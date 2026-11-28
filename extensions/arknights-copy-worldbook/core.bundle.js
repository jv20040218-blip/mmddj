(function(globalThis){
var __cwb_modules = Object.create(null);
function require(spec) {
  var raw = String(spec || '');
  var noExt = raw.replace(/^\.\//, '').replace(/\.js$/, '');
  var candidates = [noExt, 'core/' + noExt, 'ui/' + noExt];
  if (noExt.indexOf('core/') === 0 || noExt.indexOf('ui/') === 0) {
    candidates.push(noExt.split('/').slice(1).join('/'));
  }
  for (var i = 0; i < candidates.length; i++) {
    var id = candidates[i];
    if (Object.prototype.hasOwnProperty.call(__cwb_modules, id)) return __cwb_modules[id];
  }
  throw new Error('arknights-copy-worldbook: missing module ' + spec);
}

// ---- core/schema ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Exact 14-section character profile schema used by the base worldbook.
// Section titles must remain verbatim; parsers and the LLM client both
// reject rewritten headers.

const SECTIONS = Object.freeze([
  '基本信息', '外貌', '服装', '武器', '特点', '源石技艺', '能力',
  '喜欢', '讨厌', '经历', '人际关系', '语言示例', '秘密', '备注'
]);

const SECTION_SET = new Set(SECTIONS);
const HEADER_RE = new RegExp(
  '^(' + SECTIONS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*[:：]\\s*',
  'm'
);
const HEADER_LINE_RE = new RegExp(
  '^(' + SECTIONS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*[:：]\\s*(.*)$'
);

function emptySections() {
  const sections = {};
  for (const s of SECTIONS) sections[s] = '';
  return sections;
}

function isSectionTitle(name) {
  return SECTION_SET.has(String(name || '').trim());
}

function parseSections(content) {
  const text = String(content == null ? '' : content).replace(/\r\n/g, '\n');
  const sections = emptySections();
  const lines = text.split('\n');
  let preamble = [];
  let current = null;
  const body = {};
  for (const s of SECTIONS) body[s] = [];
  for (const line of lines) {
    const m = line.match(HEADER_LINE_RE);
    if (m) {
      current = m[1];
      const rest = m[2] == null ? '' : m[2];
      if (rest.trim()) body[current].push(rest);
      continue;
    }
    if (current) body[current].push(line);
    else preamble.push(line);
  }
  for (const s of SECTIONS) {
    sections[s] = body[s].join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return {
    preamble: preamble.join('\n').replace(/\n+$/, ''),
    sections
  };
}

function serializeSections(preamble, sections) {
  const parts = [];
  const pre = String(preamble || '').replace(/\n+$/, '');
  if (pre) parts.push(pre);
  const src = sections || {};
  for (const s of SECTIONS) {
    const body = String(src[s] == null ? '' : src[s]).replace(/^\n+/, '').replace(/\n+$/, '');
    parts.push(s + '：' + (body ? '\n' + body : ''));
  }
  return parts.join('\n\n') + '\n';
}

function fromStructured(obj, preamble) {
  const sections = emptySections();
  if (obj && typeof obj === 'object') {
    for (const s of SECTIONS) {
      if (obj[s] != null) sections[s] = String(obj[s]);
    }
  }
  return serializeSections(preamble || '', sections);
}

function toStructured(content) {
  const parsed = parseSections(content);
  const out = {};
  for (const s of SECTIONS) out[s] = parsed.sections[s];
  if (parsed.preamble) out._preamble = parsed.preamble;
  return out;
}

function extractStructured(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value).filter(k => SECTION_SET.has(k));
    if (keys.length === SECTIONS.length) {
      const out = {};
      for (const s of SECTIONS) out[s] = String(value[s] == null ? '' : value[s]);
      return out;
    }
  }
  const text = String(value);
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(stripped.slice(start, end + 1));
      return extractStructured(obj);
    } catch (_) { /* fall through to markdown sections */ }
  }
  const parsed = parseSections(text);
  const filled = SECTIONS.filter(s => parsed.sections[s] && parsed.sections[s].trim());
  if (filled.length >= 8) {
    const out = {};
    for (const s of SECTIONS) out[s] = parsed.sections[s];
    return out;
  }
  return null;
}

function appendBlock(existing, title, body) {
  const base = String(existing || '').replace(/\n+$/, '');
  const block = String(body || '').replace(/^\n+/, '').replace(/\n+$/, '');
  if (!block) return base;
  const heading = title ? title + '\n' : '';
  if (base && base.includes(title) && title) {
    // Replace an existing identically titled block rather than stacking.
    const re = new RegExp('(?:^|\\n)' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n[\\s\\S]*?(?=\\n【|$)');
    if (re.test('\n' + base)) {
      return (('\n' + base).replace(re, '\n' + heading + block).replace(/^\n/, '')).replace(/\n+$/, '');
    }
  }
  return (base ? base + '\n\n' : '') + heading + block;
}

function applyDynamicLayer(content, dynamic) {
  const d = dynamic || {};
  const parsed = parseSections(content);
  const sections = { ...parsed.sections };
  if (d.personality_delta) {
    sections['特点'] = appendBlock(sections['特点'], '【存档性格偏移】', String(d.personality_delta));
  }
  const events = Array.isArray(d.non_canon_events)
    ? d.non_canon_events.map(e => (typeof e === 'string' ? e : JSON.stringify(e)))
    : (d.non_canon_events ? [String(d.non_canon_events)] : []);
  if (events.length) {
    sections['经历'] = appendBlock(sections['经历'], '【存档经历（正史外）】', events.map(e => '- ' + e).join('\n'));
  }
  const rel = [];
  if (d.relationship) rel.push('与{{user}}的关系：' + d.relationship);
  if (d['人际关系'] && d['人际关系'] !== d.relationship) rel.push(d['人际关系']);
  if (d.affection != null && d.affection !== '') rel.push('好感：' + d.affection);
  if (rel.length) {
    sections['人际关系'] = appendBlock(sections['人际关系'], '【存档关系】', rel.join('\n'));
  }
  if (d.notes) {
    sections['备注'] = appendBlock(sections['备注'], '【存档备注】', String(d.notes));
  }
  if (d.as_of || d.timeline_id) {
    const meta = [
      d.timeline_id ? '时间线：' + d.timeline_id : '',
      d.as_of ? '截至：' + (typeof d.as_of === 'string' ? d.as_of : JSON.stringify(d.as_of)) : ''
    ].filter(Boolean).join('\n');
    sections['备注'] = appendBlock(sections['备注'], '【存档动态层标记】', meta);
  }
  return serializeSections(parsed.preamble, sections);
}

// --- Dynamic archive status helpers (additive) ---------------------------
// These describe the archive lifecycle without changing the 14-section
// schema. They are used by archive_protection / sidecar / character_book_state
// to distinguish "empty shell" from "real archive content".

const ARCHIVE_STATUS = Object.freeze({
  EMPTY: 'empty',
  PENDING: 'pending',
  SYNCED: 'synced',
  FAILED: 'failed'
});

function emptyArchiveStatus() {
  return {
    status: ARCHIVE_STATUS.EMPTY,
    last_synced_at: null,
    last_synced_segment: null,
    last_error: null
  };
}

function normalizeArchiveStatus(value) {
  const base = emptyArchiveStatus();
  if (!value || typeof value !== 'object') return base;
  const status = String(value.status || base.status);
  return {
    status: ARCHIVE_STATUS[status.toUpperCase()] || status,
    last_synced_at: value.last_synced_at != null ? value.last_synced_at : null,
    last_synced_segment: value.last_synced_segment != null ? value.last_synced_segment : null,
    last_error: value.last_error != null ? value.last_error : null
  };
}

// Explicit independent-entry marker helpers. These are the ONLY sanctioned
// way to mark an entry as belonging to the current save + character.
function markIndependent(form) {
  if (!form || typeof form !== 'object') return form;
  return { ...form, independent: true };
}

function isIndependentForm(form) {
  return !!(form && typeof form === 'object' && form.independent === true);
}

const api = {
  SECTIONS, SECTION_SET, HEADER_RE,
  emptySections, isSectionTitle, parseSections, serializeSections,
  fromStructured, toStructured, extractStructured, appendBlock, applyDynamicLayer,
  ARCHIVE_STATUS, emptyArchiveStatus, normalizeArchiveStatus,
  markIndependent, isIndependentForm
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_SCHEMA__ = api;

__cwb_modules["core/schema"]=module.exports;
__cwb_modules["schema"]=module.exports;
})();
// ---- core/hash ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Portable, deterministic digest. Node uses real SHA-256; browsers without
// a sync SubtleCrypto fall back to the same algorithm via a compact
// implementation so compiled hashes stay comparable across host and tests.

function nodeSha256(text) {
  try {
    if (typeof require === 'function') {
      return require('crypto').createHash('sha256').update(String(text), 'utf8').digest('hex');
    }
  } catch (_) {}
  return null;
}

// Compact SHA-256 (public domain style implementation) for non-Node hosts.
function fallbackSha256(message) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  const bytes = [];
  const raw = unescape(encodeURIComponent(String(message)));
  for (let i = 0; i < raw.length; i++) bytes.push(raw.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4;
      w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => ('00000000' + v.toString(16)).slice(-8)).join('');
}

function sha256(text) {
  return nodeSha256(text) || fallbackSha256(text);
}

function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function hashContent(content) {
  return sha256(String(content == null ? '' : content));
}

function canonicalizeEntries(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  list.sort((a, b) => {
    const au = Number(a && (a.uid != null ? a.uid : a.id));
    const bu = Number(b && (b.uid != null ? b.uid : b.id));
    if (Number.isFinite(au) && Number.isFinite(bu) && au !== bu) return au - bu;
    return String((a && (a.comment || a.name)) || '').localeCompare(String((b && (b.comment || b.name)) || ''));
  });
  return list.map(e => e);
}

function hashEntries(entries) {
  return sha256(stableStringify(canonicalizeEntries(entries)));
}

const api = { sha256, stableStringify, hashContent, hashEntries, canonicalizeEntries };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_HASH__ = api;

__cwb_modules["core/hash"]=module.exports;
__cwb_modules["hash"]=module.exports;
})();
// ---- core/keys ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Exact primary-key matching for worldbook entries and characters.
// NEVER substring-match character names — chapter entries such as
// "九（剧情·时间啊，向前！·44）" must not collide with character "九".

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function commentPk(entryOrComment) {
  if (entryOrComment == null) return '';
  if (typeof entryOrComment === 'string') return trim(entryOrComment);
  return trim(entryOrComment.comment || entryOrComment.name || '');
}

function entryIdOf(entry) {
  if (entry == null || typeof entry !== 'object') return null;
  if (entry.entry_id != null) return entry.entry_id;
  if (entry.uid != null) return entry.uid;
  if (entry.id != null) return entry.id;
  return null;
}

function characterIdOf(record) {
  if (record == null) return '';
  if (typeof record === 'string') return trim(record);
  return trim(record.character_id || record.actor_id || '');
}

function isGenericCharacterEntry(entry) {
  const pk = commentPk(entry);
  return /^\[角色\]\s*[:：]/.test(pk);
}

function isChapterEntry(entry) {
  const pk = commentPk(entry);
  if (/^\[角色\]\s*[:：]/.test(pk)) return false;
  if (/^\[剧情\]/.test(pk) || /（剧情[·・]/.test(pk) || /\(剧情[·・]/.test(pk)) return true;
  if (/^\[设定\]/.test(pk) || /^\[指导\]/.test(pk) || /^ARK/.test(pk)) return true;
  return false;
}

function exactEntryMatch(entry, selector) {
  if (!entry || !selector) return false;
  if (selector.entry_id != null && entryIdOf(entry) != null &&
      String(entryIdOf(entry)) === String(selector.entry_id)) return true;
  if (selector.source_uid != null && entryIdOf(entry) != null &&
      String(entryIdOf(entry)) === String(selector.source_uid)) return true;
  if (selector.comment_pk) {
    const pk = commentPk(entry);
    if (pk && pk === trim(selector.comment_pk)) return true;
  }
  if (selector.character_id && characterIdOf(entry) &&
      characterIdOf(entry) === trim(selector.character_id)) {
    // Character-id equality only matches generic character entries, never
    // chapter/story entries that merely mention the same name.
    if (selector.allow_chapter || !isChapterEntry(entry)) return true;
  }
  return false;
}

function exactNameEquals(a, b) {
  return trim(a) !== '' && trim(a) === trim(b);
}

// Catalog: [{ character_id, canonical_name, aliases[], forms: [{ entry_id, comment_pk, label }] }]
function resolveUniqueName(name, catalog) {
  const needle = trim(name);
  if (!needle || !Array.isArray(catalog)) return { ok: false, reason: 'empty_name' };
  const hits = [];
  for (const rec of catalog) {
    const names = [rec.canonical_name].concat(rec.aliases || []);
    if (names.some(n => exactNameEquals(n, needle))) hits.push(rec);
  }
  if (hits.length === 1) return { ok: true, character: hits[0] };
  if (hits.length === 0) return { ok: false, reason: 'no_exact_match', name: needle };
  return { ok: false, reason: 'ambiguous', name: needle, candidates: hits.map(h => h.character_id) };
}

function resolveForm(character, selector) {
  if (!character) return { ok: false, reason: 'no_character' };
  const forms = character.forms || character.states || [];
  if (selector && (selector.entry_id != null || selector.source_uid != null || selector.comment_pk)) {
    const hit = forms.find(f => exactEntryMatch(f, selector));
    if (hit) return { ok: true, form: hit };
    return { ok: false, reason: 'form_not_found' };
  }
  if (selector && selector.label != null) {
    const hits = forms.filter(f => exactNameEquals(f.label, selector.label));
    if (hits.length === 1) return { ok: true, form: hits[0] };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous_form_label' };
    return { ok: false, reason: 'form_not_found' };
  }
  return { ok: false, reason: 'missing_form_selector' };
}

const api = {
  trim, commentPk, entryIdOf, characterIdOf,
  isGenericCharacterEntry, isChapterEntry,
  exactEntryMatch, exactNameEquals, resolveUniqueName, resolveForm
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_KEYS__ = api;

__cwb_modules["core/keys"]=module.exports;
__cwb_modules["keys"]=module.exports;
})();
// ---- core/compiler ----
(function(){
var module={exports:{}};var exports=module.exports;
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

__cwb_modules["core/compiler"]=module.exports;
__cwb_modules["compiler"]=module.exports;
})();
// ---- core/sidecar ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Per-save sidecar store: dynamic layers + rollback snapshots.
// This is NOT written into ark_story_v2 on the hot path. Chat variables
// only keep the pointer { book, sidecar_rev } (plus lore_mode).

const Hash = (typeof require === 'function' && require('./hash')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_HASH__);
const Compiler = (typeof require === 'function' && require('./compiler')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_COMPILER__);
const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);

function nowMs(host) {
  if (host && typeof host.now === 'function') return host.now();
  return Date.now();
}

function emptySidecar() {
  return { rev: 0, characters: {}, snapshots: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureCharacter(store, characterId, seed) {
  if (!store.characters[characterId]) {
    store.characters[characterId] = {
      character_id: characterId,
      canonical_name: (seed && seed.canonical_name) || characterId,
      aliases: (seed && seed.aliases) || [],
      forms: {},
      selection: { primary: null, overlay: null, overlay_enabled: false },
      dynamic: { main: Compiler.emptyDynamic() },
      active_timeline: 'main',
      stale_forms: {},
      clone_uid: seed && seed.clone_uid != null ? seed.clone_uid : null,
      // Additive: explicit independent-entry markers and archive status.
      independent_entries: {},
      archive_status: Schema && Schema.emptyArchiveStatus ? Schema.emptyArchiveStatus() : { status: 'empty' }
    };
  } else if (seed && seed.canonical_name && !store.characters[characterId].canonical_name) {
    store.characters[characterId].canonical_name = seed.canonical_name;
  }
  const rec = store.characters[characterId];
  if (!rec.independent_entries || typeof rec.independent_entries !== 'object') {
    rec.independent_entries = {};
  }
  if (!rec.archive_status || typeof rec.archive_status !== 'object') {
    rec.archive_status = Schema && Schema.emptyArchiveStatus ? Schema.emptyArchiveStatus() : { status: 'empty' };
  }
  return rec;
}

function characterList(store) {
  return Object.keys(store.characters || {}).map(id => {
    const rec = store.characters[id];
    return {
      ...rec,
      character_id: id,
      forms: rec.forms,
      selection: rec.selection,
      dynamic: rec.dynamic,
      active_timeline: rec.active_timeline,
      independent_entries: rec.independent_entries || {},
      archive_status: rec.archive_status || (Schema && Schema.emptyArchiveStatus ? Schema.emptyArchiveStatus() : { status: 'empty' })
    };
  });
}

function bump(store) {
  store.rev = (store.rev || 0) + 1;
  return store.rev;
}

function snapshot(store, reason, host, extra) {
  const id = 'snap_' + nowMs(host) + '_' + Math.random().toString(36).slice(2, 8);
  const layer = {
    characters: clone(store.characters || {}),
    manual: clone(store.manual || {}),
    plot_layer: store.plot_layer ? clone(store.plot_layer) : null,
    rev: store.rev || 0
  };
  const note = extra && typeof extra === 'object' ? extra : null;
  const rec = {
    id,
    at: nowMs(host),
    reason: reason || 'manual',
    characters_hash: Hash.hashContent(Hash.stableStringify(layer.characters)),
    plot_fact_ids: note && Array.isArray(note.plot_fact_ids) ? note.plot_fact_ids.slice() : [],
    segment_key: note && note.segment_key || null,
    layer
  };
  store.snapshots = Array.isArray(store.snapshots) ? store.snapshots : [];
  store.snapshots.push(rec);
  // Keep a bounded history so the sidecar cannot grow without limit.
  if (store.snapshots.length > 30) store.snapshots.splice(0, store.snapshots.length - 30);
  bump(store);
  return rec;
}

function rollback(store, snapshotId) {
  const list = store.snapshots || [];
  let rec = null;
  if (snapshotId) rec = list.find(s => s.id === snapshotId) || null;
  else {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && !list[i].voided) { rec = list[i]; break; }
    }
  }
  if (!rec || !rec.layer) return { ok: false, reason: 'snapshot_not_found', llm_calls: 0 };
  store.characters = clone(rec.layer.characters || {});
  if (rec.layer.manual) store.manual = clone(rec.layer.manual);
  if (Object.prototype.hasOwnProperty.call(rec.layer, 'plot_layer')) {
    store.plot_layer = rec.layer.plot_layer ? clone(rec.layer.plot_layer) : null;
  }
  bump(store);
  return {
    ok: true,
    snapshot_id: rec.id,
    characters_hash: Hash.hashContent(Hash.stableStringify(store.characters)),
    expected_hash: rec.characters_hash,
    llm_calls: 0
  };
}

function setForm(store, characterId, form, seed) {
  const rec = ensureCharacter(store, characterId, seed);
  const formId = String(form.form_id || form.entry_id || form.source_uid);
  const independent = form.independent === true;
  rec.forms[formId] = {
    form_id: formId,
    source_uid: form.source_uid != null ? form.source_uid : form.entry_id,
    entry_id: form.entry_id != null ? form.entry_id : form.source_uid,
    comment_pk: form.comment_pk || '',
    label: form.label || formId,
    keys: Array.isArray(form.keys) ? form.keys.slice() : [],
    content: String(form.content || ''),
    content_hash: Hash.hashContent(form.content || ''),
    copied_at: form.copied_at || null,
    // Explicit marker only. Automatic chapter copies must NOT set this.
    independent: independent
  };
  if (independent) {
    rec.independent_entries = rec.independent_entries || {};
    rec.independent_entries[formId] = true;
  }
  if (!rec.selection.primary) rec.selection.primary = formId;
  bump(store);
  return rec.forms[formId];
}

// Explicitly mark an existing form as an independent entry for this save.
function markIndependentEntry(store, characterId, formId, seed) {
  const rec = ensureCharacter(store, characterId, seed);
  const fid = String(formId);
  if (!rec.forms[fid]) return { ok: false, reason: 'form_not_found' };
  rec.forms[fid].independent = true;
  rec.independent_entries = rec.independent_entries || {};
  rec.independent_entries[fid] = true;
  bump(store);
  return { ok: true, form_id: fid };
}

function switchForm(store, characterId, selection) {
  const rec = store.characters[characterId];
  if (!rec) return { ok: false, reason: 'character_not_in_clone' };
  const next = { ...rec.selection, ...selection };
  if (next.primary != null && !rec.forms[String(next.primary)]) {
    return { ok: false, reason: 'primary_form_not_found' };
  }
  if (next.overlay != null && next.overlay_enabled && !rec.forms[String(next.overlay)]) {
    return { ok: false, reason: 'overlay_form_not_found' };
  }
  rec.selection = {
    primary: next.primary != null ? String(next.primary) : rec.selection.primary,
    overlay: next.overlay == null ? null : String(next.overlay),
    overlay_enabled: !!next.overlay_enabled
  };
  bump(store);
  return { ok: true, selection: { ...rec.selection }, llm_calls: 0 };
}

const INGEST_KEYS = ['经历', '人际关系', '特点', '备注'];
const INGEST_MAP = {
  '经历': 'non_canon_events',
  '人际关系': 'relationship',
  '特点': 'personality_delta',
  '备注': 'notes'
};

function asEventList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(v => String(v)).filter(v => v.length);
  const s = String(value);
  return s.length ? [s] : [];
}

function setDynamic(store, characterId, patch, timelineId) {
  const rec = ensureCharacter(store, characterId);
  const tid = timelineId || rec.active_timeline || 'main';
  const prev = Compiler.normalizeDynamic((rec.dynamic && rec.dynamic[tid]) || Compiler.emptyDynamic());
  const merged = { ...prev, timeline_id: tid };
  const p = patch || {};
  const provided = {};
  // 中文 ingest 键：映射到规范英文字段，并记录顶层兼容值。
  for (const k of INGEST_KEYS) {
    if (p[k] != null && String(p[k]).length) {
      const val = String(p[k]);
      provided[INGEST_MAP[k]] = val;
      provided['__cn_' + k] = val;
    }
  }
  // 英规范字段：直接写入规范时间线。
  if (p.non_canon_events != null) {
    const incoming = asEventList(p.non_canon_events);
    const base = asEventList(merged.non_canon_events);
    const list = base.slice();
    for (const ev of incoming) if (!list.includes(ev)) list.push(ev);
    merged.non_canon_events = list;
  } else if (provided.non_canon_events != null) {
    const base = asEventList(merged.non_canon_events);
    const list = base.slice();
    if (!list.includes(provided.non_canon_events)) list.push(provided.non_canon_events);
    merged.non_canon_events = list;
  }
  if (p.relationship != null) {
    merged.relationship = String(p.relationship);
  } else if (provided.relationship != null) {
    merged.relationship = provided.relationship;
  }
  if (p.personality_delta != null) {
    merged.personality_delta = String(p.personality_delta);
  } else if (provided.personality_delta != null) {
    merged.personality_delta = provided.personality_delta;
  }
  if (p.notes != null) {
    merged.notes = String(p.notes);
  } else if (provided.notes != null) {
    merged.notes = provided.notes;
  }
  if (p.as_of != null) merged.as_of = p.as_of;
  // 中文 ingest 键：同步写入时间线对象，供按时间线读取的调用方使用。
  for (const k of INGEST_KEYS) {
    if (p[k] != null && String(p[k]).length) {
      merged[k] = String(p[k]);
    }
  }
  rec.dynamic[tid] = merged;
  rec.active_timeline = rec.active_timeline || tid;
  // 顶层中文键兼容：仅当写入的是活动时间线时同步，避免污染。
  if (tid === rec.active_timeline) {
    for (const k of INGEST_KEYS) {
      if (p[k] != null && String(p[k]).length) {
        rec.dynamic[k] = String(p[k]);
      }
    }
    // 英规范字段写入活动时间线时，同步顶层中文镜像，供旧读取方使用。
    if (p.non_canon_events != null) {
      const list = asEventList(merged.non_canon_events);
      if (list.length) rec.dynamic['经历'] = list[list.length - 1];
    }
    if (p.relationship != null) rec.dynamic['人际关系'] = String(p.relationship);
    if (p.personality_delta != null) rec.dynamic['特点'] = String(p.personality_delta);
    if (p.notes != null) rec.dynamic['备注'] = String(p.notes);
  }
  bump(store);
  return rec.dynamic[tid];
}

// Update the archive status for a character. Additive; does not touch the
// dynamic content itself. Used by the sync pipeline (later slices) and by
// tests to simulate "initialized" / "failed" archives.
function setArchiveStatus(store, characterId, patch, seed) {
  const rec = ensureCharacter(store, characterId, seed);
  const prev = Schema && Schema.normalizeArchiveStatus
    ? Schema.normalizeArchiveStatus(rec.archive_status)
    : (rec.archive_status || { status: 'empty' });
  rec.archive_status = { ...prev, ...(patch || {}) };
  bump(store);
  return rec.archive_status;
}

