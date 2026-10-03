import {
  MAX_PENDING_DIFFS,
  RULE_SECTIONS,
  loadShared,
  loadLocalState,
  saveLocalState,
  buildBaselineEntries,
  recordChange,
  deriveView,
  syncNow,
  ruleConfirmStatus,
  diffTokens,
  createId
} from "./sync.js";

const SECTION_TITLES = {
  forgets: "容易忘的规则",
  disputes: "常见争议",
  setup: "开局准备",
  scoring: "计分提醒"
};

const today = new Date();

// 首次打开的默认数据：走同一条迁移路径，落成基准修订
const defaultLegacyGames = [
  {
    id: createId(),
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
    id: createId(),
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
    id: createId(),
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

const storage = localStorage;

let shared = loadShared(storage);
let state = bootState();
let view = deriveView(state, shared);
let editingRuleId = "";
let editingGameId = "";

function bootState() {
  const loaded = loadLocalState(storage);
  // 旧数据没有修订号：首次打开迁移成基准修订（baseRev 0，合并后成为 rev 1）
  if (loaded.legacy) {
    const fresh = loaded.state;
    fresh.pending.push(...buildBaselineEntries(fresh, loaded.legacy.games));
    fresh.selectedId = loaded.legacy.selectedId || loaded.legacy.games?.[0]?.id || "";
    return fresh;
  }
  if (loaded.fresh) {
    const fresh = loaded.state;
    fresh.pending.push(...buildBaselineEntries(fresh, defaultLegacyGames));
    fresh.selectedId = defaultLegacyGames[0]?.id ?? "";
    return fresh;
  }
  return loaded.state;
}

function persist() {
  saveLocalState(storage, state);
}

function refresh() {
  view = deriveView(state, shared);
}

// 所有本地改动统一入口：记账 -> 持久化 -> 重算视图 -> 重绘
function commit(change) {
  recordChange(state, view, change);
  persist();
  refresh();
  renderAll();
}

function isOnline() {
  return navigator.onLine && !state.simulateOffline;
}

function attemptSync() {
  if (!isOnline()) {
    renderSyncBar();
    return;
  }
  syncNow(storage, state);
  shared = loadShared(storage);
  persist();
  refresh();
  renderAll();
}

const els = {
  syncBar: document.querySelector("#syncBar"),
  conflictPanel: document.querySelector("#conflictPanel"),
  searchInput: document.querySelector("#searchInput"),
  playerFilter: document.querySelector("#playerFilter"),
  complexityFilter: document.querySelector("#complexityFilter"),
  sortMode: document.querySelector("#sortMode"),
  gameForm: document.querySelector("#gameForm"),
  gameFormTitle: document.querySelector("#gameFormTitle"),
  gameSubmitBtn: document.querySelector("#gameSubmitBtn"),
  cancelGameEditBtn: document.querySelector("#cancelGameEditBtn"),
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
  visibleCount: document.querySelector("#visibleCount")
};

function daysSince(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return Math.max(0, Math.floor((today - date) / 86400000));
}

function rulesOf(gameId, section) {
  return view.rules.filter((rule) => rule.gameId === gameId && (!section || rule.section === section));
}

function findGame(gameId) {
  return view.games.find((game) => game.id === gameId);
}

function getFilteredGames() {
  const keyword = els.searchInput.value.trim();
  const player = els.playerFilter.value;
  const complexity = els.complexityFilter.value;
  const games = view.games.filter((game) => {
    const text = `${game.name}${rulesOf(game.id).map((rule) => rule.text).join("")}`;
    const matchesKeyword = !keyword || text.includes(keyword);
    const matchesPlayer = player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
    const matchesComplexity = complexity === "all" || game.complexity === complexity;
    return matchesKeyword && matchesPlayer && matchesComplexity;
  });

  if (els.sortMode.value === "name") return games.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (els.sortMode.value === "complexity") {
    const rank = { 轻: 1, 中: 2, 重: 3 };
    return games.sort((a, b) => rank[b.complexity] - rank[a.complexity]);
  }
  return games.sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed));
}

