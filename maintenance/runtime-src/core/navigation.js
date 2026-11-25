// 篇章/国家导航：主线三块 + 支线国家/专题块 + 补充入口，按编译期 sequence_order 展示。
// 运行时不重排目录、不让模型决定顺序；时间索引降为辅助查阅。
// 公开接口：buildNavigation / enterExperience / finishExperience / resolveSceneContext。
'use strict';

const S = require('./state');
const R = require('./routes');
const N = require('./narrative');
const A = require('./actors');
const E = require('./events');
const T = require('./time');

function navOf(data) { return data.navigation || null; }

function findEntry(data, entryId) {
  const nav = navOf(data);
  if (!nav) return null;
  return (nav.entries || []).find(e => e.entry_id === entryId) || (nav.supplementary || []).find(e => e.entry_id === entryId) || null;
}

function entryForStory(data, storyId) {
  const nav = navOf(data);
  if (!nav) return null;
  return (nav.entries || []).find(e => e.story_id === storyId) || (nav.supplementary || []).find(e => e.story_id === storyId) || null;
}

function groupOfEntry(data, entry) {
  const nav = navOf(data);
  if (!nav || !entry || !entry.group_id) return null;
  return (nav.groups || []).find(g => g.group_id === entry.group_id) || null;
}

function isGenericActor(id) { return /^spk_/.test(String(id || '')); }

// 路线显示名（与 viewmodel.routeLabel 同语义，核心层自足）。
function routeLabel(route, data) {
  if (!route) return '未选线';
  if (route.display_label) return route.display_label;
  if (route.quality === 'official_complete' || route.line_code === 'official_complete') return '完整线';
  if (route.source_kind === 'prts_official' && route.line_code === 'main' && !(route.focus_actor_ids || []).length) return '完整线';
  const named = (route.focus_actor_ids || []).map(id => data.actorById[id] && data.actorById[id].canonical_name).filter(Boolean);
  if (named.length) return named[0] + '线';
  return '独立片段';
}

function routeBrief(route, data) {
  return { route_id: route.route_id, label: routeLabel(route, data), line_code: route.line_code, node_count: route.ordered_scene_ids.length };
}

// 导航主视图。主线三块恒在前且顺序不受时间筛选改变；支线按国家/专题分块；补充入口单列。
function buildNavigation(state, options, data) {
  const nav = navOf(data);
  if (!nav) return { available: false, reason: 'navigation_data_missing', main: [], side: [], supplementary: [] };
  const o = options || {};
  const prog = state.experience_progress || {};
  const memProg = state.memory_progress || {};
  const activeRouteId = state.active_route && state.active_route.route_id;

  const decorate = (e, isSupp) => {
    const ep = prog[e.entry_id];
    const rp = (state.route_progress || {})[e.default_route_id];
    const entered = !!(ep && ep.entered) || !!(state.entered_routes || {})[e.default_route_id];
    const finished = !!(ep && ep.finished);
    const mem = e.narrative_layer === 'memory' ? N.memoryById(data, e.memory_id) : null;
    const routes = (e.route_ids || []).map(id => data.routeById[id]).filter(r => r && !r.catalog_alias_of).map(r => routeBrief(r, data));
    return {
      entry_id: e.entry_id, story_id: e.story_id,
      title: isSupp ? e.title : e.display_title,
      group_id: e.group_id || null,
      sequence_order: e.sequence_order != null ? e.sequence_order : null,
      chapter_number: e.chapter_number != null ? e.chapter_number : null,
      narrative_layer: e.narrative_layer || 'story',
      date_display: e.date_display || '暂无',
      date_precision: e.date_precision || null,
      date_review_status: e.date_review_status || null,
      legacy_candidate_window: e.legacy_candidate_window || null,
      available: e.availability === 'provided' && routes.length > 0,
      routes,
      default_route_id: e.default_route_id,
      node_count: e.node_count || 0,
      active: !!(activeRouteId && (e.route_ids || []).includes(activeRouteId)),
      progress: {
        entered, finished,
        scene_index: rp ? rp.scene_index : null,
        label: rp ? '第' + (rp.scene_index + 1) + ' / ' + (e.node_count || '?') + '段' : (entered ? '已体验' : '未进入')
      },
      memory: mem ? {
        memory_id: mem.memory_id,
        experienced: !!(memProg[mem.memory_id] && memProg[mem.memory_id].experienced),
        parent_story_id: mem.parent_story_id,
        rewatch_available: true
      } : null,
      related_supplement_story_ids: e.related_supplement_story_ids || [],
      also_referenced_by: e.also_referenced_by || [],
      source_relative_path: e.source_relative_path || null,
      source_file_label: e.source_file_label || null,
      placement: e.placement || null,
      category: e.category || null
    };
  };

  const groups = (nav.groups || []).slice().sort((a, b) => a.display_order - b.display_order).map(g => ({
    group_id: g.group_id, label: g.label, kind: g.kind, presentation: g.presentation || null, display_order: g.display_order, order_basis: g.order_basis || null,
    entries: (g.entry_ids || []).map(id => (nav.entries || []).find(e => e.entry_id === id)).filter(Boolean).map(e => decorate(e, false))
  }));
  const main = groups.filter(g => g.kind === 'main');
  const side = groups.filter(g => g.kind !== 'main' && g.entries.length);
  const supplementary = (nav.supplementary || []).filter(e=>!e.catalog_hidden&&!e.catalog_promoted).map(e => decorate(e, true));
  return {
    available: true, schema: nav.schema || 1,
    default_view: 'navigation',
    main, side, supplementary,
    counts: nav.counts,
    reference_time: state.world_time || null,
    auxiliary: { time_index: true, history: true }
  };
}