function markStale(store, characterId, formId, info) {
  const rec = store.characters[characterId];
  if (!rec) return null;
  rec.stale_forms = rec.stale_forms || {};
  rec.stale_forms[String(formId)] = { ...(info || {}), marked_at: info && info.marked_at };
  bump(store);
  return rec.stale_forms[String(formId)];
}

function ensureActions(store, id) {
  if (!store || !store.characters) return null;
  const ch = ensureCharacter(store, id);
  if (!ch) return null;
  if (!Array.isArray(ch.actions)) ch.actions = [];
  return ch.actions;
}

function actionKey(chatId, messageId, branchId, swipeId) {
  return [String(chatId == null ? '' : chatId), String(messageId == null ? '' : messageId),
    String(branchId == null ? '' : branchId), String(swipeId == null ? '' : swipeId)].join('|');
}

function actionList(store, id, opts) {
  if (!store || !store.characters) return [];
  const ch = store.characters[id];
  if (!ch || !Array.isArray(ch.actions)) return [];
  const includeVoided = !!(opts && opts.includeVoided);
  return ch.actions.filter(a => includeVoided || !(a && (a.voided || a.invalidated)));
}

function appendAction(store, id, action) {
  const list = ensureActions(store, id);
  if (!list) return null;
  const a = Object.assign({}, action || {});
  if (a.id == null) a.id = 'act_' + (list.length + 1) + '_' + Date.now().toString(36);
  if (a.voided == null) a.voided = false;
  if (a.invalidated == null) a.invalidated = false;
  if (a.idempotency_key != null) {
    const dup = list.find(x => x && x.idempotency_key === a.idempotency_key && !x.voided && !x.invalidated);
    if (dup) return dup;
  }
  list.push(a);
  bump(store);
  return a;
}

function invalidateActionsByMessage(store, id, messageId) {
  if (!store || !store.characters) return 0;
  const ch = store.characters[id];
  if (!ch || !Array.isArray(ch.actions)) return 0;
  let n = 0;
  for (const a of ch.actions) {
    if (!a || a.voided || a.invalidated) continue;
    if (a.message_id != null && String(a.message_id) === String(messageId)) {
      a.voided = true; a.invalidated = true; n++;
    }
  }
  if (n) bump(store);
  return n;
}

function invalidateActionsAfterRollback(store, id, opts) {
  if (!store || !store.characters) return 0;
  const ch = store.characters[id];
  if (!ch || !Array.isArray(ch.actions)) return 0;
  const o = opts || {};
  const afterSnapshotId = o.afterSnapshotId;
  const afterMessageId = o.afterMessageId;
  let n = 0;
  for (const a of ch.actions) {
    if (!a || a.voided || a.invalidated) continue;
    let hit = false;
    if (afterSnapshotId != null && a.snapshot_id != null && String(a.snapshot_id) === String(afterSnapshotId)) hit = true;
    if (afterMessageId != null && a.message_id != null && String(a.message_id) === String(afterMessageId)) hit = true;
    if (hit) { a.voided = true; a.invalidated = true; n++; }
  }
  if (n) bump(store);
  return n;
}

function getProcessedPosition(store, id) {
  if (!store) return null;
  if (store.processed_positions && store.processed_positions[id]) return store.processed_positions[id];
  const ch = store.characters && store.characters[id];
  if (ch && ch.processed) return ch.processed;
  return null;
}

function setProcessedPosition(store, id, pos) {
  if (!store) return null;
  if (!store.processed_positions) store.processed_positions = {};
  store.processed_positions[id] = Object.assign({}, pos || {});
  const ch = store.characters && store.characters[id];
  if (ch) ch.processed = Object.assign({}, pos || {});
  bump(store);
  return store.processed_positions[id];
}

function markSyncGap(store, id, info) {
  if (!store) return null;
  if (!store.sync_gaps) store.sync_gaps = {};
  store.sync_gaps[id] = Object.assign({ at: Date.now() }, info || {});
  const ch = store.characters && store.characters[id];
  if (ch) ch.sync_gap = store.sync_gaps[id];
  bump(store);
  return store.sync_gaps[id];
}

function clearSyncGap(store, id) {
  if (!store) return false;
  let had = false;
  if (store.sync_gaps && store.sync_gaps[id]) { delete store.sync_gaps[id]; had = true; }
  const ch = store.characters && store.characters[id];
  if (ch && ch.sync_gap) { delete ch.sync_gap; had = true; }
  if (had) bump(store);
  return had;
}

const api = {
  emptySidecar, clone, ensureCharacter, characterList, bump,
  snapshot, rollback, setForm, switchForm, setDynamic, markStale,
  markIndependentEntry, setArchiveStatus,
  ensureActions, actionKey, actionList, appendAction,
  invalidateActionsByMessage, invalidateActionsAfterRollback,
  getProcessedPosition, setProcessedPosition, markSyncGap, clearSyncGap
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_SIDECAR__ = api;

__cwb_modules["core/sidecar"]=module.exports;
__cwb_modules["sidecar"]=module.exports;
})();
// ---- core/lore_bind ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Chat Lore binding for the sparse Copy Worldbook.
// lore_mode defaults to baseline. CHAT_CHANGED never auto-creates empty
// books for legacy saves — books are created only on an explicit enable.

const DEFAULT_LORE_MODE = 'baseline';
const POINTER_FIELDS = ['lore_mode', 'book', 'sidecar_rev'];

function pointerOf(meta) {
  const m = meta || {};
  return {
    lore_mode: m.lore_mode || DEFAULT_LORE_MODE,
    book: m.book || m.clone_book || null,
    sidecar_rev: m.sidecar_rev || 0
  };
}

function pointersEqual(a, b) {
  const pa = pointerOf(a), pb = pointerOf(b);
  return pa.lore_mode === pb.lore_mode && pa.book === pb.book && pa.sidecar_rev === pb.sidecar_rev;
}

function bookNameFor(chatId) {
  return 'ark-clone::' + String(chatId);
}

function onChatChanged(host, chatId) {
  const metrics = { book_creates: 0, book_writes: 0, lore_binds: 0, meta_writes: 0, base_writes: 0 };
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  if (ptr.lore_mode !== 'clone') {
    return {
      ok: true,
      mode: ptr.lore_mode || DEFAULT_LORE_MODE,
      created: false,
      warning: null,
      writes: 0,
      ...metrics,
      pointer: ptr
    };
  }
  const name = ptr.book;
  const exists = !!(name && host.bookExists(name));
  if (!name || !exists) {
    const next = { lore_mode: 'degraded', book: name || null, sidecar_rev: ptr.sidecar_rev };
    if (!pointersEqual(ptr, next)) {
      host.writeStoryMeta(chatId, next);
      metrics.meta_writes = 1;
    }
    return {
      ok: true,
      mode: 'degraded',
      created: false,
      warning: 'missing_clone_book',
      writes: metrics.meta_writes,
      base_writes: 0,
      ...metrics,
      pointer: next
    };
  }
  const current = host.getChatLore(chatId);
  if (current === name) {
    return {
      ok: true,
      mode: 'clone',
      created: false,
      warning: null,
      writes: 0,
      ...metrics,
      pointer: ptr,
      book: name
    };
  }
  host.setChatLore(chatId, name);
  metrics.lore_binds = 1;
  return {
    ok: true,
    mode: 'clone',
    created: false,
    warning: null,
    writes: 1,
    ...metrics,
    pointer: ptr,
    book: name
  };
}

function enableCloneMode(host, chatId, options) {
  const o = options || {};
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  const name = ptr.book || o.bookName || (host.cloneName ? host.cloneName(chatId) : bookNameFor(chatId));
  let created = false;
  if (!host.bookExists(name)) {
    const initial = Array.isArray(o.initialEntries) ? o.initialEntries : [];
    host.createBook(name, initial);
    created = true;
  }
  const next = { lore_mode: 'clone', book: name, sidecar_rev: ptr.sidecar_rev || 0 };
  host.writeStoryMeta(chatId, next);
  if (host.getChatLore(chatId) !== name) host.setChatLore(chatId, name);
  return { ok: true, mode: 'clone', created, book: name, pointer: next };
}

function disableCloneMode(host, chatId, options) {
  const o = options || {};
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  const next = { lore_mode: DEFAULT_LORE_MODE, book: ptr.book, sidecar_rev: ptr.sidecar_rev };
  host.writeStoryMeta(chatId, next);
  if (host.getChatLore(chatId) && host.getChatLore(chatId) === ptr.book) {
    host.setChatLore(chatId, null);
  }
  if (o.deleteBook && ptr.book && host.deleteBook) host.deleteBook(ptr.book);
  return { ok: true, mode: DEFAULT_LORE_MODE, pointer: next };
}

function shouldNoopBaseFlush(metaOrMode) {
  const mode = typeof metaOrMode === 'string'
    ? metaOrMode
    : pointerOf(metaOrMode).lore_mode;
  if (mode === 'clone' || mode === 'degraded') {
    return { noop: true, reason: mode };
  }
  return { noop: false, reason: mode || DEFAULT_LORE_MODE };
}

const api = {
  DEFAULT_LORE_MODE, POINTER_FIELDS,
  pointerOf, pointersEqual, bookNameFor,
  onChatChanged, enableCloneMode, disableCloneMode, shouldNoopBaseFlush
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_LORE_BIND__ = api;

__cwb_modules["core/lore_bind"]=module.exports;
__cwb_modules["lore_bind"]=module.exports;
})();
// ---- core/prompt_filter ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Outbound prompt / lore hook: when a character is overridden in the sparse
// Copy Worldbook, the base book's original entry text for that exact form
// is suppressed from the final prompt. Chapter-specific entries are never
// treated as taken over by a generic character. The base book is not mutated.

const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);
const Compiler = (typeof require === 'function' && require('./compiler')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_COMPILER__);

function overriddenSelectors(characters) {
  const list = Array.isArray(characters)
    ? characters
    : Object.keys(characters || {}).map(id => ({ character_id: id, ...characters[id] }));
  const selectors = [];
  for (const rec of list) {
    const forms = rec.forms || {};
    const formList = Array.isArray(forms) ? forms : Object.values(forms);
    const primaryId = rec.selection && rec.selection.primary;
    const chosen = primaryId != null
      ? formList.find(f => String(f.form_id || f.entry_id || f.source_uid) === String(primaryId))
      : formList[0];
    if (!chosen) continue;
    selectors.push({
      character_id: rec.character_id || rec.actor_id,
      entry_id: chosen.source_uid != null ? chosen.source_uid : chosen.entry_id,
      source_uid: chosen.source_uid != null ? chosen.source_uid : chosen.entry_id,
      comment_pk: chosen.comment_pk || '',
      form_hash: chosen.content_hash,
      compiled_content: rec.compiled_content || null
    });
  }
  return selectors;
}

function isTakenOverBaseEntry(entry, selectors) {
  if (!entry || Keys.isChapterEntry(entry) || isCloneEntry(entry)) return false;
  for (const sel of selectors || []) {
    if (Keys.exactEntryMatch(entry, sel)) return true;
  }
  return false;
}

function stripEntryContent(entry) {
  return { ...entry, content: '', disable: true, disabled: true, enabled: false, constant: false, suppressed_by: 'ark-copy-worldbook' };
}

function filterLoreCollections(lores, selectors) {
  if (!lores || typeof lores !== 'object') return { lores, removed: 0, texts: [] };
  const keys = Array.isArray(lores)
    ? null
    : ['globalLore', 'characterLore', 'chatLore', 'personaLore', 'entries', 'worldInfo'];
  let removed = 0;
  const texts = [];
  function scrub(list) {
    if (!Array.isArray(list)) return list;
    return list.map(entry => {
      if (!isTakenOverBaseEntry(entry, selectors)) return entry;
      removed += 1;
      if (entry && entry.content) texts.push(String(entry.content));
      return stripEntryContent(entry);
    });
  }
  if (Array.isArray(lores)) {
    return { lores: scrub(lores), removed, texts };
  }
  const out = { ...lores };
  for (const key of keys) {
    if (Array.isArray(out[key])) out[key] = scrub(out[key]);
  }
  return { lores: out, removed, texts };
}

function isCloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const pk = Keys.commentPk(entry);
  return typeof pk === 'string' && pk.startsWith(Compiler.CLONE_COMMENT_PREFIX);
}

function stripTextOccurrences(text, fragments, protectedSpans) {
  if (!text || typeof text !== 'string' || !fragments || !fragments.length) return text;
  let out = text;
  const tokens = [];
  for (const span of protectedSpans || []) {
    const s = String(span || '');
    if (!s || !out.includes(s)) continue;
    const token = '\u0000CWB' + tokens.length + '\u0000';
    out = out.split(s).join(token);
    tokens.push(s);
  }
  for (const frag of fragments) {
    const f = String(frag || '');
    if (f.length < 24) continue; // avoid accidental short-string wipes
    if (out.includes(f)) out = out.split(f).join('');
  }
  for (let i = 0; i < tokens.length; i++) {
    out = out.split('\u0000CWB' + i + '\u0000').join(tokens[i]);
  }
  return out;
}

function walkPrompt(payload, fn, opts) {
  if (payload == null) return payload;
  if (typeof payload === 'string') return fn(payload);
  if (Array.isArray(payload)) return payload.map(item => walkPrompt(item, fn, opts));
  if (typeof payload === 'object') {
    if (isCloneEntry(payload)) return payload;
    const out = payload;
    if (typeof out.content === 'string') out.content = fn(out.content);
    if (typeof out.mes === 'string') out.mes = fn(out.mes);
    if (typeof out.message === 'string') out.message = fn(out.message);
    if (typeof out.text === 'string') out.text = fn(out.text);
    if (Array.isArray(out.chat)) out.chat = walkPrompt(out.chat, fn, opts);
    if (Array.isArray(out.messages)) out.messages = walkPrompt(out.messages, fn, opts);
    if (Array.isArray(out.prompt)) out.prompt = walkPrompt(out.prompt, fn, opts);
    return out;
  }
  return payload;
}

function filterOutboundPrompt(payload, context) {
  const ctx = context || {};
  const selectors = ctx.selectors || overriddenSelectors(ctx.characters || []);
  const loreKeys = ['lores', 'worldInfo', 'world_info', 'characterLore', 'globalLore', 'chatLore'];
  let removed = 0;
  const texts = [];
  let out = payload;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    for (const key of loreKeys) {
      if (out[key]) {
        const filtered = filterLoreCollections(out[key], selectors);
        out[key] = filtered.lores;
        removed += filtered.removed;
        texts.push(...filtered.texts);
      }
    }
    if (Array.isArray(out.entries)) {
      const filtered = filterLoreCollections(out.entries, selectors);
      out.entries = filtered.lores;
      removed += filtered.removed;
      texts.push(...filtered.texts);
    }
  } else if (Array.isArray(out) && out[0] && (out[0].comment != null || out[0].content != null) && (out[0].uid != null || out[0].keys)) {
    const filtered = filterLoreCollections(out, selectors);
    out = filtered.lores;
    removed += filtered.removed;
    texts.push(...filtered.texts);
  }
  for (const sel of selectors) {
    if (sel.base_content) texts.push(String(sel.base_content));
  }
  const protectedSpans = [];
  for (const sel of selectors) {
    if (sel.compiled_content) protectedSpans.push(String(sel.compiled_content));
  }
  if (out && typeof out === 'object') {
    const loreLists = Array.isArray(out) ? [out] : [out.chatLore, out.entries, out.characterLore, out.globalLore];
    for (const list of loreLists) {
      if (!Array.isArray(list)) continue;
      for (const e of list) if (isCloneEntry(e) && e.content) protectedSpans.push(String(e.content));
    }
  }
  if (texts.length) out = walkPrompt(out, t => stripTextOccurrences(t, texts, protectedSpans));
  const plot = applyPlotExclusions(out, ctx.excluded || []);
  out = plot.payload;
  removed += plot.removed || 0;
  return {
    payload: out,
    removed,
    suppressed_texts: texts.length,
    selectors: selectors.length,
    excluded: plot.removed || 0,
    uncovered: plot.uncovered || []
  };
}

function stripExactFragments(text, fragments) {
  let out = String(text == null ? '' : text);
  for (const frag of fragments || []) {
    const piece = String(frag || '');
    if (piece.length < 4) continue;
    if (out.includes(piece)) out = out.split(piece).join('');
  }
  return out;
}

