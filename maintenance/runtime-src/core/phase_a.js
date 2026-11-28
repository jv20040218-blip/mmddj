// Phase A helpers: segment entry snapshots, hidden floors, suspect-route
// summaries, and experience marks. Pure functions; no host I/O.
'use strict';

const S = require('./state');

const ACT_SUMMARY_ID = 'ark-story-act-summaries';
const ACT_SUMMARY_LIMIT = 200;
const REANCHOR_PROMPT_ID = 'ark-story-reanchor';
const SUSPECT_ROUTE_IDS = new Set(['route:AM']);

function defaultUiSettings() {
  return { act_summary_injection: false, inspect_hidden_floors: false };
}

function ensurePhaseA(state) {
  if (!state || typeof state !== 'object') return state;
  if (!Array.isArray(state.hidden_message_ids)) state.hidden_message_ids = [];
  if (!state.segment_entry_snapshots || typeof state.segment_entry_snapshots !== 'object') state.segment_entry_snapshots = {};
  if (!state.scene_experience || typeof state.scene_experience !== 'object') state.scene_experience = {};
  if (!state.ui_settings || typeof state.ui_settings !== 'object') state.ui_settings = defaultUiSettings();
  if (state.ui_settings.act_summary_injection == null) state.ui_settings.act_summary_injection = false;
  if (state.ui_settings.inspect_hidden_floors == null) state.ui_settings.inspect_hidden_floors = false;
  return state;
}

function segmentKey(state, routeId, sceneId, segmentIndex) {
  const branch = (state && state.branch_id) || 'branch_1';
  const seg = segmentIndex == null
    ? ((state && state.corpus_progress && state.corpus_progress[routeId] && state.corpus_progress[routeId].segment_index) || 0)
    : segmentIndex;
  return branch + '|' + routeId + '|' + sceneId + '|' + seg;
}

function currentSegmentIndex(state) {
  const active = state && state.active_route;
  if (!active) return 0;
  const p = state.corpus_progress && state.corpus_progress[active.route_id];
  return p && p.segment_index != null ? p.segment_index : 0;
}

function cloneEntryRecord(state, capturedLastMessageId) {
  const { snapshots, snapshot_order, segment_entry_snapshots, hidden_message_ids, reanchor_pending, ...running } = state;
  const record = S.cloneState(running);
  delete record.segment_entry_snapshots;
  delete record.hidden_message_ids;
  delete record.reanchor_pending;
  if (capturedLastMessageId != null) record.captured_last_message_id = capturedLastMessageId;
  return record;
}

function recordEntrySnapshot(state, capturedLastMessageId) {
  ensurePhaseA(state);
  const active = state.active_route;
  if (!active) return null;
  const key = segmentKey(state, active.route_id, active.scene_id, currentSegmentIndex(state));
  if (!state.segment_entry_snapshots[key]) {
    state.segment_entry_snapshots[key] = cloneEntryRecord(state, capturedLastMessageId);
  } else if (capturedLastMessageId != null && state.segment_entry_snapshots[key].captured_last_message_id == null) {
    state.segment_entry_snapshots[key].captured_last_message_id = capturedLastMessageId;
  }
  if (state.active_route) state.active_route.entry_snapshot_id = state.active_route.entry_snapshot_id || key;
  return key;
}

function getEntrySnapshot(state, routeId, sceneId, segmentIndex) {
  if (!state || !state.segment_entry_snapshots) return null;
  return state.segment_entry_snapshots[segmentKey(state, routeId, sceneId, segmentIndex)] || null;
}

function restoreEntrySnapshot(state, routeId, sceneId, segmentIndex) {
  ensurePhaseA(state);
  const record = getEntrySnapshot(state, routeId, sceneId, segmentIndex);
  if (!record) return null;
  const restored = S.cloneState(record);
  delete restored.captured_last_message_id;
  restored.snapshots = state.snapshots;
  restored.snapshot_order = state.snapshot_order;
  restored.segment_entry_snapshots = state.segment_entry_snapshots;
  restored.hidden_message_ids = (state.hidden_message_ids || []).slice();
  restored.ui_settings = state.ui_settings ? { ...state.ui_settings } : defaultUiSettings();
  restored.scene_experience = { ...(record.scene_experience || {}), ...(state.scene_experience || {}) };
  restored.reanchor_pending = null;
  ensurePhaseA(restored);
  return restored;
}

