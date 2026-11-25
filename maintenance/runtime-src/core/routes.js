// 角色线：进入/退出自动对齐人物与立绘；同线连续，不中途强切；附近剧情与全部年代导航（辅助）。
// v3：回忆按 manifest/narrative_layer 识别（不依赖世界时钟比较）；回忆作用域由 narrative.js 管理；
// 入口/节点状态锚点参与人物对齐；未知日期场景记录“本段经过分钟”但不生成绝对日期。
'use strict';

const T = require('./time');
const S = require('./state');
const E = require('./events');
const A = require('./actors');
const N = require('./narrative');

// options.ignoreStoryWindow：回忆作用域不用故事候选区间兜底（整篇“暂无”，节点日期单独显示）。
function sceneTimeOf(scene, story, options) {
  const o = options || {};
  const cand = scene && scene.time;
  if (cand && cand.ordinal_minute != null) return T.makeTime(cand.ordinal_minute, cand.calendar_id);
  if (cand && cand.date_label) {
    const ord = T.dateToOrdinal(cand.date_label, cand.precision);
    if (ord != null) return T.makeTime(ord);
  }
  const win = story && story.canonical_window;
  if (!o.ignoreStoryWindow && win && win.start) {
    const ord = T.dateToOrdinal(win.start, win.precision);
    if (ord != null) return T.makeTime(ord);
  }
  return T.makeTime(null);
}

function storyOfRoute(route, data) { return data.storyById[route.story_id] || null; }

// 预计出场人物：路线焦点 + 当前场景焦点。
function castForScene(route, scene, data) {
  const ids = new Set(route.focus_actor_ids || []);
  for (const id of (scene && scene.focus_actor_ids) || []) ids.add(id);
  return [...ids];
}

function alignCast(state, route, scene, sceneTime, data, periodLabel, extra) {
  const x = extra || {};
  const ctx = { story_id: route.story_id, scene_id: scene && scene.scene_id, scene_time: sceneTime, period_label: periodLabel || null, anchors: x.anchors || {}, period_tags: x.period_tags || [], entering: x.entering === true };
  const ids = castForScene(route, scene, data);
  const actor_states = {}, portraits = {};
  for (const id of ids) {
    const st = A.resolveActorAtScene(id, ctx, state.facts, data);
    actor_states[id] = st;
    portraits[id] = A.resolvePortrait(id, st, ctx, data);
  }
  return { actor_states, portraits, cast_ids: ids };
}

