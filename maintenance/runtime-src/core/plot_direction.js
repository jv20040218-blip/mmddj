// 按存档修订后续剧情：夹在软演出和手动硬回正之间。
// 设计 API 只返回建议；游标、楼层和路线仍由本线运行时掌管。
// 本模块不发起网络请求，也不读取接口凭据。
'use strict';

const S = require('./state');

const SOFT_KINDS = new Set(['dialogue', 'reorder', 'detour_same_result', 'soft']);
const HARD_KINDS = new Set(['premise', 'endpoint', 'completion', 'sideline_pause', 'sideline_close']);
const PROFILE_FIELDS = ['经历', '人际关系', '特点', '备注'];
const RETRY_RE = /再次|重新|又一次|下一次|下一幕再|另一次/;
const FUTURE_PROFILE_RE = /下一幕|将来会|未来会|将要加入|尚未发生/;

function ensure(state) {
  if (!state.plot_direction || typeof state.plot_direction !== 'object') {
    state.plot_direction = {
      facts: {},
      fact_order: [],
      revisions: [],
      future_summaries: {},
      excluded_entries: {},
      inapplicable_nodes: {},
      completion_overrides: {},
      sidelines: {},
      handled_fact_ids: [],
      pending: null,
      ordered_nodes: [],
      next_playable: null,
      warnings: []
    };
  }
  const pd = state.plot_direction;
  if (!pd.facts) pd.facts = {};
  if (!Array.isArray(pd.fact_order)) pd.fact_order = [];
  if (!Array.isArray(pd.revisions)) pd.revisions = [];
  if (!pd.future_summaries) pd.future_summaries = {};
  if (!pd.excluded_entries) pd.excluded_entries = {};
  if (!pd.inapplicable_nodes) pd.inapplicable_nodes = {};
  if (!pd.completion_overrides) pd.completion_overrides = {};
  if (!pd.sidelines) pd.sidelines = {};
  if (!Array.isArray(pd.handled_fact_ids)) pd.handled_fact_ids = [];
  if (!Array.isArray(pd.ordered_nodes)) pd.ordered_nodes = [];
  if (!Array.isArray(pd.warnings)) pd.warnings = [];
  return pd;
}

function stableFactId(text, routeId, sceneId) {
  const s = String(routeId || '') + '|' + String(sceneId || '') + '|' + String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'fact_' + (h >>> 0).toString(16);
}

function segmentKeyOf(state, routeId, sceneId, segmentIndex) {
  const branch = (state && state.branch_id) || 'branch_1';
  const seg = segmentIndex == null ? 0 : segmentIndex;
  return branch + '|' + routeId + '|' + sceneId + '|' + seg;
}

function currentSegmentIndex(state, routeId) {
  const p = state && state.corpus_progress && state.corpus_progress[routeId];
  return p && p.segment_index != null ? p.segment_index : 0;
}

function factIds(state) {
  const pd = state && state.plot_direction;
  if (!pd || !pd.facts) return [];
  return Object.keys(pd.facts);
}

function reintroducesVoidedPremise(text, facts) {
  const t = String(text || '');
  if (!t || !RETRY_RE.test(t)) return false;
  for (const fact of facts || []) {
    const phrases = [].concat(fact.contradicts || [], fact.voids || []);
    for (const phrase of phrases) {
      const p = String(phrase || '');
      if (p.length >= 2 && t.includes(p)) return true;
    }
  }
  return false;
}

function isFutureProfileText(text, summaries, facts) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (reintroducesVoidedPremise(t, facts) || FUTURE_PROFILE_RE.test(t)) return true;
  for (const sum of summaries || []) {
    const s = String((sum && sum.summary) || '').trim();
    if (s.length >= 8 && t.includes(s)) return true;
  }
  return false;
}

function candidateText(item) {
  if (!item) return '';
  return [item.summary, item.content, item.completion, item.text, item.premise].filter(Boolean).join('\n');
}

function conflictsWithFact(fact, item) {
  if (!fact || !item || item.timing === 'current') return false;
  const premises = [].concat(item.premise_facts || [], item.depends_on || [], item.premise ? [item.premise] : []);
  const voided = [].concat(fact.voids || [], fact.contradicts || [], fact.fact_id ? [fact.fact_id] : []);
  if (premises.some(p => p && voided.includes(p))) return true;
  const text = candidateText(item);
  for (const phrase of fact.contradicts || []) {
    if (phrase && String(phrase).length >= 2 && text.includes(phrase)) return true;
  }
  return false;
}

function screenCandidates(facts, summaries, entries, completions) {
  const blocks = [];
  const excluded = [];
  const seenNodes = new Set();
  const seenKeys = new Set();
  for (const fact of facts || []) {
    for (const sum of summaries || []) {
      if (!sum || !sum.node_id || seenNodes.has(sum.node_id)) continue;
      if (!conflictsWithFact(fact, sum)) continue;
      seenNodes.add(sum.node_id);
      const fragments = [sum.summary, sum.completion].concat(sum.hide_fragments || []).filter(v => v && String(v).length >= 4);
      blocks.push({
        node_id: sum.node_id,
        route_id: sum.route_id || fact.route_id || null,
        summary: '',
        completion: null,
        status: 'conflict_blocked',
        official_policy: 'hide',
        hide_fragments: fragments,
        fact_ids: [fact.fact_id]
      });
    }
    for (const entry of entries || []) {
      if (!entry || !conflictsWithFact(fact, entry)) continue;
      const key = entryKey(entry);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const fragments = [entry.content].concat(entry.fragments || []).filter(v => v && String(v).length >= 4);
      excluded.push({
        entry_id: entry.entry_id != null ? entry.entry_id : null,
        comment_pk: entry.comment_pk || '',
        character_id: entry.character_id || null,
        fragments,
        fact_ids: [fact.fact_id],
        key
      });
    }
    for (const comp of completions || []) {
      if (!comp || !comp.node_id || seenNodes.has(comp.node_id)) continue;
      if (!conflictsWithFact(fact, comp)) continue;
      seenNodes.add(comp.node_id);
      blocks.push({
        node_id: comp.node_id,
        summary: '',
        completion: null,
        status: 'conflict_blocked',
        official_policy: 'hide',
        hide_fragments: [comp.completion].filter(v => v && String(v).length >= 4),
        fact_ids: [fact.fact_id]
      });
    }
  }
  return { blocks, excluded };
}

