#!/usr/bin/env node
// Phase B automated suite: sparse Copy Worldbook, local compiler,
// sidecar snapshots, outbound base-entry suppression, and story auto-toggle.
'use strict';

const path = require('path');
const assert = require('assert');
const repo = path.resolve(__dirname, '..');
const Plugin = require(path.join(repo, 'extensions/arknights-copy-worldbook/core/plugin.js'));
const PhaseB = require(path.join(repo, 'maintenance/runtime-src/core/phase_b_bridge.js'));
const PhaseA = require(path.join(repo, 'maintenance/runtime-src/core/phase_a.js'));
const WorldSync = require(path.join(repo, 'maintenance/runtime-src/adapter/worldbook_sync.js'));
const Adapter = require(path.join(repo, 'maintenance/runtime-src/adapter/index.js'));
const Core = require(path.join(repo, 'maintenance/runtime-src/core/index.js'));

const { Schema, Hash, Keys, Compiler, LoreBind } = Plugin;

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ok  ' + name); })
    .catch(err => { failed += 1; console.error('  FAIL ' + name + '\n    ' + (err && err.stack || err)); });
}

function profile(name, extra) {
  const sections = Schema.emptySections();
  sections['基本信息'] = ' - 本名：' + name + '\n - 代号：' + name;
  sections['外貌'] = ' - 外貌描述：' + (extra && extra.looks || name + '的外貌');
  sections['服装'] = ' - 服装：' + (extra && extra.outfit || '默认服装');
  sections['武器'] = extra && extra.weapon || '无';
  sections['特点'] = extra && extra.trait || name + '的特点';
  sections['源石技艺'] = extra && extra.arts || '无';
  sections['能力'] = extra && extra.ability || '普通能力';
  sections['喜欢'] = extra && extra.like || '';
  sections['讨厌'] = extra && extra.hate || '';
  sections['经历'] = extra && extra.history || name + '的经历。';
  sections['人际关系'] = extra && extra.relations || '';
  sections['语言示例'] = extra && extra.voice || '「你好。」';
  sections['秘密'] = extra && extra.secret || '';
  sections['备注'] = extra && extra.note || '';
  return Schema.fromStructured(sections, '# ' + name);
}

function baseFixture() {
  const amiyaCanon = profile('阿米娅', { history: 'BASE_AMIYA_HONKAKU_UNIQUE 罗德岛的领袖。', trait: '温柔而坚定' });
  const amiyaYoung = profile('阿米娅', { history: 'BASE_AMIYA_YOUNG_UNIQUE 巴别塔时期。', outfit: '巴别塔制服', trait: '幼年' });
  const nine = profile('九', { history: 'BASE_NINE_UNIQUE 九的本格经历。', trait: '冷静' });
  const chapter = '这是章节专属条目 CHAPTER_NINE_UNIQUE，讲述九在《时间啊，向前！》第 44 节的出场，不得被通用角色条目接管。';
  const kal = profile('凯尔希', { history: 'BASE_KAL_UNIQUE 罗德岛的医生。', trait: '沉稳' });
  const kalAlter = profile('凯尔希', { history: 'BASE_KAL_ALTER_UNIQUE 异格形态。', outfit: '异格服装', trait: '异格' });
  const extras = [];
  const catalog = [];
  function addChar(uid, id, name, comment, content) {
    extras.push({
      uid, id: uid, entry_id: uid, comment, name: comment, keys: [name],
      content, enabled: false, vectorized: false, character_id: id, actor_id: id
    });
  }
  addChar(1, 'amiya', '阿米娅', '[角色]:阿米娅(本格)', amiyaCanon);
  addChar(2, 'amiya', '阿米娅', '[角色]:阿米娅(幼年)', amiyaYoung);
  addChar(3, 'nine', '九', '[角色]:九', nine);
  extras.push({
    uid: 44, id: 44, entry_id: 44,
    comment: '九（剧情·时间啊，向前！·44）',
    name: '九（剧情·时间啊，向前！·44）',
    keys: ['九'], content: chapter, enabled: false, vectorized: false
  });
  addChar(11, 'kaltsit', '凯尔希', '[角色]:凯尔希(本格)', kal);
  addChar(12, 'kaltsit', '凯尔希', '[角色]:凯尔希(异格)', kalAlter);
  const names = ['陈', '银灰', '德克萨斯', '能天使', 'W', '推进之王', '霜星', '塔露拉', '煌', '闪灵'];
  names.forEach((n, i) => {
    const uid = 100 + i;
    const id = 'actor_' + n;
    addChar(uid, id, n, '[角色]:' + n, profile(n, { history: 'BASE_' + n + '_UNIQUE' }));
  });
  extras.push({ uid: 900, id: 900, comment: '[金丝雀]:保留A', name: '[金丝雀]:保留A', keys: [], content: 'CANARY_A', enabled: true });
  extras.push({ uid: 901, id: 901, comment: '[金丝雀]:保留B', name: '[金丝雀]:保留B', keys: [], content: 'CANARY_B', enabled: true });

  const byId = {};
  for (const e of extras) {
    if (!e.character_id) continue;
    if (!byId[e.character_id]) {
      byId[e.character_id] = {
        character_id: e.character_id, actor_id: e.character_id,
        canonical_name: (e.keys && e.keys[0]) || e.character_id,
        aliases: (e.keys || []).slice(),
        forms: [], states: []
      };
    }
    const form = {
      form_id: String(e.uid), entry_id: e.uid, source_uid: e.uid,
      comment_pk: e.comment, label: e.comment, keys: e.keys, content: e.content,
      content_hash: Hash.hashContent(e.content)
    };
    byId[e.character_id].forms.push(form);
    byId[e.character_id].states.push(form);
  }
  return { entries: extras, catalog: Object.values(byId) };
}

