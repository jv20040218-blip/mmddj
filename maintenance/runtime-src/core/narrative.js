// 回忆作用域（narrative context）：进入保存原上下文→独立事实/账本运行→退出恢复。
// 识别依据是 memory_manifest / narrative_layer，而不是“场景日期早于世界时钟”；
// 新聊天世界时间为空时回忆依然被识别为回忆。回忆完成标记只代表玩家已体验，
// 不代表现实事件已发生，也不把回忆事实合并进主线账本。
'use strict';

const S = require('./state');

function memoriesOf(data) {
  return (data.memoryManifest && data.memoryManifest.memories) || [];
}

function memoryForRoute(route, data) {
  if (!route) return null;
  return memoriesOf(data).find(m => m.route_id === route.route_id || m.story_id === route.story_id) || null;
}

function memoryById(data, memoryId) {
  return memoriesOf(data).find(m => m.memory_id === memoryId) || null;
}

function isMemoryRoute(route, data) { return !!memoryForRoute(route, data); }

function currentContext(state) {
  return state.narrative_context || S.defaultNarrativeContext();
}

function inMemory(state) { return currentContext(state).kind === 'memory'; }

// 进入回忆作用域。保存原活动线、世界时间、事实/事件账本、人物状态、纪事与上下文引用。
// 重看同一回忆时恢复该回忆上次的作用域归档（进度事实延续），但仍不与主线事实混合。
function enterMemoryScope(state, memory, data) {
  const ns = S.cloneState(state);
  if (inMemory(ns)) {
    const cur = currentContext(ns);
    if (cur.memory_id === memory.memory_id) return { ok: true, already: true, state: ns };
    // 不同回忆之间不嵌套：先退出当前回忆
    const out = exitMemoryScope(ns, data);
    if (!out.ok) return out;
    return enterMemoryScope(out.state, memory, data);
  }
  const returnContext = {
    active_route: ns.active_route,
    world_time: ns.world_time,
    facts: ns.facts,
    event_ledger: ns.event_ledger,
    actor_scene_states: ns.actor_scene_states,
    last_event_display: ns.last_event_display,
    narrative_context: ns.narrative_context || null,
    saved_at_revision: ns.revision
  };
  ns.memory_scopes = ns.memory_scopes || {};
  const prior = ns.memory_scopes[memory.memory_id];
  ns.narrative_context = {
    kind: 'memory',
    scope_id: 'memory:' + memory.memory_id,
    memory_id: memory.memory_id,
    return_context: returnContext
  };
  ns.facts = prior ? JSON.parse(JSON.stringify(prior.facts || {})) : {};
  ns.event_ledger = prior ? JSON.parse(JSON.stringify(prior.event_ledger || {})) : {};
  ns.actor_scene_states = {};
  ns.last_event_display = null;
  // 世界时钟在回忆中冻结：保留原值，reduceTurn 对 memory 作用域不推进世界时间。
  return { ok: true, already: false, state: ns, memory_id: memory.memory_id };
}

// 退出回忆作用域：归档回忆事实/账本（供重看），恢复进入前的完整上下文。
// 首次从回忆开局（无原活动线）时恢复到 active_route=null，由章节导航建立下一篇状态。
function exitMemoryScope(state, data) {
  const ns = S.cloneState(state);
  const nc = currentContext(ns);
  if (nc.kind !== 'memory') return { ok: false, error: 'not_in_memory', state };
  const rc = nc.return_context;
  if (!rc) return { ok: false, error: 'no_return_context', state };
  ns.memory_scopes = ns.memory_scopes || {};
  ns.memory_scopes[nc.memory_id] = {
    facts: ns.facts,
    event_ledger: ns.event_ledger,
    last_event_display: ns.last_event_display,
    archived_at_revision: ns.revision
  };
  ns.active_route = rc.active_route;
  ns.world_time = rc.world_time;
  ns.facts = rc.facts;
  ns.event_ledger = rc.event_ledger;
  ns.actor_scene_states = rc.actor_scene_states;
  ns.last_event_display = rc.last_event_display;
  ns.narrative_context = rc.narrative_context || S.defaultNarrativeContext();
  return { ok: true, state: ns, memory_id: nc.memory_id, restored_route: rc.active_route ? rc.active_route.route_id : null };
}

// 回忆体验进度：只有实际完成末节点才标记 experienced；重看不重复改变现实进度。
function noteMemoryProgress(state, route, rp, data) {
  const mem = memoryForRoute(route, data);
  if (!mem) return;
  const ns = state;
  ns.memory_progress = ns.memory_progress || {};
  const mp = ns.memory_progress[mem.memory_id] || (ns.memory_progress[mem.memory_id] = {
    memory_id: mem.memory_id, experienced: false, completed_scene_ids: [], last_scene_index: 0, finished_at_revision: null
  });
  mp.completed_scene_ids = (rp.completed_scene_ids || []).slice();
  mp.last_scene_index = rp.scene_index;
  const lastScene = route.ordered_scene_ids[route.ordered_scene_ids.length - 1];
  if (!mp.experienced && rp.completed_scene_ids && rp.completed_scene_ids.includes(lastScene)) {
    mp.experienced = true;
    mp.finished_at_revision = ns.revision;
  }
}

// 回忆节点锚点（如 SS1 斗士时期）：按 scene_id 取节点级人物锚点。
function nodeAnchorsForScene(data, memoryId, sceneId) {
  const mem = memoryById(data, memoryId);
  if (!mem) return [];
  const node = (mem.nodes || []).find(n => n.scene_id === sceneId);
  return (node && node.actor_anchors) || [];
}

const api = { memoriesOf, memoryForRoute, memoryById, isMemoryRoute, currentContext, inMemory, enterMemoryScope, exitMemoryScope, noteMemoryProgress, nodeAnchorsForScene };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_NARRATIVE__ = api; }
