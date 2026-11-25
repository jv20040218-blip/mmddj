// 世界事件：账本去重(branch_id+event_id)、依赖与到期/完成双入口结算、提前发生取消旧排期。
// 纪事显示：有新事件更新；无新事件原样沿用上一条文字与原发生时间(is_repeated=true)。
'use strict';

const T = require('./time');
const S = require('./state');

function eventText(ev) { return ev.kind === 'background' ? (ev.text || ev.title) : (ev.title || ev.text || ev.event_id); }

// 事件适用当前分支与场景：世界/background事件恒适用；key事件需story匹配或无story限制。
function eventApplicable(ev, routeStoryId) {
  if (ev.kind === 'background') return true;
  if (!ev.story_id) return true;
  return ev.story_id === routeStoryId;
}

// 结算本轮到期/完成的事件。返回新结算列表。已结算事件不重复执行effects（V02/V07/V11）。
function settleEvents(state, ctx) {
  const events = ctx.events || [];
  const sceneTime = ctx.scene_time;
  const turnResults = (ctx.turnResult && ctx.turnResult.event_results) || [];
  const resultMap = {};
  for (const r of turnResults) resultMap[r.event_id] = r;
  const newly = [];
  for (const ev of events) {
    if (ev.kind !== 'key') continue;
    const key = S.ledgerKey(state.branch_id, ev.event_id);
    if (state.event_ledger[key]) continue; // 去重：已结算不再触发
    // 前置：所有 prerequisite_event_ids 已结算
    const prereqs = ev.prerequisite_event_ids || [];
    if (!prereqs.every(pid => state.event_ledger[S.ledgerKey(state.branch_id, pid)])) continue;
    const scheduledOrd = ev.scheduled_ordinal != null ? ev.scheduled_ordinal : T.dateToTriggerOrdinal(ev.canonical_window && ev.canonical_window.date_label, ev.canonical_window && ev.canonical_window.precision, ev.canonical_window && ev.canonical_window.calendar_id);
    const tr = resultMap[ev.event_id];
    const completed = tr && (tr.result === 'completed' || tr.result === 'achieved' || tr.result === 'occurred');
    const dateReached = scheduledOrd != null && sceneTime && sceneTime.ordinal_minute != null && sceneTime.ordinal_minute >= scheduledOrd;
    const policy = ev.trigger_policy || 'date_or_achieved_event_once';
    let trigger = null;
    if (policy === 'date_or_achieved_event_once') { if (completed) trigger = 'completion'; else if (dateReached) trigger = 'date'; }
    else if (policy === 'completion_only') { if (completed) trigger = 'completion'; }
    else if (policy === 'date_only') { if (dateReached) trigger = 'date'; }
    if (!trigger) continue;
    // 实际发生时间：完成入口用当前场景时间（可提前）；到期入口用来源排期时间。
    const occurredOrd = trigger === 'completion' ? (sceneTime ? sceneTime.ordinal_minute : scheduledOrd) : scheduledOrd;
    const early = scheduledOrd != null && occurredOrd != null && occurredOrd < scheduledOrd;
    const entry = {
      event_id: ev.event_id, branch_id: state.branch_id,
      occurred_at: T.makeTime(occurredOrd, sceneTime && sceneTime.calendar_id),
      scheduled_at: T.makeTime(scheduledOrd, ev.canonical_window && ev.canonical_window.calendar_id),
      result: (tr && tr.result) || (trigger === 'date' ? 'occurred' : 'completed'),
      trigger, early, settled_in_turn: ctx.turn_id || null,
      effect_applied: false
    };
    state.event_ledger[key] = entry;
    applyEffect(state, ev, entry);
    entry.effect_applied = true;
    newly.push({ event: ev, ledger: entry });
  }
  return newly;
}

// 执行事件效果到本作用域facts；只执行一次（由settleEvents去重保证）。
// v3：能力/生存/控制/标志均记录发生时间来源，供早期篇章投影时排除未来事实；
//     control 维度是独立事实（解除黑蛇控制≠加入新整合运动）。
function applyEffect(state, ev, entry) {
  if (!state.facts.events) state.facts.events = {};
  state.facts.events[ev.event_id] = { occurred_at: entry.occurred_at, result: entry.result, early: entry.early };
  const eff = ev.proposed_effect;
  if (eff && ev.actor_ids && ev.actor_ids.length) {
    if (!state.facts.actor_effects) state.facts.actor_effects = {};
    for (const aid of ev.actor_ids) {
      if (!state.facts.actor_effects[aid]) state.facts.actor_effects[aid] = { capabilities: [], availability: null, flags: [], capability_sources: [], availability_history: [], control_history: [], flag_sources: [] };
      const ae = state.facts.actor_effects[aid];
      if (!ae.capability_sources) ae.capability_sources = [];
      if (!ae.availability_history) ae.availability_history = [];
      if (!ae.control_history) ae.control_history = [];
      if (!ae.flag_sources) ae.flag_sources = [];
      if (eff.dimension === 'capabilities' && eff.operation === 'add' && !ae.capabilities.includes(eff.value)) {
        ae.capabilities.push(eff.value);
        ae.capability_sources.push({ value: eff.value, occurred_at: entry.occurred_at, event_id: ev.event_id });
      }
      if (eff.dimension === 'availability') {
        ae.availability = eff.value;
        ae.availability_history.push({ value: eff.value, occurred_at: entry.occurred_at, event_id: ev.event_id });
      }
      if (eff.dimension === 'control') {
        ae.control = eff.value;
        ae.control_history.push({ value: eff.value, occurred_at: entry.occurred_at, event_id: ev.event_id });
      }
      if (eff.dimension === 'flag' && !ae.flags.includes(eff.value)) {
        ae.flags.push(eff.value);
        ae.flag_sources.push({ value: eff.value, occurred_at: entry.occurred_at, event_id: ev.event_id });
      }
    }
  }
  // 转折候选：记录该人物转折已在本作用域达成（供resolveActorAtScene使用）。
  const tc = ev.transition_candidate;
  if (tc && ev.actor_ids && ev.actor_ids.length) {
    if (!state.facts.actor_transitions) state.facts.actor_transitions = {};
    for (const aid of ev.actor_ids) {
      state.facts.actor_transitions[aid] = { from_entry: tc.from_entry, to_entry: tc.to_entry, achieved_at: entry.occurred_at, event_id: ev.event_id, early: entry.early, story_id: ev.story_id || null };
    }
  }
}

