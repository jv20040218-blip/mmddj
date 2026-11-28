'use strict';

// ASTER / dynamic archive — slice 1 (tasks 1–2).
// Covers: independent-entry / dynamic-archive protection in the shared gate,
// legacy auto_toggle path, character_book_state enter/exit/reset, and
// apply-time re-check. Extensible for later slices.

const assert = require('assert');
const path = require('path');

const CORE = path.join(__dirname, '..', 'extensions', 'arknights-copy-worldbook', 'core');
const Plugin = require(path.join(CORE, 'plugin.js'));

const ArchiveProtection = require(path.join(CORE, 'archive_protection.js'));
const Sidecar = require(path.join(CORE, 'sidecar.js'));
const AutoSwitch = require(path.join(CORE, 'auto_switch.js'));
const AutoToggle = require(path.join(CORE, 'auto_toggle.js'));
const { createCharacterBookState } = require(path.join(CORE, 'character_book_state.js'));
const { createArchiveScope } = require(path.join(CORE, 'archive_scope.js'));
const Compiler = require(path.join(CORE, 'compiler.js'));
const Plot = require(path.join(__dirname, '..', 'maintenance', 'runtime-src', 'core', 'plot_direction.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (err) {
    failed++;
    console.error('not ok - ' + name);
    console.error(err && err.stack || err);
    process.exitCode = 1;
  }
}

// --- helpers -------------------------------------------------------------

const FROST_BASE = '[角色]:霜星(本格,与雪原选一开)';
const FROST_SNOW = '[角色]:霜星(雪原,与本格选一开)';
const TIME_KEYS = [
  '[角色]: 瓦莲汀·沃尔金娜（剧情·时间啊，向前！·25）',
  '[角色]: 拉夫连·卡尔诺夫（剧情·时间啊，向前！·26）',
  '[角色]: 雅罗米尔（剧情·时间啊，向前！·27）',
  '[角色]: 罗季昂（剧情·时间啊，向前！·28）',
  '[角色]: 西尔卡（剧情·时间啊，向前！·30）',
  '[角色]: 斯韦特兰纳（剧情·时间啊，向前！·31）',
  '[角色]: 叶甫根尼（剧情·时间啊，向前！·32）',
  '[角色]: 雷尔金（剧情·时间啊，向前！·33）',
  '[角色]: 希尔达（剧情·时间啊，向前！·34）',
  '[角色]: 纳斯塔霞（剧情·时间啊，向前！·35）',
  '[角色]: 维特（剧情·时间啊，向前！·38）'
];

function timeNameOf(pk) {
  const m = pk.match(/\[角色\]:\s*(.+?)（/);
  return m ? m[1] : pk;
}

function buildChapterHost(extraEntries) {
  const baseEntries = [
    { comment: FROST_BASE, content: '霜星本格内容' },
    { comment: FROST_SNOW, content: '霜星雪原内容' }
  ].concat(extraEntries || []);
  return Plugin.createMemoryHost({ baseName: 'chapter-switch-base', baseEntries });
}

function setupChapterChat(plugin) {
  const chatId = 'chat-chapter-switch';
  plugin.enableCloneMode(chatId);
  plugin.upsertCharacterForm(chatId, { character_id: 'frostnova', canonical_name: '霜星' }, {
    form_id: FROST_BASE, comment_pk: FROST_BASE, content: '霜星本格内容'
  });
  return chatId;
}

function makeStore() {
  return Sidecar.emptySidecar();
}

function seedCharacter(store, id, name) {
  return Sidecar.ensureCharacter(store, id, { canonical_name: name });
}

function addForm(store, id, formId, opts) {
  const o = opts || {};
  return Sidecar.setForm(store, id, {
    form_id: formId,
    entry_id: o.entry_id != null ? o.entry_id : formId,
    comment_pk: o.comment_pk || ('pk_' + formId),
    content: o.content || ('content of ' + formId),
    independent: o.independent === true
  }, { canonical_name: o.name || id });
}

