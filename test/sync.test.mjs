// 改动账引擎的端到端验证：迁移、离线批次、逐条合并、冲突双留、
// 复习确认失效、失败重试、容量排队。运行：node test/sync.test.mjs
import assert from "node:assert/strict";
import {
  MAX_PENDING_DIFFS,
  SHARED_KEY,
  loadShared,
  loadLocalState,
  buildBaselineEntries,
  recordChange,
  deriveView,
  syncNow,
  ruleConfirmStatus,
  diffTokens,
  initialLocalState,
  createId
} from "../sync.js";

class MemStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

// 第 N 次 setItem 之后开始抛错，模拟合并中途失败
class FlakyStorage extends MemStorage {
  constructor(failAfter) {
    super();
    this.failAfter = failAfter;
    this.calls = 0;
    this.broken = true;
  }
  setItem(key, value) {
    this.calls += 1;
    if (this.broken && key === SHARED_KEY && this.calls > this.failAfter) {
      throw new Error("写入共享账本失败（模拟）");
    }
    super.setItem(key, value);
  }
}

function legacyGame(overrides = {}) {
  return {
    id: "g1",
    name: "奥尔良",
    minPlayers: 2,
    maxPlayers: 4,
    duration: 90,
    complexity: "中",
    lastPlayed: "2025-11-20",
    cover: "",
    forgets: ["商站建造前先确认道路或水路连接"],
    disputes: [],
    setup: [],
    scoring: [],
    ...overrides
  };
}

function makeDevice() {
  return { local: new MemStorage(), state: initialLocalState() };
}

function refresh(device, sharedStore) {
  return deriveView(device.state, loadShared(sharedStore));
}

// 1) 旧数据迁移成基准修订
{
  const sharedStore = new MemStorage();
  const device = makeDevice();
  device.local.setItem(
    "zfl18-boardgame-rule-cards",
    JSON.stringify({ selectedId: "g1", games: [legacyGame()] })
  );
  const loaded = loadLocalState(device.local);
  assert.ok(loaded.legacy, "应识别出没有修订号的旧数据");
  loaded.state.pending.push(...buildBaselineEntries(loaded.state, loaded.legacy.games));

  const result = syncNow(sharedStore, loaded.state);
  assert.equal(result.failed, false);
  assert.equal(result.merged, 2, "1 个桌游 + 1 张规则卡");

  const view = refresh(device, sharedStore);
  assert.equal(view.games[0].rev, 1, "迁移后桌游是基准修订 rev 1");
  assert.equal(view.rules[0].rev, 1, "迁移后规则卡是基准修订 rev 1");
  assert.equal(view.rules[0].text, "商站建造前先确认道路或水路连接");
  console.log("✓ 旧数据迁移成基准修订");
}

// 2) 断网照常改，回网后逐条按序合并
{
  const sharedStore = new MemStorage();
  const device = makeDevice();
  let view = refresh(device, sharedStore);

  recordChange(device.state, view, { type: "game.upsert", entityId: "g1", payload: legacyGame() });
  view = refresh(device, sharedStore);
  recordChange(device.state, view, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "第一条", order: 1 }
  });
  view = refresh(device, sharedStore);
  recordChange(device.state, view, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "第一条（改）", order: 1 }
  });
  assert.equal(device.state.pending.length, 3, "离线改动都留在本地批次里");

  const result = syncNow(sharedStore, device.state);
  assert.equal(result.merged, 3, "回网后逐条合并");
  view = refresh(device, sharedStore);
  assert.equal(view.rules[0].rev, 2, "同一实体按序累加修订");
  assert.equal(view.rules[0].text, "第一条（改）");
  console.log("✓ 断网照常改，回网后逐条合并");
}

// 3) 两人同时改同一张卡：两份都留下、标出差异、后到不盖先到
{
  const sharedStore = new MemStorage();
  const a = makeDevice();
  const b = makeDevice();

  // A 建卡并同步
  let viewA = refresh(a, sharedStore);
  recordChange(a.state, viewA, { type: "game.upsert", entityId: "g1", payload: legacyGame() });
  viewA = refresh(a, sharedStore);
  recordChange(a.state, viewA, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "袋中随从抽完后继续抽", order: 1 }
  });
  syncNow(sharedStore, a.state);

  // B 拉到这张卡
  syncNow(sharedStore, b.state);
  const viewB = refresh(b, sharedStore);
  assert.equal(viewB.rules[0].text, "袋中随从抽完后继续抽");

  // 两人基于同一修订各自离线修改
  viewA = refresh(a, sharedStore);
  recordChange(a.state, viewA, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "袋中随从抽完后从已回袋内容继续抽", order: 1 }
  });
  recordChange(b.state, viewB, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "袋中随从抽完后重洗弃堆再抽", order: 1 }
  });

  // A 先回网：落账成功
  const resA = syncNow(sharedStore, a.state);
  assert.equal(resA.merged, 1);
  assert.equal(resA.conflicts, 0);

  // B 后回网：不能盖掉 A，进入冲突，两份内容都留下
  const resB = syncNow(sharedStore, b.state);
  assert.equal(resB.conflicts, 1);
  const shared = loadShared(sharedStore);
  assert.equal(shared.entities.r1.data.text, "袋中随从抽完后从已回袋内容继续抽", "先到的不能被后到的盖掉");
  const conflict = b.state.conflicts[0];
  assert.equal(conflict.remote.data.text, "袋中随从抽完后从已回袋内容继续抽");
  assert.equal(conflict.local.payload.text, "袋中随从抽完后重洗弃堆再抽");

  // 差异标注能找到两边的不同
  const tokens = diffTokens(conflict.remote.data.text, conflict.local.payload.text);
  assert.ok(tokens.some((t) => t.type === "del"), "标出共享版被改掉的字");
  assert.ok(tokens.some((t) => t.type === "add"), "标出本地新增的字");

  // B 把自己的改动另存为新卡：两份内容最终都在卡库里
  recordChange(b.state, refresh(b, sharedStore), {
    type: "rule.upsert",
    entityId: createId(),
    payload: { ...conflict.local.payload, order: 2 }
  });
  conflict.resolved = true;
  syncNow(sharedStore, b.state);
  syncNow(sharedStore, a.state);
  viewA = refresh(a, sharedStore);
  const texts = viewA.rules.map((rule) => rule.text);
  assert.ok(texts.includes("袋中随从抽完后从已回袋内容继续抽"));
  assert.ok(texts.includes("袋中随从抽完后重洗弃堆再抽"));
  console.log("✓ 同卡冲突：两份都留下、标出差异、后到不盖先到");
}

