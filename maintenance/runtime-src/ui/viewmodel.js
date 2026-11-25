// 剧情页视图模型：纯函数，把运行时状态投影成界面数据（无DOM，可在node验证）。
// 沿用获认可示例的布局语义：上方选角色线，中间当前场景/目标，下方时间/纪事，侧边本轮人物立绘，窄屏上下排列。
'use strict';

function pick(requirePath, globalKey) {
  try { if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require(requirePath); } catch (e) {}
  return (typeof globalThis !== 'undefined') ? globalThis[globalKey] : null;
}
const Core = pick('../core', '__ARK_STORY_CORE__');

function actorName(id, data) { const a = data.actorById[id]; return a ? a.canonical_name : id; }
function isGeneric(id) { return /^spk_/.test(id); }

function routeLabel(route, data) {
  return Core.navigation.routeLabel(route,data);
}

function sceneLabel(scene, data, index) {
  if (!scene) return '段' + (index + 1);
  const seg = data.segmentById[(scene.segment_ids || [])[0]];
  if (seg && seg.node_code) return seg.node_code;
  if (seg && seg.act_name) return seg.act_name;
  return '段' + (index + 1);
}

function sceneTitle(scene, data, index) {
  const label = sceneLabel(scene, data, index);
  const seg = scene && data.segmentById[(scene.segment_ids || [])[0]];
  const act = seg && seg.act_name && seg.act_name !== label ? seg.act_name : null;
  const crit = scene && scene.completion_criteria;
  const tail = crit ? String(crit).slice(0, 24) : act;
  return tail ? label + ' · ' + tail : label;
}

function clockText(time) {
  if (!time || time.ordinal_minute == null) return '暂无';
  const c = Core.time.ordinalToClock(time.ordinal_minute, time.calendar_id);
  return c.date_label + (c.time_label && c.time_label !== '00:00' ? ' · ' + c.time_label : '');
}

function sceneNarrative(scene, data, max) {
  const seg = scene && data.segmentById[(scene.segment_ids || [])[0]];
  if (!seg || !seg.narrative) return null;
  const n = String(seg.narrative);
  return max && n.length > max ? n.slice(0, max) + '…' : n;
}

// 当前故事的同源角色线（顶部按钮）。
function siblingRoutes(route, data) {
  if (!route) return [];
  const story = data.storyById[route.story_id];
  const ids = (story && story.route_ids && story.route_ids.length) ? story.route_ids : data.routes.filter(r => r.story_id === route.story_id).map(r => r.route_id);
  return ids.map(id => data.routeById[id]).filter(r=>r&&!r.catalog_alias_of);
}

function routeButton(route, data, state) {
  const rp = (state.route_progress || {})[route.route_id];
  const sceneTime = routeSceneTime(route, data);
  return {
    route_id: route.route_id, label: routeLabel(route, data), line_code: route.line_code,
    story_id: route.story_id, node_count: route.ordered_scene_ids.length,
    active: !!(state.active_route && state.active_route.route_id === route.route_id),
    entered: !!state.entered_routes[route.route_id],
    progress_label: rp ? '第' + (rp.scene_index + 1) + ' / ' + route.ordered_scene_ids.length + '段' : '未进入',
    time_text: clockText(sceneTime)
  };
}
function routeSceneTime(route, data) {
  const scene = data.sceneById[route.ordered_scene_ids[0]];
  const story = data.storyById[route.story_id];
  return Core.routes.sceneTimeOf(scene, story);
}

function sceneOverview(scene, data, max) {
  if (!scene) return null;
  const text = (scene.segment_ids || []).map(id => data.segmentById[id] && data.segmentById[id].narrative).filter(Boolean).join('\n');
  if (!text) return null;
  const limit = max == null ? 800 : max;
  return limit && text.length > limit ? text.slice(0, limit) + '…' : text;
}

function playerSummary(runtime, routeId, sceneId) {
  const node = runtime.corpusNodeForScene ? runtime.corpusNodeForScene(sceneId) : null;
  return runtime.data.playerSummaryByScene.get(JSON.stringify([routeId, sceneId, node ? node.node_id : null]));
}

