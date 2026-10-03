// test-ledger.js — 验证改动账内核
const assert = require("assert");
const C = require("./ledger-core.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "\n   ", e.message);
    process.exitCode = 1;
  }
}

console.log("迁移与回放：");
test("旧字符串数据迁移为基准修订 1", () => {
  const old = { games: [{ id: "g1", name: "奥尔良", forgets: ["规则A"], disputes: [], setup: [], scoring: [] }] };
  const base = C.baselineFromLegacy(old, "我", "2026-10-01T00:00:00.000Z");
  assert.strictEqual(base.rev, 1);
  assert.strictEqual(base.type, "baseline");
  const lib = C.rebuild([base]);
  assert.strictEqual(lib.rev, 1);
  assert.strictEqual(lib.games.length, 1);
  assert.strictEqual(lib.games[0].forgets[0].text, "规则A");
  assert.strictEqual(lib.games[0].forgets[0].rev, 1);
});

test("无旧数据时生成示例基准", () => {
  const base = C.defaultBaseline("2026-10-01T00:00:00.000Z", "我");
  const lib = C.rebuild([base]);
  assert.strictEqual(lib.games.length, 3);
  assert.ok(lib.games[0].forgets.length >= 1);
});

console.log("追加改动与回放：");
test("新增规则卡后修订号增长", () => {
  const base = C.defaultBaseline("t", "我");
  const lib0 = C.rebuild([base]);
  const game = lib0.games[0];
  const rule = C.makeRule("新规则", "我", 2, "t");
  const ch = C.buildChange({ rev: 2, type: "rule.add", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, payload: { rule }, by: "我", at: "t" });
  const lib = C.rebuild([base, ch]);
  assert.strictEqual(lib.rev, 2);
  assert.strictEqual(lib.games[0].forgets.length, game.forgets.length + 1);
});

console.log("并发修改（核心：两份都留下）：");
test("两人基于同一基准改同一规则卡 → 冲突，双方都保留", () => {
  const base = C.defaultBaseline("t", "先到");
  let lib = C.rebuild([base]);
  const game = lib.games[0];
  const rule = game.forgets[0];
  const baseRev = rule.rev; // 1

  // 先到改
  const chA = C.buildChange({ rev: 2, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev, payload: { text: "先到的版本" }, by: "先到", at: "t1" });
  // 后到也基于同一基准改
  const chB = C.buildChange({ rev: 3, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev, payload: { text: "后到的版本" }, by: "后到", at: "t2" });

  lib = C.rebuild([base, chA, chB]);
  const r = lib.games[0].forgets[0];
  assert.strictEqual(r.status, "conflicted");
  assert.strictEqual(r.variants.length, 2);
  assert.strictEqual(r.variants[0].text, "先到的版本");
  assert.strictEqual(r.variants[0].by, "先到");
  assert.strictEqual(r.variants[1].text, "后到的版本");
  assert.strictEqual(r.variants[1].by, "后到");
  // 后到不盖先到：先到版本仍在
  assert.ok(r.variants.some((v) => v.text === "先到的版本"));
});

test("基于最新修订的干净编辑不产生冲突", () => {
  const base = C.defaultBaseline("t", "我");
  let lib = C.rebuild([base]);
  const game = lib.games[0];
  const rule = game.forgets[0];
  const ch = C.buildChange({ rev: 2, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: rule.rev, payload: { text: "干净编辑" }, by: "我", at: "t" });
  lib = C.rebuild([base, ch]);
  const r = lib.games[0].forgets[0];
  assert.strictEqual(r.status, "active");
  assert.strictEqual(r.text, "干净编辑");
});

console.log("复习确认失效：");
test("规则内容一变，已确认立即失效需重确", () => {
  const base = C.defaultBaseline("t", "我");
  let lib = C.rebuild([base]);
  const game = lib.games[0];
  const rule = game.forgets[0];

  // 确认（绑定 rev 1）
  const confirm = C.buildChange({ rev: 2, type: "review.confirm", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, payload: { forRev: rule.rev }, by: "我", at: "t" });
  lib = C.rebuild([base, confirm]);
  let r = lib.games[0].forgets[0];
  assert.strictEqual(C.reviewState(lib.games[0], r), "confirmed");

  // 规则内容变化
  const edit = C.buildChange({ rev: 3, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: 1, payload: { text: "改了内容" }, by: "我", at: "t2" });
  lib = C.rebuild([base, confirm, edit]);
  r = lib.games[0].forgets[0];
  assert.strictEqual(C.reviewState(lib.games[0], r), "stale", "内容变化后应失效");
});

test("冲突状态下复习确认也失效", () => {
  const base = C.defaultBaseline("t", "先到");
  let lib = C.rebuild([base]);
  const game = lib.games[0];
  const rule = game.forgets[0];
  const confirm = C.buildChange({ rev: 2, type: "review.confirm", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, payload: { forRev: rule.rev }, by: "先到", at: "t" });
  const chA = C.buildChange({ rev: 3, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: 1, payload: { text: "先到版" }, by: "先到", at: "t1" });
  const chB = C.buildChange({ rev: 4, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: 1, payload: { text: "后到版" }, by: "后到", at: "t2" });
  lib = C.rebuild([base, confirm, chA, chB]);
  const r = lib.games[0].forgets[0];
  assert.strictEqual(C.reviewState(lib.games[0], r), "stale");
});

console.log("合并失败只重试未进去的：");
test("规则被对方删除后，我的更新被跳过并标记", () => {
  const base = C.defaultBaseline("t", "我");
  let lib = C.rebuild([base]);
  const game = lib.games[0];
  const rule = game.forgets[0];
  // 对方删了规则
  const del = C.buildChange({ rev: 2, type: "rule.delete", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, by:对方("对方"), at: "t1" });
  // 我还基于旧修订改它
  const upd = C.buildChange({ rev: 3, type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: 1, payload: { text: "我改的" }, by: "我", at: "t2" });
  const res = C.applyChange(C.rebuild([base, del]), upd);
  assert.strictEqual(res.skipped, true);
  assert.ok(res.reason);
});

console.log("差异标注：");
test("diffChars 能标出增删", () => {
  const segs = C.diffChars("先到版本", "后到版本");
  const types = segs.map((s) => s.type).join(",");
  assert.ok(types.includes("del") && types.includes("add"), "应同时有删和增: " + types);
});

console.log("容量：");
test("countPending 统计离线改动+待并入+冲突", () => {
  const outbox = [{ changes: [{}, {}] }, { changes: [{}] }];
  assert.strictEqual(C.countPending(outbox, [{}, {}], 1), 2 + 1 + 2 + 1);
});

function 对方(s) { return s; }

console.log(`\n${passed} 项通过`);
if (process.exitCode) process.exit(1);
