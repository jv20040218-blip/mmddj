// 挂载入口与单例：bundle加载时自举适配器(监听+状态条)；ToolsTab补丁调用 __ARK_STORY_MOUNT__ 挂剧情页。
// 所有宿主副作用受守卫；无document/无宿主时安全跳过（node测试直接调模块，不自举）。
'use strict';

function pick(requirePath, globalKey) {
  try { if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require(requirePath); } catch (e) {}
  return (typeof globalThis !== 'undefined') ? globalThis[globalKey] : null;
}
const Core = pick('../core', '__ARK_STORY_CORE__');
const Adapter = pick('../adapter', '__ARK_ADAPTER__');
const StoryTab = pick('./StoryTab', '__ARK_UI_STORYTAB__');
const Statusbar = pick('./statusbar', '__ARK_UI_STATUSBAR__');
const Typography = pick('./typography', '__ARK_UI_TYPOGRAPHY__');
const Perf = pick('./perf', '__ARK_UI_PERF__');
const CharacterBookPanel = pick('./CharacterBookPanel', '__ARK_UI_CHARACTERBOOKPANEL__');
const WorldbookEntrance = pick('./worldbook_entrance', '__ARK_UI_WORLDBOOK_ENTRANCE__');
let typography = null;
let entranceHook = null;

const SINGLETON_KEY = '__ARK_STORY_SINGLETON__';
const mounts = new Map();

function getSingleton() {
  if (globalThis[SINGLETON_KEY]) return globalThis[SINGLETON_KEY];
  const raw = globalThis.__ARK_STORY_DATA__;
  if (!raw || !Core) return null;
  const runtime = Core.createRuntime(raw);
  try { (globalThis.__ARK_COPY_WORLDBOOK__ || globalThis.parent?.__ARK_COPY_WORLDBOOK__)?.manager?.setData(raw); } catch (_) {}
  const cfg = globalThis.__ARK_STORY_CONFIG__ || {};
  const adapter = Adapter.createStoryAdapter({ runtime, worldbookName: cfg.worldbook_name || null, strictPhysical: true });
  const singleton = { runtime, adapter, statusbar: null, booted: false };
  globalThis[SINGLETON_KEY] = singleton;
  return singleton;
}

function installEntranceHook(s) {
  if (entranceHook) return entranceHook;
  if (!WorldbookEntrance || typeof WorldbookEntrance.installWorldbookEntranceHook !== 'function') return null;
  if (!CharacterBookPanel || typeof CharacterBookPanel.mountCharacterBookPanel !== 'function') return null;
  try {
    entranceHook = WorldbookEntrance.installWorldbookEntranceHook({
      document: (typeof window !== 'undefined' && window.parent?.document) || document,
      adapter: s ? s.adapter : null,
      mountPanel: function (host, ctx) {
        const plugin = globalThis.__ARK_COPY_WORLDBOOK__ || globalThis.parent?.__ARK_COPY_WORLDBOOK__;
        if (s) plugin?.manager?.setData(s.runtime.data);
        return CharacterBookPanel.mountCharacterBookPanel(host, Object.assign({ adapter: s ? s.adapter : null }, ctx || {}, { state: plugin?.manager }));
      }
    });
  } catch (e) {
    entranceHook = null;
  }
  return entranceHook;
}

function boot() {
  if(!typography && Typography && typeof document!=='undefined') {
    const hostDocument=(typeof window!=='undefined'&&window.parent&&window.parent.document)||document;
    const handles=[Typography.mountTypography(hostDocument)];
    if(hostDocument!==document)handles.push(Typography.mountTypography(document));
    typography={stop(){for(const handle of handles)handle.stop();}};
    if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('pagehide',()=>{typography.stop();typography=null;},{once:true});
  }
  if (Perf && typeof document !== 'undefined') {
    try {
      const hostDocument=(typeof window!=='undefined'&&window.parent&&window.parent.document)||document;
      Perf.installObserverPatch(hostDocument.defaultView || window || globalThis);
      Perf.mountPerfStyles(hostDocument);
      if (hostDocument !== document) {
        Perf.installObserverPatch(document.defaultView || window || globalThis);
        Perf.mountPerfStyles(document);
      }
    } catch (e) {}
  }
  const s = getSingleton();
  if (!s || s.booted) return s;
  s.booted = true;
  try { s.adapter.init(); } catch (e) {}
  if (typeof window !== 'undefined' && window.addEventListener && s.adapter) {
    const flush = () => { try { if (typeof s.adapter.flushWorldbook === 'function') s.adapter.flushWorldbook(); } catch (e) {} };
    window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', () => {
      flush();
      try { entranceHook?.uninstall?.(); entranceHook=null; s.adapter.destroy(); } catch (_) {}
    }, {once:true});
  }
  try {
    if (typeof document !== 'undefined') {
      const hostDocument = (typeof window !== 'undefined' && window.parent && window.parent.document) || document;
      s.statusbar = Statusbar.mountStoryStatusbar({ adapter: s.adapter, document: hostDocument });
    }
  } catch (e) {}
  // 自举成功后安装世界书管理面板入口 hook（仅浏览器/宿主环境）。
  try {
    if (typeof document !== 'undefined') installEntranceHook(s);
  } catch (e) {}
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', () => {
    for (const el of mounts.keys()) unmount(el);
    if (s.statusbar) s.statusbar.unmount();
    if (entranceHook && typeof entranceHook.uninstall === 'function') { try { entranceHook.uninstall(); } catch (e) {} entranceHook = null; }
    s.adapter.destroy();
  }, { once: true });
  return s;
}

function mount(el, ctx) {
  if (!el || typeof document === 'undefined') return null;
  const s = boot();
  if (!s) return null;
  unmount(el);
  const handle = StoryTab.mountStoryTab(el, { adapter: s.adapter, options: (ctx && ctx.options) || {}, onStatusChange: status => { if (s.statusbar) s.statusbar.setStatus(status); } });
  mounts.set(el, handle);
  return handle;
}
function unmount(el) {
  const h = mounts.get(el);
  if (h) { try { h.unmount(); } catch (e) {} mounts.delete(el); }
}
function refresh() {
  const s = globalThis[SINGLETON_KEY];
  if (!s) return;
  for (const h of mounts.values()) { try { h.refresh(); } catch (e) {} }
  if (s.statusbar) { try { s.statusbar.refresh(); } catch (e) {} }
}

globalThis.__ARK_STORY_MOUNT__ = mount;
globalThis.__ARK_STORY_UNMOUNT__ = unmount;
globalThis.__ARK_STORY_REFRESH__ = refresh;
globalThis.__ARK_STORY_BOOT__ = boot;
globalThis.__ARK_STORY_GET__ = getSingleton;
globalThis.__ARK_STORY_RESET_WORLD__ = async name => {
  const singleton = getSingleton();
  if (!singleton) throw Error('剧情数据尚未加载，完整重置暂不可用');
  return singleton.adapter.resetWorldbook(name);
};

// 浏览器/宿主环境自举；node环境（无document）跳过。
try { if (typeof document !== 'undefined' && typeof window !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot()); else boot(); } } catch (e) {}

const api = { getSingleton, boot, mount, unmount, refresh, installEntranceHook };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_UI_BOOTSTRAP__ = api; }

