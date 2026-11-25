// 人物解析：按场景时点投影状态（不拿最新档案直接复制）；立绘按当前形态/身份匹配，缺图明确占位。
// v3：入口/节点状态锚点优先；控制状态作为独立事实（解除控制≠加入新整合运动）；
// 节点触发独立于绝对日期（当前作用域内已达成的转折在未知日期场景也生效）；
// 能力/生存/控制事实按发生时间投影，不把未来事实带回早期篇章；
// 立绘先排除身份/时期冲突再排序，无匹配不任取该人物未来形象。
'use strict';

const T = require('./time');

// 状态标签 → 立绘变体 的规范映射（本格=默认形象）。
const LABEL_TO_VARIANT = { '本格': '默认', '简略本格': '默认', '默认': '默认' };
function variantForLabel(label) { return LABEL_TO_VARIANT[label] || label; }

// 事实时间投影：ord 已知→只取 occurred_at<=ord；ord 未知→只取无绝对时间的事实（作用域已隔离）。
function effectApplicable(occurredAt, ord) {
  const o = occurredAt && occurredAt.ordinal_minute;
  if (o == null) return true;
  if (ord == null) return false;
  return o <= ord;
}

// 投影 actor_effects：兼容旧格式（无时间来源的纯数组/标量，原样应用）与新格式（带来源时间）。
function projectEffects(ae, ord) {
  const empty = { capabilities: [], availability: null, control: null, flags: [] };
  if (!ae) return empty;
  const out = { capabilities: [], availability: null, control: null, flags: [] };
  if (Array.isArray(ae.capability_sources)) {
    out.capabilities = ae.capability_sources.filter(s => effectApplicable(s.occurred_at, ord)).map(s => s.value);
  } else {
    out.capabilities = (ae.capabilities || []).slice(); // legacy
  }
  if (Array.isArray(ae.availability_history)) {
    const applicable = ae.availability_history.filter(s => effectApplicable(s.occurred_at, ord));
    out.availability = applicable.length ? applicable[applicable.length - 1].value : null;
  } else {
    out.availability = ae.availability != null ? ae.availability : null; // legacy
  }
  if (Array.isArray(ae.control_history)) {
    const applicable = ae.control_history.filter(s => effectApplicable(s.occurred_at, ord));
    out.control = applicable.length ? applicable[applicable.length - 1].value : null;
  } else {
    out.control = ae.control != null ? ae.control : null;
  }
  if (Array.isArray(ae.flag_sources)) {
    out.flags = ae.flag_sources.filter(s => effectApplicable(s.occurred_at, ord)).map(s => s.value);
  } else {
    out.flags = (ae.flags || []).slice();
  }
  return out;
}