// 进入角色线。mode: 'live' | 'continue' | 'early_intervention' | 'restart'。
// 返回 {ok, already_entered, entryPlan, state}。重复点击不重复开局（V23）。
function enterRoute(state, routeId, mode, data) {
  const route = data.routeById[routeId];
  if (!route) return { ok: false, error: 'unknown_route', state };
  const target = mode && typeof mode === 'object' ? mode.scene_id : null;
  if (target && !route.ordered_scene_ids.includes(target)) return { ok: false, error: 'scene_not_in_route', state };
  const m = mode && typeof mode === 'object' ? mode.mode || 'jump' : mode || 'live';
  if (!target && m !== 'restart' && state.entered_routes[routeId] && state.active_route && state.active_route.route_id === routeId) {
    return { ok: true, already_entered: true, entryPlan: state.entered_routes[routeId].plan, state };
  }
  const ns = S.cloneState(state);
  const story = storyOfRoute(route, data);
  const rp = S.getRouteProgress(ns, routeId);
  delete ns.last_ending;
  const startIndex = target ? route.ordered_scene_ids.indexOf(target) :
    (m === 'continue') ? Math.min(rp.scene_index, route.ordered_scene_ids.length - 1) : 0;
  const sceneId = route.ordered_scene_ids[startIndex];
  const scene = data.sceneById[sceneId];
  const memory = N.memoryForRoute(route, data);
  const sceneTime = sceneTimeOf(scene, story, { ignoreStoryWindow: !!memory });
  // 世界时钟：live推进到场景时间；replay/early保留世界时钟；memory冻结世界时钟。
  let worldOrd = ns.world_time.ordinal_minute;
  let contextMode;
  if (memory) contextMode = 'memory';
  else if (m === 'early_intervention') contextMode = 'early_intervention';
  else contextMode = (sceneTime.ordinal_minute != null && worldOrd != null && sceneTime.ordinal_minute < worldOrd ? 'route_replay' : 'live');
  if (contextMode === 'live' && sceneTime.ordinal_minute != null) worldOrd = Math.max(worldOrd == null ? sceneTime.ordinal_minute : worldOrd, sceneTime.ordinal_minute);
  ns.world_time = T.makeTime(worldOrd, ns.world_time.calendar_id);
  // 解决跨线必要前置：把来源时间已到的前置事件作为背景事实结算（只给必要事实，不给B线全部经历）。
  // 回忆作用域不结算主线跨线前置，保持事实隔离。
  if (!memory) {
    for (const input of (route.cross_route_inputs || [])) {
      const ev = data.eventById[input.event_id];
      if (ev) E.settleEvents(ns, { events: [ev], scene_time: sceneTime, turnResult: null, turn_id: 'entry:' + routeId });
    }
    E.settleBackground(ns, { events: data.events, scene_time: sceneTime, turn_id: 'entry:' + routeId });
  }
  const periodLabel = memory ? '回忆' : (contextMode === 'route_replay' ? '历史时点' : null);
  const anchors = collectEntryAnchors(data, route, sceneId, ns);
  const periodTags = memory ? ['memory:' + memory.memory_id, 'npc_story'] : (contextMode === 'route_replay' ? ['historical'] : []);
  const aligned = alignCast(ns, route, scene, sceneTime, data, periodLabel, { anchors, period_tags: periodTags, entering: true });
  ns.actor_scene_states = aligned.actor_states;
  const disp = E.selectEventDisplay(ns, { events: data.events, scene_time: sceneTime, route_id: routeId, route_story_id: route.story_id, turn_id: 'entry:' + routeId });
  const goal = (scene && scene.completion_criteria) || null;
  const transactionId = 'enter_' + routeId + '_' + (ns.revision + 1);
  const entryPlan = {
    transaction_id: transactionId, route_id: routeId, story_id: route.story_id,
    scene_id: sceneId, scene_index: startIndex, scene_time: sceneTime, world_time: ns.world_time,
    context_mode: contextMode, cast_ids: aligned.cast_ids, actor_states: aligned.actor_states, portraits: aligned.portraits,
    event_display: disp, goal, node_count: route.ordered_scene_ids.length,
    opening_seed: { scene_title: (scene && scene.completion_criteria) || route.line_code, narrative: scene ? (data.segmentById[scene.segment_ids[0]] || {}).narrative : null },
    auto_switch_to_other_route: false,
    narrative_layer: memory ? 'memory' : (scene && scene.narrative_layer) || 'main',
    memory_id: memory ? memory.memory_id : null,
    date_display: memory ? '暂无' : null
  };
  ns.active_route = { route_id: routeId, scene_id: sceneId, scene_time: sceneTime, context_mode: contextMode, entry_snapshot_id: null, unknown_date_elapsed_minutes: 0 };
  rp.scene_index = startIndex;
  rp.current_goal_id = goal;
  ns.revision += 1;
  ns.entered_routes[routeId] = { transaction_id: transactionId, plan: entryPlan, revision: ns.revision };
  return { ok: true, already_entered: false, entryPlan, state: ns };
}

// 入口锚点：路线级/故事级 + 回忆节点级（仅当前场景）。
function collectEntryAnchors(data, route, sceneId, state) {
  const out = {};
  const bindings = data.worldbook_binding;
  if (bindings) {
    for (const [id, anchor] of Object.entries(bindings.story_states[route.story_id] || {})) out[id] = { ...anchor, anchor_id: 'story-binding:' + route.story_id + ':' + id };
  }
  const list = (data.actorAnchors && data.actorAnchors.anchors) || [];
  for (const a of list) {
    if ((a.scope === 'route' && a.route_id === route.route_id) || (a.scope === 'story' && a.story_id === route.story_id)) out[a.actor_id] = a;
  }
  if (bindings) for (const anchor of bindings.scene_anchors || []) if (anchor.scene_id === sceneId) out[anchor.actor_id] = { ...anchor, anchor_id: 'scene-binding:' + sceneId + ':' + anchor.actor_id };
  for (const a of list) if (a.scope === 'scene' && a.scene_id === sceneId) out[a.actor_id] = a;
  const nc = N.currentContext(state);
  if (nc.kind === 'memory') {
    for (const na of N.nodeAnchorsForScene(data, nc.memory_id, sceneId)) {
      out[na.actor_id] = { anchor_id: 'node:' + sceneId + ':' + na.actor_id, scope: 'scene', actor_id: na.actor_id, state_entry_id: na.entry_id, label: na.label, control_state: na.control_state || null, basis: na.basis, evidence_level: 'local_node_explicit' };
    }
  }
  return out;
}