// 背景世界事件按来源时间自然发生（无effects），进入纪事候选。未知/相对日期不结算（不造精确时间）。
function settleBackground(state, ctx) {
  const events = ctx.events || [];
  const sceneTime = ctx.scene_time;
  if (!sceneTime || sceneTime.ordinal_minute == null) return [];
  const newly = [];
  for (const ev of events) {
    if (ev.kind !== 'background') continue;
    const key = S.ledgerKey(state.branch_id, ev.event_id);
    if (state.event_ledger[key]) continue;
    const cw = ev.canonical_window || {};
    const ord = T.dateToOrdinal(cw.date_label, cw.precision, cw.calendar_id);
    if (ord == null || ord > sceneTime.ordinal_minute) continue;
    state.event_ledger[key] = { event_id: ev.event_id, branch_id: state.branch_id, occurred_at: T.makeTime(ord, cw.calendar_id), scheduled_at: T.makeTime(ord, cw.calendar_id), result: 'occurred', trigger: 'date', early: false, settled_in_turn: ctx.turn_id || null, effect_applied: false };
    newly.push(ev.event_id);
  }
  return newly;
}

// 纪事显示选择（V01/V02/V03）。返回 {event_id,text,occurred_at,selected_in_turn,is_repeated, others[]}。
function selectEventDisplay(state, ctx) {
  const events = ctx.events || [];
  const sceneTime = ctx.scene_time;
  const routeId = ctx.route_id;
  const routeStoryId = ctx.route_story_id || null;
  const rp = S.getRouteProgress(state, routeId);
  // 候选 = 已发生 AND 适用当前分支 AND 不晚于当前场景时间
  const candidates = [];
  for (const ev of events) {
    const led = state.event_ledger[S.ledgerKey(state.branch_id, ev.event_id)];
    if (!led) continue;
    if (!eventApplicable(ev, routeStoryId)) continue;
    if (sceneTime && led.occurred_at && led.occurred_at.ordinal_minute != null && sceneTime.ordinal_minute != null && led.occurred_at.ordinal_minute > sceneTime.ordinal_minute) continue;
    candidates.push({ ev, led });
  }
  const importance = c => (c.ev.kind === 'key' ? 2 : 1) + (c.ev.story_id && c.ev.story_id === routeStoryId ? 1 : 0);
  const sortPick = arr => arr.slice().sort((a, b) => (importance(b) - importance(a)) || (T.compareTime(b.led.occurred_at, a.led.occurred_at)));
  const displayed = new Set(rp.displayed_event_ids);
  const fresh = candidates.filter(c => !displayed.has(c.ev.event_id));
  let chosen, isRepeated = false;
  if (fresh.length) {
    chosen = sortPick(fresh)[0];
    // 本轮所有新事件都已播报（主事件＋可展开其他），下一轮无新事件时沿用主事件。
    for (const c of fresh) if (!rp.displayed_event_ids.includes(c.ev.event_id)) rp.displayed_event_ids.push(c.ev.event_id);
  } else if (rp.last_event_display) {
    // 无新事件：原样沿用文字与原发生时间
    const prev = rp.last_event_display;
    const stillValid = candidates.find(c => c.ev.event_id === prev.event_id);
    const disp = { event_id: prev.event_id, text: prev.text, occurred_at: prev.occurred_at, selected_in_turn: ctx.turn_id || prev.selected_in_turn, is_repeated: true, others: [] };
    rp.last_event_display = disp; state.last_event_display = disp;
    return disp;
  } else {
    // 首次进入且无历史：取当前场景之前最近适用事件
    chosen = candidates.length ? sortPick(candidates)[0] : null;
  }
  let disp;
  if (chosen) {
    disp = { event_id: chosen.ev.event_id, text: eventText(chosen.ev), occurred_at: chosen.led.occurred_at, selected_in_turn: ctx.turn_id || null, is_repeated: false, others: sortPick(candidates.filter(c => c !== chosen)).slice(0, 5).map(c => ({ event_id: c.ev.event_id, text: eventText(c.ev), occurred_at: c.led.occurred_at })) };
    rp.displayed_event_ids.includes(chosen.ev.event_id) || rp.displayed_event_ids.push(chosen.ev.event_id);
  } else {
    disp = { event_id: null, text: '暂无已记录事件', occurred_at: null, selected_in_turn: ctx.turn_id || null, is_repeated: false, others: [] };
  }
  rp.last_event_display = disp;
  state.last_event_display = disp;
  return disp;
}

const api = { eventText, eventApplicable, settleEvents, settleBackground, applyEffect, selectEventDisplay };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_EVENTS__ = api; }

