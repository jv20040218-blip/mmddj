// Thin Phase B bridge: the sparse-copy worldbook plugin lives in
// extensions/arknights-copy-worldbook/. The story runtime only consults
// the installed singleton (or lore_mode already on state) so baseline
// chats keep their existing behaviour when the plugin is absent.
'use strict';

function getPlugin() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  for (const scope of [g, g && g.parent]) {
    try { if (scope && scope.__ARK_COPY_WORLDBOOK__) return scope.__ARK_COPY_WORLDBOOK__; } catch (_) {}
  }
  return null;
}

function loreModeOf(state) {
  return (state && state.lore_mode) || 'baseline';
}

function shouldNoopBaseFlush(state, chatId) {
  if (typeof globalThis !== 'undefined' && globalThis.__ARK_STORY_CONFIG__?.sparse_clone_only) return { noop: true, reason: 'baseline_read_only' };
  const mode = loreModeOf(state);
  if (mode === 'clone' || mode === 'degraded') return { noop: true, reason: mode };
  const plugin = getPlugin();
  if (plugin && typeof plugin.shouldNoopBaseFlush === 'function') {
    try {
      const r = plugin.shouldNoopBaseFlush(chatId || (state && state.chat_id));
      if (r && r.noop) return r;
    } catch (_) {}
  }
  return { noop: false, reason: mode };
}

function filterOutboundPrompt(payload, state, chatId, ctx) {
  const plugin = getPlugin();
  const extra = Object.assign({}, ctx || {});
  if (state && state.plot_direction && state.plot_direction.excluded_entries) {
    extra.excluded = Object.values(state.plot_direction.excluded_entries).concat(extra.excluded || []);
  }
  const hasExclusions = extra.excluded && extra.excluded.length;
  if (!plugin || typeof plugin.filterOutboundPrompt !== 'function') return payload;
  let mode = loreModeOf(state);
  try { mode = plugin.host.readStoryMeta(chatId || state?.chat_id).lore_mode || mode; } catch (_) {}
  if (mode !== 'clone' && !hasExclusions) return payload;
  try {
    const result = plugin.filterOutboundPrompt(payload, chatId || (state && state.chat_id), extra);
    return result && result.payload != null ? result.payload : payload;
  } catch (_) { return payload; }
}

async function revisePlotDirection(chatId, request, api) {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.revisePlotDirection !== 'function') {
    return { ok: false, reason: 'plugin_unavailable', llm_calls: 0, cursor_advanced: false, floors_created: 0, scene_continues: true };
  }
  return plugin.revisePlotDirection(chatId, request, api);
}

function rollbackPlotRevisions(chatId, spec) {
  const plugin = getPlugin();
  if (!plugin || typeof plugin.rollbackPlotRevisions !== 'function') {
    return { ok: false, reason: 'plugin_unavailable', llm_calls: 0, cursor_advanced: false, floors_created: 0 };
  }
  try { return plugin.rollbackPlotRevisions(chatId, spec); }
  catch (e) { return { ok: false, reason: 'plot_rollback_failed', error: e && e.message, llm_calls: 0 }; }
}

function onChatChanged(chatId) {
  const plugin = getPlugin();
  if (plugin && typeof plugin.onChatChanged === 'function') {
    try { return plugin.onChatChanged(chatId); } catch (e) { return { ok: false, error: e && e.message }; }
  }
  return null;
}

function autoToggleForSegment(chatId, spec, state) {
  if (state && loreModeOf(state) !== 'clone') return null;
  const plugin = getPlugin();
  if (!plugin || typeof plugin.autoToggleForSegment !== 'function') return null;
  // Forward state / story_id / chapter so the plugin can decide whether an
  // adapted chapter switch applies. Old callers that pass only (chatId, spec)
  // keep working: state is undefined and the plugin falls back to legacy.
  const merged = Object.assign({}, spec || {});
  if (state) {
    if (merged.state == null) merged.state = state;
    if (merged.story_id == null && state.story_id != null) merged.story_id = state.story_id;
    if (merged.chapter == null && state.chapter != null) merged.chapter = state.chapter;
    if (merged.chapter == null && state.active_route && state.active_route.chapter != null) {
      merged.chapter = state.active_route.chapter;
    }
  }
  try { return plugin.autoToggleForSegment(chatId, merged, state); }
  catch (e) { return { ok: false, error: e && e.message }; }
}

function ensureLoreDefaults(state) {
  if (!state || typeof state !== 'object') return state;
  if (!state.lore_mode) state.lore_mode = 'baseline';
  if (!Object.prototype.hasOwnProperty.call(state, 'clone_book')) state.clone_book = state.book || null;
  if (state.sidecar_rev == null) state.sidecar_rev = 0;
  if (!Object.prototype.hasOwnProperty.call(state, 'clone_warning')) state.clone_warning = null;
  return state;
}

const api = {
  getPlugin, loreModeOf, shouldNoopBaseFlush, filterOutboundPrompt,
  onChatChanged, autoToggleForSegment, ensureLoreDefaults,
  revisePlotDirection, rollbackPlotRevisions
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CORE_PHASE_B__ = api;
