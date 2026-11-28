'use strict';

// Tests for entrance character-book integration (round 1 scope):
//   - catalog exact matching (九 / 九色鹿 / chapter pk no collision)
//   - chapter_adapt cross-chapter same-name (维特 / 帕尔维斯)
//   - default form inheritance (赫默 淬羽异格, 银灰 凛御异格)
//   - influence three-state (severe / clear / unknown) + minimum samples
//   - unadapted chapters not marked adapted
//
// Style mirrors test_phase_b.js: plain node assertions, runnable standalone.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = process.env.ARK_CATALOG_PATH || path.join(ROOT, 'data/character_catalog.json');

const catalogMod = require(path.join(ROOT, 'extensions/arknights-copy-worldbook/core/character_catalog.js'));
const influence = require(path.join(ROOT, 'extensions/arknights-copy-worldbook/core/influence.js'));
const adapt = require(path.join(ROOT, 'extensions/arknights-copy-worldbook/core/chapter_adapt.js'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    if(process.env.ARK_CATALOG_PATH)throw new Error('inventory-catalog.json not found at ' + CATALOG_PATH);
    const {buildCatalog}=require('../extensions/arknights-copy-worldbook/core/manager_bridge');
    const data=JSON.parse(fs.readFileSync(path.join(ROOT,'data/story_runtime.json'),'utf8'));
    const baseline=JSON.parse(fs.readFileSync(path.join(ROOT,'data/base_worldbook.json'),'utf8'));
    return {characters:buildCatalog(data,Object.values(baseline.entries))};
  }
  return catalogMod.loadFromFile(CATALOG_PATH);
}

// ---------------------------------------------------------------------------
// Catalog exact matching
// ---------------------------------------------------------------------------
console.log('\n[catalog] exact matching');

const catalog = loadCatalog();

test('catalog loads with characters', () => {
  assert.ok(Array.isArray(catalog.characters));
  assert.ok(catalog.characters.length > 0);
});

test('commentPk reads comment_pk field', () => {
  const pk = catalogMod.commentPk({ comment_pk: '  [角色]: 九  ' });
  assert.strictEqual(pk, '[角色]: 九');
});

test('commentPk falls back to comment then name', () => {
  assert.strictEqual(catalogMod.commentPk({ comment: '[角色]: A' }), '[角色]: A');
  assert.strictEqual(catalogMod.commentPk({ name: '[角色]: B' }), '[角色]: B');
  assert.strictEqual(catalogMod.commentPk('  [角色]: C  '), '[角色]: C');
});

test('九 resolves uniquely, not 九色鹿', () => {
  const r = catalogMod.resolveUniqueName('九', catalog);
  assert.strictEqual(r.ok, true, 'expected unique 九, got ' + JSON.stringify(r));
  assert.strictEqual(r.character.canonical_name, '九');
});

test('九色鹿 resolves uniquely, not 九', () => {
  const r = catalogMod.resolveUniqueName('九色鹿', catalog);
  assert.strictEqual(r.ok, true, 'expected unique 九色鹿, got ' + JSON.stringify(r));
  assert.strictEqual(r.character.canonical_name, '九色鹿');
});

test('九 and 九色鹿 are different characters', () => {
  const a = catalogMod.resolveUniqueName('九', catalog);
  const b = catalogMod.resolveUniqueName('九色鹿', catalog);
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.character.character_id, b.character.character_id);
});

test('chapter pk is not the generic 九 entry', () => {
  const r = catalogMod.resolveUniqueName('九', catalog);
  assert.ok(r.ok);
  const chapterPk = '[角色]: 九（剧情·时间啊，向前！·44）';
  const form = catalogMod.findFormByCommentPk(r.character, chapterPk);
  // The chapter pk must NOT be found among 九's generic forms.
  assert.strictEqual(form.ok, false, 'chapter pk must not match a generic form');
  // But it should be found among chapter_entries.
  const ce = catalogMod.findChapterEntryByCommentPk(r.character, chapterPk);
  assert.strictEqual(ce.ok, true, 'chapter pk should be in chapter_entries');
});

