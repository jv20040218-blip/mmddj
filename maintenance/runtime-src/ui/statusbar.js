// 本轮状态条：场景时间｜角色线进度｜大地纪事(沿用/新)｜出场人物迷你立绘。
// 可挂到控制台 .ark-global-statusbar-mount-point；由脚本计算，不另发模型请求。绑定当前或指定历史消息快照。
'use strict';

function pick(requirePath, globalKey) {
  try { if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require(requirePath); } catch (e) {}
  return (typeof globalThis !== 'undefined') ? globalThis[globalKey] : null;
}
const ST = pick('./styles', '__ARK_UI_STYLES__');
const Perf = pick('./perf', '__ARK_UI_PERF__');
const el = ST.el, icon = ST.icon, clear = ST.clear;

const STATUS_CSS = `
.ark-story-status{box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 12px;border:1px solid var(--color-outline-variant,#384b57);border-radius:8px;background:var(--color-surface-container-low,#17232b);color:var(--color-on-surface,#dce8ed);font-family:var(--font-body,system-ui,"Microsoft YaHei",sans-serif);font-size:12px;line-height:1.5;}
.ark-story-status *{box-sizing:border-box;}
.ark-story-status .ark-ss-clock{font-weight:600;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:4px;}
.ark-story-status .ark-ss-progress{color:var(--color-on-surface-variant,#adbec8);}
.ark-story-status .ark-ss-news{display:inline-flex;align-items:center;gap:6px;min-width:0;}
.ark-story-status .ark-ss-news .ark-ss-text{overflow-wrap:anywhere;}
.ark-story-status .ark-ss-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--color-outline-variant,#384b57);color:var(--color-on-surface-variant,#adbec8);white-space:nowrap;}
.ark-story-status .ark-ss-cast{display:inline-flex;align-items:center;gap:6px;}
.ark-story-status .ark-ss-face{width:30px;height:30px;border-radius:6px;overflow:hidden;background:var(--color-surface-container-high,#293e49);display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}
.ark-story-status .ark-ss-face img{width:100%;height:100%;object-fit:cover;object-position:top center;}
.ark-story-status .ark-ss-face .material-symbols-outlined{font-size:18px;color:var(--color-on-surface-variant,#aac5d2);}
.ark-story-status .ark-ss-empty{color:var(--color-on-surface-variant,#adbec8);}
.ark-story-status button{font:inherit;color:inherit;background:var(--color-surface-container-high,#293e49);border:1px solid #65818e;border-radius:6px;padding:6px 10px;cursor:pointer;min-height:32px;}
.ark-story-status button:disabled{opacity:.5;cursor:wait;}
.ark-story-status button:focus-visible,.ark-story-status summary:focus-visible{outline:2px solid #62cdd2;outline-offset:2px;}
.ark-story-status .ark-ss-ending p{margin:5px 0;overflow-wrap:anywhere;}
`;

function ensureStatusCss(doc) { if (doc.getElementById('ark-story-status-css')) return; const s = doc.createElement('style'); s.id = 'ark-story-status-css'; s.textContent = STATUS_CSS; doc.head.appendChild(s); }

function faceNode(c) {
  const face = el('span', { class: 'ark-ss-face', title: (c.name || '') + ' · ' + (c.label || '') + (c.period_label ? ' · ' + c.period_label : '') });
  const ph = () => { clear(face); face.appendChild(icon('person')); };
  ST.mountPortrait(face, c, ph);
  return face;
}