function entryKey(entry) {
  if (!entry) return '';
  if (entry.comment_pk) return 'pk:' + entry.comment_pk;
  if (entry.entry_id != null) return 'id:' + entry.entry_id;
  return '';
}

function knownEntry(entry, keys) {
  return (keys || []).some(k => {
    if (!k || !entry) return false;
    if (entry.entry_id != null && k.entry_id != null && String(entry.entry_id) === String(k.entry_id)) return true;
    if (entry.comment_pk && k.comment_pk && String(entry.comment_pk) === String(k.comment_pk)) return true;
    return false;
  });
}

function allowedBrief(text, facts) {
  const t = String(text || '').trim();
  if (!t) return false;
  return (facts || []).some(f => {
    const fact = String((f && f.text) || '').trim();
    return fact && (fact === t || fact.includes(t) || t.includes(fact));
  });
}

function composeBrief(existing, factTexts, dropTexts, facts) {
  const drops = (dropTexts || []).map(t => String(t || '').trim()).filter(Boolean);
  const lines = []
    .concat(String(existing || '').split('\n'), factTexts || [])
    .map(s => String(s || '').trim())
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (drops.some(d => d && (line === d || line.includes(d)))) continue;
    if (reintroducesVoidedPremise(line, facts)) continue;
    if (!kept.includes(line)) kept.push(line);
  }
  return kept.join('\n');
}

function stripFragments(text, fragments) {
  let out = String(text || '');
  for (const frag of fragments || []) {
    const f = String(frag || '');
    if (f.length >= 4 && out.includes(f)) out = out.split(f).join('');
  }
  return out;
}

function collectHideFragments(pd) {
  const out = [];
  const push = frag => {
    const f = String(frag || '');
    if (f.length >= 4 && !out.includes(f)) out.push(f);
  };
  for (const sum of Object.values((pd && pd.future_summaries) || {})) {
    for (const frag of sum.hide_fragments || []) push(frag);
    if (sum.official_text) push(sum.official_text);
  }
  for (const ex of Object.values((pd && pd.excluded_entries) || {})) {
    for (const frag of ex.fragments || []) push(frag);
  }
  return out;
}

function normalizeFacts(signal, state) {
  const routeId = signal.route_id || (state.active_route && state.active_route.route_id) || null;
  const sceneId = signal.scene_id || (state.active_route && state.active_route.scene_id) || null;
  const seg = signal.segment_index != null ? signal.segment_index : currentSegmentIndex(state, routeId);
  const out = [];
  for (const raw of signal.facts || []) {
    if (!raw) continue;
    const text = String(raw.text || '').trim();
    const kind = raw.kind || 'premise';
    if (!text && !HARD_KINDS.has(kind)) continue;
    const fact_id = raw.fact_id || stableFactId(text || kind, routeId, sceneId);
    out.push({
      fact_id,
      text,
      kind,
      settled: raw.settled !== false,
      contradicts: [].concat(raw.contradicts || []),
      voids: [].concat(raw.voids || []),
      character_id: raw.character_id || null,
      route_id: raw.route_id || routeId,
      scene_id: raw.scene_id || sceneId,
      node_id: raw.node_id || signal.node_id || null,
      segment_index: raw.segment_index != null ? raw.segment_index : seg,
      segment_key: segmentKeyOf(state, raw.route_id || routeId, raw.scene_id || sceneId, raw.segment_index != null ? raw.segment_index : seg)
    });
  }
  return out;
}

function candidateBundle(signal) {
  const c = signal.candidates || {};
  return {
    summaries: c.summaries || signal.summaries || [],
    entries: c.entries || signal.entries || [],
    completions: c.completions || signal.completions || [],
    ordered_nodes: c.ordered_nodes || signal.ordered_nodes || []
  };
}

function applyBlocks(pd, blocks, excluded) {
  for (const block of blocks || []) {
    if (!block || !block.node_id) continue;
    const prev = pd.future_summaries[block.node_id];
    pd.future_summaries[block.node_id] = {
      node_id: block.node_id,
      route_id: block.route_id || (prev && prev.route_id) || null,
      summary: block.summary || '',
      completion: block.completion || null,
      status: block.status || 'conflict_blocked',
      official_policy: block.official_policy || 'hide',
      hide_fragments: block.hide_fragments || (prev && prev.hide_fragments) || [],
      fact_ids: block.fact_ids || (prev && prev.fact_ids) || []
    };
  }
  for (const ex of excluded || []) {
    if (!ex || !ex.key) continue;
    pd.excluded_entries[ex.key] = ex;
  }
}

