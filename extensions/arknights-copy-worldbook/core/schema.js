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
