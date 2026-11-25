// 每轮结果包(<ark_turn> v2)：校验→结算→提交→生成TurnSnapshot。异常不半提交（V26）。
// 镜头锁定当前route_id；AI临时写到B线人物不自动切线（V21）。历史回复读快照（V19）。
'use strict';

const T = require('./time');
const S = require('./state');
const E = require('./events');
const A = require('./actors');
const R = require('./routes');
const N = require('./narrative');
const C = require('./corpus');
const Nav = require('./navigation');

const PRESENCE = ['onstage', 'voice', 'memory', 'mentioned'];
const RESULT_ENUM = ['completed', 'achieved', 'occurred', 'failed', 'changed'];

// 运行态完整复制，但不把整个历史库再嵌入每条历史记录。
function cloneRunningState(state) {
  const { snapshots, snapshot_order, ...running } = state;
  return S.cloneState(running);
}

function validateTurnResult(tr, state, data) {
  const errors = [];
  if (!tr || typeof tr !== 'object') return { ok: false, errors: ['turn_result_not_object'] };
  if (tr.v !== 2) errors.push('bad_version:expected_v2');
  if (tr.base_revision !== state.revision) errors.push('stale_base_revision:' + tr.base_revision + '!=' + state.revision);
  if (!state.active_route) errors.push('no_active_route');
  else {
    if (tr.route_id !== state.active_route.route_id) errors.push('route_mismatch:camera_locked');
    const route = data.routeById[state.active_route.route_id];
    if (tr.scene_id !== undefined && tr.scene_id !== state.active_route.scene_id) errors.push('scene_mismatch:expected_current_scene');
    if (route && Array.isArray(tr.completed_scene_ids)) {
      const start = route.ordered_scene_ids.indexOf(state.active_route.scene_id);
      if (start < 0 || tr.completed_scene_ids.some((id, i) => typeof id !== 'string' || id !== route.ordered_scene_ids[start + i])) errors.push('completed_scenes_not_contiguous');
    }
  }
  if (tr.elapsed_minutes != null && (typeof tr.elapsed_minutes !== 'number' || tr.elapsed_minutes < 0 || tr.elapsed_minutes > 1440 || !Number.isFinite(tr.elapsed_minutes))) errors.push('bad_elapsed_minutes');
  if (tr.completed_scene_ids != null && !Array.isArray(tr.completed_scene_ids)) errors.push('completed_scene_ids_not_array');
  if (tr.event_results != null) {
    const allowed = new Set(allowedEventCandidates(state, data).map(ev => ev.event_id));
    if (!Array.isArray(tr.event_results)) errors.push('event_results_not_array');
    else for (const r of tr.event_results) {
      if (!r || !Object.prototype.hasOwnProperty.call(data.eventById, r.event_id)) errors.push('unknown_event:' + (r && r.event_id));
      else if (!allowed.has(r.event_id)) errors.push('event_not_allowed:' + r.event_id);
      if (r && !RESULT_ENUM.includes(r.result)) errors.push('bad_result_enum:' + r.result);
    }
  }
  if (tr.cast !== undefined) {
    if (!Array.isArray(tr.cast)) errors.push('cast_not_array');
    else for (const c of tr.cast) {
      if (!c || !c.actor_id) errors.push('cast_missing_actor_id');
      else if (typeof c.actor_id !== 'string' || !Object.prototype.hasOwnProperty.call(data.actorById, c.actor_id)) errors.push('unknown_actor:' + c.actor_id);
      if (c && c.presence !== undefined && !PRESENCE.includes(c.presence)) errors.push('bad_presence:' + c.presence);
      if (c && c.presence === 'memory') {
        if (c.memory_time === undefined && c.scene_id === undefined) errors.push('memory_missing_time_or_scene');
        if (c.scene_id !== undefined && (typeof c.scene_id !== 'string' || !Object.prototype.hasOwnProperty.call(data.sceneById, c.scene_id))) errors.push('bad_memory_scene:' + c.scene_id);
        if (c.memory_time !== undefined) {
          const mt = c.memory_time;
          const parsed = mt && typeof mt.date_label === 'string' ? T.parseDateLabel(mt.date_label) : null;
          const calendar = T.cal(mt && mt.calendar_id);
          if (!parsed || !mt || typeof mt !== 'object' || Array.isArray(mt) ||
              (mt.calendar_id !== undefined && !Object.prototype.hasOwnProperty.call(T.CALENDARS, mt.calendar_id)) ||
              (mt.precision !== undefined && !['day', 'month', 'year', 'season', 'range'].includes(mt.precision)) ||
              parsed.month < 1 || parsed.month > calendar.monthsPerYear || parsed.day < 1 || parsed.day > calendar.daysPerMonth ||
              (parsed.end_year != null && parsed.end_year < parsed.year) ||
              !Number.isFinite(T.dateToOrdinal(mt.date_label, mt.precision, mt.calendar_id))) errors.push('bad_memory_time');
        }
      }
    }
  }
  if (tr.progress != null && tr.progress.brief != null && typeof tr.progress.brief !== 'string') errors.push('progress_brief_not_string');
  return { ok: errors.length === 0, errors };
}