function buildRequest(state, signal, facts, screened) {
  const bundle = candidateBundle(signal);
  const routeId = signal.route_id || (state.active_route && state.active_route.route_id);
  const nodeIds = [];
  const pushNode = id => { if (id && !nodeIds.includes(id)) nodeIds.push(id); };
  for (const row of bundle.summaries) pushNode(row && row.node_id);
  for (const row of bundle.completions) pushNode(row && row.node_id);
  for (const row of bundle.ordered_nodes) pushNode(row && row.node_id);
  if (signal.node_id) pushNode(signal.node_id);
  const sceneIds = [];
  for (const row of bundle.ordered_nodes) if (row && row.scene_id && !sceneIds.includes(row.scene_id)) sceneIds.push(row.scene_id);
  const rp = routeId ? S.getRouteProgress(state, routeId) : { brief: '' };
  return {
    chat_id: signal.chat_id || state.chat_id || null,
    route_id: routeId,
    scene_id: signal.scene_id || (state.active_route && state.active_route.scene_id) || null,
    node_id: signal.node_id || null,
    base_revision: signal.base_revision != null ? signal.base_revision : state.revision,
    segment_key: facts[0] ? facts[0].segment_key : null,
    settled_facts: facts,
    brief: rp.brief || '',
    node_ids: nodeIds,
    scene_ids: sceneIds,
    summaries: bundle.summaries,
    completions: bundle.completions,
    entry_keys: bundle.entries,
    ordered_nodes: bundle.ordered_nodes,
    sideline: signal.sideline || null,
    profiles: signal.profiles || [],
    local_exclusions: screened.excluded,
    local_blocks: screened.blocks,
    effective_actions: (signal && signal.effective_actions) || [],
    archive_version: (signal && signal.archive_version != null) ? signal.archive_version : null,
    character_archives: (signal && signal.character_archives) || {},
    required_characters: (signal && signal.required_characters) || [],
    protection: (signal && signal.protection) || null,
    manual_selection: (signal && signal.manual_selection) || null,
    call_design: true
  };
}

function signalFromTurn(before, after, turnResult) {
  if (!turnResult || !after || !after.active_route) return null;
  const progress = turnResult.progress || {};
  const explicit = Array.isArray(progress.plot_facts) ? progress.plot_facts : [];
  const events = Array.isArray(turnResult.event_results)
    ? turnResult.event_results.filter(e => e && (e.result === 'failed' || e.result === 'changed'))
    : [];
  const divergence = progress.divergence === true || progress.causal === true;
  const sideline = progress.sideline && progress.sideline.hook_broken ? progress.sideline : null;
  const messageKind = progress.message_kind || null;
  if (messageKind && SOFT_KINDS.has(messageKind) && !explicit.length && !sideline && !events.length && !divergence) return null;
  if (!explicit.length && !events.length && !divergence && !sideline) return null;
  const brief = typeof progress.brief === 'string' ? progress.brief : '';
  const routeId = turnResult.route_id || after.active_route.route_id;
  const beforeBrief = before && before.route_progress && before.route_progress[routeId]
    ? before.route_progress[routeId].brief || ''
    : '';
  if (!explicit.length && !sideline && !events.length && !divergence) return null;
  if (!explicit.length && events.length && !divergence && brief === beforeBrief && !brief) return null;
  const facts = explicit.length ? explicit : [{
    fact_id: progress.fact_id || null,
    text: brief,
    kind: progress.kind || (sideline ? 'sideline_pause' : 'premise'),
    contradicts: progress.contradicts || [],
    voids: progress.voids || [],
    settled: true,
    character_id: progress.character_id || null
  }];
  return {
    chat_id: after.chat_id,
    route_id: routeId,
    scene_id: turnResult.scene_id || after.active_route.scene_id,
    node_id: progress.node_id || turnResult.segment_node_id || null,
    base_revision: after.revision,
    message_kind: messageKind || 'causal',
    facts,
    candidates: progress.plot_candidates || null,
    sideline,
    segment_index: turnResult.segment_ack != null ? turnResult.segment_ack : null
  };
}

function consider(state, signal) {
  const s = signal || {};
  if (!state || !state.active_route && !s.route_id) {
    return { call_design: false, reasons: ['no_route'], request: null, excluded: [], facts: [] };
  }
  const pd = ensure(state);
  const facts = normalizeFacts(s, state);
  const bundle = candidateBundle(s);
  const fresh = facts.filter(f => f.fact_id && !pd.facts[f.fact_id] && !pd.handled_fact_ids.includes(f.fact_id));
  const known = facts.filter(f => f.fact_id && pd.facts[f.fact_id]);
  const screenFacts = fresh.length ? fresh : facts.filter(f => f.fact_id && pd.facts[f.fact_id]);
  const screened = screenCandidates(screenFacts, bundle.summaries, bundle.entries, bundle.completions);
  const hard = facts.filter(f => HARD_KINDS.has(f.kind));
  const soft = SOFT_KINDS.has(s.message_kind);
  const sideline = !!(s.sideline && s.sideline.hook_broken);
  const reasons = [];
  let call = false;
  let recordFacts = true;

  if (soft && !hard.length && !sideline && !screened.excluded.length && !screened.blocks.length) {
    reasons.push('soft_turn');
    recordFacts = false;
  } else if (!fresh.length && !sideline) {
    if (screened.excluded.length || screened.blocks.length) {
      applyBlocks(pd, screened.blocks, screened.excluded);
      reasons.push('fact_already_handled_local_exclude');
    } else {
      reasons.push(pd.pending ? 'already_pending' : 'already_handled');
    }
  } else if (hard.length || sideline || screened.excluded.length || screened.blocks.length) {
    call = true;
    if (hard.length) reasons.push('settled_fact');
    if (screened.excluded.length || screened.blocks.length) reasons.push('upcoming_conflict');
    if (sideline) reasons.push('sideline');
  } else {
    reasons.push('no_trigger');
  }

  if (recordFacts && fresh.length) {
    const routeId = s.route_id || state.active_route.route_id;
    const rp = S.getRouteProgress(state, routeId);
    const texts = fresh.map(f => f.text).filter(Boolean);
    rp.brief = composeBrief(rp.brief, texts, [], fresh);
    for (const fact of fresh) {
      pd.facts[fact.fact_id] = { ...fact, handled: false, at_revision: state.revision };
      if (!pd.fact_order.includes(fact.fact_id)) pd.fact_order.push(fact.fact_id);
    }
  }
  if (screened.excluded.length || screened.blocks.length) applyBlocks(pd, screened.blocks, screened.excluded);
  if (bundle.ordered_nodes.length) pd.ordered_nodes = bundle.ordered_nodes;

  const request = call ? buildRequest(state, s, fresh.length ? fresh : hard, screened) : null;
  if (call) {
    pd.pending = {
      request,
      fact_ids: (fresh.length ? fresh : hard).map(f => f.fact_id),
      at_revision: state.revision
    };
  }
  return {
    call_design: call,
    reasons,
    request,
    excluded: screened.excluded,
    blocks: screened.blocks,
    facts: fresh,
    repeated: !fresh.length && facts.length > 0
  };
}

