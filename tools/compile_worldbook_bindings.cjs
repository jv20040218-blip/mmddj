'use strict';
const stem = text => String(text || '').replace(/^\[角色\]\s*[:：]\s*/, '').replace(/[（(].*$/, '').trim();
const norm = text => String(text || '').normalize('NFKC').replace(/\s+/g, '').replace(/诗怀雅/g, '诗怀雅').trim();

// These are entry contexts, not invented exact dates. Node and memory anchors remain stronger.
const STORY_STATES = {
  '雪原线': { '塔露拉': '斗士', '爱国者': '雪原', '霜星': '雪原' },
  '生于黑夜': { 'W／维什戴尔': '本格', '凯尔希': '巴别塔', '特蕾西娅': '巴别塔', '可露希尔': '早年', '塔露拉': '斗士' },
  '巴别塔': { '阿米娅': '幼年', '凯尔希': '巴别塔', '特蕾西娅': '巴别塔', '特雷西斯': '内战', '可露希尔': '早年', 'W／维什戴尔': '本格' },
  '风暴瞭望': { '苇草': '本格', '维娜／推进之王': '本格', '杰西卡': '本格' },
  '照我以火': { '苇草': '异格', '爱布拉娜': '领袖' },
  '长夜临光': { '临光': '异格' }, '骑兵与猎人': { '临光': '本格' },
  '孤岛风云': { '赫默': '本格' }, '绿野幻梦': { '赫默': '本格', '格雷伊': '异格' },
  '密林悍将归来': { '嘉维尔': '本格' }, '理想城：长夏狂欢季': { '嘉维尔': '异格' },
  '覆潮之下': { '斯卡蒂': '本格', '幽灵鲨': '本格' },
  '愚人号': { '斯卡蒂': '本格' }, '生路': { '斯卡蒂': '本格', '幽灵鲨': '异格' },
  '火蓝之心': { '艾雅法拉': '本格' }, '火山旅梦': { '艾雅法拉': '异格', '诗怀雅': '异格' },
  '多索雷斯假日': { '陈': '异格', '星熊': '本格' },
  '喧闹法则': { '德克萨斯': '本格', '拉普兰德': '本格', '能天使': '本格' },
  '叙拉古人': { '德克萨斯': '异格', '拉普兰德': '本格' },
  '画中人': { '炎熔': '异格', '克洛丝': '本格' }, '将进酒': { '克洛丝': '异格' },
  '尘影余音': { '芙蓉': '异格' }, '落叶逐火': { '夜刀': '异格', '黑角': '异格' },
  '风雪过境': { '银灰': '本格', '初雪': '本格' }, '银心湖列车': { '银灰': '本格', '初雪': '本格' },
  '乌萨斯的孩子们': { '凛冬': '本格', '真理': '本格' }, '人们，我们': { '凛冬': '本格', '真理': '本格' },
  '时间啊，向前！': { '塔露拉': '新整合运动', '凛冬': '异格', '真理': '成年' },
  '相见欢': { '惊蛰': '异格', '煌': '异格' }, '辞岁行': { '陈': '二异' },
  '相变临界': { '凯尔希': '异格', '塔露拉': '新整合运动' }
};

function compileBindings(raw, baseEntries, importedEntries) {
  const actors = [...raw.actors.actors, ...raw.actors.generic_actors];
  const known = new Map(), owners = new Map(), aliasMap = new Map();
  function register(actor) {
    for (const name of [actor.canonical_name, ...(actor.aliases || [])]) {
      const key = norm(name); if (!known.has(key) || actor.states?.length) known.set(key, actor);
    }
    for (const state of actor.states || []) owners.set(state.entry_id, actor);
  }
  actors.forEach(register);
  for (const e of baseEntries.filter(e => /^\[角色\]\s*[:：]/.test(e.comment || ''))) {
    const uid = e.uid ?? e.id, name = stem(e.comment);
    let actor = owners.get(uid) || known.get(norm(name));
    if (!actor) {
      actor = { actor_id: 'wb_' + uid, canonical_name: name, aliases: [name], dimension: 'single', default_entry: uid, states: [], transitions: [] };
      actors.push(actor); raw.actors.generic_actors.push(actor);
    }
    if (!actor.states?.length) {
      actor.dimension = 'single'; actor.default_entry = uid;
      actor.states = [{ entry_id: uid, label: '本格', entry_name: e.comment, exists_in_card: true, enabled_in_original: e.enabled !== false }];
    }
    if (!owners.has(uid)) {
      if (!actor.states.some(s => s.entry_id === uid)) actor.states.push({ entry_id: uid, label: name, entry_name: e.comment, exists_in_card: true, enabled_in_original: e.enabled !== false });
      owners.set(uid, actor);
    }
    if (!actor.aliases.includes(name)) actor.aliases.push(name);
    register(actor);
  }
  for (const actor of actors.filter(a => a.states?.length)) {
    actor.timeline_default_entry = (actor.states.find(s => s.label === '本格') || actor.states.find(s => s.label === '简略本格') || actor.states.find(s => s.entry_id === actor.default_entry) || actor.states[0]).entry_id;
    // The imported card may have its newest alter enabled; it is not an early-story baseline.
    const initial = (actor.transitions || []).find(t => t.from_entry != null && t.to_entry != null);
    if (initial) actor.timeline_default_entry = initial.from_entry;
    for (const state of actor.states) {
      const name = norm(stem(state.entry_name)); if (!name) continue;
      const list = aliasMap.get(name) || []; list.push({ actor, state }); aliasMap.set(name, list);
    }
  }
  const explicitNames = new Map();
  for (const e of baseEntries) {
    const actor = owners.get(e.uid ?? e.id); if (!actor) continue;
    const header = String(e.content || '').split(/外貌\s*[:：]/)[0].slice(0, 1600);
    for (const match of header.matchAll(/(?:本名|姓名|代号)\s*[:：]\s*([^\n]+)/g)) {
      for (const part of match[1].split(/[/／、]/)) {
        const full = part.trim().replace(/[（(].*$/, '');
        for (const name of [full, ...(full.includes('·') ? [full.split('·')[0]] : [])]) {
          if (!name || name.length < 2 || /^(?:未知|无|不明|殿下|魔王|姐姐|哥哥|博士)$/.test(name)) continue;
          const key = norm(name), list = explicitNames.get(key) || new Set(); list.add(actor); explicitNames.set(key, list);
        }
      }
    }
  }
  for (const [name, matches] of explicitNames) if (matches.size === 1) {
    const actor = [...matches][0]; if (!actor.aliases.includes(name)) actor.aliases.push(name); known.set(name, actor);
  }
  const replacements = {};
  for (const actor of actors.filter(a => !a.states?.length)) {
    const target = known.get(norm(actor.canonical_name));
    if (target && target !== actor && target.states?.length) {
      replacements[actor.actor_id] = target.actor_id;
      for (const p of actor.profile_variants || []) {
        target.profile_variants ||= [];
        if (!target.profile_variants.some(t => t.entry_id === p.entry_id && t.story_id === p.story_id)) target.profile_variants.push(p);
      }
      for (const r of raw.profile_registry.records.filter(r => r.actor_id === actor.actor_id)) { r.actor_id = target.actor_id; r.canonical_name = target.canonical_name; }
      actor.profile_variants = [];
    }
  }
  const nodes = new Map(raw.corpus.nodes.map(n => [n.scene_id || 'scene:' + n.node_id, n]));
  const storyById = new Map(raw.catalog.stories.map(s => [s.story_id, s]));
  const sceneAnchors = [], report = { stories: [], aliases_linked: Object.keys(replacements).length, speaker_links: 0 };
  const mainEarly = new Set(['主线第一至第五章', '黑暗时代·上', '黑暗时代·下', '异卵同生', '二次呼吸', '急性衰竭', '靶向药物', '局部坏死', '苦难摇篮']);
  const policies = {};
  for (const story of raw.catalog.stories) {
    const policy = { ...(STORY_STATES[story.title] || {}) };
    if (mainEarly.has(story.title)) Object.assign(policy, { '塔露拉': '黑蛇', '阿米娅': '本格', '临光': '本格', 'W／维什戴尔': '本格', '爱国者': '本格', '霜星': '本格' });
    if (story.title === '怒号光明') Object.assign(policy, { '阿米娅': '本格' });
    policies[story.story_id] = {};
    for (const [name, label] of Object.entries(policy)) {
      const actor = known.get(norm(name)), state = actor?.states.find(s => s.label === label);
      if (!actor || !state) throw Error('Invalid story-state mapping: ' + story.title + '/' + name + '/' + label);
      policies[story.story_id][actor.actor_id] = { state_entry_id: state.entry_id, label, basis: '篇章身份上下文：' + story.title, evidence_level: 'story_context', allow_date_transitions: false };
    }
  }
  for (const scene of raw.scenes.scenes) {
    scene.focus_actor_ids = [...new Set((scene.focus_actor_ids || []).map(id => replacements[id] || id))];
    const node = nodes.get(scene.scene_id); if (!node) continue;
    const stateHits = new Map();
    for (const speaker of node.speakers || []) {
      const actor = known.get(norm(speaker));
      if (actor && !scene.focus_actor_ids.includes(actor.actor_id)) { scene.focus_actor_ids.push(actor.actor_id); report.speaker_links++; }
      const candidates = aliasMap.get(norm(speaker)) || [];
      if (candidates.length === 1) {
        const hit = candidates[0];
        // The unqualified base name is neutral; a distinct alter/child name is evidence.
        if (hit.state.entry_id !== hit.actor.timeline_default_entry &&
          (hit.state.label !== '本格' || norm(stem(hit.state.entry_name)) !== norm(hit.actor.canonical_name))) stateHits.set(hit.actor.actor_id, hit);
      }
    }
    for (const [actorId, hit] of stateHits) sceneAnchors.push({ actor_id: actorId, scene_id: scene.scene_id,
      state_entry_id: hit.state.entry_id, label: hit.state.label, basis: '本幕明确出场名：' + stem(hit.state.entry_name),
      source_locator: node.source_locator, evidence_level: 'explicit_speaker_alias', allow_date_transitions: false });
    if (storyById.get(node.story_id)?.title === '怒号光明') {
      // Existing verified original-node bindings: AM3 draws the sword, AM5 releases control.
      const number = /^AM(\d+)$/.exec(node.node_code || '');
      if (number && Number(number[1]) > 3) sceneAnchors.push({ actor_id: 'char_368', scene_id: scene.scene_id,
        state_entry_id: 929, label: '近卫', basis: 'AM3 原文“阿米娅握紧了剑柄（魔王升变）”之后的本线节点',
        source_locator: node.source_locator, evidence_level: 'verified_node_boundary', allow_date_transitions: false });
      if (number && Number(number[1]) > 5) sceneAnchors.push({ actor_id: 'char_588', scene_id: scene.scene_id,
        state_entry_id: 39, label: '斗士', control_state: 'free', basis: 'AM5 解除黑蛇控制之后，使用非控制成年过渡档案',
        source_locator: node.source_locator, evidence_level: 'verified_node_boundary', allow_date_transitions: false });
      if ((node.speakers || []).includes('黑蛇')) {
        const aliasId = known.get(norm('黑蛇'))?.actor_id;
        if (aliasId) scene.focus_actor_ids = scene.focus_actor_ids.filter(id => id !== aliasId);
        if (!scene.focus_actor_ids.includes('char_588')) scene.focus_actor_ids.push('char_588');
      }
    }
  }
  for (const route of raw.routes.routes) route.focus_actor_ids = [...new Set((route.focus_actor_ids || []).map(id => replacements[id] || id))];
  // Never auto-select the player's gender/species preference from a story date.
  const choices = actors.filter(a => a.dimension === 'identity_choice').map(a => a.actor_id);
  const reset = baseEntries.map(e => ({ uid: e.uid ?? e.id, enabled: typeof e.disable === 'boolean' ? !e.disable : e.enabled !== false,
    type: e.constant ? 'constant' : e.extensions?.vectorized ? 'vectorized' : 'selective' }));
  for (const uid of Object.values(raw.route_guide_uids)) reset.push({ uid, enabled: false, type: 'selective' });
  for (const e of importedEntries) reset.push({ uid: e.uid, enabled: false, type: 'selective' });
  const maxUid = Math.max(...baseEntries.map(e => e.uid ?? e.id)); reset.push({ uid: maxUid + 1, enabled: true, type: 'constant' });
  raw.worldbook_binding = { schema: 1, physical: true, story_states: policies, scene_anchors: sceneAnchors,
    preserve_choice_actor_ids: choices, reset_baseline: reset, actor_aliases: replacements,
    state_policy: 'memory_node > explicit_scene > explicit_story > source_suffix > date_event > conservative_base; player_choices_preserved' };
  for (const story of raw.catalog.stories) {
    const routes = raw.routes.routes.filter(r => r.story_id === story.story_id), cast = new Set();
    for (const r of routes) for (const sid of r.ordered_scene_ids) for (const id of raw.scenes.scenes.find(s => s.scene_id === sid)?.focus_actor_ids || []) cast.add(id);
    const scoped = [...cast].map(id => actors.find(a => a.actor_id === id)).filter(Boolean);
    report.stories.push({ story_id: story.story_id, title: story.title, routes: routes.length,
      scenes: new Set(routes.flatMap(r => r.ordered_scene_ids)).size, entry_actors: scoped.filter(a => a.states?.length || a.profile_variants?.length).length,
      multistate_actors: scoped.filter(a => a.states?.length > 1).map(a => a.canonical_name),
      speakers_without_independent_entry: scoped.filter(a => !a.states?.length && !a.profile_variants?.length).map(a => a.canonical_name) });
  }
  report.actors_with_entries = actors.filter(a => a.states?.length).length;
  report.multistate_actors = actors.filter(a => a.states?.length > 1).length;
  report.scene_alias_anchors = sceneAnchors.length; report.reset_entries = reset.length;
  return report;
}
module.exports = { compileBindings, STORY_STATES };