// ---------- 同步状态条 ----------

function renderSyncBar() {
  const online = isOnline();
  const conflictCount = state.conflicts.filter((item) => !item.resolved).length;
  const batchNote = state.pending.length > 0 && !online ? `（离线批次 ${state.pending.length} 条已保留）` : "";
  els.syncBar.innerHTML = `
    <div class="sync-status">
      <span class="pill ${online ? "net-on" : "net-off"}">${online ? "在线" : state.simulateOffline ? "离线·模拟断网" : "离线"}</span>
      <span>待合并差异 <strong>${state.pending.length}</strong>/${MAX_PENDING_DIFFS}${batchNote}</span>
      <span>排队草稿 <strong>${state.drafts.length}</strong></span>
      <span>未解冲突 <strong>${conflictCount}</strong></span>
      <span>上次同步 ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("zh-CN") : "从未"}</span>
      ${state.lastSyncError ? `<span class="sync-error">上次合并中断：${escapeHtml(state.lastSyncError)}，未合并的 ${state.pending.length} 条会在下次重试</span>` : ""}
    </div>
    <div class="sync-actions">
      <button id="syncNowBtn" type="button" ${online ? "" : "disabled"}>立即同步</button>
      <button id="toggleOfflineBtn" type="button">${state.simulateOffline ? "恢复联网" : "模拟断网"}</button>
    </div>
  `;
}

// ---------- 冲突面板：两份内容都留下并标出差异 ----------

function renderConflictPanel() {
  const open = state.conflicts.filter((item) => !item.resolved);
  if (!open.length) {
    els.conflictPanel.innerHTML = "";
    els.conflictPanel.hidden = true;
    return;
  }
  els.conflictPanel.hidden = false;
  els.conflictPanel.innerHTML = `
    <h2>合并冲突（${open.length}）：先到的已保留，后到的没有覆盖它</h2>
    ${open.map(renderConflictItem).join("")}
  `;
}

function renderConflictItem(conflict) {
  const isDelete = conflict.entryType.endsWith(".delete");
  const remoteData = conflict.remote?.data ?? {};
  const localData = conflict.local.payload ?? {};
  const gameId = remoteData.gameId ?? localData.gameId ?? conflict.entityId;
  const game = findGame(gameId) ?? findGame(remoteData.gameId) ?? findGame(localData.gameId);
  const where =
    conflict.entityType === "rule"
      ? `规则卡 · ${game ? `《${escapeHtml(game.name)}》` : "未知桌游"} · ${SECTION_TITLES[remoteData.section ?? localData.section] ?? ""}`
      : `桌游 · 《${escapeHtml(remoteData.name ?? localData.name ?? "")}》`;

  let versions;
  if (conflict.entityType === "rule" && !isDelete) {
    const remoteText = conflict.remote?.deleted ? "（对方已删除这张卡）" : String(remoteData.text ?? "");
    const localText = String(localData.text ?? "");
    const tokens = diffTokens(conflict.remote?.deleted ? "" : remoteText, localText);
    const remoteHtml = tokens
      .filter((t) => t.type !== "add")
      .map((t) => (t.type === "del" ? `<del>${escapeHtml(t.text)}</del>` : escapeHtml(t.text)))
      .join("");
    const localHtml = tokens
      .filter((t) => t.type !== "del")
      .map((t) => (t.type === "add" ? `<ins>${escapeHtml(t.text)}</ins>` : escapeHtml(t.text)))
      .join("");
    versions = `
      <div class="ver remote"><strong>共享版（先到，rev ${conflict.remote?.rev ?? 0}）：</strong>${conflict.remote?.deleted ? escapeHtml(remoteText) : remoteHtml}</div>
      <div class="ver local"><strong>我的改动（后到，未覆盖）：</strong>${localHtml}</div>
    `;
  } else {
    versions = `
      <div class="ver remote"><strong>共享版（先到，rev ${conflict.remote?.rev ?? 0}）：</strong>${escapeHtml(describeVersion(conflict.entityType, remoteData, conflict.remote?.deleted))}</div>
      <div class="ver local"><strong>我的改动（后到，未覆盖）：</strong>${escapeHtml(isDelete ? "删除这张卡" : describeVersion(conflict.entityType, localData, false))}</div>
    `;
  }

  const keepMineLabel = isDelete ? "仍然删除" : conflict.entityType === "rule" ? "我的另存为新卡" : "用我的覆盖共享版";
  return `
    <div class="conflict-item" data-conflict-id="${conflict.id}">
      <div class="conflict-where">${where}</div>
      <div class="conflict-versions">${versions}</div>
      <div class="conflict-actions">
        <button type="button" class="primary" data-conflict-action="keep">${keepMineLabel}</button>
        <button type="button" data-conflict-action="drop">${isDelete ? "保留共享版" : "放弃我的改动"}</button>
      </div>
    </div>
  `;
}