function candidatesFromGuide(guide, currentNodeId) {
  if (!guide) return [];
  const acts = guide.acts || [];
  const briefs = guide.act_briefs || [];
  const idx = currentNodeId ? acts.findIndex(a => a.node_id === currentNodeId) : -1;
  const out = [];
  for (let i = 0; i < acts.length; i++) {
    if (idx >= 0 && i <= idx) continue;
    const brief = briefs[i] || {};
    const summary = brief.line || brief.summary || acts[i].summary || '';
    if (!acts[i] || !acts[i].node_id || !summary) continue;
    out.push({
      node_id: acts[i].node_id,
      summary,
      completion: acts[i].completion || null,
      timing: 'future'
    });
  }
  return out;
}

function enrichRequest(state, request, guide) {
  const req = request || {};
  const extra = candidatesFromGuide(guide, req.node_id);
  if (!extra.length) return req;
  const summaries = (req.summaries || []).slice();
  const seen = new Set(summaries.map(row => row && row.node_id));
  for (const row of extra) if (!seen.has(row.node_id)) summaries.push(row);
  const nodeIds = (req.node_ids || []).slice();
  for (const row of summaries) if (row && row.node_id && !nodeIds.includes(row.node_id)) nodeIds.push(row.node_id);
  const screened = screenCandidates(req.settled_facts || [], summaries, req.entry_keys || [], req.completions || []);
  if (state) {
    const pd = ensure(state);
    applyBlocks(pd, screened.blocks, screened.excluded);
  }
  return {
    ...req,
    summaries,
    node_ids: nodeIds,
    local_exclusions: (req.local_exclusions || []).concat(screened.excluded),
    local_blocks: (req.local_blocks || []).concat(screened.blocks)
  };
}

function characterIdsOf(request) {
  const ids = new Set();
  for (const row of request.profiles || []) if (row && row.character_id) ids.add(String(row.character_id));
  for (const row of request.entry_keys || []) if (row && row.character_id) ids.add(String(row.character_id));
  for (const row of request.settled_facts || []) if (row && row.character_id) ids.add(String(row.character_id));
  return ids;
}