// 进入前的完整角色线预览：逐幕列出顺序、梗概与完成条件，不改动运行态。
function buildRoutePreview(runtime, routeId, opts) {
  const data = runtime.data;
  const route = data.routeById[routeId];
  if (!route) return null;
  const story = data.storyById[route.story_id];
  const entry = Core.navigation && Core.navigation.entryForStory(data, route.story_id);
  const group = entry && Core.navigation.groupOfEntry(data, entry);
  const scenes = route.ordered_scene_ids.map((sid, index) => {
    const scene = data.sceneById[sid];
    const sceneTime = Core.routes.sceneTimeOf(scene, story);
    let dateDisplay = clockText(sceneTime);
    if (dateDisplay === '暂无' && entry && entry.date_display) dateDisplay = entry.date_display;
    const actorIds = scene && scene.focus_actor_ids && scene.focus_actor_ids.length ? scene.focus_actor_ids : route.focus_actor_ids || [];
    // 预览默认只给梗概；展开时由文本节点渲染该幕完整原文、人物与来源。打开预览不启动生成。
    const node = runtime.corpusNodeForScene ? runtime.corpusNodeForScene(sid) : null;
    const full = node && runtime.corpusFullText ? runtime.corpusFullText(node.node_id) : null;
    const authored = playerSummary(runtime, routeId, sid);
    return {
      index, scene_id: sid,
      label: sceneLabel(scene, data, index),
      title: authored ? authored.title : sceneTitle(scene, data, index),
      narrative: authored ? authored.summary : sceneOverview(scene, data, opts && opts.narrativeMax),
      goal: scene && scene.completion_criteria || '沿当前角色线推进',
      date_display: dateDisplay,
      cast_names: actorIds.filter(id => !isGeneric(id)).map(id => actorName(id, data)),
      node_id: node ? node.node_id : null,
      node_code: node ? node.node_code : null,
      act_name: node ? node.act_name : null,
      playable: node ? node.playable !== false : false,
      material_status: full ? '有完整原文且已接入' : '原素材仅有摘要／待补原文',
      full_text: full ? full.text : null,
      full_chars: full ? full.chars : 0,
      segment_count: full ? full.segment_count : 0,
      source_speakers: full ? full.speakers : [],
      source: full ? { file: full.source_file, sha256: full.source_file_sha256,
        locator: full.source_locator, uid: node.source_uid, entry_chars: full.source_entry_chars } : null
    };
  });
  return {
    route_id: route.route_id, story_id: route.story_id,
    route_label: routeLabel(route, data), story_title: story ? story.title : route.story_id,
    entry_id: entry ? entry.entry_id : null,
    group_label: group ? group.label : null,
    category: story ? story.category : null,
    date_display: entry && entry.date_display || (scenes[0] && scenes[0].date_display) || '暂无',
    node_count: scenes.length, scenes
  };
}

// Player-only complete overview, ordered by the same scenes used by play/jump.
// Do not reuse the deliberately short AI injection or load future text into it.
function buildRouteSummary(runtime, routeId) {
  const route = runtime.data.routeById[routeId];
  if (!route) return null;
  const guide = runtime.guideForRoute ? runtime.guideForRoute(routeId) : null;
  const briefs = new Map(((guide && guide.act_briefs) || []).map(act => [act.node_id, act]));
  const acts = (route.ordered_scene_ids || []).map((id, index) => {
    const scene = runtime.data.sceneById[id];
    const node = runtime.corpusNodeForScene ? runtime.corpusNodeForScene(id) : null;
    const brief = node && briefs.get(node.node_id);
    const authored = playerSummary(runtime, routeId, id);
    return {index, scene_id:id, node_id:node ? node.node_id : null,
      title:authored ? authored.title : sceneTitle(scene,runtime.data,index),
      summary:authored ? authored.summary : brief && brief.line || sceneOverview(scene,runtime.data,0) || scene && scene.completion_criteria || '本幕暂无独立摘要，请查看本幕原文。',
      source_status:authored ? authored.source_status || 'full_text' : 'legacy',
      notes:authored ? authored.notes || '' : ''};
  });
  return {route_id:routeId, header_lines:guide ? guide.header_lines || [] : [], acts,
    notes:guide ? guide.performance_notes || [] : []};
}