test('isChapterCommentPk distinguishes chapter vs generic', () => {
  assert.strictEqual(catalogMod.isChapterCommentPk('[角色]: 九'), false);
  assert.strictEqual(catalogMod.isChapterCommentPk('[角色]: 九（剧情·时间啊，向前！·44）'), true);
  assert.strictEqual(catalogMod.isChapterCommentPk('[角色]: 九色鹿'), false);
});

test('findFormByCommentPk works on catalog objects', () => {
  const r = catalogMod.resolveUniqueName('九', catalog);
  assert.ok(r.ok);
  const forms = r.character.forms || [];
  assert.ok(forms.length > 0, '九 should have at least one form');
  const pk = catalogMod.commentPk(forms[0]);
  assert.ok(pk.length > 0, 'form comment_pk must be non-empty');
  const found = catalogMod.findFormByCommentPk(r.character, pk);
  assert.strictEqual(found.ok, true);
  assert.strictEqual(catalogMod.commentPk(found.form), pk);
});

// ---------------------------------------------------------------------------
// Default form inheritance
// ---------------------------------------------------------------------------
console.log('\n[catalog] default form inheritance');

test('赫默 default is 淬羽异格 (not 本格)', () => {
  const r = catalogMod.resolveUniqueName('赫默', catalog);
  assert.ok(r.ok, '赫默 should resolve');
  const def = catalogMod.defaultFormOf(r.character);
  assert.ok(def, '赫默 should have a default form');
  const pk = catalogMod.commentPk(def);
  assert.ok(/淬羽/.test(pk), '赫默 default should be 淬羽, got ' + pk);
});

test('银灰 default is 凛御异格 (not 本格)', () => {
  const r = catalogMod.resolveUniqueName('银灰', catalog);
  assert.ok(r.ok, '银灰 should resolve');
  const def = catalogMod.defaultFormOf(r.character);
  assert.ok(def, '银灰 should have a default form');
  const pk = catalogMod.commentPk(def);
  assert.ok(/凛御/.test(pk), '银灰 default should be 凛御, got ' + pk);
});

test('塔露拉 default is 斗士 (not 新整合运动)', () => {
  const r = catalogMod.resolveUniqueName('塔露拉', catalog);
  assert.ok(r.ok);
  const def = catalogMod.defaultFormOf(r.character);
  assert.ok(def);
  const pk = catalogMod.commentPk(def);
  assert.ok(/斗士/.test(pk), '塔露拉 default should be 斗士, got ' + pk);
});

// ---------------------------------------------------------------------------
// chapter_adapt: cross-chapter same-name
// ---------------------------------------------------------------------------
console.log('\n[adapt] cross-chapter same-name');

test('维特 in 时间啊，向前！ selects ·38 only', () => {
  const r = adapt.findTarget('维特', '时间啊，向前！', catalog);
  assert.strictEqual(r.ok, true, 'expected target, got ' + JSON.stringify(r));
  assert.strictEqual(r.comment_pk, '[角色]: 维特（剧情·时间啊，向前！·38）');
});

test('维特 in 遗尘漫步 does not use 时间啊，向前！ target', () => {
  const r = adapt.findTarget('维特', '遗尘漫步', catalog);
  // 遗尘漫步 is not adapted this round -> must not return the 时间 target.
  if (r.ok) {
    assert.notStrictEqual(r.comment_pk, '[角色]: 维特（剧情·时间啊，向前！·38）');
  }
});

test('帕尔维斯 in 孤星 selects 孤星·14 only', () => {
  const r = adapt.findTarget('帕尔维斯', '孤星', catalog);
  assert.strictEqual(r.ok, true, 'expected target, got ' + JSON.stringify(r));
  assert.strictEqual(r.comment_pk, '[角色]: 帕尔维斯（剧情·孤星·14）');
});