function validateDesignEdits(request, revision) {
  const req = request || {};
  const rejected = [];
  const warnings = [];
  const accepted = { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null };
  if (!revision || typeof revision !== 'object') {
    return { ok: false, reason: 'no_revision', accepted, rejected, warnings };
  }
  if (revision.chat_id && req.chat_id && revision.chat_id !== req.chat_id) {
    rejected.push({ reason: 'archive_mismatch' });
    return { ok: false, reason: 'archive_mismatch', accepted, rejected, warnings };
  }
  if (revision.route_id && req.route_id && revision.route_id !== req.route_id) {
    rejected.push({ reason: 'route_mismatch' });
    return { ok: false, reason: 'route_mismatch', accepted, rejected, warnings };
  }
  if (revision.base_revision != null && req.base_revision != null && Number(revision.base_revision) !== Number(req.base_revision)) {
    rejected.push({ reason: 'stale_progress' });
    return { ok: false, reason: 'stale_progress', accepted, rejected, warnings };
  }
  if (revision.advance_cursor || revision.completed_scene_ids || revision.create_messages || revision.floors || revision.message) {
    warnings.push({ kind: 'ignored_cursor_command' });
  }
  const nodes = new Set(req.node_ids || []);
  const facts = req.settled_facts || [];
  const effActions = Array.isArray(req.effective_actions) ? req.effective_actions : [];
  const effActionIds = new Set();
  for (const a of effActions) {
    if (!a) continue;
    if (a.voided || a.invalidated) continue;
    if (a.action_id) effActionIds.add(String(a.action_id));
  }
  const reqVersion = req.archive_version != null ? Number(req.archive_version) : null;
  const requiredChars = Array.isArray(req.required_characters) ? req.required_characters.map(String) : [];
  const conclusions = Array.isArray(revision.character_conclusions) ? revision.character_conclusions : [];
  const conclusionById = {};
  for (const c of conclusions) {
    if (!c || !c.character_id) continue;
    conclusionById[String(c.character_id)] = c;
  }
  for (const cid of requiredChars) {
    const c = conclusionById[cid];
    if (!c) { rejected.push({ type: 'character', reason: 'missing_conclusion', character_id: cid }); continue; }
    if (reqVersion != null && c.archive_version != null && Number(c.archive_version) !== reqVersion) {
      rejected.push({ type: 'character', reason: 'stale_archive_version', character_id: cid });
      continue;
    }
    const refs = Array.isArray(c.action_refs) ? c.action_refs : [];
    let badRef = false;
    for (const r of refs) {
      if (!effActionIds.has(String(r))) { badRef = true; break; }
    }
    if (badRef) { rejected.push({ type: 'character', reason: 'invalid_action_ref', character_id: cid }); continue; }
    if (c.participation === 'participate' && !refs.length && effActionIds.size) {
      rejected.push({ type: 'character', reason: 'missing_action_ref', character_id: cid });
      continue;
    }
    accepted.character_conclusions = accepted.character_conclusions || [];
    accepted.character_conclusions.push(c);
  }
  for (const raw of revision.brief_facts || []) {
    const text = typeof raw === 'string' ? raw : raw && raw.text;
    if (!allowedBrief(text, facts)) rejected.push({ type: 'brief', reason: 'not_settled_fact', text: text || '' });
    else if (reintroducesVoidedPremise(text, facts)) rejected.push({ type: 'brief', reason: 'reintroduces_voided', text });
    else accepted.brief_facts.push(String(text).trim());
  }
  for (const sum of revision.future_summaries || []) {
    if (!sum || !nodes.has(sum.node_id)) {
      rejected.push({ type: 'summary', reason: 'unknown_node', node_id: sum && sum.node_id });
      continue;
    }
    if (reintroducesVoidedPremise(sum.summary, facts) || reintroducesVoidedPremise(sum.completion, facts)) {
      rejected.push({ type: 'summary', reason: 'reintroduces_voided', node_id: sum.node_id });
      continue;
    }
    accepted.future_summaries.push({
      node_id: sum.node_id,
      summary: sum.summary || '',
      completion: sum.completion || null,
      status: sum.status === 'inapplicable' ? 'inapplicable' : 'revised',
      official_policy: sum.official_policy === 'downweight' ? 'downweight' : 'hide',
      hide_fragments: [].concat(sum.hide_fragments || []).filter(Boolean),
      route_id: req.route_id
    });
  }
  for (const entry of revision.worldbook || []) {
    if (!knownEntry(entry, req.entry_keys || [])) {
      rejected.push({ type: 'worldbook', reason: 'unknown_entry', entry_id: entry && entry.entry_id, comment_pk: entry && entry.comment_pk });
      continue;
    }
    if (reintroducesVoidedPremise(entry.content, facts)) {
      rejected.push({ type: 'worldbook', reason: 'reintroduces_voided', entry_id: entry.entry_id });
      continue;
    }
    const action = entry.action === 'replace' || entry.action === 'keep' ? entry.action : 'disable';
    accepted.worldbook.push({
      entry_id: entry.entry_id != null ? entry.entry_id : null,
      comment_pk: entry.comment_pk || '',
      character_id: entry.character_id || null,
      action,
      content: action === 'replace' ? (entry.content || '') : '',
      fragments: [].concat(entry.fragments || []).filter(Boolean)
    });
  }
  const allowedCharacters = characterIdsOf(req);
  for (const profile of revision.profile || []) {
    if (!profile || !profile.character_id || (allowedCharacters.size && !allowedCharacters.has(String(profile.character_id)))) {
      rejected.push({ type: 'profile', reason: 'unknown_character', character_id: profile && profile.character_id });
      continue;
    }
    if (profile.evidence !== 'on_site') {
      rejected.push({ type: 'profile', reason: 'no_on_site_evidence', character_id: profile.character_id });
      continue;
    }
    const sections = {};
    for (const [name, value] of Object.entries(profile.sections || {})) {
      if (!PROFILE_FIELDS.includes(name)) {
        rejected.push({ type: 'profile', reason: 'field_not_evidenced', field: name, character_id: profile.character_id });
        continue;
      }
      if (isFutureProfileText(value, accepted.future_summaries, facts)) {
        rejected.push({ type: 'profile', reason: 'future_development', field: name, character_id: profile.character_id });
        continue;
      }
      if (String(value || '').trim()) sections[name] = String(value);
    }
    if (Object.keys(sections).length) {
      accepted.profile.push({ character_id: String(profile.character_id), evidence: 'on_site', sections });
    }
  }
  if (revision.sideline && revision.sideline.action && revision.sideline.action !== 'none') {
    const side = revision.sideline;
    const allowedRoutes = new Set([req.route_id, req.sideline && req.sideline.route_id].filter(Boolean));
    const scenes = new Set(req.scene_ids || []);
    if (!['pause', 'close'].includes(side.action) || !allowedRoutes.has(side.route_id)) {
      rejected.push({ type: 'sideline', reason: 'route_not_in_request', route_id: side.route_id });
    } else if (side.resume_scene_id && scenes.size && !scenes.has(side.resume_scene_id)) {
      rejected.push({ type: 'sideline', reason: 'unknown_resume_scene', scene_id: side.resume_scene_id });
    } else {
      accepted.sideline = {
        route_id: side.route_id,
        action: side.action,
        resume_scene_id: side.resume_scene_id || (req.sideline && req.sideline.resume_scene_id) || null,
        resume_segment_index: side.resume_segment_index != null ? side.resume_segment_index : (req.sideline && req.sideline.resume_segment_index) || 0
      };
    }
  }
  // 拒绝恢复作废前提：角色对相关有效行动结论为 absent 且理由含拒绝/不参与，
  // brief 却试图用等效事件恢复原终点 => 拒绝。
  const absentRefusals = [];
  for (const c of accepted.character_conclusions || []) {
    if (!c || c.participation !== 'absent') continue;
    const reason = String(c.reason || '') + ' ' + String(c.constraints || '');
    if (/拒绝|不参与|缺席|refus|absent|declin/i.test(reason)) {
      absentRefusals.push(c);
    }
  }
  if (absentRefusals.length) {
    const refActionIds = new Set();
    for (const c of absentRefusals) {
      for (const a of c.action_refs || []) refActionIds.add(a);
    }
    const briefs = Array.isArray(revision && revision.brief_facts) ? revision.brief_facts : [];
    for (const b of briefs) {
      const text = String((b && b.text) || '');
      if (!text) continue;
      const mentionsOffset = /等效|恢复原终点|抵消|替代|offset|equivalent|restore/i.test(text);
      if (!mentionsOffset) continue;
      const touchesRefused = refActionIds.size === 0
        ? true
        : (Array.isArray(b && b.action_refs) && b.action_refs.some(a => refActionIds.has(a)))
          || absentRefusals.some(c => text.includes(String(c.character_id)));
      if (!touchesRefused) continue;
      rejected.push({
        kind: 'brief_fact',
        reason: 'equivalent_event_offsets_refusal',
        text,
        character_ids: absentRefusals.map(c => c.character_id)
      });
    }
  }
  if (rejected.length) {
    return { ok: false, reason: 'design_edits_rejected', accepted, rejected, warnings };
  }
  return { ok: true, reason: null, accepted, rejected, warnings };
}

