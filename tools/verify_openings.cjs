'use strict';
// Read-only integration check against the actually installed helper reader and exported card.
// node verify_openings.cjs <native-worldbook.json> <card.png> <helper/dist/index.js>
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const [bookPath, cardPath, helperPath] = process.argv.slice(2);
assert.ok(bookPath && cardPath && helperPath, 'Pass native worldbook, PNG card, installed helper JS');
const rawBook = fs.readFileSync(bookPath), book = JSON.parse(rawBook);
assert.ok(book.entries && !Array.isArray(book.entries), 'UID-keyed native worldbook required');
const helper = fs.readFileSync(helperPath, 'utf8');
const mapperAt = helper.indexOf('function RH(e)');
assert.ok(mapperAt >= 0, 'Installed helper reader signature changed; inspect contract before deploying');
const mapperEnd = helper.indexOf('function ', mapperAt + 10);
assert.ok(mapperEnd > mapperAt);
function chain(value) {
  return { set(key, next) { const keys = key.split('.'); let ref = value;
    for (const k of keys.slice(0, -1)) ref = ref[k] ||= {}; ref[keys.at(-1)] = next; return this; },
    merge(other) { Object.assign(value, other); return this; }, value() { return value; } };
}
chain.pick = (value, keys) => Object.fromEntries(keys.filter(k => k in value).map(k => [k, value[k]]));
const mapper = vm.runInNewContext(helper.slice(mapperAt, mapperEnd) + '\nRH;', { _: chain, et: () => undefined, LH: {} });
const originals = Object.values(book.entries);
for (const [uid, e] of Object.entries(book.entries)) {
  assert.ok(Array.isArray(e.key) && Array.isArray(e.keysecondary), 'Missing native keys at ' + e.uid);
  assert.equal(String(e.uid), uid);
  const parsed = mapper(e); assert.ok(parsed.position.type); assert.equal(parsed.content, e.content);
}
const png = fs.readFileSync(cardPath); let card = null;
for (let off = 8; off + 12 <= png.length;) {
  const n = png.readUInt32BE(off), kind = png.toString('ascii', off + 4, off + 8), data = png.subarray(off + 8, off + 8 + n); off += n + 12;
  if (kind === 'tEXt' && data.subarray(0, 5).toString() === 'ccv3\0') card = JSON.parse(Buffer.from(data.subarray(5).toString(), 'base64').toString());
}
assert.ok(card); const script = card.data.extensions.tavern_helper.scripts.find(s => s.name.startsWith('ARK_UI')).content;
const tableAt = script.indexOf('334(e,t,o){'), rest = script.slice(tableAt + 3), tableEnd = rest.search(/},\d+\(e,t,o\)\{/);
assert.ok(tableAt >= 0 && tableEnd > 0);
const tableExports = {}, webpack = { d(target, getters) { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }); } };
vm.runInNewContext('(function' + rest.slice(0, tableEnd + 1) + ')')({}, tableExports, webpack);
const normalizeAt = script.indexOf("const n=e=>{if(!e)return'';"), normalizeEnd = script.indexOf(',l=[', normalizeAt);
assert.ok(normalizeAt >= 0 && normalizeEnd > normalizeAt);
const normalize = vm.runInNewContext('(' + script.slice(normalizeAt + 8, normalizeEnd) + ')');
const at = script.indexOf('async applyScenario(e,t,o=!1){'), end = script.indexOf('},607(e,t,o)', at);
assert.ok(at >= 0 && end > at); const method = script.slice(at, end - 1);
let updates = 0, successes = 0, checked = 0;
const stableBodies = JSON.stringify(originals.map(e => [e.uid, e.content]));
(async () => {
  for (const scenario of tableExports.g) {
    const native = structuredClone(book);
    const service = vm.runInNewContext('({' + method + '})', {
      a: { g: tableExports.g }, n: normalize,
      toastr: { info() {}, success() { successes++; }, error() {} }, console: { info() {}, error() {} },
      document: { dispatchEvent() {} }, CustomEvent: function(type, options) { this.type = type; this.detail = options?.detail; },
      updateWorldbookWith: async (name, updater) => {
        assert.equal(name, book.name);
        const changed = updater(Object.values(native.entries).map(mapper));
        for (const row of changed) native.entries[row.uid].disable = !row.enabled;
        updates++;
      }
    });
    service.getWorldbookStatus = async () => 'original';
    await service.applyScenario(book.name, scenario.swipeId);
    for (const e of Object.values(native.entries)) {
      const matches = key => normalize(e.comment) === normalize(key) || e.key.some(k => typeof k === 'string' && normalize(k) === normalize(key));
      if (scenario.linkedWorldInfo.some(matches)) { assert.equal(e.disable, false, scenario.title + '/' + e.comment); checked++; }
      if ((scenario.disabledWorldInfo || []).some(matches)) { assert.equal(e.disable, true, scenario.title + '/' + e.comment); checked++; }
    }
    assert.equal(JSON.stringify(Object.values(native.entries).map(e => [e.uid, e.content])), stableBodies);
  }
  assert.equal(updates, tableExports.g.length); assert.equal(successes, tableExports.g.length);
  assert.ok(tableExports.g.some(s => s.title.includes('龙门四小只')));
  assert.deepEqual(fs.readFileSync(bookPath), rawBook, 'Verification must not change the live worldbook');
  console.log(JSON.stringify({ entries_read: originals.length, openings_executed: successes, actor_switch_checks: checked,
    live_worldbook_unchanged: true, card_version: card.data.character_version, paid_model_calls: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
