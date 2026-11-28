#!/usr/bin/env node
// 按存档修订后续剧情：触发、brief 与未来摘要分离、回跳回滚、Chat Lore 排除、设计接口失败。
// 设计接口一律使用本地 stub，不访问网络，也不写入真实凭据。
'use strict';

const path = require('path');
const assert = require('assert');
const repo = path.resolve(__dirname, '..');
const src = path.join(repo, 'maintenance/runtime-src');

const Core = require(path.join(src, 'core/index.js'));
const Plot = require(path.join(src, 'core/plot_direction.js'));
const PhaseA = require(path.join(src, 'core/phase_a.js'));
const Adapter = require(path.join(src, 'adapter/index.js'));
const Rules = require(path.join(src, 'adapter/rules.js'));
const Plugin = require(path.join(repo, 'extensions/arknights-copy-worldbook/core/plugin.js'));

const { Schema } = Plugin;

const BAD = '被带走后的处境：塔露拉已经被掳走。';
const PHRASE = '塔露拉已经被掳走，并在之后加入整合运动。';
const SECOND = '下一幕再次被掳走以保住整合运动结局';
const FAILED = '此次掳走未遂';
const ON_SITE = '她经历了这次掳走未遂。';
const PRIOR = 'PRIOR_EVENT_UNIQUE';
const EARLY = '已经见面';
const STUB_API = { key: 'test-key', url: 'http://example.invalid', model: 'stub-model' };

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ok  ' + name); })
    .catch(err => { failed += 1; console.error('  FAIL ' + name + '\n    ' + (err && err.stack || err)); });
}

function profile(name, history) {
  const sections = Schema.emptySections();
  sections['基本信息'] = ' - 本名：' + name;
  sections['外貌'] = ' - 外貌描述：' + name;
  sections['服装'] = ' - 服装：默认';
  sections['武器'] = '无';
  sections['特点'] = name;
  sections['源石技艺'] = '无';
  sections['能力'] = '无';
  sections['喜欢'] = '';
  sections['讨厌'] = '';
  sections['经历'] = history;
  sections['人际关系'] = '';
  sections['语言示例'] = '「……」';
  sections['秘密'] = '';
  sections['备注'] = '';
  return Schema.fromStructured(sections, '# ' + name);
}

function bareState(routeId, sceneId) {
  const state = Core.state.createState({ chat_id: 'chat_plot', branch_id: 'branch_1' });
  state.revision = 4;
  state.active_route = { route_id: routeId, scene_id: sceneId, scene_time: null, context_mode: 'live', unknown_date_elapsed_minutes: 0 };
  return state;
}

function tallulahFact(extra) {
  return Object.assign({
    fact_id: 'tallulah_abduction_failed',
    text: FAILED,
    kind: 'premise',
    contradicts: ['已经被掳走', '被带走后', '被掳'],
    voids: ['abducted'],
    settled: true,
    character_id: 'tallulah'
  }, extra || {});
}

function tallulahSignal(state) {
  return {
    chat_id: state.chat_id,
    route_id: state.active_route.route_id,
    scene_id: state.active_route.scene_id,
    node_id: 'n2',
    message_kind: 'causal',
    facts: [tallulahFact()],
    summaries: [
      { node_id: 'n2', summary: '双方还在对峙。', timing: 'current' },
      { node_id: 'n3', summary: BAD, premise: 'abducted', timing: 'future', completion: '被掳之后加入整合运动' }
    ],
    entries: [
      { entry_id: 77, comment_pk: '[剧情]:塔露拉被掳后', content: PHRASE, premise: 'abducted', timing: 'future' },
      { entry_id: 8, comment_pk: '[角色]:塔露拉', character_id: 'tallulah', content: '被掳后她加入了整合运动。', premise: 'abducted', timing: 'future' }
    ],
    ordered_nodes: [
      { node_id: 'n1', scene_id: 'sc1' },
      { node_id: 'n2', scene_id: 'sc2' },
      { node_id: 'n3', scene_id: 'sc3' }
    ],
    profiles: [{ character_id: 'tallulah' }]
  };
}