function computeNextPlayable(state, ordered, currentSceneId) {
  const bad = (state.plot_direction && state.plot_direction.inapplicable_nodes) || {};
  let seen = !currentSceneId;
  for (const row of ordered || []) {
    if (!row) continue;
    if (!seen) {
      if (row.scene_id === currentSceneId || row.node_id === currentSceneId) seen = true;
      continue;
    }
    if (row.node_id && bad[row.node_id]) continue;
    return { node_id: row.node_id || null, scene_id: row.scene_id || null };
  }
  return null;
}

function relocateIfNeeded(state, request) {
  const pd = state.plot_direction;
  const active = state.active_route;
  if (!active || !request) return { relocated: false, settled_skipped: false };
  const currentNode = request.node_id;
  if (!currentNode || !pd.inapplicable_nodes[currentNode]) return { relocated: false, settled_skipped: false };
  const ordered = request.ordered_nodes || pd.ordered_nodes || [];
  const next = computeNextPlayable(state, ordered, active.scene_id);
  if (!next || !next.scene_id || next.scene_id === active.scene_id) return { relocated: false, next, settled_skipped: false };
  const ids = (request.scene_ids && request.scene_ids.length) ? request.scene_ids : ordered.map(row => row && row.scene_id).filter(Boolean);
  const idx = ids.indexOf(next.scene_id);
  if (idx < 0) return { relocated: false, next, settled_skipped: false };
  const rp = S.getRouteProgress(state, active.route_id);
  const skippedScene = active.scene_id;
  active.scene_id = next.scene_id;
  rp.scene_index = idx;
  const cp = state.corpus_progress && state.corpus_progress[active.route_id];
  if (cp && next.node_id) {
    cp.node_id = next.node_id;
    cp.segment_index = 0;
  }
  pd.cursor_note = { relocated_to: next.scene_id, skipped_scene_id: skippedScene, skipped_node: currentNode, settled: false };
  return { relocated: true, next, settled_skipped: false, skipped_scene_id: skippedScene };
}

