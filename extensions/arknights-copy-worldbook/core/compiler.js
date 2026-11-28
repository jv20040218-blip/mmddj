'use strict';

// Local hot-path compiler: one native worldbook entry per character, no LLM.
// Mutual exclusion is enforced by exact character_id / entry_id primary keys.
// A second overlaid form injects only a section-level diff capped at 800 chars.

const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);
const Hash = (typeof require === 'function' && require('./hash')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_HASH__);
const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);

const DIFF_LIMIT = 800;
const CLONE_COMMENT_PREFIX = '[克隆角色]:';

function normSection(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function formDiff(primaryContent, overlayContent, limit) {
  const cap = limit == null ? DIFF_LIMIT : limit;
  const a = Schema.parseSections(primaryContent);
  const b = Schema.parseSections(overlayContent);
  const parts = [];
  for (const s of Schema.SECTIONS) {
    if (normSection(a.sections[s]) !== normSection(b.sections[s])) {
      const body = b.sections[s] && b.sections[s].trim() ? b.sections[s] : '（空）';
      parts.push(s + '：\n' + body);
    }
  }
  let text = parts.join('\n\n');
  const originalChars = text.length;
  let truncated = false;
  if (text.length > cap) {
    text = text.slice(0, cap);
    truncated = true;
  }
  const warning = truncated ? {
    kind: 'diff_truncated',
    limit: cap,
    original_chars: originalChars,
    message: '叠开形态差分超过 ' + cap + ' 字，已截断。超限部分没有静默丢弃标记，请在管理面板查看本条警告。'
  } : null;
  return { text, truncated, chars: text.length, limit: cap, warning };
}

function emptyDynamic() {
  return {
    affection: '',
    relationship: '',
    non_canon_events: [],
    personality_delta: '',
    as_of: null,
    timeline_id: 'main'
  };
}

function normalizeDynamic(layer) {
  const d = emptyDynamic();
  if (!layer || typeof layer !== 'object') return d;
  if (layer.affection != null) d.affection = layer.affection;
  if (layer.relationship != null) d.relationship = String(layer.relationship);
  if (Array.isArray(layer.non_canon_events)) d.non_canon_events = layer.non_canon_events.slice();
  else if (layer.non_canon_events) d.non_canon_events = [layer.non_canon_events];
  if (layer.personality_delta != null) d.personality_delta = String(layer.personality_delta);
  if (layer.notes != null) d.notes = String(layer.notes);
  if (layer.as_of != null) d.as_of = layer.as_of;
  d.timeline_id = layer.timeline_id || 'main';
  // 中文兼容键：保留原值，并映射到规范字段（不覆盖已有规范值）。
  if (layer['经历'] != null && String(layer['经历']).length) {
    d['经历'] = String(layer['经历']);
    const list = Array.isArray(d.non_canon_events) ? d.non_canon_events.slice() : [];
    if (!list.includes(d['经历'])) list.push(d['经历']);
    d.non_canon_events = list;
  }
  if (layer['人际关系'] != null && String(layer['人际关系']).length) {
    d['人际关系'] = String(layer['人际关系']);
    if (!d.relationship) d.relationship = d['人际关系'];
  }
  if (layer['特点'] != null && String(layer['特点']).length) {
    d['特点'] = String(layer['特点']);
    if (!d.personality_delta) d.personality_delta = d['特点'];
  }
  if (layer['备注'] != null && String(layer['备注']).length) {
    d['备注'] = String(layer['备注']);
    if (!d.notes) d.notes = d['备注'];
  }
  return d;
}

function compileCharacter(record, options) {
  const o = options || {};
  const characterId = Keys.characterIdOf(record) || Keys.trim(record && record.canonical_name);
  if (!characterId) return { ok: false, reason: 'missing_character_id' };
  const forms = (record && record.forms) || {};
  const formList = Array.isArray(forms)
    ? forms
    : Object.keys(forms).map(k => ({ form_id: k, ...forms[k] }));
  const selection = (record && record.selection) || {};
  const primaryId = selection.primary != null ? String(selection.primary) : null;
  const overlayId = selection.overlay_enabled && selection.overlay != null ? String(selection.overlay) : null;
  function findForm(id) {
    if (id == null) return null;
    return formList.find(f => String(f.form_id || f.entry_id || f.source_uid) === String(id)) || null;
  }
  const primary = findForm(primaryId) || formList[0] || null;
  if (!primary || primary.content == null) return { ok: false, reason: 'missing_primary_form', character_id: characterId };
  if (overlayId && overlayId === String(primary.form_id || primary.entry_id || primary.source_uid)) {
    return { ok: false, reason: 'overlay_same_as_primary', character_id: characterId };
  }
  let content = String(primary.content);
  let overlay = null;
  let diff = { text: '', truncated: false, chars: 0, limit: DIFF_LIMIT };
  if (overlayId) {
    overlay = findForm(overlayId);
    if (!overlay) return { ok: false, reason: 'overlay_form_not_found', character_id: characterId };
    diff = formDiff(primary.content, overlay.content, o.diffLimit != null ? o.diffLimit : DIFF_LIMIT);
    if (diff.text) {
      content = content.replace(/\n+$/, '') + '\n\n【叠开形态差分】\n' + diff.text + '\n';
    }
  }
  const timelineId = (record.active_timeline || (record.dynamic && record.dynamic.timeline_id) || 'main');
  const dynamicMap = record.dynamic && typeof record.dynamic === 'object' ? record.dynamic : {};
  const dynamic = normalizeDynamic(dynamicMap[timelineId] || dynamicMap.main || record.dynamic_layer || dynamicMap);
  dynamic.timeline_id = timelineId;
  content = Schema.applyDynamicLayer(content, dynamic);
  const plotOverlay = record.plot_overlay || null;
  if (plotOverlay && Array.isArray(plotOverlay.suppressed_fragments)) {
    for (const frag of plotOverlay.suppressed_fragments) {
      const piece = String(frag || '');
      if (piece.length >= 4 && content.includes(piece)) content = content.split(piece).join('');
    }
  }
  if (plotOverlay && plotOverlay.replacement) {
    content = content.replace(/\n+$/, '') + '\n\n【本存档修订】\n' + String(plotOverlay.replacement) + '\n';
  }
  if (plotOverlay && plotOverlay.profile_note) {
    content = content.replace(/\n+$/, '') + '\n\n【本存档现场】\n' + String(plotOverlay.profile_note) + '\n';
  }

  const canonical = record.canonical_name || characterId;
  const uid = record.clone_uid != null ? record.clone_uid : o.uid;
  const entry = {
    uid: uid,
    comment: CLONE_COMMENT_PREFIX + canonical,
    name: CLONE_COMMENT_PREFIX + canonical,
    keys: Array.isArray(primary.keys) && primary.keys.length ? primary.keys.slice() : [canonical],
    content,
    enabled: true,
    vectorized: false,
    disable: false,
    constant: true,
    character_id: characterId,
    actor_id: characterId,
    source_uid: primary.source_uid != null ? primary.source_uid : primary.entry_id,
    form_id: String(primary.form_id || primary.entry_id || primary.source_uid),
    overlay_form_id: overlay ? String(overlay.form_id || overlay.entry_id || overlay.source_uid) : null,
    content_hash: Hash.hashContent(content),
    form_hash: Hash.hashContent(primary.content),
    comment_pk: primary.comment_pk || '',
    strategy: { type: 'constant', keys: Array.isArray(primary.keys) ? primary.keys.slice() : [canonical] }
  };
  if (plotOverlay && plotOverlay.disable_entry) {
    entry.enabled = false;
    entry.disable = true;
    entry.constant = false;
  }
  const warnings = [];
  if (diff && diff.warning) warnings.push({ character_id: characterId, ...diff.warning });
  return {
    ok: true,
    character_id: characterId,
    entry,
    diff,
    dynamic,
    form_hash: entry.form_hash,
    warnings
  };
}

function compileBook(characters, options) {
  const o = options || {};
  const seen = new Map();
  const entries = [];
  const errors = [];
  const warnings = [];
  const list = Array.isArray(characters)
    ? characters
    : Object.keys(characters || {}).map(id => ({ character_id: id, ...characters[id] }));
  let nextUid = o.startUid != null ? o.startUid : 100000;
  for (const rec of list) {
    const id = Keys.characterIdOf(rec) || rec.canonical_name;
    if (!id) { errors.push({ reason: 'missing_character_id' }); continue; }
    if (seen.has(String(id))) {
      errors.push({ reason: 'duplicate_character_id', character_id: id });
      continue;
    }
    const compiled = compileCharacter(rec, { ...o, uid: rec.clone_uid != null ? rec.clone_uid : nextUid });
    if (!compiled.ok) { errors.push(compiled); continue; }
    if (compiled.warnings && compiled.warnings.length) warnings.push(...compiled.warnings);
    seen.set(String(id), compiled.entry);
    entries.push(compiled.entry);
    if (rec.clone_uid == null) nextUid += 1;
  }
  return { ok: errors.length === 0, entries, errors, warnings, count: entries.length };
}

const api = {
  DIFF_LIMIT, CLONE_COMMENT_PREFIX,
  formDiff, emptyDynamic, normalizeDynamic, compileCharacter, compileBook
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_COMPILER__ = api;