// 本轮允许结算的候选事件：已ready、适用当前故事、未结算、前置成立。
function allowedEventCandidates(state, data) {
  if (!state.active_route) return [];
  const storyId = (data.routeById[state.active_route.route_id] || {}).story_id;
  return data.events.filter(ev => ev.kind === 'key' && ev.ready_for_runtime === true && E.eventApplicable(ev, storyId) && !S.isEventSettled(state, ev.event_id) && (ev.prerequisite_event_ids || []).every(pid => S.isEventSettled(state, pid)));
}

function reduceTurn(state, turnResult, data, opts) {
  const o = opts || {};
  const v = validateTurnResult(turnResult, state, data);
  if (!v.ok) return { ok: false, errors: v.errors, state, turnSnapshot: null };
  // 原文库段落游标校验：节点/修订号/合法后继/共享事件由程序复核，不采信模型自报推进。
  const ci = data.corpusIndex || C.buildCorpusIndex(data.corpus || {});
  const segCtx = C.validationContext(ci, state, data);
  const check = C.validateAdvance(ci, state, data, turnResult, segCtx);
  if (!check.ok) return { ok: false, errors: check.errors, state, turnSnapshot: null };
  // 交汇场景切换视角重读时，关键事件/状态变化只提交一次。
  if (check.skip_event_settlement && turnResult.event_results && turnResult.event_results.length) {
    turnResult = { ...turnResult, event_results: [] };
  }
  // 当段末段确认后由程序补当前幕完成标记，确保一次操作只推进一次。
    if (check.advance && (check.advance.kind === 'node' || check.advance.kind === 'segment_end_hold') &&
      !(turnResult.completed_scene_ids || []).includes(state.active_route.scene_id)) {
    turnResult = { ...turnResult, completed_scene_ids: [state.active_route.scene_id] };
  }
  // History records are append-only. Copy the containers so a rejected or
  // branched turn cannot append to its input, and keep prior records intact.
  const ns = cloneRunningState(state);
  ns.snapshots = { ...state.snapshots };
  ns.snapshot_order = state.snapshot_order.slice();
  const active = ns.active_route;
  const route = data.routeById[active.route_id];
  const story = data.storyById[route.story_id];
  const elapsed = turnResult.elapsed_minutes || 0;
  const turnId = 'turn_' + (ns.revision + 1);
  // 场景时钟推进；世界时钟live取max；memory作用域冻结世界时钟。
  let sceneOrd = active.scene_time && active.scene_time.ordinal_minute;
  sceneOrd = sceneOrd == null ? null : sceneOrd + elapsed;
  const sceneTime = T.makeTime(sceneOrd, active.scene_time && active.scene_time.calendar_id);
  let worldOrd = ns.world_time.ordinal_minute;
  if (active.context_mode === 'live' && sceneOrd != null) worldOrd = Math.max(worldOrd == null ? sceneOrd : worldOrd, sceneOrd);
  ns.world_time = T.makeTime(worldOrd, ns.world_time.calendar_id);
  // 未知日期：记录本段经过分钟，但不因此生成绝对日期。
  let unknownElapsed = active.unknown_date_elapsed_minutes || 0;
  if (sceneOrd == null && elapsed > 0) unknownElapsed += elapsed;
  // 结算事件（完成入口＋到期入口），去重。
  const newly = E.settleEvents(ns, { events: data.events, scene_time: sceneTime, turnResult, turn_id: turnId });
  E.settleBackground(ns, { events: data.events, scene_time: sceneTime, turn_id: turnId });
  // 路线进度：完成判据推进场景。
  const rp = S.getRouteProgress(ns, route.route_id);
  for (const sid of (turnResult.completed_scene_ids || [])) if (!rp.completed_scene_ids.includes(sid)) rp.completed_scene_ids.push(sid);
  let sceneId = active.scene_id;
  let sceneIndex = rp.scene_index;
  const completedSet = new Set(turnResult.completed_scene_ids || []);
  while (completedSet.has(sceneId) && sceneIndex < route.ordered_scene_ids.length - 1) {
    sceneIndex += 1; sceneId = route.ordered_scene_ids[sceneIndex]; rp.scene_index = sceneIndex;
  }
  if (turnResult.progress) { rp.current_goal_id = turnResult.progress.current_goal_id || rp.current_goal_id; rp.brief = turnResult.progress.brief || rp.brief; }
  const scene = data.sceneById[active.scene_id];
  // 明确名单（包括空/仅提及）是本轮实际出场；缺省才用当前场景焦点。
  const entries = turnResult.cast === undefined
    ? ((scene && scene.focus_actor_ids) || []).map(actor_id => ({ actor_id, presence: 'onstage' }))
    : turnResult.cast;
  const castView = [];
  const actor_states = {};
  const nc = N.currentContext(ns);
  const scopeMemory = (nc.kind === 'memory' ? N.memoryById(data, nc.memory_id) : null) || N.memoryForRoute(route, data);
  const anchors = R.collectEntryAnchors(data, route, active.scene_id, ns);
  const scopePeriodTags = scopeMemory ? ['memory:' + scopeMemory.memory_id, 'npc_story'] : (active.context_mode === 'route_replay' ? ['historical'] : []);
  for (const ci of entries) {
    const id = ci.actor_id;
    const presence = ci.presence || 'onstage';
    let ctx = { story_id: route.story_id, scene_id: active.scene_id, scene_time: sceneTime, anchors, period_tags: scopePeriodTags };
    let periodLabel = scopeMemory ? '回忆' : null;
    if (presence === 'memory') {
      const memoryRoute = ci.scene_id && data.routes.find(r => r.ordered_scene_ids.includes(ci.scene_id));
      const memory = memoryRoute && N.memoryForRoute(memoryRoute, data);
      const memOrd = ci.memory_time ? T.dateToOrdinal(ci.memory_time.date_label, ci.memory_time.precision) : (ci.scene_id && data.sceneById[ci.scene_id] ? R.sceneTimeOf(data.sceneById[ci.scene_id], story).ordinal_minute : null);
      ctx = { story_id: memoryRoute?.story_id, scene_id: ci.scene_id, scene_time: T.makeTime(memOrd != null ? memOrd : sceneOrd),
        anchors: memoryRoute ? R.collectEntryAnchors(data, memoryRoute, ci.scene_id, ns) : null,
        period_tags: memory ? ['memory:' + memory.memory_id, 'npc_story'] : [] };
      periodLabel = '回忆' + (ci.memory_time && ci.memory_time.date_label ? '·' + ci.memory_time.date_label : '');
    }
    const st = A.resolveActorAtScene(id, ctx, ns.facts, data);
    const portraitContext = { ...ctx, period_label: periodLabel };
    const pt = A.resolvePortrait(id, st, portraitContext, data);
    if (presence !== 'memory') actor_states[id] = st; // 当下状态以非回忆视图为准
    castView.push({ actor_id: id, canonical_name: st.canonical_name, presence, state: st, portrait: pt, period_label: periodLabel,
      portrait_context: { period_tags: ctx.period_tags, period_label: periodLabel } });
  }
  ns.actor_scene_states = actor_states;
  const disp = E.selectEventDisplay(ns, { events: data.events, scene_time: sceneTime, route_id: route.route_id, route_story_id: route.story_id, turn_id: turnId });
  ns.active_route = { route_id: route.route_id, scene_id: sceneId, scene_time: sceneTime, context_mode: active.context_mode, entry_snapshot_id: active.entry_snapshot_id, unknown_date_elapsed_minutes: unknownElapsed };
  // 有效提交后才把「已给模型阅读」转成「已在故事中发生」，并推进一次游标。
  C.applyAdvance(ci, ns, turnResult, check);
  // 完成当前幕后，下一轮必须投影下一幕的人物与日期；本条回复的castView仍保留实际演出人物。
  if (sceneId !== active.scene_id) {
    const nextScene = data.sceneById[sceneId];
    const nextTime = R.sceneTimeOf(nextScene, story, { ignoreStoryWindow: !!scopeMemory });
    const nextAnchors = R.collectEntryAnchors(data, route, sceneId, ns);
    ns.active_route.scene_time = nextTime;
    ns.active_route.unknown_date_elapsed_minutes = 0;
    ns.actor_scene_states = R.alignCast(ns, route, nextScene, nextTime, data, scopeMemory ? '回忆' : null,
      { anchors: nextAnchors, period_tags: scopePeriodTags }).actor_states;
    if (active.context_mode === 'live' && nextTime.ordinal_minute != null) ns.world_time = T.makeTime(Math.max(ns.world_time.ordinal_minute || 0, nextTime.ordinal_minute));
  }
  ns.revision += 1;
  // 回忆体验进度：实际完成末节点才标记 experienced；不等同现实事件发生。
  N.noteMemoryProgress(ns, route, rp, data);
  const snapshotBase = 'snap_' + ns.revision + '_' + turnId;
  let snapshotId = snapshotBase, version = 1;
  // 历史库不回滚：同输入确定，同revision的新版本不覆盖任何旧版本。
  while (Object.prototype.hasOwnProperty.call(ns.snapshots, snapshotId)) snapshotId = snapshotBase + '_v' + (++version);
  const snapshot = {
    snapshot_id: snapshotId, message_id: turnResult.message_id || ('msg_' + ns.revision),
    branch_id: ns.branch_id, chat_id: ns.chat_id, revision: ns.revision, version: 2, data_version: ns.data_version,
    sync_status: turnResult.sync_status || 'model',
    clock: { world_time: ns.world_time, scene_time: sceneTime },
    route: { route_id: route.route_id, story_id: route.story_id, scene_id: sceneId, performed_scene_id: active.scene_id, scene_index: sceneIndex, node_count: route.ordered_scene_ids.length, context_mode: active.context_mode },
    narrative_context: { kind: nc.kind, scope_id: nc.scope_id, memory_id: nc.memory_id || null },
    unknown_date_elapsed_minutes: unknownElapsed,
    cast: castView, mentioned: castView.filter(c => c.presence === 'mentioned').map(c => c.actor_id),
    event_display: disp, newly_settled: newly.map(n => n.event.event_id),
    progress: { current_goal_id: rp.current_goal_id, brief: rp.brief, completed_scene_ids: rp.completed_scene_ids.slice(), scene_index: sceneIndex },
    state_before: o.storeHistory === false ? undefined : cloneRunningState(state)
  };
  ns.active_route.entry_snapshot_id = ns.active_route.entry_snapshot_id || snapshotId;
  // fork按提交后的revision还原，不从展示字段拼接/猜测事实。
  if (o.storeHistory !== false) snapshot.state_after = cloneRunningState(ns);
  S.recordSnapshot(ns, snapshot);
  return { ok: true, state: ns, turnSnapshot: snapshot };
}