function designReply(req) {
  const ids = (req.settled_facts || []).map(f => f.fact_id);
  const base = { chat_id: req.chat_id, route_id: req.route_id, base_revision: req.base_revision, scene_id: req.scene_id };
  if (ids.includes('met_already')) {
    return Object.assign(base, { brief_facts: [EARLY], future_summaries: [], worldbook: [], profile: [] });
  }
  return Object.assign(base, {
    advance_cursor: true,
    create_messages: [{ role: 'assistant', message: '不应写入楼层' }],
    completed_scene_ids: ['sc3'],
    brief_facts: [FAILED, SECOND],
    future_summaries: [
      { node_id: 'n3', summary: SECOND, status: 'revised', official_policy: 'hide', hide_fragments: [BAD] },
      { node_id: 'n_unknown', summary: '不存在的节点', status: 'revised' },
      {
        node_id: 'n3', summary: '', status: 'inapplicable', official_policy: 'hide',
        hide_fragments: [BAD, PHRASE], completion: null
      }
    ],
    worldbook: [
      { entry_id: 77, comment_pk: '[剧情]:塔露拉被掳后', action: 'disable', fragments: [PHRASE] },
      {
        entry_id: 8, comment_pk: '[角色]:塔露拉', character_id: 'tallulah', action: 'replace',
        content: '早年经历仍然有效。此次掳走并未成功。',
        fragments: ['被掳后她加入了整合运动。']
      },
      { entry_id: 404, comment_pk: '[剧情]:不存在', action: 'disable', fragments: ['不存在的条目'] }
    ],
    profile: [{
      character_id: 'tallulah',
      evidence: 'on_site',
      sections: {
        '经历': ON_SITE,
        '基本信息': '她将在下一幕再次被掳走并领导整合运动',
        '备注': '她将在下一幕再次被掳走并领导整合运动'
      }
    }]
  });
}

function stubFetch(calls) {
  return async (url, init) => {
    calls.n += 1;
    if (!String(url).includes('example.invalid')) throw new Error('refusing non-stub endpoint');
    const body = JSON.parse(init.body);
    const user = body.messages.find(m => m.role === 'user').content;
    const req = JSON.parse(user);
    const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
    assert.equal(auth, 'Bearer ' + STUB_API.key);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(designReply(req)) } }] }) };
  };
}

function makePlugin(fetchImpl) {
  const host = Plugin.createMemoryHost({ baseName: 'base-worldbook', baseEntries: [], chatId: 'chat_plot' });
  host.readDesignApi = () => ({ url: STUB_API.url, model: STUB_API.model, key: STUB_API.key });
  host.createChatMessages = () => { host._floors = (host._floors || 0) + 1; };
  const plugin = Plugin.createCopyWorldbookPlugin(host, { fetch: fetchImpl });
  return { host, plugin };
}

function usePlugin(plugin) {
  const prev = globalThis.__ARK_COPY_WORLDBOOK__;
  globalThis.__ARK_COPY_WORLDBOOK__ = plugin;
  return () => {
    if (prev) globalThis.__ARK_COPY_WORLDBOOK__ = prev;
    else delete globalThis.__ARK_COPY_WORLDBOOK__;
  };
}

function textEntry(id, text) {
  return { entry_id: id, text_sha256: id, chars: text.length };
}
function corpusNode(id, segmentId, entryId, text, title) {
  return {
    node_id: id, segment_id: segmentId, entry_id: entryId, source_id: 'src1',
    segment_count: 1, playable: true, title, act_name: title, start: 0, end: text.length,
    segments: [{ start: 0, end: text.length }], speakers: ['塔露拉'], chars: text.length
  };
}

function buildFixture() {
  const texts = {
    e1: '第一幕原文：双方见面。',
    e2: '第二幕原文：双方还在对峙。',
    e3: '第三幕原文：后续节点。'
  };
  const scenes = [1, 2, 3].map(i => ({
    scene_id: 'sc' + i, segment_ids: ['seg' + i], focus_actor_ids: ['amiya'],
    completion_criteria: '第' + i + '幕完成'
  }));
  const actors = [{ actor_id: 'amiya', canonical_name: '阿米娅', states: [{ entry_id: 1, label: '本格' }], profile_variants: [] }];
  const baseline = [
    { uid: 1, name: '[角色]:阿米娅', enabled: false, keys: ['阿米娅'], content: '阿米娅', strategy: { type: 'selective', keys: ['阿米娅'] } },
    { uid: 100, name: 'ARK剧情指导·测试线', enabled: false, keys: ['guide'], content: 'guide', strategy: { type: 'constant', keys: ['guide'] } }
  ];
  return {
    data_version: 'test-plot-direction',
    actors: { actors },
    catalog: { stories: [{ story_id: 'story_test', title: '测试线', category: 'main' }] },
    routes: { routes: [{ route_id: 'route:TEST', story_id: 'story_test', line_code: 'TEST', ordered_scene_ids: ['sc1', 'sc2', 'sc3'], focus_actor_ids: ['amiya'], cross_route_inputs: [] }] },
    scenes: { scenes },
    segments: { segments: scenes.map((s, i) => ({ segment_id: 'seg' + (i + 1), narrative: texts['e' + (i + 1)] })) },
    events: { events: [] },
    portraits: { portraits: [] },
    corpus: {
      texts,
      sources: [{ source_id: 'src1', relative_path: 'fixture.json', file_sha256: 'x', entries: [1, 2, 3].map(i => textEntry('e' + i, texts['e' + i])) }],
      nodes: [1, 2, 3].map(i => corpusNode('n' + i, 'seg' + i, 'e' + i, texts['e' + i], '第' + i + '幕')),
      lines: [{ route_id: 'route:TEST', ordered_scene_ids: ['sc1', 'sc2', 'sc3'] }]
    },
    route_guides: { guides: [{
      route_id: 'route:TEST', guide_id: 'g-test', status: '有完整原文且已接入',
      header_lines: [BAD],
      acts: [
        { node_id: 'n1', completion: '见面' },
        { node_id: 'n2', completion: '对峙' },
        { node_id: 'n3', completion: '被掳之后加入整合运动' }
      ],
      act_briefs: [
        { line: '第一幕：双方见面。' },
        { line: '第二幕：双方还在对峙。' },
        { line: BAD }
      ]
    }] },
    worldbook_binding: {
      physical: true, preserve_choice_actor_ids: [], actor_aliases: {}, story_states: {},
      reset_baseline: baseline.map(e => ({ uid: e.uid, enabled: e.enabled, type: e.strategy.type }))
    },
    route_guide_uids: { 'route:TEST': 100 },
    __baseline: baseline
  };
}

