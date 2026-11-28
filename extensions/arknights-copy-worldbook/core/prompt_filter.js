'use strict';

// Outbound prompt / lore hook: when a character is overridden in the sparse
// Copy Worldbook, the base book's original entry text for that exact form
// is suppressed from the final prompt. Chapter-specific entries are never
// treated as taken over by a generic character. The base book is not mutated.

const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);
const Compiler = (typeof require === 'function' && require('./compiler')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_COMPILER__);

function overriddenSelectors(characters) {
  const list = Array.isArray(characters)
    ? characters
    : Object.keys(characters || {}).map(id => ({ character_id: id, ...characters[id] }));
  const selectors = [];
  for (const rec of list) {
    const forms = rec.forms || {};
    const formList = Array.isArray(forms) ? forms : Object.values(forms);
    const primaryId = rec.selection && rec.selection.primary;
    const chosen = primaryId != null
      ? formList.find(f => String(f.form_id || f.entry_id || f.source_uid) === String(primaryId))
      : formList[0];
    if (!chosen) continue;
    selectors.push({
      character_id: rec.character_id || rec.actor_id,
      entry_id: chosen.source_uid != null ? chosen.source_uid : chosen.entry_id,
      source_uid: chosen.source_uid != null ? chosen.source_uid : chosen.entry_id,
      comment_pk: chosen.comment_pk || '',
      form_hash: chosen.content_hash,
      compiled_content: rec.compiled_content || null
    });
  }
  return selectors;
}

function isTakenOverBaseEntry(entry, selectors) {
  if (!entry || Keys.isChapterEntry(entry) || isCloneEntry(entry)) return false;
  for (const sel of selectors || []) {
    if (Keys.exactEntryMatch(entry, sel)) return true;
  }
  return false;
}

function stripEntryContent(entry) {
  return { ...entry, content: '', disable: true, disabled: true, enabled: false, constant: false, suppressed_by: 'ark-copy-worldbook' };
}

function filterLoreCollections(lores, selectors) {
  if (!lores || typeof lores !== 'object') return { lores, removed: 0, texts: [] };
  const keys = Array.isArray(lores)
    ? null
    : ['globalLore', 'characterLore', 'chatLore', 'personaLore', 'entries', 'worldInfo'];
  let removed = 0;
  const texts = [];
  function scrub(list) {
    if (!Array.isArray(list)) return list;
    return list.map(entry => {
      if (!isTakenOverBaseEntry(entry, selectors)) return entry;
      removed += 1;
      if (entry && entry.content) texts.push(String(entry.content));
      return stripEntryContent(entry);
    });
  }
  if (Array.isArray(lores)) {
    return { lores: scrub(lores), removed, texts };
  }
  const out = { ...lores };
  for (const key of keys) {
    if (Array.isArray(out[key])) out[key] = scrub(out[key]);
  }
  return { lores: out, removed, texts };
}

function isCloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const pk = Keys.commentPk(entry);
  return typeof pk === 'string' && pk.startsWith(Compiler.CLONE_COMMENT_PREFIX);
}

function stripTextOccurrences(text, fragments, protectedSpans) {
  if (!text || typeof text !== 'string' || !fragments || !fragments.length) return text;
  let out = text;
  const tokens = [];
  for (const span of protectedSpans || []) {
    const s = String(span || '');
    if (!s || !out.includes(s)) continue;
    const token = '\u0000CWB' + tokens.length + '\u0000';
    out = out.split(s).join(token);
    tokens.push(s);
  }
  for (const frag of fragments) {
    const f = String(frag || '');
    if (f.length < 24) continue; // avoid accidental short-string wipes
    if (out.includes(f)) out = out.split(f).join('');
  }
  for (let i = 0; i < tokens.length; i++) {
    out = out.split('\u0000CWB' + i + '\u0000').join(tokens[i]);
  }
  return out;
}

function walkPrompt(payload, fn, opts) {
  if (payload == null) return payload;
  if (typeof payload === 'string') return fn(payload);
  if (Array.isArray(payload)) return payload.map(item => walkPrompt(item, fn, opts));
  if (typeof payload === 'object') {
    if (isCloneEntry(payload)) return payload;
    const out = payload;
    if (typeof out.content === 'string') out.content = fn(out.content);
    if (typeof out.mes === 'string') out.mes = fn(out.mes);
    if (typeof out.message === 'string') out.message = fn(out.message);
    if (typeof out.text === 'string') out.text = fn(out.text);
    if (Array.isArray(out.chat)) out.chat = walkPrompt(out.chat, fn, opts);
    if (Array.isArray(out.messages)) out.messages = walkPrompt(out.messages, fn, opts);
    if (Array.isArray(out.prompt)) out.prompt = walkPrompt(out.prompt, fn, opts);
    return out;
  }
  return payload;
}

