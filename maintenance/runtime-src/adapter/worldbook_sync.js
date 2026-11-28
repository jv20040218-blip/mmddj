'use strict';

// Unique worldbook commit path (Phase A0).
// No-op diff => 0 writes and 0 verification re-reads (cache hit => 0 reads).
// Batch of toggles => 1 save; read-back checks only changed UIDs; unknown/canary
// entries are preserved byte-for-byte and never dropped or reordered.

function entrySignature(entry) {
  try { return JSON.stringify(entry); } catch (_) { return String(entry); }
}

function createWorldbookSync(options) {
  const o = options, sessions = new Map();
  let tail = Promise.resolve(), sequence = 0, current = null;
  let batchDepth = 0, pending = null, debounceTimer = null;
  const cache = new Map(); // book\nchat -> { enabled: {uid:bool}, signatures: {uid:sig}, viewKey }
  const status = { state: 'idle', writes: 0, reads: 0, verified: 0, error: null, last_changed: 0 };
  const key = c => c.book + '\n' + c.chat;
  function available() { return typeof o.read === 'function' && typeof o.update === 'function'; }
  function viewKeyOf(target) {
    const uids = Object.keys(target).sort();
    return uids.map(uid => uid + ':' + (target[uid] ? '1' : '0')).join('|');
  }
  function cacheHit(id, target) {
    const hit = cache.get(id);
    if (!hit) return false;
    for (const uid of Object.keys(target)) {
      if (!Object.prototype.hasOwnProperty.call(hit.enabled, uid)) return false;
      if (!!hit.enabled[uid] !== !!target[uid]) return false;
    }
    return true;
  }

  async function execute(view, context, ticket) {
    if (ticket !== sequence || context.valid && !context.valid()) return { ok: false, stale: true };
    if (!available() || !context.book) { status.state = 'unavailable'; return { ok: false, unavailable: true }; }
    status.state = 'writing'; status.error = null;
    const id = key(context);
    // The same book can be reused by another chat: release the preceding scene first.
    if (current && current !== id && sessions.has(current)) {
      const previous = sessions.get(current);
      if (previous.book === context.book) {
        status.writes++;
        await o.update(previous.book, entries => entries.map(e => previous.original[e.uid] == null ? e : { ...e, enabled: previous.original[e.uid] }));
        sessions.delete(current);
        cache.delete(current);
      }
    }
    current = id;
    let session = sessions.get(id);
    if (!session && o.load) { const saved = o.load(context); if (saved && saved.book === context.book) session = saved; }
    if (!session && !context.active) { status.state = 'ready'; return { ok: true, changed: 0, inactive: true, writes: 0, reads: 0 }; }
    let baselineChanged = !session;
    session = { book: context.book, original: { ...session?.original } };
    const target = {};
    if (context.active) {
      for (const uid of view.disable || []) target[String(uid)] = false;
      for (const uid of view.enable || []) target[String(uid)] = true;
      if (view.set && typeof view.set === 'object') {
        for (const [uid, on] of Object.entries(view.set)) target[String(uid)] = !!on;
      }
    }
    // Cache hit: desired flags already verified. Zero reads, zero writes.
    if (context.active && Object.keys(target).length && cacheHit(id, { ...((cache.get(id) || {}).enabled || {}), ...target }) && !baselineChanged) {
      const desired = { ...session.original, ...target };
      const hit = cache.get(id);
      let mismatch = false;
      for (const uid of Object.keys(desired)) {
        if (!Object.prototype.hasOwnProperty.call(hit.enabled, uid) || !!hit.enabled[uid] !== !!desired[uid]) { mismatch = true; break; }
      }
      if (!mismatch) {
        sessions.set(id, session);
        status.state = 'ready';
        if (o.changed) o.changed({ ...status });
        return { ok: true, changed: 0, verified: true, writes: 0, reads: 0, cached: true };
      }
    }
    status.reads++;
    const before = await o.read(context.book);
    if (!Array.isArray(before)) throw Error('世界书读取结果不是条目数组');
    if (ticket !== sequence || context.valid && !context.valid()) return { ok: false, stale: true };
    const byId = new Map(before.map(e => [String(e.uid), e]));
    for (const uid of Object.keys(target)) {
      if (!byId.has(uid)) throw Error('世界书缺少所需条目 UID ' + uid);
      if (!(uid in session.original)) {
        session.original[uid] = !!byId.get(uid).enabled;
        baselineChanged = true;
      }
    }
    const desired = context.active ? { ...session.original, ...target } : { ...session.original };
    if (context.active && baselineChanged && o.save) o.save(context, session);
    sessions.set(id, session);
    const changes = Object.keys(desired).filter(uid => byId.has(uid) && !!byId.get(uid).enabled !== desired[uid]);
    const canaryUids = (context.canaryUids || []).map(String);
    const preserved = new Map();
    for (const entry of before) {
      const uid = String(entry.uid);
      if (!changes.includes(uid)) preserved.set(uid, entrySignature(entry));
    }
    for (const uid of canaryUids) {
      if (!byId.has(uid)) throw Error('世界书缺少金丝雀条目 UID ' + uid);
    }
    if (changes.length) {
      await o.update(context.book, entries => {
        if (context.valid && !context.valid()) return entries;
        // Map in place: only flip enabled on targeted UIDs; keep order and unknown rows.
        return entries.map(e => {
          const uid = String(e.uid);
          return Object.prototype.hasOwnProperty.call(desired, uid) && !!e.enabled !== !!desired[uid]
            ? { ...e, enabled: desired[uid] }
            : e;
        });
      });
      status.writes++;
      status.last_changed = changes.length;
    }
    if (context.valid && !context.valid()) return { ok: false, stale: true };
    if (changes.length) {
      status.reads++;
      const after = await o.read(context.book);
      const actual = new Map(after.map(e => [String(e.uid), e]));
      if (after.length !== before.length) throw Error('世界书回读条目数量变化');
      for (let i = 0; i < after.length; i++) {
        if (String(after[i].uid) !== String(before[i].uid)) throw Error('世界书回读条目顺序变化');
      }
      for (const uid of changes) {
        const row = actual.get(uid);
        if (!row || !!row.enabled !== desired[uid]) throw Error('世界书开关回读不一致 UID ' + uid);
      }
      for (const [uid, sig] of preserved) {
        const row = actual.get(uid);
        if (!row || entrySignature(row) !== sig) throw Error('世界书未改条目被改写 UID ' + uid);
      }
      for (const uid of canaryUids) {
        const row = actual.get(uid);
        if (!row || entrySignature(row) !== preserved.get(uid)) throw Error('金丝雀条目被改写 UID ' + uid);
      }
    }
    const enabled = {};
    const signatures = {};
    const source = changes.length ? (await Promise.resolve()) : null;
    const rowsForCache = changes.length ? null : before;
    if (rowsForCache) {
      for (const e of rowsForCache) {
        enabled[String(e.uid)] = !!e.enabled;
        signatures[String(e.uid)] = preserved.get(String(e.uid)) || entrySignature(e);
      }
    } else {
      // after is in scope only in the changes branch; re-read not needed — use desired + preserved
      // We still have `after` if changes.length; reconstruct cache from last read.
    }
    // Rebuild cache from the last known book state without an extra read.
    const cacheRows = changes.length ? null : before;
    if (cacheRows) {
      cache.set(id, { enabled, signatures, viewKey: viewKeyOf(desired) });
    } else {
      const afterMap = {};
      // last update read is in `after` from the changes branch; recover via a local recap
    }
    status.verified++; status.state = 'ready';
    if (!context.active) { sessions.delete(id); cache.delete(id); if (o.save) o.save(context, null); }
    else {
      // Populate cache from desired flags plus preserved signatures.
      const snap = { enabled: {}, signatures: {}, viewKey: viewKeyOf(desired) };
      for (const [uid, sig] of preserved) {
        snap.signatures[uid] = sig;
        snap.enabled[uid] = Object.prototype.hasOwnProperty.call(desired, uid) ? !!desired[uid] : undefined;
      }
      // Fill enabled for every known uid
      for (const e of before) {
        const uid = String(e.uid);
        snap.enabled[uid] = Object.prototype.hasOwnProperty.call(desired, uid) ? !!desired[uid] : !!e.enabled;
        if (!snap.signatures[uid]) snap.signatures[uid] = preserved.get(uid) || entrySignature({ ...e, enabled: snap.enabled[uid] });
      }
      cache.set(id, snap);
    }
    if (o.changed) o.changed({ ...status });
    return { ok: true, changed: changes.length, verified: true, writes: changes.length ? 1 : 0, reads: changes.length ? 2 : 1 };
    void source;
  }

  let notifyScheduled = null, scheduledPromise = null;
  function enqueueExecute() {
    const job = pending;
    pending = null;
    if (!job) return tail;
    tail = tail.catch(() => {}).then(() => execute(job.view, job.context, job.ticket)).catch(error => {
      status.state = 'error'; status.error = error.message;
      if (o.changed) o.changed({ ...status });
      return { ok: false, error: error.message };
    });
    return tail;
  }
  function fireScheduled() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    const notify = notifyScheduled;
    scheduledPromise = null;
    notifyScheduled = null;
    const result = enqueueExecute();
    if (notify) notify(result);
    return result;
  }
  function schedule(view, context) {
    const ticket = ++sequence;
    status.state = 'pending';
    pending = { view, context, ticket };
    if (batchDepth > 0) return scheduledPromise || tail;
    const wait = Number(o.debounceMs) || 0;
    if (wait === 0) return fireScheduled();
    if (!scheduledPromise) scheduledPromise = new Promise(resolve => { notifyScheduled = resolve; });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fireScheduled, wait);
    return scheduledPromise;
  }

  function sync(view, context) { return schedule(view, context); }

  async function flush() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    const result = fireScheduled();
    let promise;
    do { promise = tail; await promise; } while (promise !== tail || pending);
    return result;
  }

  function beginBatch() {
 batchDepth += 1; }
  async function endBatch() {
    batchDepth = Math.max(0, batchDepth - 1);
    if (batchDepth === 0) return flush();
    return tail;
  }

  async function commitWorldbookPatch(view, context) {
    const ticket = ++sequence;
    status.state = 'pending';
    pending = null;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    tail = tail.catch(() => {}).then(() => execute(view, context, ticket)).catch(error => {
      status.state = 'error'; status.error = error.message;
      if (o.changed) o.changed({ ...status });
      return { ok: false, error: error.message };
    });
    return tail;
  }

  function forget(context) { sessions.delete(key(context)); cache.delete(key(context)); if (o.save) o.save(context, null); }
  function invalidate(context) { if (context) cache.delete(key(context)); else cache.clear(); }

  return {
    sync, flush, forget, available, status,
    commitWorldbookPatch, beginBatch, endBatch, invalidate,
    metrics: () => ({ writes: status.writes, reads: status.reads, verified: status.verified, state: status.state, error: status.error })
  };
}

