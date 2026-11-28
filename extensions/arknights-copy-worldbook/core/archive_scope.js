'use strict';

// Archive scope: every write must be bound to the current card + current chat
// (save) and its dedicated worldbook copy. Cross-save async results are
// rejected. The base worldbook is read-only.

const { trim } = require('./keys.js');

function stableCardId(card) {
  if (!card || typeof card !== 'object') return '';
  return trim(card.avatar || card.card_id || card.character_id || card.name || '');
}

function stableChatId(chat) {
  if (chat == null) return '';
  if (typeof chat === 'string') return trim(chat);
  if (typeof chat !== 'object') return '';
  return trim(chat.chat_id || chat.chatId || chat.id || chat.file_name || chat.fileName || '');
}

function stableCopyId(copy) {
  if (copy == null) return '';
  if (typeof copy === 'string') return trim(copy);
  if (typeof copy !== 'object') return '';
  return trim(copy.copy_id || copy.copyId || copy.worldbook_id || copy.worldbookId || copy.name || '');
}

function makeScopeKey(card, chat, copy) {
  const c = stableCardId(card);
  const s = stableChatId(chat);
  const p = stableCopyId(copy);
  if (!c || !s) return '';
  return [c, s, p].join('::');
}

function createArchiveScope(options) {
  const opts = options || {};
  const getCard = typeof opts.getCard === 'function' ? opts.getCard : () => opts.card;
  const getChat = typeof opts.getChat === 'function' ? opts.getChat : () => opts.chat;
  const getCopy = typeof opts.getCopy === 'function' ? opts.getCopy : () => opts.copy;
  const isBaseWorldbook = typeof opts.isBaseWorldbook === 'function'
    ? opts.isBaseWorldbook
    : (wb) => !!(wb && (wb.is_base || wb.isBase || wb.read_only || wb.readOnly));

  let bound = null;
  let generation = 0;
  const pending = new Set();

  function currentIdentity() {
    return {
      card: getCard(),
      chat: getChat(),
      copy: getCopy()
    };
  }

  function bind() {
    const id = currentIdentity();
    const key = makeScopeKey(id.card, id.chat, id.copy);
    if (!key) {
      bound = null;
      generation += 1;
      return { ok: false, reason: 'incomplete_identity', identity: id };
    }
    if (bound && bound.key === key) {
      return { ok: true, key, generation, identity: id, reused: true };
    }
    bound = { key, generation: generation + 1, identity: id };
    generation = bound.generation;
    // Any in-flight work from the previous binding is now stale.
    pending.clear();
    return { ok: true, key, generation, identity: id, reused: false };
  }

  function isBound() {
    return !!bound;
  }

  function currentKey() {
    return bound ? bound.key : '';
  }

  function assertWritable(target) {
    if (!bound) return { ok: false, reason: 'not_bound' };
    const id = currentIdentity();
    const key = makeScopeKey(id.card, id.chat, id.copy);
    if (!key) return { ok: false, reason: 'incomplete_identity' };
    if (key !== bound.key) return { ok: false, reason: 'scope_changed' };
    if (target && isBaseWorldbook(target)) return { ok: false, reason: 'base_read_only' };
    return { ok: true, key };
  }

  // Begin an async operation. Returns a token that must be validated before
  // committing the result. If the scope changes in between, commit is refused.
  function beginAsync(label) {
    if (!bound) return { ok: false, reason: 'not_bound' };
    const token = {
      label: trim(label) || 'async',
      key: bound.key,
      generation,
      settled: false
    };
    pending.add(token);
    return { ok: true, token };
  }

  function commitAsync(token, apply) {
    if (!token || token.settled) return { ok: false, reason: 'token_settled' };
    token.settled = true;
    pending.delete(token);
    if (!bound) return { ok: false, reason: 'not_bound' };
    if (token.key !== bound.key || token.generation !== generation) {
      return { ok: false, reason: 'stale_scope' };
    }
    if (typeof apply !== 'function') return { ok: false, reason: 'no_apply' };
    const result = apply();
    return { ok: true, result };
  }

  function abortAsync(token) {
    if (!token || token.settled) return false;
    token.settled = true;
    pending.delete(token);
    return true;
  }

  function pendingCount() {
    return pending.size;
  }

  function reset() {
    bound = null;
    generation += 1;
    pending.clear();
  }

  return {
    bind,
    isBound,
    currentKey,
    assertWritable,
    beginAsync,
    commitAsync,
    abortAsync,
    pendingCount,
    reset,
    _currentIdentity: currentIdentity
  };
}

module.exports = {
  stableCardId,
  stableChatId,
  stableCopyId,
  makeScopeKey,
  createArchiveScope
};