function addDynamicEvent(store, id, text) {
  Sidecar.setDynamic(store, id, {
    non_canon_events: [text]
  });
}

function makeCatalog(entries) {
  return entries.map(e => ({
    character_id: e.character_id,
    canonical_name: e.canonical_name,
    aliases: e.aliases || [],
    forms: (e.forms || []).map(f => ({
      entry_id: f.entry_id,
      comment_pk: f.comment_pk,
      content: f.content || ''
    }))
  }));
}

function makeWriter() {
  const enabled = new Set();
  return {
    enabled,
    isWritable() { return true; },
    setEntryEnabled(pk, on) {
      if (on) enabled.add(String(pk));
      else enabled.delete(String(pk));
      return { ok: true };
    },
    getEntryEnabled(pk) { return enabled.has(String(pk)); }
  };
}

function makeScope() {
  return createArchiveScope({
    card: { name: 'card-A' },
    chat: { chat_id: 'save-A' },
    copy: { name: 'copy-A' }
  });
}

// 霜星雪原主键 catalog：可被 findTarget 命中。
function makeFrostCatalog() {
  return makeCatalog([{
    character_id: 'frostnova',
    canonical_name: '霜星',
    forms: [
      { entry_id: FROST_BASE, comment_pk: FROST_BASE, content: '霜星本格内容' },
      { entry_id: FROST_SNOW, comment_pk: FROST_SNOW, content: '霜星雪原内容' }
    ]
  }]);
}

// --- 1. independent entry + clear/missing influence => protected ---------

test('independent entry + missing influence => protected (auto_switch)', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.strictEqual(plan.protected[0].name, '角色甲');
  assert.ok(plan.protected[0].reasons.includes('independent_entry'));
  assert.strictEqual(plan.switched.length, 0);
});

test('independent entry + clear influence => protected (auto_switch)', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: { '角色甲': { status: 'clear' } },
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('independent_entry'));
  assert.strictEqual(plan.switched.length, 0);
});

// --- 2. dynamic archive only (independent link missing) => protected -----

test('dynamic archive only => protected with pending link', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  addDynamicEvent(store, 'c1', '在雪原救下商队');
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('dynamic_archive'));
  assert.ok(plan.protected[0].pending.includes('independent_link_missing'));
  assert.strictEqual(plan.switched.length, 0);
});

// --- 3. independent entry + uninitialized archive => still protected -----

test('independent entry + uninitialized archive => still protected', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  // archive_status stays 'empty'; dynamic is empty shell.
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('independent_entry'));
  assert.ok(plan.protected[0].pending.includes('archive_uninitialized'));
  assert.strictEqual(plan.switched.length, 0);
});

// --- 4. no records => clear / new save still auto candidate --------------

test('no records + clear influence => auto candidate (auto_switch)', () => {
  const store = makeStore();
  seedCharacter(store, 'frostnova', '霜星');
  addForm(store, 'frostnova', FROST_BASE, { independent: false, comment_pk: FROST_BASE });
  const catalog = makeFrostCatalog();
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '霜星' }],
    influenceByCharacter: { '霜星': { status: 'clear' } },
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 0);
  assert.strictEqual(plan.switched.length, 1);
  assert.strictEqual(plan.switched[0].name, '霜星');
});

test('no records + missing influence => auto candidate (auto_switch)', () => {
  const store = makeStore();
  seedCharacter(store, 'frostnova', '霜星');
  addForm(store, 'frostnova', FROST_BASE, { independent: false, comment_pk: FROST_BASE });
  const catalog = makeFrostCatalog();
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '霜星' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 0);
  assert.strictEqual(plan.switched.length, 1);
});

// --- 5. severe / unknown / manual keep protecting ------------------------

test('severe influence keeps protecting', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: { '角色甲': { status: 'severe' } },
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('severe'));
});

test('unknown influence keeps protecting', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: { '角色甲': { status: 'unknown' } },
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('unknown'));
});