// 剧情页主视图。
function buildStoryPageView(runtime, state, opts) {
  const o = opts || {};
  if (o.snapshot && o.snapshot.state_after) state = o.snapshot.state_after;
  const data = runtime.data;
  const active = state.active_route;
  const route = active ? data.routeById[active.route_id] : null;
  const story = route ? data.storyById[route.story_id] : null;
  const scene = active ? data.sceneById[active.scene_id] : null;
  const rp = route ? (state.route_progress || {})[route.route_id] : null;
  const sceneIndex = active ? (rp ? rp.scene_index : 0) : 0;
  const status = o.status || null;
  const ordered = route ? route.ordered_scene_ids : [];
  const pathLabels = ordered.map((sid, i) => sceneLabel(data.sceneById[sid], data, i));
  const path = pathLabels.length > 8 ? pathLabels.slice(0, 8).join(' → ') + ' → …（共' + pathLabels.length + '段）' : pathLabels.join(' → ');
  const cast = status ? status.cast : [];
  const lastIdx = ordered.length - 1;
  const lineCompleted = !!active && sceneIndex >= lastIdx && !!rp &&
    (rp.completed_scene_ids || []).includes(ordered[lastIdx]);
  // v3：导航分块/篇章标签、回忆前情提示、继续下一篇入口。
  const Nav = Core.navigation;
  const entry = route && Nav ? Nav.entryForStory(data, route.story_id) : null;
  const group = entry && Nav ? Nav.groupOfEntry(data, entry) : null;
  const nc = state.narrative_context || { kind: 'story' };
  let memoryPreface = null;
  if (route && data.memoryManifest) {
    const childMem = (data.memoryManifest.memories || []).find(m => m.parent_story_id === route.story_id);
    if (childMem) {
      const experienced = !!((state.memory_progress || {})[childMem.memory_id] || {}).experienced;
      memoryPreface = { memory_id: childMem.memory_id, entry_id: childMem.entry_id, title: childMem.title, experienced,
        hint: experienced ? '已体验「' + childMem.title + '」；本章不再自动插播，可重看回忆。' : '前情推荐：「' + childMem.title + '」。可点击进入，也可继续当前章节。' };
    }
  }
  const nextEntry = entry && Nav && sceneIndex >= lastIdx ? Nav.nextEntry(data, entry.entry_id) : null;
  const nextSceneId = sceneIndex < lastIdx ? ordered[sceneIndex + 1] : null;
  const nextScene = nextSceneId ? data.sceneById[nextSceneId] : null;
  const cs = active && runtime.corpusStatus ? runtime.corpusStatus(state) : null;
  const guideRaw = active && runtime.guideForRoute ? runtime.guideForRoute(active.route_id) : null;
  const summary = active ? buildRouteSummary(runtime, active.route_id) : null;
  const currentSummary = active ? playerSummary(runtime, active.route_id, active.scene_id) : null;
  const nextSummary = nextSceneId ? playerSummary(runtime, active.route_id, nextSceneId) : null;
  const guideView = summary ? {
    guide_id: guideRaw ? guideRaw.guide_id : null, status: guideRaw ? guideRaw.status : '按现有场景说明展示', acts: summary.acts.length,
    chapter: guideRaw && guideRaw.chapter ? guideRaw.chapter.title : null,
    brief: summary.header_lines.concat(summary.acts.map(act => act.summary), summary.notes).join('\n'),
    act_summaries: summary.acts, header_lines:summary.header_lines, notes:summary.notes,
    current_act: cs ? summary.acts.findIndex(x => x.node_id === cs.node_id) + 1 : sceneIndex + 1
  } : null;
  const corpusView = cs ? {
    node_id: cs.node_id, node_code: cs.node_code, act_name: cs.act_name,
    segment_index: cs.segment_index, segment_count: cs.segment_count,
    display: '当前幕：' + (cs.act_name || cs.node_code) + '｜当前段：第' + (cs.segment_index + 1) + ' / ' + cs.segment_count + '段',
    next_step: cs.next_allowed_scene_id
      ? (cs.next_allowed_node_id || sceneTitle(data.sceneById[cs.next_allowed_scene_id], data, sceneIndex + 1))
      : '本线收束；可继续下一篇或退出',
    source_file: cs.source_file, source_locator: cs.source_locator,
    source_file_sha256: cs.source_file_sha256, speakers: cs.speakers,
    shared_event_id: cs.shared_event_id, material_status: '有完整原文且已接入'
  } : null;
  return {
    schema_version: 3, data_version: data.data_version,
    has_active: !!active,
    header: { title: '剧情', subtitle: story ? story.title : '未选择角色线', note: story ? (story.category || '') + (story.availability === 'provided' ? ' · 已整理可玩' : story.availability === 'official_only_pending' ? ' · 待改编' : '') : '从下方目录选择一条角色线' },
    navigation_label: (group ? group.label + '｜' : '') + (entry ? (entry.display_title || entry.title) + '｜' : ''),
    context_kind: nc.kind,
    routes: siblingRoutes(route, data).map(r => routeButton(r, data, state)),
    current: active ? {
      route_id: route.route_id, route_label: routeLabel(route, data), story_id: route.story_id,
      scene_id: active.scene_id, scene_title: currentSummary ? currentSummary.title : sceneTitle(scene, data, sceneIndex),
      path, context_mode: active.context_mode,
      scene_clock: entry && ['year','month','season','range'].includes(entry.date_precision) && !(scene && scene.time && scene.time.precision === 'day') ? entry.date_display : clockText(active.scene_time), world_clock: clockText(state.world_time),
      date_display: nc.kind === 'memory' ? clockText(active.scene_time) : (entry && entry.date_display ? entry.date_display : clockText(active.scene_time)),
      unknown_date_elapsed_minutes: active.unknown_date_elapsed_minutes || 0,
      goal: (scene && scene.completion_criteria) || (rp && rp.current_goal_id) || '沿当前角色线推进',
      brief: (rp && rp.brief) || null,
      narrative: currentSummary ? currentSummary.summary : sceneNarrative(scene, data, o.narrativeMax || 1200),
      next_scene: nextScene ? {
        scene_id: nextSceneId,
        title: nextSummary ? nextSummary.title : sceneTitle(nextScene, data, sceneIndex + 1),
        narrative: nextSummary ? nextSummary.summary : sceneOverview(nextScene, data, 260),
        goal: nextScene.completion_criteria || '沿当前角色线推进'
      } : null,
      progress_label: '第' + (sceneIndex + 1) + ' / ' + ordered.length + '段',
      progress_percent: ordered.length ? Math.round((sceneIndex + 1) / ordered.length * 100) : 0,
      chronicle: status ? { text: status.event_text, time: status.event_time ? (status.event_time.date_label + (status.event_time.time_label && status.event_time.time_label !== '00:00' ? ' · ' + status.event_time.time_label : '')) : '暂无', is_repeated: status.event_is_repeated, others: status.event_others || [] } : null,
      sync_status: status ? status.sync_status : null,
      memory_preface: memoryPreface,
      corpus: corpusView,
      guide: guideView,
      corpus_restore: state.corpus_restore || null
    } : null,
    cast, memory_cast: status ? status.memory_cast : [], mentioned: status ? status.mentioned : [],
    actions: {
      can_continue: !!active && sceneIndex < lastIdx,
      can_restart: !!active,
      can_exit: !!active,
      at_end: lineCompleted,
      next_entry: nextEntry ? { entry_id: nextEntry.entry_id, title: nextEntry.display_title || nextEntry.title } : null,
      hint: !active ? '选择一条角色线开始' : (status && status.sync_status === 'fallback_zero_delta' ? '本轮未收到状态包：已保存当前快照，时间与剧情未推进' : (nc.kind === 'memory' ? '回忆作用域：事实与纪事独立结算，退出后恢复进入前进度' : (sceneIndex >= lastIdx ? '本线已到收束，可继续下一篇或选择同源另一条线' : (active.context_mode === 'route_replay' ? '当前场景早于世界进度，已按场景时点对齐人物' : '连续推进当前角色线，不中途强切视角'))))
    },
    catalog: o.catalog || null,
    navigation: o.navigation || null,
    history: o.history || null
  };
}