function createFakeHost(bookRows) {
  const chatId = 'chat_plot';
  const bookName = 'test-book';
  let book = bookRows.map(e => ({ ...e, strategy: { ...e.strategy } }));
  const vars = { [chatId]: {} };
  const chat = [];
  const listeners = {};
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
        chat.push({ ...row, message_id, swipe_id: 0, swipes: [row.message] });
      }
    },
    async setChatMessages() {},
    async getWorldbook() { return book.map(e => ({ ...e, strategy: { ...e.strategy } })); },
    async updateWorldbookWith(name, apply) {
      const next = await apply(book.map(e => e));
      if (Array.isArray(next)) book = next;
      return book;
    },
    getCharWorldbookNames() { return { primary: bookName }; },
    getChatWorldbookName() { return bookName; },
    injectPrompts(prompts) { g._prompts = prompts; return false; },
    uninjectPrompts() { g._prompts = []; },
    async generate() { throw new Error('generate_should_not_be_called'); },
    eventOn(name, handler) {
      (listeners[name] = listeners[name] || []).push(handler);
      return () => { listeners[name] = (listeners[name] || []).filter(h => h !== handler); };
    },
    getCurrentChatId() { return chatId; },
    getScriptId() { return 'ark_story'; },
    stopGenerationById() {}
  };
  return {
    g, capabilities: {},
    tavern_events: {
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
    },
    chatId: () => chatId,
    has: name => typeof g[name] === 'function',
    readChatVars: id => (id === chatId ? { ...(vars[chatId] || {}) } : {}),
    readChatVar: (id, key) => (id === chatId ? (vars[chatId] || {})[key] : undefined),
    writeChatVars(id, next) { if (id !== chatId) return false; vars[chatId] = { ...next }; return true; },
    scriptId: () => 'ark_story',
    messageById: id => g.getChatMessages(id)[0] || null,
    recentMessages: n => chat.slice(-n),
    worldbookName: () => bookName,
    charWorldbook: () => book,
    on(name, handler) { return g.eventOn(name, handler); },
    inject(prompts) { return !!g.injectPrompts(prompts); },
    uninject() { g.uninjectPrompts(); return true; },
    _emit(name, ...args) { return (listeners[name] || []).map(h => h(...args)); },
    _prompts: () => g._prompts || []
  };
}

function seedTallulah(plugin) {
  const content = profile('塔露拉', '早年经历仍然有效。被掳后她加入了整合运动。');
  plugin.enableCloneMode('chat_plot');
  plugin.upsertCharacterForm('chat_plot', {
    character_id: 'tallulah', canonical_name: '塔露拉', aliases: ['塔露拉']
  }, {
    form_id: '8', entry_id: 8, source_uid: 8, comment_pk: '[角色]:塔露拉',
    label: '[角色]:塔露拉', keys: ['塔露拉'], content
  });
  plugin.setDynamicLayer('chat_plot', 'tallulah', { non_canon_events: [PRIOR] });
}