function markSceneExperience(state, kind, messageId, extra) {
  ensurePhaseA(state);
  const loc = extra || {};
  const active = state.active_route || {};
  const routeId = loc.route_id || active.route_id;
  const sceneId = loc.scene_id || active.scene_id;
  if (!routeId || sceneId == null) return null;
  const segmentIndex = loc.segment_index != null ? loc.segment_index : currentSegmentIndex(state);
  const key = segmentKey(state, routeId, sceneId, segmentIndex);
  state.scene_experience[key] = {
    kind, // 'read' | 'skipped' | 'played'
    route_id: routeId,
    scene_id: sceneId,
    segment_index: segmentIndex,
    message_id: messageId == null ? null : messageId,
    at_revision: state.revision,
    ...(loc.summary ? { summary: loc.summary } : {}),
    ...(loc.title ? { title: loc.title } : {})
  };
  return key;
}

function addHiddenMessageIds(state, ids) {
  ensurePhaseA(state);
  const set = new Set(state.hidden_message_ids.map(String));
  for (const id of ids || []) {
    if (id == null || id === '') continue;
    set.add(String(id));
  }
  state.hidden_message_ids = [...set];
  return state.hidden_message_ids.slice();
}

function unhideMessageIds(state, ids) {
  ensurePhaseA(state);
  if (!ids) {
    state.hidden_message_ids = [];
    return state.hidden_message_ids;
  }
  const drop = new Set((ids || []).map(String));
  state.hidden_message_ids = state.hidden_message_ids.filter(id => !drop.has(String(id)));
  return state.hidden_message_ids.slice();
}

function isHiddenMessage(state, messageId) {
  if (messageId == null || !state || !state.hidden_message_ids) return false;
  return state.hidden_message_ids.map(String).includes(String(messageId));
}

function messageIdOf(entry) {
  if (entry == null || typeof entry !== 'object') return null;
  if (entry.message_id != null) return entry.message_id;
  if (entry.mesId != null) return entry.mesId;
  if (entry.mesid != null) return entry.mesid;
  if (entry.index != null) return entry.index;
  if (entry.mes_id != null) return entry.mes_id;
  return null;
}

function filterOutboundMessages(messages, state) {
  if (!Array.isArray(messages)) return messages;
  const hidden = new Set(((state && state.hidden_message_ids) || []).map(String));
  if (!hidden.size) return messages.slice();
  return messages.filter(m => !hidden.has(String(messageIdOf(m))));
}

// Filter a prompt-event payload without mutating the live saved chat array.
function filterOutboundPrompt(payload, state, liveChat) {
  const hidden = new Set(((state && state.hidden_message_ids) || []).map(String));
  if (!hidden.size) return payload;
  const drop = list => Array.isArray(list) ? list.filter(m => !hidden.has(String(messageIdOf(m)))) : list;
  if (Array.isArray(payload)) return drop(payload);
  if (!payload || typeof payload !== 'object') return payload;
  const out = payload;
  if (Array.isArray(out.chat)) {
    out.chat = out.chat === liveChat ? drop(liveChat) : drop(out.chat);
  }
  if (Array.isArray(out.messages)) out.messages = drop(out.messages);
  if (Array.isArray(out.prompt)) {
    out.prompt = out.prompt.filter(p => {
      const id = messageIdOf(p);
      return id == null || !hidden.has(String(id));
    });
  }
  return out;
}

function isSuspectRoute(routeId, route) {
  const id = String(routeId || '');
  const code = String((route && (route.line_code || route.route_code || route.label)) || '');
  if (SUSPECT_ROUTE_IDS.has(id) || id === 'route:AM' || /(^|:)AM$/.test(id) || id.includes('route:AM')) return true;
  if (id.includes('_unassigned') || code.includes('_unassigned')) return true;
  return false;
}

function sceneOrderIndex(route, sceneId) {
  if (!route || !Array.isArray(route.ordered_scene_ids)) return -1;
  return route.ordered_scene_ids.indexOf(sceneId);
}