// v3 导航视图：主线三块 + 支线国家/专题块 + 补充入口（编译期顺序，运行时不重排）。
function buildNavigationView(runtime, state, opts) {
  return runtime.buildNavigation(state, opts || {});
}

// 本轮人物立绘 + 剧情进度面板（绑定消息快照，可看历史）。
function buildTurnPanelView(runtime, state, messageId, adapter) {
  let status = null, snapshotId = null, isHistorical = false;
  if (messageId != null && adapter) { status = adapter.getStatusForMessage(messageId); const s = adapter.snapshotForMessage(messageId); snapshotId = s ? s.snapshot_id : null; isHistorical = !!status; }
  if (!status && adapter) status = adapter.currentStatus();
  if (!status) return { has: false, cast: [], memory_cast: [], mentioned: [], progress: null, chronicle: null, scene_clock: null, world_clock: null };
  return {
    has: true, snapshot_id: snapshotId || status.snapshot_id, message_id: status.message_id, is_historical: isHistorical,
    scene_clock: status.scene_clock, world_clock: status.world_clock, sync_status: status.sync_status,
    route_label: status.route_label, progress_label: status.progress_label, progress_percent: status.progress_percent,
    goal: status.goal, brief: status.brief,
    chronicle: { text: status.event_text, time: status.event_time, is_repeated: status.event_is_repeated, others: status.event_others || [] },
    cast: status.cast, memory_cast: status.memory_cast, mentioned: status.mentioned
  };
}

