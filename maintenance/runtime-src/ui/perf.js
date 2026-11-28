// Phase A0: tablet performance helpers. Pause #chat MutationObservers during
// batch rendering, and disable startup-shell backdrop blur on narrow viewports.
'use strict';

const TABLET_MQ = '(max-width: 1024px)';
const PERF_STYLE_ID = 'ark-story-perf-css';
const PERF_CSS = `
@media ${TABLET_MQ} {
  .ark-startup-container,
  .ark-startup-container *,
  .ark-console-fullscreen,
  .ark-console-fullscreen *,
  [data-v-86b3a0b8],
  .main-container[data-v-86b3a0b8],
  .ark-startup-container.transparent-theme .main-container[data-v-86b3a0b8] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .backdrop-blur-\\[2px\\],
  .backdrop-blur,
  .backdrop-blur-sm,
  .backdrop-blur-md,
  .backdrop-blur-lg,
  .backdrop-blur-xl {
    --tw-backdrop-blur: none !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
`;

function installObserverPatch(root) {
  const g = root || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!g) return getController(g);
  if (g.__ARK_CHAT_OBS__ && g.__ARK_CHAT_OBS__.pause) return g.__ARK_CHAT_OBS__;
  const Native = g.MutationObserver;
  const tracked = [];
  if (typeof Native === 'function' && !Native.__arkPatched) {
    class PatchedMutationObserver extends Native {
      constructor(callback) {
        const rec = { callback, target: null, options: null, desired: false, calls: 0, inst: null };
        super(function (mutations, observer) {
          const ctrl = g.__ARK_CHAT_OBS__;
          if (ctrl && ctrl.paused && isChatTarget(rec.target)) return;
          rec.calls += 1;
          return callback.call(this, mutations, observer);
        });
        rec.inst = this;
        this.__arkRec = rec;
      }
      observe(target, options) {
        const rec = this.__arkRec;
        if (rec) {
          rec.target = target;
          rec.options = options;
          rec.desired = true;
          if (isChatTarget(target) && !tracked.includes(rec)) tracked.push(rec);
        }
        if (g.__ARK_CHAT_OBS__ && g.__ARK_CHAT_OBS__.paused && isChatTarget(target)) return;
        return super.observe(target, options);
      }
      disconnect() {
        const rec = this.__arkRec;
        if (rec) rec.desired = false;
        return super.disconnect();
      }
    }
    PatchedMutationObserver.__arkPatched = true;
    g.MutationObserver = PatchedMutationObserver;
  }
  return attachController(g, tracked);
}

function isChatTarget(target) {
  if (!target || typeof target !== 'object') return false;
  try {
    if (target.id === 'chat') return true;
    if (typeof target.closest === 'function' && target.closest('#chat')) return true;
  } catch (_) {}
  return false;
}

function attachController(g, tracked) {
  const existing = g.__ARK_CHAT_OBS__;
  if (existing && existing.__tracked === tracked) return existing;
  const extra = existing && existing.__extra || [];
  const ctrl = {
    paused: false,
    __tracked: tracked,
    __extra: extra,
    register(observer, target, options) {
      const rec = { inst: observer, target, options, desired: true, calls: 0, callback: null };
      extra.push(rec);
      return rec;
    },
    unregister(observer) {
      for (let i = extra.length - 1; i >= 0; i--) if (extra[i].inst === observer) extra.splice(i, 1);
    },
    calls() {
      return tracked.concat(extra).reduce((n, rec) => n + (rec.calls || 0), 0);
    },
    resetCalls() {
      for (const rec of tracked.concat(extra)) rec.calls = 0;
    },
    trackedCount() {
      return tracked.concat(extra).filter(rec => rec.desired || (rec.inst && rec.target)).length;
    },
    pause() {
      this.paused = true;
      for (const rec of tracked.concat(extra)) {
        try { if (rec.inst && rec.inst.disconnect) rec.inst.disconnect(); } catch (_) {}
        if (rec.desired != null) rec.desired = true;
      }
    },
    resume() {
      this.paused = false;
      const doc = g.document;
      for (const rec of tracked.concat(extra)) {
        try {
          let target = rec.target;
          if (target && target.id === 'chat' && (!target.isConnected || !target.parentNode) && doc) {
            target = doc.getElementById('chat') || target;
            rec.target = target;
          }
          if (target && rec.inst && rec.inst.observe) rec.inst.observe(target, rec.options || { childList: true });
        } catch (_) {}
      }
    }
  };
  g.__ARK_CHAT_OBS__ = ctrl;
  return ctrl;
}

function getController(root) {
  const g = root || (typeof globalThis !== 'undefined' ? globalThis : {});
  return g.__ARK_CHAT_OBS__ || attachController(g, []);
}

function pauseChatObservers(root) { return getController(root).pause(); }
function resumeChatObservers(root) { return getController(root).resume(); }

function withPausedObservers(fn, root) {
  const ctrl = getController(root);
  ctrl.pause();
  try { return fn(); }
  finally { ctrl.resume(); }
}

function mountPerfStyles(doc) {
  if (!doc || !doc.head) return null;
  let style = doc.getElementById(PERF_STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = PERF_STYLE_ID;
    style.textContent = PERF_CSS;
    doc.head.appendChild(style);
  }
  return style;
}

const api = {
  TABLET_MQ, PERF_CSS, installObserverPatch, getController,
  pauseChatObservers, resumeChatObservers, withPausedObservers, mountPerfStyles, isChatTarget
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_UI_PERF__ = api;