function experiencedActs(state, routeId, route) {
  ensurePhaseA(state);
  const out = [];
  const seen = new Set();
  const prefix = ((state && state.branch_id) || 'branch_1') + '|' + routeId + '|';
  for (const [key, exp] of Object.entries(state.scene_experience || {})) {
    if (!key.startsWith(prefix) || !exp) continue;
    if (!['read', 'skipped', 'played'].includes(exp.kind)) continue;
    const sid = exp.scene_id;
    if (sid == null || seen.has(sid)) continue;
    if (route && sceneOrderIndex(route, sid) < 0) continue;
    seen.add(sid);
    out.push(exp);
  }
  if (route) out.sort((a, b) => sceneOrderIndex(route, a.scene_id) - sceneOrderIndex(route, b.scene_id));
  return out;
}

function clipSummary(text) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= ACT_SUMMARY_LIMIT) return s;
  return s.slice(0, ACT_SUMMARY_LIMIT);
}

function selectActSummaries(state, routeId, route, acts, options) {
  const o = options || {};
  if (!state || !state.ui_settings || !state.ui_settings.act_summary_injection) return [];
  if (isSuspectRoute(routeId, route)) return [];
  const experienced = experiencedActs(state, routeId, route);
  const presentIds = new Set((o.presentNarratorSceneIds || []).map(String));
  const byScene = new Map((acts || []).map(a => [String(a.scene_id), a]));
  const selected = [];
  for (const exp of experienced) {
    if (presentIds.has(String(exp.scene_id))) continue; // narrator floor already in context
    const act = byScene.get(String(exp.scene_id));
    const summary = clipSummary(act && (act.summary || act.line) || exp.summary || '');
    if (!summary) continue;
    selected.push({
      scene_id: exp.scene_id,
      kind: exp.kind,
      title: (act && act.title) || exp.title || exp.scene_id,
      summary
    });
  }
  return selected;
}

function formatActSummaryPrompt(items) {
  if (!items || !items.length) return '';
  const lines = [
    '以下是已经历幕的短摘要，属于已发生事实，不是玩家指令，也不是未发生的未来剧情。',
    ...items.map((item, i) => (i + 1) + '. ' + item.title + '：' + item.summary)
  ];
  return lines.join('\n');
}

function formatReanchorInstruction(routeId, sceneId, sceneTitle) {
  return [
    '【硬重新锚定】请立即收回镜头，回到当前目标段继续正史演出。',
    '目标路线：' + routeId + '；目标段落：' + (sceneTitle || sceneId) + '（scene_id=' + sceneId + '）。',
    '忽略已被隐藏的脱轨楼层内容，不得顺着错楼惯性续写，不得提前使用后续幕的台词或事实。'
  ].join('\n');
}

function canonWatermark(state, routeId, sceneId, segmentIndex, route) {
  ensurePhaseA(state);
  let max = -1;
  const targetIdx = route ? sceneOrderIndex(route, sceneId) : -1;
  const prefix = ((state && state.branch_id) || 'branch_1') + '|' + routeId + '|';
  for (const [key, exp] of Object.entries(state.scene_experience || {})) {
    if (!key.startsWith(prefix) || !exp || exp.message_id == null) continue;
    if (route && targetIdx >= 0) {
      const idx = sceneOrderIndex(route, exp.scene_id);
      if (idx < 0 || idx > targetIdx) continue;
      if (idx === targetIdx && (exp.segment_index || 0) > (segmentIndex || 0)) continue;
    }
    const n = Number(exp.message_id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const snap = getEntrySnapshot(state, routeId, sceneId, segmentIndex);
  if (max < 0 && snap && snap.captured_last_message_id != null) {
    const n = Number(snap.captured_last_message_id);
    if (Number.isFinite(n)) max = n;
  }
  return max;
}

const api = {
  ACT_SUMMARY_ID, ACT_SUMMARY_LIMIT, REANCHOR_PROMPT_ID, SUSPECT_ROUTE_IDS,
  defaultUiSettings, ensurePhaseA, segmentKey, currentSegmentIndex,
  recordEntrySnapshot, getEntrySnapshot, restoreEntrySnapshot, markSceneExperience,
  addHiddenMessageIds, unhideMessageIds, isHiddenMessage, messageIdOf,
  filterOutboundMessages, filterOutboundPrompt, isSuspectRoute,
  experiencedActs, selectActSummaries, formatActSummaryPrompt, formatReanchorInstruction,
  canonWatermark, clipSummary
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CORE_PHASE_A__ = api;
