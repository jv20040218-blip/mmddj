'use strict';
// The synchronous core uses a hydrated cache; only flush() acknowledges a native save.
const META_UID = 2147483000;
const META_COMMENT = 'ARK::ChatLore::Sidecar::v2';
const clone = value => JSON.parse(JSON.stringify(value));
function createNativeHost(root, options) {
  const o = options || {}, books = new Map(), stores = new Map(), pointers = new Map();
  const dirty = new Map(), serializedBooks = new Map(); let tail = Promise.resolve(), hydrated = null, baseline = [], baselineName = '', revision = 0;
  const context = () => root.SillyTavern?.getContext?.() || {};
  function identity() {
    const c = context(), card = c.characters?.[c.characterId];
    const chat = c.getCurrentChatId?.() ?? c.chatId;
    const avatar = card?.avatar || '';
    return { chat: chat == null ? '' : String(chat), avatar, key: JSON.stringify([avatar, chat]), context: c, card };
  }
  function check(chat) {
    const id = identity();
    if (!id.chat || !id.avatar || String(chat) !== id.chat || hydrated !== id.key) throw Error('chat_scope_changed_or_not_ready');
    return id;
  }
  function capture(chat) { return { ...check(chat), context: undefined, card: undefined }; }
  function isCurrent(ticket) { return !!ticket && ticket.key === identity().key && hydrated === ticket.key; }
  function pointer(id) {
    const vars = id.context.chatMetadata?.variables || {};
    const b = vars.ark_story_v2 || {}, s = b.state || {};
    const saved = s.clone_book || b.book || b.clone_book;
    return pointers.get(id.key) || { lore_mode: s.lore_mode || b.lore_mode || 'baseline', book: saved || null, sidecar_rev: b.sidecar_rev || s.sidecar_rev || 0 };
  }
  function metadata(id, ptr) {
    const md = id.context.chatMetadata;
    if (!md) throw Error('missing_chat_metadata');
    md.variables ||= {}; const b = md.variables.ark_story_v2 ||= {};
    Object.assign(b, { lore_mode: ptr.lore_mode, book: ptr.book, sidecar_rev: ptr.sidecar_rev });
    if (b.state) Object.assign(b.state, { lore_mode: ptr.lore_mode, clone_book: ptr.book, sidecar_rev: ptr.sidecar_rev });
  }
  async function post(endpoint, body) {
    const headers = context().getRequestHeaders?.();
    if (!headers) throw Error('missing_native_request_headers');
    const response = await root.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
    if (!response.ok) throw Error('native_http_' + response.status);
    return response.json();
  }
  const io = o.io || {
    async read(name) { return post('/api/worldinfo/get', { name }); },
    async write(name, data) {
      await post('/api/worldinfo/edit', { name, data });
      const wi = await import('/scripts/world-info.js');
      wi.worldInfoCache?.delete(name); await wi.updateWorldInfoList();
    },
    async baseline() {
      const base = root.__ARK_STORY_EXTENSION__?.base || '/scripts/extensions/third-party/mmddj/';
      const r = await root.fetch(new URL('data/base_worldbook.json', new URL(base, root.location.href)).href);
      if (!r.ok) throw Error('baseline_http_' + r.status); return r.json();
    },
    async saveChat() { const result = await context().saveChat?.(); if (result === false) throw Error('native_chat_save_rejected'); }
  };
  function rows(book) { return Object.values(book?.entries || {}).map(e => ({ ...e, name: e.comment || e.name, keys: e.key || e.keys || [], enabled: !e.disable })); }
  async function prepare(chat) {
    const id = identity(); if (String(chat) !== id.chat || !id.chat || !id.avatar) throw Error('no_current_chat');
    if (!o.io && !(id.card?.data?.extensions?.tavern_helper?.scripts || []).some(s => String(s.name||'').startsWith('ARK_UI'))) throw Error('unsupported_character');
    const key = id.key;
    if (!baseline.length) {
      const raw = await io.baseline(); baseline = rows(raw);
    }
    if (identity().key !== key) throw Error('chat_changed_during_prepare');
    baselineName = id.card?.data?.extensions?.world || '';
    const ptr = pointer(id);
    if (ptr.book && !books.has(ptr.book)) {
      const raw = await io.read(ptr.book);
      if (identity().key !== key) throw Error('chat_changed_during_prepare');
      if (raw?.ark_chat_scope !== key) throw Error('clone_scope_mismatch');
      books.set(ptr.book, rows(raw).filter(e => e.comment !== META_COMMENT));
      const rec = Object.values(raw.entries || {}).find(e => e.comment === META_COMMENT);
      if (rec) stores.set(key, JSON.parse(rec.content));
    }
    pointers.set(key, ptr); hydrated = key;
    return { ...ptr };
  }
  function schedule(chat) { const id = check(chat); dirty.set(id.key, { ...capture(chat), version: ++revision }); }
  function nativeBook(ticket) {
    const ptr = pointers.get(ticket.key), entries = {};
    for (const e of books.get(ptr.book) || []) {
      const uid = Number(e.uid); if (!Number.isInteger(uid) || uid === META_UID || entries[uid]) throw Error('invalid_clone_uid');
      const src = baseline.find(b => String(b.uid) === String(e.source_uid)) || baseline.find(b => (b.comment||b.name) === e.comment_pk) || {};
      entries[uid] = { order:100, position:0, depth:4, probability:100, useProbability:true, selective:true, selectiveLogic:0, ...src, ...e, uid, key: e.keys || e.key || [], keysecondary: e.keysecondary || [],
        disable: e.enabled === false || e.disable === true, constant: e.constant !== false, content: String(e.content || '') };
    }
    entries[META_UID] = { uid: META_UID, comment: META_COMMENT, key: [], keysecondary: [], disable: true, constant: false,
      content: JSON.stringify(stores.get(ticket.key) || {}), order: 0, position: 0 };
    return { entries, ark_chat_scope: ticket.key, ark_schema: 2 };
  }
  async function flush() {
    const pending = [...dirty.values()].filter(t => t.key === identity().key);
    const task = tail.catch(() => {}).then(async () => {
      for (const ticket of pending) {
        if (!isCurrent(ticket)) throw Error('chat_changed_before_commit');
        const ptr = pointers.get(ticket.key);
        if (!ptr?.book || !/^ARK-ChatLore-/.test(ptr.book) || ptr.book === baselineName) throw Error('refusing_base_write');
        const book = nativeBook(ticket), serialized=JSON.stringify(book);
        if(serializedBooks.get(ptr.book)!==serialized){
          await io.write(ptr.book, book);
          const readback = await io.read(ptr.book);
          if (JSON.stringify(readback?.entries) !== JSON.stringify(book.entries) || readback.ark_chat_scope !== ticket.key) throw Error('native_readback_mismatch');
          serializedBooks.set(ptr.book,serialized);
        }
        if (!isCurrent(ticket)) throw Error('chat_changed_during_commit');
        const id = identity(); metadata(id, ptr);
        if (ptr.lore_mode === 'clone') id.context.chatMetadata.world_info = ptr.book;
        else if (id.context.chatMetadata.world_info === ptr.book) id.context.chatMetadata.world_info = null;
        await io.saveChat(); if (dirty.get(ticket.key)?.version === ticket.version) dirty.delete(ticket.key);
      }
    }); tail = task; return task;
  }
  const host = {
    now: () => Date.now(), chatId: () => identity().chat, identity, capture, isCurrent, prepare, flush,
    isReady(chat) { try { check(chat); return true; } catch (_) { return false; } },
    cloneName(chat) { const id = check(chat); let h = 2166136261; for (const c of id.key) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return 'ARK-ChatLore-' + (h >>> 0).toString(16) + '-' + Date.now().toString(36); },
    listBooks: () => [...books.keys()], bookExists: name => books.has(name),
    createBook(name, entries) { if (!/^ARK-ChatLore-/.test(name) || name === baselineName) throw Error('refusing_base_write'); books.set(name, clone(entries || [])); schedule(identity().chat); },
    readBook(name) { return clone(books.get(name) || []); },
    writeBook(name, entries) { const id = check(identity().chat); if (pointer(id).book !== name) throw Error('not_current_clone'); books.set(name, clone(entries)); schedule(id.chat); },
    getChatLore(chat) { return check(chat).context.chatMetadata.world_info || null; },
    setChatLore(chat, name) { const id = check(chat); if (name != null && pointer(id).book !== name) throw Error('not_current_clone'); schedule(chat); },
    getBaseBookName: () => baselineName, readBaseBook: () => clone(baseline),
    readStoryMeta(chat) { return { ...pointer(check(chat)) }; },
    writeStoryMeta(chat, ptr) { const id = check(chat); pointers.set(id.key, { ...pointer(id), ...ptr }); schedule(chat); },
    readSidecar(chat) { const id = check(chat); return stores.has(id.key) ? clone(stores.get(id.key)) : null; },
    writeSidecar(chat, data) { const id = check(chat); stores.set(id.key, clone(data)); schedule(chat); },
    readDesignApi() { return root.__ARK_CWB_TAVERN_API__.resolveGenerateApi({ context: context() }); }
  };
  return host;
}
const api = { createNativeHost, META_UID, META_COMMENT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_NATIVE_HOST__ = api;
