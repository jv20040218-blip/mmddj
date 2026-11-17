'use strict';

const CONSOLE_LAYOUT_CSS = `
#ark-ui-root.ark-console-fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;min-height:0;transform:none!important;z-index:9999!important;overflow:hidden!important;box-sizing:border-box;grid-template-rows:auto minmax(0,1fr) auto;gap:0;background:var(--color-surface,#17232b);color:var(--color-on-surface,#e8f0f4)}
#ark-ui-root.ark-console-fullscreen>.ark-console-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));min-height:48px;border-bottom:1px solid var(--color-outline-variant,#526873);box-sizing:border-box}
#ark-ui-root.ark-console-fullscreen .ark-console-heading{margin:0;font:600 16px/1.4 var(--font-body,system-ui);min-width:0;overflow-wrap:anywhere}
#ark-ui-root.ark-console-fullscreen>.ark-console-main{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain}
#ark-ui-root.ark-console-fullscreen>.ark-console-main>div{flex:1 1 0%;min-height:0;min-width:0;width:100%;max-height:none}
#ark-ui-root.ark-console-fullscreen>.ark-console-footer{min-height:0;border-top:1px solid var(--color-outline-variant,#526873);padding-bottom:env(safe-area-inset-bottom);background:var(--color-surface,#17232b)}
#ark-ui-root.ark-console-fullscreen .ark-console-subnav{position:static;display:flex;justify-content:center;padding:4px 8px}
#ark-ui-root.ark-console-fullscreen .ark-console-footer>nav{position:static!important;width:100%;max-width:none}
#ark-ui-root.ark-console-fullscreen .ark-console-close{position:static!important;flex:0 0 auto;padding:7px 14px!important;min-height:40px;border:1px solid var(--color-outline-variant,#697d87)!important;background:var(--color-surface-container,#20343f)!important;color:inherit!important;cursor:pointer}
#ark-ui-root.ark-console-fullscreen button:focus-visible{outline:2px solid #62cdd2;outline-offset:-2px}
`;

// A single bounded layout replaces both legacy FULL and MINI render branches.
// It does not depend on Tailwind grid/flex utility classes being available.
function createConsoleRenderer(v, ui, panes) {
  const h = v.createElementVNode, component = v.createVNode;
  return function renderConsole() {
    const tab = ui.tab.value, sub = ui.subTab.value;
    let content;
    if (tab === 'dashboard') content = component(panes.Dashboard, { onNavigate: (id, child) => { ui.tab.value = id; ui.subTab.value = child || ''; } });
    else if (tab === 'settings') content = component(panes.Settings);
    else if (tab === 'worldbook') {
      const pane = { interceptor: panes.Interceptor, lore: panes.Lore, history: panes.History }[sub] || panes.Lore;
      content = component(pane, { onClosePanel: ui.closePanel });
    } else content = component(panes.Tools);
    const footer = [];
    if (tab === 'worldbook') footer.push(h('div', { class: 'ark-console-subnav' }, [component(panes.SubNav, { activeSubTab: sub, tabs: ui.subTabs, onChangeSubTab: id => { ui.subTab.value = id; } })]));
    footer.push(component(panes.BottomNav, { activeTab: tab, onChangeTab: id => { ui.tab.value = id; } }));
    const root = h('div', {
      id: 'ark-ui-root', class: 'ark-console-fullscreen ark-global-statusbar-mount-point ' + (ui.theme.value?.theme === 'light' ? 'light-theme' : 'dark-theme'),
      role: 'dialog', 'aria-modal': 'true', 'aria-label': '方舟世界书控制台', ref: ui.root,
      style: { display: 'grid', position: 'fixed', inset: '0', width: '100vw', height: '100dvh', maxHeight: 'none', transform: 'none' }
    }, [
      h('header', { class: 'ark-console-toolbar' }, [h('h2', { class: 'ark-console-heading' }, '方舟世界书控制台'), h('button', { type: 'button', class: 'ark-console-close', 'aria-label': '关闭控制台', onClick: ui.close }, '关闭 ×')]),
      h('main', { class: 'ark-console-main ark-console-content' }, [content]),
      h('footer', { class: 'ark-console-footer' }, footer)
    ]);
    return v.withDirectives(root, [[v.vShow, ui.visible.value]]);
  };
}