function exclusionFragments(excluded) {
  const out = [];
  for (const ex of excluded || []) {
    const list = [].concat((ex && ex.fragments) || [], ex && ex.content ? [ex.content] : []);
    for (const frag of list) {
      const piece = String(frag || '');
      if (piece.length >= 4 && !out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

function matchesExactExclusion(entry, ex) {
  if (!entry || !ex) return false;
  if (ex.comment_pk && Keys.commentPk(entry) === Keys.trim(ex.comment_pk)) return true;
  if (ex.entry_id != null) {
    const id = Keys.entryIdOf(entry);
    if (id != null && String(id) === String(ex.entry_id)) return true;
    if (entry.source_uid != null && String(entry.source_uid) === String(ex.entry_id)) return true;
    if (entry.uid != null && String(entry.uid) === String(ex.entry_id)) return true;
  }
  return false;
}

function scrubExcludedList(list, excluded, fragments) {
  if (!Array.isArray(list)) return { list, removed: 0, matched: [] };
  let removed = 0;
  const matched = [];
  const next = list.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const exact = (excluded || []).some(ex => matchesExactExclusion(entry, ex));
    if (exact) {
      removed += 1;
      matched.push(entry);
      return stripEntryContent(entry);
    }
    if (typeof entry.content === 'string' && fragments.length) {
      const stripped = stripExactFragments(entry.content, fragments);
      if (stripped !== entry.content) return { ...entry, content: stripped };
    }
    return entry;
  });
  return { list: next, removed, matched };
}

function applyPlotExclusions(payload, excluded) {
  const rows = excluded || [];
  const fragments = exclusionFragments(rows);
  if (!rows.length && !fragments.length) {
    return { payload, removed: 0, uncovered: [], fragments: 0 };
  }
  let out = payload;
  let removed = 0;
  const original = (() => { try { return JSON.stringify(payload); } catch (_) { return ''; } })();
  const loreKeys = ['chatLore', 'characterLore', 'globalLore', 'personaLore', 'worldInfo', 'entries', 'world_info'];
  function scrubContainer(container) {
    if (!container || typeof container !== 'object') return container;
    if (Array.isArray(container)) {
      const scrubbed = scrubExcludedList(container, rows, fragments);
      removed += scrubbed.removed;
      return scrubbed.list;
    }
    const copy = { ...container };
    for (const key of loreKeys) {
      if (Array.isArray(copy[key])) {
        const scrubbed = scrubExcludedList(copy[key], rows, fragments);
        copy[key] = scrubbed.list;
        removed += scrubbed.removed;
      } else if (copy[key] && typeof copy[key] === 'object') {
        copy[key] = scrubContainer(copy[key]);
      }
    }
    if (copy.lores) copy.lores = scrubContainer(copy.lores);
    return copy;
  }
  if (Array.isArray(out) || (out && typeof out === 'object')) out = scrubContainer(out);
  if (fragments.length) {
    const protect = [];
    out = walkPrompt(out, text => stripExactFragments(text, fragments), { protect });
  }
  const uncovered = [];
  for (const ex of rows) {
    const fragHit = (ex.fragments || []).some(frag => frag && original.includes(String(frag)))
      || (ex.content && original.includes(String(ex.content)));
    const keyHit = ex.comment_pk && original.includes(String(ex.comment_pk))
      || (ex.entry_id != null && original.includes(String(ex.entry_id)));
    if (!fragHit && !keyHit) uncovered.push(ex);
  }
  return { payload: out, removed, uncovered, fragments: fragments.length };
}

function promptContainsBaseText(payload, fragments) {
  const hits = [];
  walkPrompt(payload, text => {
    for (const frag of fragments || []) {
      if (frag && String(text).includes(String(frag))) hits.push(frag);
    }
    return text;
  });
  return hits;
}

const api = {
  overriddenSelectors, isTakenOverBaseEntry, filterLoreCollections,
  filterOutboundPrompt, promptContainsBaseText, stripTextOccurrences, isCloneEntry,
  applyPlotExclusions, matchesExactExclusion, stripExactFragments,
  CLONE_COMMENT_PREFIX: Compiler.CLONE_COMMENT_PREFIX
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_PROMPT_FILTER__ = api;

__cwb_modules["core/prompt_filter"]=module.exports;
__cwb_modules["prompt_filter"]=module.exports;
})();
// ---- core/chapter_adapt ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Chapter adaptation table for the three chapters confirmed by the Sol guide.
// Only exact, explicitly confirmed targets are listed here. Anything not in
// this table must NOT be treated as adapted, and no form may be guessed.
//
// Matching is by full character name (exact string equality after trim) and
// by full comment primary key. NEVER substring-match.

const keys = (typeof require === 'function')
  ? require('./keys.js')
  : (typeof globalThis !== 'undefined' ? globalThis.__ARK_CWB_KEYS__ : null);

function trim(value) {
  return String(value == null ? '' : value).trim();
}

// ---------------------------------------------------------------------------
// Adapted chapter set (exactly these three, nothing else)
// ---------------------------------------------------------------------------

const ADAPTED_CHAPTERS = ['雪原线', '时间啊，向前！', '孤星'];

function adaptedChapters() {
  return ADAPTED_CHAPTERS.slice();
}

function isAdapted(chapter) {
  const name = trim(chapter);
  if (!name) return false;
  return ADAPTED_CHAPTERS.indexOf(name) !== -1;
}

// ---------------------------------------------------------------------------
// Target tables. Each entry: { character, comment_pk, label, note }
// comment_pk is the full Sol primary key, preserving the space after the colon.
// ---------------------------------------------------------------------------

// 《雪原线》 — only the two explicit snowfield suffixes plus Talulah's
// scene-conditional rule. Talulah's snowfield target is the same斗士 entry as
// her daily default; it is only switched when the current scene binding says so.
const SNOWFIELD_TARGETS = [
  {
    character: '霜星',
    comment_pk: '[角色]:霜星(雪原,与本格选一开)',
    label: '雪原',
    note: '仅当当前场景确实需要霜星且角色未被保护时切换'
  },
  {
    character: '爱国者',
    comment_pk: '[角色]:爱国者(雪原,与本格、博卓卡斯替选一开)',
    label: '雪原',
    note: '仅当当前场景确实需要爱国者且角色未被保护时切换'
  },
  {
    character: '塔露拉',
    comment_pk: '[角色]:塔露拉(斗士,与幼年、黑蛇、新整合运动选一开)',
    label: '斗士',
    note: '雪原斗士场景对应目标；须与现行场景绑定核对，不覆盖明确的幼年或其他回忆绑定'
  }
];

// 《时间啊，向前！》 — 35 explicit chapter character entries.
const TIME_FORWARD_TARGETS = [
  { character: '瓦莲汀·沃尔金娜', comment_pk: '[角色]: 瓦莲汀·沃尔金娜（剧情·时间啊，向前！·25）', label: '本篇', note: '无独立通用条目' },
  { character: '拉夫连·卡尔诺夫', comment_pk: '[角色]: 拉夫连·卡尔诺夫（剧情·时间啊，向前！·26）', label: '本篇', note: '无独立通用条目' },
  { character: '雅罗米尔', comment_pk: '[角色]: 雅罗米尔（剧情·时间啊，向前！·27）', label: '本篇', note: '无独立通用条目' },
  { character: '罗季昂', comment_pk: '[角色]: 罗季昂（剧情·时间啊，向前！·28）', label: '本篇', note: '无独立通用条目' },
  { character: '卡特琳娜', comment_pk: '[角色]: 卡特琳娜（剧情·时间啊，向前！·29）', label: '本篇', note: '别名关联候选（乔万娜关键词含卡特琳娜），需核对现行身份标识' },
  { character: '西尔卡', comment_pk: '[角色]: 西尔卡（剧情·时间啊，向前！·30）', label: '本篇', note: '通用来源 [角色]:西尔卡' },
  { character: '斯韦特兰纳', comment_pk: '[角色]: 斯韦特兰纳（剧情·时间啊，向前！·31）', label: '本篇', note: '通用来源 [角色]:斯韦特兰纳' },
  { character: '叶甫根尼', comment_pk: '[角色]: 叶甫根尼（剧情·时间啊，向前！·32）', label: '本篇', note: '通用来源 [角色]:叶甫根尼' },
  { character: '雷尔金', comment_pk: '[角色]: 雷尔金（剧情·时间啊，向前！·33）', label: '本篇', note: '通用来源 [角色]:雷尔金' },
  { character: '希尔达', comment_pk: '[角色]: 希尔达（剧情·时间啊，向前！·34）', label: '本篇', note: '通用来源 [角色]:希尔达' },
  { character: '纳斯塔霞', comment_pk: '[角色]: 纳斯塔霞（剧情·时间啊，向前！·35）', label: '本篇', note: '通用来源 [角色]:纳斯塔霞' },
  { character: '叶莉莎女大公', comment_pk: '[角色]: 叶莉莎女大公（剧情·时间啊，向前！·36）', label: '本篇', note: '明示别名 叶莉莎女大公 / 叶莉莎' },
  { character: '尼克托', comment_pk: '[角色]: 尼克托（剧情·时间啊，向前！·37）', label: '本篇', note: '通用来源 [角色]:尼克托' },
  { character: '维特', comment_pk: '[角色]: 维特（剧情·时间啊，向前！·38）', label: '本篇', note: '只选本篇，不能选遗尘漫步同名条目' },
  { character: '凛冬', comment_pk: '[角色]: 凛冬（剧情·时间啊，向前！·39）', label: '本篇', note: '现行凛冬互斥组，日常默认本格' },
  { character: '费奥多尔', comment_pk: '[角色]: 费奥多尔（剧情·时间啊，向前！·40）', label: '本篇', note: '通用来源 [角色]:费奥多尔' },
  { character: '阿洛伊泽', comment_pk: '[角色]: 阿洛伊泽（剧情·时间啊，向前！·41）', label: '本篇', note: '通用来源 [角色]:阿洛伊泽' },
  { character: '奥尔佳', comment_pk: '[角色]: 奥尔佳（剧情·时间啊，向前！·42）', label: '本篇', note: '通用来源 [角色]:奥尔佳' },
  { character: '安托沙', comment_pk: '[角色]: 安托沙（剧情·时间啊，向前！·43）', label: '本篇', note: '通用来源 [角色]:安托沙' },
  { character: '九', comment_pk: '[角色]: 九（剧情·时间啊，向前！·44）', label: '本篇', note: '通用来源 [角色]:九；不得与九色鹿或雪原九线合并' },
  { character: '雷德', comment_pk: '[角色]: 雷德（剧情·时间啊，向前！·45）', label: '本篇', note: '通用来源 [角色]:雷德；不与红合并' },
  { character: '米拉娜', comment_pk: '[角色]: 米拉娜（剧情·时间啊，向前！·46）', label: '本篇', note: '明示别名 米拉娜 / “伊凡·图林”' },
  { character: '塔露拉', comment_pk: '[角色]: 塔露拉（剧情·时间啊，向前！·47）', label: '本篇', note: '现行塔露拉互斥组，日常默认斗士' },
  { character: 'Raidian', comment_pk: '[角色]: Raidian（剧情·时间啊，向前！·48）', label: '本篇', note: '通用来源 [角色]:Raidian' },
  { character: 'Mantra', comment_pk: '[角色]: Mantra（剧情·时间啊，向前！·49）', label: '本篇', note: '通用来源 [角色]:Mantra' },
  { character: '卡德尔', comment_pk: '[角色]: 卡德尔（剧情·时间啊，向前！·50）', label: '本篇', note: '无独立通用条目；不与卡铎尔合并' },
  { character: '奥妮拉', comment_pk: '[角色]: 奥妮拉（剧情·时间啊，向前！·51）', label: '本篇', note: '无独立通用条目' },
  { character: '塔拉斯', comment_pk: '[角色]: 塔拉斯（剧情·时间啊，向前！·52）', label: '本篇', note: '无独立通用条目' },
  { character: '弑君者', comment_pk: '[角色]: 弑君者（剧情·时间啊，向前！·53）', label: '本篇', note: '通用来源 [角色]:弑君者' },
  { character: '赫拉格', comment_pk: '[角色]: 赫拉格（剧情·时间啊，向前！·54）', label: '本篇', note: '通用来源 [角色]:赫拉格' },
  { character: '维伊', comment_pk: '[角色]: 维伊（剧情·时间啊，向前！·55）', label: '本篇', note: '通用来源 [角色]:维伊' },
  { character: '折桠', comment_pk: '[角色]: 折桠（剧情·时间啊，向前！·56）', label: '本篇', note: '通用来源 [角色]:折桠' },
  { character: '卡谢娜', comment_pk: '[角色]: 卡谢娜（剧情·时间啊，向前！·57）', label: '本篇', note: '通用来源 [角色]:卡谢娜；不与黑蛇/科西切合并' },
  { character: '谢尔戈', comment_pk: '[角色]: 谢尔戈（剧情·时间啊，向前！·58）', label: '本篇', note: '无独立通用条目' },
  { character: '奥列格', comment_pk: '[角色]: 奥列格（剧情·时间啊，向前！·59）', label: '本篇', note: '无独立通用条目' }
];

// 《孤星》 — 6 explicit chapter character entries.
const LONE_STAR_TARGETS = [
  { character: '洛肯·威廉姆斯', comment_pk: '[角色]: 洛肯·威廉姆斯（剧情·孤星·11）', label: '本篇', note: '无独立通用条目；只使用完整姓名，不合并到杰斯顿等' },
  { character: '布莱克上校', comment_pk: '[角色]: 布莱克上校（剧情·孤星·12）', label: '本篇', note: '无独立通用条目；不按“上校”称谓匹配其他人' },
  { character: '杰克逊', comment_pk: '[角色]: 杰克逊（剧情·孤星·13）', label: '本篇', note: '通用来源 [角色]:杰克逊' },
  { character: '帕尔维斯', comment_pk: '[角色]: 帕尔维斯（剧情·孤星·14）', label: '本篇', note: '只能选孤星条目，不能选绿野幻梦条目' },
  { character: '斐尔迪南', comment_pk: '[角色]: 斐尔迪南（剧情·孤星·15）', label: '本篇', note: '通用来源 [角色]:斐尔迪南' },
  { character: '伊芙利特', comment_pk: '[角色]: 伊芙利特（剧情·孤星·16）', label: '本篇', note: '有专属目标，不能因通用来源无后缀而漏切' }
];

const TARGETS_BY_CHAPTER = {
  '雪原线': SNOWFIELD_TARGETS,
  '时间啊，向前！': TIME_FORWARD_TARGETS,
  '孤星': LONE_STAR_TARGETS
};

// ---------------------------------------------------------------------------
// Characters that must NOT be auto-switched even though they appear in a
// chapter. These are recorded so callers can surface "不应自动切" reasons.
// ---------------------------------------------------------------------------

const DO_NOT_AUTO_SWITCH = {
  '雪原线': [
    { character: '九', reason: '雪原短暂出场，无雪原专属条目；不得借用《时间啊，向前！》九条目，无明确场景绑定则保持当前资料' },
    { character: '博卓卡斯替', reason: '898 年条目不是雪原后缀，仅在现行明确场景确需该时期时使用' },
    { character: '塔露拉', reason: '幼年、黑蛇、新整合运动形态不能从整篇名称确定逐幕时期，仅现行明确场景绑定才能切' }
  ],
  '时间啊，向前！': [
    { character: '真理', reason: '不得因篇名自行指定成年形态；无本篇目标时只有现行明确场景绑定才能切' },
    { character: '霜星', reason: '不得因篇名自行指定雪原形态' },
    { character: '阿米娅', reason: '历史清单提到但当前索引无本篇命名条目，使用现行明确场景绑定' },
    { character: '博士', reason: '性别及玩家身份属于开局选择，不得擅自改性别或重开独立 NPC 条目' },
    { character: '爱国者', reason: '不得因篇名自行指定雪原/博卓卡斯替形态' },
    { character: '凯尔希', reason: '不得自行指定巴别塔等形态，使用现行明确场景绑定' },
    { character: '维娜', reason: '历史清单提到但无本篇命名条目；ED2 维娜幼年 scene_anchor 为现行明确绑定' },
    { character: '推进之王', reason: '同维娜，使用现行明确场景绑定' }
  ],
  '孤星': [
    { character: '克丽斯腾', reason: '有大学、本格，无孤星命名条目；依现行场景绑定，不整篇切大学' },
    { character: '娜斯提', reason: '有幼年、本格，无孤星命名条目；依现行场景绑定，不整篇切幼年' },
    { character: '赫默', reason: '当前默认淬羽赫默（异格 entry 533，本格 144 关闭）；保留现行默认与明确场景切换' },
    { character: '博士', reason: '不得擅自改性别，不重开玩家博士独立 NPC 条目' },
    { character: '凯尔希', reason: '不借用遗尘漫步条目；复用现行明确场景绑定' }
  ]
};

// ---------------------------------------------------------------------------
// Missing / ambiguous items recorded by the Sol guide. These are NOT targets.
// ---------------------------------------------------------------------------

const MISSING_OR_AMBIGUOUS = {
  '雪原线': [
    { character: '九', issue: '无雪原专属条目，不得借用《时间啊，向前！》九条目' },
    { character: '其余出场人物及称谓', issue: '1.7.0 的 8 人仅为历史统计，材料无现行完整名单，需逐项核对现行场景绑定' }
  ],
  '时间啊，向前！': [
    { character: '瓦莲汀·沃尔金娜', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '拉夫连·卡尔诺夫', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '雅罗米尔', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '罗季昂', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '卡德尔', issue: '有本篇条目但无独立通用条目；不与卡铎尔合并' },
    { character: '奥妮拉', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '塔拉斯', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '谢尔戈', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '奥列格', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '卡特琳娜', issue: '别名关联候选（乔万娜关键词含卡特琳娜），需核对现行身份标识；冲突则列歧义' },
    { character: '米拉娜', issue: '明示别名“伊凡·图林”，需验证唯一身份，不通过删称谓/去引号/子串转换实现' },
    { character: '叶莉莎女大公', issue: '明示别名 叶莉莎，需验证唯一身份' },
    { character: '维特', issue: '同时存在《遗尘漫步》同名本篇条目，只选本篇 38' },
    { character: '雷德', issue: '另有角色“红”，不因译名/近义/外观推断合并' },
    { character: '卡谢娜', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '塔露拉', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '科西切', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '其余出场人物、回忆人物和称谓', issue: '材料无完整名单和逐幕绑定，35 条不能冒称全篇全部角色覆盖' }
  ],
  '孤星': [
    { character: '洛肯·威廉姆斯', issue: '“威廉姆斯”也出现在其他角色关键词中，只使用完整姓名和现行身份' },
    { character: '克丽斯腾', issue: '有大学、本格，无孤星命名条目；不整篇统一切大学' },
    { character: '娜斯提', issue: '有幼年、本格，无孤星命名条目；不因本篇含回忆就全部切幼年' },
    { character: '赫默', issue: '当前默认淬羽赫默，本格关闭；不根据剧情印象自行重设' },
    { character: '博士', issue: '性别及玩家身份属于开局选择，不得擅自改性别' },
    { character: '凯尔希', issue: '有多种资料及遗尘漫步本篇条目，无孤星命名条目；不借用遗尘漫步条目' },
    { character: '其他角色与称谓', issue: '历史“17 个有独立条目人物”不能提供当前完整名单，6 条不能称为全员适配' }
  ]
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function normalizeName(name) {
  return trim(name);
}

function findTargetInTable(table, characterName) {
  const name = normalizeName(characterName);
  if (!name) return null;
  const hits = table.filter(t => t.character === name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Multiple targets for the same character in one chapter is ambiguous.
    return { ambiguous: true, candidates: hits };
  }
  return null;
}

// Optional catalog: when provided, verify the target comment_pk exists in the
// catalog and that the character identity is unique. The catalog is expected
// to be an array of { character_id, canonical_name, aliases[], forms[] }.
function verifyAgainstCatalog(target, characterName, catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return { ok: true };
  }
  const name = normalizeName(characterName);
  const identityHits = [];
  for (const rec of catalog) {
    if (!rec || typeof rec !== 'object') continue;
    const names = [rec.canonical_name].concat(rec.aliases || []);
    if (names.some(n => trim(n) === name)) identityHits.push(rec);
  }
  if (identityHits.length === 0) {
    // Catalog does not know this character; still allow the explicit table
    // target, but flag it so callers can surface a warning.
    return { ok: true, warning: 'character_not_in_catalog' };
  }
  if (identityHits.length > 1) {
    return { ok: false, reason: 'ambiguous_identity', candidates: identityHits.map(r => r.character_id) };
  }
  const rec = identityHits[0];
  const forms = rec.forms || rec.states || [];
  const formHit = forms.find(f => trim(f && f.comment_pk) === trim(target.comment_pk));
  if (!formHit) {
    return { ok: false, reason: 'target_not_in_catalog', character_id: rec.character_id };
  }
  return { ok: true, character_id: rec.character_id, form: formHit };
}

/**
 * Find the confirmed chapter target for a character.
 *
 * @param {string} characterName  Full character name (exact match).
 * @param {string} chapterName    Chapter name (exact match).
 * @param {Array}  [catalog]      Optional character catalog for identity check.
 * @returns {object} Always an object, never null.
 *   - { ok: true, comment_pk, target }
 *   - { ok: false, reason: 'chapter_not_adapted' }
 *   - { ok: false, reason: 'no_target' }
 *   - { ok: false, reason: 'ambiguous_target', candidates }
 *   - { ok: false, reason: 'ambiguous_identity', candidates }
 *   - { ok: false, reason: 'target_not_in_catalog', character_id }
 */
function findTarget(characterName, chapterName, catalog) {
  const chapter = trim(chapterName);
  const name = normalizeName(characterName);

  if (!chapter) {
    return { ok: false, reason: 'chapter_not_adapted' };
  }
  if (!isAdapted(chapter)) {
    return { ok: false, reason: 'chapter_not_adapted' };
  }
  if (!name) {
    return { ok: false, reason: 'no_target' };
  }

  const table = TARGETS_BY_CHAPTER[chapter] || [];
  const hit = findTargetInTable(table, name);

  if (!hit) {
    return { ok: false, reason: 'no_target' };
  }
  if (hit.ambiguous) {
    return { ok: false, reason: 'ambiguous_target', candidates: hit.candidates.map(c => c.comment_pk) };
  }

  const verify = verifyAgainstCatalog(hit, name, catalog);
  if (!verify.ok) {
    return { ok: false, reason: verify.reason, character_id: verify.character_id, candidates: verify.candidates };
  }

  const result = {
    ok: true,
    comment_pk: hit.comment_pk,
    target: {
      character: hit.character,
      chapter,
      comment_pk: hit.comment_pk,
      label: hit.label,
      note: hit.note
    }
  };
  if (verify.warning) result.warning = verify.warning;
  if (verify.character_id) result.character_id = verify.character_id;
  return result;
}

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

function targetsForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (TARGETS_BY_CHAPTER[chapter] || []).map(t => ({
    character: t.character,
    comment_pk: t.comment_pk,
    label: t.label,
    note: t.note
  }));
}

function doNotAutoSwitchForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (DO_NOT_AUTO_SWITCH[chapter] || []).map(x => ({ character: x.character, reason: x.reason }));
}

function missingOrAmbiguousForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (MISSING_OR_AMBIGUOUS[chapter] || []).map(x => ({ character: x.character, issue: x.issue }));
}

