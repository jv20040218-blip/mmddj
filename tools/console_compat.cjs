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

function createScenarioSwitch(api, groups) {
  return {
    async apply(book, scenario, normalize) {
      const story = api.story();
      if (story?.adapter.getState().active_route) {
        story.adapter.cancelPending();
        const exited = await story.adapter.exitRoute(null);
        if (!exited.ok) throw Error('退出原剧情失败：' + (exited.detail || exited.error));
        const restored = await story.adapter.flushWorldbook();
        if (restored && !restored.ok) throw Error('恢复开局世界书失败：' + restored.error);
      }
      let changes = [], desired;
      await api.write(book, entries => {
        const signature = text => {
          const value = normalize(text).replace(/^\[联动角色\]/, '[角色]');
          const bracket = value.indexOf('('), name = (bracket < 0 ? value : value.slice(0, bracket)).trim();
          const state = bracket >= 0 && name.startsWith('[角色]') ? value.slice(bracket + 1).split(/[,)]/)[0].trim() : '';
          return name + (state && !state.startsWith('与') ? '(' + state : '');
        };
        const resolve = ref => {
          let found = entries.filter(e => normalize(e.name) === normalize(ref));
          if (!found.length) found = entries.filter(e => signature(e.name) === signature(ref));
          if (!found.length) found = entries.filter(e => (e.strategy?.keys || []).some(key => typeof key === 'string' && normalize(key) === normalize(ref)));
          if (found.length !== 1) throw Error('开局条目' + (found.length ? '匹配不唯一：' : '未找到：') + ref);
          return found[0].uid;
        };
        const enable = new Set(scenario.linkedWorldInfo.map(resolve));
        const disable = new Set((scenario.disabledWorldInfo || []).map(resolve));
        for (const uid of disable) enable.delete(uid);
        for (const group of groups) if (group.some(uid => enable.has(uid))) {
          for (const uid of group) if (!enable.has(uid)) disable.add(uid);
        }
        desired = new Map([...disable].map(uid => [uid, false]));
        for (const uid of enable) desired.set(uid, true);
        const present = new Set(entries.map(e => e.uid));
        for (const uid of desired.keys()) if (!present.has(uid)) throw Error('开局形态条目缺失 UID ' + uid);
        changes = [];
        return entries.map(entry => {
          const enabled = desired.has(entry.uid) ? desired.get(entry.uid) : !!entry.enabled;
          if (enabled !== !!entry.enabled) changes.push({ uid: entry.uid, comment: entry.name, from: !!entry.enabled, to: enabled });
          return { ...entry, enabled };
        });
      });
      if (!desired) throw Error('开局世界书更新未执行');
      const actual = new Map((await api.read(book)).map(e => [e.uid, !!e.enabled]));
      for (const [uid, enabled] of desired) if (actual.get(uid) !== enabled) throw Error('开局世界书回读不一致 UID ' + uid);
      return changes;
    }
  };
}

