'use strict';

// Chat Lore binding for the sparse Copy Worldbook.
// lore_mode defaults to baseline. CHAT_CHANGED never auto-creates empty
// books for legacy saves — books are created only on an explicit enable.

const DEFAULT_LORE_MODE = 'baseline';
const POINTER_FIELDS = ['lore_mode', 'book', 'sidecar_rev'];

function pointerOf(meta) {
  const m = meta || {};
  return {
    lore_mode: m.lore_mode || DEFAULT_LORE_MODE,
    book: m.book || m.clone_book || null,
    sidecar_rev: m.sidecar_rev || 0
  };
}

function pointersEqual(a, b) {
  const pa = pointerOf(a), pb = pointerOf(b);
  return pa.lore_mode === pb.lore_mode && pa.book === pb.book && pa.sidecar_rev === pb.sidecar_rev;
}

function bookNameFor(chatId) {
  return 'ark-clone::' + String(chatId);
}

function onChatChanged(host, chatId) {
  const metrics = { book_creates: 0, book_writes: 0, lore_binds: 0, meta_writes: 0, base_writes: 0 };
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  if (ptr.lore_mode !== 'clone') {
    return {
      ok: true,
      mode: ptr.lore_mode || DEFAULT_LORE_MODE,
      created: false,
      warning: null,
      writes: 0,
      ...metrics,
      pointer: ptr
    };
  }
  const name = ptr.book;
  const exists = !!(name && host.bookExists(name));
  if (!name || !exists) {
    const next = { lore_mode: 'degraded', book: name || null, sidecar_rev: ptr.sidecar_rev };
    if (!pointersEqual(ptr, next)) {
      host.writeStoryMeta(chatId, next);
      metrics.meta_writes = 1;
    }
    return {
      ok: true,
      mode: 'degraded',
      created: false,
      warning: 'missing_clone_book',
      writes: metrics.meta_writes,
      base_writes: 0,
      ...metrics,
      pointer: next
    };
  }
  const current = host.getChatLore(chatId);
  if (current === name) {
    return {
      ok: true,
      mode: 'clone',
      created: false,
      warning: null,
      writes: 0,
      ...metrics,
      pointer: ptr,
      book: name
    };
  }
  host.setChatLore(chatId, name);
  metrics.lore_binds = 1;
  return {
    ok: true,
    mode: 'clone',
    created: false,
    warning: null,
    writes: 1,
    ...metrics,
    pointer: ptr,
    book: name
  };
}

function enableCloneMode(host, chatId, options) {
  const o = options || {};
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  const name = ptr.book || o.bookName || (host.cloneName ? host.cloneName(chatId) : bookNameFor(chatId));
  let created = false;
  if (!host.bookExists(name)) {
    const initial = Array.isArray(o.initialEntries) ? o.initialEntries : [];
    host.createBook(name, initial);
    created = true;
  }
  const next = { lore_mode: 'clone', book: name, sidecar_rev: ptr.sidecar_rev || 0 };
  host.writeStoryMeta(chatId, next);
  if (host.getChatLore(chatId) !== name) host.setChatLore(chatId, name);
  return { ok: true, mode: 'clone', created, book: name, pointer: next };
}

function disableCloneMode(host, chatId, options) {
  const o = options || {};
  const meta = host.readStoryMeta(chatId) || {};
  const ptr = pointerOf(meta);
  const next = { lore_mode: DEFAULT_LORE_MODE, book: ptr.book, sidecar_rev: ptr.sidecar_rev };
  host.writeStoryMeta(chatId, next);
  if (host.getChatLore(chatId) && host.getChatLore(chatId) === ptr.book) {
    host.setChatLore(chatId, null);
  }
  if (o.deleteBook && ptr.book && host.deleteBook) host.deleteBook(ptr.book);
  return { ok: true, mode: DEFAULT_LORE_MODE, pointer: next };
}

function shouldNoopBaseFlush(metaOrMode) {
  const mode = typeof metaOrMode === 'string'
    ? metaOrMode
    : pointerOf(metaOrMode).lore_mode;
  if (mode === 'clone' || mode === 'degraded') {
    return { noop: true, reason: mode };
  }
  return { noop: false, reason: mode || DEFAULT_LORE_MODE };
}

const api = {
  DEFAULT_LORE_MODE, POINTER_FIELDS,
  pointerOf, pointersEqual, bookNameFor,
  onChatChanged, enableCloneMode, disableCloneMode, shouldNoopBaseFlush
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_LORE_BIND__ = api;
