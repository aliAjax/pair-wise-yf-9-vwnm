// 改动账引擎：把收藏桌游、规则卡、复习确认全部变成带修订号的变更条目。
// 断网时改动进本地待合并队列；回网后逐条合并进共享账本。
// 本文件不碰 DOM，storage 全部注入，方便在 Node 里单测。

export const STORAGE_KEY = "zfl18-boardgame-rule-cards";
export const SHARED_KEY = "zfl18-shared-ledger";
export const MAX_PENDING_DIFFS = 30; // 待确认差异容量上限，超过后新改动先排进草稿
export const RULE_SECTIONS = ["forgets", "disputes", "setup", "scoring"];

export function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------- 共享账本（模拟回网后大家汇合的那本账） ----------

export function emptyShared() {
  return { entries: [], entities: {}, confirmations: [] };
}

export function loadShared(storage) {
  try {
    const raw = storage.getItem(SHARED_KEY);
    if (!raw) return emptyShared();
    return { ...emptyShared(), ...JSON.parse(raw) };
  } catch {
    return emptyShared();
  }
}

export function saveShared(storage, shared) {
  storage.setItem(SHARED_KEY, JSON.stringify(shared));
}

// ---------- 本地状态 ----------

export function initialLocalState(deviceId = createId()) {
  return {
    version: 2,
    deviceId,
    localSeq: 0,
    selectedId: "",
    pending: [], // 待合并差异（离线批次）
    drafts: [], // 容量满后排队的草稿，不丢
    conflicts: [], // 合并冲突：先到的与后到的两份内容都留在这里
    appliedEntryIds: [], // 已经从共享账本拉取过的条目
    currentBatchId: null,
    lastSyncAt: "",
    lastSyncError: "",
    simulateOffline: false
  };
}

export function loadLocalState(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return { state: initialLocalState(), fresh: true, legacy: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 2) {
      return { state: { ...initialLocalState(), ...parsed }, fresh: false, legacy: null };
    }
    // 旧数据没有修订号：交给调用方迁移成基准修订
    return { state: initialLocalState(), fresh: false, legacy: parsed };
  } catch {
    return { state: initialLocalState(), fresh: true, legacy: null };
  }
}

export function saveLocalState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- 变更条目 ----------

function makeEntry(state, { type, entityId, baseRev, payload = null }) {
  state.localSeq += 1;
  return {
    id: createId(),
    deviceId: state.deviceId,
    seq: state.localSeq,
    batchId: state.currentBatchId ?? null,
    type, // game.upsert | game.delete | rule.upsert | rule.delete | review.confirm
    entityId,
    baseRev, // 改动基于的修订号，合并时据此判定冲突
    payload,
    at: new Date().toISOString(),
    status: "pending"
  };
}

// 记录一条本地改动。容量满时进草稿队列，草稿不丢。
export function recordChange(state, view, { type, entityId, payload = null }) {
  if (!state.currentBatchId) state.currentBatchId = createId();
  const entity = view.entities[entityId];
  const entry = makeEntry(state, { type, entityId, baseRev: entity ? entity.rev : 0, payload });
  if (state.pending.length >= MAX_PENDING_DIFFS) {
    entry.status = "draft";
    state.drafts.push(entry);
  } else {
    state.pending.push(entry);
  }
  return entry;
}

// 旧数据迁移：没有修订号的收藏/规则卡逐条变成基准修订（baseRev 0 -> rev 1）
export function buildBaselineEntries(state, legacyGames) {
  const entries = [];
  for (const game of legacyGames ?? []) {
    entries.push(
      makeEntry(state, {
        type: "game.upsert",
        entityId: game.id,
        baseRev: 0,
        payload: {
          name: game.name,
          minPlayers: game.minPlayers,
          maxPlayers: game.maxPlayers,
          duration: game.duration,
          complexity: game.complexity,
          lastPlayed: game.lastPlayed,
          cover: game.cover ?? ""
        }
      })
    );
    for (const section of RULE_SECTIONS) {
      for (const text of game[section] ?? []) {
        entries.push(
          makeEntry(state, {
            type: "rule.upsert",
            entityId: createId(),
            baseRev: 0,
            payload: { gameId: game.id, section, text: String(text), order: state.localSeq }
          })
        );
      }
    }
  }
  return entries;
}