async function run() {
  console.log('Plot direction layer tests');

  await test('trigger is not every message', () => {
    const state = bareState('route:TEST', 'sc2');
    for (const kind of ['dialogue', 'reorder', 'detour_same_result']) {
      const soft = Plot.consider(state, { message_kind: kind, facts: [], route_id: 'route:TEST', scene_id: 'sc2' });
      assert.equal(soft.call_design, false, kind);
      assert.ok(soft.reasons.includes('soft_turn'), kind);
    }
    assert.equal(state.route_progress['route:TEST'], undefined);
    const quiet = Plot.signalFromTurn(
      { route_progress: { 'route:TEST': { brief: '还在说话' } }, active_route: { route_id: 'route:TEST' } },
      state,
      { v: 2, route_id: 'route:TEST', scene_id: 'sc2', progress: { brief: '还在说话', message_kind: 'dialogue' }, event_results: [{ event_id: 'e', result: 'occurred' }] }
    );
    assert.equal(quiet, null);
    const first = Plot.consider(state, tallulahSignal(state));
    assert.equal(first.call_design, true);
    assert.ok(first.request && first.request.settled_facts.length === 1);
    const again = Plot.consider(state, tallulahSignal(state));
    assert.equal(again.call_design, false);
    assert.ok(again.reasons.some(r => r === 'already_pending' || r === 'already_handled' || r === 'fact_already_handled_local_exclude'), again.reasons.join(','));
  });

  await test('brief keeps settled facts and future plans stay in future summaries', () => {
    const state = bareState('route:TEST', 'sc2');
    Core.state.getRouteProgress(state, 'route:TEST').brief = '已经见面\n' + SECOND;
    const considered = Plot.consider(state, tallulahSignal(state));
    const adopted = Plot.adopt(state, considered, {
      ok: true,
      llm_calls: 0,
      cursor_advanced: false,
      floors_created: 0,
      revision: designReply(considered.request)
    });
    const brief = state.route_progress['route:TEST'].brief;
    assert.ok(brief.includes(FAILED), brief);
    assert.ok(brief.includes(EARLY), brief);
    assert.ok(!brief.includes(SECOND), brief);
    assert.ok(!brief.includes('整合运动'), brief);
    assert.equal(state.plot_direction.future_summaries.n3.status, 'inapplicable');
    assert.ok(!JSON.stringify(state.plot_direction.future_summaries).includes('再次被掳'), JSON.stringify(state.plot_direction.future_summaries));
    assert.equal(adopted.cursor_advanced, false);
    assert.equal(adopted.floors_created, 0);
    assert.equal(state.active_route.scene_id, 'sc2');
    assert.deepEqual(state.route_progress['route:TEST'].completed_scene_ids, []);
    assert.ok(adopted.revision.fact_ids.includes('tallulah_abduction_failed'));
    assert.deepEqual(state.plot_direction.future_summaries.n3.fact_ids, ['tallulah_abduction_failed']);
    assert.ok(state.plot_direction.excluded_entries['pk:[剧情]:塔露拉被掳后'].fact_ids.includes('tallulah_abduction_failed'));
    assert.ok(!state.plot_direction.future_summaries.n2, 'current scene must stay playable');
  });

  await test('design edits must match this archive, route, revision, and known ids', () => {
    const request = {
      chat_id: 'chat_plot', route_id: 'route:TEST', base_revision: 4,
      node_ids: ['n3'], scene_ids: ['sc2', 'sc3'],
      settled_facts: [tallulahFact()],
      entry_keys: [{ entry_id: 77, comment_pk: '[剧情]:塔露拉被掳后' }],
      profiles: [{ character_id: 'tallulah' }]
    };
    assert.equal(Plot.validateDesignEdits(request, { chat_id: 'other', route_id: 'route:TEST', base_revision: 4 }).reason, 'archive_mismatch');
    assert.equal(Plot.validateDesignEdits(request, { chat_id: 'chat_plot', route_id: 'route:OTHER', base_revision: 4 }).reason, 'route_mismatch');
    assert.equal(Plot.validateDesignEdits(request, { chat_id: 'chat_plot', route_id: 'route:TEST', base_revision: 3 }).reason, 'stale_progress');
    const mixed = Plot.validateDesignEdits(request, {
      chat_id: 'chat_plot', route_id: 'route:TEST', base_revision: 4,
      future_summaries: [{ node_id: 'n_missing', summary: 'x' }],
      worldbook: [{ entry_id: 9, comment_pk: '[剧情]:别的', action: 'disable' }],
      profile: [{ character_id: 'other', evidence: 'on_site', sections: { '经历': '不该写入' } }]
    });
    assert.ok(mixed.rejected.some(r => r.reason === 'unknown_node'));
    assert.ok(mixed.rejected.some(r => r.reason === 'unknown_entry'));
    assert.ok(mixed.rejected.some(r => r.reason === 'unknown_character'));
    assert.equal(mixed.accepted.future_summaries.length, 0);
    assert.equal(mixed.accepted.worldbook.length, 0);
  });

  await test('api failure still blocks conflicting refs and continues the current scene', async () => {
    const state = bareState('route:TEST', 'sc2');
    const considered = Plot.consider(state, tallulahSignal(state));
    const { host, plugin } = makePlugin(async () => { throw new Error('down'); });
    plugin.enableCloneMode('chat_plot');
    const restore = usePlugin(plugin);
    try {
      const design = await plugin.revisePlotDirection('chat_plot', considered.request);
      assert.equal(design.ok, false);
      assert.equal(design.cursor_advanced, false);
      assert.equal(design.floors_created, 0);
      assert.equal(design.scene_continues, true);
      assert.equal(host._floors || 0, 0);
      const adopted = Plot.adopt(state, considered, design);
      assert.equal(state.active_route.scene_id, 'sc2');
      assert.equal(adopted.relocated, false);
      assert.deepEqual(state.route_progress['route:TEST'].completed_scene_ids, []);
      assert.equal(state.plot_direction.future_summaries.n3.status, 'conflict_blocked');
      assert.equal(state.plot_direction.future_summaries.n3.summary, '');
      assert.ok(!JSON.stringify(state.plot_direction).includes('再次被掳'));
      const inj = Plot.decorateInjection(state, {
        scene_material: '双方还在对峙。',
        route_guide: { text: BAD },
        corpus_segment: { node_id: 'n2' },
        current_goal: '对峙'
      });
      assert.ok(inj.scene_material.includes('双方还在对峙'));
      assert.ok(!inj.scene_material.includes('已经被掳走'));
      assert.ok(!inj.route_guide.text.includes(BAD));
      const eventData = {
        chat: [{ role: 'system', content: '忽略旧设定。' + PHRASE }],
        chatLore: [{ comment: '[剧情]:塔露拉被掳后', name: '[剧情]:塔露拉被掳后', uid: 77, content: PHRASE }]
      };
      const filtered = plugin.filterOutboundPrompt(eventData, 'chat_plot', { excluded: Object.values(state.plot_direction.excluded_entries) });
      const packed = JSON.stringify(filtered.payload);
      assert.ok(packed.includes('忽略旧设定'));
      assert.ok(!packed.includes(PHRASE), packed);
      const store = plugin.loadSidecar('chat_plot');
      assert.ok((store.plot_layer.exclusions || []).some(ex => (ex.fragments || []).some(f => String(f).includes('已经被掳走'))));
    } finally { restore(); }
  });

  await test('ten conflicting entries stay out of the next prompt while only eight are written', async () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        entry_id: 500 + i,
        comment_pk: '[剧情]:冲突' + i,
        action: 'disable',
        fragments: ['冲突片段' + i + '必须排除']
      });
    }
    const request = {
      chat_id: 'chat_plot', route_id: 'route:TEST', base_revision: 1, call_design: true,
      node_ids: [], scene_ids: ['sc2'], settled_facts: [tallulahFact()],
      entry_keys: entries.map(e => ({ entry_id: e.entry_id, comment_pk: e.comment_pk })),
      local_exclusions: entries.map(e => ({ ...e, key: 'pk:' + e.comment_pk, fact_ids: ['tallulah_abduction_failed'] }))
    };
    const { plugin } = makePlugin(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        chat_id: 'chat_plot', route_id: 'route:TEST', base_revision: 1,
        brief_facts: [FAILED], future_summaries: [], worldbook: entries, profile: []
      }) } }] })
    }));
    plugin.enableCloneMode('chat_plot');
    const result = await plugin.revisePlotDirection('chat_plot', request);
    assert.equal(result.cap_deferred, 2);
    assert.ok((result.warnings || []).some(w => w && String(w.message || w).includes('另有 2 条未写入')));
    const payload = {
      chatLore: entries.map(e => ({ comment: e.comment_pk, name: e.comment_pk, uid: e.entry_id, content: e.fragments[0] })),
      messages: [{ role: 'system', content: entries.map(e => e.fragments[0]).join('\n') }]
    };
    const filtered = plugin.filterOutboundPrompt(payload, 'chat_plot');
    const packed = JSON.stringify(filtered.payload);
    for (const e of entries) assert.ok(!packed.includes(e.fragments[0]), e.comment_pk);
  });

  await test('paused side line keeps its resume point and does not switch to the main route', () => {
    const state = bareState('route:SIDE', 'sc_side');
    const signal = {
      chat_id: state.chat_id, route_id: 'route:SIDE', scene_id: 'sc_side', node_id: 'n_side',
      message_kind: 'causal',
      facts: [{ fact_id: 'hook_gone', text: '旧钩子已经不成立', kind: 'sideline_pause', settled: true, contradicts: ['旧钩子'] }],
      sideline: { hook_broken: true, route_id: 'route:SIDE', resume_scene_id: 'sc_side', resume_segment_index: 1 },
      ordered_nodes: [{ node_id: 'n_side', scene_id: 'sc_side' }],
      summaries: []
    };
    const considered = Plot.consider(state, signal);
    assert.equal(considered.call_design, true);
    const adopted = Plot.adopt(state, considered, {
      ok: true,
      revision: {
        chat_id: state.chat_id, route_id: 'route:SIDE', base_revision: considered.request.base_revision,
        brief_facts: ['旧钩子已经不成立'],
        sideline: { action: 'pause', route_id: 'route:SIDE', resume_scene_id: 'sc_side', resume_segment_index: 1 }
      }
    });
    assert.equal(state.active_route.route_id, 'route:SIDE');
    assert.equal(state.active_route.scene_id, 'sc_side');
    assert.equal(state.plot_direction.sidelines['route:SIDE'].status, 'paused');
    assert.equal(state.plot_direction.sidelines['route:SIDE'].resume_scene_id, 'sc_side');
    assert.equal(state.plot_direction.sidelines['route:SIDE'].resume_segment_index, 1);
    assert.equal(adopted.cursor_advanced, false);
    const rejected = Plot.validateDesignEdits(considered.request, {
      chat_id: state.chat_id, route_id: 'route:SIDE', base_revision: considered.request.base_revision,
      sideline: { action: 'close', route_id: 'route:MAIN', resume_scene_id: 'sc1' }
    });
    assert.ok(rejected.rejected.some(r => r.reason === 'route_not_in_request'));
    assert.equal(state.active_route.route_id, 'route:SIDE');
  });

  await test('inapplicable current node is not recorded as having happened', () => {
    const state = bareState('route:TEST', 'sc_dead');
    const signal = {
      chat_id: state.chat_id, route_id: 'route:TEST', scene_id: 'sc_dead', node_id: 'n_dead',
      facts: [{ fact_id: 'void_now', text: '当前前提已经作废', kind: 'completion', settled: true, contradicts: ['旧前提'] }],
      summaries: [{ node_id: 'n_dead', summary: '旧前提仍要发生', timing: 'future' }],
      ordered_nodes: [
        { node_id: 'n_dead', scene_id: 'sc_dead' },
        { node_id: 'n_next', scene_id: 'sc_next' }
      ]
    };
    const considered = Plot.consider(state, signal);
    const adopted = Plot.adopt(state, considered, {
      ok: true,
      revision: {
        chat_id: state.chat_id, route_id: 'route:TEST', base_revision: considered.request.base_revision,
        brief_facts: ['当前前提已经作废'],
        future_summaries: [{ node_id: 'n_dead', summary: '', status: 'inapplicable', official_policy: 'hide', hide_fragments: ['旧前提仍要发生'] }]
      }
    });
    assert.equal(adopted.cursor_advanced, false);
    assert.equal(adopted.settled_skipped, false);
    assert.ok(!state.route_progress['route:TEST'].completed_scene_ids.includes('sc_dead'));
    assert.deepEqual(state.event_ledger, {});
    assert.equal(state.plot_direction.inapplicable_nodes.n_dead.label, '本存档不再适用');
    assert.equal(state.active_route.scene_id, 'sc_next');
    assert.equal(Plot.blocksSettlement(state, { segment_node_id: 'n_dead' }), true);
    assert.equal(Plot.blocksSettlement(state, { segment_node_id: 'n_next' }), false);
    const arrived = bareState('route:TEST', 'sc_dead');
    Plot.ensure(arrived);
    arrived.plot_direction.inapplicable_nodes.n_dead = { node_id: 'n_dead', label: '本存档不再适用', fact_ids: ['void_now'] };
    arrived.plot_direction.ordered_nodes = signal.ordered_nodes;
    arrived.corpus_progress = { 'route:TEST': { node_id: 'n_dead', segment_index: 0 } };
    const moved = Plot.releaseInapplicableCursor(arrived);
    assert.equal(moved.relocated, true);
    assert.equal(moved.settled_skipped, false);
    assert.equal(arrived.active_route.scene_id, 'sc_next');
    assert.deepEqual(arrived.route_progress['route:TEST'].completed_scene_ids, []);
  });

  await test('Tallulah abduction failure revises later summaries and rolls back without erasing earlier experience', async () => {
    const calls = { n: 0 };
    const { host: pluginHost, plugin } = makePlugin(stubFetch(calls));
    seedTallulah(plugin);
    const restore = usePlugin(plugin);
    const storyHost = createFakeHost(buildFixture().__baseline);
    const data = buildFixture();
    const runtime = Core.createRuntime(data);
    const adapter = Adapter.createStoryAdapter({
      runtime, host: storyHost, worldbookName: 'test-book',
      state: runtime.createState({ chat_id: 'chat_plot', branch_id: 'branch_1' }),
      strictPhysical: false
    });
    try {
      adapter.init();
      assert.ok(Rules.RULES_CONTENT.includes('plot_facts'));
      const entered = await adapter.enterRoute('route:TEST', 'live');
      assert.equal(adapter.getState().active_route && adapter.getState().active_route.scene_id, 'sc1', entered && (entered.error || entered.reason));
      for (const kind of ['dialogue', 'reorder', 'detour_same_result']) {
        const soft = Plot.consider(adapter.getState(), { message_kind: kind, route_id: 'route:TEST', scene_id: 'sc1', facts: [] });
        assert.equal(soft.call_design, false, kind);
      }
      assert.equal(calls.n, 0);
      const early = await adapter.revisePlotDirection({
        chat_id: 'chat_plot', route_id: 'route:TEST', scene_id: 'sc1', node_id: 'n1', message_kind: 'causal',
        facts: [{ fact_id: 'met_already', text: EARLY, kind: 'premise', settled: true }]
      });
      assert.equal(early.called, true, JSON.stringify(early.reasons));
      assert.equal(early.cursor_advanced, false);
      assert.equal(early.floors_created, 0);
      assert.equal(calls.n, 1);
      assert.equal(pluginHost._floors || 0, 0);
      assert.ok(adapter.getState().route_progress['route:TEST'].brief.includes(EARLY));
      const read = await adapter.directReadCurrentSegment();
      assert.equal(read.ok, true, read.error);
      assert.equal(adapter.getState().active_route.scene_id, 'sc2');
      PhaseA.markSceneExperience(adapter.getState(), 'played', null, {
        route_id: 'route:TEST', scene_id: 'sc1', segment_index: 0, summary: PRIOR
      });
      const beforeLater = calls.n;
      const state = adapter.getState();
      state.route_progress['route:TEST'].brief += '\n' + SECOND;
      const considered = Plot.consider(state, tallulahSignal(state));
      assert.equal(considered.call_design, true);
      assert.equal(calls.n, beforeLater, 'consider must not call the design API');
      assert.ok(!state.route_progress['route:TEST'].brief.includes(SECOND));
      assert.equal(state.plot_direction.future_summaries.n2, undefined);
      const pending = state.plot_direction.pending;
      assert.ok(pending && pending.request);
      const emitted = storyHost._emit('GENERATION_AFTER_COMMANDS', 'continue', {}, false);
      await Promise.all(emitted.map(v => v));
      assert.equal(calls.n, beforeLater + 1);
      assert.equal(pluginHost._floors || 0, 0);
      assert.equal(state.active_route.scene_id, 'sc2');
      assert.equal(state.active_route.route_id, 'route:TEST');
      assert.ok(!state.route_progress['route:TEST'].completed_scene_ids.includes('sc3'));
      assert.ok(!state.route_progress['route:TEST'].completed_scene_ids.includes('sc2'));
      assert.deepEqual(state.event_ledger, {});
      assert.equal(state.plot_direction.future_summaries.n3.status, 'inapplicable');
      assert.equal(state.plot_direction.future_summaries.n3.label || state.plot_direction.inapplicable_nodes.n3.label, '本存档不再适用');
      assert.ok(state.plot_direction.revisions.some(rev => (rev.fact_ids || []).includes('tallulah_abduction_failed')));
      assert.ok(!JSON.stringify(state.plot_direction).includes('再次被掳'));
      assert.ok(state.route_progress['route:TEST'].brief.includes(FAILED));
      assert.ok(state.route_progress['route:TEST'].brief.includes(EARLY));
      assert.ok(!state.route_progress['route:TEST'].brief.includes('下一幕'));
      const inj = runtime.buildPromptInjection(state);
      const packedInj = JSON.stringify(inj);
      assert.ok(packedInj.includes('双方还在对峙'), packedInj);
      assert.ok(!packedInj.includes(BAD), packedInj);
      assert.ok(!packedInj.includes(PHRASE), packedInj);
      assert.ok(packedInj.includes('本存档不再适用') || packedInj.includes('本存档后续参考'), packedInj);
      const prompts = storyHost._prompts().map(p => p.content).join('\n');
      assert.ok(prompts.includes('双方还在对峙'));
      assert.ok(!prompts.includes(BAD));
      assert.ok(!prompts.includes('再次被掳'));
      const compiled = plugin.compileBook('chat_plot').entries.map(e => e.content).join('\n');
      assert.ok(compiled.includes(PRIOR), compiled);
      assert.ok(compiled.includes(ON_SITE), compiled);
      assert.ok(compiled.includes('早年经历仍然有效'), compiled);
      assert.ok(!compiled.includes('被掳后她加入了整合运动'), compiled);
      const eventData = {
        chat: [{ role: 'system', content: '忽略旧设定。' + PHRASE }],
        chatLore: [{ comment: '[剧情]:塔露拉被掳后', name: '[剧情]:塔露拉被掳后', uid: 77, content: PHRASE, enabled: true }]
      };
      storyHost._emit('CHAT_COMPLETION_PROMPT_READY', eventData);
      assert.ok(eventData.chat[0].content.includes('忽略旧设定'));
      assert.ok(!JSON.stringify(eventData).includes(PHRASE), JSON.stringify(eventData));
      const lores = {
        chatLore: [{ world: 'test-book', uid: 77, comment: '[剧情]:塔露拉被掳后', name: '[剧情]:塔露拉被掳后', content: PHRASE, enabled: true }],
        globalLore: [], characterLore: [], personaLore: []
      };
      storyHost._emit('WORLDINFO_ENTRIES_LOADED', lores);
      assert.ok(!JSON.stringify(lores).includes(PHRASE), JSON.stringify(lores));
      assert.equal(pluginHost.metrics.base_writes, 0);
      const callsBeforeRepeat = calls.n;
      const repeated = Plot.consider(state, tallulahSignal(state));
      assert.equal(repeated.call_design, false);
      await Promise.all(storyHost._emit('GENERATION_AFTER_COMMANDS', 'continue', {}, false).map(v => v));
      assert.equal(calls.n, callsBeforeRepeat);
      const re = adapter.reanchorToScene('route:TEST', 'sc2', 0);
      assert.equal(re.ok, true, re.error);
      assert.equal(re.restored_entry_snapshot, true);
      const after = adapter.getState();
      assert.equal(after.active_route.route_id, 'route:TEST');
      assert.equal(after.active_route.scene_id, 'sc2');
      assert.ok(after.plot_direction.facts.met_already, 'early fact was erased');
      assert.ok(!after.plot_direction.facts.tallulah_abduction_failed, 'later fact survived jump-back');
      assert.ok(!after.plot_direction.future_summaries.n3, 'later summary survived jump-back');
      assert.ok((after.route_progress['route:TEST'].brief || '').includes(EARLY));
      assert.ok(!(after.route_progress['route:TEST'].brief || '').includes(FAILED));
      const exp = Object.values(after.scene_experience || {});
      assert.ok(exp.some(e => e.scene_id === 'sc1' && e.summary === PRIOR), JSON.stringify(exp));
      const rolled = plugin.compileBook('chat_plot').entries.map(e => e.content).join('\n');
      assert.ok(rolled.includes(PRIOR), rolled);
      assert.ok(rolled.includes('早年经历仍然有效'), rolled);
      assert.ok(!rolled.includes(ON_SITE), rolled);
      assert.equal(pluginHost._floors || 0, 0);
      assert.equal(pluginHost.metrics.base_writes, 0);
    } finally {
      try { adapter.destroy(); } catch (_) {}
      restore();
    }
  });

  await test('missing tavern and plugin api still blocks conflicting refs without fetching', async () => {
    const state = bareState('route:TEST', 'sc2');
    const considered = Plot.consider(state, tallulahSignal(state));
    let fetchCalls = 0;
    const host = Plugin.createMemoryHost({ baseName: 'base-worldbook', baseEntries: [], chatId: 'chat_plot' });
    host.readDesignApi = () => Plugin.TavernApi.resolveGenerateApi({
      pluginSettings: { url: '', model: 'deepseek-v4.1-flash-1017', key: '' },
      context: {}
    });
    const plugin = Plugin.createCopyWorldbookPlugin(host, {
      fetch: async () => { fetchCalls += 1; throw new Error('unavailable path must not fetch'); }
    });
    plugin.enableCloneMode('chat_plot');
    const restore = usePlugin(plugin);
    try {
      const design = await plugin.revisePlotDirection('chat_plot', considered.request);
      assert.equal(design.ok, false);
      assert.equal(design.scene_continues, true);
      assert.equal(design.cursor_advanced, false);
      assert.equal(design.floors_created, 0);
      assert.equal(fetchCalls, 0);
      const adopted = Plot.adopt(state, considered, design);
      assert.equal(adopted.relocated, false);
      assert.equal(state.active_route.scene_id, 'sc2');
      const inj = Plot.decorateInjection(state, {
        scene_material: '双方还在对峙。',
        route_guide: { text: BAD },
        corpus_segment: { node_id: 'n2' },
        current_goal: '对峙'
      });
      assert.ok(inj.scene_material.includes('双方还在对峙'));
      assert.ok(!inj.route_guide.text.includes(BAD));
    } finally { restore(); }
  });

  test('design rejects missing character conclusion', () => {
    const req = { effective_actions: [{ action_id: 'a1' }], archive_version: 3, required_characters: ['c1'], node_ids: ['n1'] };
    const design = { base_revision: 3, character_conclusions: [] };
    const out = Plot.validateDesignEdits(req, design);
    assert.strictEqual(out.ok, false);
    assert.ok(out.rejected.some(r => r.reason === 'missing_conclusion'));
  });

  test('design rejects voided action reference', () => {
    const req = { effective_actions: [{ action_id: 'a1', voided: true }], archive_version: 3, required_characters: ['c1'], node_ids: ['n1'] };
    const design = { base_revision: 3, character_conclusions: [{ character_id: 'c1', participation: 'participate', reason: 'r', constraints: 'c', action_refs: ['a1'], archive_version: 3 }] };
    const out = Plot.validateDesignEdits(req, design);
    assert.strictEqual(out.ok, false);
    assert.ok(out.rejected.some(r => r.reason === 'invalid_action_ref'));
  });

  test('design rejects stale archive version', () => {
    const req = { effective_actions: [{ action_id: 'a1' }], archive_version: 3, required_characters: ['c1'], node_ids: ['n1'] };
    const design = { base_revision: 3, character_conclusions: [{ character_id: 'c1', participation: 'participate', reason: 'r', constraints: 'c', action_refs: ['a1'], archive_version: 2 }] };
    const out = Plot.validateDesignEdits(req, design);
    assert.strictEqual(out.ok, false);
    assert.ok(out.rejected.some(r => r.reason === 'stale_archive_version'));
  });

  test('design accepts valid conclusion and action refs', () => {
    const req = { effective_actions: [{ action_id: 'a1' }], archive_version: 3, required_characters: ['c1'], node_ids: ['n1'] };
    const design = { base_revision: 3, character_conclusions: [{ character_id: 'c1', participation: 'participate', reason: 'r', constraints: 'c', action_refs: ['a1'], archive_version: 3 }] };
    const out = Plot.validateDesignEdits(req, design);
    assert.strictEqual(out.ok, true);
    assert.ok(Array.isArray(out.accepted.character_conclusions));
    assert.strictEqual(out.accepted.character_conclusions.length, 1);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
