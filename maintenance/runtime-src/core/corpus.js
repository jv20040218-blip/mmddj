// 剧情原文库运行时：按稳定节点 ID 定位源条目区间，按段落游标供给当段原文。
// 关键约束：「已给模型阅读」(read) 与「已在故事中发生」(occurred) 分开记账；
// 发出请求/注入提示不推进游标，只有有效回复显式确认当段结束才推进一次。
'use strict';

function buildCorpusIndex(raw) {
  const c = (raw && raw.corpus) || raw || {};
  const nodesById = {}, nodesBySegmentId = {}, entriesById = {}, sourcesById = {}, linesById = {}, logicByStory = {};
  for (const s of c.sources || []) sourcesById[s.source_id] = s;
  for (const s of c.sources || []) for (const e of s.entries || []) entriesById[e.entry_id] = e;
  for (const n of c.nodes || []) { nodesById[n.node_id] = n; nodesBySegmentId[n.segment_id] = n; }
  for (const l of c.lines || []) linesById[l.route_id] = l;
  for (const d of c.logic || []) { if (d.story_id) (logicByStory[d.story_id] = logicByStory[d.story_id] || []).push(d); }
  return { raw: c, texts: c.texts || {}, nodesById, nodesBySegmentId, entriesById, sourcesById, linesById, logicByStory,
    available: Object.keys(nodesById).length > 0 };
}

function entryText(ci, entryId) {
  const e = ci.entriesById[entryId];
  if (!e) return '';
  const t = ci.texts[e.text_sha256];
  return t == null ? '' : t;
}

// 用「最终交付物里取回的原文」按区间拼回节点全文。
function textOfNode(ci, node) {
  if (!node) return '';
  const t = entryText(ci, node.entry_id);
  return (node.ranges || [[node.start, node.end]]).map(r => t.slice(r[0], r[1])).join('');
}
function textOfSegment(ci, node, index) {
  if (!node || !node.segments || !node.segments[index]) return '';
  const s = node.segments[index];
  return entryText(ci, node.entry_id).slice(s.start, s.end);
}
function nodeForScene(ci, data, sceneId) {
  const scene = data && data.sceneById && data.sceneById[sceneId];
  if (!scene) return null;
  const sid = (scene.segment_ids || [])[0];
  return ci.nodesBySegmentId[sid] || null;
}
function lineForRoute(ci, routeId) { return ci.linesById[routeId] || null; }
function sourceOf(ci, node) { return node ? ci.sourcesById[node.source_id] || null : null; }

// 旧存档恢复：优先按稳定节点 ID（scene_id -> segment_id -> node_id）定位。
// 找不到可靠匹配时不猜位置，交给 UI 显示原位置并让玩家选续点。
function ensureProgress(ci, state, data) {
  const active = state && state.active_route;
  if (!active) return { progress: null, restored: null, needs_manual_choice: false };
  const routeId = active.route_id;
  if (!state.corpus_progress) state.corpus_progress = {};
  if (!state.shared_events) state.shared_events = {};
  const p = state.corpus_progress[routeId];
  const node = nodeForScene(ci, data, active.scene_id);
  if (p && p.node_id && ci.nodesById[p.node_id] && p.segment_index != null) {
    if (node && p.node_id !== node.node_id) {
      // 存档游标与当前稳定节点不一致：按稳定节点重定位，保留已读记录。
      return { progress: resetProgress(state, routeId, node), restored: 'by_stable_node_id', needs_manual_choice: false };
    }
    return { progress: p, restored: 'existing_progress', needs_manual_choice: false };
  }
  if (!node) return { progress: null, restored: null, needs_manual_choice: true,
    original_position: active.scene_id, reason: '旧存档的场景 ID 在本原文库中没有可靠对应节点' };
  return { progress: resetProgress(state, routeId, node), restored: 'by_stable_node_id', needs_manual_choice: false };
}

function resetProgress(state, routeId, node) {
  if (!state.corpus_progress) state.corpus_progress = {};
  const p = { route_id: routeId, node_id: node ? node.node_id : null, segment_index: 0,
    read: {}, occurred: {}, settled_shared_events: [], revision: state.revision };
  state.corpus_progress[routeId] = p;
  return p;
}