test('manual lock keeps protecting', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: { '角色甲': { locked: true } },
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('manual'));
});

// --- 6. manual released but archive still present => still protected -----

test('manual released but independent entry remains => still protected', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '角色甲' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {}, // released
    catalog,
    store
  });
  assert.strictEqual(plan.protected.length, 1);
  assert.ok(plan.protected[0].reasons.includes('independent_entry'));
  assert.ok(!plan.protected[0].reasons.includes('manual'));
});

// --- 7. apply-time re-check: archive created during async => skip --------

test('apply re-check: archive created during async => skipped', () => {
  const store = makeStore();
  seedCharacter(store, 'frostnova', '霜星');
  addForm(store, 'frostnova', FROST_BASE, { independent: false, comment_pk: FROST_BASE });
  const catalog = makeFrostCatalog();
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '霜星' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.switched.length, 1);
  // Simulate async: archive appears before write.
  addDynamicEvent(store, 'frostnova', '异步期间新增经历');
  const writer = makeWriter();
  const applied = AutoSwitch.applyAutoSwitch(plan, writer, {
    store,
    influenceByCharacter: {},
    manual: {}
  });
  assert.strictEqual(applied.applied.length, 0);
  assert.strictEqual(applied.skipped.length, 1);
  assert.strictEqual(applied.skipped[0].reason, 'protected');
  assert.strictEqual(writer.enabled.size, 0);
});

test('apply re-check: manual set during async => skipped', () => {
  const store = makeStore();
  seedCharacter(store, 'frostnova', '霜星');
  addForm(store, 'frostnova', FROST_BASE, { independent: false, comment_pk: FROST_BASE });
  const catalog = makeFrostCatalog();
  const plan = AutoSwitch.planAutoSwitch({
    chapter: '雪原线',
    sceneCharacters: [{ name: '霜星' }],
    influenceByCharacter: {},
    currentForms: {},
    manual: {},
    catalog,
    store
  });
  assert.strictEqual(plan.switched.length, 1);
  const writer = makeWriter();
  const applied = AutoSwitch.applyAutoSwitch(plan, writer, {
    store,
    influenceByCharacter: {},
    manual: { '霜星': { locked: true } }
  });
  assert.strictEqual(applied.applied.length, 0);
  assert.strictEqual(applied.skipped[0].reason, 'protected');
});

// --- 8. legacy auto_toggle path also skips protected ---------------------

test('legacy auto_toggle skips protected character', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoToggle.planAutoToggle(
    { speakers: ['角色甲'] },
    catalog,
    store.characters,
    { store, influenceByCharacter: {}, manual: {} }
  );
  assert.strictEqual(plan.enable.length, 0);
  assert.strictEqual(plan.protected.length, 1);
  assert.strictEqual(plan.protected[0].name, '角色甲');
});

test('legacy auto_toggle allows unprotected character', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const plan = AutoToggle.planAutoToggle(
    { speakers: ['角色甲'] },
    catalog,
    store.characters,
    { store, influenceByCharacter: {}, manual: {} }
  );
  assert.strictEqual(plan.enable.length, 1);
  assert.strictEqual(plan.protected.length, 0);
});

// --- 9. character_book_state enter/exit/reset respect protection ---------

test('character_book_state enterChapter keeps protected character', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  addDynamicEvent(store, 'c1', '已有经历');
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const state = createCharacterBookState({ catalog, store, scope: makeScope() });
  const writer = makeWriter();
  const res = state.enterChapter('雪原线', [{ name: '角色甲' }], writer);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.plan.protected.length, 1);
  assert.ok(res.plan.protected[0].reasons.includes('independent_entry'));
  assert.strictEqual(writer.enabled.size, 0);
});

test('character_book_state exitChapter skips protected character', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const state = createCharacterBookState({ catalog, store, scope: makeScope() });
  // Manually set a current form first.
  state.setForm('角色甲', 'pk_f1', { snapshot: false });
  const writer = makeWriter();
  const res = state.exitChapter(writer);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.restored.length, 0);
  assert.strictEqual(res.skipped.length, 1);
  assert.ok(res.skipped[0].reasons.includes('independent_entry'));
});