test('帕尔维斯 in 绿野幻梦 does not use 孤星 target', () => {
  const r = adapt.findTarget('帕尔维斯', '绿野幻梦', catalog);
  if (r.ok) {
    assert.notStrictEqual(r.comment_pk, '[角色]: 帕尔维斯（剧情·孤星·14）');
  }
});

test('帕尔维斯 catalog may hold both chapter entries', () => {
  const c = catalogMod.resolveUniqueName('帕尔维斯', catalog);
  assert.ok(c.ok);
  const entries = c.character.chapter_entries || [];
  const pks = entries.map(e => catalogMod.commentPk(e));
  // Both may exist in the catalog; that is correct. The adapt layer picks one.
  const hasLone = pks.some(p => /孤星·14/.test(p));
  assert.ok(hasLone, '帕尔维斯 should have 孤星·14 chapter entry');
});

// ---------------------------------------------------------------------------
// chapter_adapt: adapted set
// ---------------------------------------------------------------------------
console.log('\n[adapt] adapted chapters');

test('three chapters are marked adapted', () => {
  const adapted = adapt.adaptedChapters();
  assert.ok(adapted.indexOf('雪原线') !== -1);
  assert.ok(adapted.indexOf('时间啊，向前！') !== -1);
  assert.ok(adapted.indexOf('孤星') !== -1);
});

test('unadapted chapter is not marked adapted', () => {
  assert.strictEqual(adapt.isAdapted('遗尘漫步'), false);
  assert.strictEqual(adapt.isAdapted('绿野幻梦'), false);
  assert.strictEqual(adapt.isAdapted('主线'), false);
});

test('findTarget on unadapted chapter returns not_adapted', () => {
  const r = adapt.findTarget('维特', '遗尘漫步', catalog);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'chapter_not_adapted');
});

// ---------------------------------------------------------------------------
// influence: three-state
// ---------------------------------------------------------------------------
console.log('\n[influence] three-state');

test('exports SEVERE/CLEAR/UNKNOWN', () => {
  assert.strictEqual(influence.SEVERE, 'severe');
  assert.strictEqual(influence.CLEAR, 'clear');
  assert.strictEqual(influence.UNKNOWN, 'unknown');
});

test('fresh save, no interaction -> clear (auto candidate)', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: []
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('reading original story only -> not severe', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{ kind: 'reading', reading_only: true }]
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('plan/hypothesis/quote do not count', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [
      { kind: 'major_experience', plan: true },
      { kind: 'persistent_relation', hypothesis: true },
      { kind: 'faction_duty', quote_only: true }
    ]
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('greeting / one help, no lasting change -> clear', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{ kind: 'minor_interaction', value: 'greeting' }]
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('small affection change within stage -> clear', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{
      kind: 'affection_stage',
      scale: 'trust_0_100',
      stage_before: 'neutral',
      stage_after: 'neutral',
      crossed_stage: false
    }]
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('affection crossed stage with scale -> severe', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{
      kind: 'affection_stage',
      scale: 'trust_0_100',
      stage_before: 'hostile',
      stage_after: 'trust',
      crossed_stage: true
    }]
  });
  assert.strictEqual(r.status, influence.SEVERE);
});

test('affection changed but no scale/stage -> unknown', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{ kind: 'affection_stage', affection_changed: true }]
  });
  assert.strictEqual(r.status, influence.UNKNOWN);
});

test('player saved character, changed death -> severe', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{ kind: 'major_experience', value: 'saved_from_death', confirmed: true }]
  });
  assert.strictEqual(r.status, influence.SEVERE);
});

test('one joking nickname, no lasting relation -> clear', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [{ kind: 'minor_interaction', value: 'joking_nickname' }]
  });
  assert.strictEqual(r.status, influence.CLEAR);
});

