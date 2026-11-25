// TavernHelper 4.12.1 宿主边界；不改共享世界书，不触碰模型配置或凭据。
'use strict';

function scopes(root) {
  const result = [];
  const add = value => { if (value && !result.includes(value)) result.push(value); };
  add(root);
  try { add(root.window); } catch (e) {}
  try { add(root.parent); } catch (e) {}
  try { add(root.window && root.window.parent); } catch (e) {}
  return result;
}
function resolveValue(name, root = globalThis) {
  for (const scope of scopes(root)) {
    try { if (scope[name] != null) return scope[name]; } catch (e) {}
    try { if (scope.TavernHelper && scope.TavernHelper[name] != null) return scope.TavernHelper[name]; } catch (e) {}
  }
  return null;
}
function resolveGlobal(name, root = globalThis) {
  for (const scope of scopes(root)) {
    try { if (typeof scope[name] === 'function') return scope[name].bind(scope); } catch (e) {}
    try {
      if (scope.TavernHelper && typeof scope.TavernHelper[name] === 'function') return scope.TavernHelper[name].bind(scope.TavernHelper);
    } catch (e) {}
  }
  return null;
}

function createHost(root = globalThis) {
  const names = ['getVariables', 'replaceVariables', 'getChatMessages', 'getLastMessageId',
    'createChatMessages', 'setChatMessages', 'getWorldbook', 'getCharWorldbookNames',
    'getChatWorldbookName', 'updateWorldbookWith', 'injectPrompts', 'uninjectPrompts', 'generate', 'eventOn',
    'getScriptId', 'getCurrentChatId', 'stopGenerationById'];
  const g = Object.fromEntries(names.map(name => [name, resolveGlobal(name, root)]));
  const tavern_events = resolveValue('tavern_events', root);
  const capabilities = Object.fromEntries(names.map(name => [name, !!g[name]]));
  capabilities.tavern_events = !!tavern_events;
  let injection = null;
  function chatId() {
    try {
      const st = resolveValue('SillyTavern', root);
      const context = st && st.getContext();
      const id = context && context.getCurrentChatId();
      if (id != null && id !== '') return String(id);
      // 存在 ST 上下文但没有打开聊天时，绝不使用另一个过期全局值。
      if (context) return null;
    } catch (e) {}
    try { const id = g.getCurrentChatId && g.getCurrentChatId(); if (id != null && id !== '') return String(id); } catch (e) {}
    return null;
  }
  const matchesChat = id => id != null && id !== '' && String(id) === chatId();
  function liveChatMetadata(id) {
    try {
      const context = resolveValue('SillyTavern', root)?.getContext();
      if (id == null || String(context?.getCurrentChatId()) !== String(id)) return null;
      const metadata = context.chatMetadata;
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
    } catch (_) { return null; }
  }
  function readChatVars(id) {
    if (!matchesChat(id)) return {};
    if (g.getVariables) return g.getVariables({ type: 'chat' }) || {};
    try { return JSON.parse(root.localStorage.getItem('ark_story_state:' + id) || '{}'); } catch (_) { return {}; }
  }
  return {
    g, tavern_events, capabilities, chatId,
    has: name => typeof g[name] === 'function',
    readChatVars,
    readChatVar(id, key) {
      const metadata = g.getVariables ? liveChatMetadata(id) : null;
      return (metadata ? metadata.variables : readChatVars(id))?.[key];
    },
    writeChatVars(id, vars) {
      if (!matchesChat(id)) return false;
      // 仅合并顶层；整个 ark_story_v2 替换，避免深 merge 把已删快照/索引复活。
      if (g.replaceVariables && g.getVariables) {
        try {
          const metadata = liveChatMetadata(id);
          const current = (metadata ? metadata.variables : g.getVariables({ type: 'chat' })) || {};
          if (!matchesChat(id)) return false;
          g.replaceVariables({ ...current, ...vars }, { type: 'chat' });
          return true;
        } catch (e) { return false; }
      }
      if (g.getVariables) return false;
      try { root.localStorage.setItem('ark_story_state:' + id, JSON.stringify(vars)); return true; } catch (e) { return false; }
    },
    scriptId() { try { return g.getScriptId ? g.getScriptId() : 'ark_story'; } catch (e) { return 'ark_story'; } },
    messageById(id) {
      if (!g.getChatMessages || id == null) return null;
      return g.getChatMessages(id, { include_swipes: true })[0] || null;
    },
    recentMessages(n) {
      const count = Math.max(0, Math.floor(Math.abs(Number(n) || 0)));
      if (!g.getChatMessages || !count) return [];
      let last;
      try { last = g.getLastMessageId ? Number(g.getLastMessageId()) : resolveValue('SillyTavern', root)?.getContext()?.chat?.length - 1; } catch (_) {}
      if (Number.isInteger(last)) return last < 0 ? [] : g.getChatMessages(Math.max(0, last - count + 1) + '-' + last, { include_swipes: true });
      return g.getChatMessages('0-{{lastMessageId}}', { include_swipes: true }).slice(-count);
    },
    worldbookName() {
      try { const name = g.getChatWorldbookName && g.getChatWorldbookName('current'); if (name) return name; } catch (e) {}
      try { const books = g.getCharWorldbookNames && g.getCharWorldbookNames('current'); return books && books.primary || null; } catch (e) { return null; }
    },
    charWorldbook(name) { return g.getWorldbook ? g.getWorldbook(name) : null; },
    on(eventName, handler) {
      if (!g.eventOn || !tavern_events || !tavern_events[eventName]) return null;
      return g.eventOn(tavern_events[eventName], handler);
    },
    inject(prompts) {
      if (!g.injectPrompts || !chatId()) return false;
      try { injection = g.injectPrompts(prompts, { once: false }); return true; } catch (e) { return false; }
    },
    uninject(ids) {
      try {
        if (g.uninjectPrompts) { g.uninjectPrompts(ids); injection = null; return true; }
        if (injection && typeof injection.uninject === 'function') { injection.uninject(); injection = null; return true; }
      } catch (e) {}
      return false;
    }
  };
}

const api = { resolveGlobal, createHost };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_ADAPTER_HOST__ = api; }