test('character_book_state reset keeps protected current form', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: true });
  const catalog = makeCatalog([{ character_id: 'c1', canonical_name: '角色甲', forms: [{ entry_id: 'f1', comment_pk: 'pk_f1' }] }]);
  const state = createCharacterBookState({ catalog, store, scope: makeScope() });
  state.setForm('角色甲', 'pk_f1', { snapshot: false });
  const res = state.reset();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.kept['角色甲'], 'pk_f1');
});

// --- 10. influenceStatusOf compatibility ---------------------------------

test('influenceStatusOf: {status:clear} => clear', () => {
  assert.strictEqual(AutoSwitch.influenceStatusOf({ status: 'clear' }), 'clear');
  assert.strictEqual(AutoSwitch.influenceStatusOf(null), 'clear');
  assert.strictEqual(AutoSwitch.influenceStatusOf('clear'), 'clear');
});

test('allowsAutoModification("clear") still works', () => {
  const { allowsAutoModification } = require(path.join(CORE, 'influence.js'));
  assert.strictEqual(allowsAutoModification('clear'), true);
  assert.strictEqual(allowsAutoModification('severe'), false);
  assert.strictEqual(allowsAutoModification('unknown'), false);
  assert.strictEqual(allowsAutoModification('manual'), false);
});

// --- 11. emptyDynamic shell does not count as archive --------------------

test('emptyDynamic shell does not trigger archive protection', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  // dynamic.main is empty shell from ensureCharacter.
  const verdict = ArchiveProtection.evaluateProtection({
    name: '角色甲',
    store,
    influenceByCharacter: {},
    manual: {}
  });
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.protected, false);
});

// --- 12. setForm auto-copy does NOT mark independent ---------------------

test('setForm without independent flag does not mark independent', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const rec = store.characters['c1'];
  assert.strictEqual(rec.forms['f1'].independent, false);
  assert.deepStrictEqual(rec.independent_entries, {});
  const verdict = ArchiveProtection.evaluateProtection({
    name: '角色甲',
    store,
    influenceByCharacter: {},
    manual: {}
  });
  assert.strictEqual(verdict.allowed, true);
});

// --- 13. markIndependentEntry explicit marker ----------------------------

test('markIndependentEntry marks existing form', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const r = Sidecar.markIndependentEntry(store, 'c1', 'f1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(store.characters['c1'].forms['f1'].independent, true);
  assert.strictEqual(store.characters['c1'].independent_entries['f1'], true);
});

// --- 14. archive_status synced counts as archive -------------------------

test('archive_status synced counts as dynamic archive', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  Sidecar.setArchiveStatus(store, 'c1', { status: 'synced', last_synced_at: 123 });
  const verdict = ArchiveProtection.evaluateProtection({
    name: '角色甲',
    store,
    influenceByCharacter: {},
    manual: {}
  });
  assert.strictEqual(verdict.protected, true);
  assert.ok(verdict.reasons.includes('dynamic_archive'));
});

// --- 15. archive_status failed still protects ----------------------------

test('archive_status failed still protects', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  Sidecar.setArchiveStatus(store, 'c1', { status: 'failed', last_error: 'boom' });
  const verdict = ArchiveProtection.evaluateProtection({
    name: '角色甲',
    store,
    influenceByCharacter: {},
    manual: {}
  });
  assert.strictEqual(verdict.protected, true);
  assert.ok(verdict.reasons.includes('dynamic_archive'));
});

// --- 16. stillValidForWrite re-check -------------------------------------

test('stillValidForWrite: archive appears => false', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const before = ArchiveProtection.stillValidForWrite(
    { name: '角色甲' },
    { store, influenceByCharacter: {}, manual: {} }
  );
  assert.strictEqual(before, true);
  addDynamicEvent(store, 'c1', '异步新增');
  const after = ArchiveProtection.stillValidForWrite(
    { name: '角色甲' },
    { store, influenceByCharacter: {}, manual: {} }
  );
  assert.strictEqual(after, false);
});

