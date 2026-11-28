'use strict';

const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);
const Hash = (typeof require === 'function' && require('./hash')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_HASH__);
const Keys = (typeof require === 'function' && require('./keys')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_KEYS__);
const Compiler = (typeof require === 'function' && require('./compiler')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_COMPILER__);
const Sidecar = (typeof require === 'function' && require('./sidecar')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SIDECAR__);
const LoreBind = (typeof require === 'function' && require('./lore_bind')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_LORE_BIND__);
const PromptFilter = (typeof require === 'function' && require('./prompt_filter')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_PROMPT_FILTER__);
const AutoToggle = (typeof require === 'function' && require('./auto_toggle')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_AUTO_TOGGLE__);
const Llm = (typeof require === 'function' && require('./llm_client')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_LLM__);
const TavernApi = (typeof require === 'function' && require('./tavern_api')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_TAVERN_API__);
const Plot = (typeof require === 'function' && require('./plot_direction')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_PLOT__);
const AutoSwitch = (typeof require === 'function' && require('./auto_switch')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_AUTO_SWITCH__);
const ArchiveProtection = (typeof require === 'function' && require('./archive_protection')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_ARCHIVE_PROTECTION__);
const Influence = (typeof require === 'function' && require('./influence')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_INFLUENCE__);
const SummaryIngest = (typeof require === 'function' && require('./summary_ingest')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SUMMARY_INGEST__);
const CharacterActions = (typeof require === 'function' && require('./character_actions')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_CHARACTER_ACTIONS__);

const STORY_CHAPTER = {
  story_0f447c9b9b: '雪原线',
  story_c579b90d26: '时间啊，向前！',
  story_899cfa8775: '孤星'
};

function resolveChapter(spec, state) {
  const candidates = [];
  if (spec && typeof spec === 'object') {
    candidates.push(spec.chapter, spec.story_id, spec.storyId, spec.story);
  }
  if (state && typeof state === 'object') {
    candidates.push(state.chapter, state.story_id, state.storyId, state.story);
  }
  for (const raw of candidates) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    if (Object.prototype.hasOwnProperty.call(STORY_CHAPTER, value)) return STORY_CHAPTER[value];
    for (const id of Object.keys(STORY_CHAPTER)) {
      if (STORY_CHAPTER[id] === value) return value;
    }
  }
  return '';
}

function loadSidecar(host, chatId) {
  const raw = host.readSidecar(chatId);
  if (!raw || typeof raw !== 'object') return Sidecar.emptySidecar();
  if (!raw.characters) raw.characters = {};
  if (!Array.isArray(raw.snapshots)) raw.snapshots = [];
  if (raw.rev == null) raw.rev = 0;
  return raw;
}

function persistSidecar(host, chatId, store) {
  host.writeSidecar(chatId, store);
  const meta = LoreBind.pointerOf(host.readStoryMeta(chatId) || {});
  if (meta.sidecar_rev !== store.rev) {
    host.writeStoryMeta(chatId, { lore_mode: meta.lore_mode, book: meta.book, sidecar_rev: store.rev });
  }
}