function describeVersion(entityType, data, deleted) {
  if (deleted) return "（已删除）";
  if (entityType === "rule") return String(data.text ?? "");
  return `${data.name ?? ""}（${data.minPlayers ?? "?"}-${data.maxPlayers ?? "?"}人 · ${data.duration ?? "?"}分钟 · ${data.complexity ?? "?"} · 上次游玩 ${data.lastPlayed ?? "?"}）`;
}

function resolveConflict(conflictId, action) {
  const conflict = state.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.resolved) return;
  if (action === "keep") {
    if (conflict.entryType.endsWith(".delete")) {
      // 仍然删除：基于当前共享修订再记一条删除
      commit({ type: conflict.entryType, entityId: conflict.entityId });
    } else if (conflict.entityType === "rule") {
      // 另存为新卡：两份内容都留在卡库里
      const payload = { ...conflict.local.payload, order: state.localSeq + 1 };
      commit({ type: "rule.upsert", entityId: createId(), payload });
    } else {
      // 用我的覆盖共享版：基于当前视图里的最新修订记一条，用户显式选择后才覆盖
      commit({ type: "game.upsert", entityId: conflict.entityId, payload: { ...conflict.local.payload } });
    }
  }
  conflict.resolved = true;
  persist();
  refresh();
  renderAll();
}

// ---------- 汇总 / 列表 / 详情 ----------

function renderSummary() {
  const stale = [...view.games].sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed))[0];
  els.gameCount.textContent = view.games.length;
  els.ruleCount.textContent = view.rules.length;
  els.staleGame.textContent = stale ? `${daysSince(stale.lastPlayed)}天` : "-";
}