function filterOutboundPrompt(payload, context) {
  const ctx = context || {};
  const selectors = ctx.selectors || overriddenSelectors(ctx.characters || []);
  const loreKeys = ['lores', 'worldInfo', 'world_info', 'characterLore', 'globalLore', 'chatLore'];
  let removed = 0;
  const texts = [];
  let out = payload;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    for (const key of loreKeys) {
      if (out[key]) {
        const filtered = filterLoreCollections(out[key], selectors);
        out[key] = filtered.lores;
        removed += filtered.removed;
        texts.push(...filtered.texts);
      }
    }
    if (Array.isArray(out.entries)) {
      const filtered = filterLoreCollections(out.entries, selectors);
      out.entries = filtered.lores;
      removed += filtered.removed;
      texts.push(...filtered.texts);
    }
  } else if (Array.isArray(out) && out[0] && (out[0].comment != null || out[0].content != null) && (out[0].uid != null || out[0].keys)) {
    const filtered = filterLoreCollections(out, selectors);
    out = filtered.lores;
    removed += filtered.removed;
    texts.push(...filtered.texts);
  }
  for (const sel of selectors) {
    if (sel.base_content) texts.push(String(sel.base_content));
  }
  const protectedSpans = [];
  for (const sel of selectors) {
    if (sel.compiled_content) protectedSpans.push(String(sel.compiled_content));
  }
  if (out && typeof out === 'object') {
    const loreLists = Array.isArray(out) ? [out] : [out.chatLore, out.entries, out.characterLore, out.globalLore];
    for (const list of loreLists) {
      if (!Array.isArray(list)) continue;
      for (const e of list) if (isCloneEntry(e) && e.content) protectedSpans.push(String(e.content));
    }
  }
  if (texts.length) out = walkPrompt(out, t => stripTextOccurrences(t, texts, protectedSpans));
  const plot = applyPlotExclusions(out, ctx.excluded || []);
  out = plot.payload;
  removed += plot.removed || 0;
  return {
    payload: out,
    removed,
    suppressed_texts: texts.length,
    selectors: selectors.length,
    excluded: plot.removed || 0,
    uncovered: plot.uncovered || []
  };
}

function stripExactFragments(text, fragments) {
  let out = String(text == null ? '' : text);
  for (const frag of fragments || []) {
    const piece = String(frag || '');
    if (piece.length < 4) continue;
    if (out.includes(piece)) out = out.split(piece).join('');
  }
  return out;
}

function exclusionFragments(excluded) {
  const out = [];
  for (const ex of excluded || []) {
    const list = [].concat((ex && ex.fragments) || [], ex && ex.content ? [ex.content] : []);
    for (const frag of list) {
      const piece = String(frag || '');
      if (piece.length >= 4 && !out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

function matchesExactExclusion(entry, ex) {
  if (!entry || !ex) return false;
  if (ex.comment_pk && Keys.commentPk(entry) === Keys.trim(ex.comment_pk)) return true;
  if (ex.entry_id != null) {
    const id = Keys.entryIdOf(entry);
    if (id != null && String(id) === String(ex.entry_id)) return true;
    if (entry.source_uid != null && String(entry.source_uid) === String(ex.entry_id)) return true;
    if (entry.uid != null && String(entry.uid) === String(ex.entry_id)) return true;
  }
  return false;
}

function scrubExcludedList(list, excluded, fragments) {
  if (!Array.isArray(list)) return { list, removed: 0, matched: [] };
  let removed = 0;
  const matched = [];
  const next = list.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const exact = (excluded || []).some(ex => matchesExactExclusion(entry, ex));
    if (exact) {
      removed += 1;
      matched.push(entry);
      return stripEntryContent(entry);
    }
    if (typeof entry.content === 'string' && fragments.length) {
      const stripped = stripExactFragments(entry.content, fragments);
      if (stripped !== entry.content) return { ...entry, content: stripped };
    }
    return entry;
  });
  return { list: next, removed, matched };
}

function applyPlotExclusions(payload, excluded) {
  const rows = excluded || [];
  const fragments = exclusionFragments(rows);
  if (!rows.length && !fragments.length) {
    return { payload, removed: 0, uncovered: [], fragments: 0 };
  }
  let out = payload;
  let removed = 0;
  const original = (() => { try { return JSON.stringify(payload); } catch (_) { return ''; } })();
  const loreKeys = ['chatLore', 'characterLore', 'globalLore', 'personaLore', 'worldInfo', 'entries', 'world_info'];
  function scrubContainer(container) {
    if (!container || typeof container !== 'object') return container;
    if (Array.isArray(container)) {
      const scrubbed = scrubExcludedList(container, rows, fragments);
      removed += scrubbed.removed;
      return scrubbed.list;
    }
    const copy = { ...container };
    for (const key of loreKeys) {
      if (Array.isArray(copy[key])) {
        const scrubbed = scrubExcludedList(copy[key], rows, fragments);
        copy[key] = scrubbed.list;
        removed += scrubbed.removed;
      } else if (copy[key] && typeof copy[key] === 'object') {
        copy[key] = scrubContainer(copy[key]);
      }
    }
    if (copy.lores) copy.lores = scrubContainer(copy.lores);
    return copy;
  }
  if (Array.isArray(out) || (out && typeof out === 'object')) out = scrubContainer(out);
  if (fragments.length) {
    const protect = [];
    out = walkPrompt(out, text => stripExactFragments(text, fragments), { protect });
  }
  const uncovered = [];
  for (const ex of rows) {
    const fragHit = (ex.fragments || []).some(frag => frag && original.includes(String(frag)))
      || (ex.content && original.includes(String(ex.content)));
    const keyHit = ex.comment_pk && original.includes(String(ex.comment_pk))
      || (ex.entry_id != null && original.includes(String(ex.entry_id)));
    if (!fragHit && !keyHit) uncovered.push(ex);
  }
  return { payload: out, removed, uncovered, fragments: fragments.length };
}

function promptContainsBaseText(payload, fragments) {
  const hits = [];
  walkPrompt(payload, text => {
    for (const frag of fragments || []) {
      if (frag && String(text).includes(String(frag))) hits.push(frag);
    }
    return text;
  });
  return hits;
}

const api = {
  overriddenSelectors, isTakenOverBaseEntry, filterLoreCollections,
  filterOutboundPrompt, promptContainsBaseText, stripTextOccurrences, isCloneEntry,
  applyPlotExclusions, matchesExactExclusion, stripExactFragments,
  CLONE_COMMENT_PREFIX: Compiler.CLONE_COMMENT_PREFIX
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_PROMPT_FILTER__ = api;