// Coalesce consecutive enabled-only toggles (worldbook console "open 20 characters")
// into a single updateWorldbookWith call.
function createEnabledBatcher(updateFn, options) {
  const o = options || {};
  const wait = o.debounceMs == null ? 80 : o.debounceMs;
  let pending = null, timer = null, writes = 0;
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const job = pending;
    pending = null;
    if (!job) return { ok: true, changed: 0, writes: 0 };
    const changes = [];
    await updateFn(job.book, entries => entries.map(e => {
      const uid = String(e.uid);
      if (!Object.prototype.hasOwnProperty.call(job.desired, uid)) return e;
      const on = !!job.desired[uid];
      if (!!e.enabled !== on) changes.push({ uid, from: !!e.enabled, to: on });
      return !!e.enabled === on ? e : { ...e, enabled: on };
    }));
    writes += 1;
    const waiters = job.waiters.slice();
    const result = { ok: true, changed: changes.length, writes: 1, changes };
    for (const w of waiters) w.resolve(result);
    return result;
  }
  function queueEnabled(book, uid, enabled) {
    if (!pending || pending.book !== book) {
      if (pending) flush();
      pending = { book, desired: {}, waiters: [] };
    }
    pending.desired[String(uid)] = !!enabled;
    if (timer) clearTimeout(timer);
    const p = new Promise(resolve => pending.waiters.push({ resolve }));
    if (wait === 0) { flush(); return p; }
    timer = setTimeout(() => { timer = null; flush(); }, wait);
    return p;
  }
  return { queueEnabled, flush, get writes() { return writes; } };
}

function installCommitGate(root) {
  const g = root || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!g) return null;
  if (g.__ARK_WB_COMMIT__ && g.__ARK_WB_COMMIT__.queueEnabled) return g.__ARK_WB_COMMIT__;
  const getUpdate = () => (typeof g.updateWorldbookWith === 'function' ? g.updateWorldbookWith.bind(g) : null);
  let batcher = null;
  function ensure() {
    const fn = getUpdate();
    if (!fn) return null;
    if (!batcher) batcher = createEnabledBatcher(fn, { debounceMs: 80 });
    return batcher;
  }
  const gate = {
    queueEnabled(book, uid, enabled) {
      const b = ensure();
      if (!b) throw Error('updateWorldbookWith 不可用');
      return b.queueEnabled(book, uid, enabled);
    },
    flush() { return batcher ? batcher.flush() : Promise.resolve({ ok: true, changed: 0, writes: 0 }); },
    get writes() { return batcher ? batcher.writes : 0; }
  };
  g.__ARK_WB_COMMIT__ = gate;
  return gate;
}

const api = { createWorldbookSync, createEnabledBatcher, installCommitGate, entrySignature };
if (typeof module !== 'undefined') module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_WORLDBOOK_SYNC__ = api;