// 导航序列中的下一篇：同组按 sequence_order；组末则按 display_order 取下一组首项。
function nextEntry(data, entryId) {
  const nav = navOf(data);
  if (!nav) return null;
  const entry = findEntry(data, entryId);
  if (!entry) return null;
  if(entry.main_combined_archive)return (nav.entries||[]).find(e=>e.group_id===entry.group_id&&e.chapter_number===6)||null;
  if (entry.group_id) {
    const group = (nav.groups || []).find(g => g.group_id === entry.group_id);
    if (group) {
      const siblings = (group.entry_ids || []).map(id => (nav.entries || []).find(e => e.entry_id === id)).filter(Boolean)
        .sort((a, b) => a.sequence_order - b.sequence_order);
      const i = siblings.findIndex(e => e.entry_id === entryId);
      if (i >= 0 && i + 1 < siblings.length) return siblings[i + 1];
      const groups = (nav.groups || []).slice().sort((a, b) => a.display_order - b.display_order);
      const gi = groups.findIndex(g => g.group_id === entry.group_id);
      for (let k = gi + 1; k < groups.length; k++) {
        const first = (groups[k].entry_ids || [])[0];
        const e = first && (nav.entries || []).find(x => x.entry_id === first);
        if (e) return e;
      }
    }
    return null;
  }
  // 补充入口：按补充列表顺序
  const supp = nav.supplementary || [];
  const si = supp.findIndex(e => e.entry_id === entryId);
  return si >= 0 && si + 1 < supp.length ? supp[si + 1] : null;
}

// 进入体验：找到路线→恢复/创建上下文（含回忆作用域）→对齐人物→生成一次开场计划。
// options: { route_id, mode: 'live'|'continue'|'restart' }
function enterExperience(state, entryId, options, data) {
  const o = options || {};
  const entry = findEntry(data, entryId);
  if (!entry) return { ok: false, error: 'unknown_entry', state };
  const routeId = o.route_id || entry.default_route_id;
  if (!routeId || !(entry.route_ids || []).includes(routeId)) return { ok: false, error: 'route_not_in_entry', state };
  const route = data.routeById[routeId];
  if (!route) return { ok: false, error: 'unknown_route', state };

  let ns = S.cloneState(state);
  ns.experience_progress = ns.experience_progress || {};
  const ep = ns.experience_progress[entryId] || (ns.experience_progress[entryId] = { entry_id: entryId, story_id: entry.story_id, entered: false, finished: false, route_ids_used: [], last_route_id: null });
  ep.entered = true;
  ep.last_route_id = routeId;
  if (!ep.route_ids_used.includes(routeId)) ep.route_ids_used.push(routeId);

  const mem = N.memoryForRoute(route, data);
  let memoryEntered = false;
  if (mem) {
    const r = N.enterMemoryScope(ns, mem, data);
    if (!r.ok) return { ok: false, error: r.error, state };
    ns = r.state;
    memoryEntered = !r.already;
  } else if (N.inMemory(ns)) {
    // 从回忆进入正常篇章：先恢复主线上下文，再进入目标线
    const r = N.exitMemoryScope(ns, data);
    if (!r.ok) return { ok: false, error: r.error, state };
    ns = r.state;
  }

  const mode = o.scene_id ? { scene_id: o.scene_id, mode: 'jump' } :
    o.mode || ((state.entered_routes || {})[routeId] ? 'continue' : 'live');
  const r = R.enterRoute(ns, routeId, mode, data);
  if (!r.ok) return { ok: false, error: r.error, state };
  ns = r.state;

  // 父章前情提示：不自动插播回忆；未体验给可点击前情入口，已体验给重看入口。
  let memoryPreface = null;
  const childMem = N.memoriesOf(data).find(m => m.parent_story_id === entry.story_id);
  if (childMem) {
    const experienced = !!((ns.memory_progress || {})[childMem.memory_id] || {}).experienced;
    memoryPreface = {
      memory_id: childMem.memory_id,
      entry_id: childMem.entry_id,
      experienced,
      auto_insert: false,
      hint: experienced
        ? '已体验「' + childMem.title + '」；本章不再自动插播，可在目录重看回忆。'
        : '前情推荐：「' + childMem.title + '」。可点击进入回忆，也可继续当前章节，不强制退回。'
    };
  }
  return {
    ok: true, entry_id: entryId, entryPlan: r.entryPlan, state: ns,
    already_entered: r.already_entered, memory_entered: memoryEntered,
    memory_preface: memoryPreface,
    narrative_context: N.currentContext(ns)
  };
}