// 计算某人物在场景时点的状态。facts 为本作用域事实；按锚点→已达成转折→日期规则→保守默认投影。
function resolveActorAtScene(actorId, sceneContext, facts, data) {
  const actor = data.actorById[actorId];
  const sceneTime = sceneContext && sceneContext.scene_time;
  const ord = sceneTime && sceneTime.ordinal_minute;
  const f = facts || {};
  const storyId = sceneContext && sceneContext.story_id;
  const profiles = actor && (actor.profile_variants || []).filter(p => p.story_id === storyId) || [];
  const anchor = ((sceneContext && sceneContext.anchors) || {})[actorId] || null;
  // 来源后缀只在本篇适用；明确场景/回忆时期锚点优先，不跨篇携带档案。
  const anchoredEntry = anchor && anchor.state_entry_id;
  const profile = profiles.find(p => p.state_entry_id != null && p.state_entry_id === anchoredEntry)
    || profiles.find(p => p.state_entry_id == null)
    || (anchoredEntry == null ? profiles[0] : null);
  const profileFields = { profile_entry_id: profile ? profile.entry_id : null,
    profile_label: profile ? profile.label : null,
    profile_source: profile ? profile.source_entry_id : null };
  if (data.worldbook_binding && actor && actor.dimension === 'identity_choice' && !anchor) {
    return { actor_id: actorId, canonical_name: actor.canonical_name, entry_id: null, label: '沿用开局选择',
      state_source: 'player_choice', applied_transitions: [], capabilities: [], availability: null,
      control_state: null, profile_excerpt: null, exists_in_card: true, preserve_opening_choice: true, ...profileFields };
  }
  if (!actor || actor.dimension === 'none' || !actor.states || !actor.states.length) {
    // 出场说话人/未建状态机：占位状态，不编造档案。
    const name = actor ? actor.canonical_name : (data.nameIndex && Object.keys(data.nameIndex).find(k => data.nameIndex[k] === actorId)) || actorId;
    return { actor_id: actorId, canonical_name: name, entry_id: profile ? profile.entry_id : null, label: profile ? profile.label : '出场', state_source: profile ? 'story_profile' : 'speaker_only', applied_transitions: [], capabilities: [], availability: null, control_state: null, profile_excerpt: null, exists_in_card: !!profile, ...profileFields };
  }
  const baseEntry = data.worldbook_binding && actor.timeline_default_entry != null ? actor.timeline_default_entry : actor.default_entry;
  let current = anchor && anchor.state_entry_id != null ? anchor.state_entry_id : (baseEntry != null ? baseEntry : (actor.states[0] && actor.states[0].entry_id));
  if (anchoredEntry == null && profile && profile.state_entry_id != null) current = profile.state_entry_id;
  let controlState = anchor && anchor.control_state != null ? anchor.control_state : null;
  const applied = [];
  if (anchoredEntry == null && profile && profile.state_entry_id != null) applied.push({ transition_id: profile.source_entry_id, to_entry: current, via: 'explicit_source_suffix' });
  if (anchor) applied.push({ transition_id: 'anchor:' + (anchor.anchor_id || 'entry'), to_entry: current, via: 'anchor', basis: anchor.basis || null });
  const candidate = f.actor_transitions && f.actor_transitions[actorId];
  function eventWithinScene(eventId) {
    if (!data.worldbook_binding || !sceneContext || !sceneContext.scene_id) return true;
    const event = data.eventById && data.eventById[eventId], binding = event && event.node_binding;
    if (!binding || event.story_id !== storyId) return true;
    const boundary = 'scene:' + binding.segment_id, target = sceneContext.scene_id;
    const route = data.routes.find(r => r.story_id === storyId && r.ordered_scene_ids.includes(boundary) && r.ordered_scene_ids.includes(target));
    if (!route) return true;
    const eventIndex = route.ordered_scene_ids.indexOf(boundary), targetIndex = route.ordered_scene_ids.indexOf(target);
    return targetIndex > eventIndex || targetIndex === eventIndex && !sceneContext.entering;
  }
  const achieved = candidate && (!candidate.story_id || !storyId || candidate.story_id === storyId) && eventWithinScene(candidate.event_id) ? candidate : null;
  // 未知日期场景：当前作用域内已达成的转折按因果生效（作用域隔离保证不跨阶段）；
  // 已知日期场景：仅 achieved_at<=场景时间 的转折生效（未来事实不回带）。
  const atOrBefore = (t) => {
    if (!t || t.ordinal_minute == null) return true;
    if (ord == null) return true;
    return t.ordinal_minute <= ord;
  };
  const controlRules = (data && data.controlTransitions) || [];
  const applyControlRelease = (fromEntry, via, eventId) => {
    controlState = 'free';
    const rule = controlRules.find(c => c.actor_id === actorId && c.from_entry === fromEntry);
    if (rule && rule.transitional_entry_id != null) {
      current = rule.transitional_entry_id;
      applied.push({ transition_id: 'control:' + (rule.event_id || eventId || fromEntry), to_entry: rule.transitional_entry_id, via: 'control_transition', control_state: 'free', note: rule.basis || '解除控制只改变控制状态；过渡档案，不等同加入新整合运动', evidence_level: rule.evidence_level || null });
    } else {
      applied.push({ transition_id: 'control:' + (eventId || fromEntry), to_entry: null, via, control_state: 'free', note: '控制状态独立事实：不切换人格条目' });
    }
  };
  // 依转换规则推进：日期到期 或 本作用域已达成事件（任一入口，_once）。
  for (const tr of (actor.transitions || [])) {
    if (tr.from_entry !== current) continue;
    const trOrd = T.dateToTriggerOrdinal(tr.date, tr.precision);
    const dateReached = (!anchor || anchor.allow_date_transitions === true) && trOrd != null && ord != null && ord >= trOrd;
    const eventAchieved = achieved && achieved.to_entry === tr.to_entry && atOrBefore(achieved.achieved_at);
    const policy = tr.trigger_policy || 'date_or_achieved_event_once';
    let fire = false;
    if (policy === 'date_or_achieved_event_once') fire = dateReached || eventAchieved;
    else if (policy === 'date_only') fire = dateReached;
    else if (policy === 'completion_only') fire = eventAchieved;
    if (fire) {
      if (tr.to_entry == null) { applyControlRelease(current, eventAchieved ? 'event' : 'date', achieved && achieved.event_id); continue; }
      current = tr.to_entry;
      applied.push({ transition_id: tr.transition_id, to_entry: tr.to_entry, via: eventAchieved ? 'event' : 'date', early: !!(achieved && achieved.early) });
    }
  }
  // 事件达成的转折（即使actor.transitions未列）也按事实投影。
  if (achieved && atOrBefore(achieved.achieved_at) && current === achieved.from_entry) {
    if (achieved.to_entry == null) {
      applyControlRelease(current, 'event', achieved.event_id);
    } else {
      current = achieved.to_entry;
      applied.push({ transition_id: 'fact:' + achieved.event_id, to_entry: achieved.to_entry, via: 'event', early: !!achieved.early });
    }
  }
  const st = actor.states.find(s => s.entry_id === current) || actor.states[0];
  let actorEffects = f.actor_effects && f.actor_effects[actorId];
  if (actorEffects && data.worldbook_binding) {
    actorEffects = { ...actorEffects };
    for (const key of ['capability_sources', 'availability_history', 'control_history', 'flag_sources'])
      if (Array.isArray(actorEffects[key])) actorEffects[key] = actorEffects[key].filter(s => !s.event_id || eventWithinScene(s.event_id));
  }
  const ae = projectEffects(actorEffects, ord);
  // 控制事实优先于锚点初始值（事件结算后更新）。
  if (ae.control != null) controlState = ae.control;
  return {
    actor_id: actorId, canonical_name: actor.canonical_name,
    entry_id: st ? st.entry_id : current, label: st ? st.label : '默认',
    state_source: applied.length ? (anchor ? 'anchored_projected' : 'projected') : 'default',
    applied_transitions: applied,
    capabilities: ae.capabilities || [], availability: ae.availability, control_state: controlState, flags: ae.flags || [],
    profile_excerpt: st ? st.profile_excerpt : null,
    exists_in_card: st ? st.exists_in_card : false,
    all_transition_dates_verified: actor.all_transition_dates_verified
    , ...profileFields
  };
}

