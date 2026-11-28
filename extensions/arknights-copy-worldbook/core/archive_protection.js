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