function renderList() {
  const games = getFilteredGames();
  els.visibleCount.textContent = `${games.length}个匹配`;
  els.gameList.innerHTML =
    games
      .map((game) => {
        const selected = game.id === state.selectedId ? "selected" : "";
        return `
          <article class="game-card ${selected}" data-game-id="${game.id}">
            <div class="cover">
              ${
                game.cover
                  ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
                  : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
              }
              <span class="stale-ribbon">${daysSince(game.lastPlayed)}天未玩</span>
            </div>
            <div class="game-body">
              <h3>${escapeHtml(game.name)}</h3>
              <div class="game-meta">
                <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
                <span class="pill">${game.duration}分钟</span>
                <span class="pill heavy">${escapeHtml(game.complexity)}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">没有符合筛选的桌游。</p>`;
}

function renderDetail() {
  const game = findGame(state.selectedId) || view.games[0];
  if (!game) {
    els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
    return;
  }
  state.selectedId = game.id;
  els.detailView.innerHTML = `
    <div class="quick-card">
      <div class="detail-cover">
        ${game.cover ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />` : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`}
      </div>
      <div>
        <h2>${escapeHtml(game.name)}</h2>
        <div class="game-meta">
          <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
          <span class="pill">${game.duration}分钟</span>
          <span class="pill heavy">${escapeHtml(game.complexity)}</span>
          <span class="pill">${daysSince(game.lastPlayed)}天未玩</span>
        </div>
      </div>
      ${RULE_SECTIONS.map((key) => renderRuleSection(SECTION_TITLES[key], key, rulesOf(game.id, key))).join("")}
      ${renderReviewSection(game)}
      <form class="add-rule" id="ruleForm">
        <select id="ruleTypeInput">
          ${RULE_SECTIONS.map((key) => `<option value="${key}">${SECTION_TITLES[key]}</option>`).join("")}
        </select>
        <textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>
        <button class="primary" type="submit">加入规则卡片</button>
      </form>
      <div class="detail-actions">
        <button id="playedTodayBtn" type="button">标记今天玩过</button>
        <button id="editGameBtn" type="button">修改信息</button>
        <button id="deleteGameBtn" type="button">删除桌游</button>
      </div>
    </div>
  `;
}

function renderRuleSection(title, key, rules) {
  return `
    <section class="rule-section">
      <h3>${title}</h3>
      <ul class="rule-list">
        ${
          rules
            .map((rule) => {
              if (rule.id === editingRuleId) {
                return `
                  <li data-rule-id="${rule.id}">
                    <textarea class="rule-edit-area" id="ruleEditArea" rows="3">${escapeHtml(rule.text)}</textarea>
                    <span class="rule-actions">
                      <button type="button" class="mini-btn" data-rule-save="${rule.id}">存</button>
                      <button type="button" class="mini-btn" data-rule-cancel>取消</button>
                    </span>
                  </li>
                `;
              }
              const confirm = ruleConfirmStatus(view, rule);
              const pill =
                confirm.status === "valid"
                  ? `<span class="pill ok">已复习</span>`
                  : confirm.status === "stale"
                    ? `<span class="pill stale">需重新确认</span>`
                    : "";
              return `
                <li data-rule-id="${rule.id}">
                  <span class="rule-text">${escapeHtml(rule.text)}</span>
                  ${pill}
                  <span class="rule-actions">
                    <button type="button" class="mini-btn" title="编辑" data-rule-edit="${rule.id}">改</button>
                    <button type="button" class="mini-btn" title="删除" data-rule-del="${rule.id}">×</button>
                  </span>
                </li>
              `;
            })
            .join("") || `<li><span>暂无内容。</span></li>`
        }
      </ul>
    </section>
  `;
}

function renderReviewSection(game) {
  const rules = rulesOf(game.id);
  const items = rules
    .map((rule) => {
      const { status, confirmation } = ruleConfirmStatus(view, rule);
      const pill =
        status === "valid"
          ? `<span class="pill ok">已确认 · ${escapeHtml(confirmation.deviceId.slice(0, 4))} · ${new Date(confirmation.at).toLocaleString("zh-CN")}</span>`
          : status === "stale"
            ? `<span class="pill stale">内容已变，需重新确认</span>`
            : `<span class="pill todo">未确认</span>`;
      return `
        <li class="review-item">
          <span class="rule-text">${escapeHtml(rule.text)}</span>
          ${pill}
          <button type="button" class="mini-btn" data-confirm-rule="${rule.id}" ${status === "valid" ? "disabled" : ""}>确认已复习</button>
        </li>
      `;
    })
    .join("");
  const staleCount = rules.filter((rule) => ruleConfirmStatus(view, rule).status !== "valid").length;
  return `
    <section class="rule-section review-section">
      <h3>开局前复习确认</h3>
      <p class="review-hint">规则内容一有变化，对应确认立即失效，需重新确认。当前还有 ${staleCount} 条待确认。</p>
      <ul class="rule-list review-list">${items || `<li><span>暂无规则卡。</span></li>`}</ul>
      <button id="confirmAllBtn" type="button" ${staleCount ? "" : "disabled"}>全部确认已复习</button>
    </section>
  `;
}

function renderAll() {
  renderSyncBar();
  renderConflictPanel();
  renderSummary();
  renderList();
  renderDetail();
}

// ---------- 表单与动作 ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function submitGameForm(event) {
  event.preventDefault();
  const minPlayers = Number(els.minPlayersInput.value);
  const maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
  const fields = {
    name: els.nameInput.value.trim(),
    minPlayers,
    maxPlayers,
    duration: Number(els.durationInput.value),
    complexity: els.complexityInput.value,
    lastPlayed: els.lastPlayedInput.value
  };

  if (editingGameId) {
    const game = findGame(editingGameId);
    if (!game) return;
    const coverFile = els.coverInput.files[0];
    const cover = coverFile ? await readFileAsDataUrl(coverFile) : game.cover;
    commit({ type: "game.upsert", entityId: game.id, payload: { ...fields, cover } });
    exitGameEditMode();
    return;
  }

  const cover = await readFileAsDataUrl(els.coverInput.files[0]);
  const gameId = createId();
  commit({ type: "game.upsert", entityId: gameId, payload: { ...fields, cover } });
  // 新桌游自带三条提醒卡
  const seedRules = [
    { section: "forgets", text: "本局开始前先补充容易忘的规则。" },
    { section: "setup", text: "整理组件并按人数调整初始设置。" },
    { section: "scoring", text: "确认终局计分项和即时得分项。" }
  ];
  for (const seed of seedRules) {
    recordChange(state, view, {
      type: "rule.upsert",
      entityId: createId(),
      payload: { gameId, section: seed.section, text: seed.text, order: state.localSeq + 1 }
    });
  }
  state.selectedId = gameId;
  persist();
  refresh();
  els.gameForm.reset();
  setDefaultDate();
  renderAll();
}

function enterGameEditMode() {
  const game = findGame(state.selectedId);
  if (!game) return;
  editingGameId = game.id;
  els.gameFormTitle.textContent = `修改：${game.name}`;
  els.gameSubmitBtn.textContent = "保存修改";
  els.cancelGameEditBtn.hidden = false;
  els.nameInput.value = game.name;
  els.minPlayersInput.value = game.minPlayers;
  els.maxPlayersInput.value = game.maxPlayers;
  els.durationInput.value = game.duration;
  els.complexityInput.value = game.complexity;
  els.lastPlayedInput.value = game.lastPlayed;
  els.nameInput.focus();
}

function exitGameEditMode() {
  editingGameId = "";
  els.gameFormTitle.textContent = "新增桌游";
  els.gameSubmitBtn.textContent = "加入收藏";
  els.cancelGameEditBtn.hidden = true;
  els.gameForm.reset();
  setDefaultDate();
}

function setDefaultDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 2);
  els.lastPlayedInput.value = date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- 事件 ----------

