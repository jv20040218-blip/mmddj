// 管理插件侧的剧情设计：校验设计 API 的修订建议，并规划克隆书写入。
// 凭据不在本文件。本模块不创建聊天楼层，也不推进游标。
'use strict';

const AutoToggle = (typeof require === 'function' && require('./auto_toggle')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_AUTO_TOGGLE__);

const PROFILE_FIELDS = ['经历', '人际关系', '特点', '备注'];
const RETRY_RE = /再次|重新|又一次|下一次|下一幕再|另一次/;
const FUTURE_PROFILE_RE = /下一幕|将来会|未来会|将要加入|尚未发生/;
const WRITE_CAP = (AutoToggle && AutoToggle.AUTO_TOGGLE_CAP) || 8;

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

function allowedBrief(text, facts) {
  const t = String(text || '').trim();
  if (!t) return false;
  return (facts || []).some(f => {
    const fact = String((f && f.text) || '').trim();
    return fact && (fact === t || fact.includes(t) || t.includes(fact));
  });
}

function knownEntry(entry, keys) {
  return (keys || []).some(k => {
    if (!k || !entry) return false;
    if (entry.entry_id != null && k.entry_id != null && String(entry.entry_id) === String(k.entry_id)) return true;
    if (entry.comment_pk && k.comment_pk && String(entry.comment_pk) === String(k.comment_pk)) return true;
    return false;
  });
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
    if (Object.keys(sections).length) accepted.profile.push({ character_id: String(profile.character_id), evidence: 'on_site', sections });
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
        resume_segment_index: side.resume_segment_index != null ? side.resume_segment_index : 0
      };
    }
  }
  return { ok: true, reason: null, accepted, rejected, warnings };
}

function exclusionFromEntry(entry, factIds) {
  const fragments = [].concat(entry.fragments || [], entry.content ? [entry.content] : []).filter(v => v && String(v).length >= 4);
  return {
    entry_id: entry.entry_id != null ? entry.entry_id : null,
    comment_pk: entry.comment_pk || '',
    character_id: entry.character_id || null,
    fragments,
    fact_ids: factIds || [],
    action: entry.action || 'disable'
  };
}

function capEntryWrites(entries, cap) {
  const limit = cap == null ? WRITE_CAP : cap;
  const writes = (entries || []).filter(entry => entry && entry.action !== 'keep');
  const apply = writes.slice(0, limit);
  const deferred = writes.slice(limit);
  const warning = deferred.length ? {
    kind: 'auto_toggle_cap',
    cap: limit,
    skipped: deferred.length,
    message: '剧情修订一次最多写入 ' + limit + ' 条精确主键，另有 ' + deferred.length + ' 条未写入克隆书。这些条目仍会从下一次生成上下文中排除。'
  } : null;
  return { apply, deferred, warning, cap: limit };
}

function mergeExclusions(localRows, acceptedRows) {
  const map = new Map();
  function add(row) {
    if (!row) return;
    const key = row.comment_pk ? 'pk:' + row.comment_pk : (row.entry_id != null ? 'id:' + row.entry_id : '');
    if (!key) return;
    const prev = map.get(key) || { fragments: [] };
    const fragments = [].concat(prev.fragments || [], row.fragments || []).filter((v, i, a) => v && a.indexOf(v) === i);
    map.set(key, { ...prev, ...row, fragments });
  }
  for (const row of localRows || []) add(row);
  for (const row of acceptedRows || []) add(exclusionFromEntry(row, row.fact_ids));
  return [...map.values()];
}

const api = {
  PROFILE_FIELDS, WRITE_CAP,
  reintroducesVoidedPremise, isFutureProfileText, allowedBrief,
  validateDesignEdits, capEntryWrites, mergeExclusions, exclusionFromEntry
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_PLOT__ = api;