function allTargets() {
  const out = [];
  for (const chapter of ADAPTED_CHAPTERS) {
    for (const t of (TARGETS_BY_CHAPTER[chapter] || [])) {
      out.push({
        chapter,
        character: t.character,
        comment_pk: t.comment_pk,
        label: t.label,
        note: t.note
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const api = {
  adaptedChapters,
  isAdapted,
  findTarget,
  targetsForChapter,
  doNotAutoSwitchForChapter,
  missingOrAmbiguousForChapter,
  allTargets,
  // Exposed for tests / callers that need the raw tables.
  ADAPTED_CHAPTERS: ADAPTED_CHAPTERS.slice(),
  TARGETS_BY_CHAPTER,
  DO_NOT_AUTO_SWITCH,
  MISSING_OR_AMBIGUOUS
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_CHAPTER_ADAPT__ = api;

__cwb_modules["core/chapter_adapt"]=module.exports;
__cwb_modules["chapter_adapt"]=module.exports;
})();
// ---- core/influence ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// "已被玩家严重影响过" three-state evaluation.
// Implements Sol's testable criteria:
//   - SEVERE  : at least one effective major fact (7 categories)
//   - CLEAR   : record complete, all major-fact checks false, no manual exclusion
//   - UNKNOWN : record missing / not up to date / identity ambiguous / conflicting
//
// A fact counts only if it is: in the current save, clearly tied to the
// character, already happened/confirmed, not revoked, and has player agency.
// Plans, hypotheses, quoted lines, and merely reading the original story do
// NOT count as an effective player change.
//
// evaluateInfluence returns { status } where status is one of SEVERE/CLEAR/UNKNOWN.
// No paid model call is made here; callers pass already-extracted facts.

const SEVERE = 'severe';
const CLEAR = 'clear';
const UNKNOWN = 'unknown';

// The seven major-fact categories (Sol table).
const MAJOR_KINDS = Object.freeze({
  MAJOR_EXPERIENCE: 'major_experience', // 生死/复活/永久伤残/关键救援/长期囚禁/身份状态变化
  PERSISTENT_RELATION: 'persistent_relation', // 恋人/配偶/收养/师徒/正式结盟/持续敌对/背叛/决裂
  AFFECTION_STAGE: 'affection_stage', // 好感跨越现行阶段阈值
  FACTION_DUTY: 'faction_duty', // 阵营/效忠/长期职责/核心目标改变
  PERSONALITY_BELIEF: 'personality_belief', // 持续性格/价值判断/行为原则变化
  PLOT_DIRECTION: 'plot_direction', // 关键偏离事实改变后续行动前提
  PLAYER_RESERVED: 'player_reserved' // 玩家明确要求保留
});

const MAJOR_KIND_SET = new Set(Object.values(MAJOR_KINDS));

// Relation states that conflict with each other when both are "active".
// If a character has both a positive relation and a breakup/severance record
// that is not resolved, the record is contradictory -> UNKNOWN.
const RELATION_POSITIVE = new Set([
  '恋人', '配偶', '夫妻', '伴侣', '收养', '师徒', '正式结盟', '结盟', '盟友',
  'lover', 'spouse', 'partner', 'adopted', 'mentor', 'alliance', 'ally'
]);
const RELATION_NEGATIVE = new Set([
  '分手', '决裂', '背叛', '敌对', '断交', '解除', '离婚',
  'breakup', 'break_up', 'severed', 'betrayal', 'hostile', 'divorce'
]);

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// A fact is "effective" if it is confirmed, not revoked, and has player agency.
// Facts that are plans/hypotheses/quotes/reading-only are not effective.
function isEffectiveFact(fact) {
  if (!fact || typeof fact !== 'object') return false;
  if (fact.revoked === true) return false;
  if (fact.confirmed === false) return false;
  // Player agency required for a "player change".
  if (fact.player_agency === false) return false;
  // Plans / hypotheses / quotes / reading-only never count.
  if (fact.plan === true) return false;
  if (fact.hypothesis === true) return false;
  if (fact.quote_only === true) return false;
  if (fact.reading_only === true) return false;
  if (fact.kind === 'reading' || fact.kind === 'plan' || fact.kind === 'hypothesis') return false;
  return true;
}

function relationStateOf(fact) {
  if (!fact) return '';
  const raw = fact.relation_state != null ? fact.relation_state : fact.value;
  return trim(raw);
}

function isPositiveRelation(state) {
  return RELATION_POSITIVE.has(state);
}

function isNegativeRelation(state) {
  return RELATION_NEGATIVE.has(state);
}

// Detect contradictory persistent-relation facts for the same character:
// a positive relation and a negative/breakup record both active.
function hasConflictingRelations(facts) {
  let positive = false;
  let negative = false;
  for (const f of facts) {
    if (!f || f.kind !== MAJOR_KINDS.PERSISTENT_RELATION) continue;
    if (!isEffectiveFact(f)) continue;
    const st = relationStateOf(f);
    if (isPositiveRelation(st)) positive = true;
    if (isNegativeRelation(st)) negative = true;
  }
  return positive && negative;
}

// Affection: severe only if a stage threshold was actually crossed AND a
// scale/stage definition exists. If only a numeric change is recorded with no
// scale and no stage fields, it is UNKNOWN (cannot judge importance).
function affectionVerdict(fact) {
  if (!fact || fact.kind !== MAJOR_KINDS.AFFECTION_STAGE) return null;
  if (!isEffectiveFact(fact)) return null;
  const hasScale = isNonEmptyString(fact.scale) || isNonEmptyString(fact.scale_id);
  const hasStages = isNonEmptyString(fact.stage_before) || isNonEmptyString(fact.stage_after);
  const crossed = fact.crossed_stage === true ||
    (isNonEmptyString(fact.stage_before) && isNonEmptyString(fact.stage_after) &&
      trim(fact.stage_before) !== trim(fact.stage_after));
  if (!hasScale && !hasStages) {
    // No scale and no stage definition -> cannot judge -> UNKNOWN.
    return UNKNOWN;
  }
  if (crossed) return SEVERE;
  // Has scale/stages but did not cross -> not severe (small change).
  return null;
}

// Evaluate a single character's influence state.
// input: {
//   character_id,
//   record_complete: boolean,   // false/undefined => record missing
//   up_to_date: boolean,        // false => not processed to latest message
//   identity_ambiguous: boolean,
//   manual_excluded: boolean,   // player set to manual / reserved
//   facts: [ { kind, ... } ]
// }
function evaluateInfluence(input) {
  const rec = input || {};
  const facts = Array.isArray(rec.facts) ? rec.facts : [];

  // Manual exclusion / player reserved -> protected (severe-equivalent: no auto).
  if (rec.manual_excluded === true) {
    return { status: SEVERE, reason: 'manual_excluded' };
  }

  // Identity ambiguity -> UNKNOWN.
  if (rec.identity_ambiguous === true) {
    return { status: UNKNOWN, reason: 'identity_ambiguous' };
  }

  // Record missing or not up to date -> UNKNOWN (never treat "no archive" as clear).
  if (rec.record_complete !== true) {
    return { status: UNKNOWN, reason: 'record_missing' };
  }
  if (rec.up_to_date === false) {
    return { status: UNKNOWN, reason: 'not_up_to_date' };
  }

  // Conflicting persistent relations -> UNKNOWN before counting as severe.
  if (hasConflictingRelations(facts)) {
    return { status: UNKNOWN, reason: 'conflicting_relations' };
  }

  // Player reserved fact -> SEVERE.
  for (const f of facts) {
    if (f && f.kind === MAJOR_KINDS.PLAYER_RESERVED && isEffectiveFact(f)) {
      return { status: SEVERE, reason: 'player_reserved' };
    }
  }

  // Affection: may yield UNKNOWN (missing scale) or SEVERE (crossed).
  let affectionUnknown = false;
  for (const f of facts) {
    if (!f || f.kind !== MAJOR_KINDS.AFFECTION_STAGE) continue;
    const v = affectionVerdict(f);
    if (v === SEVERE) return { status: SEVERE, reason: 'affection_stage_crossed' };
    if (v === UNKNOWN) affectionUnknown = true;
  }

  // Other major kinds -> SEVERE if effective.
  const severeKinds = [
    MAJOR_KINDS.MAJOR_EXPERIENCE,
    MAJOR_KINDS.PERSISTENT_RELATION,
    MAJOR_KINDS.FACTION_DUTY,
    MAJOR_KINDS.PERSONALITY_BELIEF,
    MAJOR_KINDS.PLOT_DIRECTION
  ];
  for (const f of facts) {
    if (!f || !MAJOR_KIND_SET.has(f.kind)) continue;
    if (severeKinds.indexOf(f.kind) === -1) continue;
    if (isEffectiveFact(f)) {
      return { status: SEVERE, reason: f.kind };
    }
  }

  // Affection with missing scale but no other severe fact -> UNKNOWN.
  if (affectionUnknown) {
    return { status: UNKNOWN, reason: 'affection_scale_missing' };
  }

  // All checks false, record complete -> CLEAR.
  return { status: CLEAR, reason: 'no_major_evidence' };
}

// Convenience: should the auto flow touch this character?
function allowsAutoModification(status) {
  return status === CLEAR;
}

const api = {
  SEVERE,
  CLEAR,
  UNKNOWN,
  MAJOR_KINDS,
  evaluateInfluence,
  allowsAutoModification,
  isEffectiveFact,
  hasConflictingRelations
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_INFLUENCE__ = api;

__cwb_modules["core/influence"]=module.exports;
__cwb_modules["influence"]=module.exports;
})();
// ---- core/archive_protection ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Shared protection gate for automatic character-book switching.
//
// The design locks the following rules:
//   - A character that already has an independent entry (explicitly owned by
//     the current save) OR a live dynamic archive must never be auto-switched.
//   - `clear` / missing influence records cannot override that protection.
//   - `severe` / `unknown` / manual locks keep working as extra protection.
//   - The gate lives in ONE place so both the new `auto_switch` path and the
//     legacy `auto_toggle` / `plugin.autoToggleForSegment` path obey it.
//   - The gate is re-checked right before any write (isStillValid).
//
// "Independent entry" means an entry explicitly marked as belonging to the
// current save + character. It is NOT a base-book entry, NOT a keyword match,
// and NOT the automatic chapter copy performed by `Sidecar.setForm`.
// Explicit markers only:
//   - form.independent === true
//   - character.independent_entries = { [formId]: true } (or array of ids)
//
// "Dynamic archive exists" means the character has been initialized or has
// real dynamic content (events / relationship / personality delta / archive
// status). An `emptyDynamic()` shell does NOT count.

const { trim } = require('./keys.js');

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// Normalize a dynamic record to a boolean "has real content" answer.
// Accepts the shape produced by Compiler.emptyDynamic()/normalizeDynamic().
function dynamicHasContent(dyn) {
  if (!dyn) return false;
  if (typeof dyn !== 'object') return false;
  if (dyn.initialized === true) return true;
  if (dyn.archive_status && String(dyn.archive_status) !== 'empty') return true;
  if (dyn.personality_delta && String(dyn.personality_delta).trim()) return true;
  if (dyn.relationship && String(dyn.relationship).trim()) return true;
  if (dyn.affection != null && dyn.affection !== '') return true;
  const events = dyn.non_canon_events;
  if (Array.isArray(events) && events.length > 0) return true;
  if (typeof events === 'string' && events.trim()) return true;
  if (isPlainObject(events) && Object.keys(events).length > 0) return true;
  if (Array.isArray(dyn.actions) && dyn.actions.length > 0) return true;
  if (isPlainObject(dyn.actions) && Object.keys(dyn.actions).length > 0) return true;
  return false;
}

// Collect explicit independent-entry markers for a character record.
// Returns an array of form ids (strings). Never guesses from names.
function independentEntryIds(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const s = trim(id);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const forms = rec.forms && typeof rec.forms === 'object' ? rec.forms : {};
  for (const fid of Object.keys(forms)) {
    const form = forms[fid];
    if (form && form.independent === true) push(fid);
  }
  const marker = rec.independent_entries;
  if (Array.isArray(marker)) {
    for (const id of marker) push(id);
  } else if (isPlainObject(marker)) {
    for (const id of Object.keys(marker)) {
      if (marker[id]) push(id);
    }
  }
  return out;
}

function hasIndependentEntry(rec) {
  return independentEntryIds(rec).length > 0;
}

// Resolve the dynamic record for a character. Prefers the active timeline,
// then 'main', then any timeline that has real content.
function activeDynamicOf(rec) {
  if (!rec || !rec.dynamic || typeof rec.dynamic !== 'object') return null;
  const tid = rec.active_timeline || 'main';
  if (rec.dynamic[tid]) return rec.dynamic[tid];
  if (rec.dynamic.main) return rec.dynamic.main;
  for (const k of Object.keys(rec.dynamic)) {
    if (dynamicHasContent(rec.dynamic[k])) return rec.dynamic[k];
  }
  return null;
}

function hasDynamicArchive(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.dynamic && typeof rec.dynamic === 'object') {
    for (const k of Object.keys(rec.dynamic)) {
      if (dynamicHasContent(rec.dynamic[k])) return true;
    }
  }
  const st = rec.archive_status;
  if (st && typeof st === 'object') {
    const status = st.status;
    if (typeof status === 'string' && status !== '' && status !== 'empty') return true;
  }
  return false;
}

// Build a protection verdict for a single character record.
// Returns { protected: boolean, reasons: string[], independent: boolean,
//           dynamic: boolean, pending: string[] }.
// `reasons` are stable machine tokens; `pending` lists archive gaps that
// must be surfaced to the player (but never unlock auto switching).
function protectionFor(rec) {
  const independent = hasIndependentEntry(rec);
  const dynamic = hasDynamicArchive(rec);
  const reasons = [];
  const pending = [];
  if (independent) reasons.push('independent_entry');
  if (dynamic) reasons.push('dynamic_archive');
  if (independent && !dynamic) pending.push('archive_uninitialized');
  if (dynamic && !independent) pending.push('independent_link_missing');
  return {
    protected: independent || dynamic,
    reasons,
    independent,
    dynamic,
    pending
  };
}

// Resolve a character record from a sidecar store by name or id.
// Matches canonical_name, name, aliases, or the store key. Exact only.
function findCharacterRecord(store, nameOrId) {
  const key = trim(nameOrId);
  if (!key || !store || !store.characters) return null;
  const chars = store.characters;
  if (chars[key]) return chars[key];
  for (const id of Object.keys(chars)) {
    const rec = chars[id];
    if (!rec) continue;
    if (trim(rec.canonical_name) === key) return rec;
    if (trim(rec.name) === key) return rec;
    if (Array.isArray(rec.aliases) && rec.aliases.some(a => trim(a) === key)) return rec;
  }
  return null;
}

// Normalize the influence status the same way auto_switch does, so the
// protection gate and the legacy influence gate agree on `clear`.
function influenceStatusOf(inf) {
  if (inf == null) return 'clear';
  if (typeof inf === 'string') return inf;
  if (typeof inf === 'object') {
    if (inf.status) return String(inf.status);
    if (inf.severe) return 'severe';
    if (inf.unknown) return 'unknown';
    if (inf.manual) return 'manual';
    if (inf.locked) return 'manual';
    return 'clear';
  }
  return 'clear';
}

// Full gate used by both auto paths.
// input: {
//   name, store, influenceByCharacter, manual,
//   allowsAutoModification?: fn(status) -> boolean
// }
// Returns { allowed, protected, reasons, pending, status, manual }.
function evaluateProtection(input) {
  const opts = input || {};
  const name = trim(opts.name);
  const store = opts.store || null;
  const influenceByCharacter = opts.influenceByCharacter || {};
  const manual = opts.manual || {};
  const allows = typeof opts.allowsAutoModification === 'function'
    ? opts.allowsAutoModification
    : (status) => status !== 'severe' && status !== 'unknown' && status !== 'manual';

  const out = {
    name,
    allowed: true,
    protected: false,
    reasons: [],
    pending: [],
    status: 'clear',
    manual: false
  };
  if (!name) {
    out.allowed = false;
    out.protected = true;
    out.reasons.push('empty_name');
    return out;
  }

  // Manual lock (explicit player choice) always protects.
  const mrec = manual[name];
  if (mrec === true || (mrec && typeof mrec === 'object' && (mrec.locked === true || mrec.manual === true))) {
    out.manual = true;
    out.protected = true;
    out.reasons.push('manual');
  }

  // Influence status (severe / unknown / manual) keeps protecting.
  const status = influenceStatusOf(influenceByCharacter[name]);
  out.status = status;
  if (!allows(status)) {
    out.protected = true;
    if (!out.reasons.includes(status)) out.reasons.push(status);
  }

  // Independent entry / dynamic archive protection.
  const rec = findCharacterRecord(store, name);
  if (rec) {
    const p = protectionFor(rec);
    if (p.protected) {
      out.protected = true;
      for (const r of p.reasons) if (!out.reasons.includes(r)) out.reasons.push(r);
      for (const r of p.pending) if (!out.pending.includes(r)) out.pending.push(r);
    }
  }

  out.allowed = !out.protected;
  return out;
}

// Convenience: does this character have any archive protection?
function isArchiveProtected(store, nameOrId) {
  const rec = findCharacterRecord(store, nameOrId);
  if (!rec) return false;
  return protectionFor(rec).protected;
}

// Re-check helper for apply-time validation. Given a plan item and the
// current store/manual/influence, returns true when the item is still safe
// to write. Used as the default `isStillValid` guard.
function stillValidForWrite(item, ctx) {
  const c = ctx || {};
  const name = trim(item && (item.name || item.canonical_name));
  if (!name) return false;
  const verdict = evaluateProtection({
    name,
    store: c.store,
    influenceByCharacter: c.influenceByCharacter,
    manual: c.manual,
    allowsAutoModification: c.allowsAutoModification
  });
  return verdict.allowed;
}

const api = {
  dynamicHasContent,
  independentEntryIds,
  hasIndependentEntry,
  activeDynamicOf,
  hasDynamicArchive,
  protectionFor,
  findCharacterRecord,
  influenceStatusOf,
  evaluateProtection,
  isArchiveProtected,
  stillValidForWrite
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_ARCHIVE_PROTECTION__ = api;

__cwb_modules["core/archive_protection"]=module.exports;
__cwb_modules["archive_protection"]=module.exports;
})();
// ---- core/archive_scope ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Archive scope: every write must be bound to the current card + current chat
// (save) and its dedicated worldbook copy. Cross-save async results are
// rejected. The base worldbook is read-only.

const { trim } = require('./keys.js');

function stableCardId(card) {
  if (!card || typeof card !== 'object') return '';
  return trim(card.avatar || card.card_id || card.character_id || card.name || '');
}

function stableChatId(chat) {
  if (chat == null) return '';
  if (typeof chat === 'string') return trim(chat);
  if (typeof chat !== 'object') return '';
  return trim(chat.chat_id || chat.chatId || chat.id || chat.file_name || chat.fileName || '');
}

function stableCopyId(copy) {
  if (copy == null) return '';
  if (typeof copy === 'string') return trim(copy);
  if (typeof copy !== 'object') return '';
  return trim(copy.copy_id || copy.copyId || copy.worldbook_id || copy.worldbookId || copy.name || '');
}

function makeScopeKey(card, chat, copy) {
  const c = stableCardId(card);
  const s = stableChatId(chat);
  const p = stableCopyId(copy);
  if (!c || !s) return '';
  return [c, s, p].join('::');
}

function createArchiveScope(options) {
  const opts = options || {};
  const getCard = typeof opts.getCard === 'function' ? opts.getCard : () => opts.card;
  const getChat = typeof opts.getChat === 'function' ? opts.getChat : () => opts.chat;
  const getCopy = typeof opts.getCopy === 'function' ? opts.getCopy : () => opts.copy;
  const isBaseWorldbook = typeof opts.isBaseWorldbook === 'function'
    ? opts.isBaseWorldbook
    : (wb) => !!(wb && (wb.is_base || wb.isBase || wb.read_only || wb.readOnly));

  let bound = null;
  let generation = 0;
  const pending = new Set();

  function currentIdentity() {
    return {
      card: getCard(),
      chat: getChat(),
      copy: getCopy()
    };
  }

  function bind() {
    const id = currentIdentity();
    const key = makeScopeKey(id.card, id.chat, id.copy);
    if (!key) {
      bound = null;
      generation += 1;
      return { ok: false, reason: 'incomplete_identity', identity: id };
    }
    if (bound && bound.key === key) {
      return { ok: true, key, generation, identity: id, reused: true };
    }
    bound = { key, generation: generation + 1, identity: id };
    generation = bound.generation;
    // Any in-flight work from the previous binding is now stale.
    pending.clear();
    return { ok: true, key, generation, identity: id, reused: false };
  }

  function isBound() {
    return !!bound;
  }

  function currentKey() {
    return bound ? bound.key : '';
  }

  function assertWritable(target) {
    if (!bound) return { ok: false, reason: 'not_bound' };
    const id = currentIdentity();
    const key = makeScopeKey(id.card, id.chat, id.copy);
    if (!key) return { ok: false, reason: 'incomplete_identity' };
    if (key !== bound.key) return { ok: false, reason: 'scope_changed' };
    if (target && isBaseWorldbook(target)) return { ok: false, reason: 'base_read_only' };
    return { ok: true, key };
  }

  // Begin an async operation. Returns a token that must be validated before
  // committing the result. If the scope changes in between, commit is refused.
  function beginAsync(label) {
    if (!bound) return { ok: false, reason: 'not_bound' };
    const token = {
      label: trim(label) || 'async',
      key: bound.key,
      generation,
      settled: false
    };
    pending.add(token);
    return { ok: true, token };
  }

  function commitAsync(token, apply) {
    if (!token || token.settled) return { ok: false, reason: 'token_settled' };
    token.settled = true;
    pending.delete(token);
    if (!bound) return { ok: false, reason: 'not_bound' };
    if (token.key !== bound.key || token.generation !== generation) {
      return { ok: false, reason: 'stale_scope' };
    }
    if (typeof apply !== 'function') return { ok: false, reason: 'no_apply' };
    const result = apply();
    return { ok: true, result };
  }

  function abortAsync(token) {
    if (!token || token.settled) return false;
    token.settled = true;
    pending.delete(token);
    return true;
  }

  function pendingCount() {
    return pending.size;
  }

  function reset() {
    bound = null;
    generation += 1;
    pending.clear();
  }

  return {
    bind,
    isBound,
    currentKey,
    assertWritable,
    beginAsync,
    commitAsync,
    abortAsync,
    pendingCount,
    reset,
    _currentIdentity: currentIdentity
  };
}

module.exports = {
  stableCardId,
  stableChatId,
  stableCopyId,
  makeScopeKey,
  createArchiveScope
};

__cwb_modules["core/archive_scope"]=module.exports;
__cwb_modules["archive_scope"]=module.exports;
})();
// ---- core/auto_toggle ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Story Auto-Toggle on the sparse Copy Worldbook.
// Set = this-segment speakers + focus characters + names that uniquely
// match a comment primary key. Hard cap 8. Exact PK only.
// Copy-priority with read-only base fallback. A newer base form is
// surfaced as a non-destructive prompt — never silently overwrite the
// dynamic layer or mutate the base book.
//
// Archive protection (independent entry / dynamic archive) is enforced here
// as well, so the legacy path (no chapter) cannot bypass it.

const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);
const Hash = (typeof require === 'function' && require('./hash')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_HASH__);
const ArchiveProtection = (typeof require === 'function' && require('./archive_protection')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_ARCHIVE_PROTECTION__);

const AUTO_TOGGLE_CAP = 8;

function uniquePush(list, item, keyFn) {
  const key = keyFn(item);
  if (list.some(x => keyFn(x) === key)) return;
  list.push(item);
}

// options (additive, optional):
//   store: sidecar store for archive protection
//   influenceByCharacter: { [name]: status }
//   manual: { [name]: true | { locked } }
//   allowsAutoModification: fn(status) -> boolean
function planAutoToggle(spec, catalog, sidecarCharacters, options) {
  const s = spec || {};
  const opts = options || {};
  const cap = s.cap != null ? s.cap : AUTO_TOGGLE_CAP;
  const report = [];
  const planned = [];
  const protectedList = [];

  function isProtected(name) {
    if (!ArchiveProtection || typeof ArchiveProtection.evaluateProtection !== 'function') return null;
    const verdict = ArchiveProtection.evaluateProtection({
      name,
      store: opts.store || null,
      influenceByCharacter: opts.influenceByCharacter || {},
      manual: opts.manual || {},
      allowsAutoModification: opts.allowsAutoModification
    });
    return verdict.allowed ? null : verdict;
  }

  function consider(selector, via) {
    if (selector.entry_id != null || selector.comment_pk) {
      // Exact PK path: look up which character owns this form.
      let hit = null;
      for (const rec of catalog || []) {
        const forms = rec.forms || rec.states || [];
        const form = forms.find(f => Keys.exactEntryMatch(f, selector));
        if (form) { hit = { character: rec, form, via }; break; }
      }
      if (!hit) {
        report.push({ action: 'skip', reason: 'no_exact_pk', via, selector });
        return;
      }
      const name = hit.character.canonical_name || hit.character.name;
      const verdict = isProtected(name);
      if (verdict) {
        protectedList.push({ name, reason: verdict.reasons[0] || 'protected', reasons: verdict.reasons.slice(), via });
        return;
      }
      uniquePush(planned, {
        character_id: hit.character.character_id || hit.character.actor_id,
        canonical_name: hit.character.canonical_name,
        entry_id: hit.form.entry_id != null ? hit.form.entry_id : hit.form.source_uid,
        comment_pk: hit.form.comment_pk || Keys.commentPk(hit.form),
        via
      }, x => String(x.character_id) + '::' + String(x.entry_id));
      return;
    }
    if (selector.name) {
      const resolved = Keys.resolveUniqueName(selector.name, catalog);
      if (!resolved.ok) {
        report.push({ action: 'skip', reason: resolved.reason, via, name: selector.name, candidates: resolved.candidates });
        return;
      }
      const rec = resolved.character;
      const name = rec.canonical_name || rec.name || selector.name;
      const verdict = isProtected(name);
      if (verdict) {
        protectedList.push({ name, reason: verdict.reasons[0] || 'protected', reasons: verdict.reasons.slice(), via });
        return;
      }
      const formSel = selector.form || (rec.forms && rec.forms[0]) || (rec.states && rec.states[0]);
      const form = formSel && (formSel.entry_id != null || formSel.comment_pk)
        ? (rec.forms || rec.states || []).find(f => Keys.exactEntryMatch(f, formSel)) || formSel
        : formSel;
      if (!form || (form.entry_id == null && form.source_uid == null && !form.comment_pk)) {
        report.push({ action: 'skip', reason: 'no_unique_form', via, name: selector.name });
        return;
      }
      uniquePush(planned, {
        character_id: rec.character_id || rec.actor_id,
        canonical_name: rec.canonical_name,
        entry_id: form.entry_id != null ? form.entry_id : form.source_uid,
        comment_pk: form.comment_pk || Keys.commentPk(form),
        via
      }, x => String(x.character_id) + '::' + String(x.entry_id));
    }
  }

  for (const id of s.focus_entry_ids || s.desired_entry_ids || []) {
    consider({ entry_id: id }, 'focus_entry');
  }
  for (const id of s.focus_actor_ids || []) {
    const rec = (catalog || []).find(c => String(c.character_id || c.actor_id) === String(id));
    if (!rec) { report.push({ action: 'skip', reason: 'unknown_actor', via: 'focus_actor', character_id: id }); continue; }
    const states = rec.forms || rec.states || [];
    const form = s.actor_forms && s.actor_forms[id]
      ? states.find(f => Keys.exactEntryMatch(f, s.actor_forms[id]))
      : states[0];
    if (!form) { report.push({ action: 'skip', reason: 'no_unique_form', via: 'focus_actor', character_id: id }); continue; }
    consider({ entry_id: form.entry_id != null ? form.entry_id : form.source_uid, comment_pk: form.comment_pk }, 'focus_actor');
  }
  for (const name of s.speakers || []) consider({ name }, 'speaker');
  for (const name of s.unique_names || []) consider({ name }, 'unique_name');

  const excluded = s.excluded_keys || [];
  function plotExcluded(item) {
    return excluded.some(ex => {
      if (!ex) return false;
      if (ex.entry_id != null && String(ex.entry_id) === String(item.entry_id)) return true;
      if (ex.comment_pk && ex.comment_pk === item.comment_pk) return true;
      return false;
    });
  }
  const held = planned.filter(plotExcluded).map(p => ({ action: 'skip', reason: 'plot_excluded', ...p }));
  const eligible = planned.filter(item => !plotExcluded(item));
  const capped = eligible.slice(0, cap);
  const overflow = eligible.slice(cap).map(p => ({ action: 'skip', reason: 'cap', ...p }));
  const warning = overflow.length ? {
    kind: 'auto_toggle_cap',
    cap,
    skipped: overflow.length,
    message: '自动开关一次最多写入 ' + cap + ' 条精确主键，另有 ' + overflow.length + ' 条未写入。'
  } : null;
  return {
    enable: capped,
    skipped: report.concat(held, overflow),
    protected: protectedList,
    cap,
    uncapped_count: planned.length,
    warning
  };
}

function evaluateCopyPriority(item, sidecarCharacters, baseFormsByEntry) {
  const rec = sidecarCharacters && sidecarCharacters[item.character_id];
  if (!rec) {
    return {
      ...item,
      action: 'base_fallback',
      reason: 'not_in_clone',
      copy: false,
      prompt: null
    };
  }
  const formId = String(item.entry_id);
  const cloneForm = rec.forms && (rec.forms[formId] || Object.values(rec.forms).find(f => String(f.source_uid) === formId || String(f.entry_id) === formId));
  if (!cloneForm) {
    return {
      ...item,
      action: 'base_fallback',
      reason: 'form_not_in_clone',
      copy: false,
      prompt: null
    };
  }
  const base = baseFormsByEntry && (baseFormsByEntry[formId] || baseFormsByEntry[String(cloneForm.source_uid)]);
  const baseHash = base ? (base.content_hash || Hash.hashContent(base.content || '')) : null;
  const cloneHash = cloneForm.content_hash || Hash.hashContent(cloneForm.content || '');
  if (baseHash && cloneHash && baseHash !== cloneHash) {
    return {
      ...item,
      action: 'stale_prompt',
      reason: 'base_form_newer',
      copy: true,
      use_clone: true,
      prompt: {
        kind: 'newer_form',
        character_id: item.character_id,
        canonical_name: item.canonical_name || rec.canonical_name,
        message: '底板中「' + (rec.canonical_name || item.character_id) + '」的形态正文已更新。不会自动覆盖本存档的动态层；如需同步请在管理面板执行「从底板复制形态正文」。',
        base_hash: baseHash,
        clone_hash: cloneHash
      }
    };
  }
  return {
    ...item,
    action: 'use_clone',
    reason: 'hash_match',
    copy: true,
    use_clone: true,
    prompt: null
  };
}

function applyAutoToggle(plan, sidecarCharacters, baseFormsByEntry) {
  const results = [];
  const prompts = [];
  for (const item of (plan && plan.enable) || []) {
    const ev = evaluateCopyPriority(item, sidecarCharacters, baseFormsByEntry);
    results.push(ev);
    if (ev.prompt) prompts.push(ev.prompt);
  }
  return {
    results,
    prompts,
    clone_writes: 1, // one paragraph commit writes the clone book at most once (caller performs it)
    base_writes: 0,
    dynamic_overwrites: 0
  };
}

const api = { AUTO_TOGGLE_CAP, planAutoToggle, evaluateCopyPriority, applyAutoToggle };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_AUTO_TOGGLE__ = api;

__cwb_modules["core/auto_toggle"]=module.exports;
__cwb_modules["auto_toggle"]=module.exports;
})();
// ---- core/auto_switch ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Automatic per-character switching for adapted chapters.
// - Only writes to the current save's dedicated copy (never the base book).
// - Respects influence protection (severe/unknown/manual => skip).
// - Respects archive protection (independent entry / dynamic archive => skip).
// - Manual choices win over late automatic writes.
// - AUTO_TOGGLE_CAP is a per-batch write cap; overflow is reported, never
//   silently truncated.

const { trim, commentPk } = require('./keys.js');
const { findTarget, isAdapted } = require('./chapter_adapt.js');
const { allowsAutoModification } = require('./influence.js');
const ArchiveProtection = require('./archive_protection.js');

const AUTO_TOGGLE_CAP = 8;

function normalizeManual(manual) {
  if (!manual || typeof manual !== 'object') return {};
  const out = {};
  for (const k of Object.keys(manual)) out[trim(k)] = manual[k];
  return out;
}

function isManualLocked(manual, characterName) {
  const m = normalizeManual(manual);
  const rec = m[trim(characterName)];
  if (!rec) return false;
  if (rec === true) return true;
  if (typeof rec === 'object') return rec.locked === true || rec.manual === true;
  return false;
}

function manualFormOf(manual, characterName) {
  const m = normalizeManual(manual);
  const rec = m[trim(characterName)];
  if (rec && typeof rec === 'object' && rec.comment_pk) return trim(rec.comment_pk);
  return '';
}

// Normalize an influence record to the status string that
// allowsAutoModification expects. Accepts:
//   - undefined / null  -> 'clear' (new save, no facts => auto candidate)
//   - string            -> itself
//   - { status }        -> status
//   - { severe: true }  -> 'severe'
//   - { unknown: true } -> 'unknown'
//   - { manual: true }  -> 'manual'
function influenceStatusOf(inf) {
  return ArchiveProtection.influenceStatusOf(inf);
}