// 把状态视图渲染进容器（覆盖原有内容）。
function renderTurnStatusInto(container, status, adapter) {
  const doc = container.ownerDocument || document;
  ensureStatusCss(doc);
  clear(container);
  const bar = el('div', { class: 'ark-story-status', role: 'status', 'aria-label': '本轮剧情状态' });
  if (!status) { bar.appendChild(el('span', { class: 'ark-ss-empty', text: '剧情：未进入角色线' })); container.appendChild(bar); return bar; }
  const sc = status.scene_clock;
  const clockText = sc ? sc.date_label + (sc.time_label && sc.time_label !== '00:00' ? ' ' + sc.time_label : '') : (status.date_display && status.date_display !== '暂无' ? status.date_display : '暂无');
  bar.appendChild(el('span', { class: 'ark-ss-clock' }, [icon('schedule'), (status.context_kind === 'memory' ? '回忆时间：' : '') + clockText]));
  if (status.navigation_label) bar.appendChild(el('span', { class: 'ark-ss-progress', text: status.navigation_label }));
  bar.appendChild(el('span', { class: 'ark-ss-progress', text: (status.route_label || '') + ' · ' + (status.progress_label || '') }));
  const news = el('span', { class: 'ark-ss-news' });
  news.appendChild(el('span', { class: 'ark-ss-text', text: '纪事｜' + (status.event_text || '暂无') }));
  if (status.event_time) news.appendChild(el('span', { class: 'ark-ss-badge', text: status.event_time.date_label }));
  news.appendChild(el('span', { class: 'ark-ss-badge', text: status.event_is_repeated ? '沿用上一条' : '最近事件' }));
  bar.appendChild(news);
  const cast = el('span', { class: 'ark-ss-cast' });
  for (const c of (status.cast || []).slice(0, 6)) cast.appendChild(faceNode(c));
  for (const c of (status.memory_cast || []).slice(0, 3)) cast.appendChild(faceNode(c));
  if ((status.cast || []).length || (status.memory_cast || []).length) bar.appendChild(cast);
  const profiles = (status.cast || []).filter(c => c.profile_label);
  if (profiles.length) {
    const details = el('details', { style: 'flex-basis:100%' });
    details.appendChild(el('summary', { text: '本轮角色档案后缀（' + profiles.length + '）' }));
    for (const c of profiles) details.appendChild(el('div', { text: c.name + '｜状态：' + c.label + '｜资料：' + c.profile_label }));
    bar.appendChild(details);
  }
  if (status.flow) {
    const flow = status.flow;
    const panel = el('div', { class: 'ark-ss-flow', style: 'flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center' });
    panel.appendChild(el('strong', { text: flow.stage === 'finished' ? '本线已结束' : flow.stage === 'ready_to_finish' ? '末段已完成 · 待结算' : flow.segment_label }));
    if (flow.stage === 'playing') panel.appendChild(el('span', { text: flow.next_hint }));
    const error = el('span', { role: 'alert' });
    function action(label, fn) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { const r = await fn(); if (r && r.ok === false) error.textContent = '操作未完成：' + (r.error || r.reason); }
        catch (e) { error.textContent = '操作未完成：' + e.message; }
        finally { b.disabled = false; }
      });
      panel.appendChild(b);
    }
    if (adapter) {
      if (flow.stage === 'playing') action('确认本段完成／推进', () => adapter.advanceCurrentSegment(status.revision));
      if (flow.stage === 'ready_to_finish') action('结算并结束本线', () => adapter.finishExperience({}));
      if (adapter.getState().active_route) action('保存并退出当前线', () => { adapter.cancelPending(); return adapter.exitRoute(null); });
    }
    if (flow.ending) {
      const end = flow.ending;
      const details = el('details', { class: 'ark-ss-ending', style: 'flex-basis:100%' });
      details.appendChild(el('summary', { text: '结束结算｜' + end.label }));
      details.appendChild(el('p', { text: end.summary + ' 完成 ' + end.completed_scenes + ' / ' + end.total_scenes + ' 幕。' }));
      details.appendChild(el('p', { text: '结束节点：' + (end.final_goal || '暂无') }));
      details.appendChild(el('p', { text: end.chapter_complete ? '本篇全部角色线已完成。' : '可在剧情目录选择本篇其他角色线；未体验的路线保持未完成。' }));
      if (end.memory_exited) details.appendChild(el('p', { text: '回忆已结束，已恢复进入前的上下文。' }));
      if (adapter && end.ending_node_id) {
        const fullText = adapter.runtime.corpusFullText(end.ending_node_id);
        if (fullText) {
          const original = el('details');
          original.appendChild(el('summary', { text: '查看本线结尾原文（仅供玩家查看）' }));
          original.appendChild(el('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere', text: typeof fullText === 'string' ? fullText : (fullText.text || fullText.material || '') }));
          if (end.source_locator) original.appendChild(el('p', { text: '来源：' + end.source_locator }));
          details.appendChild(original);
        }
      }
      panel.appendChild(details);
      if (adapter && flow.stage === 'finished' && end.next_entry) action('进入下一篇（不自动生成）', () => {
        const route = adapter.data.routeById[end.next_entry.default_route_id];
        if (!route) return { ok: false, error: 'next_route_missing' };
        return adapter.jumpToScene(route.route_id, route.ordered_scene_ids[0]);
      });
    }
    panel.appendChild(error);
    bar.appendChild(panel);
  }
  container.appendChild(bar);
  return bar;
}