function adopt(state, considered, design) {
  const pd = ensure(state);
  const pending = (considered && considered.request) ? considered : null;
  const request = (pending && pending.request) || (pd.pending && pd.pending.request) || (considered && considered.request) || {};
  const beforeScene = state.active_route ? state.active_route.scene_id : null;
  const beforeCompleted = state.active_route
    ? ((state.route_progress[state.active_route.route_id] || {}).completed_scene_ids || []).slice()
    : [];
  const factList = request.settled_facts || [];
  const echoed = design && design.ok
    ? (design.revision || (design.accepted ? {
      chat_id: request.chat_id,
      route_id: request.route_id,
      base_revision: request.base_revision,
      brief_facts: design.accepted.brief_facts,
      future_summaries: design.accepted.future_summaries,
      worldbook: design.accepted.worldbook,
      profile: design.accepted.profile,
      sideline: design.accepted.sideline
    } : null))
    : null;
  const review = validateDesignEdits(request, echoed);
  const body = (design && design.accepted && design.ok) ? design.accepted : review.accepted;
  const checked = (design && design.accepted && design.ok) ? validateDesignEdits(request, {
    chat_id: request.chat_id,
    route_id: request.route_id,
    base_revision: request.base_revision,
    brief_facts: body.brief_facts,
    future_summaries: body.future_summaries,
    worldbook: body.worldbook,
    profile: body.profile,
    sideline: body.sideline
  }) : review;
  const use = checked.accepted || { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null };
  applyBlocks(pd, request.local_blocks || [], request.local_exclusions || []);
  const factIdList = factList.map(f => f.fact_id).filter(Boolean);
  if (design && design.ok) {
    for (const sum of use.future_summaries || []) {
      pd.future_summaries[sum.node_id] = {
        ...sum,
        fact_ids: factIdList.slice(),
        route_id: request.route_id
      };
      if (sum.status === 'inapplicable') {
        pd.inapplicable_nodes[sum.node_id] = {
          node_id: sum.node_id,
          route_id: request.route_id,
          fact_ids: factIdList.slice(),
          label: '本存档不再适用'
        };
      }
      if (sum.completion && sum.status !== 'inapplicable') {
        pd.completion_overrides[sum.node_id] = {
          node_id: sum.node_id,
          route_id: request.route_id,
          completion: sum.completion,
          fact_ids: factIdList.slice()
        };
      }
    }
    for (const entry of use.worldbook || []) {
      const key = entryKey(entry);
      if (!key) continue;
      const prev = pd.excluded_entries[key] || {};
      pd.excluded_entries[key] = {
        ...prev,
        ...entry,
        key,
        fragments: [].concat(prev.fragments || [], entry.fragments || []).filter((v, i, a) => v && a.indexOf(v) === i),
        fact_ids: factIdList.slice()
      };
    }
    if (use.sideline && use.sideline.route_id) {
      pd.sidelines[use.sideline.route_id] = {
        ...use.sideline,
        status: use.sideline.action === 'close' ? 'finished' : 'paused',
        fact_ids: factIdList.slice()
      };
    }
  }
  if (request.route_id) {
    const rp = S.getRouteProgress(state, request.route_id);
    const futureTexts = Object.values(pd.future_summaries).map(sum => sum.summary).filter(Boolean);
    const drop = futureTexts.concat((checked.rejected || []).filter(row => row.type === 'brief').map(row => row.text));
    rp.brief = composeBrief(rp.brief, factList.map(f => f.text), drop, factList);
  }
  for (const id of factIdList) {
    if (pd.facts[id]) pd.facts[id].handled = true;
    if (!pd.handled_fact_ids.includes(id)) pd.handled_fact_ids.push(id);
  }
  const revision = {
    revision_id: 'rev_' + (state.revision || 0) + '_' + factIdList.join('_'),
    fact_ids: factIdList.slice(),
    route_id: request.route_id || null,
    segment_key: request.segment_key || (factList[0] && factList[0].segment_key) || null,
    at_revision: state.revision,
    source: design && design.ok && checked.ok ? 'design' : 'local',
    summary_node_ids: Object.keys(pd.future_summaries),
    excluded_keys: Object.keys(pd.excluded_entries)
  };
  if (factIdList.length) pd.revisions.push(revision);
  pd.ordered_nodes = request.ordered_nodes || pd.ordered_nodes || [];
  pd.next_playable = computeNextPlayable(state, pd.ordered_nodes, state.active_route && state.active_route.scene_id);
  const moved = relocateIfNeeded(state, request);
  pd.pending = null;
  const afterCompleted = state.active_route
    ? ((state.route_progress[state.active_route.route_id] || {}).completed_scene_ids || []).slice()
    : beforeCompleted;
  return {
    ok: true,
    design_ok: !!(design && design.ok && checked.ok),
    reason: design && design.ok ? checked.reason : (design && design.reason) || 'design_unavailable',
    call_design: !!(considered && considered.call_design),
    revision,
    rejected: checked.rejected || [],
    warnings: (checked.warnings || []).concat((design && design.warnings) || []),
    excluded: Object.values(pd.excluded_entries),
    cursor_advanced: false,
    floors_created: 0,
    scene_continues: true,
    relocated: !!moved.relocated,
    settled_skipped: false,
    scene_id: state.active_route ? state.active_route.scene_id : beforeScene,
    completed_scene_ids: afterCompleted,
    route_id: state.active_route ? state.active_route.route_id : null,
    brief: request.route_id ? (state.route_progress[request.route_id] || {}).brief || '' : ''
  };
}

function releaseInapplicableCursor(state) {
  const pd = state && state.plot_direction;
  const active = state && state.active_route;
  if (!pd || !active) return { relocated: false, settled_skipped: false };
  const cp = state.corpus_progress && state.corpus_progress[active.route_id];
  const nodeId = cp && cp.node_id;
  if (!nodeId || !pd.inapplicable_nodes[nodeId]) return { relocated: false, settled_skipped: false };
  const ordered = pd.ordered_nodes || [];
  return relocateIfNeeded(state, {
    node_id: nodeId,
    ordered_nodes: ordered,
    scene_ids: ordered.map(row => row && row.scene_id).filter(Boolean)
  });
}

function blocksSettlement(state, turnResult) {
  const pd = state && state.plot_direction;
  if (!pd || !pd.inapplicable_nodes) return false;
  const node = turnResult && (turnResult.segment_node_id || (turnResult.progress && turnResult.progress.node_id));
  if (node && pd.inapplicable_nodes[node]) return true;
  const routeId = state.active_route && state.active_route.route_id;
  const cp = routeId && state.corpus_progress && state.corpus_progress[routeId];
  return !!(cp && cp.node_id && pd.inapplicable_nodes[cp.node_id]);
}

function sceneIndexOf(route, sceneId) {
  if (!route || !Array.isArray(route.ordered_scene_ids)) return -1;
  return route.ordered_scene_ids.indexOf(sceneId);
}