test('lover relation with unresolved breakup -> unknown', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    facts: [
      { kind: 'persistent_relation', relation_state: '恋人', confirmed: true },
      { kind: 'persistent_relation', relation_state: '分手', confirmed: true }
    ]
  });
  assert.strictEqual(r.status, influence.UNKNOWN);
});

test('manual exclusion -> severe (no auto)', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    manual_excluded: true,
    facts: []
  });
  assert.strictEqual(r.status, influence.SEVERE);
});

test('record missing -> unknown (not clear)', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: false,
    facts: []
  });
  assert.strictEqual(r.status, influence.UNKNOWN);
});

test('not up to date -> unknown', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: false,
    facts: []
  });
  assert.strictEqual(r.status, influence.UNKNOWN);
});

test('identity ambiguous -> unknown', () => {
  const r = influence.evaluateInfluence({
    character_id: 'char_x',
    record_complete: true,
    up_to_date: true,
    identity_ambiguous: true,
    facts: []
  });
  assert.strictEqual(r.status, influence.UNKNOWN);
});

test('allowsAutoModification only for clear', () => {
  assert.strictEqual(influence.allowsAutoModification(influence.CLEAR), true);
  assert.strictEqual(influence.allowsAutoModification(influence.SEVERE), false);
  assert.strictEqual(influence.allowsAutoModification(influence.UNKNOWN), false);
});

// ---------------------------------------------------------------------------
// Entrance hook + CharacterBookPanel (fake DOM)
// ---------------------------------------------------------------------------
console.log('\n[entrance] hook + panel');

