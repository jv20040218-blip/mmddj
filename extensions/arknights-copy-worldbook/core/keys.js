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