// 重生成：恢复生成前状态（V19）。
function revertToSnapshot(state, snapshotId) {
  const snap = S.getSnapshot(state, snapshotId);
  if (!snap || !snap.state_before) return { ok: false, error: 'no_pre_state' };
  const restored = S.cloneState(snap.state_before);
  // 保留快照库以便历史回看，但运行状态回到生成前。
  restored.snapshots = state.snapshots; restored.snapshot_order = state.snapshot_order;
  return { ok: true, state: restored };
}

// 状态栏视图（由脚本计算，不另发模型请求）。data 可选：提供时附加导航分块/篇章标签。
// 时间未知固定显示“暂无”，不使用1970-01-01/0年，也不继承上一篇日期。
function renderTurnStatus(snapshot, data) {
  if (!snapshot) return null;
  let sc = T.ordinalToClock(snapshot.clock.scene_time.ordinal_minute, snapshot.clock.scene_time.calendar_id);
  const wc = T.ordinalToClock(snapshot.clock.world_time.ordinal_minute, snapshot.clock.world_time.calendar_id);
  const ed = snapshot.event_display || {};
  let et = ed.occurred_at ? T.ordinalToClock(ed.occurred_at.ordinal_minute, ed.occurred_at.calendar_id) : null;
  const sceneSource = data && data.sceneById && data.sceneById[snapshot.route.scene_id];
  const storyId = snapshot.route.story_id || (data && data.routeById && data.routeById[snapshot.route.route_id] || {}).story_id;
  const storySource = data && data.storyById && data.storyById[storyId];
  const sourceDate = sceneSource && sceneSource.time || storySource && storySource.canonical_window;
  if (sc && sourceDate && ['year','month','season','range'].includes(sourceDate.precision)) {
    sc = { ...sc, date_label: sourceDate.date_label || sourceDate.start, time_label: '', precision: sourceDate.precision };
  }
  const sourceEvent = data && (data.events || []).find(e => e.event_id === ed.event_id);
  const sourceWindow = sourceEvent && sourceEvent.canonical_window;
  if (et && sourceWindow && ['year','month','season','range'].includes(sourceWindow.precision)) {
    et = { ...et, date_label: sourceWindow.date_label, time_label: '', precision: sourceWindow.precision };
  }
  const nc = snapshot.narrative_context || { kind: 'story', memory_id: null };
  const route = data.routeById[snapshot.route.route_id];
  const memory = (nc.memory_id && N.memoryById(data, nc.memory_id)) || (route && N.memoryForRoute(route, data));
  const historical = snapshot.state_before?.active_route?.context_mode === 'route_replay';
  const periodTags = memory ? ['memory:' + memory.memory_id, 'npc_story'] : historical ? ['historical'] : [];
  const cast = snapshot.cast.map(person => {
    const context = person.portrait_context || {
      period_tags: person.presence === 'memory' ? person.portrait?.period_tags || [] : periodTags,
      period_label: person.period_label || (memory && person.presence !== 'memory' ? '回忆' : historical ? '历史时点' : null)
    };
    return { ...person, period_label: context.period_label,
      portrait: A.resolvePortrait(person.actor_id, person.state, context, data) };
  });
  const onstage = cast.filter(c => c.presence === 'onstage' || c.presence === 'voice');
  let groupLabel = null, entryLabel = null, dateDisplay = sc ? sc.date_label : '暂无';
  if (data && data.navigationEntryById && snapshot.route) {
    const entryIds = data.navigationByStory[snapshot.route.story_id] || [];
    const entry = entryIds.map(id => data.navigationEntryById[id]).find(e => e && e.group_id) || entryIds.map(id => data.navigationEntryById[id]).find(Boolean);
    if (entry) {
      entryLabel = entry.display_title || entry.title || null;
      const group = (data.navigation.groups || []).find(g => g.group_id === entry.group_id);
      groupLabel = group ? group.label : null;
      if (!sc && entry.date_display && nc.kind !== 'memory') dateDisplay = entry.date_display;
    }
  }
  if (nc.kind === 'memory') dateDisplay = sc ? sc.date_label : '暂无';
  return {
    snapshot_id: snapshot.snapshot_id, message_id: snapshot.message_id, revision: snapshot.revision, sync_status: snapshot.sync_status || 'model',
    scene_clock: sc, world_clock: wc,
    date_display: dateDisplay,
    route_label: data.routeById[snapshot.route.route_id] ? Nav.routeLabel(data.routeById[snapshot.route.route_id], data) : '角色线',
    scene_id: snapshot.route.scene_id,
    group_label: groupLabel, entry_label: entryLabel,
    navigation_label: (groupLabel ? groupLabel + '｜' : '') + (entryLabel ? entryLabel + '｜' : ''),
    context_kind: nc.kind, memory_id: nc.memory_id || null,
    unknown_date_elapsed_minutes: snapshot.unknown_date_elapsed_minutes || 0,
    progress_label: '第' + (snapshot.route.scene_index + 1) + ' / ' + snapshot.route.node_count + '段',
    progress_percent: snapshot.route.node_count ? Math.round((snapshot.route.scene_index + 1) / snapshot.route.node_count * 100) : null,
    event_text: ed.text || '暂无已记录事件', event_time: et, event_is_repeated: !!ed.is_repeated, event_others: ed.others || [],
    cast: onstage.map(c => ({ actor_id: c.actor_id, name: c.canonical_name, label: c.state.label, profile_label: c.state.profile_label, profile_entry_id: c.state.profile_entry_id, presence: c.presence, portrait_url: c.portrait.image_url, portrait_fallback_urls: c.portrait.fallback_urls, placeholder: c.portrait.placeholder, placeholder_name: c.portrait.placeholder_name, fallback_reason: c.portrait.fallback_reason, period_label: c.period_label })),
    memory_cast: cast.filter(c => c.presence === 'memory').map(c => ({ actor_id: c.actor_id, name: c.canonical_name, label: c.state.label, portrait_url: c.portrait.image_url, portrait_fallback_urls: c.portrait.fallback_urls, period_label: c.period_label, placeholder: c.portrait.placeholder })),
    mentioned: snapshot.mentioned,
    goal: snapshot.progress.current_goal_id, brief: snapshot.progress.brief
  };
}

const api = { PRESENCE, RESULT_ENUM, validateTurnResult, allowedEventCandidates, reduceTurn, revertToSnapshot, renderTurnStatus };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_TURN__ = api; }
