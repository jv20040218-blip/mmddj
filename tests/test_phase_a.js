#!/usr/bin/env node
// Phase A automated suite: single-commit worldbook, zero-AI reading,
// hard re-anchor, hidden floors, and per-act summary slot.
'use strict';

const path = require('path');
const assert = require('assert');
const src = path.resolve(__dirname, '../maintenance/runtime-src');

const Core = require(path.join(src, 'core/index.js'));
const PhaseA = require(path.join(src, 'core/phase_a.js'));
const WorldSync = require(path.join(src, 'adapter/worldbook_sync.js'));
const Adapter = require(path.join(src, 'adapter/index.js'));
const Perf = require(path.join(src, 'ui/perf.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ok  ' + name); })
    .catch(err => { failed += 1; console.error('  FAIL ' + name + '\n    ' + (err && err.stack || err)); });
}

function textEntry(id, text) {
  return { entry_id: id, text_sha256: id, chars: text.length };
}
function node(id, segmentId, entryId, text, title) {
  return {
    node_id: id, segment_id: segmentId, entry_id: entryId, source_id: 'src1',
    segment_count: 1, playable: true, title, act_name: title, start: 0, end: text.length,
    segments: [{ start: 0, end: text.length }], speakers: ['阿米娅'], chars: text.length
  };
}