// 尝试挂到控制台全局状态栏挂载点；缺失则返回mounted:false（不伪造）。
function mountStoryStatusbar(ctx) {
  const adapter = ctx.adapter, doc = ctx.document || document;
  let node = null, messageId = null, selectedStatus = null;
  let ownedHost = null;
  // 原控制台会测量自己的容器并计算浮动位置。回复栏必须是 body 下的独立兄弟节点，
  // 不能向同名控制台挂载点追加内容，否则改变尺寸并遮住剧情导航。
  function getHost() {
    if (ctx.mountPoint) return ctx.mountPoint;
    if (!ownedHost || !ownedHost.parentNode) {
      ownedHost = doc.createElement('div');
      ownedHost.className = 'ark-story-reply-status-host';
      ownedHost.setAttribute('style', 'position:fixed;top:var(--topBarBlockSize,40px);bottom:auto;left:0;right:0;z-index:20;max-height:22vh;overflow:auto;');
      doc.body.appendChild(ownedHost);
    }
    return ownedHost;
  }
  function refresh() {
    const host = getHost();
    if (!host) { node = null; return; }
    if (!node || node.parentNode !== host) {
      node = doc.createElement('div'); node.className = 'ark-story-statusbar-slot'; host.appendChild(node);
    }
    const status = selectedStatus || (messageId != null ? adapter.getStatusForMessage(messageId) : adapter.currentStatus());
    renderTurnStatusInto(node, status, messageId == null && (!selectedStatus || selectedStatus.flow) ? adapter : null);
  }
  const unsubscribe = adapter.subscribe(() => { selectedStatus = null; refresh(); });
  const Observer = doc.defaultView && doc.defaultView.MutationObserver;
  let debounce = null;
  const observer = Observer ? new Observer(() => {
    const ctrl = Perf && Perf.getController && Perf.getController(doc.defaultView || globalThis);
    if (ctrl && ctrl.paused) return;
    if (observer.__arkRec) observer.__arkRec.calls = (observer.__arkRec.calls || 0) + 1;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      const host = getHost();
      if (host && (!node || node.parentNode !== host)) refresh();
    }, 150);
    if (debounce && debounce.unref) debounce.unref();
  }) : null;
  const observeTarget = doc.getElementById('chat') || getHost() || doc.body;
  if (observer) {
    observer.observe(observeTarget, { childList: true, subtree: false });
    if (Perf && Perf.getController) Perf.getController(doc.defaultView || globalThis).register(observer, observeTarget, { childList: true, subtree: false });
  }
  refresh();
  return { get mounted() { return !!node; }, get node() { return node; }, refresh,
    setMessage: id => { selectedStatus = null; messageId = id; refresh(); },
    setStatus: status => { selectedStatus = status; messageId = null; refresh(); },
    unmount: () => {
      unsubscribe();
      if (debounce) clearTimeout(debounce);
      if (Perf && Perf.getController) Perf.getController(doc.defaultView || globalThis).unregister(observer);
      if (observer) observer.disconnect();
      if (node && node.parentNode) node.parentNode.removeChild(node); node = null;
      if (ownedHost && ownedHost.parentNode) ownedHost.parentNode.removeChild(ownedHost); ownedHost = null;
    }
  };
}

const api = { STATUS_CSS, renderTurnStatusInto, mountStoryStatusbar, ensureStatusCss };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_UI_STATUSBAR__ = api; }
