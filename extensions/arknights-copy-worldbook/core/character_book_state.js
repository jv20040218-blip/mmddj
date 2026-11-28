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