els.searchInput.addEventListener("input", renderAll);
els.playerFilter.addEventListener("change", renderAll);
els.complexityFilter.addEventListener("change", renderAll);
els.sortMode.addEventListener("change", renderAll);
els.gameForm.addEventListener("submit", submitGameForm);
els.cancelGameEditBtn.addEventListener("click", exitGameEditMode);

els.gameList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  state.selectedId = card.dataset.gameId;
  editingRuleId = "";
  persist();
  renderAll();
});

els.syncBar.addEventListener("click", (event) => {
  if (event.target.closest("#syncNowBtn")) attemptSync();
  if (event.target.closest("#toggleOfflineBtn")) {
    state.simulateOffline = !state.simulateOffline;
    persist();
    renderSyncBar();
    if (!state.simulateOffline) attemptSync();
  }
});

els.conflictPanel.addEventListener("click", (event) => {
  const button = event.target.closest("[data-conflict-action]");
  if (!button) return;
  const item = button.closest("[data-conflict-id]");
  resolveConflict(item.dataset.conflictId, button.dataset.conflictAction);
});

els.detailView.addEventListener("submit", (event) => {
  if (event.target.id !== "ruleForm") return;
  event.preventDefault();
  const game = findGame(state.selectedId);
  if (!game) return;
  const section = document.querySelector("#ruleTypeInput").value;
  const text = document.querySelector("#ruleTextInput").value.trim();
  if (!text) return;
  commit({
    type: "rule.upsert",
    entityId: createId(),
    payload: { gameId: game.id, section, text, order: state.localSeq + 1 }
  });
});

