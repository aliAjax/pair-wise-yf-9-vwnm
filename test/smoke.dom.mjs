// 用最小 DOM 桩跑一遍 app.js 的启动路径：迁移 -> 首次渲染 -> 回网同步。
// 运行：node test/smoke.dom.mjs
import assert from "node:assert/strict";
import { STORAGE_KEY, SHARED_KEY } from "../sync.js";

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

function makeElement() {
  return {
    value: "",
    files: [],
    hidden: false,
    innerHTML: "",
    textContent: "",
    addEventListener() {},
    reset() {},
    focus() {},
    closest() {
      return null;
    },
    querySelector() {
      return makeElement();
    }
  };
}

const elements = new Map();
globalThis.document = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  }
};
globalThis.navigator = { onLine: true };
globalThis.localStorage = new MemStorage();
globalThis.window = {
  addEventListener() {},
};
globalThis.setInterval = () => 0;

// 预置一份没有修订号的旧存档，验证启动迁移路径
globalThis.localStorage.setItem(
  STORAGE_KEY,
  JSON.stringify({
    selectedId: "g1",
    games: [
      {
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
        scoring: []
      }
    ]
  })
);

await import("../app.js");

const saved = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY));
assert.equal(saved.version, 2, "启动后本地状态已升级为 v2");
assert.equal(saved.pending.length, 0, "在线启动时基准修订已同步落账");

const shared = JSON.parse(globalThis.localStorage.getItem(SHARED_KEY));
assert.equal(shared.entities.g1.rev, 1, "旧数据迁移成基准修订 rev 1");
assert.ok(Object.values(shared.entities).some((e) => e.type === "rule" && e.rev === 1));

const syncBar = elements.get("#syncBar");
assert.ok(syncBar.innerHTML.includes("在线"), "同步状态条已渲染");
const detail = elements.get("#detailView");
assert.ok(detail.innerHTML.includes("开局前复习确认"), "复习确认区已渲染");
assert.ok(detail.innerHTML.includes("商站建造前先确认道路或水路连接"), "旧规则内容保留");

console.log("✓ 启动冒烟通过：旧数据迁移 -> 基准修订落账 -> 页面渲染");