// 结束体验：结算当前作用域→保存体验进度→回忆退出恢复→给出下一篇入口（不自动连续生成）。
// result: { completed?: boolean }（末节点是否实际完成由路线进度判定，这里不伪造完成）
function finishExperience(state, result, data) {
  let ns = S.cloneState(state);
  const active = ns.active_route;
  if (!active) return { ok: false, error: 'no_active_route', state };
  const route = data.routeById[active.route_id];
  if (!route) return { ok: false, error: 'unknown_route', state };
  const rp = S.getRouteProgress(ns, active.route_id);
  const lastScene = route.ordered_scene_ids[route.ordered_scene_ids.length - 1];
  const atEnd = rp.scene_index >= route.ordered_scene_ids.length - 1;
  const completed = atEnd && (rp.completed_scene_ids || []).includes(lastScene);
    if (!completed) return { ok: false, error: 'experience_not_completed', state };

  const entry = entryForStory(data, route.story_id);
  let finishedEntry = null;
  if (entry) {
    ns.experience_progress = ns.experience_progress || {};
    const ep = ns.experience_progress[entry.entry_id] || (ns.experience_progress[entry.entry_id] = { entry_id: entry.entry_id, story_id: route.story_id, entered: true, finished: false, route_ids_used: [active.route_id], last_route_id: active.route_id });
    ep.entered = true;
    ep.last_route_id = active.route_id;
    // 单条角色线到结尾不代表全章每条线均已体验，跳幕也不补记完成。
    ep.finished_route_ids = ep.finished_route_ids || [];
    if (completed && route.ordered_scene_ids.every(id => (rp.completed_scene_ids || []).includes(id)) && !ep.finished_route_ids.includes(active.route_id)) ep.finished_route_ids.push(active.route_id);
    ep.finished = (entry.route_ids || [active.route_id]).every(id => ep.finished_route_ids.includes(id));
    if (ep.finished) ep.finished_at_revision = ns.revision;
    finishedEntry = entry.entry_id;
  }

  const wasMemory = N.inMemory(ns);
  const chapterComplete = !!(entry && ns.experience_progress[entry.entry_id] && ns.experience_progress[entry.entry_id].finished);
  let memoryExited = false, restoredRoute = null;
  if (wasMemory) {
    N.noteMemoryProgress(ns, route, rp, data);
    const r = N.exitMemoryScope(ns, data);
    if (!r.ok) return { ok: false, error: r.error, state };
    ns = r.state;
    memoryExited = true;
    restoredRoute = r.restored_route;
  }
  ns.revision += 1;
  const next = entry ? nextEntry(data, entry.entry_id) : null;
  return {
    ok: true, state: ns,
    entry_id: finishedEntry,
    completed,
    chapter_complete: chapterComplete,
    at_end: atEnd,
    memory_exited: memoryExited,
    restored_route: restoredRoute,
    next_entry: next ? { entry_id: next.entry_id, story_id: next.story_id, title: next.display_title || next.title, default_route_id: next.default_route_id, group_id: next.group_id || null } : null,
    narrative_context: N.currentContext(ns)
  };
}