// 立绘选择：先排除身份/时期冲突，再按 形态匹配→默认形象→通用形象 排序；无匹配明确占位。
// 表情差分不改变人物身份；精英二不自动意味着故事未来状态；时期标签无交集的资产不参与当前时期。
function portraitPeriodConflict(p, periodTags) {
  const pt = (p.applicability && p.applicability.period_tags) || p.period_tags || null;
  if (!pt || !pt.length) return false; // 未标注时期的通用资产不构成冲突
  const category = t => t === 'npc_story' || t === 'operator_story';
  const specific = pt.filter(t => !category(t));
  const inScene = (periodTags || []).filter(t => !category(t));
  if (!specific.length) return false;
  return !specific.some(t => inScene.includes(t));
}

function resolvePortrait(actorId, actorState, sceneContext, data) {
  const list = (data.portraitsByActor && data.portraitsByActor[actorId]) || [];
  const label = actorState && actorState.label;
  const wantVariant = variantForLabel(label) || '默认';
  const actor = data.actorById[actorId];
  const requiresForm = wantVariant && wantVariant !== '默认' && (
    (actor?.states || []).some(s => s.label === label) && actor.states.length > 1
    || list.some(p => p.variant === wantVariant)
  );
  const name = (actorState && actorState.canonical_name) || actorId;
  const periodLabel = (sceneContext && sceneContext.period_label) || null;
  const periodTags = (sceneContext && sceneContext.period_tags) || [];
  const usable = list.filter(p => /^https:\/\//i.test(p.image_url || '') && p.asset_kind !== 'expression');
  const eligible = usable.filter(p => !portraitPeriodConflict(p, periodTags));
  const sort = (arr) => arr.slice().sort((a, b) => {
    const ap = p => p.applicability || {};
    const tags = p => (ap(p).period_tags) || p.period_tags || [];
    const kindRank = p => ap(p).kind === '立绘' ? 0 : ap(p).kind === '头像' ? 1 : 2;
    const npcStoryRank = p => tags(p).includes('npc_story') ? 0 : 1; // NPC剧情立绘优先于干员立绘/头像
    const eliteRank = p => ap(p).elite_stage === '精英2' ? 1 : 0; // 不默认最高精英阶段
    const periodRank = p => tags(p).some(tag => periodTags.includes(tag)) ? 0 : 1;
    return (periodRank(a) - periodRank(b)) || (kindRank(a) - kindRank(b)) || (npcStoryRank(a) - npcStoryRank(b)) || (eliteRank(a) - eliteRank(b)) || ((a.confidence === 'high' ? 0 : 1) - (b.confidence === 'high' ? 0 : 1));
  });
  let candidates = sort(eligible.filter(p => p.variant === wantVariant));
  if (!candidates.length && !requiresForm) candidates = sort(eligible.filter(p => p.variant === '默认'));
  const match = candidates[0];
  if (match) {
    return { asset_id: match.asset_id, actor_id: actorId, image_url: match.image_url,
      fallback_urls: [...new Set(candidates.map(item => item.image_url))].slice(1, 3),
      variant: match.variant, requested_variant: wantVariant, source_ref: match.source_ref, file_page: match.file_page,
      confidence: match.confidence, fallback_reason: match.variant === wantVariant ? null : 'variant_fallback', placeholder: false,
      period_label: periodLabel, asset_kind: match.asset_kind || null, period_tags: (match.applicability && match.applicability.period_tags) || match.period_tags || null };
  }
  const excluded = usable.length - eligible.length;
  return { asset_id: null, actor_id: actorId, image_url: null, variant: null, requested_variant: wantVariant, source_ref: null, confidence: null, fallback_reason: excluded > 0 ? 'period_conflict_excluded' : (list.length ? 'no_variant_match' : 'no_portrait_asset'), placeholder: true, placeholder_name: name, period_label: periodLabel };
}

const api = { LABEL_TO_VARIANT, variantForLabel, resolveActorAtScene, resolvePortrait, projectEffects, portraitPeriodConflict };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_ACTORS__ = api; }