test('stillValidForWrite: manual lock appears => false', () => {
  const store = makeStore();
  seedCharacter(store, 'c1', '角色甲');
  addForm(store, 'c1', 'f1', { independent: false });
  const after = ArchiveProtection.stillValidForWrite(
    { name: '角色甲' },
    { store, influenceByCharacter: {}, manual: { '角色甲': { locked: true } } }
  );
  assert.strictEqual(after, false);
});

// --- 17. plugin.autoToggleForSegment legacy path (no chapter) ------------

test('plugin.autoToggleForSegment: no chapter, protected character not switched', () => {
  const Plugin = require(path.join(CORE, 'plugin.js'));
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const store = plugin.loadSidecar(chatId);
  Sidecar.markIndependentEntry(store, 'frostnova', FROST_BASE);
  plugin.host.writeSidecar(chatId, store);
  const res = plugin.autoToggleForSegment(chatId, {
    speakers: ['霜星'],
    catalog: makeFrostCatalog(),
    influenceByCharacter: {}
  });
  assert.ok(res);
  assert.ok(res.protected && res.protected.length >= 1);
  assert.ok(res.protected.some(p => p.name === '霜星'));
  const banners = plugin.banners.get(chatId);
  assert.ok(banners && banners.some(b => b.kind === 'archive_protected'));
});

// --- 18. plugin.autoToggleForSegment adapted chapter (雪原线) -------------

test('plugin.autoToggleForSegment: 雪原线, independent entry protected', () => {
  const Plugin = require(path.join(CORE, 'plugin.js'));
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const store = plugin.loadSidecar(chatId);
  Sidecar.markIndependentEntry(store, 'frostnova', FROST_BASE);
  plugin.host.writeSidecar(chatId, store);
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '雪原线',
    speakers: ['霜星'],
    influenceByCharacter: { '霜星': 'clear' }
  });
  assert.ok(res);
  assert.ok(res.chapter_switch, 'expected chapter switch plan');
  assert.ok(res.chapter_switch.protected.some(p => p.name === '霜星'));
  // 当前形态仍为本格，不被切到雪原主键。
  const after = plugin.loadSidecar(chatId);
  const rec = after.characters['frostnova'];
  const current = rec && rec.forms && rec.forms[rec.selection.primary] && rec.forms[rec.selection.primary].comment_pk;
  assert.strictEqual(current, FROST_BASE);
});

// --- 19. plugin.autoToggleForSegment adapted chapter, missing influence --

test('plugin.autoToggleForSegment: 雪原线, missing influence still protected', () => {
  const Plugin = require(path.join(CORE, 'plugin.js'));
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const store = plugin.loadSidecar(chatId);
  Sidecar.markIndependentEntry(store, 'frostnova', FROST_BASE);
  plugin.host.writeSidecar(chatId, store);
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '雪原线',
    speakers: ['霜星'],
    influenceByCharacter: {}
  });
  assert.ok(res);
  assert.ok(res.chapter_switch, 'expected chapter switch plan');
  assert.ok(res.chapter_switch.protected.some(p => p.name === '霜星'));
  const after = plugin.loadSidecar(chatId);
  const rec = after.characters['frostnova'];
  const current = rec && rec.forms && rec.forms[rec.selection.primary] && rec.forms[rec.selection.primary].comment_pk;
  assert.strictEqual(current, FROST_BASE);
});

// --- 20. plugin exposes archiveProtection --------------------------------

test('plugin exposes archiveProtection', () => {
  const Plugin = require(path.join(CORE, 'plugin.js'));
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  assert.ok(plugin.archiveProtection);
  assert.strictEqual(typeof plugin.archiveProtection.evaluateProtection, 'function');
  assert.strictEqual(typeof plugin.archiveProtection.stillValidForWrite, 'function');
});