function createCopyWorldbookPlugin(host, options) {
  const o = options || {};
  const metrics = {
    book_creates: 0,
    base_writes: 0,
    clone_writes: 0,
    meta_writes: 0,
    llm_calls: 0,
    last_warning: null
  };
  const banners = new Map(); // chatId -> prompts

  function meta(chatId) {
    return LoreBind.pointerOf(host.readStoryMeta(chatId) || {});
  }

  function onChatChanged(chatId) {
    const result = LoreBind.onChatChanged(host, chatId);
    if (result.warning) {
      metrics.last_warning = result.warning;
      banners.set(chatId, [{ kind: 'degraded', message: '克隆世界书缺失或无法绑定，已降级为底板只读投影，不会改写底板。' }]);
    } else if (result.mode === 'clone') {
      banners.delete(chatId);
    }
    metrics.meta_writes += result.meta_writes || 0;
    return result;
  }

  function enableCloneMode(chatId, opts) {
    const result = LoreBind.enableCloneMode(host, chatId, opts);
    if (result.created) metrics.book_creates += 1;
    metrics.meta_writes += 1;
    if (result.created && (!opts || !opts.initialEntries || !opts.initialEntries.length)) {
      // empty sparse book is fine; compiled entries are written later
    }
    return result;
  }

  function disableCloneMode(chatId, opts) {
    banners.delete(chatId);
    return LoreBind.disableCloneMode(host, chatId, opts);
  }

  function shouldNoopBaseFlush(chatIdOrState) {
    if (chatIdOrState && typeof chatIdOrState === 'object' && chatIdOrState.lore_mode) {
      return LoreBind.shouldNoopBaseFlush(chatIdOrState);
    }
    return LoreBind.shouldNoopBaseFlush(meta(chatIdOrState));
  }

  function getStatus(chatId) {
    const ptr = meta(chatId);
    const exists = !!(ptr.book && host.bookExists(ptr.book));
    const store = loadSidecar(host, chatId);
    const overridden = Object.keys(store.characters || {});
    return {
      lore_mode: ptr.lore_mode,
      book: ptr.book,
      sidecar_rev: store.rev,
      book_exists: exists,
      bound_lore: host.getChatLore(chatId),
      overridden_characters: overridden,
      warning: ptr.lore_mode === 'degraded' || (ptr.lore_mode === 'clone' && !exists) ? 'missing_clone_book' : null,
      banners: banners.get(chatId) || [],
      snapshots: (store.snapshots || []).map(s => ({ id: s.id, at: s.at, reason: s.reason }))
    };
  }

  function recompileAndWrite(chatId, store) {
    const ptr = meta(chatId);
    if (ptr.lore_mode !== 'clone' || !ptr.book || !host.bookExists(ptr.book)) {
      return { ok: false, reason: ptr.lore_mode === 'clone' ? 'missing_clone_book' : 'not_in_clone_mode', writes: 0 };
    }
    const compiled = Compiler.compileBook(Sidecar.characterList(store));
    host.writeBook(ptr.book, compiled.entries);
    metrics.clone_writes += 1;
    persistSidecar(host, chatId, store);
    if (compiled.warnings && compiled.warnings.length) {
      const message = compiled.warnings[0].message || '叠开形态差分已超过字数上限并被截断。';
      metrics.last_warning = message;
      const prev = banners.get(chatId) || [];
      if (!prev.some(b => b.kind === 'diff_truncated')) {
        banners.set(chatId, prev.concat([{ kind: 'diff_truncated', message }]));
      }
    }
    return { ok: compiled.ok, entries: compiled.entries, errors: compiled.errors, warnings: compiled.warnings || [], writes: 1, sidecar_rev: store.rev };
  }

  function upsertCharacterForm(chatId, character, form) {
    const store = loadSidecar(host, chatId);
    const id = character.character_id || character.actor_id;
    Sidecar.setForm(store, id, form, character);
    return recompileAndWrite(chatId, store);
  }

  function switchForm(chatId, characterId, selection) {
    const store = loadSidecar(host, chatId);
    const result = Sidecar.switchForm(store, characterId, selection);
    if (!result.ok) return result;
    const compiled = recompileAndWrite(chatId, store);
    return { ...result, ...compiled, llm_calls: 0 };
  }

  function setDynamicLayer(chatId, characterId, patch, timelineId) {
    const store = loadSidecar(host, chatId);
    const layer = Sidecar.setDynamic(store, characterId, patch, timelineId);
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, dynamic: layer, ...compiled };
  }

  function snapshot(chatId, reason) {
    const store = loadSidecar(host, chatId);
    const rec = Sidecar.snapshot(store, reason, host);
    persistSidecar(host, chatId, store);
    return { ok: true, snapshot_id: rec.id, reason: rec.reason, characters_hash: rec.characters_hash, sidecar_rev: store.rev };
  }

  function rollback(chatId, snapshotId) {
    const store = loadSidecar(host, chatId);
    const result = Sidecar.rollback(store, snapshotId);
    if (!result.ok) return result;
    const compiled = recompileAndWrite(chatId, store);
    return { ...result, ...compiled, llm_calls: 0 };
  }

  function copyFormFromBase(chatId, characterId, form, options) {
    // Explicit admin action only. Replaces form text, then local-compiles
    // to reattach the dynamic layer. Never used by auto-toggle.
    const store = loadSidecar(host, chatId);
    snapshot(chatId, 'pre_copy_from_base');
    const rec = loadSidecar(host, chatId);
    Sidecar.setForm(rec, characterId, {
      ...form,
      content: form.content,
      content_hash: Hash.hashContent(form.content || ''),
      copied_at: host.now ? host.now() : Date.now()
    }, { character_id: characterId, canonical_name: (options && options.canonical_name) || characterId });
    if (rec.characters[characterId] && rec.characters[characterId].stale_forms) {
      delete rec.characters[characterId].stale_forms[String(form.form_id || form.entry_id || form.source_uid)];
    }
    return recompileAndWrite(chatId, rec);
  }

  function plotExclusions(store, ctx) {
    const fromStore = (store && store.plot_layer && store.plot_layer.exclusions) || [];
    const fromCtx = (ctx && ctx.excluded) || [];
    return fromStore.concat(fromCtx);
  }

  function filterOutboundPrompt(payload, chatId, ctx) {
    const ptr = meta(chatId);
    const store = loadSidecar(host, chatId);
    const excluded = plotExclusions(store, ctx);
    if (ptr.lore_mode !== 'clone') {
      if (!excluded.length) return { payload, removed: 0, suppressed_texts: 0, selectors: 0, excluded: 0, uncovered: [] };
      return PromptFilter.filterOutboundPrompt(payload, { selectors: [], excluded });
    }
    const characters = Sidecar.characterList(store);
    const compiled = Compiler.compileBook(characters);
    const compiledById = new Map((compiled.entries || []).map(e => [String(e.character_id), e]));
    const selectors = PromptFilter.overriddenSelectors(characters);
    for (const sel of selectors) {
      const entry = compiledById.get(String(sel.character_id));
      if (entry && entry.content) sel.compiled_content = entry.content;
    }
    if (ctx && Array.isArray(ctx.base_entries)) {
      for (const sel of selectors) {
        const base = ctx.base_entries.find(e => Keys.exactEntryMatch(e, sel));
        if (base && base.content) sel.base_content = String(base.content);
      }
    } else if (typeof host.readBaseBook === 'function') {
      const baseEntries = host.readBaseBook() || [];
      for (const sel of selectors) {
        const base = baseEntries.find(e => Keys.exactEntryMatch(e, sel));
        if (base && base.content) sel.base_content = String(base.content);
      }
    }
    return PromptFilter.filterOutboundPrompt(payload, { selectors, characters, excluded });
  }

  function autoToggleForSegment(chatId, spec, state) {
    const ptr = meta(chatId);
    if (ptr.lore_mode !== 'clone') {
      return { ok: true, skipped: true, reason: ptr.lore_mode, base_writes: 0, clone_writes: 0 };
    }
    if (!ptr.book || !host.bookExists(ptr.book)) {
      const degraded = onChatChanged(chatId);
      return { ok: true, skipped: true, reason: 'missing_clone_book', warning: degraded.warning, base_writes: 0, clone_writes: 0 };
    }
    const catalog = (spec && spec.catalog) || (host.readCatalog && host.readCatalog()) || o.catalog || [];
    const store = loadSidecar(host, chatId);
    const influenceByCharacter = Object.assign(
      {},
      (store && store.influence) || {},
      (spec && (spec.influenceByCharacter || spec.influence_by_character)) || {}
    );
    const manual = Object.assign(
      {},
      (store && store.manual) || {},
      (spec && (spec.manual) || {})
    );
    const excluded = ((store.plot_layer && store.plot_layer.exclusions) || []).concat((spec && spec.excluded_keys) || []);
    const plan = AutoToggle.planAutoToggle(
      Object.assign({}, spec || {}, { excluded_keys: excluded }),
      catalog.map(c=>({...c,forms:[...(c.forms||[]),...(c.chapter_entries||[])]})),
      store.characters,
      {
        store,
        influenceByCharacter: Object.assign({}, influenceByCharacter || {}),
        manual: Object.assign({}, manual || {}),
        allowsAutoModification: Influence.allowsAutoModification
      }
    );
    const baseForms = {};
    const baseEntries = (spec && spec.base_entries) || (host.readBaseBook && host.readBaseBook()) || [];
    for (const e of baseEntries) {
      const id = String(Keys.entryIdOf(e));
      baseForms[id] = { content: e.content, content_hash: Hash.hashContent(e.content || ''), comment_pk: Keys.commentPk(e) };
    }
    const applied = AutoToggle.applyAutoToggle(plan, store.characters, baseForms);
    for (const ev of applied.results) {
      if (ev.action === 'stale_prompt') {
        Sidecar.markStale(store, ev.character_id, ev.entry_id, {
          base_hash: ev.prompt.base_hash,
          clone_hash: ev.prompt.clone_hash,
          marked_at: host.now ? host.now() : Date.now()
        });
      }
    }
    // One clone-book compile/write for this paragraph (even if only flags change).
    const compiled = recompileAndWrite(chatId, store);
    if (applied.prompts.length) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat(applied.prompts));
    }
    if (plan.warning) {
      metrics.last_warning = plan.warning.message;
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{ kind: plan.warning.kind || 'auto_toggle_cap', message: plan.warning.message }]));
    }
    const result = {
      ok: true,
      plan,
      results: applied.results,
      prompts: applied.prompts,
      base_writes: 0,
      clone_writes: compiled.writes || 0,
      dynamic_overwrites: 0,
      entries: compiled.entries,
      protected: (plan && plan.protected) || [],
      warning: plan.warning || null
    };
    if (result.protected.length > 0) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{
        kind: 'archive_protected',
        message: '已有独立条目或动态档案，本次未自动切换：' + result.protected.map(p => p.name).join('、')
      }]));
    }

    // Additive chapter switch for the three adapted stories. Legacy callers
    // without a resolvable chapter keep the exact result above.
    state = state || (spec && spec.state) || {};
    const chapter = resolveChapter(spec, state);
    if (!chapter || !AutoSwitch || typeof AutoSwitch.planAutoSwitch !== 'function') {
      return result;
    }

    const sceneCharacters = [];
    const seenNames = new Set();
    const extraMissing = [];
    const pushName = (name) => {
      const n = String(name || '').trim();
      if (!n || seenNames.has(n)) return;
      seenNames.add(n);
      sceneCharacters.push({ name: n });
    };
    const rawScene = (spec && (spec.scene_characters || spec.sceneCharacters)) || [];
    for (const c of rawScene) {
      if (typeof c === 'string') pushName(c);
      else if (c && (c.name || c.canonical_name || c.character_name)) {
        pushName(c.name || c.canonical_name || c.character_name);
      }
    }
    for (const s of (spec && spec.speakers) || []) {
      if (typeof s === 'string') pushName(s);
      else if (s && (s.name || s.canonical_name || s.character_name)) {
        pushName(s.name || s.canonical_name || s.character_name);
      }
    }
    const byId = new Map();
    for (const c of catalog || []) {
      if (!c) continue;
      if (c.character_id) byId.set(String(c.character_id), c);
      if (c.actor_id) byId.set(String(c.actor_id), c);
    }
    for (const fid of (spec && (spec.focus_actor_ids || spec.focusActorIds)) || []) {
      const hit = byId.get(String(fid));
      if (hit && (hit.canonical_name || hit.name)) pushName(hit.canonical_name || hit.name);
      else extraMissing.push({ name: String(fid), reason: 'unresolved_focus' });
    }

    const currentForms = {};
    for (const id of Object.keys(store.characters || {})) {
      const rec = store.characters[id];
      if (!rec || !rec.forms || !rec.selection) continue;
      const form = rec.forms[String(rec.selection.primary)];
      if (form && form.comment_pk) {
        const key = rec.canonical_name || rec.name || id;
        currentForms[key] = form.comment_pk;
        if (id !== key) currentForms[id] = form.comment_pk;
      }
    }


    const contentForPk = (pk) => {
      if (pk == null) return null;
      const key = String(pk);
      for (const c of catalog || []) {
        for (const f of (c && c.forms) || []) {
          if (f && String(f.comment_pk) === key) return f.content;
        }
      }
      for (const e of baseEntries) {
        const epk = (e && (e.comment_pk || Keys.commentPk(e))) || '';
        if (String(epk) === key || String(e && e.comment) === key) return e.content;
      }
      for (const id of Object.keys(store.characters || {})) {
        const rec = store.characters[id];
        for (const f of Object.values((rec && rec.forms) || {})) {
          if (f && String(f.comment_pk) === key) return f.content;
        }
      }
      return null;
    };

    const characterIdFor = (name) => {
      const n = String(name || '').trim();
      for (const c of catalog || []) {
        const names = [c && c.canonical_name, c && c.name].concat((c && c.aliases) || []);
        if (names.some(x => x && String(x) === n) && c.character_id) return String(c.character_id);
      }
      for (const id of Object.keys(store.characters || {})) {
        const rec = store.characters[id];
        if (id === n || (rec && (rec.canonical_name === n || rec.name === n))) return id;
      }
      return n;
    };

    let switchPlan;
    try {
      switchPlan = AutoSwitch.planAutoSwitch({
        chapter,
        sceneCharacters,
        influenceByCharacter,
        currentForms,
        manual,
        catalog,
        store
      });
    } catch (err) {
      result.chapter_switch_error = err && err.message ? err.message : String(err);
      return result;
    }

    const writer = {
      isWritable() {
        return ptr.lore_mode === 'clone' && !!(ptr.book && host.bookExists(ptr.book));
      },
      setEntryEnabled(comment_pk, enabled) {
        if (!enabled) return { ok: true };
        const item = ((switchPlan && switchPlan.switched) || []).find(s => String(s.comment_pk) === String(comment_pk));
        const name = (item && item.name) || '';
        const characterId = characterIdFor(name);
        const content = contentForPk(comment_pk);
        if (content == null && !item) return { ok: false, error: 'entry_not_found' };
        const rec = store.characters[characterId];
        let formId = null;
        if (rec && rec.forms) {
          for (const fid of Object.keys(rec.forms)) {
            if (String(rec.forms[fid].comment_pk) === String(comment_pk)) { formId = fid; break; }
          }
        }
        if (!formId) formId = String(comment_pk);
        Sidecar.setForm(store, characterId, {
          form_id: formId,
          comment_pk,
          content: content == null ? '' : content,
          copied_at: host.now ? host.now() : Date.now()
        }, { character_id: characterId, canonical_name: name || characterId });
        return Sidecar.switchForm(store, characterId, { primary: formId });
      }
    };

    const switchApplied = AutoSwitch.applyAutoSwitch(switchPlan, writer, {
      store,
      influenceByCharacter,
      manual,
      isStillValid: function (item) {
        return ArchiveProtection.stillValidForWrite({
          name: item && item.name,
          store,
          influenceByCharacter,
          manual,
          writer
        });
      }
    });
    if (switchApplied && switchApplied.applied && switchApplied.applied.length) {
      const recompiled = recompileAndWrite(chatId, store);
      result.clone_writes = (result.clone_writes || 0) + (recompiled.writes || 0);
      result.entries = recompiled.entries || result.entries;
    }
    const missing = ((switchPlan && switchPlan.missing) || []).concat(extraMissing);
    result.chapter_switch = {
      chapter,
      adapted: !!(switchPlan && switchPlan.adapted),
      switched: (switchPlan && switchPlan.switched) || [],
      unchanged: (switchPlan && switchPlan.unchanged) || [],
      protected: (switchPlan && switchPlan.protected) || [],
      missing,
      overflow: (switchPlan && switchPlan.overflow) || [],
      overflowNotice: (switchPlan && switchPlan.overflowNotice) || null,
      cap: switchPlan && switchPlan.cap,
      applied: switchApplied
    };
    if (switchPlan && switchPlan.overflowNotice) {
      const prev = banners.get(chatId) || [];
      const message = switchPlan.overflowNotice.message || switchPlan.overflowNotice;
      metrics.last_warning = message;
      banners.set(chatId, prev.concat([{ kind: 'chapter_switch_overflow', message }]));
    }
    if (switchPlan && switchPlan.protected && switchPlan.protected.length > 0) {
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{
        kind: 'archive_protected',
        message: '已有独立条目或动态档案，本次未自动切换：' + switchPlan.protected.map(p => p.name).join('、')
      }]));
    }
    return result;
  }

  function designApi(explicit) {
    if (TavernApi && TavernApi.isUsable(explicit)) return explicit;
    if (explicit && (explicit.key || explicit.api_key || explicit.apiKey) && (explicit.url || explicit.endpoint)) return explicit;
    if (host && typeof host.readDesignApi === 'function') {
      try {
        const cfg = host.readDesignApi();
        if (TavernApi && TavernApi.isUsable(cfg)) return cfg;
        if (cfg && (cfg.key || cfg.api_key || cfg.apiKey) && (cfg.url || cfg.endpoint)) return cfg;
      } catch (_) {}
    }
    return null;
  }

  function rememberExclusions(store, rows, factIds) {
    const layer = store.plot_layer && typeof store.plot_layer === 'object'
      ? store.plot_layer
      : { exclusions: [] };
    const merged = Plot.mergeExclusions(layer.exclusions || [], []);
    const next = Plot.mergeExclusions(merged, (rows || []).map(row => ({
      ...row,
      fact_ids: row.fact_ids && row.fact_ids.length ? row.fact_ids : factIds
    })));
    store.plot_layer = { exclusions: next, fact_ids: factIds || layer.fact_ids || [] };
    return next;
  }

  function applyProfileSections(store, profile) {
    const id = profile.character_id;
    if (!store.characters[id]) return null;
    const rec = store.characters[id];
    const tid = rec.active_timeline || 'main';
    const prev = Compiler.normalizeDynamic((rec.dynamic && (rec.dynamic[tid] || rec.dynamic.main)) || {});
    const sections = profile.sections || {};
    const events = (prev.non_canon_events || []).slice();
    if (sections['经历'] && !events.includes(sections['经历'])) events.push(sections['经历']);
    const relationship = [prev.relationship, sections['人际关系']].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    const personality = [prev.personality_delta, sections['特点'], sections['备注'] ? '【处境】' + sections['备注'] : ''].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    Sidecar.setDynamic(store, id, {
      non_canon_events: events,
      relationship,
      personality_delta: personality
    }, tid);
    const note = [sections['经历'], sections['人际关系'], sections['特点'], sections['备注']].filter(Boolean).join('\n');
    rec.plot_overlay = rec.plot_overlay || {};
    if (note) rec.plot_overlay.profile_note = note;
    return id;
  }

  function applyEntryWrite(store, entry) {
    if (!entry || entry.action === 'keep' || !entry.character_id) return false;
    const rec = store.characters[entry.character_id];
    if (!rec) return false;
    rec.plot_overlay = rec.plot_overlay || { suppressed_fragments: [], replacement: '', disable_entry: false };
    const frags = [].concat(rec.plot_overlay.suppressed_fragments || [], entry.fragments || []);
    rec.plot_overlay.suppressed_fragments = frags.filter((v, i, a) => v && a.indexOf(v) === i);
    if (entry.action === 'replace' && entry.content) rec.plot_overlay.replacement = entry.content;
    if (entry.action === 'disable' && !entry.content) rec.plot_overlay.disable_entry = true;
    rec.plot_overlay.fact_ids = entry.fact_ids || rec.plot_overlay.fact_ids || [];
    Sidecar.bump(store);
    return true;
  }

  async function revisePlotDirection(chatId, request, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const req = request || {};
    const factIds = (req.settled_facts || []).map(fact => fact.fact_id).filter(Boolean);
    // 从 sidecar 注入有效行动与档案版本，作为必读输入。
    try {
      const store = loadSidecar(host, chatId);
      if (store) {
        const actions = [];
        const archives = {};
        const required = [];
        for (const cid of Object.keys(store.characters || {})) {
          const rec = store.characters[cid];
          const tid = rec.active_timeline || 'main';
          const list = Sidecar.actionList(store, cid, { includeVoided: false });
          for (const a of list) actions.push({ ...a, character_id: cid });
          archives[cid] = {
            timeline_id: tid,
            dynamic: JSON.parse(JSON.stringify((rec.dynamic && rec.dynamic[tid]) || {})),
            rev: store.rev || 0
          };
          if (list.length) required.push(cid);
        }
        req.effective_actions = actions;
        req.archive_version = store.rev != null ? store.rev : 0;
        req.character_archives = archives;
        if (!Array.isArray(req.required_characters) || !req.required_characters.length) {
          req.required_characters = required;
        }
      }
    } catch (e) { /* sidecar 不可用时保持缺项 */ }
    let design = { ok: false, reason: 'not_called', llm_calls: 0 };
    if (req.call_design) {
      const cfg = designApi(api);
      try {
        design = await Llm.designPlot(req, cfg, o.fetch);
        if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',llm_calls:1,cursor_advanced:false,floors_created:0};
      } catch (e) {
        design = { ok: false, reason: 'design_api_unavailable', llm_calls: 0 };
      }
      metrics.llm_calls += design.llm_calls || 0;
    }
    const review = Plot.validateDesignEdits(req, design.ok ? design.revision : null);
    const accepted = review.ok ? review.accepted : { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null };
    const localRows = req.local_exclusions || [];
    const acceptedRows = (review.ok ? accepted.worldbook : []).map(entry => ({ ...entry, fact_ids: factIds }));
    const excluded = Plot.mergeExclusions(localRows, acceptedRows);
    const capped = Plot.capEntryWrites(review.ok ? accepted.worldbook : [], Plot.WRITE_CAP);
    const warnings = (review.warnings || []).concat(capped.warning ? [capped.warning] : []);
    let entryWrites = 0;
    let profileIds = [];
    const ptr = meta(chatId);
    if (ptr.lore_mode === 'clone' && ptr.book && host.bookExists(ptr.book)) {
      const store = loadSidecar(host, chatId);
      const hasApply = review.ok && Array.isArray(capped.apply) && capped.apply.length > 0;
      const hasProfile = review.ok && Array.isArray(accepted.profile) && accepted.profile.length > 0;
      const hasExclusions = Array.isArray(excluded) && excluded.length > 0;
      const hasFacts = Array.isArray(factIds) && factIds.length > 0;
      const hasRevision = hasApply || hasProfile || hasExclusions || hasFacts;
      if (hasRevision) {
        Sidecar.snapshot(store, 'plot_revision_before', host, { plot_fact_ids: factIds, segment_key: req.segment_key || null });
        rememberExclusions(store, excluded, factIds);
        if (review.ok) {
          for (const entry of capped.apply) {
            if (applyEntryWrite(store, { ...entry, fact_ids: factIds })) entryWrites += 1;
          }
          for (const profile of accepted.profile || []) {
            const applied = applyProfileSections(store, profile);
            if (applied) profileIds.push(applied);
          }
        }
        const overlays = Object.values(store.characters || {}).some(rec => rec && rec.plot_overlay);
        if (overlays || profileIds.length) recompileAndWrite(chatId, store);
        else persistSidecar(host, chatId, store);
      }
    }
    if (capped.warning) {
      metrics.last_warning = capped.warning.message;
      const prev = banners.get(chatId) || [];
      banners.set(chatId, prev.concat([{ kind: 'auto_toggle_cap', message: capped.warning.message }]));
    }
    return {
      ok: !!(design.ok && review.ok),
      reason: !design.ok ? (design.reason || 'design_unavailable') : review.reason,
      accepted: review.ok ? accepted : { brief_facts: [], future_summaries: [], worldbook: [], profile: [], sideline: null },
      rejected: review.rejected || [],
      excluded_keys: excluded,
      warnings,
      llm_calls: design.llm_calls || 0,
      cursor_advanced: false,
      floors_created: 0,
      scene_continues: true,
      entry_writes: entryWrites,
      cap_deferred: capped.deferred.length,
      profile_ids: profileIds
    };
  }

  function rollbackPlotRevisions(chatId, spec) {
    const ids = new Set((spec && spec.fact_ids) || []);
    if (!ids.size) return { ok: true, rolled: false, llm_calls: 0, cursor_advanced: false, floors_created: 0 };
    const store = loadSidecar(host, chatId);
    const snaps = (store.snapshots || []).filter(row => row && !row.voided && (row.plot_fact_ids || []).some(id => ids.has(id)));
    if (!snaps.length) return { ok: true, rolled: false, reason: 'no_plot_snapshot', llm_calls: 0, cursor_advanced: false, floors_created: 0 };
    const target = snaps[0];
    const targetAt = (store.snapshots || []).findIndex(row => row && row.id === target.id);
    const result = Sidecar.rollback(store, target.id);
    if (!result.ok) return result;
    (store.snapshots || []).forEach((row, index) => {
      if (!row || index <= targetAt) return;
      if ((row.plot_fact_ids || []).some(id => ids.has(id)) || (row.plot_fact_ids || []).length) row.voided = true;
    });
    const ptr = meta(chatId);
    if (ptr.lore_mode === 'clone' && ptr.book && host.bookExists(ptr.book)) recompileAndWrite(chatId, store);
    else persistSidecar(host, chatId, store);
    return { ...result, rolled: true, snapshot_id: target.id, cursor_advanced: false, floors_created: 0 };
  }

  async function summarizeIntoProfile(chatId, characterId, input, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const before = snapshot(chatId, 'pre_summarize');
    const store = loadSidecar(host, chatId);
    const rec = store.characters[characterId];
    const existing = rec && rec.selection && rec.forms[rec.selection.primary]
      ? Schema.toStructured(rec.forms[rec.selection.primary].content)
      : {};
    const result = await Llm.summarizeChat({
      ...(input || {}),
      character_id: characterId,
      canonical_name: (rec && rec.canonical_name) || characterId,
      existing_profile: existing
    }, designApi(api), o.fetch);
    metrics.llm_calls += result.llm_calls || 0;
    if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',unchanged:true,llm_calls:1};
    if (!result.ok) return { ...result, unchanged: true, snapshot_id: before.snapshot_id };
    const serialized = Schema.fromStructured(result.sections, existing._preamble || ((rec && rec.canonical_name) ? '# ' + rec.canonical_name : ''));
    // Summarizer updates the dynamic-facing compiled view by writing the
    // structured sections back onto the primary form's experiences via the
    // dynamic layer where possible; the returned 14-section body is stored
    // as the compiled target and the primary form text remains the immutable
    // base unless the caller also requested a form rewrite.
    if (result.sections['经历'] || result.sections['人际关系'] || result.sections['特点']) {
      Sidecar.setDynamic(store, characterId, {
        non_canon_events: result.sections['经历'] ? [result.sections['经历']] : [],
        relationship: result.sections['人际关系'] || '',
        personality_delta: result.sections['特点'] || ''
      }, rec && rec.active_timeline);
    }
    rec && (rec.last_summary = { sections: result.sections, serialized, at: host.now ? host.now() : Date.now() });
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, sections: result.sections, snapshot_id: before.snapshot_id, llm_calls: result.llm_calls, ...compiled };
  }

  async function mergeTimelines(chatId, characterId, input, api) {
    const scopeTicket = host.capture ? host.capture(chatId) : null;
    const before = snapshot(chatId, 'pre_merge');
    const store = loadSidecar(host, chatId);
    const rec = store.characters[characterId];
    if (!rec) return { ok: false, reason: 'character_not_in_clone', llm_calls: 0, snapshot_id: before.snapshot_id };
    const fromId = (input && input.from_timeline) || rec.active_timeline || 'main';
    const toId = (input && input.to_timeline) || 'main';
    const primary = rec.forms[rec.selection.primary] || Object.values(rec.forms || {})[0];
    const result = await Llm.mergeTimelines({
      character_id: characterId,
      canonical_name: rec.canonical_name,
      from_timeline: fromId,
      to_timeline: toId,
      target_profile: input && input.target_profile || (primary ? Schema.toStructured(primary.content) : {}),
      source_profile: input && input.source_profile || {},
      dynamic_layer: rec.dynamic[fromId] || rec.dynamic.main
    }, designApi(api), o.fetch);
    metrics.llm_calls += result.llm_calls || 0;
    if(scopeTicket && !host.isCurrent(scopeTicket))return {ok:false,reason:'chat_scope_changed',unchanged:true,llm_calls:1};
    if (!result.ok) {
      // Parse failure: hashes stay unchanged (we snapshotted but did not apply).
      return { ...result, unchanged: true, snapshot_id: before.snapshot_id };
    }
    Sidecar.setDynamic(store, characterId, {
      ...(rec.dynamic[fromId] || {}),
      personality_delta: result.sections['特点'] || (rec.dynamic[fromId] && rec.dynamic[fromId].personality_delta) || '',
      relationship: result.sections['人际关系'] || (rec.dynamic[fromId] && rec.dynamic[fromId].relationship) || '',
      non_canon_events: result.sections['经历'] ? [result.sections['经历']] : ((rec.dynamic[fromId] && rec.dynamic[fromId].non_canon_events) || [])
    }, toId);
    rec.active_timeline = toId;
    rec.last_merge = { sections: result.sections, at: host.now ? host.now() : Date.now() };
    const compiled = recompileAndWrite(chatId, store);
    return { ok: true, sections: result.sections, snapshot_id: before.snapshot_id, llm_calls: result.llm_calls, ...compiled };
  }

  function attachArchiveSummaryPrompt(chatId, promptPayload) {
    const store = loadSidecar(host, chatId);
    const chars = Sidecar.characterList(store) || [];
    const lines = [];
    for (const ch of chars) {
      if (!ch) continue;
      const id = ch.id || ch.character_id;
      if (!id) continue;
      const dyn = ch.dynamic || {};
      const form = ch.form || {};
      const pick = k => (dyn[k] != null ? dyn[k] : (form[k] != null ? form[k] : ''));
      const exp = pick('经历');
      const rel = pick('人际关系');
      const feat = pick('特点');
      const note = pick('备注');
      if (!exp && !rel && !feat && !note) continue;
      lines.push('角色: ' + id);
      if (exp) lines.push('  经历: ' + exp);
      if (rel) lines.push('  人际关系: ' + rel);
      if (feat) lines.push('  特点: ' + feat);
      if (note) lines.push('  备注: ' + note);
    }
    const block = [
      '【存档摘要区】',
      lines.length ? lines.join('\n') : '(暂无已确认摘要)',
      '',
      '【机器可读输出约定】',
      '若本回合有角色状态变化，请在可见正文之后追加如下注释块（无变化则省略）：',
      '<!--ARK_ARCHIVE_SUMMARY',
      '{"characters":[{"character_id":"<已确认角色id>","no_change":false,"sections":{"经历":"...","人际关系":"...","特点":"...","备注":"..."},"actions":[{"situation":"...","behavior":"...","result":"..."}]}]}',
      '-->',
      '仅可填写已确认绑定的角色；无变化时 no_change 置 true 且不填 sections。'
    ].join('\n');

    const payload = promptPayload || {};
    if (typeof payload === 'string') return payload + '\n\n' + block;
    if (Array.isArray(payload.chat)) {
      payload.chat.push({ role: 'system', content: block });
      return payload;
    }
    if (Array.isArray(payload)) {
      payload.push({ role: 'system', content: block });
      return payload;
    }
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.concat([{ role: 'system', content: block }]);
      return payload;
    }
    if (typeof payload.prompt === 'string') {
      payload.prompt = payload.prompt + '\n\n' + block;
      return payload;
    }
    if (typeof payload.text === 'string') {
      payload.text = payload.text + '\n\n' + block;
      return payload;
    }
    payload.prompt = block;
    return payload;
  }

  function onVisibleGenerationComplete(chatId, info) {
    const opts = info || {};
    const source = opts.source;
    if (SummaryIngest && typeof SummaryIngest.isInternalSource === 'function' && SummaryIngest.isInternalSource(source)) {
      return { ok: true, skipped: true, reason: 'internal_source' };
    }
    const rawText = typeof opts.rawText === 'string' ? opts.rawText : '';
    const messageId = opts.messageId;
    const swipeId = opts.swipeId;
    const branchId = opts.branchId;
    const store = loadSidecar(host, chatId);
    const idemKey = Sidecar.actionKey(chatId, messageId, branchId, swipeId);

    const parsed = (SummaryIngest && typeof SummaryIngest.parseArchiveSummary === 'function')
      ? SummaryIngest.parseArchiveSummary(rawText)
      : { ok: false, reason: 'no_parser' };

    if (!parsed || !parsed.ok) {
      Sidecar.markSyncGap(store, '__global__', { reason: (parsed && parsed.reason) || 'missing_summary', messageId, branchId });
      persistSidecar(host, chatId, store);
      return { ok: false, reason: (parsed && parsed.reason) || 'missing_summary', syncGap: true };
    }

    const entries = Array.isArray(parsed.characters) ? parsed.characters : [];
    const known = new Set((Sidecar.characterList(store) || []).map(c => c && (c.id || c.character_id)).filter(Boolean));
    let changed = 0;
    let appended = 0;
    let rejected = 0;

    for (const entry of entries) {
      if (!entry || !entry.character_id) { rejected++; continue; }
      const id = entry.character_id;
      if (!known.has(id)) { rejected++; continue; }
      if (entry.no_change) continue;

      const sections = entry.sections || {};
      const ch = Sidecar.ensureCharacter(store, id);
      if (!ch) { rejected++; continue; }
      if (!ch.dynamic) ch.dynamic = {};
      const patch = {};
      let touched = false;
      for (const k of ['经历', '人际关系', '特点', '备注']) {
        if (sections[k] != null && String(sections[k]).length) {
          patch[k] = String(sections[k]);
          touched = true;
        }
      }
      if (touched) {
        Sidecar.setDynamic(store, id, patch);
        changed++;
      }

      const acts = Array.isArray(entry.actions) ? entry.actions : [];
      for (const act of acts) {
        if (!act) continue;
        const rec = {
          situation: act.situation != null ? String(act.situation) : '',
          behavior: act.behavior != null ? String(act.behavior) : '',
          result: act.result != null ? String(act.result) : '',
          message_id: messageId,
          branch_id: branchId,
          swipe_id: swipeId,
          snapshot_id: opts.snapshotId,
          idempotency_key: idemKey + '|' + id + '|' + appended
        };
        const before = Sidecar.actionList(store, id).length;
        Sidecar.appendAction(store, id, rec);
        if (Sidecar.actionList(store, id).length > before) appended++;
      }
    }

    Sidecar.setProcessedPosition(store, '__global__', {
      messageId, branchId, swipeId, idempotency_key: idemKey, at: Date.now()
    });
    Sidecar.clearSyncGap(store, '__global__');

    persistSidecar(host, chatId, store);
    try { recompileAndWrite(chatId, store); } catch (e) { /* keep silent */ }

    return { ok: true, changed, appended, rejected, idempotency_key: idemKey };
  }

  function invalidateArchiveContributions(chatId, info) {
    const opts = info || {};
    const store = loadSidecar(host, chatId);
    const chars = Sidecar.characterList(store) || [];
    let voided = 0;
    for (const ch of chars) {
      if (!ch) continue;
      const id = ch.id || ch.character_id;
      if (!id) continue;
      if (opts.messageId != null) {
        voided += Sidecar.invalidateActionsByMessage(store, id, opts.messageId);
      }
      if (opts.afterSnapshotId != null) {
        voided += Sidecar.invalidateActionsAfterRollback(store, id, { afterSnapshotId: opts.afterSnapshotId });
      }
    }
    persistSidecar(host, chatId, store);
    try { recompileAndWrite(chatId, store); } catch (e) { /* keep silent */ }
    return { ok: true, voided };
  }

  const plugin = {
    host, metrics, banners,
    onChatChanged, enableCloneMode, disableCloneMode, shouldNoopBaseFlush, getStatus,
    upsertCharacterForm, switchForm, setDynamicLayer, snapshot, rollback,
    copyFormFromBase, filterOutboundPrompt, autoToggleForSegment,
    archiveProtection: ArchiveProtection,
    summarizeIntoProfile, mergeTimelines, revisePlotDirection, rollbackPlotRevisions,
    attachArchiveSummaryPrompt, onVisibleGenerationComplete, invalidateArchiveContributions,
    loadSidecar: chatId => loadSidecar(host, chatId),
    compileBook: chatId => Compiler.compileBook(Sidecar.characterList(loadSidecar(host, chatId))),
    recompileAndWrite
  };
  return plugin;
}