// 本轮注入包：只给视角人物此时可知的当段原文，不给未来幕的原文。
function segmentContext(ci, state, data) {
  const active = state && state.active_route;
  if (!ci.available || !active) return null;
  const ep = ensureProgress(ci, state, data);
  if (ep.needs_manual_choice || !ep.progress) return { needs_manual_choice: true, ...ep };
  const p = ep.progress;
  const node = ci.nodesById[p.node_id] || nodeForScene(ci, data, active.scene_id);
  if (!node) return null;
  const index = Math.min(Math.max(p.segment_index || 0, 0), Math.max(node.segment_count - 1, 0));
  const text = textOfSegment(ci, node, index);
  const seg = node.segments[index] || { start: node.start, end: node.end, chars: node.chars };
  const line = lineForRoute(ci, active.route_id);
  const ordered = line && line.ordered_scene_ids || (data.routeById[active.route_id] || {}).ordered_scene_ids || [];
  const at = ordered.indexOf(active.scene_id);
  const nextSceneId = at >= 0 && at + 1 < ordered.length ? ordered[at + 1] : null;
  const nextNode = nextSceneId ? nodeForScene(ci, data, nextSceneId) : null;
  const src = sourceOf(ci, node);
  // 「已给模型阅读」只记账，不代表故事里已经发生。
  const readKey = node.node_id + '#' + index;
  p.read[readKey] = (p.read[readKey] || 0) + 1;
  p.last_injected = { node_id: node.node_id, segment_index: index, revision: state.revision, chars: text.length };
  const settled = node.shared_event_id ? !!state.shared_events[node.shared_event_id] : false;
  return {
    node_id: node.node_id, node_code: node.node_code, alias_codes: node.alias_codes || [],
    story_id: node.story_id, scene_id: active.scene_id, route_id: active.route_id,
    act_name: node.act_name, node_title: node.title || null,
    segment_index: index, segment_count: node.segment_count, segment_chars: seg.chars,
    segment_range: [seg.start, seg.end],
    source_locator: node.source_locator, source_file: src ? src.relative_path : null,
    source_file_sha256: src ? src.file_sha256 : null, source_uid: node.source_uid,
    source_entry_chars: node.chars,
    material: text,
    speakers: (seg.speakers || []).concat(node.speakers || []).filter((v, i, a) => a.indexOf(v) === i),
    is_last_segment: index >= node.segment_count - 1,
    shared_event_id: node.shared_event_id || null,
    shared_event_already_settled: settled,
    next_allowed_scene_id: nextSceneId,
    next_allowed_node_id: nextNode ? nextNode.node_id : null,
    next_allowed_node_code: nextNode ? nextNode.node_code : null,
    logic_rule_count: (ci.logicByStory[node.story_id] || []).reduce((a, d) => a + d.rules.length, 0),
    read_not_occurred_note: '本段只表示已提供给模型阅读；未收到有效确认前不算在故事中发生，游标不推进。',
    restored: ep.restored
  };
}

// 只读的校验上下文：不记账、不改存档，供每轮提交时复核。
function validationContext(ci, state, data) {
  if (!ci || !ci.available || !state || !state.active_route) return null;
  const routeId = state.active_route.route_id;
  const p = state.corpus_progress && state.corpus_progress[routeId];
  if (!p) return null;
  const node = ci.nodesById[p.node_id];
  if (!node) return null;
  const line = ci.linesById[routeId];
  const ordered = (line && line.ordered_scene_ids) || (data.routeById[routeId] || {}).ordered_scene_ids || [];
  const at = ordered.indexOf(state.active_route.scene_id);
  const nextSceneId = at >= 0 && at + 1 < ordered.length ? ordered[at + 1] : null;
  const nextNode = nextSceneId ? nodeForScene(ci, data, nextSceneId) : null;
  return { scene_id: state.active_route.scene_id, node_id: node.node_id,
    segment_index: p.segment_index, segment_count: node.segment_count,
    is_last_segment: p.segment_index >= node.segment_count - 1,
    next_allowed_scene_id: nextSceneId, next_allowed_node_id: nextNode ? nextNode.node_id : null,
    shared_event_id: node.shared_event_id || null };
}