// --- summary -------------------------------------------------------------

function makeAsterHost(chatId) {
  const id = chatId || 'chat-aster';
  const host = Plugin.createMemoryHost({
    chatId: id,
    baseName: 'aster-base',
    baseEntries: [
      { comment: FROST_BASE, content: '霜星本格内容' },
      { comment: FROST_SNOW, content: '霜星雪原内容' }
    ]
  });
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  plugin.enableCloneMode(id);
  plugin.upsertCharacterForm(id, { character_id: 'frostnova', canonical_name: '霜星' }, {
    form_id: FROST_BASE, comment_pk: FROST_BASE, content: '霜星本格内容'
  });
  const store = plugin.loadSidecar(id);
  Sidecar.markIndependentEntry(store, 'frostnova', FROST_BASE);
  const rec = store.characters.frostnova;
  rec.dynamic = rec.dynamic || {};
  rec.dynamic['经历'] = '初始经历';
  rec.dynamic['人际关系'] = '初始关系';
  rec.dynamic['特点'] = '初始特点';
  rec.dynamic['备注'] = '初始备注';
  host.writeSidecar(id, store);
  return { host, plugin, chatId: id };
}

function summaryText(obj) {
  return 'visible text\n<!--ARK_ARCHIVE_SUMMARY\n' + JSON.stringify(obj) + '\n-->\n';
}

function llmCalls(plugin) {
  return (plugin.metrics && plugin.metrics.llm_calls) || 0;
}

test('testNoChangeOnlyUpdatesPosition', function () {
  const { host, plugin } = makeAsterHost('chat-a');
  const before = llmCalls(plugin);
  const r = plugin.onVisibleGenerationComplete('chat-a', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: true }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  assert(r && r.ok, 'no_change ok');
  const store = plugin.loadSidecar('chat-a');
  const pos = Sidecar.getProcessedPosition(store, '__global__');
  assert(pos && pos.messageId === 'm1', 'position updated');
  assert(llmCalls(plugin) === before, 'no llm_calls increase');
});

test('testSuccessIncrement', function () {
  const { plugin } = makeAsterHost('chat-b');
  const r = plugin.onVisibleGenerationComplete('chat-b', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: '拒绝了原计划', 人际关系: '与博士关系变化' } }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  assert(r && r.ok && r.changed >= 1, 'changed');
  const store = plugin.loadSidecar('chat-b');
  const ch = store.characters['frostnova'];
  assert(ch.dynamic['经历'] === '拒绝了原计划', '经历 updated');
  assert(ch.dynamic['人际关系'] === '与博士关系变化', '人际关系 updated');
});

test('testFailureActionNotSuccess', function () {
  const { plugin } = makeAsterHost('chat-c');
  plugin.onVisibleGenerationComplete('chat-c', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'x' }, actions: [{ situation: '关键任务', behavior: '拒绝执行', result: '失败' }] }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  const store = plugin.loadSidecar('chat-c');
  const acts = Sidecar.actionList(store, 'frostnova');
  assert(acts.length === 1, 'one action');
  assert(acts[0].result === '失败', 'result preserved as failure');
});

test('testAbsentNotFabricated', function () {
  const { plugin } = makeAsterHost('chat-d');
  plugin.onVisibleGenerationComplete('chat-d', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: '仅经历' } }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  const store = plugin.loadSidecar('chat-d');
  const ch = store.characters['frostnova'];
  assert(ch.dynamic['经历'] === '仅经历', '经历 set');
  assert(ch.dynamic['人际关系'] === '初始关系', '人际关系 untouched');
});