function createMemoryHost(options) {
  const o = options || {};
  const books = new Map(); // name -> entries
  const lore = new Map(); // chatId -> book name
  const meta = new Map();
  const sidecars = new Map();
  const baseName = o.baseName || 'base-worldbook';
  const baseEntries = Array.isArray(o.baseEntries) ? o.baseEntries.map(e => JSON.parse(JSON.stringify(e))) : [];
  books.set(baseName, baseEntries.map(e => JSON.parse(JSON.stringify(e))));
  const metrics = { base_writes: 0, book_creates: 0, lore_binds: 0 };
  return {
    metrics, books, lore, meta, sidecars, baseName,
    now: o.now || (() => Date.now()),
    chatId: () => o.chatId || 'chat_a',
    listBooks: () => [...books.keys()],
    bookExists: name => books.has(name),
    createBook(name, entries) {
      if (name === baseName) { metrics.base_writes += 1; }
      else metrics.book_creates += 1;
      books.set(name, Array.isArray(entries) ? entries.map(e => JSON.parse(JSON.stringify(e))) : []);
    },
    readBook(name) {
      const rows = books.get(name);
      return rows ? rows.map(e => JSON.parse(JSON.stringify(e))) : null;
    },
    writeBook(name, entries) {
      if (name === baseName) metrics.base_writes += 1;
      books.set(name, Array.isArray(entries) ? entries.map(e => JSON.parse(JSON.stringify(e))) : []);
    },
    deleteBook(name) {
      if (name === baseName) return false;
      return books.delete(name);
    },
    getChatLore: chatId => lore.get(chatId) || null,
    setChatLore(chatId, name) { metrics.lore_binds += 1; if (name == null) lore.delete(chatId); else lore.set(chatId, name); },
    getBaseBookName: () => baseName,
    readBaseBook: () => (books.get(baseName) || []).map(e => JSON.parse(JSON.stringify(e))),
    hashBaseBook: () => Hash.hashEntries(books.get(baseName) || []),
    readStoryMeta: chatId => meta.get(chatId) || { lore_mode: 'baseline', book: null, sidecar_rev: 0 },
    writeStoryMeta(chatId, ptr) { meta.set(chatId, { ...LoreBind.pointerOf(meta.get(chatId)), ...ptr }); },
    readSidecar: chatId => sidecars.has(chatId) ? JSON.parse(JSON.stringify(sidecars.get(chatId))) : null,
    writeSidecar(chatId, data) { sidecars.set(chatId, JSON.parse(JSON.stringify(data))); }
  };
}

const api = {
  createCopyWorldbookPlugin, createMemoryHost,
  resolveChapter, STORY_CHAPTER,
  Schema, Hash, Keys, Compiler, Sidecar, LoreBind, PromptFilter, AutoToggle, AutoSwitch, Llm, Plot, TavernApi
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_COPY_WORLDBOOK_FACTORY__ = api;