// sceneCharacters: [{ name, needed?: boolean }]
// influenceByCharacter: { [name]: { status } | string }
// currentForms: { [name]: comment_pk }
// store: optional sidecar store for archive protection
function planAutoSwitch(input) {
  const opts = input || {};
  const chapter = trim(opts.chapter);
  const sceneCharacters = Array.isArray(opts.sceneCharacters) ? opts.sceneCharacters : [];
  const influenceByCharacter = opts.influenceByCharacter || {};
  const currentForms = opts.currentForms || {};
  const manual = opts.manual || {};
  const catalog = opts.catalog;
  const store = opts.store || null;

  const result = {
    chapter,
    adapted: isAdapted(chapter),
    switched: [],
    unchanged: [],
    protected: [],
    missing: [],
    failed: [],
    overflow: [],
    cap: AUTO_TOGGLE_CAP
  };

  if (!result.adapted) {
    result.reason = 'chapter_not_adapted';
    return result;
  }

  const candidates = [];
  for (const sc of sceneCharacters) {
    const name = trim(sc && (sc.name || sc.character_name));
    if (!name) continue;
    if (sc && sc.needed === false) continue;

    // Shared protection gate: manual + influence + archive.
    const verdict = ArchiveProtection.evaluateProtection({
      name,
      store,
      influenceByCharacter,
      manual,
      allowsAutoModification
    });
    if (!verdict.allowed) {
      const entry = { name, reason: verdict.reasons[0] || 'protected', reasons: verdict.reasons.slice() };
      if (verdict.pending.length) entry.pending = verdict.pending.slice();
      if (verdict.manual) entry.manual = true;
      result.protected.push(entry);
      continue;
    }

    const target = findTarget(name, chapter, catalog);
    if (!target || !target.ok) {
      result.missing.push({ name, reason: (target && target.reason) || 'no_target' });
      continue;
    }

    const manualPk = manualFormOf(manual, name);
    if (manualPk) {
      result.protected.push({ name, reason: 'manual_form', comment_pk: manualPk });
      continue;
    }

    const current = trim(currentForms[name]);
    if (current && current === trim(target.comment_pk)) {
      result.unchanged.push({ name, comment_pk: target.comment_pk });
      continue;
    }

    candidates.push({ name, comment_pk: target.comment_pk, target });
  }

  const accepted = candidates.slice(0, AUTO_TOGGLE_CAP);
  const overflow = candidates.slice(AUTO_TOGGLE_CAP);
  result.switched = accepted;
  result.overflow = overflow.map(c => ({ name: c.name, comment_pk: c.comment_pk }));
  if (overflow.length > 0) {
    result.overflowNotice = {
      cap: AUTO_TOGGLE_CAP,
      total: candidates.length,
      applied: accepted.length,
      remaining: overflow.length,
      message: `本批最多自动切换 ${AUTO_TOGGLE_CAP} 个角色，剩余 ${overflow.length} 个未处理，请分批或手动处理。`
    };
  }
  return result;
}

// Apply a plan against a writer. writer must expose:
//   setEntryEnabled(comment_pk, enabled) -> { ok, error? }
//   getEntryEnabled(comment_pk) -> boolean
//   isWritable() -> boolean
// options.isStillValid(item) -> boolean  (re-checked before each write)
// options.store / influenceByCharacter / manual  (for default re-check)
function applyAutoSwitch(plan, writer, options) {
  const opts = options || {};
  const out = {
    applied: [],
    failed: [],
    skipped: [],
    overflow: plan && plan.overflow ? plan.overflow.slice() : [],
    overflowNotice: plan && plan.overflowNotice ? plan.overflowNotice : null
  };
  if (!plan || !plan.adapted) {
    out.skipped.push({ reason: 'chapter_not_adapted' });
    return out;
  }
  if (!writer || typeof writer.isWritable !== 'function' || !writer.isWritable()) {
    out.failed.push({ reason: 'not_writable' });
    return out;
  }
  const guard = typeof opts.isStillValid === 'function' ? opts.isStillValid : () => true;
  const ctx = {
    store: opts.store || null,
    influenceByCharacter: opts.influenceByCharacter || {},
    manual: opts.manual || {},
    allowsAutoModification
  };

  for (const item of plan.switched || []) {
    if (!guard(item)) {
      out.skipped.push({ name: item.name, reason: 'stale' });
      continue;
    }
    // Re-check archive protection right before the write.
    if (!ArchiveProtection.stillValidForWrite(item, ctx)) {
      out.skipped.push({ name: item.name, reason: 'protected' });
      continue;
    }
    try {
      const r = writer.setEntryEnabled(item.comment_pk, true);
      if (r && r.ok === false) {
        out.failed.push({ name: item.name, comment_pk: item.comment_pk, error: r.error || 'write_failed' });
      } else {
        out.applied.push({ name: item.name, comment_pk: item.comment_pk });
      }
    } catch (err) {
      out.failed.push({ name: item.name, comment_pk: item.comment_pk, error: String(err && err.message || err) });
    }
  }
  return out;
}

module.exports = {
  AUTO_TOGGLE_CAP,
  isManualLocked,
  manualFormOf,
  influenceStatusOf,
  planAutoSwitch,
  applyAutoSwitch
};

__cwb_modules["core/auto_switch"]=module.exports;
__cwb_modules["auto_switch"]=module.exports;
})();
// ---- core/character_actions ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// ASTER 切片 2 / 任务 5：角色行动整理。
// 与十四段共享有效事实；失败不记成功；承诺未兑现不记完成。

const sidecar = require('./sidecar.js');

const RESULT_KINDS = ['完成', '失败', '受阻', '未决'];

function normalizeResult(result) {
  const r = typeof result === 'string' ? result.trim() : '';
  return RESULT_KINDS.indexOf(r) >= 0 ? r : '未决';
}

function buildActionRecord(input, context) {
  const src = input && typeof input === 'object' ? input : {};
  const ctx = context && typeof context === 'object' ? context : {};
  return {
    character_id: ctx.characterId != null ? String(ctx.characterId) : null,
    situation: typeof src.situation === 'string' ? src.situation.trim() : '',
    behavior: typeof src.behavior === 'string' ? src.behavior.trim() : '',
    target: typeof src.target === 'string' ? src.target.trim() : '',
    result: normalizeResult(src.result),
    known_info: typeof src.known_info === 'string' ? src.known_info.trim() : '',
    promise: typeof src.promise === 'string' ? src.promise.trim() : '',
    lasting_effect: typeof src.lasting_effect === 'string' ? src.lasting_effect.trim() : '',
    related_facts: Array.isArray(src.related_facts) ? src.related_facts.slice() : [],
    source_message_id: ctx.messageId != null ? String(ctx.messageId) : null,
    source_branch_id: ctx.branchId != null ? String(ctx.branchId) : null,
    source_chat_id: ctx.chatId != null ? String(ctx.chatId) : null,
    sequence: ctx.sequence != null ? Number(ctx.sequence) : null,
    idempotency_key: ctx.idempotencyKey || null
  };
}

function hasActionWithKey(sidecarObj, characterId, idempotencyKey) {
  const list = sidecar.actionList(sidecarObj, characterId);
  if (!idempotencyKey) return false;
  return list.some(a => a && a.idempotency_key === idempotencyKey);
}

function appendActions(sidecarObj, characterId, actions, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const appended = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    const record = buildActionRecord(a, Object.assign({ characterId }, ctx));
    if (!record.situation && !record.behavior) continue;
    if (record.idempotency_key && hasActionWithKey(sidecarObj, characterId, record.idempotency_key)) continue;
    const entry = sidecar.appendAction(sidecarObj, characterId, record);
    if (entry) appended.push(entry);
  }
  return appended;
}

function invalidateForBranch(sidecarObj, characterId, messageId, branchId, reason) {
  return sidecar.invalidateActionsByMessage(sidecarObj, characterId, messageId, branchId, reason || 'branch_replaced');
}

function invalidateAfterRollback(sidecarObj, characterId, rollbackPoint) {
  return sidecar.invalidateActionsAfterRollback(sidecarObj, characterId, rollbackPoint);
}

function listEffective(sidecarObj, characterId) {
  return sidecar.actionList(sidecarObj, characterId);
}

module.exports = {
  RESULT_KINDS,
  normalizeResult,
  buildActionRecord,
  appendActions,
  invalidateForBranch,
  invalidateAfterRollback,
  listEffective
};

__cwb_modules["core/character_actions"]=module.exports;
__cwb_modules["character_actions"]=module.exports;
})();
// ---- core/summary_ingest ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// ASTER 切片 2 / 任务 3-4：可见生成结果中的机器可读摘要解析与增量嵌合。
// 约定：可见回复末尾可携带
//   <!--ARK_ARCHIVE_SUMMARY
//   { "characters": [ { "character_id": "...", "no_change": false, "sections": {...}, "actions": [...] } ] }
//   -->
// 边界必须能从原始完整结果读取，不依赖渲染后可见正文。

const SUMMARY_OPEN = '<!--ARK_ARCHIVE_SUMMARY';
const SUMMARY_CLOSE = '-->';

const SECTION_TITLES = [
  '基本信息', '外貌', '服装', '武器', '特点', '源石技艺', '能力',
  '喜欢', '讨厌', '经历', '人际关系', '语言示例', '秘密', '备注'
];

const PRIMARY_SECTIONS = ['经历', '人际关系', '特点', '备注'];

const INTERNAL_SOURCES = new Set([
  'internal', 'generateRaw', 'generateraw', 'design', 'summarize', 'summary', 'merge', 'timeline_merge'
]);

function isInternalSource(source) {
  if (source == null) return false;
  return INTERNAL_SOURCES.has(String(source));
}

function extractSummaryBlock(rawText) {
  if (typeof rawText !== 'string' || !rawText) return { ok: false, reason: 'empty' };
  const open = rawText.lastIndexOf(SUMMARY_OPEN);
  if (open < 0) return { ok: false, reason: 'missing' };
  const afterOpen = rawText.indexOf(SUMMARY_CLOSE, open + SUMMARY_OPEN.length);
  if (afterOpen < 0) return { ok: false, reason: 'unterminated' };
  const body = rawText.slice(open + SUMMARY_OPEN.length, afterOpen).trim();
  if (!body) return { ok: false, reason: 'empty_body' };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { ok: false, reason: 'bad_json', error: e.message };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad_shape' };
  return { ok: true, data: parsed, raw: body, start: open, end: afterOpen + SUMMARY_CLOSE.length };
}

function normalizeSectionName(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  return SECTION_TITLES.indexOf(t) >= 0 ? t : null;
}

function normalizeSections(sections) {
  const out = {};
  if (!sections || typeof sections !== 'object') return out;
  for (const key of Object.keys(sections)) {
    const title = normalizeSectionName(key);
    if (!title) continue;
    const v = sections[key];
    if (v == null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out[title] = s;
    } else if (Array.isArray(v)) {
      const arr = v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      if (arr.length) out[title] = arr;
    }
  }
  return out;
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const situation = typeof a.situation === 'string' ? a.situation.trim() : '';
    const behavior = typeof a.behavior === 'string' ? a.behavior.trim() : '';
    if (!situation && !behavior) continue;
    const result = typeof a.result === 'string' ? a.result.trim() : '';
    const resultKind = ['完成', '失败', '受阻', '未决'].indexOf(result) >= 0 ? result : '未决';
    out.push({
      situation,
      behavior,
      target: typeof a.target === 'string' ? a.target.trim() : '',
      result: resultKind,
      known_info: typeof a.known_info === 'string' ? a.known_info.trim() : '',
      promise: typeof a.promise === 'string' ? a.promise.trim() : '',
      lasting_effect: typeof a.lasting_effect === 'string' ? a.lasting_effect.trim() : '',
      related_facts: Array.isArray(a.related_facts) ? a.related_facts.slice() : []
    });
  }
  return out;
}

// 校验归属：只允许已确认关联的角色 id。
function resolveCharacterId(entry, allowedIds) {
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.character_id != null ? String(entry.character_id) : null;
  if (!id) return null;
  if (allowedIds && allowedIds.size > 0 && !allowedIds.has(id)) return null;
  return id;
}

function parseArchiveSummary(rawText, options) {
  const r = parseAndValidate(rawText, options);
  if (!r.ok) return r;
  return { ok: true, characters: r.accepted, rejected: r.rejected, block: r.block };
}

function buildIdempotencyKey(chatId, messageId, branchId) {
  return [String(chatId == null ? '' : chatId), String(messageId == null ? '' : messageId), String(branchId == null ? '' : branchId)].join('|');
}

// 将增量嵌合进现有动态层。不覆盖底板，不改固定标题。
function mergeIncrement(existingDynamic, sections) {
  const base = existingDynamic && typeof existingDynamic === 'object' ? existingDynamic : {};
  const out = Object.assign({}, base);
  for (const title of Object.keys(sections)) {
    const inc = sections[title];
    const prev = out[title];
    if (Array.isArray(inc)) {
      const prevArr = Array.isArray(prev) ? prev.slice() : (typeof prev === 'string' && prev ? [prev] : []);
      const seen = new Set(prevArr.map(x => String(x)));
      for (const item of inc) {
        const s = String(item);
        if (!seen.has(s)) { prevArr.push(s); seen.add(s); }
      }
      out[title] = prevArr;
    } else if (typeof inc === 'string') {
      if (typeof prev === 'string' && prev.trim()) {
        if (prev.indexOf(inc) >= 0) {
          out[title] = prev;
        } else {
          out[title] = prev + '\n' + inc;
        }
      } else if (Array.isArray(prev)) {
        if (prev.map(x => String(x)).indexOf(inc) < 0) out[title] = prev.concat([inc]);
        else out[title] = prev;
      } else {
        out[title] = inc;
      }
    }
  }
  return out;
}

function parseAndValidate(rawText, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const allowedIds = opts.allowedCharacterIds instanceof Set
    ? opts.allowedCharacterIds
    : new Set(Array.isArray(opts.allowedCharacterIds) ? opts.allowedCharacterIds.map(String) : []);
  const block = extractSummaryBlock(rawText);
  if (!block.ok) return { ok: false, reason: block.reason, error: block.error };
  const data = block.data;
  const list = Array.isArray(data.characters) ? data.characters : [];
  const accepted = [];
  const rejected = [];
  for (const entry of list) {
    const id = resolveCharacterId(entry, allowedIds);
    if (!id) { rejected.push({ reason: 'unattributed', entry }); continue; }
    const noChange = entry.no_change === true;
    const sections = normalizeSections(entry.sections);
    const actions = normalizeActions(entry.actions);
    if (noChange && Object.keys(sections).length === 0 && actions.length === 0) {
      accepted.push({ character_id: id, no_change: true, sections: {}, actions: [] });
      continue;
    }
    if (Object.keys(sections).length === 0 && actions.length === 0) {
      rejected.push({ reason: 'empty_entry', character_id: id });
      continue;
    }
    accepted.push({ character_id: id, no_change: false, sections, actions });
  }
  return { ok: true, accepted, rejected, block };
}

module.exports = {
  SUMMARY_OPEN,
  SUMMARY_CLOSE,
  SECTION_TITLES,
  PRIMARY_SECTIONS,
  INTERNAL_SOURCES,
  isInternalSource,
  extractSummaryBlock,
  normalizeSectionName,
  normalizeSections,
  normalizeActions,
  resolveCharacterId,
  buildIdempotencyKey,
  mergeIncrement,
  parseAndValidate,
  parseArchiveSummary
};

__cwb_modules["core/summary_ingest"]=module.exports;
__cwb_modules["summary_ingest"]=module.exports;
})();
// ---- core/character_book_state ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Shared state for the character book: opening, story switching and the
// management page all read/write through this module so they never diverge.
//
// Archive protection (independent entry / dynamic archive) is enforced here
// for enterChapter / exitChapter / reset, so the state module cannot bypass
// the shared gate.

const { trim } = require('./keys.js');
const { createArchiveScope } = require('./archive_scope.js');
const { planAutoSwitch, applyAutoSwitch, AUTO_TOGGLE_CAP } = require('./auto_switch.js');
const { evaluateInfluence, allowsAutoModification } = require('./influence.js');
const { findTarget, isAdapted, adaptedChapters } = require('./chapter_adapt.js');
const ArchiveProtection = require('./archive_protection.js');

function createCharacterBookState(options) {
  const opts = options || {};
  const catalog = opts.catalog || [];
  const scope = opts.scope || createArchiveScope(opts.scopeOptions || {});
  // Optional sidecar store for archive protection. When absent, protection
  // falls back to influence/manual only (legacy behavior preserved).
  const store = opts.store || null;

  // Per-save state keyed by scope key.
  const saves = new Map();

  function emptySave() {
    return {
      currentChapter: '',
      currentForms: {},      // name -> comment_pk
      manual: {},            // name -> true | { locked, comment_pk }
      influence: {},         // name -> { status, reasons }
      snapshots: [],         // [{ id, at, forms, manual, influence }]
      lastResult: null
    };
  }

  function saveFor(key) {
    if (!key) return null;
    if (!saves.has(key)) saves.set(key, emptySave());
    return saves.get(key);
  }

  function currentSave() {
    const b = scope.bind();
    if (!b.ok) return { ok: false, reason: b.reason };
    return { ok: true, key: b.key, save: saveFor(b.key) };
  }

  function snapshot(label) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    const snap = {
      id: 'snap_' + (s.snapshots.length + 1) + '_' + Date.now(),
      label: trim(label) || 'auto',
      at: new Date().toISOString(),
      forms: Object.assign({}, s.currentForms),
      manual: JSON.parse(JSON.stringify(s.manual)),
      influence: JSON.parse(JSON.stringify(s.influence))
    };
    s.snapshots.push(snap);
    return { ok: true, snapshot: snap };
  }

  function rollback(snapshotId) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    const idx = s.snapshots.findIndex(x => x.id === snapshotId);
    if (idx < 0) return { ok: false, reason: 'snapshot_not_found' };
    const snap = s.snapshots[idx];
    s.currentForms = Object.assign({}, snap.forms);
    s.manual = JSON.parse(JSON.stringify(snap.manual));
    s.influence = JSON.parse(JSON.stringify(snap.influence));
    return { ok: true, restored: snap };
  }

  function setManual(name, value) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const n = trim(name);
    if (!n) return { ok: false, reason: 'empty_name' };
    if (value === false || value == null) {
      delete cur.save.manual[n];
    } else {
      cur.save.manual[n] = value;
    }
    return { ok: true };
  }

  function setForm(name, commentPk, opts2) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const n = trim(name);
    const pk = trim(commentPk);
    if (!n || !pk) return { ok: false, reason: 'missing_args' };
    const o = opts2 || {};
    if (o.snapshot !== false) snapshot('before_set_form:' + n);
    cur.save.currentForms[n] = pk;
    if (o.manual) cur.save.manual[n] = { locked: true, comment_pk: pk };
    return { ok: true, name: n, comment_pk: pk };
  }

  function setInfluence(name, record) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const n = trim(name);
    if (!n) return { ok: false, reason: 'empty_name' };
    cur.save.influence[n] = record || { status: 'unknown' };
    return { ok: true };
  }

  function evaluateAndStore(name, facts) {
    const rec = evaluateInfluence(facts || {});
    setInfluence(name, rec);
    return rec;
  }

  // Shared protection check for a single character name.
  function protectionOf(name, save) {
    const s = save || (currentSave().save || emptySave());
    return ArchiveProtection.evaluateProtection({
      name,
      store,
      influenceByCharacter: s.influence,
      manual: s.manual,
      allowsAutoModification
    });
  }

  function enterChapter(chapter, sceneCharacters, writer) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    const ch = trim(chapter);
    s.currentChapter = ch;

    const plan = planAutoSwitch({
      chapter: ch,
      sceneCharacters: sceneCharacters || [],
      influenceByCharacter: s.influence,
      currentForms: s.currentForms,
      manual: s.manual,
      catalog,
      store
    });

    if (!plan.adapted) {
      s.lastResult = plan;
      return { ok: true, plan, applied: null, adapted: false };
    }

    const tokenRes = scope.beginAsync('enterChapter:' + ch);
    if (!tokenRes.ok) return { ok: false, reason: tokenRes.reason };

    const applied = applyAutoSwitch(plan, writer, {
      store,
      influenceByCharacter: s.influence,
      manual: s.manual,
      isStillValid: () => {
        const b = scope.bind();
        return b.ok && b.key === tokenRes.token.key;
      }
    });

    const commit = scope.commitAsync(tokenRes.token, () => {
      for (const a of applied.applied) s.currentForms[a.name] = a.comment_pk;
      s.lastResult = { plan, applied };
      return true;
    });
    if (!commit.ok) {
      return { ok: false, reason: commit.reason, plan, applied };
    }
    return { ok: true, plan, applied, adapted: true };
  }

  function exitChapter(writer) {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    const restored = [];
    const skipped = [];
    for (const name of Object.keys(s.currentForms)) {
      // Archive protection: never auto-close a protected character.
      const verdict = protectionOf(name, s);
      if (!verdict.allowed) {
        skipped.push({ name, reason: verdict.reasons[0] || 'protected', reasons: verdict.reasons.slice() });
        continue;
      }
      if (writer && typeof writer.setEntryEnabled === 'function') {
        try {
          writer.setEntryEnabled(s.currentForms[name], false);
          restored.push({ name, comment_pk: s.currentForms[name] });
        } catch (err) {
          skipped.push({ name, reason: 'write_failed' });
        }
      }
      delete s.currentForms[name];
    }
    s.currentChapter = '';
    return { ok: true, restored, skipped };
  }

  function listCharacters() {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    const influence = s.influence || {};
    const manualMap = s.manual || {};
    const currentForms = s.currentForms || {};
    const out = [];
    for (const rec of catalog) {
      const name = rec.canonical_name;
      const inf = influence[name];
      const manual = manualMap[name];
      const verdict = protectionOf(name, s);
      out.push({
        name,
        character_id: rec.character_id,
        current_form: currentForms[name] || '',
        default_form: rec.default_form || '',
        manual: !!manual,
        manual_locked: !!(manual && (manual === true || manual.locked)),
        influence: inf ? inf.status : 'unknown',
        auto_allowed: verdict.allowed,
        protected: verdict.protected,
        protection_reasons: verdict.reasons.slice(),
        protection_pending: verdict.pending.slice(),
        pending: !inf || inf.status === 'unknown',
        sync_gap: null,
        candidates: []
      });
    }
    return { ok: true, characters: out };
  }

  function reset() {
    const cur = currentSave();
    if (!cur.ok) return { ok: false, reason: cur.reason };
    const s = cur.save;
    // Reset must not silently drop protected characters' current forms.
    // We keep currentForms for protected characters and clear the rest.
    const kept = {};
    const cleared = [];
    for (const name of Object.keys(s.currentForms)) {
      const verdict = protectionOf(name, s);
      if (!verdict.allowed) {
        kept[name] = s.currentForms[name];
      } else {
        cleared.push(name);
      }
    }
    s.currentChapter = '';
    s.currentForms = kept;
    s.manual = {};
    s.influence = {};
    s.snapshots = [];
    s.lastResult = null;
    return { ok: true, kept, cleared };
  }

  return {
    scope,
    currentSave,
    snapshot,
    rollback,
    setManual,
    setForm,
    setInfluence,
    evaluateAndStore,
    enterChapter,
    exitChapter,
    listCharacters,
    reset,
    protectionOf,
    AUTO_TOGGLE_CAP,
    adaptedChapters,
    isAdapted,
    findTarget
  };
}

module.exports = { createCharacterBookState };

__cwb_modules["core/character_book_state"]=module.exports;
__cwb_modules["character_book_state"]=module.exports;
})();
// ---- core/tavern_api ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// Resolve which LLM connection to use for design / summarize / merge.
// Field names are taken from official SillyTavern 1.19.0
// (public/scripts/st-context.js, openai.js, secrets.js, src/endpoints/secrets.js).
// Do not invent new host property names. Never log secret values.

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function pluginOverride(settings) {
  const s = settings || {};
  const url = trim(s.url || s.endpoint);
  const key = trim(s.key || s.api_key || s.apiKey);
  const model = trim(s.model);
  // A leftover default model name alone is not an override.
  // Only a complete plugin connection (URL + key) replaces the tavern generate pipeline.
  if (url && key) {
    return { source: 'plugin_override', url, key, model };
  }
  return null;
}

function tavernModel(context) {
  const ctx = context || {};
  try {
    if (typeof ctx.getChatCompletionModel === 'function') {
      return trim(ctx.getChatCompletionModel());
    }
  } catch (_) {}
  const oai = ctx.chatCompletionSettings;
  if (!oai || typeof oai !== 'object') return '';
  // Live 1.19.0 should prefer getChatCompletionModel(), which switches on
  // chat_completion_source (openai_model, custom_model, deepseek_model, ...).
  // This fallback is only for incomplete test stubs.
  return trim(oai.custom_model || oai.openai_model || '');
}

function tavernGenerateApi(context) {
  const ctx = context || {};
  const generateRaw = typeof ctx.generateRaw === 'function' ? ctx.generateRaw : null;
  const generateRawData = typeof ctx.generateRawData === 'function' ? ctx.generateRawData : null;
  if (!generateRaw && !generateRawData) return null;
  const oai = ctx.chatCompletionSettings || null;
  return {
    source: 'tavern',
    mainApi: ctx.mainApi || null,
    model: tavernModel(ctx),
    generateRaw,
    generateRawData,
    chat_completion_source: oai && oai.chat_completion_source ? oai.chat_completion_source : null
  };
}