test('testMissingSummaryKeepsOldAndGap', function () {
  const { plugin } = makeAsterHost('chat-e');
  const r = plugin.onVisibleGenerationComplete('chat-e', {
    rawText: 'no summary here', messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  assert(r && r.ok === false, 'missing summary not ok');
  const store = plugin.loadSidecar('chat-e');
  const ch = store.characters['frostnova'];
  assert(ch.dynamic['经历'] === '初始经历', 'old preserved');
  assert(store.sync_gaps && store.sync_gaps['__global__'], 'sync gap marked');
});

test('testDuplicateCompletionIdempotent', function () {
  const { plugin } = makeAsterHost('chat-f');
  const payload = {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'dup' }, actions: [{ situation: 's', behavior: 'b', result: 'r' }] }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  };
  plugin.onVisibleGenerationComplete('chat-f', payload);
  plugin.onVisibleGenerationComplete('chat-f', payload);
  const store = plugin.loadSidecar('chat-f');
  const acts = Sidecar.actionList(store, 'frostnova');
  assert(acts.length === 1, 'no duplicate action');
});

test('testNewBranchInvalidatesOld', function () {
  const { plugin } = makeAsterHost('chat-g');
  plugin.onVisibleGenerationComplete('chat-g', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'old' }, actions: [{ situation: 's', behavior: 'b', result: 'r' }] }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  plugin.invalidateArchiveContributions('chat-g', { messageId: 'm1' });
  const store = plugin.loadSidecar('chat-g');
  const acts = Sidecar.actionList(store, 'frostnova');
  assert(acts.length === 0, 'old action voided');
  const all = Sidecar.actionList(store, 'frostnova', { includeVoided: true });
  assert(all.length === 1 && (all[0].voided || all[0].invalidated), 'voided not deleted');
});

test('testRollbackKeepsPriorExperience', function () {
  const { plugin } = makeAsterHost('chat-h');
  plugin.onVisibleGenerationComplete('chat-h', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'before' }, actions: [{ situation: 's', behavior: 'b', result: 'r' }] }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  plugin.invalidateArchiveContributions('chat-h', { afterSnapshotId: 'snap-x' });
  const store = plugin.loadSidecar('chat-h');
  const ch = store.characters['frostnova'];
  assert(ch.dynamic['经历'] === 'before', 'prior experience kept');
});

test('testCrossChatIsolation', function () {
  const { plugin } = makeAsterHost('chat-i');
  plugin.onVisibleGenerationComplete('chat-i', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'chat-i' } }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'visible'
  });
  const other = plugin.loadSidecar('chat-j');
  const ch = other.characters && other.characters['frostnova'];
  assert(!ch || ch.dynamic['经历'] !== 'chat-i', 'cross chat not written');
});

test('testAttachPromptContainsSummary', function () {
  const { plugin } = makeAsterHost('chat-k');
  const out = plugin.attachArchiveSummaryPrompt('chat-k', { prompt: 'base prompt' });
  assert(typeof out.prompt === 'string' && out.prompt.indexOf('存档摘要区') >= 0, 'summary block present');
  assert(out.prompt.indexOf('ARK_ARCHIVE_SUMMARY') >= 0, 'machine contract present');
});

test('testInternalSourceSkipped', function () {
  const { plugin } = makeAsterHost('chat-l');
  const before = llmCalls(plugin);
  const r = plugin.onVisibleGenerationComplete('chat-l', {
    rawText: summaryText({ characters: [{ character_id: 'frostnova', no_change: false, sections: { 经历: 'internal' } }] }),
    messageId: 'm1', branchId: 'b1', swipeId: 0, source: 'internal'
  });
  assert(r && r.skipped, 'internal skipped');
  const store = plugin.loadSidecar('chat-l');
  const ch = store.characters && store.characters['frostnova'];
  assert(!ch || ch.dynamic['经历'] !== 'internal', 'internal not recorded');
  assert(llmCalls(plugin) === before, 'no llm_calls');
});

