'use strict';

// Resolve which LLM connection to use for design / summarize / merge.
// Field names are taken from official SillyTavern 1.19.0
// (public/scripts/st-context.js, openai.js, secrets.js, src/endpoints/secrets.js).
// Do not invent new host property names. Never log secret values.

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function pluginOverride(settings) {
  const s = settings || {};
  const url = trim(s.url || s.endpoint);
  const key = trim(s.key || s.api_key || s.apiKey);
  const model = trim(s.model);
  // A leftover default model name alone is not an override.
  // Only a complete plugin connection (URL + key) replaces the tavern generate pipeline.
  if (url && key) {
    return { source: 'plugin_override', url, key, model };
  }
  return null;
}

function tavernModel(context) {
  const ctx = context || {};
  try {
    if (typeof ctx.getChatCompletionModel === 'function') {
      return trim(ctx.getChatCompletionModel());
    }
  } catch (_) {}
  const oai = ctx.chatCompletionSettings;
  if (!oai || typeof oai !== 'object') return '';
  // Live 1.19.0 should prefer getChatCompletionModel(), which switches on
  // chat_completion_source (openai_model, custom_model, deepseek_model, ...).
  // This fallback is only for incomplete test stubs.
  return trim(oai.custom_model || oai.openai_model || '');
}

function tavernGenerateApi(context) {
  const ctx = context || {};
  const generateRaw = typeof ctx.generateRaw === 'function' ? ctx.generateRaw : null;
  const generateRawData = typeof ctx.generateRawData === 'function' ? ctx.generateRawData : null;
  if (!generateRaw && !generateRawData) return null;
  const oai = ctx.chatCompletionSettings || null;
  return {
    source: 'tavern',
    mainApi: ctx.mainApi || null,
    model: tavernModel(ctx),
    generateRaw,
    generateRawData,
    chat_completion_source: oai && oai.chat_completion_source ? oai.chat_completion_source : null
  };
}

function resolveGenerateApi(input) {
  const src = input || {};
  const override = pluginOverride(src.pluginSettings);
  if (override) return override;
  const tavern = tavernGenerateApi(src.context);
  if (tavern) return tavern;
  return { source: 'unavailable', reason: 'missing_tavern_api' };
}

function isUsable(api) {
  if (!api || typeof api !== 'object') return false;
  if (typeof api.generateRaw === 'function' || typeof api.generateRawData === 'function') return true;
  const url = trim(api.url || api.endpoint);
  const key = trim(api.key || api.api_key || api.apiKey);
  return !!(url && key);
}

function safeView(api) {
  if (!api || typeof api !== 'object') return { source: 'unavailable' };
  const view = { source: api.source || (isUsable(api) ? 'plugin_override' : 'unavailable') };
  if (api.model) view.model = String(api.model);
  if (api.mainApi) view.mainApi = String(api.mainApi);
  if (api.chat_completion_source) view.chat_completion_source = String(api.chat_completion_source);
  if (api.reason) view.reason = String(api.reason);
  view.usable = isUsable(api);
  return view;
}

const api = { pluginOverride, tavernGenerateApi, resolveGenerateApi, isUsable, safeView, tavernModel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_TAVERN_API__ = api;