// ---------- 视图物化：共享账本 + 本地待合并 + 草稿 ----------

function applyEntryTentative(entities, confirmations, entry) {
  const rev = entry.baseRev + 1;
  switch (entry.type) {
    case "game.upsert":
      entities[entry.entityId] = { type: "game", rev, deleted: false, data: { ...entry.payload } };
      break;
    case "game.delete":
      entities[entry.entityId] = { ...(entities[entry.entityId] ?? { type: "game", data: {} }), rev, deleted: true };
      break;
    case "rule.upsert":
      entities[entry.entityId] = { type: "rule", rev, deleted: false, data: { ...entry.payload } };
      break;
    case "rule.delete":
      entities[entry.entityId] = { ...(entities[entry.entityId] ?? { type: "rule", data: {} }), rev, deleted: true };
      break;
    case "review.confirm":
      confirmations.push({
        id: entry.id,
        ruleId: entry.entityId,
        rev: entry.payload?.rev ?? entry.baseRev,
        deviceId: entry.deviceId,
        at: entry.at
      });
      break;
  }
}

export function deriveView(state, shared) {
  const entities = structuredClone(shared.entities);
  const confirmations = shared.confirmations.map((item) => ({ ...item }));
  for (const entry of [...state.pending, ...state.drafts]) {
    applyEntryTentative(entities, confirmations, entry);
  }
  const games = [];
  const rules = [];
  for (const [id, entity] of Object.entries(entities)) {
    if (entity.deleted) continue;
    if (entity.type === "game") games.push({ id, rev: entity.rev, ...entity.data });
    if (entity.type === "rule") rules.push({ id, rev: entity.rev, ...entity.data });
  }
  rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { entities, games, rules, confirmations };
}

// ---------- 复习确认：确认绑定修订号，内容一变立即失效 ----------

export function latestConfirmation(view, ruleId, rev) {
  const matches = view.confirmations.filter((c) => c.ruleId === ruleId && (rev === undefined || c.rev === rev));
  return matches.sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
}

export function ruleConfirmStatus(view, rule) {
  const valid = latestConfirmation(view, rule.id, rule.rev);
  if (valid) return { status: "valid", confirmation: valid };
  const stale = latestConfirmation(view, rule.id);
  return stale ? { status: "stale", confirmation: stale } : { status: "none", confirmation: null };
}

// ---------- 合并 ----------

function buildConflict(entry, current) {
  return {
    id: createId(),
    at: new Date().toISOString(),
    entityId: entry.entityId,
    entityType: entry.type.split(".")[0],
    entryType: entry.type,
    // 后到的（本地）内容
    local: { deviceId: entry.deviceId, payload: entry.payload ?? null, baseRev: entry.baseRev },
    // 先到的（共享账本里的）内容，后到的不能盖掉它
    remote: current ? { rev: current.rev, deleted: !!current.deleted, data: current.data ?? null } : null,
    resolved: false
  };
}

