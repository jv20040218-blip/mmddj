'use strict';

// Hook into the original "世界书管理器" (worldbook/lore) entrance.
// The original WorldbookTab is replaced/inlined by the character book panel.
// We do NOT rebuild the Vue shell; we detect the panel DOM and mount our own.

const PANEL_TITLE = '世界书管理面板';
const PANEL_MARK = 'SYS_MODULE // WBOOK_MGR';

function isWorldbookPanel(node) {
  if (!node || node.nodeType !== 1) return false;
  const text = (node.textContent || '');
  if (text.indexOf(PANEL_MARK) >= 0) return true;
  if (text.indexOf(PANEL_TITLE) >= 0) return true;
  return false;
}

function findWorldbookPanel(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const headings = doc.querySelectorAll('h1,h2,h3');
  for (const heading of headings) {
    if ((heading.textContent || '').trim() === PANEL_TITLE) return heading.closest?.('.slim-scroll-container') || heading.parentElement?.parentElement || heading.parentNode;
  }
  const all = doc.querySelectorAll('[data-ark-worldbook-panel]');
  for (const el of all) {
    if (isWorldbookPanel(el)) return el;
  }
  return null;
}

// Remove the original management affordances: new book, global batch,
// manage-other-worldbooks selectors. We keep the container and mount ours.
function narrowOriginalPanel(panel) {
  if (!panel) return { ok: false, reason: 'no_panel' };
  const removed = [];
  const buttons = panel.querySelectorAll('button,a,[role="button"]');
  for (const btn of buttons) {
    const label = (btn.textContent || '').trim();
    if (/新建书本|新建世界书|全局批量|管理全部世界书|管理其他世界书/.test(label)) {
      btn.setAttribute('data-ark-disabled', '1');
      btn.style.display = 'none';
      removed.push(label);
    }
  }
  return { ok: true, removed };
}

// Mount the character book panel directly into `panel`.
// When `direct` is true (explicit target passed to open()), the target node
// itself is handed to mountFn so that mounted.host === target.
function mountCharacterBookPanel(panel, mountFn, ctx, direct) {
  if (!panel) return { ok: false, reason: 'no_panel' };
  if (typeof mountFn !== 'function') return { ok: false, reason: 'no_mount_fn' };
  let host = panel;
  if (!direct) {
    host = panel.querySelector('[data-ark-character-book]');
    if (!host) {
      const doc = panel.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc) return { ok: false, reason: 'no_document' };
      host = doc.createElement('div');
      host.setAttribute('data-ark-character-book', '1');
      panel.appendChild(host);
    }
  }
  const handle = mountFn(host, ctx);
  return { ok: true, host, handle };
}

function installWorldbookEntranceHook(options) {
  const opts = options || {};
  let doc = opts.document || (typeof document !== 'undefined' ? document : null);
  // Accept both `mount` and `mountPanel` for the panel mount callback.
  const mountFn = opts.mount || opts.mountPanel;
  const ctx = opts.ctx || opts.context || { adapter: opts.adapter || null };
  let observer = null;
  let mounted = false;
  let handle = null;
  let host = null;

  function currentDoc() {
    if (!doc) doc = (typeof document !== 'undefined' ? document : null);
    return doc;
  }

  function tryMount() {
    const d = currentDoc();
    if (!d) return false;
    if (mounted && host && host.isConnected === false) { mounted = false; handle = null; host = null; }
    const panel = findWorldbookPanel(d);
    if (!panel) return false;
    narrowOriginalPanel(panel);
    if (!mounted) {
      const r = mountCharacterBookPanel(panel, mountFn, ctx, false);
      if (r.ok && r.handle?.mounted !== false) {
        for (const child of panel.children || []) if (child !== r.host) { child.setAttribute('data-ark-original-hidden', '1'); child.hidden = true; }
        mounted = true;
        handle = r.handle || null;
        host = r.host || null;
      }
      return r.ok;
    }
    return true;
  }

  function open(target) {
    if (target) {
      // Explicit node: mount directly into it, no wrapper child.
      narrowOriginalPanel(target);
      const r = mountCharacterBookPanel(target, mountFn, ctx, true);
      if (r.ok) {
        mounted = true;
        handle = r.handle || null;
        host = r.host || null;
      }
      return r;
    }
    const d = currentDoc();
    const panel = d ? findWorldbookPanel(d) : null;
    if (!panel) return { ok: false, reason: 'no_panel' };
    narrowOriginalPanel(panel);
    const r = mountCharacterBookPanel(panel, mountFn, ctx, false);
    if (r.ok) {
      mounted = true;
      handle = r.handle || null;
      host = r.host || null;
    }
    return r;
  }

  function uninstall() {
    if (observer) { observer.disconnect(); observer = null; }
    if (handle && typeof handle.unmount === 'function') {
      try { handle.unmount(); } catch (err) { /* ignore */ }
    }
    handle = null;
    mounted = false;
  }

  function startObserver() {
    const d = currentDoc();
    if (!d || observer) return;
    if (typeof MutationObserver === 'undefined') return;
    const root = d.body || d.documentElement;
    if (!root) return;
    let queued = false;
    observer = new MutationObserver(() => {
      if (mounted && host?.isConnected !== false) return;
      if (queued) return; queued = true;
      Promise.resolve().then(() => { queued = false; tryMount(); });
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  startObserver();
  tryMount();

  return {
    ok: true,
    tryMount,
    open,
    uninstall,
    disconnect() { if (observer) observer.disconnect(); },
    isMounted() { return mounted; },
    getHandle() { return handle; },
    getHost() { return host; }
  };
}

const api = {
  PANEL_TITLE,
  PANEL_MARK,
  isWorldbookPanel,
  findWorldbookPanel,
  narrowOriginalPanel,
  mountCharacterBookPanel,
  installWorldbookEntranceHook
};

if (typeof globalThis !== 'undefined') {
  globalThis.__ARK_UI_WORLDBOOK_ENTRANCE__ = api;
}

module.exports = api;
