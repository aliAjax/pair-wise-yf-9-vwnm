// app.js — 桌游规则卡库：可续作改动账 + 离线批次合并 + 冲突保留双方 + 复习确认失效
(function () {
  "use strict";

  var C = window.LedgerCore;

  // ---------- 存储键 ----------
  var LEDGER_KEY = "zfl18-ledger";          // 共享改动账（在线时的真相）
  var DEVICE_KEY = "zfl18-device";          // 本机身份
  var OUTBOX_KEY = "zfl18-outbox";          // 我的离线批次
  var PEER_KEY = "zfl18-peer-pending";      // 搭子发来、待我并入的改动
  var ONLINE_KEY = "zfl18-online";
  var SELECTED_KEY = "zfl18-selected";
  var LEGACY_KEY = "zfl18-boardgame-rule-cards"; // 旧数据（无修订号）

  var bc = null;
  try { bc = new BroadcastChannel("zfl18-sync"); } catch (e) { bc = null; }

  // ---------- 状态 ----------
  var device = loadDevice();
  var online = loadOnline();
  var outbox = loadOutbox();
  var peerPending = loadPeerPending();
  var peerSeen = {}; // 搭子“上次同步”时各规则卡的修订号（用于构造并发）
  var view = C.makeLibrary();
  var selectedId = localStorage.getItem(SELECTED_KEY) || "";

  var els = {};

  // ---------- 基础存取 ----------
  function loadDevice() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(DEVICE_KEY) || "null"); } catch (e) { d = null; }
    if (!d || !d.id) {
      d = { id: C.uuid(), name: "搭子·本机" + Math.floor(Math.random() * 90 + 10) };
      localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    }
    return d;
  }
  function loadOnline() { return localStorage.getItem(ONLINE_KEY) !== "0"; }
  function setOnlineFlag(v) { online = v; localStorage.setItem(ONLINE_KEY, v ? "1" : "0"); }
  function loadOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveOutbox() { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); }
  function loadPeerPending() {
    try { return JSON.parse(localStorage.getItem(PEER_KEY) || "[]"); } catch (e) { return []; }
  }
  function savePeerPending() { localStorage.setItem(PEER_KEY, JSON.stringify(peerPending)); }
  function loadLedger() {
    try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveLedger(ledger) { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); }
  function maxRev(ledger) {
    return ledger.reduce(function (m, ch) { return Math.max(m, ch.rev || 0); }, 0);
  }
  function nextRev(ledger, extra) {
    var m = maxRev(ledger);
    (extra || []).forEach(function (ch) { m = Math.max(m, ch.rev || 0); });
    return m + 1;
  }
  function broadcast(msg) { try { bc && bc.postMessage(msg); } catch (e) {} }

  // ---------- 迁移：旧数据无修订号，首次打开包成基准修订 1 ----------
  function migrate() {
    var ledger = loadLedger();
    if (ledger && ledger.length) return;
    var base;
    var legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      try {
        var old = JSON.parse(legacyRaw);
        base = C.baselineFromLegacy(old, device.name, C.nowIso());
      } catch (e) {
        base = C.defaultBaseline(C.nowIso(), device.name);
      }
    } else {
      base = C.defaultBaseline(C.nowIso(), device.name);
    }
    saveLedger([base]);
  }

  // 视图：已并入账本 + 离线批次乐观叠加 ----------
  function rebuildView() {
    var lib = C.rebuild(loadLedger());
    outbox.forEach(function (b) {
      if (b.status === "partial" || b.status === "failed") return; // 没并入的不乐观应用
      b.changes.forEach(function (ch) { C.applyChange(lib, ch); });
    });
    view = lib;
    if (!selectedId || !view.games.some(function (g) { return g.id === selectedId; })) {
      selectedId = view.games[0] ? view.games[0].id : "";
    }
    render();
  }

  // 搭子上次同步所见的规则卡修订号：只在“并入搭子改动后”或启动时更新，
  // 我本地提交不追平，这样搭子基于旧版修改才会判定为并发冲突。
  function updatePeerSeen() {
    view.games.forEach(function (g) {
      C.RULE_KEYS.forEach(function (k) {
        g[k].forEach(function (r) { peerSeen[r.id] = r.rev; });
      });
    });
  }

  function conflictCount() {
    var n = 0;
    view.games.forEach(function (g) {
      C.RULE_KEYS.forEach(function (k) {
        g[k].forEach(function (r) { if (r.status === "conflicted") n++; });
      });
    });
    return n;
  }

  // ---------- 本地改动：在线立即入账，离线进批次 ----------
  function performLocalChange(ch) {
    ch.by = device.name;
    if (online) {
      var ledger = loadLedger();
      ch.rev = nextRev(ledger);
      ledger.push(ch);
      saveLedger(ledger);
      broadcast({ type: "ledger", rev: ch.rev });
      rebuildView();
    } else {
      ch.batchId = currentBatchId();
      var batch = outbox.find(function (b) { return b.id === ch.batchId; });
      var pending = C.countPending(outbox, peerPending, conflictCount());
      if (pending >= C.CAPACITY) batch.status = "queued"; // 容量到顶先排队，草稿不丢
      batch.changes.push(ch);
      saveOutbox();
      rebuildView();
    }
  }

  function currentBatchId() {
    var open = outbox.find(function (b) { return b.status === "pending" || b.status === "queued"; });
    if (open) return open.id;
    var batch = { id: C.uuid(), createdAt: C.nowIso(), changes: [], status: "pending", failed: [] };
    outbox.push(batch);
    return batch.id;
  }

  // ---------- 回网：合并离线批次 + 并入搭子改动 ----------
  function goOnline() {
    if (online) return;
    setOnlineFlag(true);
    pullPeer();      // 先并入搭子已发来的改动
    flushOutbox();   // 再把我的离线批次 rebases 到最新账本上
    rebuildView();
  }
  function goOffline() {
    if (!online) return;
    setOnlineFlag(false);
    saveOutbox();
    rebuildView();
  }

  function flushOutbox() {
    var ledger = loadLedger();
    var changed = false;
    outbox.forEach(function (batch) {
      if (batch.status === "merged") return;
      var trace = C.rebuild(ledger);
      var merged = [];
      var failed = batch.failed || [];
      var changes = batch.status === "partial" || batch.status === "failed" ? batch.changes : batch.changes;
      changes.forEach(function (ch) {
        ch.rev = nextRev(ledger, merged);
        var res = C.applyChange(trace, ch);
        if (res.skipped) {
          failed.push({ ch: ch, reason: res.reason });
        } else {
          merged.push(ch);
        }
      });
      merged.forEach(function (ch) { ledger.push(ch); });
      if (failed.length) {
        batch.changes = failed.map(function (f) { return f.ch; });
        batch.failed = failed;
        batch.status = "partial";
      } else {
        batch.changes = [];
        batch.failed = [];
        batch.status = "merged";
      }
      changed = true;
    });
    outbox = outbox.filter(function (b) { return b.status !== "merged"; });
    if (changed) {
      saveLedger(ledger);
      broadcast({ type: "ledger" });
    }
    saveOutbox();
    rebuildView();
  }

  function pullPeer() {
    if (!peerPending.length) { rebuildView(); return; }
    var ledger = loadLedger();
    var trace = C.rebuild(ledger);
    var merged = [];
    var failed = [];
    peerPending.forEach(function (ch) {
      ch.rev = nextRev(ledger, merged);
      var res = C.applyChange(trace, ch);
      if (res.skipped) failed.push({ ch: ch, reason: res.reason });
      else merged.push(ch);
    });
    merged.forEach(function (ch) { ledger.push(ch); });
    saveLedger(ledger);
    broadcast({ type: "ledger" });
    peerPending = failed.map(function (f) { return f.ch; }); // 没并入的留下重试
    savePeerPending();
    rebuildView();
    updatePeerSeen(); // 搭子已同步，追平其所见修订
  }

  function retryFailed() {
    flushOutbox();
    pullPeer();
  }

  function discardBatch(batchId) {
    outbox = outbox.filter(function (b) { return b.id !== batchId; });
    saveOutbox();
    rebuildView();
  }

  // ---------- 搭子模拟器（单机演示用；真实多标签走 BroadcastChannel） ----------
  function peerVariantText(text) {
    var t = text || "";
    if (t.indexOf("【搭子补充】") !== -1) return t + "（再补）";
    return t + "【搭子补充：开局前再核对一遍】";
  }
  function simulatePeerEdit(gameId, ruleKey, ruleId) {
    var game = view.games.find(function (g) { return g.id === gameId; });
    if (!game) return;
    var rule = game[ruleKey].find(function (r) { return r.id === ruleId; });
    if (!rule) return;
    var baseRev = peerSeen[ruleId] || rule.rev;
    var ch = C.buildChange({
      type: "rule.update", gameId: gameId, ruleKey: ruleKey, ruleId: ruleId,
      baseRev: baseRev, payload: { text: peerVariantText(rule.text) }, by: "搭子小Z"
    });
    peerPending.push(ch);
    savePeerPending();
    if (online) pullPeer(); else rebuildView();
  }
  function simulatePeerAddRule(gameId) {
    var game = view.games.find(function (g) { return g.id === gameId; });
    if (!game) return;
    var rule = C.makeRule("搭子新增的提醒：结算前再确认一轮顺序", "搭子小Z", 1, C.nowIso());
    var ch = C.buildChange({
      type: "rule.add", gameId: gameId, ruleKey: "disputes", ruleId: rule.id,
      payload: { rule: rule }, by: "搭子小Z"
    });
    peerPending.push(ch);
    savePeerPending();
    if (online) pullPeer(); else rebuildView();
  }
  function simulatePeerDeleteGame(gameId) {
    var ch = C.buildChange({ type: "game.delete", gameId: gameId, by: "搭子小Z" });
    peerPending.push(ch);
    savePeerPending();
    if (online) pullPeer(); else rebuildView();
  }
  // 一键演示：我先改、搭子基于旧版改 → 同卡冲突，双方都留下
  function demoConflict() {
    if (!online) setOnlineFlag(true);
    var game = view.games[0];
    if (!game) return;
    var rule = game.forgets[0];
    if (!rule) return;
    var myCh = C.buildChange({
      type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id,
      baseRev: rule.rev, payload: { text: rule.text + "【我的版本】" }, by: device.name
    });
    performLocalChange(myCh);
    var peerCh = C.buildChange({
      type: "rule.update", gameId: game.id, ruleKey: "forgets", ruleId: rule.id,
      baseRev: peerSeen[rule.id] || 1, payload: { text: rule.text + "【搭子版本】" }, by: "搭子小Z"
    });
    peerPending.push(peerCh);
    savePeerPending();
    pullPeer();
    selectedId = game.id;
    localStorage.setItem(SELECTED_KEY, selectedId);
    render();
  }

  // ---------- 渲染 ----------
  function cacheEls() {
    els = {
      searchInput: document.querySelector("#searchInput"),
      playerFilter: document.querySelector("#playerFilter"),
      complexityFilter: document.querySelector("#complexityFilter"),
      sortMode: document.querySelector("#sortMode"),
      gameForm: document.querySelector("#gameForm"),
      nameInput: document.querySelector("#nameInput"),
      minPlayersInput: document.querySelector("#minPlayersInput"),
      maxPlayersInput: document.querySelector("#maxPlayersInput"),
      durationInput: document.querySelector("#durationInput"),
      complexityInput: document.querySelector("#complexityInput"),
      lastPlayedInput: document.querySelector("#lastPlayedInput"),
      coverInput: document.querySelector("#coverInput"),
      gameList: document.querySelector("#gameList"),
      detailView: document.querySelector("#detailView"),
      gameCount: document.querySelector("#gameCount"),
      ruleCount: document.querySelector("#ruleCount"),
      staleGame: document.querySelector("#staleGame"),
      visibleCount: document.querySelector("#visibleCount"),
      syncStatus: document.querySelector("#syncStatus"),
      deviceName: document.querySelector("#deviceName"),
      pendingCount: document.querySelector("#pendingCount"),
      conflictCount: document.querySelector("#conflictCount"),
      capacityBar: document.querySelector("#capacityBar"),
      capacityText: document.querySelector("#capacityText"),
      outboxList: document.querySelector("#outboxList"),
      peerList: document.querySelector("#peerList"),
      ledgerList: document.querySelector("#ledgerList"),
      syncPanel: document.querySelector("#syncPanel")
    };
  }

  function daysSince(dateString) {
    if (!dateString) return 0;
    var date = new Date(dateString + "T00:00:00");
    return Math.max(0, Math.floor((new Date() - date) / 86400000));
  }
  function getAllRules(game) {
    var n = 0;
    C.RULE_KEYS.forEach(function (k) { n += game[k].length; });
    return n;
  }
  function getFilteredGames() {
    var keyword = els.searchInput.value.trim();
    var player = els.playerFilter.value;
    var complexity = els.complexityFilter.value;
    var games = view.games.filter(function (game) {
      var texts = [];
      C.RULE_KEYS.forEach(function (k) { game[k].forEach(function (r) { texts.push(r.text); }); });
      var text = game.name + texts.join("");
      var matchesKeyword = !keyword || text.includes(keyword);
      var matchesPlayer = player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
      var matchesComplexity = complexity === "all" || game.complexity === complexity;
      return matchesKeyword && matchesPlayer && matchesComplexity;
    });
    if (els.sortMode.value === "name") return games.sort(function (a, b) { return a.name.localeCompare(b.name, "zh-CN"); });
    if (els.sortMode.value === "complexity") {
      var rank = { 轻: 1, 中: 2, 重: 3 };
      return games.sort(function (a, b) { return rank[b.complexity] - rank[a.complexity]; });
    }
    return games.sort(function (a, b) { return daysSince(b.lastPlayed) - daysSince(a.lastPlayed); });
  }

  function renderSummary() {
    var allRuleCount = view.games.reduce(function (sum, g) { return sum + getAllRules(g); }, 0);
    var stale = view.games.slice().sort(function (a, b) { return daysSince(b.lastPlayed) - daysSince(a.lastPlayed); })[0];
    els.gameCount.textContent = view.games.length;
    els.ruleCount.textContent = allRuleCount;
    els.staleGame.textContent = stale ? daysSince(stale.lastPlayed) + "天" : "-";
  }

  function renderList() {
    var games = getFilteredGames();
    els.visibleCount.textContent = games.length + "个匹配";
    els.gameList.innerHTML = games.map(function (game) {
      var selected = game.id === selectedId ? "selected" : "";
      var conflictN = 0;
      C.RULE_KEYS.forEach(function (k) { game[k].forEach(function (r) { if (r.status === "conflicted") conflictN++; }); });
      return (
        '<article class="game-card ' + selected + '" data-game-id="' + game.id + '">' +
          '<div class="cover">' +
            (game.cover ? '<img src="' + game.cover + '" alt="' + escapeHtml(game.name) + '封面" />' : '<span>' + escapeHtml(game.name.slice(0, 2)) + '</span>') +
            '<span class="stale-ribbon">' + daysSince(game.lastPlayed) + '天未玩</span>' +
            (conflictN ? '<span class="conflict-ribbon" title="有 ' + conflictN + ' 张规则卡双方修改后都保留了版本">冲突 ' + conflictN + '</span>' : '') +
          '</div>' +
          '<div class="game-body">' +
            '<h3>' + escapeHtml(game.name) + '</h3>' +
            '<div class="game-meta">' +
              '<span class="pill">' + game.minPlayers + '-' + game.maxPlayers + '人</span>' +
              '<span class="pill">' + game.duration + '分钟</span>' +
              '<span class="pill heavy">' + escapeHtml(game.complexity) + '</span>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join("") || '<p class="empty">没有符合筛选的桌游。</p>';
  }

  function reviewBadge(game, rule) {
    var st = C.reviewState(game, rule);
    if (st === "confirmed") {
      return '<span class="review-badge confirmed" title="内容修订 rev ' + rule.rev + ' 已确认">✓ 已复习确认</span>';
    }
    if (st === "stale") {
      return '<span class="review-badge stale" title="规则内容已变更，原确认失效，需重新确认">⚠ 内容已变更·请重新确认</span>';
    }
    return '<span class="review-badge none">未复习确认</span>';
  }

  function renderDiff(a, b) {
    return C.diffChars(a, b).map(function (s) {
      if (s.type === "same") return escapeHtml(s.text);
      if (s.type === "add") return '<ins>' + escapeHtml(s.text) + '</ins>';
      return '<del>' + escapeHtml(s.text) + '</del>';
    }).join("");
  }

  function renderRuleItem(game, key, rule) {
    var st = C.reviewState(game, rule);
    var confirmLabel = st === "confirmed" ? "重新确认" : "开局前复习确认";
    var body;
    if (rule.status === "conflicted" && rule.variants.length >= 2) {
      var v0 = rule.variants[0], v1 = rule.variants[rule.variants.length - 1];
      body =
        '<div class="conflict-banner">⚠ 同一张规则卡两人修改，双方版本都保留（后到不盖先到）</div>' +
        '<div class="variant"><span class="variant-tag first">先到 · ' + escapeHtml(v0.by) + ' · rev ' + v0.rev + '</span>' +
          '<div class="variant-text">' + escapeHtml(v0.text) + '</div></div>' +
        '<div class="variant"><span class="variant-tag later">后到 · ' + escapeHtml(v1.by) + ' · rev ' + v1.rev + '</span>' +
          '<div class="variant-text">' + escapeHtml(v1.text) + '</div></div>' +
        '<div class="diff-box"><span class="diff-label">差异对照（红删绿增）</span><div class="diff-text">' + renderDiff(v0.text, v1.text) + '</div></div>';
    } else {
      body = '<span class="rule-text">' + escapeHtml(rule.text) + '</span>';
    }
    return (
      '<li class="rule ' + (rule.status === "conflicted" ? "conflicted" : "") + '" data-rule-key="' + key + '" data-rule-id="' + rule.id + '">' +
        '<div class="rule-body">' + body + '</div>' +
        '<div class="rule-meta">' +
          reviewBadge(game, rule) +
          '<span class="rev-tag" title="规则卡修订号">rev ' + rule.rev + '</span>' +
        '</div>' +
        '<div class="rule-actions">' +
          '<button type="button" data-action="confirm" data-rule-key="' + key + '" data-rule-id="' + rule.id + '">' + confirmLabel + '</button>' +
          '<button type="button" data-action="edit" data-rule-key="' + key + '" data-rule-id="' + rule.id + '">编辑</button>' +
          '<button type="button" data-action="peer" data-rule-key="' + key + '" data-rule-id="' + rule.id + '" title="模拟搭子也改了这张卡">模拟对方改</button>' +
          '<button type="button" data-action="delete" data-rule-key="' + key + '" data-rule-id="' + rule.id + '">删除</button>' +
        '</div>' +
      '</li>');
  }

  function renderRuleSection(game, key, title) {
    var items = game[key];
    return (
      '<section class="rule-section"><h3>' + title + '</h3>' +
      '<ul class="rule-list">' +
        (items.length ? items.map(function (r) { return renderRuleItem(game, key, r); }).join("") : '<li><span>暂无内容。</span></li>') +
      '</ul></section>'
    );
  }

  function renderDetail() {
    var game = view.games.find(function (g) { return g.id === selectedId; }) || view.games[0];
    if (!game) {
      els.detailView.innerHTML = '<p class="empty">先添加一个桌游。</p>';
      return;
    }
    selectedId = game.id;
    localStorage.setItem(SELECTED_KEY, selectedId);
    els.detailView.innerHTML =
      '<div class="quick-card">' +
        '<div class="detail-cover">' +
          (game.cover ? '<img src="' + game.cover + '" alt="' + escapeHtml(game.name) + '封面" />' : '<span>' + escapeHtml(game.name.slice(0, 2)) + '</span>') +
        '</div>' +
        '<div><h2>' + escapeHtml(game.name) + '</h2>' +
        '<div class="game-meta">' +
          '<span class="pill">' + game.minPlayers + '-' + game.maxPlayers + '人</span>' +
          '<span class="pill">' + game.duration + '分钟</span>' +
          '<span class="pill heavy">' + escapeHtml(game.complexity) + '</span>' +
          '<span class="pill">' + daysSince(game.lastPlayed) + '天未玩</span>' +
        '</div></div>' +
        renderRuleSection(game, "forgets", "容易忘的规则") +
        renderRuleSection(game, "disputes", "常见争议") +
        renderRuleSection(game, "setup", "开局准备") +
        renderRuleSection(game, "scoring", "计分提醒") +
        '<form class="add-rule" id="ruleForm">' +
          '<select id="ruleTypeInput">' +
            '<option value="forgets">容易忘的规则</option>' +
            '<option value="disputes">常见争议</option>' +
            '<option value="setup">开局准备</option>' +
            '<option value="scoring">计分提醒</option>' +
          '</select>' +
          '<textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>' +
          '<button class="primary" type="submit">加入规则卡片</button>' +
        '</form>' +
        '<div class="detail-actions">' +
          '<button id="playedTodayBtn" type="button">标记今天玩过</button>' +
          '<button id="peerAddRuleBtn" type="button">模拟对方新增规则</button>' +
          '<button id="deleteGameBtn" type="button">删除桌游</button>' +
        '</div>' +
      '</div>';
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function renderSync() {
    // 顶部状态
    els.syncStatus.textContent = online ? "在线 · 改动逐条合并" : "离线 · 改动暂存本机，回网后合并";
    els.syncStatus.className = "sync-status " + (online ? "online" : "offline");
    els.deviceName.value = device.name;
    var pending = C.countPending(outbox, peerPending, conflictCount());
    els.pendingCount.textContent = pending;
    els.conflictCount.textContent = conflictCount();
    var pct = Math.min(100, Math.round((pending / C.CAPACITY) * 100));
    els.capacityBar.style.width = pct + "%";
    els.capacityBar.className = pending >= C.CAPACITY ? "bar full" : "bar";
    els.capacityText.textContent = pending + " / " + C.CAPACITY + " 待办" + (pending >= C.CAPACITY ? "（已满，新改动排队不丢）" : "");

    // 离线批次
    var outHtml = "";
    if (!outbox.length) outHtml = '<p class="empty">没有待合并的离线批次。</p>';
    else {
      outbox.forEach(function (b) {
        var statusLabel = { pending: "待合并", queued: "已排队", partial: "部分失败·可重试", failed: "全部失败·可重试" }[b.status] || b.status;
        var items = b.changes.map(function (ch) {
          var fail = (b.failed || []).find(function (f) { return f.ch === ch; });
          return '<li class="' + (fail ? "failed" : "") + '">' + changeLabel(ch) + (fail ? '<em class="fail-reason">（' + escapeHtml(fail.reason) + '）</em>' : '') + '</li>';
        }).join("");
        outHtml +=
          '<div class="batch ' + b.status + '">' +
            '<div class="batch-head"><strong>批次 ' + b.id.slice(0, 6) + '</strong>' +
            '<span class="batch-status ' + b.status + '">' + statusLabel + '</span></div>' +
            '<ul class="batch-changes">' + (items || '<li class="empty">已全部并入。</li>') + '</ul>' +
            '<div class="batch-actions">' +
              '<button type="button" data-action="retry-batch" data-batch="' + b.id + '">重试未并入的</button>' +
              '<button type="button" data-action="discard-batch" data-batch="' + b.id + '">放弃该批次</button>' +
            '</div>' +
          '</div>';
      });
    }
    els.outboxList.innerHTML = outHtml;

    // 待并入（搭子发来）
    if (!peerPending.length) els.peerList.innerHTML = '<p class="empty">没有待并入的对方改动。</p>';
    else els.peerList.innerHTML = '<ul class="batch-changes">' + peerPending.map(function (ch) {
      return '<li>' + changeLabel(ch) + '</li>';
    }).join("") + '</ul>';

    // 改动账（最近 12 条）
    var ledger = loadLedger();
    var recent = ledger.slice(-12).reverse();
    els.ledgerList.innerHTML = recent.length
      ? '<ul class="ledger-list">' + recent.map(function (ch) {
          return '<li><span class="rev">rev ' + ch.rev + '</span> ' + changeLabel(ch) + ' <em class="who">' + escapeHtml(ch.by || "") + ' · ' + fmtTime(ch.at) + '</em></li>';
        }).join("") + '</ul>'
      : '<p class="empty">改动账为空。</p>';
  }

  function changeLabel(ch) {
    var g = view.games.find(function (x) { return x.id === ch.gameId; });
    var gname = g ? g.name : (ch.gameId ? "已删除的桌游" : "");
    var rname = "";
    if (ch.ruleId && g) {
      C.RULE_KEYS.forEach(function (k) {
        var r = g[k].find(function (x) { return x.id === ch.ruleId; });
        if (r) rname = "「" + r.text.slice(0, 12) + "…」";
      });
    }
    var label = {
      baseline: "基准修订（首次打开迁移）",
      "game.add": "新增桌游《" + gname + "》",
      "game.update": "更新桌游《" + gname + "》资料",
      "game.delete": "删除桌游《" + gname + "》",
      "rule.add": "新增规则卡 " + rname,
      "rule.update": "修改规则卡 " + rname,
      "rule.delete": "删除规则卡 " + rname,
      "review.confirm": "复习确认 " + rname
    }[ch.type] || ch.type;
    return escapeHtml(label);
  }

  function render() {
    renderSummary();
    renderList();
    renderDetail();
    renderSync();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve) {
      if (!file) { resolve(""); return; }
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { resolve(""); };
      reader.readAsDataURL(file);
    });
  }

  function setDefaultDate() {
    var d = new Date();
    d.setMonth(d.getMonth() - 2);
    els.lastPlayedInput.value = d.toISOString().slice(0, 10);
  }

  // ---------- 事件处理 ----------
  function onGameSubmit(event) {
    event.preventDefault();
    var minPlayers = Number(els.minPlayersInput.value);
    var maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
    readFileAsDataUrl(els.coverInput.files[0]).then(function (cover) {
      var at = C.nowIso();
      var game = C.makeGame({
        name: els.nameInput.value.trim(),
        minPlayers: minPlayers,
        maxPlayers: maxPlayers,
        duration: Number(els.durationInput.value),
        complexity: els.complexityInput.value,
        lastPlayed: els.lastPlayedInput.value,
        cover: cover,
        forgets: ["本局开始前先补充容易忘的规则。"],
        disputes: [],
        setup: ["整理组件并按人数调整初始设置。"],
        scoring: ["确认终局计分项和即时得分项。"]
      }, device.name, 1, at);
      var ch = C.buildChange({ type: "game.add", payload: { game: game }, by: device.name, at: at });
      performLocalChange(ch);
      selectedId = game.id;
      localStorage.setItem(SELECTED_KEY, selectedId);
      els.gameForm.reset();
      setDefaultDate();
    });
  }

  function onRuleSubmit(event) {
    if (event.target.id !== "ruleForm") return;
    event.preventDefault();
    var game = view.games.find(function (g) { return g.id === selectedId; });
    if (!game) return;
    var key = document.querySelector("#ruleTypeInput").value;
    var text = document.querySelector("#ruleTextInput").value.trim();
    if (!text) return;
    var rule = C.makeRule(text, device.name, 1, C.nowIso());
    var ch = C.buildChange({
      type: "rule.add", gameId: game.id, ruleKey: key, ruleId: rule.id,
      payload: { rule: rule }, by: device.name
    });
    performLocalChange(ch);
    document.querySelector("#ruleTextInput").value = "";
  }

  function onDetailClick(event) {
    var game = view.games.find(function (g) { return g.id === selectedId; });
    if (!game) return;
    var ruleBtn = event.target.closest("[data-rule-key][data-rule-id]");
    var playedButton = event.target.closest("#playedTodayBtn");
    var deleteButton = event.target.closest("#deleteGameBtn");
    var peerAddButton = event.target.closest("#peerAddRuleBtn");

    if (ruleBtn) {
      var key = ruleBtn.dataset.ruleKey;
      var ruleId = ruleBtn.dataset.ruleId;
      var action = event.target.dataset.action;
      var rule = game[key].find(function (r) { return r.id === ruleId; });
      if (!rule) return;
      if (action === "delete") {
        var chDel = C.buildChange({ type: "rule.delete", gameId: game.id, ruleKey: key, ruleId: ruleId, by: device.name });
        performLocalChange(chDel);
      } else if (action === "confirm") {
        var chCf = C.buildChange({
          type: "review.confirm", gameId: game.id, ruleKey: key, ruleId: ruleId,
          payload: { forRev: rule.rev }, by: device.name
        });
        performLocalChange(chCf);
      } else if (action === "edit") {
        var next = window.prompt("修改规则卡内容（会生成新修订，已有的复习确认需重新确认）：", rule.text);
        if (next === null) return;
        next = next.trim();
        if (!next || next === rule.text) return;
        var chEd = C.buildChange({
          type: "rule.update", gameId: game.id, ruleKey: key, ruleId: ruleId,
          baseRev: rule.rev, payload: { text: next }, by: device.name
        });
        performLocalChange(chEd);
      } else if (action === "peer") {
        simulatePeerEdit(game.id, key, ruleId);
      }
      return;
    }

    if (playedButton) {
      var chPlay = C.buildChange({
        type: "game.update", gameId: game.id,
        payload: { patch: { lastPlayed: new Date().toISOString().slice(0, 10) } }, by: device.name
      });
      performLocalChange(chPlay);
    }
    if (peerAddButton) {
      simulatePeerAddRule(game.id);
    }
    if (deleteButton) {
      if (!window.confirm("删除桌游《" + game.name + "》？该改动会同步给其他搭子。")) return;
      var chGd = C.buildChange({ type: "game.delete", gameId: game.id, by: device.name });
      performLocalChange(chGd);
      selectedId = "";
      localStorage.setItem(SELECTED_KEY, "");
    }
  }

  function onSyncClick(event) {
    var retry = event.target.closest("[data-action='retry-batch']");
    var discard = event.target.closest("[data-action='discard-batch']");
    if (retry) {
      var b = outbox.find(function (x) { return x.id === retry.dataset.batch; });
      if (b) { b.status = "pending"; saveOutbox(); }
      retryFailed();
      return;
    }
    if (discard) {
      discardBatch(discard.dataset.batch);
      return;
    }
    var goOnlineBtn = event.target.closest("#goOnlineBtn");
    var goOfflineBtn = event.target.closest("#goOfflineBtn");
    var demoBtn = event.target.closest("#demoConflictBtn");
    if (goOnlineBtn) goOnline();
    if (goOfflineBtn) goOffline();
    if (demoBtn) demoConflict();
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", render);
    els.playerFilter.addEventListener("change", render);
    els.complexityFilter.addEventListener("change", render);
    els.sortMode.addEventListener("change", render);
    els.gameForm.addEventListener("submit", onGameSubmit);
    els.detailView.addEventListener("submit", onRuleSubmit);
    els.detailView.addEventListener("click", onDetailClick);
    els.syncPanel.addEventListener("click", onSyncClick);
    els.deviceName.addEventListener("change", function () {
      device.name = els.deviceName.value.trim() || device.name;
      localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    });
    if (bc) {
      bc.onmessage = function (e) {
        if (e.data && e.data.type === "ledger" && online) {
          rebuildView();
        }
      };
    }
    window.addEventListener("storage", function (e) {
      if (e.key === LEDGER_KEY && online) rebuildView();
    });
  }

  // ---------- 启动 ----------
  function init() {
    cacheEls();
    migrate();
    bindEvents();
    setDefaultDate();
    rebuildView();
    updatePeerSeen(); // 启动时搭子与我所见一致
    // 在线时启动即拉一次搭子改动
    if (online) pullPeer();
  }

  // 调试 / 端到端测试用的内部导出
  window.__zfl = {
    C: C,
    get view() { return view; },
    get outbox() { return outbox; },
    get peerPending() { return peerPending; },
    get online() { return online; },
    get device() { return device; },
    conflictCount: conflictCount,
    savePeerPending: savePeerPending,
    goOnline: goOnline,
    goOffline: goOffline,
    performLocalChange: performLocalChange,
    simulatePeerEdit: simulatePeerEdit,
    simulatePeerAddRule: simulatePeerAddRule,
    simulatePeerDeleteGame: simulatePeerDeleteGame,
    demoConflict: demoConflict,
    rebuildView: rebuildView,
    flushOutbox: flushOutbox,
    pullPeer: pullPeer,
    retryFailed: retryFailed,
    loadLedger: loadLedger,
    migrate: migrate
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
