// 会话状态：schema_version=3（v2幂等迁移见 adapter/persistence.migrateSave）。
// 世界时钟与场景时钟分开；事件账本按 branch_id+event_id 去重；
// 每条角色线另存进度与最近事件快照；每条回复独立 TurnSnapshot 供历史回看。
// v3新增：narrative_context（回忆作用域与返回上下文）、experience_progress（导航条目体验进度）、
//         memory_scopes（回忆作用域事实/账本归档）、memory_progress（回忆体验标记，不等同现实事件）。
'use strict';

const SCHEMA_VERSION = 3;

function defaultNarrativeContext() {
  return { kind: 'story', scope_id: 'main', memory_id: null, return_context: null };
}

function createState(opts) {
  const o = opts || {};
  return {
    schema_version: SCHEMA_VERSION,
    chat_id: o.chat_id || 'chat_local',
    branch_id: o.branch_id || 'branch_1',
    revision: 0,
    data_version: o.data_version || 'dev',
    world_time: o.world_time || { calendar_id: 'terra', ordinal_minute: null },
    active_route: null,
    facts: {},
    event_ledger: {},
    route_progress: {},
    actor_scene_states: {},
    last_event_display: null,
    snapshots: {},
    snapshot_order: [],
    entered_routes: {},
    narrative_context: defaultNarrativeContext(),
    experience_progress: {},
    memory_scopes: {},
    memory_progress: {},
    hidden_message_ids: [],
    segment_entry_snapshots: {},
    scene_experience: {},
    ui_settings: { act_summary_injection: false, inspect_hidden_floors: false },
    reanchor_pending: null,
    lore_mode: 'baseline',
    clone_book: null,
    sidecar_rev: 0,
    clone_warning: null
  };
}

function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

function cloneRunningState(state) {
  const { snapshots, snapshot_order, ...running } = state;
  return cloneState(running);
}

function ledgerKey(branchId, eventId) { return branchId + '|' + eventId; }
function sceneExperienceKey(branchId, routeId, sceneId) { return branchId + '|' + routeId + '|' + sceneId; }

function getRouteProgress(state, routeId) {
  if (!state.route_progress[routeId]) {
    state.route_progress[routeId] = {
      route_id: routeId,
      scene_index: 0,
      completed_scene_ids: [],
      current_goal_id: null,
      brief: '',
      displayed_event_ids: [],
      last_event_display: null,
      scene_experience: {}
    };
  }
  return state.route_progress[routeId];
}

function isEventSettled(state, eventId) {
  return !!state.event_ledger[ledgerKey(state.branch_id, eventId)];
}

function recordSnapshot(state, snapshot) {
  state.snapshots[snapshot.snapshot_id] = snapshot;
  state.snapshot_order.push(snapshot.snapshot_id);
}

function getSnapshot(state, snapshotId) { return state.snapshots[snapshotId] || null; }

// 从某历史快照恢复显示（不改动当前运行状态）。
function projectSnapshot(state, snapshotId) {
  const snap = getSnapshot(state, snapshotId);
  if (!snap) return null;
  return snap;
}

const api = { SCHEMA_VERSION, defaultNarrativeContext, createState, cloneState, cloneRunningState, ledgerKey, sceneExperienceKey, getRouteProgress, isEventSettled, recordSnapshot, getSnapshot, projectSnapshot };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_STATE__ = api; }
