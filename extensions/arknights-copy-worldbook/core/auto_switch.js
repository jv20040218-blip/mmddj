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