// 程序校验：模型提交的节点、当前修订号、合法后继、分支前置、共享事件。
function validateAdvance(ci, state, data, turnResult, segCtx) {
  const errors = [];
  let skipEventSettlement = false;
  if (!ci.available || !segCtx || segCtx.needs_manual_choice) return { ok: true, advance: null, errors, skipped: 'no_corpus_node', skip_event_settlement: false };
  const p = (state.corpus_progress || {})[state.active_route.route_id];
  if (!p) return { ok: false, errors: ['corpus_progress_missing'], advance: null };
  if (p.revision != null && p.revision !== state.revision) {
    // 修订号落后时按当前注入值重新对齐，不拒绝本轮。
    p.revision = state.revision;
  }
  if (turnResult.base_revision !== state.revision) errors.push('corpus_stale_base_revision');
  const node = ci.nodesById[p.node_id];
  if (!node) errors.push('corpus_node_missing:' + p.node_id);
  else {
    if (segCtx.scene_id !== state.active_route.scene_id) errors.push('corpus_scene_mismatch');
    if (turnResult.segment_node_id && turnResult.segment_node_id !== node.node_id) errors.push('corpus_node_mismatch:' + turnResult.segment_node_id);
    const acked = turnResult.segment_ack;
    if (acked != null && acked !== p.segment_index) errors.push('segment_ack_stale:' + acked + '!=' + p.segment_index);
    const completed = turnResult.completed_scene_ids || [];
    if (completed.length && !segCtx.is_last_segment) errors.push('cannot_complete_scene_before_last_segment');
    if (completed.some(id => id !== state.active_route.scene_id)) errors.push('completed_scene_not_current');
    // 交汇场景可被另一条线切换视角重读，但世界时间/关键事件/状态变化只提交一次。
    if (node.shared_event_id && state.shared_events && state.shared_events[node.shared_event_id]) skipEventSettlement = true;
    if (acked === p.segment_index) {
      const withinNode = p.segment_index + 1 < node.segment_count;
      const advance = withinNode
        ? { kind: 'segment', from: p.segment_index, to: p.segment_index + 1, node_id: node.node_id, shared_event_id: null }
        : !segCtx.next_allowed_scene_id
          ? { kind: 'segment_end_hold', from: p.segment_index, to: p.segment_index, node_id: node.node_id, shared_event_id: null }
          : { kind: 'node', from_node_id: node.node_id, to_scene_id: segCtx.next_allowed_scene_id,
              to_node_id: segCtx.next_allowed_node_id,
              shared_event_id: skipEventSettlement ? null : (node.shared_event_id || null) };
      return { ok: errors.length === 0, errors, advance, skipped: null, skip_event_settlement: skipEventSettlement };
    }
  }
  return { ok: errors.length === 0, errors, advance: null,
    skipped: turnResult.segment_ack == null ? 'no_segment_ack' : null,
    skip_event_settlement: skipEventSettlement };
}

function applyAdvance(ci, state, turnResult, check) {
  if (!check || !check.ok || !check.advance) return state;
  const routeId = state.active_route.route_id;
  const p = state.corpus_progress[routeId];
  if (!p) return state;
  const a = check.advance;
  const occurredKey = p.node_id + '#' + p.segment_index;
  p.occurred[occurredKey] = { revision: state.revision, message_id: turnResult.message_id || null };
  if (a.kind === 'segment' || a.kind === 'segment_end_hold') {
    p.segment_index = a.to;
  } else {
    if (a.shared_event_id) {
      if (state.shared_events[a.shared_event_id]) return state; // 交汇只提交一次
      state.shared_events[a.shared_event_id] = { revision: state.revision, route_id: routeId };
      p.settled_shared_events.push(a.shared_event_id);
    }
    if (a.to_node_id && ci.nodesById[a.to_node_id]) {
      p.node_id = a.to_node_id;
      p.segment_index = 0;
    } else p.segment_index = 0;
  }
  p.revision = state.revision + 1;
  p.last_advanced = { revision: state.revision, kind: a.kind, node_id: p.node_id, segment_index: p.segment_index };
  return state;
}

// 完整阅读页：玩家主动浏览，不启动生成、不改变注入内容。
function nodeFullText(ci, nodeId) {
  const n = ci.nodesById[nodeId];
  if (!n) return null;
  const src = sourceOf(ci, n);
  return { node_id: n.node_id, node_code: n.node_code, act_name: n.act_name, title: n.title || null,
    text: textOfNode(ci, n), chars: n.chars, segment_count: n.segment_count,
    speakers: n.speakers || [], source_locator: n.source_locator,
    source_file: src ? src.relative_path : null, source_file_sha256: src ? src.file_sha256 : null,
    source_entry_chars: (ci.entriesById[n.entry_id] || {}).chars || null };
}

const api = { buildCorpusIndex, entryText, textOfNode, textOfSegment, nodeForScene, lineForRoute, sourceOf,
  ensureProgress, resetProgress, segmentContext, validationContext, validateAdvance, applyAdvance, nodeFullText };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_CORPUS__ = api; }