function patchConsole(source, expectedName, groups) {
  let result = source;
  function replaceOnce(from, to) {
    if (result.split(from).length !== 2) throw new Error('Console patch anchor is not unique: ' + from.slice(0, 100));
    result = result.replace(from, to);
  }
  const scenarioStart = result.indexOf('async applyScenario(e,t,o=!1){');
  const scenarioEnd = result.indexOf('},607(e,t,o)', scenarioStart);
  if (scenarioStart < 0 || scenarioEnd < scenarioStart) throw Error('Opening service anchors changed');
  const scenarioMethod = result.slice(scenarioStart, scenarioEnd);
  replaceOnce(scenarioMethod, scenarioMethod.replace(/let t=\[\];if\(await updateWorldbookWith[\s\S]*?(?=document\.dispatchEvent)/,
    'const t=await __ARK_CONSOLE_SCENARIOS__.apply(e,r,n);if('));
  replaceOnce('var t={261(',
    'const __ARK_CONSOLE_SCENARIOS__=(' + createScenarioSwitch.toString() + ')({read:name=>getWorldbook(name),write:(name,update)=>updateWorldbookWith(name,update),story:()=>typeof globalThis.__ARK_STORY_GET__===\'function\'?globalThis.__ARK_STORY_GET__():null},' + JSON.stringify(groups) + ');' +
    'const __ARK_CONSOLE_BOOK__=(' + createConsoleBook.toString() + ')({' +
    "books:()=>getCharWorldbookNames('current')," +
    "characterName:()=>typeof getCurrentCharacterName==='function'?getCurrentCharacterName():''," +
    'readBook:name=>getWorldbook(name)},' + JSON.stringify(expectedName) + ');' +
    "{const s=document.createElement('style');s.id='ark-console-fullscreen-css';s.textContent=" + JSON.stringify(CONSOLE_LAYOUT_CSS) + ';document.head.appendChild(s);}const __ARK_CONSOLE_RENDER__=(' + createConsoleRenderer.toString() + ');var t={261(');

  // The legacy MINI/drag shell must never become the entry or closing state.
  replaceOnce('k=(0,n.ref)(!0),w=(0,n.ref)(c.MINI)', 'k=(0,n.ref)(!1),w=(0,n.ref)(c.FULL)');
  replaceOnce("N=(0,n.ref)('worldbook'),S=(0,n.ref)('interceptor')", "N=(0,n.ref)('misc'),S=(0,n.ref)('lore')");
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

  function replaceSection(start, end, replacement) {
    const from = result.indexOf(start), to = result.indexOf(end, from + start.length);
    if (from < 0 || to < from || result.split(start).length !== 2 || result.split(end).length !== 2) throw Error('Console section anchors changed: ' + start);
    replaceOnce(result.slice(from, to), replacement);
  }
  replaceSection("(0,n.createCommentVNode)(' 界面布局 (UI_LAYOUT) ')", "(0,n.createCommentVNode)(' 视觉表现 (APPEARANCE) ')",
    "(0,n.createElementVNode)('p',{class:'ark-console-layout-note'},'自适应全屏；正文黑体 16px，常规字重；标题按层级放大。'),");
  replaceSection('const d=(0,n.ref)(l.value?.uiWidth??400)', 'y=(0,n.computed)({get:()=>l.value?.theme', 'const ');
  replaceSection("(0,n.createCommentVNode)(' 拦截器开关 ')", "(0,n.createCommentVNode)(' 常驻条目显示 ')",
    "(0,n.createElementVNode)('p',null,'发送与回车使用酒馆原生行为；需要检查条目时请使用世界书中的手动检测。'),");
  replaceSection('v=(0,n.computed)({get:()=>l.value?.isInterceptorEnabled', 'B=(0,n.computed)({get:()=>l.value?.showConstantEntries', '');
  replaceSection("(0,n.createCommentVNode)(' PRE-CHECK ENABLED Toggle ')", "(0,n.createCommentVNode)(' MANUAL SCAN Button ')",
    "(0,n.createElementVNode)('span',null,'原生发送 · 不拦截'),");
  replaceOnce(' 拦截预警控制中心 ', ' 世界书手动检测 ');
  replaceOnce(' 监测所有世界书数据注入请求，以防止危险的内容污染与冗余的数据注入，优化上下文与LLM表现。 ', ' 手动查看当前可能触发的世界书条目，不拦截发送，不调用模型。 ');
  replaceOnce(' 开启后，无论是在被动发送拦截还是主动检测中，都将展示被激活的常驻条目（仅供检查调试）。 ', ' 手动检测时展示被激活的常驻条目，仅供检查调试。 ');
  replaceOnce(' 预检拦截时，同时估算即将发送的 Token。 ', ' 手动检测时估算上下文 Token。 ');
  replaceOnce('如果遇到拦截严重卡顿，请关闭此项。', '估算不调用模型；检测卡顿时可关闭此项。');
  return result;
}

module.exports = { createConsoleBook, patchConsole, CONSOLE_LAYOUT_CSS, createConsoleRenderer };
