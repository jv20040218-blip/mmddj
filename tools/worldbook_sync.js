'use strict';

// Serialize physical worldbook writes. A scene change is acknowledged only after read-back.
function createWorldbookSync(options) {
  const o = options, sessions = new Map();
  let tail = Promise.resolve(), sequence = 0, current = null;
  const status = { state: 'idle', writes: 0, verified: 0, error: null };
  const key = c => c.book + '\n' + c.chat;
  function available() { return typeof o.read === 'function' && typeof o.update === 'function'; }
  async function execute(view, context, ticket) {
    if (ticket !== sequence || context.valid && !context.valid()) return { ok: false, stale: true };
    if (!available() || !context.book) { status.state = 'unavailable'; return { ok: false, unavailable: true }; }
    status.state = 'writing'; status.error = null;
    const id = key(context);
    // The same book can be reused by another chat: release the preceding scene first.
    if (current && current !== id && sessions.has(current)) {
      const previous = sessions.get(current);
      if (previous.book === context.book) {
        await o.update(previous.book, entries => entries.map(e => previous.original[e.uid] == null ? e : { ...e, enabled: previous.original[e.uid] }));
        sessions.delete(current);
      }
    }
    current = id;
    let session = sessions.get(id);
    if (!session && o.load) { const saved = o.load(context); if (saved && saved.book === context.book) session = saved; }
    if (!session && !context.active) { status.state = 'ready'; return { ok: true, changed: 0, inactive: true }; }
    if (!session) session = { book: context.book, original: {} };
    const target = {};
    if (context.active) {
      for (const uid of view.disable || []) target[uid] = false;
      for (const uid of view.enable || []) target[uid] = true;
    }
    const before = await o.read(context.book);
    if (!Array.isArray(before)) throw Error('世界书读取结果不是条目数组');
    if (ticket !== sequence || context.valid && !context.valid()) return { ok: false, stale: true };
    const byId = new Map(before.map(e => [String(e.uid), e]));
    for (const uid of Object.keys(target)) {
      if (!byId.has(uid)) throw Error('世界书缺少所需条目 UID ' + uid);
      if (!(uid in session.original)) session.original[uid] = !!byId.get(uid).enabled;
    }
    const desired = { ...session.original, ...target };
    sessions.set(id, session);
    if (o.save) o.save(context, session);
    const changes = Object.keys(desired).filter(uid => byId.has(uid) && !!byId.get(uid).enabled !== desired[uid]);
    if (changes.length) {
      await o.update(context.book, entries => {
        if (context.valid && !context.valid()) return entries;
        return entries.map(e => String(e.uid) in desired ? { ...e, enabled: desired[e.uid] } : e);
      });
      status.writes++;
    }
    if (context.valid && !context.valid()) return { ok: false, stale: true };
    const after = await o.read(context.book), actual = new Map(after.map(e => [String(e.uid), !!e.enabled]));
    for (const uid of Object.keys(desired)) if (byId.has(uid) && actual.get(uid) !== desired[uid]) throw Error('世界书开关回读不一致 UID ' + uid);
    status.verified++; status.state = 'ready';
    if (!context.active) { sessions.delete(id); if (o.save) o.save(context, null); }
    if (o.changed) o.changed({ ...status });
    return { ok: true, changed: changes.length, verified: true };
  }
  function sync(view, context) {
    const ticket = ++sequence;
    status.state = 'pending';
    tail = tail.catch(() => {}).then(() => execute(view, context, ticket)).catch(error => {
      status.state = 'error'; status.error = error.message;
      if (o.changed) o.changed({ ...status });
      return { ok: false, error: error.message };
    });
    return tail;
  }
  async function flush() { let promise; do { promise = tail; await promise; } while (promise !== tail); return promise; }
  function forget(context) { sessions.delete(key(context)); if (o.save) o.save(context, null); }
  return { sync, flush, forget, available, status };
}
const api = { createWorldbookSync };
if (typeof module !== 'undefined') module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_WORLDBOOK_SYNC__ = api;