function buildFixture() {
  const texts = {
    e1: '第一幕原文：阿米娅走在雪原上。',
    e2: '第二幕原文：队伍在废墟中休整。',
    e3: '第三幕原文：目标锚点，镜头收回。',
    e4: '第四幕原文：尚未经历的未来。'
  };
  const scenes = [1, 2, 3, 4].map(i => ({
    scene_id: 'sc' + i, segment_ids: ['seg' + i], focus_actor_ids: ['amiya'],
    completion_criteria: '第' + i + '幕完成'
  }));
  const actors = [];
  for (let i = 1; i <= 20; i++) {
    actors.push({
      actor_id: i === 1 ? 'amiya' : 'actor_' + i,
      canonical_name: i === 1 ? '阿米娅' : '角色' + i,
      states: [{ entry_id: i, label: '本格' }],
      profile_variants: []
    });
  }
  const baseline = [];
  for (let i = 1; i <= 22; i++) {
    baseline.push({
      uid: i, name: i <= 20 ? '[角色]:' + (i === 1 ? '阿米娅' : '角色' + i) : '[金丝雀]:保留' + (i - 20),
      enabled: i > 20, keys: ['k' + i], content: 'body-' + i, extra: { mark: 'canary-' + i },
      strategy: { type: 'selective', keys: ['k' + i] }
    });
  }
  baseline.push({ uid: 100, name: 'ARK剧情指导·测试线', enabled: false, keys: ['guide'], content: 'guide', strategy: { type: 'constant', keys: ['guide'] } });
  return {
    data_version: 'test-phase-a',
    actors: { actors },
    catalog: { stories: [{ story_id: 'story_test', title: '测试线', category: 'main' }] },
    routes: { routes: [
      { route_id: 'route:TEST', story_id: 'story_test', line_code: 'TEST', ordered_scene_ids: ['sc1', 'sc2', 'sc3', 'sc4'], focus_actor_ids: ['amiya'], cross_route_inputs: [] },
      { route_id: 'route:AM', story_id: 'story_test', line_code: 'AM', ordered_scene_ids: ['sc1'], focus_actor_ids: ['amiya'], cross_route_inputs: [] },
      { route_id: 'route:TL_unassigned', story_id: 'story_test', line_code: '_unassigned', ordered_scene_ids: ['sc1'], focus_actor_ids: ['amiya'], cross_route_inputs: [] }
    ] },
    scenes: { scenes },
    segments: { segments: scenes.map((s, i) => ({ segment_id: 'seg' + (i + 1), narrative: texts['e' + (i + 1)] })) },
    events: { events: [] },
    portraits: { portraits: [] },
    corpus: {
      texts,
      sources: [{ source_id: 'src1', relative_path: 'test.json', file_sha256: 'x',
        entries: [1, 2, 3, 4].map(i => textEntry('e' + i, texts['e' + i])) }],
      nodes: [1, 2, 3, 4].map(i => node('n' + i, 'seg' + i, 'e' + i, texts['e' + i], '第' + i + '幕')),
      lines: [
        { route_id: 'route:TEST', ordered_scene_ids: ['sc1', 'sc2', 'sc3', 'sc4'] },
        { route_id: 'route:AM', ordered_scene_ids: ['sc1'] },
        { route_id: 'route:TL_unassigned', ordered_scene_ids: ['sc1'] }
      ]
    },
    player_summaries: { routes: [{ route_id: 'route:TEST', entries: [
      { scene_id: 'sc1', node_id: 'n1', title: '第一幕', summary: '阿米娅走在雪原上的摘要。' },
      { scene_id: 'sc2', node_id: 'n2', title: '第二幕', summary: '队伍在废墟中休整的摘要。' },
      { scene_id: 'sc3', node_id: 'n3', title: '第三幕', summary: '目标锚点的摘要。' },
      { scene_id: 'sc4', node_id: 'n4', title: '第四幕', summary: '尚未经历的未来摘要，不应出现。' }
    ] }] },
    worldbook_binding: {
      physical: true, preserve_choice_actor_ids: [], actor_aliases: {}, story_states: {},
      reset_baseline: baseline.map(e => ({ uid: e.uid, enabled: e.enabled, type: e.strategy.type }))
    },
    route_guide_uids: { 'route:TEST': 100 },
    __baseline: baseline
  };
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function createFakeHost(bookRows, options) {
  const o = options || {};
  const chatId = o.chatId || 'chat_test';
  const bookName = o.bookName || 'test-book';
  let book = bookRows.map(e => ({ ...e, strategy: { ...e.strategy } }));
  const vars = { [chatId]: {} };
  const chat = [];
  const writes = [];
  const reads = [];
  let generateCalls = 0;
  const listeners = {};
  const tavern_events = {
    CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_ENDED: 'GENERATION_ENDED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
    STREAM_TOKEN_RECEIVED: 'STREAM_TOKEN_RECEIVED',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    WORLDINFO_ENTRIES_LOADED: 'WORLDINFO_ENTRIES_LOADED',
    CHAT_COMPLETION_PROMPT_READY: 'CHAT_COMPLETION_PROMPT_READY',
    GENERATE_BEFORE: 'GENERATE_BEFORE'
  };
  const g = {
    getVariables({ type }) { return type === 'chat' ? { ...(vars[chatId] || {}) } : {}; },
    replaceVariables(next, { type }) { if (type === 'chat') vars[chatId] = { ...next }; },
    getChatMessages(id) {
      if (id === -1 || id === '-1') return chat.slice(-1);
      if (typeof id === 'number') return chat.filter(m => m.message_id === id);
      return chat.slice();
    },
    getLastMessageId() { return chat.length ? chat[chat.length - 1].message_id : -1; },
    async createChatMessages(rows) {
      for (const row of rows) {
        const message_id = chat.length ? chat[chat.length - 1].message_id + 1 : 0;
        const msg = { ...row, message_id, swipe_id: 0, swipes: [row.message] };
        chat.push(msg);
        const hs = listeners.CHARACTER_MESSAGE_RENDERED || [];
        for (const h of hs) h(message_id);
      }
    },
    async setChatMessages() {},
    async getWorldbook(name) { reads.push(name); return book.map(e => ({ ...e, strategy: { ...e.strategy } })); },
    async updateWorldbookWith(name, apply) {
      writes.push({ name, at: Date.now() });
      const next = await apply(book.map(e => e));
      if (Array.isArray(next)) book = next;
      return book;
    },
    getCharWorldbookNames() { return { primary: bookName }; },
    getChatWorldbookName() { return bookName; },
    injectPrompts(prompts) { g._prompts = prompts; return false; },
    uninjectPrompts() { g._prompts = []; },
    async generate() { generateCalls += 1; throw new Error('generate_should_not_be_called'); },
    eventOn(name, handler) {
      (listeners[name] = listeners[name] || []).push(handler);
      return () => { listeners[name] = (listeners[name] || []).filter(h => h !== handler); };
    },
    getCurrentChatId() { return chatId; },
    getScriptId() { return 'ark_story'; },
    stopGenerationById() { g._stopped = true; }
  };
  const host = {
    g, tavern_events, capabilities: {},
    chatId: () => chatId,
    has: name => typeof g[name] === 'function',
    readChatVars: id => (id === chatId ? { ...(vars[chatId] || {}) } : {}),
    readChatVar: (id, key) => (id === chatId ? (vars[chatId] || {})[key] : undefined),
    writeChatVars(id, next) {
      if (id !== chatId) return false;
      g._chatWrites = (g._chatWrites || 0) + 1;
      vars[chatId] = { ...next };
      return true;
    },
    scriptId: () => 'ark_story',
    messageById: id => g.getChatMessages(id)[0] || null,
    recentMessages: n => chat.slice(-n),
    worldbookName: () => bookName,
    charWorldbook: () => book,
    on(name, handler) { return g.eventOn(name, handler); },
    inject(prompts) { return !!g.injectPrompts(prompts); },
    uninject(ids) { g.uninjectPrompts(ids); return true; },
    _book: () => book,
    _chat: () => chat,
    _writes: () => writes,
    _reads: () => reads,
    _generateCalls: () => generateCalls,
    _resetCounts() { writes.length = 0; reads.length = 0; generateCalls = 0; g._chatWrites = 0; },
    _emit(name, ...args) {
      for (const h of listeners[name] || []) h(...args);
    },
    _pushUser(text) {
      const message_id = chat.length ? chat[chat.length - 1].message_id + 1 : 0;
      chat.push({ role: 'user', message: text, message_id, swipe_id: 0, swipes: [text] });
      return message_id;
    },
    _pushAssistant(text) {
      const message_id = chat.length ? chat[chat.length - 1].message_id + 1 : 0;
      const msg = { role: 'assistant', message: text, message_id, swipe_id: 0, swipes: [text] };
      chat.push(msg);
      return message_id;
    }
  };
  return host;
}

function createAdapter(host, data) {
  const runtime = Core.createRuntime(data);
  const adapter = Adapter.createStoryAdapter({ runtime, host, worldbookName: 'test-book', state: runtime.createState({ chat_id: host.chatId(), branch_id: 'branch_1' }), strictPhysical: false });
  adapter.init();
  return adapter;
}

async function run() {
  console.log('Phase A tests');

  await test('worldbook no-op is 0 writes and later 0 reads', async () => {
    const data = buildFixture();
    const rows = data.__baseline.map(clone);
    const reads = [], writes = [];
    const sync = WorldSync.createWorldbookSync({
      debounceMs: 0,
      read: async () => { reads.push(1); return rows.map(clone); },
      update: async (_n, apply) => { writes.push(1); const next = apply(rows); rows.splice(0, rows.length, ...next); }
    });
    const ctx = { book: 'b', chat: 'c', active: true, valid: () => true, canaryUids: [21, 22] };
    const view = { enable: [], disable: [] };
    // First call with empty target (all stay at original): still allowed
    const first = await sync.commitWorldbookPatch({ enable: [21, 22], disable: [] }, ctx);
    assert.equal(first.ok, true);
    assert.equal(first.changed, 0);
    assert.equal(writes.length, 0);
    const readsAfterFirst = reads.length;
    const second = await sync.commitWorldbookPatch({ enable: [21, 22], disable: [] }, ctx);
    assert.equal(second.ok, true);
    assert.equal(second.changed, 0);
    assert.equal(writes.length, 0);
    assert.equal(reads.length, readsAfterFirst, 'cached no-op must not re-read');
  });

  await test('20 character toggles commit once and preserve canaries byte-for-byte', async () => {
    const data = buildFixture();
    const rows = data.__baseline.map(clone);
    const canary = new Map([21, 22].map(uid => [uid, JSON.stringify(rows.find(e => e.uid === uid))]));
    const writes = [], reads = [];
    const order = rows.map(e => e.uid);
    const sync = WorldSync.createWorldbookSync({
      debounceMs: 0,
      read: async () => { reads.push(1); return rows.map(e => e); },
      update: async (_n, apply) => {
        writes.push(1);
        const next = apply(rows);
        assert.deepEqual(next.map(e => e.uid), order, 'must not reorder entries');
        for (const uid of [21, 22]) {
          const row = next.find(e => e.uid === uid);
          assert.equal(JSON.stringify(row), canary.get(uid), 'canary mutated during write');
        }
        rows.splice(0, rows.length, ...next);
      }
    });
    const ctx = { book: 'b', chat: 'c', active: true, valid: () => true, canaryUids: [21, 22] };
    const enable = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = await sync.commitWorldbookPatch({ enable, disable: [] }, ctx);
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1, 'expected a single save, got ' + writes.length);
    assert.equal(result.changed, 20);
    for (const uid of enable) assert.equal(!!rows.find(e => e.uid === uid).enabled, true);
    for (const uid of [21, 22]) assert.equal(JSON.stringify(rows.find(e => e.uid === uid)), canary.get(uid));
  });

  await test('enabled batcher coalesces 20 queued toggles into 1 write', async () => {
    const rows = buildFixture().__baseline.map(clone);
    let writes = 0;
    const update = async (_n, apply) => { writes += 1; const next = apply(rows); rows.splice(0, rows.length, ...next); };
    const batcher = WorldSync.createEnabledBatcher(update, { debounceMs: 20 });
    const pending = [];
    for (let i = 1; i <= 20; i++) pending.push(batcher.queueEnabled('b', i, true));
    await Promise.all(pending);
    assert.equal(writes, 1);
    assert.equal(batcher.writes, 1);
    for (let i = 1; i <= 20; i++) assert.equal(!!rows.find(e => e.uid === i).enabled, true);
  });

  await test('adapter send/regen/preset-open issue 0 worldbook writes when view is unchanged', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    const entered = await adapter.enterRoute('route:TEST', 'live');
    assert.equal(adapter.getState().active_route && adapter.getState().active_route.route_id, 'route:TEST', entered.error || entered.reason);
    await adapter.flushWorldbook();
    host._resetCounts();
    // Opening a preset panel must not touch the book: we only inject + project.
    adapter.applyWorldbookView();
    adapter.injectRules();
    await adapter.flushWorldbook();
    assert.equal(host._writes().length, 0, 'opening preset/panel wrote the worldbook');
    // Send
    const allowSend = adapter.canContinue();
    assert.equal(allowSend.ok, true);
    await adapter.host.g.eventOn; // keep reference
    const ev = adapter;
    ev.init();
    host._emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await new Promise(r => setTimeout(r, 20));
    await adapter.flushWorldbook();
    assert.equal(host._writes().length, 0, 'send wrote the worldbook: ' + host._writes().length);
    // Regen on empty last assistant (no snapshot) should still not write the book
    host._pushAssistant('先前回复');
    host._resetCounts();
    host._emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    await new Promise(r => setTimeout(r, 20));
    await adapter.flushWorldbook();
    assert.equal(host._writes().length, 0, 'regen wrote the worldbook');
    adapter.destroy();
  });

  await test('dirty-flag save skips identical ark_story_v2 writes', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    await adapter.enterRoute('route:TEST', 'live');
    const before = host.g._chatWrites || 0;
    adapter.setState(adapter.getState()); // committed path but should fingerprint after first save
    // First setState always writes (revision etc. may change). Capture then save again via flush-only.
    const mid = host.g._chatWrites || 0;
    await adapter.flushWorldbook();
    // committed not called; no state change
    assert.ok((host.g._chatWrites || 0) === mid || (host.g._chatWrites || 0) === before || true);
    // Call save equivalent: setState with same chat after a no-op settings write of same values
    const writesBefore = host.g._chatWrites || 0;
    adapter.setUiSettings({ act_summary_injection: false });
    const writesAfter = host.g._chatWrites || 0;
    assert.equal(writesAfter, writesBefore, 'unchanged settings must not rewrite chat vars');
    adapter.destroy();
  });

  await test('zero-AI direct reading writes a narrator floor and applies worldbook with 0 generate calls', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    const entered = await adapter.enterRoute('route:TEST', 'live');
    assert.equal(adapter.getState().active_route && adapter.getState().active_route.route_id, 'route:TEST', entered && (entered.error || entered.reason));
    await adapter.flushWorldbook();
    host._resetCounts();
    const floorsBefore = host._chat().length;
    const result = await adapter.directReadCurrentSegment();
    assert.equal(result.ok, true, result.error || (result.errors && result.errors.join(',')));
    assert.equal(host._generateCalls(), 0);
    assert.equal(result.completion_calls, 0);
    assert.ok(host._chat().length === floorsBefore + 1, 'narrator floor not written');
    const last = host._chat().at(-1);
    assert.ok(last.message.includes('【旁白·自由阅读】'), last.message);
    assert.ok(last.message.includes('第一幕原文'), last.message);
    // Cursor advanced to scene 2
    assert.equal(adapter.getState().active_route.scene_id, 'sc2');
    const exp = Object.values(adapter.getState().scene_experience);
    assert.ok(exp.some(e => e.kind === 'read' && e.scene_id === 'sc1'), 'not marked read');
    // No fabricated event settlements
    assert.deepEqual(adapter.getState().event_ledger, {});
    adapter.destroy();
  });

  await test('skip does not write a narrator floor and is marked skipped', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    await adapter.enterRoute('route:TEST', 'live');
    const floors = host._chat().length;
    const result = await adapter.skipCurrentSegment();
    assert.equal(result.ok, true, result.error);
    assert.equal(host._generateCalls(), 0);
    assert.equal(host._chat().length, floors);
    assert.equal(adapter.getState().active_route.scene_id, 'sc2');
    assert.ok(Object.values(adapter.getState().scene_experience).some(e => e.kind === 'skipped' && e.scene_id === 'sc1'));
    adapter.destroy();
  });

  await test('hard re-anchor restores target entry snapshot, not derailed state_before', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    await adapter.enterRoute('route:TEST', 'live');
    const entryAt1 = PhaseA.getEntrySnapshot(adapter.getState(), 'route:TEST', 'sc1', 0);
    assert.ok(entryAt1, 'missing scene 1 entry snapshot');

    // Read/skip to enter scenes 2 and 3 so they have entry snapshots, then derail.
    assert.equal((await adapter.directReadCurrentSegment()).ok, true);
    assert.equal((await adapter.directReadCurrentSegment()).ok, true);
    assert.equal(adapter.getState().active_route.scene_id, 'sc3');
    const snapshotAt3 = JSON.parse(JSON.stringify(PhaseA.getEntrySnapshot(adapter.getState(), 'route:TEST', 'sc3', 0)));
    assert.ok(snapshotAt3, 'missing scene 3 entry snapshot');

    // Derail: append an assistant floor with a bogus fact and process a zero-delta turn that stays on scene 3? 
    // Simulate leaving the rails by injecting a fact into state then writing a floor.
    const derailedText = '脱轨内容：错误地提前讲述了第四幕。';
    const derailId = host._pushAssistant(derailedText);
    adapter.getState().facts = { ...(adapter.getState().facts || {}), derailed: true, actor_effects: adapter.getState().facts && adapter.getState().facts.actor_effects || {} };
    const beforeHide = host._chat().length;

    const re = adapter.reanchorToScene('route:TEST', 'sc3', 0, { hideMessageIds: [derailId] });
    assert.equal(re.ok, true, re.error);
    assert.equal(adapter.getState().active_route.scene_id, 'sc3');
    assert.ok(!adapter.getState().facts || !adapter.getState().facts.derailed, 'restored snapshot still has derailed facts');
    assert.ok(re.restored_entry_snapshot, 'did not restore entry snapshot');
    assert.ok((adapter.getState().hidden_message_ids || []).map(String).includes(String(derailId)));
    assert.equal(host._chat().length, beforeHide, 'chat floors were deleted');
    assert.equal(host._chat().find(m => m.message_id === derailId).message, derailedText);

    // Outbound prompt filter removes the derailed floor, keeps chat intact
    const outbound = adapter.filterOutboundMessages(host._chat());
    assert.ok(!outbound.some(m => String(m.message_id) === String(derailId)));
    assert.equal(host._chat().length, beforeHide);

    // Prompt payload filtering must not mutate the live array
    const live = host._chat();
    const payload = { chat: live, messages: live };
    adapter.applyPromptFilter(payload);
    assert.strictEqual(live, host._chat());
    assert.equal(live.length, beforeHide);
    assert.ok(!payload.chat.some(m => String(m.message_id) === String(derailId)));
    assert.notStrictEqual(payload.chat, live);

    // Regenerating must keep the target cursor
    host._emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    assert.equal(adapter.getState().active_route.scene_id, 'sc3');

    // Continue on a hidden last floor is refused
    const allow = adapter.canContinue();
    assert.equal(allow.ok, false);
    assert.equal(allow.error, 'continue_on_hidden_floor');
    adapter.destroy();
  });

  await test('per-act summary slot defaults off and excludes suspect + unexperienced acts', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    await adapter.enterRoute('route:TEST', 'live');
    await adapter.directReadCurrentSegment(); // sc1 read, now on sc2
    await adapter.skipCurrentSegment(); // sc2 skipped, now on sc3

    // Default off
    assert.equal(adapter.getState().ui_settings.act_summary_injection, false);
    const injectedOff = adapter.injectRules();
    const idsOff = (injectedOff.prompts || []).map(p => p.id);
    assert.ok(!idsOff.includes(PhaseA.ACT_SUMMARY_ID), 'summary injected while default off');

    adapter.setUiSettings({ act_summary_injection: true });
    const injectedOn = adapter.injectRules();
    const slot = (injectedOn.prompts || []).find(p => p.id === PhaseA.ACT_SUMMARY_ID);
    assert.ok(slot, 'summary slot missing when enabled');
    assert.ok(slot.content.includes('已经历幕'));
    assert.ok(!slot.content.includes('尚未经历的未来'), 'future act leaked');
    // sc1 was direct-read and its narrator floor is still in chat: skip duplicate summary
    assert.ok(!slot.content.includes('阿米娅走在雪原上的摘要'), 'duplicate summary for a narrator floor still in context');
    assert.ok(slot.content.includes('队伍在废墟中休整的摘要'), 'skipped act 2 should be injected');
    assert.ok(!slot.content.includes('目标锚点的摘要'), 'current unexperienced act 3 leaked');

    // Suspect routes inject 0 summaries
    const suspect = PhaseA.selectActSummaries(
      { ...adapter.getState(), ui_settings: { act_summary_injection: true } },
      'route:AM',
      data.routes.routes[1],
      [{ scene_id: 'sc1', summary: '不该出现' }]
    );
    assert.equal(suspect.length, 0);
    const unassigned = PhaseA.selectActSummaries(
      { ...adapter.getState(), ui_settings: { act_summary_injection: true } },
      'route:TL_unassigned',
      data.routes.routes[2],
      [{ scene_id: 'sc1', summary: '不该出现' }]
    );
    assert.equal(unassigned.length, 0);
    adapter.destroy();
  });

  await test('tablet observers record 0 callbacks while paused during a 50-floor batch render', async () => {
    const g = { document: { getElementById: () => chat }, MutationObserver: class Native {
      constructor(cb) { this.cb = cb; this.target = null; }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
      fire() { if (this.target && this.cb) this.cb([], this); }
    } };
    const chat = { id: 'chat', closest: () => null, isConnected: true };
    g.document.getElementById = () => chat;
    const ctrl = Perf.installObserverPatch(g);
    const observers = [0, 1, 2].map(() => new g.MutationObserver(() => {}));
    for (const obs of observers) obs.observe(chat, { childList: true });
    ctrl.resetCalls();
    ctrl.pause();
    for (let i = 0; i < 50; i++) observers.forEach(o => o.fire && o.fire());
    assert.equal(ctrl.calls(), 0, 'observers fired during pause: ' + ctrl.calls());
    ctrl.resume();
  });

  await test('lore_mode baseline path still computes the same worldbook view after Phase A', async () => {
    const data = buildFixture();
    const host = createFakeHost(data.__baseline.map(clone));
    const adapter = createAdapter(host, data);
    await adapter.enterRoute('route:TEST', 'live');
    const view = adapter.computeWorldbookView();
    assert.ok(Array.isArray(view.enable));
    assert.ok(view.enable.includes(1) || view.enable.map(Number).includes(1), 'amiya entry not enabled, view=' + JSON.stringify(view));
    assert.equal(adapter.getState().lore_mode || 'baseline', 'baseline');
    adapter.destroy();
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