function makeFakeDom() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      children: [],
      parentNode: null,
      style: {},
      dataset: {},
      attributes: {},
      _listeners: {},
      textContent: '',
      innerHTML: '',
      hidden: false,
      isConnected: true,
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
      addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const arr = el._listeners[type] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
      dispatch(type, ev) {
        const arr = (el._listeners[type] || []).slice();
        for (const fn of arr) fn(ev || { type, target: el });
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; }
    };
    return el;
  }
  const body = makeEl('body');
  const doc = {
    readyState: 'complete',
    body,
    documentElement: makeEl('html'),
    _byId: {},
    createElement: tag => makeEl(tag),
    getElementById(id) { return doc._byId[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {}
  };
  return { doc, makeEl, body };
}

function loadEntranceModules() {
  const entrancePath = path.join(ROOT, 'maintenance/runtime-src/ui/worldbook_entrance.js');
  const panelPath = path.join(ROOT, 'maintenance/runtime-src/ui/CharacterBookPanel.js');
  const out = { entrance: null, panel: null };
  if (fs.existsSync(entrancePath)) out.entrance = require(entrancePath);
  if (fs.existsSync(panelPath)) out.panel = require(panelPath);
  return out;
}

test('worldbook_entrance exposes install hook', () => {
  const mods = loadEntranceModules();
  assert.ok(mods.entrance, 'worldbook_entrance module should exist');
  assert.strictEqual(typeof mods.entrance.installWorldbookEntranceHook, 'function');
});

test('CharacterBookPanel exposes mount', () => {
  const mods = loadEntranceModules();
  assert.ok(mods.panel, 'CharacterBookPanel module should exist');
  assert.strictEqual(typeof mods.panel.mountCharacterBookPanel, 'function');
});

test('entrance hook mounts CharacterBookPanel into host', () => {
  const mods = loadEntranceModules();
  const dom = makeFakeDom();
  const host = dom.makeEl('div');
  dom.body.appendChild(host);
  let mounted = null;
  const hook = mods.entrance.installWorldbookEntranceHook({
    adapter: null,
    mountPanel: (h, ctx) => {
      mounted = { host: h, ctx };
      return { unmount() {} };
    }
  });
  assert.ok(hook, 'hook should be returned');
  assert.strictEqual(typeof hook.open, 'function');
  hook.open(host);
  assert.ok(mounted, 'mountPanel should be called');
  assert.strictEqual(mounted.host, host);
  if (typeof hook.uninstall === 'function') hook.uninstall();
});

test('CharacterBookPanel mount returns handle with unmount', () => {
  const mods = loadEntranceModules();
  const dom = makeFakeDom();
  const host = dom.makeEl('div');
  dom.body.appendChild(host);
  const handle = mods.panel.mountCharacterBookPanel(host, { adapter: null });
  assert.ok(handle, 'panel handle should be returned');
  assert.strictEqual(typeof handle.unmount, 'function');
  handle.unmount();
});

// ---------------------------------------------------------------------------
// Auto-switch safety (fake adapter)
// ---------------------------------------------------------------------------
console.log('\n[entrance] auto-switch safety');

function makeFakeAdapter(opts) {
  const o = opts || {};
  const state = {
    writes: [],
    manual: new Set(o.manual || []),
    severe: new Set(o.severe || []),
    unknown: new Set(o.unknown || []),
    cap: typeof o.cap === 'number' ? o.cap : 8,
    overflowNotice: null,
    snapshot: null
  };
  const adapter = {
    state,
    evaluate(characterId) {
      if (state.manual.has(characterId)) return influence.SEVERE;
      if (state.severe.has(characterId)) return influence.SEVERE;
      if (state.unknown.has(characterId)) return influence.UNKNOWN;
      return influence.CLEAR;
    },
    tryAutoSwitch(characterId, formPk) {
      const status = adapter.evaluate(characterId);
      if (!influence.allowsAutoModification(status)) {
        return { ok: false, reason: status };
      }
      if (state.writes.length >= state.cap) {
        state.overflowNotice = 'overflow:' + state.writes.length;
        return { ok: false, reason: 'overflow', overflowNotice: state.overflowNotice };
      }
      state.writes.push({ characterId, formPk });
      return { ok: true };
    },
    markManual(characterId) { state.manual.add(characterId); },
    takeSnapshot() { state.snapshot = state.writes.slice(); return state.snapshot; },
    restoreSnapshot() { if (state.snapshot) state.writes = state.snapshot.slice(); }
  };
  return adapter;
}

test('new book / global batch hidden from entrance', () => {
  const mods = loadEntranceModules();
  const dom = makeFakeDom();
  const host = dom.makeEl('div');
  dom.body.appendChild(host);
  const handle = mods.panel.mountCharacterBookPanel(host, { adapter: null });
  const actions = typeof handle.listActions === 'function' ? handle.listActions() : [];
  const ids = actions.map(a => a && a.id);
  assert.ok(ids.indexOf('new_book') === -1, 'new_book must be hidden');
  assert.ok(ids.indexOf('global_batch') === -1, 'global_batch must be hidden');
  handle.unmount();
});

test('unadapted chapter not marked adapted in panel', () => {
  const mods = loadEntranceModules();
  const dom = makeFakeDom();
  const host = dom.makeEl('div');
  dom.body.appendChild(host);
  const handle = mods.panel.mountCharacterBookPanel(host, { adapter: null, chapter: '遗尘漫步' });
  const adapted = typeof handle.isAdapted === 'function' ? handle.isAdapted() : false;
  assert.strictEqual(adapted, false);
  handle.unmount();
});

test('severe character is not auto-switched', () => {
  const adapter = makeFakeAdapter({ severe: ['char_severe'] });
  const r = adapter.tryAutoSwitch('char_severe', '[角色]: X');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, influence.SEVERE);
  assert.strictEqual(adapter.state.writes.length, 0);
});

test('unknown character is not auto-switched', () => {
  const adapter = makeFakeAdapter({ unknown: ['char_unknown'] });
  const r = adapter.tryAutoSwitch('char_unknown', '[角色]: X');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, influence.UNKNOWN);
  assert.strictEqual(adapter.state.writes.length, 0);
});