// 场景上下文一次性解析：时间标签（保留来源精度/暂无）、时期、锚点、有效事实、人物状态与纪事。
function resolveSceneContext(state, sceneId, data) {
  const scene = data.sceneById[sceneId];
  if (!scene) return { ok: false, error: 'unknown_scene' };
  const active = state.active_route;
  const route = active ? data.routeById[active.route_id] : null;
  const story = route ? data.storyById[route.story_id] : null;
  const nc = N.currentContext(state);
  const mem = nc.kind === 'memory' ? N.memoryById(data, nc.memory_id) : null;
  const sceneTime = R.sceneTimeOf(scene, story, { ignoreStoryWindow: !!mem });
  const node = mem ? (mem.nodes || []).find(n => n.scene_id === sceneId) : null;

  // 时间标签：场景已知时间→运行时钟；回忆节点有明确日期→节点日期；否则“暂无”。
  let dateDisplay = '暂无', datePrecision = 'unknown', dateSource = null;
  if (sceneTime.ordinal_minute != null) {
    const clock = T.ordinalToClock(sceneTime.ordinal_minute, sceneTime.calendar_id);
    dateDisplay = clock.date_label; datePrecision = 'day'; dateSource = 'scene_clock';
  } else if (node && node.node_date && node.node_date.date_label) {
    dateDisplay = node.node_date.date_label; datePrecision = node.node_date.precision || 'unknown'; dateSource = node.node_date.source;
  } else if (node && node.node_date && node.node_date.display) {
    dateDisplay = node.node_date.display; datePrecision = node.node_date.precision; dateSource = node.node_date.source;
  } else if (!mem && story && story.canonical_window && story.canonical_window.start) {
    dateDisplay = story.canonical_window.start + (story.canonical_window.end && story.canonical_window.end !== story.canonical_window.start ? ' 至 ' + story.canonical_window.end : '');
    datePrecision = story.canonical_window.precision || 'unknown'; dateSource = 'story_window_inherited';
  }

  const anchors = collectAnchors(data, { story_id: route && route.story_id, route_id: route && route.route_id, scene_id: sceneId, memory_id: nc.memory_id });
  const portraitMemory = mem || (route?.ordered_scene_ids.includes(sceneId) ? N.memoryForRoute(route, data) : null);
  const periodTags = portraitMemory ? ['memory:' + portraitMemory.memory_id, 'npc_story'] : (active && active.context_mode === 'route_replay' ? ['historical'] : []);
  const ctx = { story_id: route?.story_id, scene_id: sceneId, scene_time: sceneTime, period_label: portraitMemory ? '回忆' : (active && active.context_mode === 'route_replay' ? '历史时点' : null), anchors, period_tags: periodTags };
  const ids = route ? R.castForScene(route, scene, data) : (scene.focus_actor_ids || []);
  const actorStates = {}, portraits = {};
  for (const id of ids) {
    const st = A.resolveActorAtScene(id, ctx, state.facts, data);
    actorStates[id] = st;
    portraits[id] = A.resolvePortrait(id, st, ctx, data);
  }
  const chronicle = E.selectEventDisplay(S.cloneRunningState(state), { events: data.events, scene_time: sceneTime, route_id: route && route.route_id, route_story_id: route && route.story_id, turn_id: 'resolve:' + sceneId });
  return {
    ok: true, scene_id: sceneId,
    scene_time: sceneTime, date_display: dateDisplay, date_precision: datePrecision, date_source: dateSource,
    narrative_layer: mem ? 'memory' : (scene.narrative_layer || 'main'),
    context_kind: nc.kind, memory_id: nc.memory_id || null,
    node: node ? { node_code: node.node_code, local_evidence: node.local_evidence, nested_recollection: node.nested_recollection, original_text_coverage: node.original_text_coverage } : null,
    period_label: ctx.period_label, period_tags: periodTags,
    anchors, actor_states: actorStates, portraits,
    valid_facts: state.facts,
    chronicle
  };
}

// 汇总适用锚点：路线级/故事级/节点级。返回 { actor_id: anchor }。
function collectAnchors(data, ref) {
  const out = {};
  const list = (data.actorAnchors && data.actorAnchors.anchors) || [];
  for (const a of list) {
    const match =
      (a.scope === 'route' && ref.route_id && a.route_id === ref.route_id) ||
      (a.scope === 'story' && ref.story_id && a.story_id === ref.story_id) ||
      (a.scope === 'scene' && ref.scene_id && a.scene_id === ref.scene_id);
    if (match) out[a.actor_id] = a;
  }
  if (ref.memory_id && ref.scene_id) {
    for (const na of N.nodeAnchorsForScene(data, ref.memory_id, ref.scene_id)) {
      out[na.actor_id] = { anchor_id: 'node:' + ref.scene_id + ':' + na.actor_id, scope: 'scene', actor_id: na.actor_id, state_entry_id: na.entry_id, label: na.label, control_state: na.control_state || null, basis: na.basis, evidence_level: 'local_node_explicit' };
    }
  }
  return out;
}

const api = { buildNavigation, enterExperience, finishExperience, resolveSceneContext, findEntry, entryForStory, groupOfEntry, nextEntry, routeLabel, routeBrief, collectAnchors };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_NAVIGATION__ = api; }