// 目录视图：附近剧情 / 全部年代 / 待定。每条故事给出角色线入口。
function buildCatalogView(runtime, state, opts) {
  const nav = runtime.listNearbyStories(state.active_route ? state.active_route.scene_time : state.world_time, opts);
  const data = runtime.data;
  const decorate = (s) => ({
    story_id: s.story_id, title: s.title, category: s.category, availability: s.availability,
    window: s.canonical_window, distance_minutes: s.distance_minutes,
    available: s.availability === 'provided' && (s.route_ids || []).length > 0,
    routes: (s.route_ids || []).map(id => data.routeById[id]).filter(Boolean).map(r => ({ route_id: r.route_id, label: routeLabel(r, data), node_count: r.ordered_scene_ids.length }))
  });
  return {
    reference_time: nav.reference_time,
    nearby: nav.nearby.map(decorate),
    eras: nav.eras.map(e => ({ era_label: e.era_label, stories: e.stories.map(decorate) })),
    undated: nav.undated.map(decorate),
    total: nav.all.length
  };
}

// 历史快照选择器（V19）。
function buildHistoryView(runtime, state) {
  const order = (state.snapshot_order || []).slice().reverse();
  return order.map(sid => {
    const s = state.snapshots[sid];
    if (!s) return null;
    const time = s.clock && s.clock.scene_time;
    const sc = time ? Core.time.ordinalToClock(time.ordinal_minute, time.calendar_id) : null;
    return { snapshot_id: sid, message_id: s.message_id, revision: s.revision, route_id: s.route.route_id, scene_id: s.route.scene_id, scene_clock: sc ? sc.date_label + (sc.time_label && sc.time_label !== '00:00' ? ' · ' + sc.time_label : '') : '暂无', progress_label: '第' + (s.route.scene_index + 1) + ' / ' + s.route.node_count + '段', event_text: (s.event_display && s.event_display.text) || '暂无已记录事件' };
  }).filter(Boolean);
}

const api = { routeLabel, sceneLabel, sceneTitle, clockText, sceneNarrative, sceneOverview, siblingRoutes, routeButton, buildRoutePreview, buildRouteSummary, buildStoryPageView, buildTurnPanelView, buildCatalogView, buildNavigationView, buildHistoryView };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_UI_VIEWMODEL__ = api; }