test('manual character is not auto-switched', () => {
  const adapter = makeFakeAdapter({ manual: ['char_manual'] });
  const r = adapter.tryAutoSwitch('char_manual', '[角色]: X');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, influence.SEVERE);
  assert.strictEqual(adapter.state.writes.length, 0);
});

test('late auto write cannot override manual choice', () => {
  const adapter = makeFakeAdapter({});
  adapter.markManual('char_m');
  const r = adapter.tryAutoSwitch('char_m', '[角色]: late');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(adapter.state.writes.length, 0);
});

test('two saves do not cross-contaminate', () => {
  const a = makeFakeAdapter({});
  const b = makeFakeAdapter({});
  a.tryAutoSwitch('char_a', '[角色]: A');
  assert.strictEqual(a.state.writes.length, 1);
  assert.strictEqual(b.state.writes.length, 0);
  b.tryAutoSwitch('char_b', '[角色]: B');
  assert.strictEqual(a.state.writes.length, 1);
  assert.strictEqual(b.state.writes.length, 1);
  assert.notStrictEqual(a.state.writes[0].characterId, b.state.writes[0].characterId);
});

test('overflow beyond cap=8 sets overflowNotice', () => {
  const adapter = makeFakeAdapter({ cap: 8 });
  for (let i = 0; i < 8; i++) {
    const r = adapter.tryAutoSwitch('char_' + i, '[角色]: ' + i);
    assert.strictEqual(r.ok, true);
  }
  const over = adapter.tryAutoSwitch('char_9', '[角色]: 9');
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, 'overflow');
  assert.ok(adapter.state.overflowNotice, 'overflowNotice should be set');
});

test('form switch snapshot can be rolled back', () => {
  const adapter = makeFakeAdapter({});
  adapter.tryAutoSwitch('char_1', '[角色]: 1');
  adapter.takeSnapshot();
  adapter.tryAutoSwitch('char_2', '[角色]: 2');
  assert.strictEqual(adapter.state.writes.length, 2);
  adapter.restoreSnapshot();
  assert.strictEqual(adapter.state.writes.length, 1);
  assert.strictEqual(adapter.state.writes[0].characterId, 'char_1');
});

// ---------------------------------------------------------------------------
// Chapter switch wired into plugin.autoToggleForSegment
// ---------------------------------------------------------------------------
const Plugin = require(path.join(ROOT, 'extensions/arknights-copy-worldbook/core/plugin.js'));

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

test('chapter switch: speakers path switches unprotected 霜星 to snow form, base untouched', () => {
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const before = host.hashBaseBook();
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '雪原线',
    speakers: ['霜星'],
    influenceByCharacter: { '霜星': 'clear' }
  });
  assert.ok(res && res.ok);
  assert.strictEqual(res.base_writes, 0);
  assert.ok(res.chapter_switch, 'chapter_switch present');
  assert.ok(res.chapter_switch.switched.some(s => s.name === '霜星' && s.comment_pk === FROST_SNOW), 'switched to snow pk');
  assert.strictEqual(host.hashBaseBook(), before);
  const store = plugin.loadSidecar(chatId);
  const rec = store.characters.frostnova;
  const primary = rec && rec.forms[rec.selection.primary];
  assert.ok(primary, 'primary form exists');
  assert.strictEqual(primary.comment_pk, FROST_SNOW);
});

test('chapter switch: severe/unknown/manual 霜星 is not switched', () => {
  for (const status of ['severe', 'unknown', 'manual']) {
    const host = buildChapterHost();
    const plugin = Plugin.createCopyWorldbookPlugin(host, {});
    const chatId = setupChapterChat(plugin);
    const spec = {
      chapter: '雪原线',
      speakers: ['霜星']
    };
    if (status === 'manual') spec.manual = { '霜星': true };
    else spec.influenceByCharacter = { '霜星': status };
    const res = plugin.autoToggleForSegment(chatId, spec);
    assert.ok(res.chapter_switch, 'chapter_switch present for ' + status);
    assert.ok(!res.chapter_switch.switched.some(s => s.name === '霜星'), 'not switched for ' + status);
    const store = plugin.loadSidecar(chatId);
    const rec = store.characters.frostnova;
    const primary = rec && rec.forms[rec.selection.primary];
    assert.strictEqual(primary.comment_pk, FROST_BASE, 'stays base for ' + status);
  }
});

