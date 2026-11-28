#!/usr/bin/env node
// Design / summarize / merge should default to the tavern's existing generate
// configuration (SillyTavern 1.19.0 getContext().generateRaw). Plugin panel
// url/key are an optional override only. Do not print secret values.
'use strict';

const path = require('path');
const assert = require('assert');
const repo = path.resolve(__dirname, '..');
const TavernApi = require(path.join(repo, 'extensions/arknights-copy-worldbook/core/tavern_api.js'));
const Llm = require(path.join(repo, 'extensions/arknights-copy-worldbook/core/llm_client.js'));
const Plugin = require(path.join(repo, 'extensions/arknights-copy-worldbook/core/plugin.js'));

const OVERRIDE = { url: 'https://example.invalid/v1/chat/completions', model: 'override-model', key: 'test-override-key' };

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ok  ' + name); })
    .catch(err => { failed += 1; console.error('  FAIL ' + name + '\n    ' + (err && err.stack || err)); });
}

function emptyPluginSettings() {
  return { url: '', model: 'deepseek-v4.1-flash-1017', key: '' };
}

function tavernContext(generateRaw, extra) {
  return Object.assign({
    mainApi: 'openai',
    chatCompletionSettings: { chat_completion_source: 'custom', custom_model: 'tavern-custom-model' },
    getChatCompletionModel() { return 'tavern-custom-model'; },
    generateRaw
  }, extra || {});
}

async function run() {
  console.log('Tavern generate API resolution tests');

  await test('empty plugin fields use tavern generateRaw and never require a second key', async () => {
    let calls = 0;
    const generateRaw = async (params) => {
      calls += 1;
      assert.ok(params);
      assert.equal(params.instructOverride, true);
      assert.ok(Array.isArray(params.prompt) || typeof params.prompt === 'string');
      return JSON.stringify({
        chat_id: 'chat_plot',
        route_id: 'route:TEST',
        base_revision: 1,
        brief_facts: ['对峙仍在继续'],
        future_summaries: []
      });
    };
    const resolved = TavernApi.resolveGenerateApi({
      pluginSettings: emptyPluginSettings(),
      context: tavernContext(generateRaw)
    });
    assert.equal(resolved.source, 'tavern');
    assert.equal(resolved.model, 'tavern-custom-model');
    assert.equal(resolved.mainApi, 'openai');
    assert.strictEqual(resolved.key, undefined);
    assert.strictEqual(resolved.api_key, undefined);
    assert.equal(typeof resolved.generateRaw, 'function');
    const view = TavernApi.safeView(resolved);
    assert.equal(view.source, 'tavern');
    assert.equal(view.usable, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(view, 'key'));
    const text = JSON.stringify(view);
    assert.ok(!text.includes(OVERRIDE.key));

    const res = await Llm.designPlot({
      chat_id: 'chat_plot',
      route_id: 'route:TEST',
      base_revision: 1,
      settled_facts: []
    }, resolved, async () => { throw new Error('direct fetch must not run for tavern source'); });
    assert.equal(res.ok, true);
    assert.equal(calls, 1);
    assert.equal(res.revision.brief_facts[0], '对峙仍在继续');
    assert.equal(res.source || resolved.source, 'tavern');
  });

  await test('filled plugin url and key remain an optional override', async () => {
    let generateCalls = 0;
    let fetchCalls = 0;
    const generateRaw = async () => { generateCalls += 1; throw new Error('override must not call generateRaw'); };
    const resolved = TavernApi.resolveGenerateApi({
      pluginSettings: OVERRIDE,
      context: tavernContext(generateRaw)
    });
    assert.equal(resolved.source, 'plugin_override');
    assert.equal(resolved.url, OVERRIDE.url);
    assert.equal(resolved.model, OVERRIDE.model);
    assert.equal(resolved.key, OVERRIDE.key);
    assert.ok(!resolved.generateRaw);

    const res = await Llm.chatCompletions(resolved, [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'ping' }
    ], async (url, init) => {
      fetchCalls += 1;
      assert.equal(url, OVERRIDE.url);
      assert.equal(init.headers.Authorization, 'Bearer ' + OVERRIDE.key);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok-override' } }] }) };
    });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'ok-override');
    assert.equal(fetchCalls, 1);
    assert.equal(generateCalls, 0);
  });

  await test('model-only plugin settings do not override the tavern generate path', () => {
    const resolved = TavernApi.resolveGenerateApi({
      pluginSettings: { url: '', model: 'deepseek-v4.1-flash-1017', key: '' },
      context: tavernContext(async () => 'unused')
    });
    assert.equal(resolved.source, 'tavern');
    assert.equal(typeof resolved.generateRaw, 'function');
  });

  await test('missing tavern config and empty plugin fields are unavailable', async () => {
    const resolved = TavernApi.resolveGenerateApi({
      pluginSettings: emptyPluginSettings(),
      context: { mainApi: null, chatCompletionSettings: {} }
    });
    assert.equal(resolved.source, 'unavailable');
    assert.equal(resolved.reason, 'missing_tavern_api');
    assert.equal(TavernApi.isUsable(resolved), false);

    let fetchCalls = 0;
    const res = await Llm.designPlot({ chat_id: 'c', route_id: 'r', base_revision: 0 }, resolved, async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    });
    assert.equal(res.ok, false);
    assert.ok(res.reason === 'missing_tavern_api' || res.reason === 'missing_api_key' || res.reason === 'missing_api_url');
    assert.equal(fetchCalls, 0);
  });

  await test('summarize and merge use the resolved tavern generateRaw when no plugin override is passed', async () => {
    let calls = 0;
    const generateRaw = async () => {
      calls += 1;
      return JSON.stringify({
        '基本信息': '名：塔露拉',
        '外貌': '',
        '服装': '',
        '武器': '',
        '特点': '现场可见的冷静',
        '源石技艺': '',
        '能力': '',
        '喜欢': '',
        '讨厌': '',
        '经历': '此次掳走未遂',
        '人际关系': '与阿米娅仍在对峙',
        '语言示例': '',
        '秘密': '',
        '备注': ''
      });
    };
    const host = Plugin.createMemoryHost({ baseName: 'base-worldbook', baseEntries: [], chatId: 'chat_plot' });
    host.readDesignApi = () => TavernApi.resolveGenerateApi({
      pluginSettings: emptyPluginSettings(),
      context: tavernContext(generateRaw)
    });
    const plugin = Plugin.createCopyWorldbookPlugin(host, {
      fetch: async () => { throw new Error('summarize must not direct-fetch'); }
    });
    plugin.enableCloneMode('chat_plot');
    plugin.upsertCharacterForm('chat_plot', {
      character_id: 'tallulah', canonical_name: '塔露拉', aliases: ['塔露拉']
    }, {
      form_id: '8', entry_id: 8, source_uid: 8, comment_pk: '[角色]:塔露拉',
      label: '[角色]:塔露拉', keys: ['塔露拉'], content: '# 塔露拉\n - 本名：塔露拉\n'
    });
    const sum = await plugin.summarizeIntoProfile('chat_plot', 'tallulah', { transcript: '对峙' });
    assert.equal(sum.ok, true, sum.reason);
    assert.equal(sum.sections['经历'], '此次掳走未遂');
    assert.equal(calls, 1);
    const merged = await plugin.mergeTimelines('chat_plot', 'tallulah', { from_timeline: 'main', to_timeline: 'main' });
    assert.equal(merged.ok, true, merged.reason);
    assert.equal(calls, 2);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