// 退出/切线：结算实际结果→保存本线进度→更新世界事实→目标场景投影→重选人物/立绘→更新纪事。
// 尚未完成的转折不因退出而算完成。回忆作用域退出时恢复进入前上下文（narrative.js）。
function exitRoute(state, destination, data) {
  let ns = S.cloneState(state);
  const active = ns.active_route;
  const settled = active ? Object.values(ns.event_ledger).filter(l => l.branch_id === ns.branch_id) : [];
  if (active) {
    const rp = S.getRouteProgress(ns, active.route_id);
    rp.brief = rp.brief || '';
  }
  // 回忆中退出：先归档回忆作用域并恢复原上下文。
  if (N.inMemory(ns)) {
    const route = active ? data.routeById[active.route_id] : null;
    if (route) N.noteMemoryProgress(ns, route, S.getRouteProgress(ns, route.route_id), data);
    const r = N.exitMemoryScope(ns, data);
    if (!r.ok) return { ok: false, error: r.error, state };
    ns = r.state;
    if (destination && destination.route_id) {
      const r2 = enterRoute(ns, destination.route_id, destination.mode || 'live', data);
      if (r2.ok) return { ok: true, settled_events: settled.map(s => s.event_id), saved_route: active ? active.route_id : null, destination: r2.entryPlan, state: r2.state, already_entered: r2.already_entered, memory_exited: true };
      return { ok: false, error: r2.error, state };
    }
    ns.revision += 1;
    return { ok: true, settled_events: settled.map(s => s.event_id), saved_route: active ? active.route_id : null, destination: null, state: ns, memory_exited: true, restored_route: ns.active_route ? ns.active_route.route_id : null };
  }
  let destPlan = null;
  if (destination && destination.route_id) {
    const r = enterRoute(ns, destination.route_id, destination.mode || 'live', data);
    if (r.ok) { return { ok: true, settled_events: settled.map(s => s.event_id), saved_route: active ? active.route_id : null, destination: r.entryPlan, state: r.state, already_entered: r.already_entered }; }
    return { ok: false, error: r.error, state };
  }
  ns.active_route = null;
  ns.revision += 1;
  return { ok: true, settled_events: settled.map(s => s.event_id), saved_route: active ? active.route_id : null, destination: null, state: ns };
}

// 附近剧情 + 全部年代导航（辅助查阅，不决定默认游玩顺序）。不伪造未知日期；待定篇章归入undated。
function listNearbyStories(sceneTime, catalog, options) {
  const o = options || {};
  const stories = (catalog && catalog.stories) || catalog || [];
  const windowMinutes = o.windowMinutes != null ? o.windowMinutes : 360 * 1440; // 默认±1运行年
  const refOrd = sceneTime && sceneTime.ordinal_minute;
  const enriched = stories.map(s => {
    const win = s.canonical_window;
    const ord = win && win.start ? T.dateToOrdinal(win.start, win.precision) : null;
    const distance = (ord != null && refOrd != null) ? Math.abs(ord - refOrd) : null;
    return { story_id: s.story_id, title: s.title, category: s.category, availability: s.availability, canonical_window: win, route_ids: s.route_ids || [], distance_minutes: distance, ordinal: ord };
  });
  const dated = enriched.filter(s => s.ordinal != null);
  const undated = enriched.filter(s => s.ordinal == null);
  const nearby = dated.filter(s => s.distance_minutes != null && s.distance_minutes <= windowMinutes).sort((a, b) => a.distance_minutes - b.distance_minutes);
  // 按年代分桶（运行年），仅用于导航分组，不冒充官方精确日期。
  const eraMap = {};
  for (const s of dated) {
    const year = Math.floor(s.ordinal / (360 * 1440));
    const era = year + '年代';
    (eraMap[era] = eraMap[era] || []).push(s);
  }
  const eras = Object.keys(eraMap).sort().map(k => ({ era_label: k, stories: eraMap[k].sort((a, b) => a.ordinal - b.ordinal) }));
  return { nearby, eras, undated, all: enriched, reference_time: sceneTime || null };
}

const api = { sceneTimeOf, storyOfRoute, castForScene, alignCast, enterRoute, exitRoute, listNearbyStories, collectEntryAnchors };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_ROUTES__ = api; }