// Bridge the original compiled console without editing its source maps or worldbook bodies.
// Resolve on every action: the helper may start before the character's binding is available.
function createConsoleBook(api, expectedName) {
  return {
    async resolve() {
      try {
        const books = await api.books();
        if (books && books.primary) return books.primary;
        if (books && books.additional && books.additional.length) return books.additional[0];
      } catch (_) {}
      // Only this card may use its bundled book as a fallback. Check that it really exists.
      let name = '';
      try { name = await api.characterName(); } catch (_) {}
      if (!String(name || '').includes('明日方舟')) return null;
      try {
        const book = await api.readBook(expectedName);
        if (Array.isArray(book) && book.length) return expectedName;
      } catch (_) {}
      return null;
    }
  };
}

function patchConsole(source, expectedName) {
  let result = source;
  function replaceOnce(from, to) {
    if (result.split(from).length !== 2) throw new Error('Console patch anchor is not unique: ' + from.slice(0, 100));
    result = result.replace(from, to);
  }
  replaceOnce('var t={261(',
    'const __ARK_CONSOLE_BOOK__=(' + createConsoleBook.toString() + ')({' +
    "books:()=>getCharWorldbookNames('current')," +
    "characterName:()=>typeof getCurrentCharacterName==='function'?getCurrentCharacterName():''," +
    'readBook:name=>getWorldbook(name)},' + JSON.stringify(expectedName) + ');' +
    "{const s=document.createElement('style');s.id='ark-console-fullscreen-css';s.textContent=" + JSON.stringify(CONSOLE_LAYOUT_CSS) + ';document.head.appendChild(s);}const __ARK_CONSOLE_RENDER__=(' + createConsoleRenderer.toString() + ');var t={261(');

  // The legacy MINI/drag shell must never become the entry or closing state.
  replaceOnce('k=(0,n.ref)(!0),w=(0,n.ref)(c.MINI)', 'k=(0,n.ref)(!1),w=(0,n.ref)(c.FULL)');
  replaceOnce("N=(0,n.ref)('worldbook'),S=(0,n.ref)('interceptor')", "N=(0,n.ref)('misc'),S=(0,n.ref)('interceptor')");
  replaceOnce('C.value=!1,t.value=c.MINI,V()', 'C.value=!1,t.value=c.FULL,V()');
  replaceOnce('se=()=>{w.value===c.FULL?w.value=c.MINI:w.value===c.MINI&&(w.value=c.FULL),setTimeout(()=>H(),350)}',
    'se=()=>{k.value=!1,w.value=c.FULL}');
  replaceOnce('U=()=>{w.value=c.MINI,setTimeout(()=>H(),350)}', 'U=()=>{k.value=!1,w.value=c.FULL}');
  replaceOnce('pe=()=>{const e=!(T.value?.isSystemEnabled??1);C.i.updateConfig({isSystemEnabled:e}),e&&H()}',
    'pe=()=>{k.value=!k.value,w.value=c.FULL}');
  replaceOnce("document.addEventListener('ark:system-toggle',pe);const t=", "document.addEventListener('ark:system-toggle',pe);const __arkClose=e=>{if(e.key==='Escape')k.value=!1};(window.parent?.document||document).addEventListener('keydown',__arkClose);const t=");
  replaceOnce("document.removeEventListener('ark:system-toggle',pe),t.removeEventListener", "document.removeEventListener('ark:system-toggle',pe),(window.parent?.document||document).removeEventListener('keydown',__arkClose),t.removeEventListener");
  const componentStart = result.indexOf("__name:'GlobalStatusBar'");
  const renderStart = result.indexOf('}),(e,t)=>', componentStart) + 3;
  const renderEnd = result.indexOf('}});r(748);const tl=', renderStart);
  if (componentStart < 0 || renderStart < componentStart || renderEnd < renderStart) throw Error('Global console renderer anchors changed');
  result = result.slice(0, renderStart) + '__ARK_CONSOLE_RENDER__(n,{visible:k,theme:T,tab:N,subTab:S,root:W,close:se,closePanel:()=>{E.value=null},subTabs:D},{Dashboard:je,Interceptor:ar,Lore:Hn,History:io,Settings:$r,Tools:Qr,BottomNav:f,SubNav:V})' + result.slice(renderEnd);

  replaceOnce("const e=await getCharWorldbookNames('current');e.primary?this.targetWorldbook=e.primary:e.additional&&e.additional.length>0&&(this.targetWorldbook=e.additional[0])",
    'this.targetWorldbook=await __ARK_CONSOLE_BOOK__.resolve()');
  replaceOnce("const e=await getCharWorldbookNames('current');return e&&e.primary?this.targetWorldbook=e.primary:e&&e.additional&&e.additional.length>0&&(this.targetWorldbook=e.additional[0]),this.targetWorldbook",
    'return this.targetWorldbook=await __ARK_CONSOLE_BOOK__.resolve()');
  replaceOnce("const e=await getCharWorldbookNames('current');p.value=e.primary||(e.additional&&e.additional.length>0?e.additional[0]:null)",
    'p.value=await __ARK_CONSOLE_BOOK__.resolve()');
  replaceOnce("catch(e){console.error('Failed to load primary worldbook',e)}",
    "catch(e){p.value=null;console.error('Failed to load primary worldbook',e)}");
  replaceOnce("const t=e.detail;t&&t.isSystemEnabled&&(await v(),await f())",
    'const t=e.detail||(0,C.useArkConfig)().value;t&&t.isSystemEnabled&&(await v(),await f())');
  replaceOnce('tavern_events.WORLDINFO_ENTRIES_LOADED,async()=>{for(const e of u.value)',
    'tavern_events.WORLDINFO_ENTRIES_LOADED,async()=>{await v();for(const e of u.value)');

  const oldEvent = "new CustomEvent('ark-config-updated')";
  if (result.split(oldEvent).length !== 3) throw new Error('Expected two config event emitters');
  result = result.split(oldEvent).join("new CustomEvent('ark-config-updated',{detail:{...(0,r.unref)(this.state)}})");

  // Never silently succeed and change the opening swipe when no book was updated.
  replaceOnce('async applyScenario(e,t=!1){const o=this.getTargetWorldbook();o&&await i.Gl.applyScenario(o,e,t)}',
    "async applyScenario(e,t=!1){const o=await __ARK_CONSOLE_BOOK__.resolve();if(!o)throw new Error('当前角色卡的主世界书尚未就绪，请等待角色加载后重试。');await i.Gl.applyScenario(o,e,t)}");
  replaceOnce('async getStatus(){const e=this.getTargetWorldbook();return e?await i.Gl.getWorldbookStatus(e):\'modified\'}',
    'async getStatus(){const e=await __ARK_CONSOLE_BOOK__.resolve();return e?await i.Gl.getWorldbookStatus(e):\'modified\'}');
  replaceOnce('async resetToBaseline(e){const t=e||this.getTargetWorldbook();t&&await i.Gl.resetToBaseline(t)}',
    'async resetToBaseline(e){const t=e||await __ARK_CONSOLE_BOOK__.resolve();if(!t)throw new Error(\'当前角色卡的主世界书尚未就绪。\');await i.Gl.resetToBaseline(t)}');
  replaceOnce('async closeSingleCharEntries(){const e=this.getTargetWorldbook();e&&await i.Gl.closeSingleCharEntries(e)}',
    'async closeSingleCharEntries(){const e=await __ARK_CONSOLE_BOOK__.resolve();if(!e)throw new Error(\'当前角色卡的主世界书尚未就绪。\');await i.Gl.closeSingleCharEntries(e)}');
  replaceOnce("async resetToBaseline(e){console.info('[ARK_EntryService] Resetting Worldbook to Baseline...');try{",
    "async resetToBaseline(e){console.info('[ARK_EntryService] Resetting Worldbook to Baseline...');try{if(typeof globalThis.__ARK_STORY_RESET_WORLD__==='function'){await globalThis.__ARK_STORY_RESET_WORLD__(e);document.dispatchEvent(new CustomEvent('ark:worldbook-data-changed',{detail:{worldbookName:e}}));toastr.success('全部世界书条目已重置，剧情进度已保留');return;}");
  replaceOnce("catch(e){console.error('[ARK_EntryService] Reset failed:',e),toastr.error('世界书重置失败: '+e.message)}",
    "catch(e){throw console.error('[ARK_EntryService] Reset failed:',e),toastr.error('世界书重置失败: '+e.message),e}");
  return result;
}

module.exports = { createConsoleBook, patchConsole, CONSOLE_LAYOUT_CSS, createConsoleRenderer };
