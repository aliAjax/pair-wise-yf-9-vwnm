// test-e2e.js — 在 jsdom 里加载真实 index.html + ledger-core + app.js 做端到端验证
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

async function makeWindow(legacy) {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  if (!win.crypto) win.crypto = {};
  if (!win.crypto.randomUUID) win.crypto.randomUUID = () => nodeCrypto.randomUUID();
  if (legacy) win.localStorage.setItem("zfl18-boardgame-rule-cards", JSON.stringify(legacy));
  win.eval(fs.readFileSync(path.join(__dirname, "ledger-core.js"), "utf8"));
  win.eval(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"));
  // 等 init 跑完（JSDOM 的 DOMContentLoaded 是异步的）
  for (let i = 0; i < 60; i++) {
    if (win.__zfl && win.__zfl.view.games.length > 0) return win;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("init 未完成");
}

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ✓", name); })
    .catch((e) => { console.error("  ✗", name, "\n   ", e.message); process.exitCode = 1; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log("1. 基准迁移（旧数据无修订号）：");
  await test("旧字符串数据首次打开迁移为基准修订 1", async () => {
    const legacy = { games: [{ id: "g1", name: "奥尔良", forgets: ["规则A"], disputes: [], setup: [], scoring: [] }] };
    const win = await makeWindow(legacy);
    const z = win.__zfl;
    const ledger = z.loadLedger();
    assert(ledger.length === 1 && ledger[0].type === "baseline" && ledger[0].rev === 1, "应有 baseline rev1");
    assert(z.view.games[0].forgets[0].text === "规则A", "规则文本应保留");
    assert(z.view.games[0].forgets[0].rev === 1, "规则卡应为修订1");
    assert(win.document.querySelector("#ledgerList").textContent.includes("基准修订"), "页面应显示基准修订");
  });

  console.log("2. 离线改规则 → 回网逐条合并：");
  await test("离线新增规则进批次，回网后并入账本、修订号增长", async () => {
    const win = await makeWindow();
    const z = win.__zfl;
    z.goOffline();
    assert(z.online === false, "应已离线");
    const game = z.view.games[0];
    const before = game.forgets.length;
    const rule = z.C.makeRule("离线新增的规则", z.device.name, 1, z.C.nowIso());
    const ch = z.C.buildChange({ type: "rule.add", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, payload: { rule }, by: z.device.name });
    z.performLocalChange(ch);
    assert(z.outbox.length === 1 && z.outbox[0].changes.length === 1, "离线改动应进批次");
    assert(z.view.games[0].forgets.length === before + 1, "乐观视图应立即显示新规则");
    z.goOnline();
    assert(z.outbox.length === 0, "回网后批次应清空");
    assert(z.loadLedger().length === 2, "账本应新增一条");
    assert(z.view.games[0].forgets.length === before + 1, "回网后规则仍在");
    assert(win.document.querySelector("#syncStatus").textContent.includes("在线"), "状态应显示在线");
  });

  console.log("3. 两人同时改同一张规则卡 → 双方都保留、标出差异：");
  await test("一键演示冲突：两份内容都留下，后到不盖先到", async () => {
    const win = await makeWindow();
    const z = win.__zfl;
    z.demoConflict();
    const game = z.view.games[0];
    const rule = game.forgets[0];
    assert(rule.status === "conflicted", "规则卡应处于冲突状态");
    assert(rule.variants.length === 2, "应有两个版本");
    assert(rule.variants[0].text.includes("我的版本"), "先到版本应保留");
    assert(rule.variants[1].text.includes("搭子版本"), "后到版本应保留");
    assert(rule.variants[0].by !== rule.variants[1].by, "两个版本应来自不同人");
    assert(win.document.querySelector("#conflictCount").textContent === "1", "冲突计数应为1");
    const detail = win.document.querySelector("#detailView").textContent;
    assert(detail.includes("双方版本都保留"), "页面应提示双方保留");
    assert(detail.includes("先到") && detail.includes("后到"), "页面应标出先到/后到");
    assert(detail.includes("差异对照"), "页面应显示差异对照");
  });

  console.log("4. 复习确认随内容变更立即失效：");
  await test("确认后改规则 → 徽章变『需重新确认』", async () => {
    const win = await makeWindow();
    const z = win.__zfl;
    const game = z.view.games[0];
    const rule = game.forgets[0];
    const cf = z.C.buildChange({ type: "review.confirm", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, payload: { forRev: rule.rev }, by: z.device.name });
    z.performLocalChange(cf);
    assert(z.C.reviewState(z.view.games[0], z.view.games[0].forgets[0]) === "confirmed", "应已确认");
    const ed = z.C.buildChange({ type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: rule.rev, payload: { text: rule.text + "（修订）" }, by: z.device.name });
    z.performLocalChange(ed);
    const r2 = z.view.games[0].forgets[0];
    assert(z.C.reviewState(z.view.games[0], r2) === "stale", "内容变更后应失效");
    const badge = win.document.querySelector("#detailView .review-badge").textContent;
    assert(badge.includes("重新确认"), "页面徽章应提示重新确认: " + badge);
  });

  console.log("5. 合并失败只重试没进去的：");
  await test("搭子已删规则，我的离线更新回网时被跳过→批次部分失败可重试→可放弃", async () => {
    const win = await makeWindow();
    const z = win.__zfl;
    z.goOffline();
    const game = z.view.games[0];
    const rule = game.forgets[0];
    const myCh = z.C.buildChange({ type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, baseRev: rule.rev, payload: { text: "我离线改的" }, by: z.device.name });
    z.performLocalChange(myCh);
    // 搭子在我离线时删了这条规则（直接放进待并入闭包）
    const peerDel = z.C.buildChange({ type: "rule.delete", gameId: game.id, ruleKey: "forgets", ruleId: rule.id, by: "搭子小Z" });
    z.peerPending.push(peerDel);
    z.savePeerPending();
    z.goOnline();
    assert(z.view.games[0].forgets.find((r) => r.id === rule.id) === undefined, "规则应已被删除");
    assert(z.outbox.length === 1 && z.outbox[0].status === "partial", "批次应部分失败保留");
    assert(z.outbox[0].failed.length === 1, "应有1条失败");
    assert(z.outbox[0].failed[0].reason, "失败应带原因: " + JSON.stringify(z.outbox[0].failed[0].reason));
    z.retryFailed();
    assert(z.outbox.length === 1, "重试后批次仍保留（只重试没进去的）");
    win.document.querySelector("#syncPanel [data-action='discard-batch']").click();
    assert(z.outbox.length === 0, "放弃后批次清空");
  });

  console.log("6. 容量上限排队、草稿不丢：");
  await test("待办到容量上限时新改动进队列，草稿仍保留", async () => {
    const win = await makeWindow();
    const z = win.__zfl;
    z.goOffline();
    const fake = [];
    for (let i = 0; i < 12; i++) fake.push(z.C.buildChange({ type: "game.delete", gameId: "fake" + i, by: "x" }));
    fake.forEach((c) => z.peerPending.push(c));
    z.savePeerPending();
    z.rebuildView();
    assert(z.C.countPending(z.outbox, z.peerPending, z.conflictCount()) >= 12, "待办应达上限");
    const game = z.view.games[0];
    const rule = z.C.makeRule("排队草稿", z.device.name, 1, z.C.nowIso());
    const ch = z.C.buildChange({ type: "rule.add", gameId: game.id, ruleKey: "setup", ruleId: rule.id, payload: { rule }, by: z.device.name });
    z.performLocalChange(ch);
    assert(z.outbox.length === 1 && z.outbox[0].status === "queued", "新改动应标记为已排队");
    assert(z.outbox[0].changes.length === 1, "草稿不应丢失");
    assert(win.document.querySelector("#capacityText").textContent.includes("排队不丢"), "容量条应提示排队不丢");
  });

  console.log("7. 多标签账本通知（storage 事件触发重建）：");
  await test("另一标签提交账本后，本标签收到 storage 事件并重建", async () => {
    const win1 = await makeWindow();
    const win2 = await makeWindow();
    const z1 = win1.__zfl;
    const z2 = win2.__zfl;
    const game = z1.view.games[0];
    const rule = z1.C.makeRule("标签1新增", z1.device.name, 1, z1.C.nowIso());
    const ch = z1.C.buildChange({ type: "rule.add", gameId: game.id, ruleKey: "setup", ruleId: rule.id, payload: { rule }, by: z1.device.name });
    z1.performLocalChange(ch);
    // 把标签1的账本复制到标签2的 localStorage，再触发 storage 事件
    win2.localStorage.setItem("zfl18-ledger", win1.localStorage.getItem("zfl18-ledger"));
    win2.dispatchEvent(new win2.StorageEvent("storage", { key: "zfl18-ledger", newValue: win2.localStorage.getItem("zfl18-ledger") }));
    assert(z2.view.games[0].setup.some((r) => r.text === "标签1新增"), "标签2应看到标签1的新增");
  });

  console.log(`\n${passed} 项通过`);
  if (process.exitCode) process.exit(1);
})();
