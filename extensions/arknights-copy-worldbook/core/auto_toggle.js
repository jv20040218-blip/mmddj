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
