'use strict';

// Native-DOM character book management page (same style as StoryTab).
// Mounted into the original worldbook panel via worldbook_entrance.js.

function el(doc, tag, attrs, children) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
  }
  if (children) {
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
  }
  return node;
}

function createCharacterBookPanel(options) {
  const opts = options || {};
  const state = opts.state;
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  if (!state) throw new Error('CharacterBookPanel requires state');
  if (!doc) throw new Error('CharacterBookPanel requires document');

  let root = null;
  let selected = null;
  let search = '', limit = 40, error = '';
  async function action(fn) {
    try { error = ''; await fn(); if (opts.onChanged) await opts.onChanged(); }
    catch(e) { error = e.message; }
    render();
  }

  function renderHeader() {
    const cur = state.currentSave();
    const scopeKey = cur.ok ? cur.key : '(未绑定)';
    const chapter = cur.ok ? (cur.save.currentChapter || '(无)') : '(无)';
    return el(doc, 'div', { 'data-ark-cb-header': '1' }, [
      el(doc, 'div', { text: '当前卡/存档副本：' + scopeKey }),
      el(doc, 'div', { text: '当前剧情：' + chapter })
    ]);
  }

  function renderList() {
    const list = state.listCharacters();
    const wrap = el(doc, 'div', { 'data-ark-cb-list': '1' });
    if (!list.ok) {
      wrap.appendChild(el(doc, 'div', { text: '无法读取角色列表：' + list.reason }));
      return wrap;
    }
    const filter = el(doc, 'input', { placeholder: '搜索角色', value: search, 'aria-label': '搜索角色' });
    filter.addEventListener('change', () => { search = filter.value; limit = 40; render(); });wrap.appendChild(filter);
    const matches = list.characters.filter(c => !search || c.name.includes(search));
    for (const c of matches.slice(0, limit)) {
      const row = el(doc, 'div', {
        'data-ark-cb-row': c.name,
        style: 'padding:4px;border-bottom:1px solid #333;cursor:pointer'
      }, [
        el(doc, 'span', { text: c.name + '  ' }),
        el(doc, 'span', { text: '[' + (c.current_form || c.default_form || '无') + '] ' }),
        el(doc, 'span', { text: c.manual_locked ? '手动 ' : '自动 ' }),
        el(doc, 'span', { text: '保护:' + c.influence + ' ' }),
        el(doc, 'span', { text: c.pending ? '待处理' : '' })
      ]);
      row.addEventListener('click', () => { selected = c.name; render(); });
      wrap.appendChild(row);
    }
    if(matches.length > limit){const more=el(doc,'button',{text:'显示更多（'+limit+'/'+matches.length+'）'});more.addEventListener('click',()=>{limit+=40;render();});wrap.appendChild(more);}
    return wrap;
  }

  function renderDetail() {
    if (!selected) return el(doc, 'div', { text: '选择角色查看详情' });
    const list = state.listCharacters();
    const c = list.ok ? list.characters.find(x => x.name === selected) : null;
    if (!c) return el(doc, 'div', { text: '角色不存在' });
    const wrap = el(doc, 'div', { 'data-ark-cb-detail': selected });
    wrap.appendChild(el(doc, 'div', { text: '角色：' + c.name }));
    wrap.appendChild(el(doc, 'div', { text: '当前有效资料：' + (c.current_form || '(无)') }));
    wrap.appendChild(el(doc, 'div', { text: '默认资料：' + (c.default_form || '(无)') }));
    wrap.appendChild(el(doc, 'div', { text: '保护状态：' + c.influence }));
    for (const form of c.forms || []) {
      const button = el(doc, 'button', { text: '切换至：' + form.label });
      button.addEventListener('click', () => action(() => state.selectForm(c.name, form.id)));wrap.appendChild(button);
    }

    const toggleManual = el(doc, 'button', { text: c.manual_locked ? '取消手动' : '设为手动' });
    toggleManual.addEventListener('click', () => {
      action(() => state.setManual(c.name, c.manual_locked ? false : { locked: true }));
    });
    wrap.appendChild(toggleManual);

    const snapBtn = el(doc, 'button', { text: '快照' });
    snapBtn.addEventListener('click', () => action(() => state.snapshot('manual:' + c.name)));
    wrap.appendChild(snapBtn);

    const cur = state.currentSave();
    if (cur.ok && cur.save.snapshots.length) {
      const last = cur.save.snapshots[cur.save.snapshots.length - 1];
      const rb = el(doc, 'button', { text: '回退到 ' + last.label });
      rb.addEventListener('click', () => action(() => state.rollback(last.id)));
      wrap.appendChild(rb);
    }
    return wrap;
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    if (error) root.appendChild(el(doc, 'div', { role:'alert', text:'操作未完成：'+error }));
    const cur=state.currentSave();
    if(cur.ok && cur.mode!=='clone' && state.enable){const button=el(doc,'button',{text:'为当前存档启用独立世界书'});button.addEventListener('click',()=>action(()=>state.enable()));root.appendChild(button);}
    root.appendChild(renderHeader());
    root.appendChild(renderList());
    root.appendChild(renderDetail());
  }

  function mount(host) {
    root = host;
    render();
    return { ok: true };
  }

  return { mount, render, getSelected: () => selected };
}

// Mount a character book panel into a host element.
// Returns a handle with unmount() plus a few introspection helpers used by
// the entrance hook and tests. ctx is optional and may carry an adapter,
// a chapter name, etc.
function mountCharacterBookPanel(host, ctx) {
  const context = ctx || {};
  const doc = context.document || (host && host.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);
  if (!host) return { ok: false, reason: 'no_host', unmount() {} };
  if (!doc) return { ok: false, reason: 'no_document', unmount() {} };

  const state = context.state || null;
  let panel = null;
  let mounted = false;

  if (state) {
    try {
      panel = createCharacterBookPanel({ state, document: doc, onChanged: () => {
        const plugin=globalThis.__ARK_COPY_WORLDBOOK__ || globalThis.parent?.__ARK_COPY_WORLDBOOK__;
        if(plugin && context.adapter?.setLorePointer) context.adapter.setLorePointer(plugin.host.readStoryMeta(plugin.host.chatId()));
      } });
      panel.mount(host);
      mounted = true;
    } catch (err) {
      panel = null;
      mounted = false;
    }
  }

  const handle = {
    ok: true,
    host,
    ctx: context,
    mounted,
    panel,
    unmount() {
      if (!mounted) return { ok: true };
      try {
        if (host) host.textContent = '';
      } catch (err) { /* ignore */ }
      mounted = false;
      return { ok: true };
    },
    render() {
      if (panel && typeof panel.render === 'function') panel.render();
    },
    getSelected() {
      return panel && typeof panel.getSelected === 'function' ? panel.getSelected() : null;
    },
    // The entrance must not expose new-book / global-batch actions.
    listActions() {
      return [];
    },
    // Unadapted chapters are never reported as adapted.
    isAdapted() {
      return false;
    }
  };
  return handle;
}

const api = { createCharacterBookPanel, mountCharacterBookPanel };

if (typeof globalThis !== 'undefined') {
  globalThis.__ARK_UI_CHARACTERBOOKPANEL__ = api;
}

module.exports = api;
