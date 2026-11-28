'use strict';

// Character catalog loader + exact lookup helpers.
// Loads inventory-catalog.json (produced by build_character_inventory.py) and
// exposes exact-match lookups. NEVER substring-match character names.
//
// Catalog shape (see inventory-catalog.json):
//   {
//     generated_at, total_entries,
//     characters: [{
//       character_id, canonical_name, aliases: [],
//       forms: [{ entry_id, comment_pk, label, category, enabled, chapter }],
//       chapter_entries: [{ entry_id, comment_pk, chapter, label }],
//       default_form: { entry_id, comment_pk } | null,
//       group: 'character' | 'shared' | 'ungrouped' | 'ambiguous'
//     }],
//     shared: [...], ungrouped: [...], ambiguous: [...]
//   }

const fs = require('fs');
const path = require('path');

function trim(value) {
  return String(value == null ? '' : value).trim();
}

// Read primary key from a catalog form/entry object or a raw string.
// Order: comment_pk -> comment -> name. Always trimmed.
function commentPk(entryOrComment) {
  if (entryOrComment == null) return '';
  if (typeof entryOrComment === 'string') return trim(entryOrComment);
  if (typeof entryOrComment !== 'object') return '';
  if (entryOrComment.comment_pk != null) return trim(entryOrComment.comment_pk);
  if (entryOrComment.comment != null) return trim(entryOrComment.comment);
  if (entryOrComment.name != null) return trim(entryOrComment.name);
  return '';
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

// A chapter/story entry is one whose primary key carries a chapter marker,
// e.g. "（剧情·时间啊，向前！·44）" or "[剧情]...". Generic character entries
// start with "[角色]:" and are NOT chapter entries even if they mention a name.
function isChapterCommentPk(pkOrEntry) {
  const pk = commentPk(pkOrEntry);
  if (!pk) return false;
  if (/^\[角色\]\s*[:：]/.test(pk)) {
    // "[角色]: 九（剧情·时间啊，向前！·44）" is a chapter entry despite the
    // [角色] prefix — the chapter marker wins.
    return /（剧情[·・]/.test(pk) || /\(剧情[·・]/.test(pk);
  }
  if (/^\[剧情\]/.test(pk)) return true;
  if (/（剧情[·・]/.test(pk) || /\(剧情[·・]/.test(pk)) return true;
  if (/^\[设定\]/.test(pk) || /^\[指导\]/.test(pk) || /^ARK/.test(pk)) return true;
  return false;
}

function isGenericCharacterEntry(entry) {
  const pk = commentPk(entry);
  if (!/^\[角色\]\s*[:：]/.test(pk)) return false;
  return !isChapterCommentPk(pk);
}

function exactNameEquals(a, b) {
  return trim(a) !== '' && trim(a) === trim(b);
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object') {
    return { characters: [], shared: [], ungrouped: [], ambiguous: [], total_entries: 0 };
  }
  const characters = Array.isArray(raw.characters) ? raw.characters : [];
  return {
    generated_at: raw.generated_at || null,
    total_entries: raw.total_entries || 0,
    characters,
    shared: Array.isArray(raw.shared) ? raw.shared : [],
    ungrouped: Array.isArray(raw.ungrouped) ? raw.ungrouped : [],
    ambiguous: Array.isArray(raw.ambiguous) ? raw.ambiguous : []
  };
}

function loadFromObject(raw) {
  return normalizeCatalog(raw);
}

function loadFromFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, 'utf8');
  return loadFromObject(JSON.parse(text));
}

// Resolve a character by exact canonical name or alias. Returns
// { ok, character } | { ok:false, reason, ... }.
function resolveUniqueName(name, catalog) {
  const needle = trim(name);
  if (!needle) return { ok: false, reason: 'empty_name' };
  const chars = (catalog && catalog.characters) || [];
  const hits = [];
  for (const rec of chars) {
    const names = [rec.canonical_name].concat(rec.aliases || []);
    if (names.some(n => exactNameEquals(n, needle))) hits.push(rec);
  }
  if (hits.length === 1) return { ok: true, character: hits[0] };
  if (hits.length === 0) return { ok: false, reason: 'no_exact_match', name: needle };
  return {
    ok: false,
    reason: 'ambiguous',
    name: needle,
    candidates: hits.map(h => h.character_id)
  };
}

function resolveCharacterById(characterId, catalog) {
  const id = trim(characterId);
  if (!id) return { ok: false, reason: 'empty_id' };
  const chars = (catalog && catalog.characters) || [];
  const hits = chars.filter(c => trim(c.character_id) === id);
  if (hits.length === 1) return { ok: true, character: hits[0] };
  if (hits.length === 0) return { ok: false, reason: 'no_exact_match', character_id: id };
  return { ok: false, reason: 'ambiguous', character_id: id };
}

// Find a form within a character by exact comment_pk (or entry_id).
// Only matches the character's own forms; never falls back to substring.
function findFormByCommentPk(character, pkOrSelector) {
  if (!character) return { ok: false, reason: 'no_character' };
  const forms = character.forms || [];
  let pk = '';
  let entryId = null;
  if (pkOrSelector != null && typeof pkOrSelector === 'object') {
    pk = commentPk(pkOrSelector);
    entryId = entryIdOf(pkOrSelector);
  } else {
    pk = commentPk(pkOrSelector);
  }
  if (entryId != null) {
    const byId = forms.filter(f => entryIdOf(f) != null && String(entryIdOf(f)) === String(entryId));
    if (byId.length === 1) return { ok: true, form: byId[0] };
    if (byId.length > 1) return { ok: false, reason: 'ambiguous_entry_id' };
  }
  if (pk) {
    const byPk = forms.filter(f => commentPk(f) === pk);
    if (byPk.length === 1) return { ok: true, form: byPk[0] };
    if (byPk.length > 1) return { ok: false, reason: 'ambiguous_comment_pk' };
  }
  return { ok: false, reason: 'form_not_found' };
}

// Find a chapter entry within a character by exact comment_pk.
function findChapterEntryByCommentPk(character, pkOrSelector) {
  if (!character) return { ok: false, reason: 'no_character' };
  const entries = character.chapter_entries || [];
  const pk = commentPk(pkOrSelector);
  if (!pk) return { ok: false, reason: 'empty_comment_pk' };
  const hits = entries.filter(e => commentPk(e) === pk);
  if (hits.length === 1) return { ok: true, entry: hits[0] };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous_comment_pk' };
  return { ok: false, reason: 'chapter_entry_not_found' };
}

// Return the character's default (currently-enabled) generic form, if any.
function defaultFormOf(character) {
  if (!character) return null;
  if (character.default_form) return character.default_form;
  const forms = character.forms || [];
  const enabled = forms.filter(f => f && f.enabled === true && !isChapterCommentPk(f));
  if (enabled.length === 1) return enabled[0];
  return null;
}

// List all chapter entries for a character in a given chapter (exact chapter
// string match). Used by chapter_adapt to verify targets exist.
function chapterEntriesFor(character, chapter) {
  if (!character) return [];
  const want = trim(chapter);
  const entries = character.chapter_entries || [];
  return entries.filter(e => trim(e.chapter) === want);
}

const api = {
  trim,
  commentPk,
  entryIdOf,
  characterIdOf,
  isChapterCommentPk,
  isGenericCharacterEntry,
  exactNameEquals,
  loadFromObject,
  loadFromFile,
  resolveUniqueName,
  resolveCharacterById,
  findFormByCommentPk,
  findChapterEntryByCommentPk,
  defaultFormOf,
  chapterEntriesFor
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_CHARACTER_CATALOG__ = api;
