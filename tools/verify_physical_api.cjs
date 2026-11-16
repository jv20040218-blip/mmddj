'use strict';
// Executes the delivered card's actual runtime against a temporary, unbound server book.
// Credentials arrive only on stdin; no player chat is opened and no generation API exists.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const [plugin, cardPath, helperPath] = process.argv.slice(2);
const path = require('node:path');
const auth = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = 'http://127.0.0.1:8000';
const headers = { Authorization: 'Basic ' + Buffer.from(auth.web_user + ':' + auth.web_password).toString('base64') };
let scratch;
async function request(endpoint, body) {
  const response = await fetch(root + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, endpoint + ' HTTP ' + response.status);
  const text = await response.text(); try { return JSON.parse(text); } catch (_) { return text; }
}
function chain(value) { return { set(key, next) { const parts = key.split('.'); let ref = value;
  for (const part of parts.slice(0, -1)) ref = ref[part] ||= {}; ref[parts.at(-1)] = next; return this; },
  merge(other) { Object.assign(value, other); return this; }, value() { return value; } }; }
chain.pick = (value, keys) => Object.fromEntries(keys.filter(k => k in value).map(k => [k, value[k]]));
function readCard(file) {
  const png = fs.readFileSync(file); let card;
  for (let off = 8; off + 12 <= png.length;) {
    const n = png.readUInt32BE(off), kind = png.toString('ascii', off + 4, off + 8), data = png.subarray(off + 8, off + 8 + n); off += n + 12;
    if (kind === 'tEXt' && data.subarray(0, 5).toString() === 'ccv3\0') card = JSON.parse(Buffer.from(data.subarray(5).toString(), 'base64').toString());
  }
  assert.ok(card); return card;
}
(async () => {
  const tokenResponse = await fetch(root + '/csrf-token', { headers }); assert.ok(tokenResponse.ok);
  headers.Cookie = tokenResponse.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  headers['X-CSRF-Token'] = (await tokenResponse.json()).token;
  const baseline = JSON.parse(fs.readFileSync(path.join(plugin, 'data/base_worldbook.json')));
  scratch = baseline.name + ' (test-' + Date.now() + ')';
  const book = { ...baseline, name: scratch };
  await request('/api/worldinfo/edit', { name: scratch, data: book });
  const helper = fs.readFileSync(helperPath, 'utf8'), start = helper.indexOf('function RH(e)'), end = helper.indexOf('function ', start + 10);
  assert.ok(start >= 0 && end > start);
  const mapper = vm.runInNewContext(helper.slice(start, end) + '\nRH;', { _: chain, et: () => undefined, LH: {} });
  let writes = 0, vars = {};
  async function getWorldbook(name) { assert.equal(name, scratch); const native = await request('/api/worldinfo/get', { name }); return Object.values(native.entries).map(mapper); }
  async function updateWorldbookWith(name, update) {
    assert.equal(name, scratch); const native = await request('/api/worldinfo/get', { name });
    const changed = update(Object.values(native.entries).map(mapper));
    for (const entry of changed) {
      const target = native.entries[entry.uid]; target.disable = !entry.enabled;
      target.constant = entry.strategy.type === 'constant'; target.vectorized = entry.strategy.type === 'vectorized';
      target.selective = entry.strategy.type === 'selective';
    }
    await request('/api/worldinfo/edit', { name, data: native }); writes++;
  }
  const card = readCard(cardPath), script = card.data.extensions.tavern_helper.scripts.find(s => s.name.startsWith('ARK_UI')).content;
  const marker = "(async function(){\n'use strict';\nglobalThis.__ARK_STORY_BUILD__=";
  const at = script.indexOf(marker); assert.ok(at >= 0);
  const sandbox = { console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, URL,
    __ARK_STORY_DATA__: JSON.parse(fs.readFileSync(path.join(plugin, 'data/story_runtime.json'))),
    getCurrentChatId: () => 'isolated-server-verification', getCharWorldbookNames: () => ({ primary: scratch, additional: [] }),
    getVariables: () => vars, replaceVariables: value => { vars = value; }, getWorldbook, updateWorldbookWith,
    injectPrompts: () => ({ uninject() {} }), uninjectPrompts() {}, eventOn: () => () => {}, tavern_events: {} };
  sandbox.globalThis = sandbox; vm.createContext(sandbox);
  await vm.runInContext(script.slice(at), sandbox);
  const adapter = sandbox.__ARK_STORY_GET__().adapter;
  await updateWorldbookWith(scratch, entries => entries.map(e => e.uid === 588 ? { ...e, enabled: true } : e.uid === 39 ? { ...e, enabled: false } : e));
  assert.ok(adapter.jumpToScene('story_0f447c9b9b:route:SS', 'scene:story_0f447c9b9b:SS1').ok);
  assert.equal((await adapter.flushWorldbook()).ok, true);
  let actual = await request('/api/worldinfo/get', { name: scratch });
  assert.equal(actual.entries[588].disable, true); assert.equal(actual.entries[39].disable, false);
  await adapter.exitRoute(null); await adapter.flushWorldbook();
  actual = await request('/api/worldinfo/get', { name: scratch });
  assert.equal(actual.entries[588].disable, false); assert.equal(actual.entries[39].disable, true);
  const reset = await adapter.resetWorldbook(scratch); assert.equal(reset.entries, 2049);
  actual = await request('/api/worldinfo/get', { name: scratch });
  for (const e of Object.values(baseline.entries)) {
    const row = actual.entries[e.uid]; assert.equal(row.disable, e.disable); assert.equal(row.constant, e.constant);
  }
  adapter.destroy();
  await request('/api/worldinfo/delete', { name: scratch }); scratch = null;
  console.log(JSON.stringify({ delivered_runtime_executed: true, actual_api_writes: writes, child_to_fighter_verified: true,
    exit_restored_verified: true, full_reset_entries_verified: reset.entries, temporary_book_deleted: true,
    player_chat_modified: false, paid_model_calls: 0 }));
})().catch(async error => {
  if (scratch) { try { await request('/api/worldinfo/delete', { name: scratch }); } catch (_) {} }
  console.error(error.stack); process.exitCode = 1;
});