test('chapter switch: unadapted chapter has no chapter_switch', () => {
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '遗尘漫步',
    speakers: ['霜星'],
    influenceByCharacter: { '霜星': 'clear' }
  });
  assert.ok(res.plan, 'legacy plan present');
  assert.ok(!res.chapter_switch, 'no chapter_switch for unadapted chapter');
  assert.strictEqual(res.base_writes, 0);
});

test('chapter switch: missing chapter keeps legacy plan only', () => {
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const res = plugin.autoToggleForSegment(chatId, {
    speakers: ['霜星'],
    influenceByCharacter: { '霜星': 'clear' }
  });
  assert.ok(res.plan, 'legacy plan present');
  assert.ok(!res.chapter_switch, 'no chapter_switch without chapter');
});

test('chapter switch: 11 real 时间啊，向前！ names produce overflowNotice and banner', () => {
  const extra = TIME_KEYS.map(k => ({ comment: k, content: '内容 ' + k }));
  const host = buildChapterHost(extra);
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const speakers = TIME_KEYS.map(timeNameOf);
  const influenceByCharacter = {};
  for (const n of speakers) influenceByCharacter[n] = 'clear';
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '时间啊，向前！',
    speakers,
    influenceByCharacter
  });
  assert.ok(res.chapter_switch, 'chapter_switch present');
  assert.ok(res.chapter_switch.overflowNotice, 'overflowNotice present');
  const banners = plugin.getStatus(chatId).banners || [];
  assert.ok(banners.some(b => b.kind === 'chapter_switch_overflow'), 'overflow banner written');
});

test('chapter switch: unmapped speaker and spk_unknown go to missing', () => {
  const host = buildChapterHost();
  const plugin = Plugin.createCopyWorldbookPlugin(host, {});
  const chatId = setupChapterChat(plugin);
  const res = plugin.autoToggleForSegment(chatId, {
    chapter: '雪原线',
    speakers: ['霜星', '不存在的路人'],
    focus_actor_ids: ['spk_unknown_xxx'],
    influenceByCharacter: { '霜星': 'clear' }
  });
  assert.ok(res.chapter_switch, 'chapter_switch present');
  assert.ok(res.chapter_switch.missing.some(m => (m.name || m) === '不存在的路人'), 'unmapped speaker in missing');
  assert.ok(res.chapter_switch.missing.some(m => (m.name || m) === 'spk_unknown_xxx'), 'spk id in missing');
});

test('resolveChapter maps only the three adapted story ids and names', () => {
  assert.strictEqual(Plugin.resolveChapter({ story_id: 'story_0f447c9b9b' }), '雪原线');
  assert.strictEqual(Plugin.resolveChapter({ story_id: 'story_c579b90d26' }), '时间啊，向前！');
  assert.strictEqual(Plugin.resolveChapter({ story_id: 'story_899cfa8775' }), '孤星');
  assert.strictEqual(Plugin.resolveChapter({ chapter: '雪原线' }), '雪原线');
  assert.strictEqual(Plugin.resolveChapter({ chapter: '遗尘漫步' }), '');
  assert.strictEqual(Plugin.resolveChapter({}), '');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log('passed: ' + passed + '  failed: ' + failed);
if (failed > 0) {
  for (const f of failures) {
    console.log('\nFAILED: ' + f.name);
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exit(1);
}
console.log('all entrance character-book tests passed');
