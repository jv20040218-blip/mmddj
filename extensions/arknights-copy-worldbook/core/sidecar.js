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