els.detailView.addEventListener("click", (event) => {
  const game = findGame(state.selectedId);

  const editBtn = event.target.closest("[data-rule-edit]");
  if (editBtn) {
    editingRuleId = editBtn.dataset.ruleEdit;
    renderAll();
    document.querySelector("#ruleEditArea")?.focus();
    return;
  }

  const saveBtn = event.target.closest("[data-rule-save]");
  if (saveBtn) {
    const text = document.querySelector("#ruleEditArea")?.value.trim();
    const rule = view.rules.find((item) => item.id === saveBtn.dataset.ruleSave);
    editingRuleId = "";
    if (rule && text && text !== rule.text) {
      // 规则内容变化 -> 修订号 +1 -> 相关复习确认立即失效
      commit({
        type: "rule.upsert",
        entityId: rule.id,
        payload: { gameId: rule.gameId, section: rule.section, text, order: rule.order }
      });
    } else {
      renderAll();
    }
    return;
  }

  if (event.target.closest("[data-rule-cancel]")) {
    editingRuleId = "";
    renderAll();
    return;
  }

  const delBtn = event.target.closest("[data-rule-del]");
  if (delBtn) {
    commit({ type: "rule.delete", entityId: delBtn.dataset.ruleDel });
    return;
  }

  const confirmBtn = event.target.closest("[data-confirm-rule]");
  if (confirmBtn) {
    const rule = view.rules.find((item) => item.id === confirmBtn.dataset.confirmRule);
    if (rule) commit({ type: "review.confirm", entityId: rule.id, payload: { rev: rule.rev } });
    return;
  }

  if (event.target.closest("#confirmAllBtn")) {
    for (const rule of rulesOf(game.id)) {
      if (ruleConfirmStatus(view, rule).status !== "valid") {
        recordChange(state, view, { type: "review.confirm", entityId: rule.id, payload: { rev: rule.rev } });
        refresh();
      }
    }
    persist();
    renderAll();
    return;
  }

  if (!game) return;

  if (event.target.closest("#playedTodayBtn")) {
    commit({
      type: "game.upsert",
      entityId: game.id,
      payload: {
        name: game.name,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        duration: game.duration,
        complexity: game.complexity,
        lastPlayed: new Date().toISOString().slice(0, 10),
        cover: game.cover
      }
    });
    return;
  }

  if (event.target.closest("#editGameBtn")) {
    enterGameEditMode();
    return;
  }

  if (event.target.closest("#deleteGameBtn")) {
    for (const rule of rulesOf(game.id)) {
      recordChange(state, view, { type: "rule.delete", entityId: rule.id });
      refresh();
    }
    recordChange(state, view, { type: "game.delete", entityId: game.id });
    state.selectedId = view.games.find((item) => item.id !== game.id)?.id ?? "";
    persist();
    refresh();
    renderAll();
  }
});

window.addEventListener("online", attemptSync);
window.addEventListener("offline", renderSyncBar);
// 另一个标签页/浏览器窗口改了共享账本时，跟着刷新视图
window.addEventListener("storage", (event) => {
  if (event.key && event.key.includes("shared-ledger")) {
    shared = loadShared(storage);
    refresh();
    renderAll();
  }
});

setInterval(() => {
  if (isOnline() && (state.pending.length || state.drafts.length)) attemptSync();
}, 15000);

setDefaultDate();
persist();
renderAll();
if (isOnline() && state.pending.length) attemptSync();