function resolveGenerateApi(input) {
  const src = input || {};
  const override = pluginOverride(src.pluginSettings);
  if (override) return override;
  const tavern = tavernGenerateApi(src.context);
  if (tavern) return tavern;
  return { source: 'unavailable', reason: 'missing_tavern_api' };
}

function isUsable(api) {
  if (!api || typeof api !== 'object') return false;
  if (typeof api.generateRaw === 'function' || typeof api.generateRawData === 'function') return true;
  const url = trim(api.url || api.endpoint);
  const key = trim(api.key || api.api_key || api.apiKey);
  return !!(url && key);
}

function safeView(api) {
  if (!api || typeof api !== 'object') return { source: 'unavailable' };
  const view = { source: api.source || (isUsable(api) ? 'plugin_override' : 'unavailable') };
  if (api.model) view.model = String(api.model);
  if (api.mainApi) view.mainApi = String(api.mainApi);
  if (api.chat_completion_source) view.chat_completion_source = String(api.chat_completion_source);
  if (api.reason) view.reason = String(api.reason);
  view.usable = isUsable(api);
  return view;
}

const api = { pluginOverride, tavernGenerateApi, resolveGenerateApi, isUsable, safeView, tavernModel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_TAVERN_API__ = api;

__cwb_modules["core/tavern_api"]=module.exports;
__cwb_modules["tavern_api"]=module.exports;
})();
// ---- core/llm_client ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

// OpenAI-compatible client for explicit, on-demand actions only:
// chat summarization into the 14-section schema, and timeline/form merge.
// Never called from the story hot path (form switch is local compile).

const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);

const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';

function sectionKeyList() {
  return Schema.SECTIONS.join('、');
}

function summarizerMessages(input) {
  const existing = input.existing_profile || input.existing || {};
  const chat = Array.isArray(input.messages)
    ? input.messages.map(m => (typeof m === 'string' ? m : ((m.role || 'user') + ': ' + (m.content || m.mes || '')))).join('\n')
    : String(input.transcript || input.chat || '');
  const system = [
    '你是明日方舟角色档案整理助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    'JSON 必须且仅包含以下 14 个键，值为字符串：' + sectionKeyList() + '。',
    '小节标题必须与上面完全一致，不得改写、不得增减键名。',
    '不要编造底板未出现的固定身份信息；把本存档的经历、性格偏移、以及对 {{user}} 的好感与关系分别写入「经历」「特点」「人际关系」。',
    '「语言示例」只收录能代表该角色语气的短句。不确定的内容留空字符串。'
  ].join('\n');
  const user = [
    '角色：' + (input.canonical_name || input.character_id || ''),
    existing && Object.keys(existing).length ? '现有十四段档案：\n' + JSON.stringify(existing, null, 2) : '现有十四段档案：（空）',
    '需要整理的聊天摘录：\n' + chat
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function mergeMessages(input) {
  const system = [
    '你是明日方舟角色档案时间线合并助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    'JSON 必须且仅包含以下 14 个键，值为字符串：' + sectionKeyList() + '。',
    '小节标题必须与上面完全一致。这是字段差分合并后的完整十四段正文，不是自由改写。',
    '调和正史冲突时：保留本存档已发生的经历、好感与对 {{user}} 的关系，不得丢弃动态层；',
    '当前时间线（目标）的正史形态正文优先于被离开的时间线的形态正文；冲突处用简短说明写入「备注」。'
  ].join('\n');
  const user = [
    '角色：' + (input.canonical_name || input.character_id || ''),
    '目标时间线：' + (input.to_timeline || 'main'),
    '来源时间线：' + (input.from_timeline || 'parallel'),
    '目标形态正文（十四段）：\n' + JSON.stringify(input.target_profile || {}, null, 2),
    '来源形态正文（十四段）：\n' + JSON.stringify(input.source_profile || {}, null, 2),
    '需保留的存档动态层：\n' + JSON.stringify(input.dynamic_layer || {}, null, 2)
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function parseStructuredOutput(text) {
  const extracted = Schema.extractStructured(text);
  if (!extracted) return { ok: false, reason: 'unparseable_structured_output' };
  const missing = Schema.SECTIONS.filter(s => !Object.prototype.hasOwnProperty.call(extracted, s));
  if (missing.length) return { ok: false, reason: 'missing_sections', missing };
  return { ok: true, sections: extracted };
}

async function defaultFetch(url, init) {
  if (typeof fetch === 'function') return fetch(url, init);
  throw new Error('fetch_unavailable');
}

function normalizeApi(api) {
  const a = api || {};
  return {
    url: a.url || a.endpoint || DEFAULT_URL,
    key: a.key || a.api_key || a.apiKey || '',
    model: a.model || DEFAULT_MODEL,
    temperature: a.temperature == null ? 0.2 : a.temperature
  };
}

async function viaTavernGenerate(api, messages) {
  globalThis.__ARK_CWB_INTERNAL_CALLS__ = (globalThis.__ARK_CWB_INTERNAL_CALLS__ || 0) + 1;
  try {
  const system = (messages || []).filter(m => m && m.role === 'system').map(m => m.content || '').filter(Boolean).join('\n');
  const rest = (messages || []).filter(m => m && m.role !== 'system');
  const prompt = rest.length ? rest : messages;
  if (typeof api.generateRaw === 'function') {
    const text = await api.generateRaw({
      prompt,
      systemPrompt: system,
      instructOverride: true
    });
    return { ok: true, text: String(text || ''), llm_calls: 1, model: api.model || '', source: api.source || 'tavern' };
  }
  if (typeof api.generateRawData === 'function') {
    const data = await api.generateRawData({
      prompt,
      systemPrompt: system,
      instructOverride: true
    });
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      || (data && data.content)
      || (typeof data === 'string' ? data : '');
    return { ok: true, text: String(text || ''), raw: data, llm_calls: 1, model: api.model || '', source: api.source || 'tavern' };
  }
  return { ok: false, reason: 'missing_tavern_api', llm_calls: 0 };
  } finally { globalThis.__ARK_CWB_INTERNAL_CALLS__ = Math.max(0, (globalThis.__ARK_CWB_INTERNAL_CALLS__ || 1) - 1); }
}

async function chatCompletions(api, messages, fetcher) {
  const a = api || {};
  if (typeof a.generateRaw === 'function' || typeof a.generateRawData === 'function') {
    try {
      return await viaTavernGenerate(a, messages);
    } catch (_) {
      return { ok: false, reason: 'tavern_generate_failed', llm_calls: 1 };
    }
  }
  const cfg = normalizeApi(a);
  if (!cfg.key) return { ok: false, reason: 'missing_api_key', llm_calls: 0 };
  if (!cfg.url) return { ok: false, reason: 'missing_api_url', llm_calls: 0 };
  const doFetch = fetcher || defaultFetch;
  const res = await doFetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.key
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature
    })
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    return { ok: false, reason: 'http_' + status, llm_calls: 1 };
  }
  const body = typeof res.json === 'function' ? await res.json() : res.body;
  const text = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : (body && body.content) || '';
  return { ok: true, text: String(text || ''), raw: body, llm_calls: 1, model: cfg.model };
}

async function summarizeChat(input, api, fetcher) {
  const messages = summarizerMessages(input);
  const res = await chatCompletions(api, messages, fetcher);
  if (!res.ok) return res;
  const parsed = parseStructuredOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, missing: parsed.missing, llm_calls: 1, text: res.text };
  return { ok: true, sections: parsed.sections, llm_calls: 1, model: res.model };
}

function designMessages(input) {
  const src = input || {};
  const system = [
    '你是明日方舟存档剧情设计助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    '你只返回修订建议。不要生成聊天楼层，不要推进游标，不要结算未演的事件，不要改写已有 route_id、scene_id、node_id。',
    'brief_facts 只允许写入已经发生的事实。未来安排写入 future_summaries，不得写入 brief_facts。',
    '不能为了保住原终点而发明一次等效事件抵消玩家已经做成的事。',
    '人物档案只写有现场证据的经历、处境、认知和关系，且 evidence 必须是 on_site。可能的未来发展不要写入档案。',
    '世界书改动只能使用输入里给出的 entry_id 或 comment_pk。摘要改动只能使用输入里给出的 node_id。',
    '若某节点的全部内容只依赖已经作废的前提，status 填 inapplicable。被略过的事件不要记成已发生。',
    'chat_id、route_id、base_revision 必须原样回填输入中的值。'
  ].join('\n');
  const user = JSON.stringify({
    chat_id: src.chat_id,
    route_id: src.route_id,
    scene_id: src.scene_id,
    node_id: src.node_id,
    base_revision: src.base_revision,
    settled_facts: src.settled_facts || [],
    brief: src.brief || '',
    summaries: src.summaries || [],
    completions: src.completions || [],
    entry_keys: (src.entry_keys || []).map(entry => ({
      entry_id: entry.entry_id,
      comment_pk: entry.comment_pk,
      character_id: entry.character_id || null,
      premise: entry.premise || null,
      content: entry.content || ''
    })),
    node_ids: src.node_ids || [],
    sideline: src.sideline || null,
    profiles: src.profiles || [],
    effective_actions: src.effective_actions || [],
    archive_version: src.archive_version != null ? src.archive_version : null,
    character_archives: src.character_archives || {},
    required_characters: src.required_characters || [],
    protection: src.protection || null,
    manual_selection: src.manual_selection || null
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function parseDesignOutput(text) {
  const stripped = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'unparseable_design_output' };
  try {
    const obj = JSON.parse(stripped.slice(start, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'design_output_not_object' };
    return { ok: true, revision: obj };
  } catch (_) {
    return { ok: false, reason: 'unparseable_design_output' };
  }
}

async function designPlot(input, api, fetcher) {
  const res = await chatCompletions(api, designMessages(input), fetcher);
  if (!res.ok) return { ok: false, reason: res.reason, llm_calls: res.llm_calls || 0 };
  const parsed = parseDesignOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, llm_calls: 1 };
  return { ok: true, revision: parsed.revision, llm_calls: 1, model: res.model };
}

async function mergeTimelines(input, api, fetcher) {
  const messages = mergeMessages(input);
  const res = await chatCompletions(api, messages, fetcher);
  if (!res.ok) return res;
  const parsed = parseStructuredOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, missing: parsed.missing, llm_calls: 1, text: res.text };
  return { ok: true, sections: parsed.sections, llm_calls: 1, model: res.model };
}

const api = {
  DEFAULT_MODEL, DEFAULT_URL,
  summarizerMessages, mergeMessages, designMessages, parseStructuredOutput, parseDesignOutput,
  normalizeApi, viaTavernGenerate, chatCompletions, summarizeChat, mergeTimelines, designPlot
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_LLM__ = api;

__cwb_modules["core/llm_client"]=module.exports;
__cwb_modules["llm_client"]=module.exports;
})();
// ---- core/plot_direction ----
(function(){
var module={exports:{}};var exports=module.exports;
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

__cwb_modules["core/plot_direction"]=module.exports;
__cwb_modules["plot_direction"]=module.exports;
})();
// ---- core/plugin ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);
const Hash = (typeof require === 'function' && require('./hash')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_HASH__);
const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);
const Compiler = (typeof require === 'function' && require('./compiler')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_COMPILER__);
const Sidecar = (typeof require === 'function' && require('./sidecar')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SIDECAR__);
const LoreBind = (typeof require === 'function' && require('./lore_bind')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_LORE_BIND__);
const PromptFilter = (typeof require === 'function' && require('./prompt_filter')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_PROMPT_FILTER__);
const AutoToggle = (typeof require === 'function' && require('./auto_toggle')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_AUTO_TOGGLE__);
const Llm = (typeof require === 'function' && require('./llm_client')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_LLM__);
const TavernApi = (typeof require === 'function' && require('./tavern_api')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_TAVERN_API__);
const Plot = (typeof require === 'function' && require('./plot_direction')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_PLOT__);
const AutoSwitch = (typeof require === 'function' && require('./auto_switch')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_AUTO_SWITCH__);
const ArchiveProtection = (typeof require === 'function' && require('./archive_protection')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_ARCHIVE_PROTECTION__);
const Influence = (typeof require === 'function' && require('./influence')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_INFLUENCE__);
const SummaryIngest = (typeof require === 'function' && require('./summary_ingest')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SUMMARY_INGEST__);
const CharacterActions = (typeof require === 'function' && require('./character_actions')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_CHARACTER_ACTIONS__);

const STORY_CHAPTER = {
  story_0f447c9b9b: '雪原线',
  story_c579b90d26: '时间啊，向前！',
  story_899cfa8775: '孤星'
};

function resolveChapter(spec, state) {
  const candidates = [];
  if (spec && typeof spec === 'object') {
    candidates.push(spec.chapter, spec.story_id, spec.storyId, spec.story);
  }
  if (state && typeof state === 'object') {
    candidates.push(state.chapter, state.story_id, state.storyId, state.story);
  }
  for (const raw of candidates) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    if (Object.prototype.hasOwnProperty.call(STORY_CHAPTER, value)) return STORY_CHAPTER[value];
    for (const id of Object.keys(STORY_CHAPTER)) {
      if (STORY_CHAPTER[id] === value) return value;
    }
  }
  return '';
}

function loadSidecar(host, chatId) {
  const raw = host.readSidecar(chatId);
  if (!raw || typeof raw !== 'object') return Sidecar.emptySidecar();
  if (!raw.characters) raw.characters = {};
  if (!Array.isArray(raw.snapshots)) raw.snapshots = [];
  if (raw.rev == null) raw.rev = 0;
  return raw;
}

function persistSidecar(host, chatId, store) {
  host.writeSidecar(chatId, store);
  const meta = LoreBind.pointerOf(host.readStoryMeta(chatId) || {});
  if (meta.sidecar_rev !== store.rev) {
    host.writeStoryMeta(chatId, { lore_mode: meta.lore_mode, book: meta.book, sidecar_rev: store.rev });
  }
}