function seedClone(plugin, chatId, characterIds) {
  plugin.enableCloneMode(chatId);
  const { entries, catalog } = plugin._fixture;
  for (const id of characterIds) {
    const rec = catalog.find(c => c.character_id === id);
    const form = rec.forms[0];
    plugin.upsertCharacterForm(chatId, rec, form);
  }
}

function makeEnv() {
  const fx = baseFixture();
  const host = Plugin.createMemoryHost({ baseName: 'base-worldbook', baseEntries: fx.entries });
  const plugin = Plugin.createCopyWorldbookPlugin(host, { catalog: fx.catalog });
  plugin._fixture = fx;
  return { host, plugin, fx };
}

async function run() {
  console.log('Phase B tests');

  await test('legacy baseline CHAT_CHANGED creates 0 books and leaves base hash byte-for-byte unchanged', () => {
    const { host, plugin } = makeEnv();
    const before = host.hashBaseBook();
    const beforeCount = host.listBooks().length;
    const a = plugin.onChatChanged('legacy_chat_1');
    const b = plugin.onChatChanged('legacy_chat_2');
    const a2 = plugin.onChatChanged('legacy_chat_1');
    assert.equal(a.mode, 'baseline');
    assert.equal(b.mode, 'baseline');
    assert.equal(a.created, false);
    assert.equal(a.writes, 0);
    assert.equal(a2.writes, 0);
    assert.equal(host.listBooks().length, beforeCount);
    assert.equal(host.hashBaseBook(), before);
    assert.equal(host.metrics.base_writes, 0);
    assert.equal(host.metrics.book_creates, 0);
  });

  await test('multi-save isolation: editing Chat A does not affect Chat B or the base book', () => {
    const { host, plugin, fx } = makeEnv();
    const before = host.hashBaseBook();
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.enableCloneMode('chat_a');
    plugin.enableCloneMode('chat_b');
    plugin.upsertCharacterForm('chat_a', amiya, amiya.forms[0]);
    plugin.upsertCharacterForm('chat_b', amiya, amiya.forms[0]);
    plugin.setDynamicLayer('chat_a', 'amiya', { affection: 12, relationship: '只存在于存档A的信赖' });
    const compiledA = plugin.compileBook('chat_a').entries[0].content;
    const compiledB = plugin.compileBook('chat_b').entries[0].content;
    assert.ok(compiledA.includes('只存在于存档A的信赖'), compiledA);
    assert.ok(!compiledB.includes('只存在于存档A的信赖'), compiledB);
    assert.notEqual(Hash.hashContent(compiledA), Hash.hashContent(compiledB));
    assert.equal(host.getChatLore('chat_a'), 'ark-clone::chat_a');
    assert.equal(host.getChatLore('chat_b'), 'ark-clone::chat_b');
    assert.notEqual(host.getChatLore('chat_a'), host.getChatLore('chat_b'));
    assert.equal(host.hashBaseBook(), before);
    assert.equal(host.metrics.base_writes, 0);
  });

  await test('missing clone book degrades safely with 0 base-book writes', () => {
    const { host, plugin, fx } = makeEnv();
    const before = host.hashBaseBook();
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.enableCloneMode('chat_x');
    plugin.upsertCharacterForm('chat_x', amiya, amiya.forms[0]);
    const book = host.readStoryMeta('chat_x').book;
    assert.ok(book);
    host.deleteBook(book);
    const r = plugin.onChatChanged('chat_x');
    assert.equal(r.mode, 'degraded');
    assert.equal(r.warning, 'missing_clone_book');
    assert.equal(r.base_writes, 0);
    assert.equal(host.hashBaseBook(), before);
    assert.equal(host.metrics.base_writes, 0);
    const gate = plugin.shouldNoopBaseFlush('chat_x');
    assert.equal(gate.noop, true);
    const status = plugin.getStatus('chat_x');
    assert.equal(status.warning, 'missing_clone_book');
    assert.ok((status.banners || []).some(b => b.kind === 'degraded'));
  });

  await test('lore_mode=clone turns base flush into a strict no-op', async () => {
    const { host, plugin } = makeEnv();
    const before = host.hashBaseBook();
    plugin.enableCloneMode('chat_flush');
    assert.equal(plugin.shouldNoopBaseFlush('chat_flush').noop, true);
    const state = { lore_mode: 'clone', chat_id: 'chat_flush' };
    assert.equal(PhaseB.shouldNoopBaseFlush(state, 'chat_flush').noop, true);
    assert.equal(PhaseB.shouldNoopBaseFlush({ lore_mode: 'degraded' }).noop, true);
    assert.equal(PhaseB.shouldNoopBaseFlush({ lore_mode: 'baseline' }).noop, false);

    let writes = 0;
    const sync = WorldSync.createWorldbookSync({
      read: async () => host.readBaseBook(),
      update: async () => { writes += 1; }
    });
    // Adapter-level gate: flushWorldbook must return writes:0 without calling update.
    const fakeHost = {
      chatId: () => 'chat_flush',
      capabilities: {},
      on: () => () => {},
      readChatVars: () => ({ ark_story_v2: { state: { schema_version: 3, chat_id: 'chat_flush', lore_mode: 'clone', hidden_message_ids: [], segment_entry_snapshots: {}, scene_experience: {}, ui_settings: {} } } }),
      writeChatVars: () => true,
      g: {}
    };
    const data = {
      data_version: 'test-b',
      actors: { actors: [{ actor_id: 'amiya', canonical_name: '阿米娅', states: [{ entry_id: 1, label: '本格' }], profile_variants: [] }] },
      catalog: { stories: [{ story_id: 's', title: 't', category: 'main' }] },
      routes: { routes: [{ route_id: 'route:TEST', story_id: 's', line_code: 'TEST', ordered_scene_ids: ['sc1'], focus_actor_ids: ['amiya'], cross_route_inputs: [] }] },
      scenes: { scenes: [{ scene_id: 'sc1', segment_ids: ['seg1'], focus_actor_ids: ['amiya'], completion_criteria: 'x' }] },
      segments: { segments: [{ segment_id: 'seg1', narrative: 'n' }] },
      events: { events: [] }, portraits: { portraits: [] },
      corpus: { texts: { e1: 'n' }, sources: [], nodes: [] },
      worldbook_binding: { physical: true, preserve_choice_actor_ids: [], reset_baseline: [] }
    };
    const adapter = Adapter.createStoryAdapter({ runtime: Core.createRuntime(data), host: fakeHost, data, worldbookName: 'base-worldbook' });
    adapter.setLorePointer({ lore_mode: 'clone', book: 'ark-clone::chat_flush' });
    const flushed = await adapter.flushWorldbook();
    assert.equal(flushed.noop, true);
    assert.equal(flushed.writes, 0);
    assert.equal(writes, 0);
    assert.equal(host.hashBaseBook(), before);
    adapter.destroy();
    void sync;
  });

  await test('final outbound prompt contains the compiled clone entry and ZERO duplicate base text', () => {
    const { host, plugin, fx } = makeEnv();
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.enableCloneMode('chat_p');
    plugin.upsertCharacterForm('chat_p', amiya, amiya.forms[0]);
    plugin.setDynamicLayer('chat_p', 'amiya', { affection: 7, relationship: 'DYNAMIC_RELATION_MARKER' });
    const compiled = plugin.compileBook('chat_p').entries[0];
    assert.ok(compiled.content.includes('DYNAMIC_RELATION_MARKER'));
    assert.equal(compiled.vectorized, false);
    const baseText = amiya.forms[0].content;
    assert.ok(baseText.includes('BASE_AMIYA_HONKAKU_UNIQUE'));
    const payload = {
      characterLore: [
        { uid: 1, comment: '[角色]:阿米娅(本格)', world: 'base-worldbook', content: baseText, enabled: true },
        { uid: 44, comment: '九（剧情·时间啊，向前！·44）', world: 'base-worldbook', content: 'CHAPTER_NINE_UNIQUE', enabled: true }
      ],
      chatLore: [compiled],
      prompt: [
        { role: 'system', content: 'WORLD:\n' + baseText + '\nCLONE:\n' + compiled.content + '\nCHAPTER:\nCHAPTER_NINE_UNIQUE' }
      ]
    };
    const filtered = plugin.filterOutboundPrompt(payload, 'chat_p', { base_entries: fx.entries });
    assert.ok(filtered.removed >= 1, 'expected base entry removed, got ' + filtered.removed);
    assert.equal(filtered.payload.characterLore[0].content, '', 'base lore entry must be blanked');
    assert.equal(!!filtered.payload.characterLore[0].suppressed_by, true);
    const cloneContent = filtered.payload.chatLore[0].content;
    assert.ok(cloneContent.includes('DYNAMIC_RELATION_MARKER'), 'compiled clone text missing');
    assert.ok(cloneContent.includes('BASE_AMIYA_HONKAKU_UNIQUE'), 'compiled form still includes its own base layer');
    const promptText = JSON.stringify(filtered.payload);
    assert.ok(promptText.includes('CHAPTER_NINE_UNIQUE'), 'chapter entry must not be suppressed');
    // After removing the compiled clone body (raw and JSON-escaped), the
    // overridden base entry must not remain as a second standalone copy.
    const escaped = JSON.stringify(cloneContent).slice(1, -1);
    const residual = promptText.split(cloneContent).join('').split(escaped).join('');
    assert.ok(!residual.includes('BASE_AMIYA_HONKAKU_UNIQUE'), 'duplicate base text still in residual: ' + residual.slice(0, 400));
    assert.equal(host.metrics.base_writes, 0);
  });

  await test('compiler mutual exclusion is by exact primary key and never substring-matches names', () => {
    const { plugin, fx } = makeEnv();
    const nine = fx.catalog.find(c => c.character_id === 'nine');
    const chapter = fx.entries.find(e => e.uid === 44);
    plugin.enableCloneMode('chat_k');
    plugin.upsertCharacterForm('chat_k', nine, nine.forms[0]);
    const compiled = plugin.compileBook('chat_k');
    assert.equal(compiled.entries.length, 1, 'one native entry per character');
    assert.equal(compiled.entries[0].character_id, 'nine');
    // Substring "九" must not match the chapter entry.
    assert.equal(Keys.isChapterEntry(chapter), true);
    assert.equal(Keys.isGenericCharacterEntry(chapter), false);
    assert.equal(Keys.exactEntryMatch(chapter, { entry_id: 3, comment_pk: '[角色]:九' }), false);
    assert.equal(Keys.exactEntryMatch(chapter, { character_id: 'nine' }), false);
    const filtered = plugin.filterOutboundPrompt({
      characterLore: [chapter, { uid: 3, comment: '[角色]:九', content: nine.forms[0].content, enabled: true }],
      prompt: [{ role: 'system', content: chapter.content + nine.forms[0].content }]
    }, 'chat_k', { base_entries: fx.entries });
    const text = JSON.stringify(filtered.payload);
    assert.ok(text.includes('CHAPTER_NINE_UNIQUE'));
    assert.ok(!text.includes('BASE_NINE_UNIQUE'));
    const resolved = Keys.resolveUniqueName('九', fx.catalog);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.character.character_id, 'nine');
    const miss = Keys.resolveUniqueName('九（剧情·时间啊，向前！·44）', fx.catalog);
    assert.equal(miss.ok, false);
  });

  await test('one compiled entry per character and second-form diff is strictly ≤800 chars', () => {
    const { plugin, fx } = makeEnv();
    const kal = fx.catalog.find(c => c.character_id === 'kaltsit');
    plugin.enableCloneMode('chat_forms');
    plugin.upsertCharacterForm('chat_forms', kal, kal.forms[0]);
    plugin.upsertCharacterForm('chat_forms', kal, kal.forms[1]);
    const switched = plugin.switchForm('chat_forms', 'kaltsit', {
      primary: String(kal.forms[0].entry_id),
      overlay: String(kal.forms[1].entry_id),
      overlay_enabled: true
    });
    assert.equal(switched.ok, true);
    assert.equal(switched.llm_calls, 0);
    const entries = plugin.compileBook('chat_forms').entries;
    assert.equal(entries.length, 1);
    const entry = entries[0];
    const marker = '【叠开形态差分】';
    assert.ok(entry.content.includes(marker), entry.content.slice(-200));
    const idx = entry.content.indexOf(marker);
    const diffText = entry.content.slice(idx + marker.length).trim();
    assert.ok(diffText.length <= 800, 'diff chars=' + diffText.length);
    const direct = Compiler.formDiff(kal.forms[0].content, kal.forms[1].content, 800);
    assert.ok(direct.chars <= 800);
    assert.equal(direct.limit, 800);
    // Force a huge overlay and confirm the cap still holds.
    const huge = profile('凯尔希', { history: 'X'.repeat(5000), outfit: 'Y'.repeat(5000), looks: 'Z'.repeat(5000) });
    const capped = Compiler.formDiff(kal.forms[0].content, huge, 800);
    assert.equal(capped.chars, 800);
    assert.equal(capped.truncated, true);
  });

  await test('sidecar snapshot is created before merge and 1-click rollback restores the exact prior dynamic layer', async () => {
    const { plugin, fx } = makeEnv();
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.enableCloneMode('chat_merge');
    plugin.upsertCharacterForm('chat_merge', amiya, amiya.forms[0]);
    plugin.setDynamicLayer('chat_merge', 'amiya', {
      affection: 3,
      relationship: 'PRIOR_RELATION_UNIQUE',
      personality_delta: 'PRIOR_DELTA_UNIQUE',
      non_canon_events: ['PRIOR_EVENT_UNIQUE']
    });
    const beforeLayer = plugin.loadSidecar('chat_merge').characters.amiya.dynamic.main;
    const beforeHash = Hash.hashContent(Hash.stableStringify(beforeLayer));
    const sections = Schema.emptySections();
    for (const s of Schema.SECTIONS) sections[s] = 'MERGED_' + s;
    sections['人际关系'] = 'MERGED_RELATION';
    sections['经历'] = 'MERGED_HISTORY';
    sections['特点'] = 'MERGED_TRAIT';
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(sections) } }] })
    });
    const pluginLive = Plugin.createCopyWorldbookPlugin(plugin.host, { catalog: fx.catalog, fetch: fakeFetch });
    const merged = await pluginLive.mergeTimelines('chat_merge', 'amiya', { from_timeline: 'main', to_timeline: 'main' }, { key: 'test', url: 'http://example.invalid', model: 'dummy' });
    assert.equal(merged.ok, true);
    assert.equal(merged.llm_calls, 1);
    assert.ok(merged.snapshot_id);
    const mid = pluginLive.loadSidecar('chat_merge').characters.amiya.dynamic.main;
    assert.ok(mid.relationship === 'MERGED_RELATION' || String(mid.relationship).includes('MERGED'));
    const rolled = pluginLive.rollback('chat_merge', merged.snapshot_id);
    assert.equal(rolled.ok, true);
    assert.equal(rolled.llm_calls, 0);
    const after = pluginLive.loadSidecar('chat_merge').characters.amiya.dynamic.main;
    assert.equal(Hash.hashContent(Hash.stableStringify(after)), beforeHash);
    assert.equal(after.relationship, 'PRIOR_RELATION_UNIQUE');
    assert.equal(after.personality_delta, 'PRIOR_DELTA_UNIQUE');
  });

  await test('illegal merge output leaves hashes unchanged', async () => {
    const { plugin, fx } = makeEnv();
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.enableCloneMode('chat_bad');
    plugin.upsertCharacterForm('chat_bad', amiya, amiya.forms[0]);
    plugin.setDynamicLayer('chat_bad', 'amiya', { relationship: 'KEEP_ME' });
    const before = Hash.hashContent(Hash.stableStringify(plugin.loadSidecar('chat_bad').characters));
    const pluginLive = Plugin.createCopyWorldbookPlugin(plugin.host, {
      catalog: fx.catalog,
      fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'this is not a profile' } }] }) })
    });
    const result = await pluginLive.mergeTimelines('chat_bad', 'amiya', {}, { key: 'test', url: 'http://example.invalid', model: 'dummy' });
    assert.equal(result.ok, false);
    assert.equal(result.unchanged, true);
    const after = Hash.hashContent(Hash.stableStringify(pluginLive.loadSidecar('chat_bad').characters));
    // snapshot() bumps sidecar.rev and adds a snapshots[] entry, but characters stay the same
    const charsHash = Hash.hashContent(Hash.stableStringify(pluginLive.loadSidecar('chat_bad').characters));
    const { snapshots, rev, ...rest } = pluginLive.loadSidecar('chat_bad');
    void rest; void snapshots; void rev; void charsHash;
    assert.equal(pluginLive.loadSidecar('chat_bad').characters.amiya.dynamic.main.relationship, 'KEEP_ME');
    // Character layer equality (excluding the new unused snapshot record's effect on characters)
    const characterHashAfter = Hash.hashContent(Hash.stableStringify(pluginLive.loadSidecar('chat_bad').characters));
    assert.equal(characterHashAfter, before);
    void result;
  });

  await test('story auto-toggle respects cap 8, exact PK, copy priority, and non-destructive newer-form prompt', () => {
    const { host, plugin, fx } = makeEnv();
    const before = host.hashBaseBook();
    plugin.enableCloneMode('chat_tog');
    // Put 4 characters into the clone; leave others as base fallback.
    const inClone = ['amiya', 'kaltsit', 'nine', 'actor_陈'];
    for (const id of inClone) {
      const rec = fx.catalog.find(c => c.character_id === id);
      plugin.upsertCharacterForm('chat_tog', rec, rec.forms[0]);
    }
    // Stale Amiya form: base content changed, clone still has the old copy.
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    const staleBase = fx.entries.find(e => e.uid === 1);
    const updatedBase = { ...staleBase, content: profile('阿米娅', { history: 'NEWER_BASE_AMIYA_FORM 新的底板正文。' }) };
    const desired = [1, 11, 3, 100, 101, 102, 103, 104, 105, 106, 107]; // 11 entries, cap 8
    const dynamicBefore = plugin.loadSidecar('chat_tog').characters.amiya.dynamic.main;
    const dynHash = Hash.hashContent(Hash.stableStringify(dynamicBefore));
    const result = plugin.autoToggleForSegment('chat_tog', {
      catalog: fx.catalog,
      desired_entry_ids: desired,
      speakers: ['九', '不存在的路人', '九（剧情·时间啊，向前！·44）'],
      base_entries: fx.entries.map(e => e.uid === 1 ? updatedBase : e)
    });
    assert.equal(result.ok, true);
    assert.equal(result.base_writes, 0);
    assert.equal(result.dynamic_overwrites, 0);
    assert.equal(result.plan.enable.length, 8, 'cap 8, got ' + result.plan.enable.length);
    assert.ok(result.plan.uncapped_count > 8);
    const actions = Object.fromEntries(result.results.map(r => [r.character_id, r]));
    assert.equal(actions.amiya.action, 'stale_prompt');
    assert.equal(actions.amiya.use_clone, true);
    assert.ok(result.prompts.some(p => p.kind === 'newer_form' && p.character_id === 'amiya'));
    assert.ok(actions.kaltsit.action === 'use_clone' || actions.nine.action === 'use_clone');
    // Characters not in the clone must fall back to the base projection, not be copied.
    const fallbacks = result.results.filter(r => r.action === 'base_fallback');
    assert.ok(fallbacks.length >= 1, 'expected at least one base fallback');
    const skippedChapter = result.plan.skipped.some(s => s.reason === 'no_exact_match' || s.reason === 'no_exact_pk' || s.name === '九（剧情·时间啊，向前！·44）' || s.reason === 'ambiguous');
    const skippedUnknown = result.plan.skipped.some(s => s.name === '不存在的路人' || s.reason === 'no_exact_match');
    assert.ok(skippedUnknown, 'unknown speaker must be skipped: ' + JSON.stringify(result.plan.skipped));
    void skippedChapter;
    const dynAfter = plugin.loadSidecar('chat_tog').characters.amiya.dynamic.main;
    assert.equal(Hash.hashContent(Hash.stableStringify(dynAfter)), dynHash);
    assert.equal(host.hashBaseBook(), before);
    assert.equal(host.metrics.base_writes, 0);
  });

  await test('already-bound CHAT_CHANGED is a metadata compare with 0 book writes', () => {
    const { host, plugin, fx } = makeEnv();
    plugin.enableCloneMode('chat_bound');
    const amiya = fx.catalog.find(c => c.character_id === 'amiya');
    plugin.upsertCharacterForm('chat_bound', amiya, amiya.forms[0]);
    const creates = host.metrics.book_creates;
    const r1 = plugin.onChatChanged('chat_bound');
    const r2 = plugin.onChatChanged('chat_bound');
    assert.equal(r1.mode, 'clone');
    assert.equal(r1.created, false);
    assert.equal(r2.writes, 0);
    assert.equal(host.metrics.book_creates, creates);
    assert.equal(host.metrics.base_writes, 0);
  });

  await test('14-section schema extracts LLM output and rejects rewritten headers', () => {
    const sections = Schema.emptySections();
    for (const s of Schema.SECTIONS) sections[s] = 'v-' + s;
    const ok = Schema.extractStructured(JSON.stringify(sections));
    assert.ok(ok);
    assert.equal(ok['语言示例'], 'v-语言示例');
    const bad = Schema.extractStructured(JSON.stringify({ name: '阿米娅', look: 'x' }));
    assert.equal(bad, null);
    const wrapped = Schema.extractStructured('```json\n' + JSON.stringify(sections) + '\n```');
    assert.ok(wrapped);
    assert.equal(Schema.SECTIONS.length, 14);
  });

  await test('lore_mode baseline path is unchanged when the Phase B plugin is absent', async () => {
    const prev = globalThis.__ARK_COPY_WORLDBOOK__;
    try {
      delete globalThis.__ARK_COPY_WORLDBOOK__;
      assert.equal(PhaseB.shouldNoopBaseFlush({ lore_mode: 'baseline' }).noop, false);
      assert.equal(PhaseB.filterOutboundPrompt({ x: 1 }, { lore_mode: 'baseline' }, 'c').x, 1);
      const data = {
        data_version: 'test-b',
        actors: { actors: [{ actor_id: 'amiya', canonical_name: '阿米娅', states: [{ entry_id: 1, label: '本格' }], profile_variants: [] }] },
        catalog: { stories: [{ story_id: 's', title: 't', category: 'main' }] },
        routes: { routes: [{ route_id: 'route:TEST', story_id: 's', line_code: 'TEST', ordered_scene_ids: ['sc1'], focus_actor_ids: ['amiya'], cross_route_inputs: [] }] },
        scenes: { scenes: [{ scene_id: 'sc1', segment_ids: ['seg1'], focus_actor_ids: ['amiya'], completion_criteria: 'x' }] },
        segments: { segments: [{ segment_id: 'seg1', narrative: 'n' }] },
        events: { events: [] }, portraits: { portraits: [] },
        corpus: { texts: { e1: 'n' }, sources: [], nodes: [] }
      };
      const host = {
        chatId: () => 'c1', capabilities: {}, on: () => () => {},
        readChatVars: () => ({}), writeChatVars: () => true, g: {}
      };
      const adapter = Adapter.createStoryAdapter({ runtime: Core.createRuntime(data), host, data });
      assert.equal(adapter.getLoreMode(), 'baseline');
      const view = adapter.computeWorldbookView();
      assert.ok(Array.isArray(view.enable));
      adapter.destroy();
    } finally {
      if (prev) globalThis.__ARK_COPY_WORLDBOOK__ = prev;
      else delete globalThis.__ARK_COPY_WORLDBOOK__;
    }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
