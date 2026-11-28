// 核心运行时门面：绑定数据索引，暴露纯函数接口。宿主适配器负责世界书/消息/变量/事件/生成。
'use strict';

const T = require('./time');
const S = require('./state');
const E = require('./events');
const A = require('./actors');
const R = require('./routes');
const D = require('./data');
const N = require('./narrative');
const Nav = require('./navigation');
const Turn = require('./turn');
const C = require('./corpus');
const G = require('./guide');
const Plot = require('./plot_direction');

function createRuntime(data) {
  const idx = data.actorById ? data : D.buildIndexes(data);
  const ci = C.buildCorpusIndex(data.corpus || idx.corpus || {});
  const gi = G.buildGuideIndex(data.route_guides || idx.route_guides || {});
  if (!idx.corpusIndex) idx.corpusIndex = ci;
  if (!idx.guideIndex) idx.guideIndex = gi;
  return {
    data: idx,
    corpus: ci,
    guides: gi,
    guideForRoute: (routeId) => gi.byRoute.get(routeId) || null,
    guideAct: (routeId, nodeId) => G.actDetail(gi, routeId, nodeId),
    corpusSegment: (state) => C.segmentContext(ci, state, idx),
    corpusFullText: (nodeId) => C.nodeFullText(ci, nodeId),
    corpusLine: (routeId) => C.lineForRoute(ci, routeId),
    corpusNodeForScene: (sceneId) => C.nodeForScene(ci, idx, sceneId),
    corpusNodeById: (nodeId) => ci.nodesById[nodeId] || null,
    corpusStatus: (st) => {
      if (!ci.available || !st || !st.active_route) return null;
      const v = C.validationContext(ci, st, idx);
      if (!v) return null;
      const node = ci.nodesById[v.node_id];
      const src = C.sourceOf(ci, node);
      return { ...v, node_code: node.node_code, act_name: node.act_name, title: node.title || null,
        speakers: node.speakers || [], source_locator: node.source_locator,
        source_file: src ? src.relative_path : null,
        source_file_sha256: src ? src.file_sha256 : null };
    },
    createState: (opts) => S.createState(Object.assign({ data_version: idx.data_version }, opts)),
    listNearbyStories: (sceneTime, options) => R.listNearbyStories(sceneTime, idx.catalog || { stories: idx.stories }, options),
    enterRoute: (state, routeId, mode) => R.enterRoute(state, routeId, mode, idx),
    exitRoute: (state, destination) => R.exitRoute(state, destination, idx),
    resolveActorAtScene: (actorId, sceneContext, facts) => A.resolveActorAtScene(actorId, sceneContext, facts, idx),
    resolvePortrait: (actorId, actorState, sceneContext) => A.resolvePortrait(actorId, actorState, sceneContext, idx),
    allowedEventCandidates: (state) => Turn.allowedEventCandidates(state, idx),
    reduceTurn: (state, turnResult, opts) => Turn.reduceTurn(state, turnResult, idx, opts),
    revertToSnapshot: (state, snapshotId) => Turn.revertToSnapshot(state, snapshotId),
    selectEventDisplay: (state, ctx) => E.selectEventDisplay(state, Object.assign({ events: idx.events }, ctx)),
    renderTurnStatus: (snapshot) => Turn.renderTurnStatus(snapshot, idx),
    getSnapshot: (state, snapshotId) => S.getSnapshot(state, snapshotId),
    // v3 篇章/国家导航与回忆作用域接口
    buildNavigation: (state, options) => Nav.buildNavigation(state, options, idx),
    enterExperience: (state, entryId, options) => Nav.enterExperience(state, entryId, options, idx),
    finishExperience: (state, result) => Nav.finishExperience(state, result, idx),
    resolveSceneContext: (state, sceneId) => Nav.resolveSceneContext(state, sceneId, idx),
    nextEntry: (entryId) => Nav.nextEntry(idx, entryId),
    narrative: N,
    // 生成前注入包：当前线与目标、当前人物、短必要背景、可能事件与允许推进边界。
    // v3：附带作用域（回忆/主线）、当前时期可用事实、玩家知识（与人物知识分离）。
    buildPromptInjection: (state) => {
      if (!state.active_route) return null;
      const route = idx.routeById[state.active_route.route_id];
      const scene = idx.sceneById[state.active_route.scene_id];
      // 旧存档指向已不存在的场景：不注入剧情控制包，交由 UI 显示原位置并让玩家选续点。
      if (!route || !scene) return null;
      const candidates = Turn.allowedEventCandidates(state, idx);
      const cast = Object.values(state.actor_scene_states || {}).map(s => ({ actor_id: s.actor_id, name: s.canonical_name, label: s.label, entry_id: s.entry_id, profile_entry_id: s.profile_entry_id, profile_label: s.profile_label, control_state: s.control_state != null ? s.control_state : undefined }));
      const nc = N.currentContext(state);
      const mem = nc.kind === 'memory' ? N.memoryById(idx, nc.memory_id) : null;
      const node = mem && scene ? (mem.nodes || []).find(n => n.scene_id === scene.scene_id) : null;
      const entry = Nav.entryForStory(idx, route.story_id);
      const group = entry ? Nav.groupOfEntry(idx, entry) : null;
      const rp = S.getRouteProgress(state, route.route_id);
      const sceneIndex = route.ordered_scene_ids.indexOf(scene.scene_id);
      const nextSceneId = sceneIndex >= 0 && sceneIndex + 1 < route.ordered_scene_ids.length ? route.ordered_scene_ids[sceneIndex + 1] : null;
      const nextScene = nextSceneId ? idx.sceneById[nextSceneId] : null;
      const lastEvent = rp.last_event_display || state.last_event_display || null;
      // 本轮唯一权威的当段原文：来自最终交付物内嵌的原文库，按稳定节点 ID + 段落游标取用。
      const segCtx = C.segmentContext(ci, state, idx);
      const guide = G.focusedInjection(gi, state.active_route.route_id, segCtx && segCtx.node_id, segCtx && segCtx.material);
      // 玩家已体验的回忆（玩家知识），不等于当前扮演人物亲历的知识。
      const playerOnlyKnowledge = Object.values(state.memory_progress || {}).filter(mp => mp.experienced).map(mp => ({ memory_id: mp.memory_id, note: '玩家已体验该回忆；当前人物未必亲历，不得自动让人物引用其中细节' }));
      return Plot.decorateInjection(state, {
        route_id: route.route_id, story_id: route.story_id, scene_id: scene.scene_id,
        scene_time: state.active_route.scene_time, world_time: state.world_time, context_mode: state.active_route.context_mode,
        narrative_context: { kind: nc.kind, memory_id: nc.memory_id || null, scope_id: nc.scope_id },
        navigation: entry ? { entry_id: entry.entry_id, group: group ? group.label : null, title: entry.display_title || entry.title, date_display: nc.kind === 'memory' ? (node && node.node_date && node.node_date.date_label ? node.node_date.date_label : '暂无') : (entry.date_display || '暂无') } : null,
        memory_node: node ? { node_code: node.node_code, local_evidence: node.local_evidence, nested_recollection: !!node.nested_recollection } : null,
        current_goal: (scene && scene.completion_criteria) || null,
        progress: { scene_index: sceneIndex, node_count: route.ordered_scene_ids.length, display: '第' + (sceneIndex + 1) + ' / ' + route.ordered_scene_ids.length + '幕' },
        // 下一幕只给标题与 ID：不把下一幕原文提前放进当前回合的模型输入。
        next_scene: nextScene ? { scene_id: nextSceneId, title: nextScene.completion_criteria || nextSceneId } : null,
        last_event_display: lastEvent ? { text: lastEvent.text || null, occurred_at: lastEvent.occurred_at || null } : null,
        scene_material: segCtx && segCtx.material ? segCtx.material : '',
        route_guide: guide,
        corpus_segment: segCtx,
        segment_speakers: segCtx ? segCtx.speakers : [],
        scene_actor_ids: scene.focus_actor_ids || [],
        allowed_completed_scene_ids: [scene.scene_id],
        cast, necessary_background: (route.cross_route_inputs || []).map(i => ({ event_id: i.event_id, presentation: i.presentation })),
        possible_events: candidates.map(ev => ({ event_id: ev.event_id, title: ev.title, trigger_policy: ev.trigger_policy, ready_for_runtime: ev.ready_for_runtime })),
        player_only_knowledge: playerOnlyKnowledge,
        scope_facts_note: nc.kind === 'memory' ? '当前为回忆作用域：只使用本作用域事实与人物状态；回忆中的完成事实不写入现实主线，当前人物不自动获得玩家视角信息。' : '当前为主线/支线作用域：按当前场景时点投影人物状态，不把未来篇章的能力/死亡/知识带回早期。',
        corpus_boundary: segCtx && !segCtx.needs_manual_choice ? {
          node_id: segCtx.node_id, segment_node_id: segCtx.node_id,
          segment_index: segCtx.segment_index, segment_count: segCtx.segment_count,
          segment_ack: segCtx.segment_index, is_last_segment: segCtx.is_last_segment,
          next_allowed_scene_id: segCtx.next_allowed_scene_id,
          next_allowed_node_id: segCtx.next_allowed_node_id,
          shared_event_id: segCtx.shared_event_id,
          shared_event_already_settled: segCtx.shared_event_already_settled,
          note: '只有本段确实演完才把 segment_ack 填为当前段号；填了才推进一次，未填或无效回复保留现场。'
        } : null,
        advance_boundary: { max_elapsed_minutes: 1440, allow_zero_minutes: true, camera_locked_route: route.route_id, auto_switch: false },
        elapsed_instruction: '明确时间指令与场景预定时长高于模型建议；正常对话允许0分钟。日期未知时只记录经过分钟，不编造绝对日期。'
      });
    }
  };
}

const api = { createRuntime, time: T, state: S, events: E, actors: A, routes: R, data: D, narrative: N, navigation: Nav, turn: Turn, corpus: C, guide: G, plotDirection: Plot };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_STORY_CORE__ = api; }