function createCopyWorldbookPlugin(host, options) {
  const o = options || {};
  const metrics = {
    book_creates: 0,
    base_writes: 0,
    clone_writes: 0,
    meta_writes: 0,
    llm_calls: 0,
    last_warning: null
  };
  const banners = new Map(); // chatId -> prompts

  function meta(chatId) {
    return LoreBind.pointerOf(host.readStoryMeta(chatId) || {});
  }

  function onChatChanged(chatId) {
    const result = LoreBind.onChatChanged(host, chatId);
    if (result.warning) {
      metrics.last_warning = result.warning;
      banners.set(chatId, [{ kind: 'degraded', message: '克隆世界书缺失或无法绑定，已降级为底板只读投影，不会改写底板。' }]);
    } else if (result.mode === 'clone') {
      banners.delete(chatId);
    }
    metrics.meta_writes += result.meta_writes || 0;
    return result;
  }

  function enableCloneMode(chatId, opts) {
    const result = LoreBind.enableCloneMode(host, chatId, opts);
    if (result.created) metrics.book_creates += 1;
    metrics.meta_writes += 1;
    if (result.created && (!opts || !opts.initialEntries || !opts.initialEntries.length)) {
      // empty sparse book is fine; compiled entries are written later
    }
    return result;
  }

  function disableCloneMode(chatId, opts) {
    banners.delete(chatId);
    return LoreBind.disableCloneMode(host, chatId, opts);
  }

  function shouldNoopBaseFlush(chatIdOrState) {
    if (chatIdOrState && typeof chatIdOrState === 'object' && chatIdOrState.lore_mode) {
      return LoreBind.shouldNoopBaseFlush(chatIdOrState);
    }
    return LoreBind.shouldNoopBaseFlush(meta(chatIdOrState));
  }

  function getStatus(chatId) {
    const ptr = meta(chatId);
    const exists = !!(ptr.book && host.bookExists(ptr.book));
    const store = loadSidecar(host, chatId);
    const overridden = Object.keys(store.characters || {});
    return {
      lore_mode: ptr.lore_mode,
      book: ptr.book,
      sidecar_rev: store.rev,
      book_exists: exists,
      bound_lore: host.getChatLore(chatId),
      overridden_characters: overridden,
      warning: ptr.lore_mode === 'degraded' || (ptr.lore_mode === 'clone' && !exists) ? 'missing_clone_book' : null,
      banners: banners.get(chatId) || [],
      snapshots: (store.snapshots || []).map(s => ({ id: s.id, at: s.at, reason: s.reason }))
    };
  }

  function recompileAndWrite(chatId, store) {
    const ptr = meta(chatId);
    if (ptr.lore_mode !== 'clone' || !ptr.book || !host.bookExists(ptr.book)) {
      return { ok: false, reason: ptr.lore_mode === 'clone' ? 'missing_clone_book' : 'not_in_clone_mode', writes: 0 };
    }
    const compiled = Compiler.compileBook(Sidecar.characterList(store));
    host.writeBook(ptr.book, compiled.entries);
    metrics.clone_writes += 1;
    persistSidecar(host, chatId, store);
    if (compiled.warnings && compiled.warnings.length) {
      const message = compiled.warnings[0].message || '叠开形态差分已超过字数上限并被截断。';
      metrics.last_warning = message;
      const prev = banners.get(chatId) || [];
      if (!prev.some(b => b.kind === 'diff_truncated')) {
        banners.set(chatId, prev.concat([{ kind: 'diff_truncated', message }]));
      }
    }
    return { ok: compiled.ok, entries: compiled.entries, errors: compiled.errors, warnings: compiled.warnings || [], writes: 1, sidecar_rev: store.rev };
  }

  function upsertCharacterForm(chatId, character, form) {
    const store = loadSidecar(host, chatId);
    const id = character.character_id || character.actor_id;
    Sidecar.setForm(store, id, form, character);
    return recompileAndWrite(chatId, store);
  }

  function switchForm(chatId, characterId, selection) {
    const store = loadSidecar(host, chatId);
    const result = Sidecar.switchForm(store, characterId, selection);
    if (!result.ok) return result;
    const compiled = recompileAndWrite(chatId, store);
    return { ...result, ...compiled, llm_calls: 0 };
  }

  function setDynamicLayer(chatId, characterId, patch, timelineId) {
    const store = loadSidecar(host, chatId);
    const layer = Sidecar.setDynamic(store, characterId, patch, timelineId);
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, dynamic: layer, ...compiled };
  }

  function snapshot(chatId, reason) {
    const store = loadSidecar(host, chatId);
    const rec = Sidecar.snapshot(store, reason, host);
    persistSidecar(host, chatId, store);
    return { ok: true, snapshot_id: rec.id, reason: rec.reason, characters_hash: rec.characters_hash, sidecar_rev: store.rev };
  }

  function rollback(chatId, snapshotId) {
    const store = loadSidecar(host, chatId);
    const result = Sidecar.rollback(store, snapshotId);
    if (!result.ok) return result;
    const compiled = recompileAndWrite(chatId, store);
    return { ...result, ...compiled, llm_calls: 0 };
  }

  function copyFormFromBase(chatId, characterId, form, options) {
    // Explicit admin action only. Replaces form text, then local-compiles
    // to reattach the dynamic layer. Never used by auto-toggle.
    const store = loadSidecar(host, chatId);
    snapshot(chatId, 'pre_copy_from_base');
    const rec = loadSidecar(host, chatId);
    Sidecar.setForm(rec, characterId, {
      ...form,
      content: form.content,
      content_hash: Hash.hashContent(form.content || ''),
      copied_at: host.now ? host.now() : Date.now()
    }, { character_id: characterId, canonical_name: (options && options.canonical_name) || characterId });
    if (rec.characters[characterId] && rec.characters[characterId].stale_forms) {
      delete rec.characters[characterId].stale_forms[String(form.form_id || form.entry_id || form.source_uid)];
    }
    return recompileAndWrite(chatId, rec);
  }

  function plotExclusions(store, ctx) {
    const fromStore = (store && store.plot_layer && store.plot_layer.exclusions) || [];
    const fromCtx = (ctx && ctx.excluded) || [];
    return fromStore.concat(fromCtx);
  }

  function filterOutboundPrompt(payload, chatId, ctx) {
    const ptr = meta(chatId);
    const store = loadSidecar(host, chatId);
    const excluded = plotExclusions(store, ctx);
    if (ptr.lore_mode !== 'clone') {
      if (!excluded.length) return { payload, removed: 0, suppressed_texts: 0, selectors: 0, excluded: 0, uncovered: [] };
      return PromptFilter.filterOutboundPrompt(payload, { selectors: [], excluded });
    }
    const characters = Sidecar.characterList(store);
    const compiled = Compiler.compileBook(characters);
    const compiledById = new Map((compiled.entries || []).map(e => [String(e.character_id), e]));
    const selectors = PromptFilter.overriddenSelectors(characters);
    for (const sel of selectors) {
      const entry = compiledById.get(String(sel.character_id));
      if (entry && entry.content) sel.compiled_content = entry.content;
    }
    if (ctx && Array.isArray(ctx.base_entries)) {
      for (const sel of selectors) {
        const base = ctx.base_entries.find(e => Keys.exactEntryMatch(e, sel));
        if (base && base.content) sel.base_content = String(base.content);
      }
    } else if (typeof host.readBaseBook === 'function') {
      const baseEntries = host.readBaseBook() || [];
      for (const sel of selectors) {
        const base = baseEntries.find(e => Keys.exactEntryMatch(e, sel));
        if (base && base.content) sel.base_content = String(base.content);
      }
    }
    return PromptFilter.filterOutboundPrompt(payload, { selectors, characters, excluded });
  }

  function autoToggleForSegment(chatId, spec, state) {
    const ptr = meta(chatId);
    if (ptr.lore_mode !== 'clone') {
      return { ok: true, skipped: true, reason: ptr.lore_mode, base_writes: 0, clone_writes: 0 };
    }
    if (!ptr.book || !host.bookExists(ptr.book)) {
      const degraded = onChatChanged(chatId);
      return { ok: true, skipped: true, reason: 'missing_clone_book', warning: degraded.warning, base_writes: 0, clone_writes: 0 };
    }
    const catalog = (spec && spec.catalog) || (host.readCatalog && host.readCatalog()) || o.catalog || [];
    const store = loadSidecar(host, chatId);
    const influenceByCharacter = Object.assign(
      {},
      (store && store.influence) || {},
      (spec && (spec.influenceByCharacter || spec.influence_by_character)) || {}
    );
    const manual = Object.assign(
      {},
      (store && store.manual) || {},
      (spec && (spec.manual) || {})
    );
    const excluded = ((store.plot_layer && store.plot_layer.exclusions) || []).concat((spec && spec.excluded_keys) || []);
    const plan = AutoToggle.planAutoToggle(
      Object.assign({}, spec || {}, { excluded_keys: excluded }),
      catalog.map(c=>({...c,forms:[...(c.forms||[]),...(c.chapter_entries||[])]})),
      store.characters,
      {
        store,
        influenceByCharacter: Object.assign({}, influenceByCharacter || {}),
        manual: Object.assign({}, manual || {}),
        allowsAutoModification: Influence.allowsAutoModification
      }
    );
    const baseForms = {};
    const baseEntries = (spec && spec.base_entries) || (host.readBaseBook && host.readBaseBook()) || [];
    for (const e of baseEntries) {
      const id = String(Keys.entryIdOf(e));
      baseForms[id] = { content: e.content, content_hash: Hash.hashContent(e.content || ''), comment_pk: Keys.commentPk(e) };
    }
    const applied = AutoToggle.applyAutoToggle(plan, store.characters, baseForms);
    for (const ev of applied.results) {
      if (ev.action === 'stale_prompt') {
        Sidecar.markStale(store, ev.character_id, ev.entry_id, {
          base_hash: ev.prompt.base_hash,
          clone_hash: ev.prompt.clone_hash,
          marked_at: host.now ? host.now() : Date.now()
        });
      }
    }
    // One clone-book compile/write for this paragraph (even if only flags change).
    const compiled = recompileAndWrite(chatId, store);
    if (applied.prompts.length) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat(applied.prompts));
    }
    if (plan.warning) {
      metrics.last_warning = plan.warning.message;
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{ kind: plan.warning.kind || 'auto_toggle_cap', message: plan.warning.message }]));
    }
    const result = {
      ok: true,
      plan,
      results: applied.results,
      prompts: applied.prompts,
      base_writes: 0,
      clone_writes: compiled.writes || 0,
      dynamic_overwrites: 0,
      entries: compiled.entries,
      protected: (plan && plan.protected) || [],
      warning: plan.warning || null
    };
    if (result.protected.length > 0) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{
        kind: 'archive_protected',
        message: '已有独立条目或动态档案，本次未自动切换：' + result.protected.map(p => p.name).join('、')
      }]));
    }

    // Additive chapter switch for the three adapted stories. Legacy callers
    // without a resolvable chapter keep the exact result above.
    state = state || (spec && spec.state) || {};
    const chapter = resolveChapter(spec, state);
    if (!chapter || !AutoSwitch || typeof AutoSwitch.planAutoSwitch !== 'function') {
      return result;
    }

    const sceneCharacters = [];
    const seenNames = new Set();
    const extraMissing = [];
    const pushName = (name) => {
      const n = String(name || '').trim();
      if (!n || seenNames.has(n)) return;
      seenNames.add(n);
      sceneCharacters.push({ name: n });
    };
    const rawScene = (spec && (spec.scene_characters || spec.sceneCharacters)) || [];
    for (const c of rawScene) {
      if (typeof c === 'string') pushName(c);
      else if (c && (c.name || c.canonical_name || c.character_name)) {
        pushName(c.name || c.canonical_name || c.character_name);
      }
    }
    for (const s of (spec && spec.speakers) || []) {
      if (typeof s === 'string') pushName(s);
      else if (s && (s.name || s.canonical_name || s.character_name)) {
        pushName(s.name || s.canonical_name || s.character_name);
      }
    }
    const byId = new Map();
    for (const c of catalog || []) {
      if (!c) continue;
      if (c.character_id) byId.set(String(c.character_id), c);
      if (c.actor_id) byId.set(String(c.actor_id), c);
    }
    for (const fid of (spec && (spec.focus_actor_ids || spec.focusActorIds)) || []) {
      const hit = byId.get(String(fid));
      if (hit && (hit.canonical_name || hit.name)) pushName(hit.canonical_name || hit.name);
      else extraMissing.push({ name: String(fid), reason: 'unresolved_focus' });
    }

    const currentForms = {};
    for (const id of Object.keys(store.characters || {})) {
      const rec = store.characters[id];
      if (!rec || !rec.forms || !rec.selection) continue;
      const form = rec.forms[String(rec.selection.primary)];
      if (form && form.comment_pk) {
        const key = rec.canonical_name || rec.name || id;
        currentForms[key] = form.comment_pk;
        if (id !== key) currentForms[id] = form.comment_pk;
      }
    }


    const contentForPk = (pk) => {
      if (pk == null) return null;
      const key = String(pk);
      for (const c of catalog || []) {
        for (const f of (c && c.forms) || []) {
          if (f && String(f.comment_pk) === key) return f.content;
        }
      }
      for (const e of baseEntries) {
        const epk = (e && (e.comment_pk || Keys.commentPk(e))) || '';
        if (String(epk) === key || String(e && e.comment) === key) return e.content;
      }
      for (const id of Object.keys(store.characters || {})) {
        const rec = store.characters[id];
        for (const f of Object.values((rec && rec.forms) || {})) {
          if (f && String(f.comment_pk) === key) return f.content;
        }
      }
      return null;
    };

    const characterIdFor = (name) => {
      const n = String(name || '').trim();
      for (const c of catalog || []) {
        const names = [c && c.canonical_name, c && c.name].concat((c && c.aliases) || []);
        if (names.some(x => x && String(x) === n) && c.character_id) return String(c.character_id);
      }
      for (const id of Object.keys(store.characters || {})) {
        const rec = store.characters[id];
        if (id === n || (rec && (rec.canonical_name === n || rec.name === n))) return id;
      }
      return n;
    };

    let switchPlan;
    try {
      switchPlan = AutoSwitch.planAutoSwitch({
        chapter,
        sceneCharacters,
        influenceByCharacter,
        currentForms,
        manual,
        catalog,
        store
      });
    } catch (err) {
      result.chapter_switch_error = err && err.message ? err.message : String(err);
      return result;
    }

    const writer = {
      isWritable() {
        return ptr.lore_mode === 'clone' && !!(ptr.book && host.bookExists(ptr.book));
      },
      setEntryEnabled(comment_pk, enabled) {
        if (!enabled) return { ok: true };
        const item = ((switchPlan && switchPlan.switched) || []).find(s => String(s.comment_pk) === String(comment_pk));
        const name = (item && item.name) || '';
        const characterId = characterIdFor(name);
        const content = contentForPk(comment_pk);
        if (content == null && !item) return { ok: false, error: 'entry_not_found' };
        const rec = store.characters[characterId];
        let formId = null;
        if (rec && rec.forms) {
          for (const fid of Object.keys(rec.forms)) {
            if (String(rec.forms[fid].comment_pk) === String(comment_pk)) { formId = fid; break; }
          }
        }
        if (!formId) formId = String(comment_pk);
        Sidecar.setForm(store, characterId, {
          form_id: formId,
          comment_pk,
          content: content == null ? '' : content,
          copied_at: host.now ? host.now() : Date.now()
        }, { character_id: characterId, canonical_name: name || characterId });
        return Sidecar.switchForm(store, characterId, { primary: formId });
      }
    };

    const switchApplied = AutoSwitch.applyAutoSwitch(switchPlan, writer, {
      store,
      influenceByCharacter,
      manual,
      isStillValid: function (item) {
        return ArchiveProtection.stillValidForWrite({
          name: item && item.name,
          store,
          influenceByCharacter,
          manual,
          writer
        });
      }
    });
    if (switchApplied && switchApplied.applied && switchApplied.applied.length) {
      const recompiled = recompileAndWrite(chatId, store);
      result.clone_writes = (result.clone_writes || 0) + (recompiled.writes || 0);
      result.entries = recompiled.entries || result.entries;
    }
    const missing = ((switchPlan && switchPlan.missing) || []).concat(extraMissing);
    result.chapter_switch = {
      chapter,
      adapted: !!(switchPlan && switchPlan.adapted),
      switched: (switchPlan && switchPlan.switched) || [],
      unchanged: (switchPlan && switchPlan.unchanged) || [],
      protected: (switchPlan && switchPlan.protected) || [],
      missing,
      overflow: (switchPlan && switchPlan.overflow) || [],
      overflowNotice: (switchPlan && switchPlan.overflowNotice) || null,
      cap: switchPlan && switchPlan.cap,
      applied: switchApplied
    };
    if (switchPlan && switchPlan.overflowNotice) {
      const prev = banners.get(chatId) || [];
      const message = switchPlan.overflowNotice.message || switchPlan.overflowNotice;
      metrics.last_warning = message;
      banners.set(chatId, prev.concat([{ kind: 'chapter_switch_overflow', message }]));
    }
    if (switchPlan && switchPlan.protected && switchPlan.protected.length > 0) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{
        kind: 'archive_protected',
        message: '已有独立条目或动态档案，本次未自动切换：' + switchPlan.protected.map(p => p.name).join('、')
      }]));
    }
    return result;
  }

  function designApi(explicit) {
    if (TavernApi && TavernApi.isUsable(explicit)) return explicit;
    if (explicit && (explicit.key || explicit.api_key || explicit.apiKey) && (explicit.url || explicit.endpoint)) return explicit;
    if (host && typeof host.readDesignApi === 'function') {
      try {
        const cfg = host.readDesignApi();
        if (TavernApi && TavernApi.isUsable(cfg)) return cfg;
        if (cfg && (cfg.key || cfg.api_key || cfg.apiKey) && (cfg.url || cfg.endpoint)) return cfg;
      } catch (_) {}
    }
    return null;
  }

  function rememberExclusions(store, rows, factIds) {
    const layer = store.plot_layer && typeof store.plot_layer === 'object'
      ? store.plot_layer
      : { exclusions: [] };
    const merged = Plot.mergeExclusions(layer.exclusions || [], []);
    const next = Plot.mergeExclusions(merged, (rows || []).map(row => ({
      ...row,
      fact_ids: row.fact_ids && row.fact_ids.length ? row.fact_ids : factIds
    })));
    store.plot_layer = { exclusions: next, fact_ids: factIds || layer.fact_ids || [] };
    return next;
  }

  function applyProfileSections(store, profile) {
    const id = profile.character_id;
    if (!store.characters[id]) return null;
    const rec = store.characters[id];
    const tid = rec.active_timeline || 'main';
    const prev = Compiler.normalizeDynamic((rec.dynamic && (rec.dynamic[tid] || rec.dynamic.main)) || {});
    const sections = profile.sections || {};
    const events = (prev.non_canon_events || []).slice();
    if (sections['经历'] && !events.includes(sections['经历'])) events.push(sections['经历']);
    const relationship = [prev.relationship, sections['人际关系']].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    const personality = [prev.personality_delta, sections['特点'], sections['备注'] ? '【处境】' + sections['备注'] : ''].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    Sidecar.setDynamic(store, id, {
      non_canon_events: events,
      relationship,
      personality_delta: personality
    }, tid);
    const note = [sections['经历'], sections['人际关系'], sections['特点'], sections['备注']].filter(Boolean).join('\n');
    rec.plot_overlay = rec.plot_overlay || {};
    if (note) rec.plot_overlay.profile_note = note;
    return id;
  }

  function applyEntryWrite(store, entry) {
    if (!entry || entry.action === 'keep' || !entry.character_id) return false;
    const rec = store.characters[entry.character_id];
    if (!rec) return false;
    rec.plot_overlay = rec.plot_overlay || { suppressed_fragments: [], replacement: '', disable_entry: false };
    const frags = [].concat(rec.plot_overlay.suppressed_fragments || [], entry.fragments || []);
    rec.plot_overlay.suppressed_fragments = frags.filter((v, i, a) => v && a.indexOf(v) === i);
    if (entry.action === 'replace' && entry.content) rec.plot_overlay.replacement = entry.content;
    if (entry.action === 'disable' && !entry.content) rec.plot_overlay.disable_entry = true;
    rec.plot_overlay.fact_ids = entry.fact_ids || rec.plot_overlay.fact_ids || [];
    Sidecar.bump(store);
    return true;
  }

  async function revisePlotDirection(chatId, request, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const req = request || {};
    const factIds = (req.settled_facts || []).map(fact => fact.fact_id).filter(Boolean);
    // 从 sidecar 注入有效行动与档案版本，作为必读输入。
    try {
      const store = loadSidecar(host, chatId);
      if (store) {
        const actions = [];
        const archives = {};
        const required = [];
        for (const cid of Object.keys(store.characters || {})) {
          const rec = store.characters[cid];
          const tid = rec.active_timeline || 'main';
          const list = Sidecar.actionList(store, cid, { includeVoided: false });
          for (const a of list) actions.push({ ...a, character_id: cid });
          archives[cid] = {
            timeline_id: tid,
            dynamic: JSON.parse(JSON.stringify((rec.dynamic && rec.dynamic[tid]) || {})),
            rev: store.rev || 0
          };
          if (list.length) required.push(cid);
        }
        req.effective_actions = actions;
        req.archive_version = store.rev != null ? store.rev : 0;
        req.character_archives = archives;
        if (!Array.isArray(req.required_characters) || !req.required_characters.length) {
          req.required_characters = required;
        }
      }
    } catch (e) { /* sidecar 不可用时保持缺项 */ }
    let design = { ok: false, reason: 'not_called', llm_calls: 0 };
    if (req.call_design) {
      const cfg = designApi(api);
      try {
        design = await Llm.designPlot(req, cfg, o.fetch);
        if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',llm_calls:1,cursor_advanced:false,floors_created:0};
      } catch (e) {
        design = { ok: false, reason: 'design_api_unavailable', llm_calls: 0 };
      }
      metrics.llm_calls += design.llm_calls || 0;
    }
    const review = Plot.validateDesignEdits(req, design.ok ? design.revision : null);
    const accepted = review.ok ? review.accepted : { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null };
    const localRows = req.local_exclusions || [];
    const acceptedRows = (review.ok ? accepted.worldbook : []).map(entry => ({ ...entry, fact_ids: factIds }));
    const excluded = Plot.mergeExclusions(localRows, acceptedRows);
    const capped = Plot.capEntryWrites(review.ok ? accepted.worldbook : [], Plot.WRITE_CAP);
    const warnings = (review.warnings || []).concat(capped.warning ? [capped.warning] : []);
    let entryWrites = 0;
    let profileIds = [];
    const ptr = meta(chatId);
    if (ptr.lore_mode === 'clone' && ptr.book && host.bookExists(ptr.book)) {
      const store = loadSidecar(host, chatId);
      const hasApply = review.ok && Array.isArray(capped.apply) && capped.apply.length > 0;
      const hasProfile = review.ok && Array.isArray(accepted.profile) && accepted.profile.length > 0;
      const hasExclusions = Array.isArray(excluded) && excluded.length > 0;
      const hasFacts = Array.isArray(factIds) && factIds.length > 0;
      const hasRevision = hasApply || hasProfile || hasExclusions || hasFacts;
      if (hasRevision) {
        Sidecar.snapshot(store, 'plot_revision_before', host, { plot_fact_ids: factIds, segment_key: req.segment_key || null });
        rememberExclusions(store, excluded, factIds);
        if (review.ok) {
          for (const entry of capped.apply) {
            if (applyEntryWrite(store, { ...entry, fact_ids: factIds })) entryWrites += 1;
          }
          for (const profile of accepted.profile || []) {
            const applied = applyProfileSections(store, profile);
            if (applied) profileIds.push(applied);
          }
        }
        const overlays = Object.values(store.characters || {}).some(rec => rec && rec.plot_overlay);
        if (overlays || profileIds.length) recompileAndWrite(chatId, store);
        else persistSidecar(host, chatId, store);
      }
    }
    if (capped.warning) {
      metrics.last_warning = capped.warning.message;
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{ kind: 'auto_toggle_cap', message: capped.warning.message }]));
    }
    return {
      ok: !!(design.ok && review.ok),
      reason: !design.ok ? (design.reason || 'design_unavailable') : review.reason,
      accepted: review.ok ? accepted : { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null },
      rejected: review.rejected || [],
      excluded_keys: excluded,
      warnings,
      llm_calls: design.llm_calls || 0,
      cursor_advanced: false,
      floors_created: 0,
      scene_continues: true,
      entry_writes: entryWrites,
      cap_deferred: capped.deferred.length,
      profile_ids: profileIds
    };
  }

  function rollbackPlotRevisions(chatId, spec) {
    const ids = new Set((spec && spec.fact_ids) || []);
    if (!ids.size) return { ok: true, rolled: false, llm_calls: 0, cursor_advanced: false, floors_created: 0 };
    const store = loadSidecar(host, chatId);
    const snaps = (store.snapshots || []).filter(row => row && !row.voided && (row.plot_fact_ids || []).some(id => ids.has(id)));
    if (!snaps.length) return { ok: true, rolled: false, reason: 'no_plot_snapshot', llm_calls: 0, cursor_advanced: false, floors_created: 0 };
    const target = snaps[0];
    const targetAt = (store.snapshots || []).findIndex(row => row && row.id === target.id);
    const result = Sidecar.rollback(store, target.id);
    if (!result.ok) return result;
    (store.snapshots || []).forEach((row, index) => {
      if (!row || index <= targetAt) return;
      if ((row.plot_fact_ids || []).some(id => ids.has(id)) || (row.plot_fact_ids || []).length) row.voided = true;
    });
    const ptr = meta(chatId);
    if (ptr.lore_mode === 'clone' && ptr.book && host.bookExists(ptr.book)) recompileAndWrite(chatId, store);
    else persistSidecar(host, chatId, store);
    return { ...result, rolled: true, snapshot_id: target.id, cursor_advanced: false, floors_created: 0 };
  }

  async function summarizeIntoProfile(chatId, characterId, input, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const before = snapshot(chatId, 'pre_summarize');
    const store = loadSidecar(host, chatId);
    const rec = store.characters[characterId];
    const existing = rec && rec.selection && rec.forms[rec.selection.primary]
      ? Schema.toStructured(rec.forms[rec.selection.primary].content)
      : {};
    const result = await Llm.summarizeChat({
      ...(input || {}),
      character_id: characterId,
      canonical_name: (rec && rec.canonical_name) || characterId,
      existing_profile: existing
    }, designApi(api), o.fetch);
    metrics.llm_calls += result.llm_calls || 0;
    if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',unchanged:true,llm_calls:1};
    if (!result.ok) return { ...result, unchanged: true, snapshot_id: before.snapshot_id };
    const serialized = Schema.fromStructured(result.sections, existing._preamble || ((rec && rec.canonical_name) ? '# ' + rec.canonical_name : ''));
    // Summarizer updates the dynamic-facing compiled view by writing the
    // structured sections back onto the primary form's experiences via the
    // dynamic layer where possible; the returned 14-section body is stored
    // as the compiled target and the primary form text remains the immutable
    // base unless the caller also requested a form rewrite.
    if (result.sections['经历'] || result.sections['人际关系'] || result.sections['特点']) {
      Sidecar.setDynamic(store, characterId, {
        non_canon_events: result.sections['经历'] ? [result.sections['经历']] : [],
        relationship: result.sections['人际关系'] || '',
        personality_delta: result.sections['特点'] || ''
      }, rec && rec.active_timeline);
    }
    rec && (rec.last_summary = { sections: result.sections, serialized, at: host.now ? host.now() : Date.now() });
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, sections: result.sections, snapshot_id: before.snapshot_id, llm_calls: result.llm_calls, ...compiled };
  }

  async function mergeTimelines(chatId, characterId, input, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const before = snapshot(chatId, 'pre_merge');
    const store = loadSidecar(host, chatId);
    const rec = store.characters[characterId];
    if (!rec) return { ok: false, reason: 'character_not_in_clone', llm_calls: 0, snapshot_id: before.snapshot_id };
    const fromId = (input && input.from_timeline) || rec.active_timeline || 'main';
    const toId = (input && input.to_timeline) || 'main';
    const primary = rec.forms[rec.selection.primary] || Object.values(rec.forms || {})[0];
    const result = await Llm.mergeTimelines({
      character_id: characterId,
      canonical_name: rec.canonical_name,
      from_timeline: fromId,
      to_timeline: toId,
      target_profile: input && input.target_profile || (primary ? Schema.toStructured(primary.content) : {}),
      source_profile: input && input.source_profile || {},
      dynamic_layer: rec.dynamic[fromId] || rec.dynamic.main
    }, designApi(api), o.fetch);
    metrics.llm_calls += result.llm_calls || 0;
    if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',unchanged:true,llm_calls:1};
    if (!result.ok) {
      // Parse failure: hashes stay unchanged (we snapshotted but did not apply).
      return { ...result, unchanged: true, snapshot_id: before.snapshot_id };
    }
    Sidecar.setDynamic(store, characterId, {
      ...(rec.dynamic[fromId] || {}),
      personality_delta: result.sections['特点'] || (rec.dynamic[fromId] && rec.dynamic[fromId].personality_delta) || '',
      relationship: result.sections['人际关系'] || (rec.dynamic[fromId] && rec.dynamic[fromId].relationship) || '',
      non_canon_events: result.sections['经历'] ? [result.sections['经历']] : ((rec.dynamic[fromId] && rec.dynamic[fromId].non_canon_events) || [])
    }, toId);
    rec.active_timeline = toId;
    rec.last_merge = { sections: result.sections, at: host.now ? host.now() : Date.now() };
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, sections: result.sections, snapshot_id: before.snapshot_id, llm_calls: result.llm_calls, ...compiled };
  }

  function attachArchiveSummaryPrompt(chatId, promptPayload) {
    const store = loadSidecar(host, chatId);
    const chars = Sidecar.characterList(store) || [];
    const lines = [];
    for (const ch of chars) {
      if (!ch) continue;
      const id = ch.id || ch.character_id;
      if (!id) continue;
      const dyn = ch.dynamic || {};
      const form = ch.form || {};
      const pick = k => (dyn[k] != null ? dyn[k] : (form[k] != null ? form[k] : ''));
      const exp = pick('经历');
      const rel = pick('人际关系');
      const feat = pick('特点');
      const note = pick('备注');
      if (!exp && !rel && !feat && !note) continue;
      lines.push('角色: ' + id);
      if (exp) lines.push('  经历: ' + exp);
      if (rel) lines.push('  人际关系: ' + rel);
      if (feat) lines.push('  特点: ' + feat);
      if (note) lines.push('  备注: ' + note);
    }
    const block = [
      '【存档摘要区】',
      lines.length ? lines.join('\n') : '(暂无已确认摘要)',
      '',
      '【机器可读输出约定】',
      '若本回合有角色状态变化，请在可见正文之后追加如下注释块（无变化则省略）：',
      '<!--ARK_ARCHIVE_SUMMARY',
      '{"characters":[{"character_id":"<已确认角色id>","no_change":false,"sections":{"经历":"...","人际关系":"...","特点":"...","备注":"..."},"actions":[{"situation":"...","behavior":"...","result":"..."}]}]}',
      '-->',
      '仅可填写已确认绑定的角色；无变化时 no_change 置 true 且不填 sections。'
    ].join('\n');

    const payload = promptPayload || {};
    if (typeof payload === 'string') return payload + '\n\n' + block;
    if (Array.isArray(payload.chat)) {
      payload.chat.push({ role: 'system', content: block });
      return payload;
    }
    if (Array.isArray(payload)) {
      payload.push({ role: 'system', content: block });
      return payload;
    }
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.concat([{ role: 'system', content: block }]);
      return payload;
    }
    if (typeof payload.prompt === 'string') {
      payload.prompt = payload.prompt + '\n\n' + block;
      return payload;
    }
    if (typeof payload.text === 'string') {
      payload.text = payload.text + '\n\n' + block;
      return payload;
    }
    payload.prompt = block;
    return payload;
  }

  function onVisibleGenerationComplete(chatId, info) {
    const opts = info || {};
    const source = opts.source;
    if (SummaryIngest && typeof SummaryIngest.isInternalSource === 'function' && SummaryIngest.isInternalSource(source)) {
      return { ok: true, skipped: true, reason: 'internal_source' };
    }
    const rawText = typeof opts.rawText === 'string' ? opts.rawText : '';
    const messageId = opts.messageId;
    const swipeId = opts.swipeId;
    const branchId = opts.branchId;
    const store = loadSidecar(host, chatId);
    const idemKey = Sidecar.actionKey(chatId, messageId, branchId, swipeId);

    const parsed = (SummaryIngest && typeof SummaryIngest.parseArchiveSummary === 'function')
      ? SummaryIngest.parseArchiveSummary(rawText)
      : { ok: false, reason: 'no_parser' };

    if (!parsed || !parsed.ok) {
      Sidecar.markSyncGap(store, '__global__', { reason: (parsed && parsed.reason) || 'missing_summary', messageId, branchId });
      persistSidecar(host, chatId, store);
      return { ok: false, reason: (parsed && parsed.reason) || 'missing_summary', syncGap: true };
    }

    const entries = Array.isArray(parsed.characters) ? parsed.characters : [];
    const known = new Set((Sidecar.characterList(store) || []).map(c => c && (c.id || c.character_id)).filter(Boolean));
    let changed = 0;
    let appended = 0;
    let rejected = 0;

    for (const entry of entries) {
      if (!entry || !entry.character_id) { rejected++; continue; }
      const id = entry.character_id;
      if (!known.has(id)) { rejected++; continue; }
      if (entry.no_change) continue;

      const sections = entry.sections || {};
      const ch = Sidecar.ensureCharacter(store, id);
      if (!ch) { rejected++; continue; }
      if (!ch.dynamic) ch.dynamic = {};
      const patch = {};
      let touched = false;
      for (const k of ['经历', '人际关系', '特点', '备注']) {
        if (sections[k] != null && String(sections[k]).length) {
          patch[k] = String(sections[k]);
          touched = true;
        }
      }
      if (touched) {
        Sidecar.setDynamic(store, id, patch);
        changed++;
      }

      const acts = Array.isArray(entry.actions) ? entry.actions : [];
      for (const act of acts) {
        if (!act) continue;
        const rec = {
          situation: act.situation != null ? String(act.situation) : '',
          behavior: act.behavior != null ? String(act.behavior) : '',
          result: act.result != null ? String(act.result) : '',
          message_id: messageId,
          branch_id: branchId,
          swipe_id: swipeId,
          snapshot_id: opts.snapshotId,
          idempotency_key: idemKey + '|' + id + '|' + appended
        };
        const before = Sidecar.actionList(store, id).length;
        Sidecar.appendAction(store, id, rec);
        if (Sidecar.actionList(store, id).length > before) appended++;
      }
    }

    Sidecar.setProcessedPosition(store, '__global__', {
      messageId, branchId, swipeId, idempotency_key: idemKey, at: Date.now()
    });
    Sidecar.clearSyncGap(store, '__global__');

    persistSidecar(host, chatId, store);
    try { recompileAndWrite(chatId, store); } catch (e) { /* keep silent */ }

    return { ok: true, changed, appended, rejected, idempotency_key: idemKey };
  }

  function invalidateArchiveContributions(chatId, info) {
    const opts = info || {};
    const store = loadSidecar(host, chatId);
    const chars = Sidecar.characterList(store) || [];
    let voided = 0;
    for (const ch of chars) {
      if (!ch) continue;
      const id = ch.id || ch.character_id;
      if (!id) continue;
      if (opts.messageId != null) {
        voided += Sidecar.invalidateActionsByMessage(store, id, opts.messageId);
      }
      if (opts.afterSnapshotId != null) {
        voided += Sidecar.invalidateActionsAfterRollback(store, id, { afterSnapshotId: opts.afterSnapshotId });
      }
    }
    persistSidecar(host, chatId, store);
    try { recompileAndWrite(chatId, store); } catch (e) { /* keep silent */ }
    return { ok: true, voided };
  }

  const plugin = {
    host, metrics, banners,
    onChatChanged, enableCloneMode, disableCloneMode, shouldNoopBaseFlush, getStatus,
    upsertCharacterForm, switchForm, setDynamicLayer, snapshot, rollback,
    copyFormFromBase, filterOutboundPrompt, autoToggleForSegment,
    archiveProtection: ArchiveProtection,
    summarizeIntoProfile, mergeTimelines, revisePlotDirection, rollbackPlotRevisions,
    attachArchiveSummaryPrompt, onVisibleGenerationComplete, invalidateArchiveContributions,
    loadSidecar: chatId => loadSidecar(host, chatId),
    compileBook: chatId => Compiler.compileBook(Sidecar.characterList(loadSidecar(host, chatId))),
    recompileAndWrite
  };
  return plugin;
}

