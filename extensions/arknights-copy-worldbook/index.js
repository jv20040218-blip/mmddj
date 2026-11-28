// SillyTavern extension entry: management panel + Chat Lore host bridge.
// Core logic lives in core/*.js (Node-testable). This file only talks to the host.
(function (root) {
  'use strict';

  const SETTINGS_KEY = 'arknights_copy_worldbook';

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed_to_load ' + url));
      document.head.appendChild(s);
    });
  }

  function extensionBase() {
    try {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src || '';
        if (src.includes('arknights-copy-worldbook')) return src.replace(/\/[^/]*$/, '/');
      }
    } catch (_) {}
    return '/scripts/extensions/third-party/arknights-copy-worldbook/';
  }

  function getContext() {
    try {
      if (root.SillyTavern && typeof root.SillyTavern.getContext === 'function') return root.SillyTavern.getContext();
    } catch (_) {}
    return root;
  }

  async function start() {
    if (!root.__ARK_COPY_WORLDBOOK_FACTORY__ || !root.__ARK_CWB_NATIVE_HOST__ || !root.__ARK_CWB_MANAGER__) {
      try { await loadScript(extensionBase() + 'core.bundle.js?v=1.9.6-pre4'); } catch (e) { console.warn('[ARK_CWB] bundle load failed', e); return; }
    }
    if (root.__ARK_CWB_PANEL__ == null) {
      try { await loadScript(extensionBase() + 'ui/panel.js'); } catch (_) {}
    }
    const factory = root.__ARK_COPY_WORLDBOOK_FACTORY__;
    if (!factory) return;
    const host = root.__ARK_CWB_NATIVE_HOST__.createNativeHost(root);
    const plugin = factory.createCopyWorldbookPlugin(host);
    plugin.manager = root.__ARK_CWB_MANAGER__.createManager(plugin, host);
    root.__ARK_COPY_WORLDBOOK__ = plugin;
    async function prepareCurrent() {
      const chat = host.chatId(); if (!chat) return;
      await host.prepare(chat); plugin.onChatChanged(chat);
    }
    try {
      const ctx = getContext(), es = ctx.eventSource, types = ctx.eventTypes || ctx.event_types;
      if (es && types && types.CHAT_CHANGED && typeof es.on === 'function') {
        es.on(types.CHAT_CHANGED, () => {
          prepareCurrent().catch(e => console.warn('[ARK_CWB] chat prepare failed', e.message));
        });
      }
    } catch (_) {}
    try { await prepareCurrent(); } catch (e) { console.warn('[ARK_CWB] waiting for a supported chat', e.message); }
    console.info('[ARK_CWB] 稀疏克隆世界书插件已就绪');
    return plugin;
  }

  if (document.readyState === 'loading') root.__ARK_COPY_WORLDBOOK_READY__ = new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(start())));
  else root.__ARK_COPY_WORLDBOOK_READY__ = start();
})(typeof window !== 'undefined' ? window : globalThis);