test('ingest via setDynamic compiles into clone book', () => {
  const store = Sidecar.emptySidecar();
  Sidecar.ensureCharacter(store, 'c1');
  Sidecar.setDynamic(store, 'c1', { '经历': '拒绝了原计划', '人际关系': '与A决裂', '特点': '更谨慎', '备注': '备注X' });
  const rec = store.characters['c1'];
  assert.strictEqual(rec.dynamic['经历'], '拒绝了原计划');
  const dyn = rec.dynamic[rec.active_timeline || 'main'];
  assert.ok(dyn);
  assert.ok(dyn['经历'] === '拒绝了原计划');
  assert.ok(dyn.non_canon_events && dyn.non_canon_events.length);
  const norm = Compiler.normalizeDynamic(dyn);
  assert.ok(norm.non_canon_events.includes('拒绝了原计划'));
  assert.strictEqual(norm.notes, '备注X');
});

test('legacy top-level chinese keys merge on compile', () => {
  const store = Sidecar.emptySidecar();
  const rec = Sidecar.ensureCharacter(store, 'c1');
  rec.dynamic['经历'] = '旧经历';
  const norm = Compiler.normalizeDynamic(rec.dynamic);
  assert.ok(norm['经历'] === '旧经历');
  assert.ok(norm.non_canon_events && norm.non_canon_events.includes('旧经历'));
});

test('design rejects equivalent event offsetting refusal', () => {
  const req = {
    effective_actions: [{ action_id: 'a1', character_id: 'c1' }],
    archive_version: 5,
    required_characters: ['c1'],
    node_ids: ['n1']
  };
  const design = {
    base_revision: 5,
    character_conclusions: [{
      character_id: 'c1',
      participation: 'absent',
      reason: '拒绝',
      constraints: '不参与',
      action_refs: ['a1'],
      archive_version: 5
    }],
    brief_facts: [{ text: 'c1 用等效事件恢复了原终点' }]
  };
  const out = Plot.validateDesignEdits(req, design);
  assert.strictEqual(out.ok, false);
  assert.ok(out.rejected.length > 0);
});

test('revisePlotDirection does not advance cursor or create floors', async () => {
  const chatId = 'chat-test-1';
  const { plugin, host } = makeAsterHost(chatId);
  const store = plugin.loadSidecar(chatId);
  Sidecar.ensureCharacter(store, 'c1');
  Sidecar.setDynamic(store, 'c1', { '经历': '测试' });
  plugin.host.writeSidecar(chatId, store);
  const req = { call_design: false, settled_facts: [] };
  const before = JSON.stringify(plugin.loadSidecar(chatId));
  const result = await plugin.revisePlotDirection(chatId, req, {});
  assert.ok(result && typeof result === 'object');
  assert.notStrictEqual(result.cursor_advanced, true);
  assert.notStrictEqual(result.floors_created, 1);
  const after = JSON.stringify(plugin.loadSidecar(chatId));
  assert.strictEqual(before, after);
});

test('interface failure keeps protection and excludes conflicts', () => {
  const store = makeStore();
  const catalog = makeFrostCatalog();
  const state = createCharacterBookState({ catalog, store, scope: makeScope() });
  state.setManual('霜星', { locked: true });
  const list = state.listCharacters();
  assert.strictEqual(list.ok, true);
  const row = list.characters.find(c => c.name === '霜星');
  assert.ok(row);
  assert.strictEqual(row.protected, true);
  assert.ok(row.protection_reasons.length > 0);
});

test('listCharacters safe defaults with empty state', () => {
  const emptyCatalog = makeCatalog([]);
  const state = createCharacterBookState({ catalog: emptyCatalog, store: makeStore(), scope: makeScope() });
  const list = state.listCharacters();
  assert.strictEqual(list.ok, true);
  assert.deepStrictEqual(list.characters, []);
  const catalog2 = makeFrostCatalog();
  const state2 = createCharacterBookState({ catalog: catalog2, store: makeStore(), scope: makeScope() });
  const list2 = state2.listCharacters();
  assert.strictEqual(list2.ok, true);
  for (const row of list2.characters) {
    assert.strictEqual(row.sync_gap, null);
    assert.deepStrictEqual(row.candidates, []);
  }
});

console.log('passed: ' + passed + '  failed: ' + failed);
if (failed > 0) {
  process.exit(1);
}