// 把单条条目落进共享账本。返回 { merged } 或 { conflict }。可能抛错（存储失败）。
function commitEntry(shared, entry) {
  if (entry.type === "review.confirm") {
    shared.confirmations.push({
      id: entry.id,
      ruleId: entry.entityId,
      rev: entry.payload?.rev ?? entry.baseRev,
      deviceId: entry.deviceId,
      at: entry.at
    });
    shared.entries.push({ ...entry, status: "merged", rev: entry.payload?.rev ?? entry.baseRev });
    return { merged: true };
  }
  const current = shared.entities[entry.entityId];
  const currentRev = current?.rev ?? 0;
  if (entry.baseRev !== currentRev) {
    // 两个人同时改了同一张卡：不覆盖，两份都留下
    return { merged: false, conflict: buildConflict(entry, current) };
  }
  const rev = currentRev + 1;
  switch (entry.type) {
    case "game.upsert":
      shared.entities[entry.entityId] = { type: "game", rev, deleted: false, data: { ...entry.payload } };
      break;
    case "game.delete":
      shared.entities[entry.entityId] = { ...(current ?? { type: "game", data: {} }), rev, deleted: true };
      break;
    case "rule.upsert":
      shared.entities[entry.entityId] = { type: "rule", rev, deleted: false, data: { ...entry.payload } };
      break;
    case "rule.delete":
      shared.entities[entry.entityId] = { ...(current ?? { type: "rule", data: {} }), rev, deleted: true };
      break;
    default:
      throw new Error(`未知条目类型: ${entry.type}`);
  }
  shared.entries.push({ ...entry, status: "merged", rev });
  return { merged: true };
}

export function promoteDrafts(state) {
  while (state.drafts.length && state.pending.length < MAX_PENDING_DIFFS) {
    const draft = state.drafts.shift();
    draft.status = "pending";
    state.pending.push(draft);
  }
}

// 回网后的主流程：先拉别人的，再把自己的待合并条目逐条推进共享账本。
// 每条落账成功立即持久化；中途失败则保留离线批次，下次只重试没合并进去的那些。
export function syncNow(sharedStorage, state, now = () => new Date().toISOString()) {
  const shared = loadShared(sharedStorage);
  const result = { pulled: 0, merged: 0, conflicts: 0, failed: false, error: "" };

  for (const entry of shared.entries) {
    if (!state.appliedEntryIds.includes(entry.id)) {
      state.appliedEntryIds.push(entry.id);
      result.pulled += 1;
    }
  }
  if (state.appliedEntryIds.length > 5000) {
    state.appliedEntryIds = state.appliedEntryIds.slice(-5000);
  }

  const remaining = [];
  for (const entry of state.pending) {
    if (result.failed) {
      remaining.push(entry);
      continue;
    }
    try {
      const outcome = commitEntry(shared, entry);
      if (outcome.merged) {
        saveShared(sharedStorage, shared);
        result.merged += 1;
      } else {
        state.conflicts.push(outcome.conflict);
        result.conflicts += 1;
      }
    } catch (err) {
      result.failed = true;
      result.error = String(err?.message ?? err);
      remaining.push(entry);
    }
  }
  state.pending = remaining;
  if (state.conflicts.length > 100) {
    state.conflicts = state.conflicts.slice(-100);
  }

  promoteDrafts(state);
  state.lastSyncAt = now();
  state.lastSyncError = result.failed ? result.error : "";
  if (!result.failed && state.pending.length === 0) state.currentBatchId = null;
  return result;
}

// ---------- 差异标注：字符级 diff，冲突时两份内容并排标出 ----------

export function diffTokens(oldText, newText) {
  const a = [...String(oldText ?? "")];
  const b = [...String(newText ?? "")];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const tokens = [];
  if (start > 0) tokens.push({ type: "same", text: a.slice(0, start).join("") });
  tokens.push(...lcsTokens(midA, midB));
  if (endA < a.length) tokens.push({ type: "same", text: a.slice(endA).join("") });
  return mergeRuns(tokens);
}

function lcsTokens(midA, midB) {
  const n = midA.length;
  const m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const tokens = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      tokens.push({ type: "same", text: midA[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ type: "del", text: midA[i] });
      i += 1;
    } else {
      tokens.push({ type: "add", text: midB[j] });
      j += 1;
    }
  }
  while (i < n) tokens.push({ type: "del", text: midA[(i += 1) - 1] });
  while (j < m) tokens.push({ type: "add", text: midB[(j += 1) - 1] });
  return tokens;
}

function mergeRuns(tokens) {
  const out = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (last && last.type === token.type) last.text += token.text;
    else out.push({ type: token.type, text: token.text });
  }
  return out.filter((token) => token.text.length > 0);
}
