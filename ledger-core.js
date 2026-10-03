// ledger-core.js
// 可续作改动账内核：与 DOM / 存储无关，便于在 node 下单测。
// 素材库由账本回放（rebuild）得出；离线时的乐观改动由调用方在回放结果上叠加。
(function (global) {
  "use strict";

  var SCHEMA = 1;
  var RULE_KEYS = ["forgets", "disputes", "setup", "scoring"];
  var CAPACITY = 12; // 待办（离线改动 + 待并入 + 冲突）容量上限

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // 规则卡对象：旧实现里规则是字符串，这里升级为带修订号的对象。
  function makeRule(text, by, rev, at) {
    return {
      id: uuid(),
      text: text || "",
      rev: rev || 1,
      status: "active", // active | conflicted
      variants: [], // 冲突时保留的双方版本
      lastBy: by || "",
      lastAt: at || nowIso()
    };
  }

  function makeGame(partial, by, rev, at) {
    partial = partial || {};
    var game = {
      id: partial.id || uuid(),
      rev: rev || 1,
      name: partial.name || "",
      minPlayers: partial.minPlayers != null ? partial.minPlayers : 2,
      maxPlayers: partial.maxPlayers != null ? partial.maxPlayers : 4,
      duration: partial.duration != null ? partial.duration : 90,
      complexity: partial.complexity || "中",
      lastPlayed: partial.lastPlayed || "",
      cover: partial.cover || "",
      forgets: [],
      disputes: [],
      setup: [],
      scoring: [],
      reviews: {},
      lastBy: by || "",
      lastAt: at || nowIso()
    };
    RULE_KEYS.forEach(function (k) {
      (partial[k] || []).forEach(function (text) {
        game[k].push(makeRule(text, by, rev || 1, at));
      });
    });
    return game;
  }

  // 把旧的「字符串数组」型规则转换成规则卡对象（迁移用）。
  function gamesFromLegacyShape(games, by, at) {
    return (games || []).map(function (g) {
      return makeGame(g, by, 1, at);
    });
  }

  // 基准修订：首次打开旧数据时，把现有内容包成修订 1。
  function baselineFromLegacy(oldState, by, at) {
    at = at || nowIso();
    var games = gamesFromLegacyShape(oldState && oldState.games, by || "基准迁移", at);
    return {
      id: uuid(),
      rev: 1,
      type: "baseline",
      gameId: null,
      ruleKey: null,
      ruleId: null,
      baseRev: 0,
      payload: { schema: SCHEMA, games: games },
      by: by || "基准迁移",
      at: at
    };
  }

  // 完全没有旧数据时的示例基准。
  function defaultGames(at, by) {
    var sample = [
      {
        name: "奥尔良",
        minPlayers: 2,
        maxPlayers: 4,
        duration: 90,
        complexity: "中",
        lastPlayed: "2025-11-20",
        cover: "",
        forgets: ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
        disputes: ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
        setup: ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
        scoring: ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"]
      },
      {
        name: "盖亚计划",
        minPlayers: 1,
        maxPlayers: 4,
        duration: 150,
        complexity: "重",
        lastPlayed: "2025-08-02",
        cover: "",
        forgets: ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
        disputes: ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
        setup: ["随机终局计分板和回合得分板", "按种族设置起始资源和母星"],
        scoring: ["终局计分板", "科技轨排名", "联邦和建筑分"]
      },
      {
        name: "花砖物语",
        minPlayers: 2,
        maxPlayers: 4,
        duration: 45,
        complexity: "轻",
        lastPlayed: "2026-03-15",
        cover: "",
        forgets: ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
        disputes: ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
        setup: ["按人数放工厂圆盘", "每个圆盘补4块砖"],
        scoring: ["横竖相邻即时分", "完整行列和颜色终局加分"]
      }
    ];
    return gamesFromLegacyShape(sample, by || "基准迁移", at || nowIso());
  }

  function defaultBaseline(at, by) {
    at = at || nowIso();
    return {
      id: uuid(),
      rev: 1,
      type: "baseline",
      gameId: null,
      ruleKey: null,
      ruleId: null,
      baseRev: 0,
      payload: { schema: SCHEMA, games: defaultGames(at, by) },
      by: by || "基准迁移",
      at: at
    };
  }

  function makeLibrary() {
    return { schema: SCHEMA, rev: 0, games: [] };
  }

  // 把一条改动应用到素材库（会被 rebuild 反复调用，需幂等）。
  // 返回 { ok, skipped?, reason?, conflict?, removed? }
  function applyChange(lib, ch) {
    var at = ch.at || nowIso();
    switch (ch.type) {
      case "baseline": {
        lib.schema = SCHEMA;
        lib.games = clone(ch.payload.games);
        lib.rev = ch.rev;
        return { ok: true };
      }
      case "game.add": {
        var g = clone(ch.payload.game);
        g.rev = ch.rev;
        g.lastBy = ch.by;
        g.lastAt = at;
        RULE_KEYS.forEach(function (k) {
          (g[k] || []).forEach(function (r) {
            r.rev = r.rev || ch.rev;
            r.lastBy = r.lastBy || ch.by;
            r.lastAt = r.lastAt || at;
            r.status = r.status || "active";
            r.variants = r.variants || [];
          });
        });
        lib.games.push(g);
        lib.rev = ch.rev;
        return { ok: true };
      }
      case "game.update": {
        var gu = lib.games.find(function (x) { return x.id === ch.gameId; });
        if (!gu) return { ok: false, skipped: true, reason: "桌游已不存在" };
        Object.assign(gu, ch.payload.patch);
        gu.rev = ch.rev;
        gu.lastBy = ch.by;
        gu.lastAt = at;
        lib.rev = ch.rev;
        return { ok: true };
      }
      case "game.delete": {
        var before = lib.games.length;
        lib.games = lib.games.filter(function (x) { return x.id !== ch.gameId; });
        lib.rev = ch.rev;
        return { ok: true, removed: lib.games.length < before };
      }
      case "rule.add": {
        if (RULE_KEYS.indexOf(ch.ruleKey) === -1) {
          return { ok: false, skipped: true, reason: "规则分类无效" };
        }
        var ga = lib.games.find(function (x) { return x.id === ch.gameId; });
        if (!ga) return { ok: false, skipped: true, reason: "桌游已不存在" };
        var exists = ga[ch.ruleKey].some(function (x) { return x.id === ch.ruleId; });
        if (exists) return { ok: true, duplicate: true };
        var nr = clone(ch.payload.rule);
        nr.id = ch.ruleId || nr.id;
        nr.rev = ch.rev;
        nr.lastBy = ch.by;
        nr.lastAt = at;
        nr.status = "active";
        nr.variants = [];
        ga[ch.ruleKey].push(nr);
        ga.rev = ch.rev;
        lib.rev = ch.rev;
        return { ok: true };
      }
      case "rule.update": {
        var gx = lib.games.find(function (x) { return x.id === ch.gameId; });
        if (!gx) return { ok: false, skipped: true, reason: "桌游已不存在" };
        var ru = gx[ch.ruleKey] && gx[ch.ruleKey].find(function (x) { return x.id === ch.ruleId; });
        if (!ru) return { ok: false, skipped: true, reason: "规则卡已被对方删除" };
        var becameConflict = false;
        if (ru.rev === ch.baseRev) {
          // 基于最新修订：干净应用。
          ru.text = ch.payload.text;
          ru.rev = ch.rev;
          ru.lastBy = ch.by;
          ru.lastAt = at;
          ru.status = "active";
          ru.variants = [];
        } else {
          // 并发修改同一规则卡：两份都留下，后到不盖先到。
          becameConflict = true;
          if (ru.status === "active") {
            ru.status = "conflicted";
            ru.variants = [
              { text: ru.text, by: ru.lastBy || "先到", rev: ru.rev, at: ru.lastAt },
              { text: ch.payload.text, by: ch.by, rev: ch.rev, at: at }
            ];
          } else {
            ru.variants.push({ text: ch.payload.text, by: ch.by, rev: ch.rev, at: at });
          }
          ru.rev = ch.rev;
          ru.lastBy = ch.by;
          ru.lastAt = at;
        }
        gx.rev = ch.rev;
        lib.rev = ch.rev;
        return { ok: true, conflict: becameConflict };
      }
      case "rule.delete": {
        var gd = lib.games.find(function (x) { return x.id === ch.gameId; });
        if (!gd) return { ok: false, skipped: true, reason: "桌游已不存在" };
        var beforeLen = gd[ch.ruleKey].length;
        gd[ch.ruleKey] = gd[ch.ruleKey].filter(function (x) { return x.id !== ch.ruleId; });
        gd.rev = ch.rev;
        lib.rev = ch.rev;
        return { ok: true, removed: gd[ch.ruleKey].length < beforeLen };
      }
      case "review.confirm": {
        var gr = lib.games.find(function (x) { return x.id === ch.gameId; });
        if (!gr) return { ok: false, skipped: true, reason: "桌游已不存在" };
        var rr = gr[ch.ruleKey] && gr[ch.ruleKey].find(function (x) { return x.id === ch.ruleId; });
        if (!rr) return { ok: false, skipped: true, reason: "规则卡已不存在" };
        gr.reviews[ch.ruleId] = { by: ch.by, at: at, forRev: ch.payload.forRev };
        gr.rev = ch.rev;
        lib.rev = ch.rev;
        return { ok: true };
      }
      default:
        return { ok: false, skipped: true, reason: "未知改动类型 " + ch.type };
    }
  }

  // 按修订顺序回放账本，重建素材库。
  function rebuild(ledger) {
    var lib = makeLibrary();
    var sorted = (ledger || []).slice().sort(function (a, b) { return a.rev - b.rev; });
    for (var i = 0; i < sorted.length; i++) {
      applyChange(lib, sorted[i]);
    }
    return lib;
  }

  // 字符级 LCS 差异，用于标出同卡两份内容的差异。
  function diffChars(a, b) {
    var A = Array.from(a || "");
    var B = Array.from(b || "");
    var m = A.length;
    var n = B.length;
    var dp = Array.from({ length: m + 1 }, function () { return new Uint16Array(n + 1); });
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var stack = [];
    var ii = m;
    var jj = n;
    while (ii > 0 || jj > 0) {
      if (ii > 0 && jj > 0 && A[ii - 1] === B[jj - 1]) {
        stack.push({ type: "same", text: A[ii - 1] });
        ii--;
        jj--;
      } else if (jj > 0 && (ii === 0 || dp[ii][jj - 1] >= dp[ii - 1][jj])) {
        stack.push({ type: "add", text: B[jj - 1] });
        jj--;
      } else {
        stack.push({ type: "del", text: A[ii - 1] });
        ii--;
      }
    }
    stack.reverse();
    var out = [];
    stack.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && last.type === s.type) last.text += s.text;
      else out.push({ type: s.type, text: s.text });
    });
    return out;
  }

  // 复习确认状态：none 未确认 / confirmed 已确认 / stale 内容已变需重确。
  function reviewState(game, rule) {
    var rv = game.reviews && game.reviews[rule.id];
    if (!rv) return "none";
    if (rule.status === "conflicted") return "stale";
    return rv.forRev === rule.rev ? "confirmed" : "stale";
  }

  // 待办容量：离线改动 + 待并入 + 冲突规则卡。
  function countPending(outbox, peerPending, conflictCount) {
    var outChanges = (outbox || []).reduce(function (n, b) { return n + (b.changes ? b.changes.length : 0); }, 0);
    return outChanges + (peerPending || []).length + (conflictCount || 0);
  }

  function buildChange(partial) {
    return {
      id: uuid(),
      rev: partial.rev || 0,
      type: partial.type,
      gameId: partial.gameId || null,
      ruleKey: partial.ruleKey || null,
      ruleId: partial.ruleId || null,
      baseRev: partial.baseRev || 0,
      payload: partial.payload || {},
      by: partial.by || "",
      at: partial.at || nowIso(),
      batchId: partial.batchId || null
    };
  }

  var api = {
    SCHEMA: SCHEMA,
    RULE_KEYS: RULE_KEYS,
    CAPACITY: CAPACITY,
    uuid: uuid,
    clone: clone,
    nowIso: nowIso,
    makeRule: makeRule,
    makeGame: makeGame,
    gamesFromLegacyShape: gamesFromLegacyShape,
    baselineFromLegacy: baselineFromLegacy,
    defaultBaseline: defaultBaseline,
    defaultGames: defaultGames,
    makeLibrary: makeLibrary,
    applyChange: applyChange,
    rebuild: rebuild,
    diffChars: diffChars,
    reviewState: reviewState,
    countPending: countPending,
    buildChange: buildChange
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.LedgerCore = api;
})(typeof window !== "undefined" ? window : globalThis);