function createMemoryHost(options) {
  const o = options || {};
  const books = new Map(); // name -> entries
  const lore = new Map(); // chatId -> book name
  const meta = new Map();
  const sidecars = new Map();
  const baseName = o.baseName || 'base-worldbook';
  const baseEntries = Array.isArray(o.baseEntries) ? o.baseEntries.map(e => JSON.parse(JSON.stringify(e))) : [];
  books.set(baseName, baseEntries.map(e => JSON.parse(JSON.stringify(e))));
  const metrics = { base_writes: 0, book_creates: 0, lore_binds: 0 };
  return {
    metrics, books, lore, meta, sidecars, baseName,
    now: o.now || (() => Date.now()),
    chatId: () => o.chatId || 'chat_a',
    listBooks: () => [...books.keys()],
    bookExists: name => books.has(name),
    createBook(name, entries) {
      if (name === baseName) { metrics.base_writes += 1; }
      else metrics.book_creates += 1;
      books.set(name, Array.isArray(entries) ? entries.map(e => JSON.parse(JSON.stringify(e))) : []);
    },
    readBook(name) {
      const rows = books.get(name);
      return rows ? rows.map(e => JSON.parse(JSON.stringify(e))) : null;
    },
    writeBook(name, entries) {
      if (name === baseName) metrics.base_writes += 1;
      books.set(name, Array.isArray(entries) ? entries.map(e => JSON.parse(JSON.stringify(e))) : []);
    },
    deleteBook(name) {
      if (name === baseName) return false;
      return books.delete(name);
    },
    getChatLore: chatId => lore.get(chatId) || null,
    setChatLore(chatId, name) { metrics.lore_binds += 1; if (name == null) lore.delete(chatId); else lore.set(chatId, name); },
    getBaseBookName: () => baseName,
    readBaseBook: () => (books.get(baseName) || []).map(e => JSON.parse(JSON.stringify(e))),
    hashBaseBook: () => Hash.hashEntries(books.get(baseName) || []),
    readStoryMeta: chatId => meta.get(chatId) || { lore_mode: 'baseline', book: null, sidecar_rev: 0 },
    writeStoryMeta(chatId, ptr) { meta.set(chatId, { ...LoreBind.pointerOf(meta.get(chatId)), ...ptr }); },
    readSidecar: chatId => sidecars.has(chatId) ? JSON.parse(JSON.stringify(sidecars.get(chatId))) : null,
    writeSidecar(chatId, data) { sidecars.set(chatId, JSON.parse(JSON.stringify(data))); }
  };
}

const api = {
  createCopyWorldbookPlugin, createMemoryHost,
  resolveChapter, STORY_CHAPTER,
  Schema, Hash, Keys, Compiler, Sidecar, LoreBind, PromptFilter, AutoToggle, AutoSwitch, Llm, Plot, TavernApi
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_COPY_WORLDBOOK_FACTORY__ = api;

__cwb_modules["core/plugin"]=module.exports;
__cwb_modules["plugin"]=module.exports;
})();
// ---- ui/panel ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPanelHtml(status, settings, apiView) {
  const s = status || {};
  const cfg = settings || {};
  const view = apiView || {};
  const source = view.source || ((cfg.url && cfg.key) ? 'plugin_override' : 'tavern');
  const sourceLabel = source === 'plugin_override'
    ? '当前使用插件中单独填写的覆盖接口（可选）。'
    : (source === 'tavern'
      ? '当前使用酒馆已配置的生成接口，无需在此重复填写。'
      : '尚未读到酒馆生成接口。可先在酒馆完成 API 配置，或在下方可选栏填写覆盖接口。');
  const sourceDetail = [view.mainApi ? ('mainApi=' + view.mainApi) : '', view.model ? ('模型 ' + view.model) : ''].filter(Boolean).join(' · ');
  const warning = (s.banners || []).map(b => '<div class="ark-cwb-warn">' + escapeHtml(b.message || b.kind) + '</div>').join('');
  const chars = (s.overridden_characters || []).map(id => '<li>' + escapeHtml(id) + '</li>').join('') || '<li class="ark-cwb-muted">（尚未接管任何角色）</li>';
  const snaps = (s.snapshots || []).slice(-5).reverse().map(x => '<li>' + escapeHtml(x.reason) + ' · ' + escapeHtml(x.id) + '</li>').join('') || '<li class="ark-cwb-muted">（无快照）</li>';
  const mode = s.lore_mode || 'baseline';
  return [
    '<div class="ark-cwb-panel" id="ark-cwb-panel">',
    '<h3>明日方舟 · 稀疏克隆世界书</h3>',
    '<p class="ark-cwb-muted">底板世界书保持只读。启用后，当前存档通过官方 Chat Lore 绑定一本稀疏克隆书；动态层与回滚快照存放在侧车，不写入剧情热路径。</p>',
    warning,
    s.warning ? '<div class="ark-cwb-warn">降级：克隆书缺失，已回退为底板只读投影，不会改写底板。</div>' : '',
    '<div class="ark-cwb-row"><strong>当前模式：</strong><span>' + escapeHtml(mode) + '</span></div>',
    '<div class="ark-cwb-row"><strong>绑定 Chat Lore：</strong><span>' + escapeHtml(s.bound_lore || s.book || '（无）') + '</span></div>',
    '<div class="ark-cwb-row">',
    '<button type="button" data-ark-cwb="enable">为当前存档启用独立世界书</button>',
    '<button type="button" data-ark-cwb="disable">关闭克隆模式</button>',
    '<button type="button" data-ark-cwb="refresh">刷新状态</button>',
    '</div>',
    '<h4>已接管角色</h4><ul class="ark-cwb-list">' + chars + '</ul>',
    '<div class="ark-cwb-row">',
    '<input type="text" data-ark-cwb-input="character" placeholder="角色 ID（精确主键）">',
    '<input type="text" data-ark-cwb-input="form" placeholder="形态 entry_id">',
    '<button type="button" data-ark-cwb="switch">切换形态（本地编译）</button>',
    '<button type="button" data-ark-cwb="merge">合并时间线</button>',
    '<button type="button" data-ark-cwb="rollback">一键回滚</button>',
    '<button type="button" data-ark-cwb="summarize">按聊天更新档案</button>',
    '</div>',
    '<h4>最近快照</h4><ul class="ark-cwb-list">' + snaps + '</ul>',
    '<h4>模型接口</h4>',
    '<p class="ark-cwb-muted">设计修订、按聊天更新档案、合并时间线默认走酒馆当前用于生成的配置（SillyTavern 1.19.0 的 getContext().generateRaw，以及 mainApi / chatCompletionSettings）。密钥仍由酒馆服务端保管，本面板不会再要求填一套。下面三栏只是可选覆盖：都留空即用酒馆配置。</p>',
    '<div class="ark-cwb-row">' + escapeHtml(sourceLabel) + (sourceDetail ? ' <span class="ark-cwb-muted">(' + escapeHtml(sourceDetail) + ')</span>' : '') + '</div>',
    '<h4>可选覆盖（通常不必填）</h4>',
    '<div class="ark-cwb-row"><label>URL <input type="text" data-ark-cwb-input="url" value="' + escapeHtml(cfg.url || '') + '" placeholder="留空则用酒馆配置"></label></div>',
    '<div class="ark-cwb-row"><label>Model <input type="text" data-ark-cwb-input="model" value="' + escapeHtml(cfg.model || '') + '" placeholder="仅覆盖时填写"></label></div>',
    '<div class="ark-cwb-row"><label>API Key <input type="password" data-ark-cwb-input="key" value="' + escapeHtml(cfg.key ? '••••••' : '') + '" autocomplete="off" placeholder="留空则用酒馆配置"></label>',
    '<button type="button" data-ark-cwb="save-api">保存可选覆盖</button></div>',
    '</div>'
  ].join('');
}

const api = { escapeHtml, renderPanelHtml };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_PANEL__ = api;

__cwb_modules["ui/panel"]=module.exports;
__cwb_modules["panel"]=module.exports;
})();
// ---- core/native_host ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';
// The synchronous core uses a hydrated cache; only flush() acknowledges a native save.
const META_UID = 2147483000;
const META_COMMENT = 'ARK::ChatLore::Sidecar::v2';
const clone = value => JSON.parse(JSON.stringify(value));
function createNativeHost(root, options) {
  const o = options || {}, books = new Map(), stores = new Map(), pointers = new Map();
  const dirty = new Map(), serializedBooks = new Map(); let tail = Promise.resolve(), hydrated = null, baseline = [], baselineName = '', revision = 0;
  const context = () => root.SillyTavern?.getContext?.() || {};
  function identity() {
    const c = context(), card = c.characters?.[c.characterId];
    const chat = c.getCurrentChatId?.() ?? c.chatId;
    const avatar = card?.avatar || '';
    return { chat: chat == null ? '' : String(chat), avatar, key: JSON.stringify([avatar, chat]), context: c, card };
  }
  function check(chat) {
    const id = identity();
    if (!id.chat || !id.avatar || String(chat) !== id.chat || hydrated !== id.key) throw Error('chat_scope_changed_or_not_ready');
    return id;
  }
  function capture(chat) { return { ...check(chat), context: undefined, card: undefined }; }
  function isCurrent(ticket) { return !!ticket && ticket.key === identity().key && hydrated === ticket.key; }
  function pointer(id) {
    const vars = id.context.chatMetadata?.variables || {};
    const b = vars.ark_story_v2 || {}, s = b.state || {};
    const saved = s.clone_book || b.book || b.clone_book;
    return pointers.get(id.key) || { lore_mode: s.lore_mode || b.lore_mode || 'baseline', book: saved || null, sidecar_rev: b.sidecar_rev || s.sidecar_rev || 0 };
  }
  function metadata(id, ptr) {
    const md = id.context.chatMetadata;
    if (!md) throw Error('missing_chat_metadata');
    md.variables ||= {}; const b = md.variables.ark_story_v2 ||= {};
    Object.assign(b, { lore_mode: ptr.lore_mode, book: ptr.book, sidecar_rev: ptr.sidecar_rev });
    if (b.state) Object.assign(b.state, { lore_mode: ptr.lore_mode, clone_book: ptr.book, sidecar_rev: ptr.sidecar_rev });
  }
  async function post(endpoint, body) {
    const headers = context().getRequestHeaders?.();
    if (!headers) throw Error('missing_native_request_headers');
    const response = await root.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
    if (!response.ok) throw Error('native_http_' + response.status);
    return response.json();
  }
  const io = o.io || {
    async read(name) { return post('/api/worldinfo/get', { name }); },
    async write(name, data) {
      await post('/api/worldinfo/edit', { name, data });
      const wi = await import('/scripts/world-info.js');
      wi.worldInfoCache?.delete(name); await wi.updateWorldInfoList();
    },
    async baseline() {
      const base = root.__ARK_STORY_EXTENSION__?.base || '/scripts/extensions/third-party/mmddj/';
      const r = await root.fetch(new URL('data/base_worldbook.json', new URL(base, root.location.href)).href);
      if (!r.ok) throw Error('baseline_http_' + r.status); return r.json();
    },
    async saveChat() { const result = await context().saveChat?.(); if (result === false) throw Error('native_chat_save_rejected'); }
  };
  function rows(book) { return Object.values(book?.entries || {}).map(e => ({ ...e, name: e.comment || e.name, keys: e.key || e.keys || [], enabled: !e.disable })); }
  async function prepare(chat) {
    const id = identity(); if (String(chat) !== id.chat || !id.chat || !id.avatar) throw Error('no_current_chat');
    if (!o.io && !(id.card?.data?.extensions?.tavern_helper?.scripts || []).some(s => String(s.name||'').startsWith('ARK_UI'))) throw Error('unsupported_character');
    const key = id.key;
    if (!baseline.length) {
      const raw = await io.baseline(); baseline = rows(raw);
    }
    if (identity().key !== key) throw Error('chat_changed_during_prepare');
    baselineName = id.card?.data?.extensions?.world || '';
    const ptr = pointer(id);
    if (ptr.book && !books.has(ptr.book)) {
      const raw = await io.read(ptr.book);
      if (identity().key !== key) throw Error('chat_changed_during_prepare');
      if (raw?.ark_chat_scope !== key) throw Error('clone_scope_mismatch');
      books.set(ptr.book, rows(raw).filter(e => e.comment !== META_COMMENT));
      const rec = Object.values(raw.entries || {}).find(e => e.comment === META_COMMENT);
      if (rec) stores.set(key, JSON.parse(rec.content));
    }
    pointers.set(key, ptr); hydrated = key;
    return { ...ptr };
  }
  function schedule(chat) { const id = check(chat); dirty.set(id.key, { ...capture(chat), version: ++revision }); }
  function nativeBook(ticket) {
    const ptr = pointers.get(ticket.key), entries = {};
    for (const e of books.get(ptr.book) || []) {
      const uid = Number(e.uid); if (!Number.isInteger(uid) || uid === META_UID || entries[uid]) throw Error('invalid_clone_uid');
      const src = baseline.find(b => String(b.uid) === String(e.source_uid)) || {};
      entries[uid] = { ...src, ...e, uid, key: e.keys || e.key || [], keysecondary: e.keysecondary || [],
        disable: e.enabled === false || e.disable === true, constant: e.constant !== false, content: String(e.content || '') };
    }
    entries[META_UID] = { uid: META_UID, comment: META_COMMENT, key: [], keysecondary: [], disable: true, constant: false,
      content: JSON.stringify(stores.get(ticket.key) || {}), order: 0, position: 0 };
    return { entries, ark_chat_scope: ticket.key, ark_schema: 2 };
  }
  async function flush() {
    const pending = [...dirty.values()].filter(t => t.key === identity().key);
    const task = tail.catch(() => {}).then(async () => {
      for (const ticket of pending) {
        if (!isCurrent(ticket)) throw Error('chat_changed_before_commit');
        const ptr = pointers.get(ticket.key);
        if (!ptr?.book || !/^ARK-ChatLore-/.test(ptr.book) || ptr.book === baselineName) throw Error('refusing_base_write');
        const book = nativeBook(ticket), serialized=JSON.stringify(book);
        if(serializedBooks.get(ptr.book)!==serialized){
          await io.write(ptr.book, book);
          const readback = await io.read(ptr.book);
          if (JSON.stringify(readback?.entries) !== JSON.stringify(book.entries) || readback.ark_chat_scope !== ticket.key) throw Error('native_readback_mismatch');
          serializedBooks.set(ptr.book,serialized);
        }
        if (!isCurrent(ticket)) throw Error('chat_changed_during_commit');
        const id = identity(); metadata(id, ptr);
        if (ptr.lore_mode === 'clone') id.context.chatMetadata.world_info = ptr.book;
        else if (id.context.chatMetadata.world_info === ptr.book) id.context.chatMetadata.world_info = null;
        await io.saveChat(); if (dirty.get(ticket.key)?.version === ticket.version) dirty.delete(ticket.key);
      }
    }); tail = task; return task;
  }
  const host = {
    now: () => Date.now(), chatId: () => identity().chat, identity, capture, isCurrent, prepare, flush,
    isReady(chat) { try { check(chat); return true; } catch (_) { return false; } },
    cloneName(chat) { const id = check(chat); let h = 2166136261; for (const c of id.key) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return 'ARK-ChatLore-' + (h >>> 0).toString(16) + '-' + Date.now().toString(36); },
    listBooks: () => [...books.keys()], bookExists: name => books.has(name),
    createBook(name, entries) { if (!/^ARK-ChatLore-/.test(name) || name === baselineName) throw Error('refusing_base_write'); books.set(name, clone(entries || [])); schedule(identity().chat); },
    readBook(name) { return clone(books.get(name) || []); },
    writeBook(name, entries) { const id = check(identity().chat); if (pointer(id).book !== name) throw Error('not_current_clone'); books.set(name, clone(entries)); schedule(id.chat); },
    getChatLore(chat) { return check(chat).context.chatMetadata.world_info || null; },
    setChatLore(chat, name) { const id = check(chat); if (name != null && pointer(id).book !== name) throw Error('not_current_clone'); schedule(chat); },
    getBaseBookName: () => baselineName, readBaseBook: () => clone(baseline),
    readStoryMeta(chat) { return { ...pointer(check(chat)) }; },
    writeStoryMeta(chat, ptr) { const id = check(chat); pointers.set(id.key, { ...pointer(id), ...ptr }); schedule(chat); },
    readSidecar(chat) { const id = check(chat); return stores.has(id.key) ? clone(stores.get(id.key)) : null; },
    writeSidecar(chat, data) { const id = check(chat); stores.set(id.key, clone(data)); schedule(chat); },
    readDesignApi() { return root.__ARK_CWB_TAVERN_API__.resolveGenerateApi({ context: context() }); }
  };
  return host;
}
const api = { createNativeHost, META_UID, META_COMMENT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_NATIVE_HOST__ = api;

__cwb_modules["core/native_host"]=module.exports;
__cwb_modules["native_host"]=module.exports;
})();
// ---- core/manager_bridge ----
(function(){
var module={exports:{}};var exports=module.exports;
'use strict';
function buildCatalog(data, rows) {
  const byUid=new Map(rows.map(e=>[String(e.uid),e])),used=new Set();
  const actors=data?.actors?.actors || (Array.isArray(data?.actors)?data.actors:Object.values(data?.actorById||{}));
  const records=actors.map(actor=>{
    const all=[].concat(actor.states||[],actor.profile_variants||[]).map(f=>{
      const e=byUid.get(String(f.entry_id));if(!e)return null;used.add(String(e.uid));
      return {...e,entry_id:e.uid,source_uid:e.uid,form_id:String(e.uid),comment_pk:e.comment||e.name,label:f.label||e.comment,keys:e.keys||e.key||[],enabled:e.enabled??!e.disable};
    }).filter(Boolean);
    const generic=all.filter(f=>!/[（(]剧情[·・]/.test(f.comment_pk)),chapter=all.filter(f=>/[（(]剧情[·・]/.test(f.comment_pk));
    const defaults=generic.filter(f=>f.enabled),preferred=defaults.length===1?defaults[0]:generic.find(f=>String(f.entry_id)===String(actor.timeline_default_entry??actor.default_entry));
    generic.sort((a,b)=>Number(b===preferred)-Number(a===preferred));
    return {...actor,character_id:actor.actor_id,forms:generic,chapter_entries:chapter,default_form:preferred||null};
  });
  for(const e of rows){
    if(used.has(String(e.uid)))continue;
    const pk=(e.comment||e.name||'').trim(),match=pk.match(/^\[角色\]\s*[:：]\s*(.+?)(?:[（(](.*)[）)])?$/);
    if(!match)continue;
    const name=match[1].trim();let rec=records.find(a=>a.canonical_name===name);
    if(!rec){rec={actor_id:'native_'+e.uid,character_id:'native_'+e.uid,canonical_name:name,aliases:[name],forms:[],chapter_entries:[],default_form:null};records.push(rec);}
    const form={...e,entry_id:e.uid,source_uid:e.uid,form_id:String(e.uid),comment_pk:pk,label:match[2]||pk,keys:e.key||e.keys||[],enabled:e.enabled??!e.disable};
    if(/剧情[·・]/.test(match[2]||''))rec.chapter_entries.push(form);else{rec.forms.push(form);if(form.enabled&&!rec.default_form)rec.default_form=form;}
  }
  for(const rec of records)for(const f of rec.chapter_entries)f.chapter=(f.comment_pk.match(/[（(]剧情[·・]([^·・]+)[·・]/)||[])[1]||'';
  return records;
}
function createManager(plugin, host) {
  let actors = [], baseByUid = new Map(), catalog = [], dataVersion = null;
  const context = () => { const chat = host.chatId(); return { chat, store: plugin.loadSidecar(chat) }; };
  const find = name => actors.find(a => a.canonical_name === name || a.actor_id === name);
  function forms(actor) {
    const byUid = baseByUid;
    return [].concat(actor.states || [], actor.profile_variants || []).map(f => {
      const entry = byUid.get(String(f.entry_id)); return entry ? { ...f, ...entry, form_id: String(f.entry_id), entry_id: f.entry_id,
        source_uid: f.entry_id, comment_pk: entry.comment || entry.name, label: f.label || entry.comment, keys: entry.keys || entry.key || [] } : null;
    }).filter(Boolean);
  }
  const manager = {
    setData(data) {
      if(dataVersion === data?.data_version && baseByUid.size) return;
      actors = data?.actors?.actors || (Array.isArray(data?.actors) ? data.actors : Object.values(data?.actorById || {}));
      baseByUid = new Map(host.readBaseBook().map(e=>[String(e.uid),e])); dataVersion=data?.data_version;
      catalog=buildCatalog(data,[...baseByUid.values()]);actors=catalog;
      host.readCatalog=()=>catalog;
    },
    currentSave() {
      try { const {chat,store}=context(),ptr=host.readStoryMeta(chat);return {ok:true,key:host.identity().key,save:{currentChapter:store.currentChapter||'',snapshots:(store.snapshots||[]).map(s=>({...s,label:s.reason}))},book:ptr.book,mode:ptr.lore_mode}; }
      catch(e){return {ok:false,reason:e.message};}
    },
    listCharacters() {
      try { const {store}=context();return {ok:true,characters:actors.map(a=>{const rec=store.characters[a.actor_id],selected=rec?.forms?.[rec?.selection?.primary];return {
        name:a.canonical_name,character_id:a.actor_id,current_form:selected?.comment_pk||'',default_form:a.default_form?.comment_pk||'',
        influence:plugin.archiveProtection.isArchiveProtected(store,a.actor_id)?'已有动态档案/独立条目':'普通',manual_locked:!!store.manual?.[a.canonical_name],forms:[...a.forms,...a.chapter_entries].map(f=>({id:f.form_id,label:f.label})),pending:false};})}; }
      catch(e){return {ok:false,reason:e.message};}
    },
    async enable() { const chat=host.chatId();await host.prepare(chat);plugin.enableCloneMode(chat);await host.flush();return manager.currentSave(); },
    async selectForm(name,id) {
      const {chat,store}=context(),actor=find(name);if(!actor)throw Error('unknown_character');
      if(host.readStoryMeta(chat).lore_mode!=='clone')await manager.enable();
      const form=[...actor.forms,...actor.chapter_entries].find(f=>f.form_id===String(id));if(!form)throw Error('unknown_form');
      plugin.snapshot(chat,'manual_form:'+name);
      plugin.upsertCharacterForm(chat,{character_id:actor.actor_id,canonical_name:actor.canonical_name},form);
      plugin.switchForm(chat,actor.actor_id,{primary:form.form_id});
      const next=plugin.loadSidecar(chat);next.manual||={};next.manual[name]={locked:true};host.writeSidecar(chat,next);
      await host.flush();return {ok:true};
    },
    async setManual(name,locked){const {chat,store}=context();store.manual||={};if(locked)store.manual[name]={locked:true};else delete store.manual[name];host.writeSidecar(chat,store);await host.flush();return {ok:true};},
    async snapshot(reason){const {chat}=context();const result=plugin.snapshot(chat,reason);await host.flush();return result;},
    async rollback(id){const {chat}=context();const result=plugin.rollback(chat,id);if(result.ok)await host.flush();return result;}
  };return manager;
}
const api={createManager,buildCatalog};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
if(typeof globalThis!=='undefined')globalThis.__ARK_CWB_MANAGER__=api;

__cwb_modules["core/manager_bridge"]=module.exports;
__cwb_modules["manager_bridge"]=module.exports;
})();
})(typeof globalThis!=="undefined"?globalThis:this);
