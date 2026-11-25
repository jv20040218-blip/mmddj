// 运行数据索引：把编译产物(data/*.json)组织成核心函数所需的查找表。只读，不改原素材。
// data_version 对运行有效数据做稳定序列化后计算，覆盖导航/回忆/锚点/顺序/立绘/目录/路线/事件/人物/场景；
// 纯改目录顺序、日期标签或立绘也会改变版本（N16）。loadFromDisk 与 build_runtime_data 共用同一算法。
'use strict';

function buildIndexes(raw) {
  const actors = (raw.actors && raw.actors.actors) || [];
  const generic = (raw.actors && raw.actors.generic_actors) || [];
  const allActors = actors.concat(generic);
  const actorById = {};
  for (const a of allActors) actorById[a.actor_id] = a;
  const nameIndex = {};
  for (const a of allActors) for (const name of [a.canonical_name, ...(a.aliases || [])]) {
    const previous = actorById[nameIndex[name]];
    if (!previous || a.states?.length || !previous.states?.length) nameIndex[name] = a.actor_id;
  }
  const portraits = (raw.portraits && raw.portraits.portraits) || [];
  const portraitsByActor = {};
  for (const p of portraits) { if (!p.actor_id) continue; (portraitsByActor[p.actor_id] = portraitsByActor[p.actor_id] || []).push(p); }
  const routes = (raw.routes && raw.routes.routes) || [];
  const routeById = {};
  for (const r of routes) routeById[r.route_id] = r;
  const scenes = (raw.scenes && raw.scenes.scenes) || [];
  const sceneById = {};
  for (const s of scenes) sceneById[s.scene_id] = s;
  const stories = (raw.catalog && raw.catalog.stories) || [];
  const storyById = {};
  for (const s of stories) storyById[s.story_id] = s;
  const events = (raw.events && raw.events.events) || [];
  const eventById = {};
  for (const e of events) eventById[e.event_id] = e;
  const segments = (raw.segments && raw.segments.segments) || [];
  const segmentById = {};
  for (const s of segments) segmentById[s.segment_id] = s;
  // v3 新增数据
  const navigation = raw.navigation || null;
  const memoryManifest = raw.memory_manifest || null;
  const actorAnchors = raw.actor_scene_anchors || null;
  const sequenceOverrides = raw.sequence_overrides || null;
  const portraitPageIndex = raw.portrait_page_index || null;
  const navigationEntryById = {};
  const navigationByStory = {};
  if (navigation) {
    for (const e of [...(navigation.entries || []), ...(navigation.supplementary || [])]) {
      navigationEntryById[e.entry_id] = e;
      (navigationByStory[e.story_id] = navigationByStory[e.story_id] || []).push(e.entry_id);
    }
  }
  const memoryByStory = {};
  const memoryById = {};
  if (memoryManifest) for (const m of memoryManifest.memories || []) { memoryByStory[m.story_id] = m; memoryById[m.memory_id] = m; }
  const controlTransitions = (actorAnchors && actorAnchors.control_transitions) || [];
  const playerSummaryByScene = new Map();
  for (const route of raw.player_summaries?.routes || []) {
    for (const entry of route.entries) {
      playerSummaryByScene.set(JSON.stringify([route.route_id, entry.scene_id, entry.node_id]), entry);
    }
  }
  return {
    playerSummaryByScene,
    actorById, nameIndex, portraitsByActor, portraits, routeById, routes, sceneById, scenes,
    storyById, stories, events, eventById, segmentById, segments,
    overrides: raw.overrides || null, sources: (raw.sources && raw.sources.sources) || [],
    navigation, memoryManifest, actorAnchors, sequenceOverrides, portraitPageIndex,
    navigationEntryById, navigationByStory, memoryByStory, memoryById, controlTransitions,
    corpus: raw.corpus || null,
    route_guides: raw.route_guides || null,
    route_guide_uids: raw.route_guide_uids || null,
    worldbook_binding: raw.worldbook_binding || null,
    data_version: raw.data_version || 'dev'
  };
}

// 稳定序列化：对象键排序，数组保序。用于 data_version 计算。
function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
  return out;
}

// 运行有效数据投影：只取影响运行时行为的字段（完整数据与紧凑数据两侧一致）。
function versionInput(raw) {
  const actors = (raw.actors && raw.actors.actors) || [];
  const portraits = (raw.portraits && raw.portraits.portraits) || [];
  const routes = (raw.routes && raw.routes.routes) || [];
  const scenes = (raw.scenes && raw.scenes.scenes) || [];
  const stories = (raw.catalog && raw.catalog.stories) || [];
  const events = (raw.events && raw.events.events) || [];
  return {
    ...(raw.player_summaries ? { player_summaries: raw.player_summaries } : {}),
    navigation: raw.navigation || null,
    worldbook_binding: raw.worldbook_binding || null,
    memory_manifest: raw.memory_manifest || null,
    profile_registry: raw.profile_registry || null,
    binding_actors: raw.worldbook_binding ? [...actors, ...((raw.actors && raw.actors.generic_actors) || [])].filter(a => a.states && a.states.length).map(a => [a.actor_id, a.timeline_default_entry, a.aliases, a.states.map(s => [s.entry_id, s.label])]) : null,
    actor_scene_anchors: raw.actor_scene_anchors || null,
    sequence_overrides: raw.sequence_overrides || null,
    portrait_page_index: raw.portrait_page_index || null,
    portraits: portraits.map(p => [p.asset_id, p.actor_id, p.variant, p.image_url, p.applicability || null, p.period_tags || null, p.asset_kind || null]),
    stories: stories.map(s => [s.story_id, s.title, s.category, s.canonical_window || null, s.route_ids || [], s.availability]),
    routes: routes.map(r => [r.route_id, r.story_id, r.ordered_scene_ids || [], r.focus_actor_ids || []]),
    events: events.map(e => [e.event_id, e.kind, e.story_id || null, e.canonical_window || null, e.trigger_policy || null, e.ready_for_runtime === true, e.proposed_effect || null, e.transition_candidate || null]),
    actors: actors.map(a => [a.actor_id, a.default_entry, (a.states || []).map(s => [s.entry_id, s.label]), (a.transitions || []).map(t => [t.transition_id, t.from_entry, t.to_entry, t.date, t.precision, t.trigger_policy])]),
    scenes: scenes.map(s => [s.scene_id, s.narrative_layer || null, s.time || null, s.focus_actor_ids || []])
  };
}

function computeDataVersion(raw) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(JSON.stringify(canonical(versionInput(raw)))).digest('hex').slice(0, 12);
}

// Node 环境从磁盘加载；浏览器环境由打包器注入 raw。
function loadFromDisk(dataDir) {
  const fs = require('fs');
  const path = require('path');
  const read = f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  const readOptional = f => { try { return read(f); } catch (e) { return null; } };
  const raw = {
    actors: read('actors.json'), portraits: read('portraits.json'), routes: read('routes.json'),
    scenes: read('scenes.json'), catalog: read('catalog.json'), events: read('events.json'),
    segments: read('segments.json'), overrides: read('overrides.json'), sources: read('sources.json'),
    navigation: readOptional('navigation.json'),
    memory_manifest: readOptional('memory_manifest.json'),
    actor_scene_anchors: readOptional('actor_scene_anchors.json'),
    sequence_overrides: readOptional('sequence_overrides.json'),
    portrait_page_index: readOptional('portrait_page_index.json')
  };
  raw.data_version = computeDataVersion(raw);
  return buildIndexes(raw);
}

const api = { buildIndexes, loadFromDisk, computeDataVersion, versionInput, canonical };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_DATA__ = api; }