// 4) 规则内容一变，相关复习确认立即失效
{
  const sharedStore = new MemStorage();
  const device = makeDevice();
  let view = refresh(device, sharedStore);
  recordChange(device.state, view, { type: "game.upsert", entityId: "g1", payload: legacyGame() });
  view = refresh(device, sharedStore);
  recordChange(device.state, view, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "原始内容", order: 1 }
  });
  view = refresh(device, sharedStore);

  const rule = view.rules[0];
  recordChange(device.state, view, { type: "review.confirm", entityId: rule.id, payload: { rev: rule.rev } });
  view = refresh(device, sharedStore);
  assert.equal(ruleConfirmStatus(view, view.rules[0]).status, "valid", "确认后有效");

  recordChange(device.state, view, {
    type: "rule.upsert",
    entityId: "r1",
    payload: { gameId: "g1", section: "forgets", text: "原始内容（补充细节）", order: 1 }
  });
  view = refresh(device, sharedStore);
  assert.equal(ruleConfirmStatus(view, view.rules[0]).status, "stale", "内容一变确认立即失效");

  const rule2 = view.rules[0];
  recordChange(device.state, view, { type: "review.confirm", entityId: rule2.id, payload: { rev: rule2.rev } });
  view = refresh(device, sharedStore);
  assert.equal(ruleConfirmStatus(view, view.rules[0]).status, "valid", "重新确认后恢复有效");
  console.log("✓ 规则内容变化 -> 复习确认立即失效 -> 可重新确认");
}

// 5) 合并中途失败：保留离线批次，只重试没合并进去的那些
{
  const device = makeDevice();
  let view = deriveView(device.state, loadShared(new MemStorage()));
  for (let i = 0; i < 5; i += 1) {
    recordChange(device.state, view, {
      type: "rule.upsert",
      entityId: `r${i}`,
      payload: { gameId: "g1", section: "forgets", text: `第${i}条`, order: i }
    });
    view = deriveView(device.state, { entries: [], entities: {}, confirmations: [] });
  }

  const flaky = new FlakyStorage(2); // 只放行前 2 条落账
  const first = syncNow(flaky, device.state);
  assert.equal(first.failed, true);
  assert.equal(first.merged, 2, "失败前合并进去的保留");
  assert.equal(device.state.pending.length, 3, "没合并进去的留在离线批次里");

  flaky.broken = false; // 恢复网络/存储
  const second = syncNow(flaky, device.state);
  assert.equal(second.failed, false);
  assert.equal(second.merged, 3, "只重试没合并进去的那些");

  const shared = loadShared(flaky);
  assert.equal(shared.entries.length, 5, "不多不少，没有重复落账");
  assert.equal(new Set(shared.entries.map((e) => e.id)).size, 5, "条目 id 无重复");
  console.log("✓ 合并失败保留批次，重试只补没合并的条目");
}

// 6) 待确认差异到容量上限：新改动排队成草稿，草稿不丢
{
  const sharedStore = new MemStorage();
  const device = makeDevice();
  let view = refresh(device, sharedStore);

  const total = MAX_PENDING_DIFFS + 5;
  for (let i = 0; i < total; i += 1) {
    recordChange(device.state, view, {
      type: "rule.upsert",
      entityId: `r${i}`,
      payload: { gameId: "g1", section: "forgets", text: `草稿内容${i}`, order: i }
    });
    view = refresh(device, sharedStore);
  }
  assert.equal(device.state.pending.length, MAX_PENDING_DIFFS, "待合并到上限为止");
  assert.equal(device.state.drafts.length, 5, "超出的排进草稿");
  assert.equal(view.rules.length, total, "草稿里的改动在本地照样可见，不丢");

  const first = syncNow(sharedStore, device.state);
  assert.equal(first.merged, MAX_PENDING_DIFFS);
  assert.equal(device.state.pending.length, 5, "同步后草稿自动补进待合并");
  assert.equal(device.state.drafts.length, 0);

  syncNow(sharedStore, device.state);
  view = refresh(device, sharedStore);
  assert.equal(view.rules.length, total, "全部落账，一条不丢");
  console.log("✓ 容量上限排队草稿，草稿不丢、逐步补进");
}

console.log("\n全部通过。");