function dropFactsAfter(state, route, sceneId, segmentIndex) {
  const pd = state && state.plot_direction;
  if (!pd || !pd.facts) return [];
  const dropped = [];
  const target = sceneIndexOf(route, sceneId);
  for (const [id, fact] of Object.entries(pd.facts)) {
    if (!fact) continue;
    if (route && fact.route_id && fact.route_id !== route.route_id) continue;
    const idx = sceneIndexOf(route, fact.scene_id);
    if (idx < 0 || target < 0) continue;
    const later = idx > target || (idx === target && (fact.segment_index || 0) >= (segmentIndex || 0));
    if (!later) continue;
    dropped.push(id);
    delete pd.facts[id];
  }
  if (!dropped.length) return dropped;
  const drop = new Set(dropped);
  pd.fact_order = (pd.fact_order || []).filter(id => !drop.has(id));
  pd.handled_fact_ids = (pd.handled_fact_ids || []).filter(id => !drop.has(id));
  pd.revisions = (pd.revisions || []).filter(rev => !(rev.fact_ids || []).some(id => drop.has(id)) || (rev.fact_ids || []).some(id => pd.facts[id]));
  pd.revisions = pd.revisions.filter(rev => (rev.fact_ids || []).every(id => pd.facts[id]));
  for (const [nodeId, sum] of Object.entries(pd.future_summaries || {})) {
    if ((sum.fact_ids || []).some(id => drop.has(id)) && !(sum.fact_ids || []).some(id => pd.facts[id])) delete pd.future_summaries[nodeId];
  }
  for (const [key, ex] of Object.entries(pd.excluded_entries || {})) {
    if ((ex.fact_ids || []).some(id => drop.has(id)) && !(ex.fact_ids || []).some(id => pd.facts[id])) delete pd.excluded_entries[key];
  }
  for (const [nodeId, row] of Object.entries(pd.inapplicable_nodes || {})) {
    if ((row.fact_ids || []).some(id => drop.has(id)) && !(row.fact_ids || []).some(id => pd.facts[id])) delete pd.inapplicable_nodes[nodeId];
  }
  for (const [nodeId, row] of Object.entries(pd.completion_overrides || {})) {
    if ((row.fact_ids || []).some(id => drop.has(id)) && !(row.fact_ids || []).some(id => pd.facts[id])) delete pd.completion_overrides[nodeId];
  }
  return dropped;
}

function decorateInjection(state, injection) {
  if (!injection || !state || !state.plot_direction) return injection;
  const pd = state.plot_direction;
  const active = pd.facts && Object.keys(pd.facts).length
    || pd.future_summaries && Object.keys(pd.future_summaries).length
    || pd.excluded_entries && Object.keys(pd.excluded_entries).length;
  if (!active) return injection;
  const out = injection;
  const nodeId = out.corpus_segment && out.corpus_segment.node_id;
  const fragments = collectHideFragments(pd);
  if (out.route_guide && typeof out.route_guide.text === 'string' && fragments.length) {
    out.route_guide = { ...out.route_guide, text: stripFragments(out.route_guide.text, fragments) };
  }
  const current = nodeId && pd.future_summaries ? pd.future_summaries[nodeId] : null;
  if (current && (current.official_policy === 'hide' || current.status === 'inapplicable' || current.status === 'conflict_blocked')) {
    const revised = current.summary
      ? '【本存档修订摘要】' + current.summary
      : '（与本存档已确认事实冲突的原文已屏蔽。先按当前现场继续，不要把未发生的原作结果写成已经发生。）';
    out.scene_material = current.status === 'inapplicable'
      ? '本存档不再适用。' + (pd.next_playable && pd.next_playable.node_id ? '下一可演节点：' + pd.next_playable.node_id + '。' : '') + '被略过的事件不要记成已发生。'
      : revised;
    if (current.status === 'inapplicable') out.current_goal = '本存档不再适用';
    else if (current.completion) out.current_goal = current.completion;
  } else if (current && current.official_policy === 'downweight') {
    const head = current.summary ? '【本存档修订摘要】' + current.summary + '\n' : '';
    out.scene_material = head + '【原文已降权】若下文与修订摘要或已发生事实冲突，以修订摘要为准，不得另排一次已经失败的事件。\n' + stripFragments(out.scene_material || '', fragments);
    if (current.completion) out.current_goal = current.completion;
  } else if (nodeId && pd.completion_overrides && pd.completion_overrides[nodeId]) {
    out.current_goal = pd.completion_overrides[nodeId].completion;
  } else if (fragments.length && out.scene_material) {
    out.scene_material = stripFragments(out.scene_material, fragments);
  }
  const futureLines = [];
  for (const [id, sum] of Object.entries(pd.future_summaries || {})) {
    if (id === nodeId) continue;
    if (sum.status === 'inapplicable') futureLines.push(id + '：本存档不再适用');
    else if (sum.status === 'conflict_blocked') futureLines.push(id + '：原文与已确认事实冲突，本次参考已撤下');
    else if (sum.summary) futureLines.push(id + '：' + sum.summary);
  }
  if (futureLines.length) {
    const block = '【本存档后续参考】优先于与之冲突的原文。不要把未演节点记成已发生，不要为保住原终点重排已经失败的事件。\n' + futureLines.join('\n');
    if (out.route_guide && out.route_guide.text) {
      out.route_guide = { ...out.route_guide, text: block + '\n' + out.route_guide.text };
    } else {
      out.route_guide = { text: block, guide_id: null, status: 'archive_revision', acts: futureLines.length, current_act: null, chars: block.length };
    }
  }
  out.plot_direction = {
    next_playable: pd.next_playable || null,
    inapplicable_node_ids: Object.keys(pd.inapplicable_nodes || {}),
    revised_node_ids: Object.keys(pd.future_summaries || {}),
    exclusions: Object.keys(pd.excluded_entries || {}).length,
    sidelines: pd.sidelines || {}
  };
  return out;
}

const api = {
  SOFT_KINDS, HARD_KINDS, PROFILE_FIELDS,
  ensure, stableFactId, segmentKeyOf, factIds,
  reintroducesVoidedPremise, isFutureProfileText, conflictsWithFact, screenCandidates,
  composeBrief, stripFragments, signalFromTurn, consider, candidatesFromGuide, enrichRequest,
  validateDesignEdits, adopt, blocksSettlement, releaseInapplicableCursor, dropFactsAfter, decorateInjection,
  computeNextPlayable, entryKey
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CORE_PLOT_DIRECTION__ = api;
