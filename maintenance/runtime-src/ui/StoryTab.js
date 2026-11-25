// 剧情页（替换原“多功能”占位）：获认可示例布局的正式接入。
// 上方选角色线；中间当前场景/目标/正文素材；下方时间/纪事；侧边本轮人物立绘；窄屏上下排列。
// 另含附近剧情/全部年代目录、历史快照查看。推进由真实回复的完成判据驱动，按钮不跳过剧情、不无限生成。
'use strict';

function pick(requirePath, globalKey) {
  try { if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require(requirePath); } catch (e) {}
  return (typeof globalThis !== 'undefined') ? globalThis[globalKey] : null;
}
const VM = pick('./viewmodel', '__ARK_UI_VIEWMODEL__');
const ST = pick('./styles', '__ARK_UI_STYLES__');
const SB = pick('./statusbar', '__ARK_UI_STATUSBAR__');
const el = ST.el, icon = ST.icon, clear = ST.clear;

function ensureCss(doc) {
  if (doc.getElementById('ark-story-tab-css')) return;
  const s = doc.createElement('style'); s.id = 'ark-story-tab-css'; s.textContent = ST.STORY_CSS; doc.head.appendChild(s);
}

function portraitNode(cast) {
  const box = el('div', { class: 'ark-story-portrait', role: 'img', 'aria-label': (cast.name || '') + ' 立绘' });
  ST.mountPortrait(box, cast, failed => {
    clear(box); box.appendChild(icon('person'));
    if (failed) box.appendChild(el('div', { class: 'ark-story-side-label', text: '图片加载失败·占位' }));
  });
  return box;
}

function castCard(cast, sideLabel) {
  const card = el('div', { class: 'ark-story-castcard' });
  card.appendChild(portraitNode(cast));
  const info = el('div', {});
  info.appendChild(el('div', { class: 'ark-story-side-label', text: sideLabel }));
  info.appendChild(el('div', { class: 'ark-story-person', text: cast.name || cast.actor_id }));
  info.appendChild(el('div', { class: 'ark-story-person-state', text: (cast.label || '出场') + (cast.period_label ? ' · ' + cast.period_label : '') }));
  if (cast.placeholder) info.appendChild(el('div', { class: 'ark-story-side-label', text: cast.fallback_reason === 'no_portrait_asset' ? '暂无匹配立绘·姓名占位' : '立绘占位' }));
  card.appendChild(info);
  return card;
}

function badge(text, warn) { return el('span', { class: 'ark-story-badge' + (warn ? ' ark-warn' : ''), text }); }

function mountStoryTab(container, ctx) {
  const adapter = ctx.adapter, runtime = adapter.runtime, doc = container.ownerDocument || document;
  const opts = ctx.options || {};
  ensureCss(doc);
  let selectedSnapshotId = null;
  let catalogMode = opts.catalogMode === 'navigation' ? 'main' : (opts.catalogMode || 'main');
  let previewRouteId = null;
  let previewSceneId = null, selectedGroupId = null, selectedEntryId = null;
  let pageMode = adapter.getState().active_route ? 'current' : 'catalog', operationId = 0;
  let pending = false, errorMessage = '', mounted = true;
  let autoCurrentPending = !adapter.getState().active_route;
    const root = el('div', { class: 'ark-story-tab ark-hierarchy', 'aria-label': '剧情与连续角色线' });
  clear(container);
  container.appendChild(root);

  function state() { return adapter.getState(); }
  function selectedSnapshot() { return selectedSnapshotId && state().snapshots[selectedSnapshotId]; }
  function statusForView() {
    const snapshot = selectedSnapshot();
    return snapshot ? runtime.renderTurnStatus(snapshot) : adapter.currentStatus();
  }
  // 目录上直接标出可用程度：有本地完整原文 / 仅有摘要目录链接。
  function materialBadge(routeId) {
    const l = runtime.corpusLine ? runtime.corpusLine(routeId) : null;
    const ok = !!(l && l.source !== 'no_local_script' && l.ordered_node_ids && l.ordered_node_ids.length);
    return badge(ok ? '完整原文' : '仅摘要／待补原文', !ok);
  }
  function openPreview(routeId) { previewRouteId = routeId; previewSceneId = null; errorMessage = ''; selectedSnapshotId = null; refresh(); }
  function releaseWaiting() {
    operationId++; pending = false;
    adapter.cancelPending();
    errorMessage = '已解除等待。旧请求若仍在后台运行，其迟到结果会忽略。';
    refresh();
  }
  function jump(routeId, sceneId, segmentIndex = 0) {
    operationId++; pending = false; selectedSnapshotId = null;
    const result = adapter.jumpToScene(routeId, sceneId, segmentIndex);
    errorMessage = result.ok ? '' : '切换未完成：' + result.error;
    if (result.ok) { previewRouteId = null; pageMode = 'current'; }
    refresh();
  }
  async function changeRoute(action) {
    if (pending || adapter.isBusy()) return;
    pending = true; errorMessage = ''; selectedSnapshotId = null; previewRouteId = null;
    pageMode = 'current';
    const actionId = ++operationId;
    refresh();
    try {
      const result = await action();
      if (actionId !== operationId) return;
      if (!result.ok) errorMessage = '开场生成失败或操作未完成（' + (result.error || result.reason || 'unknown') + '）。可点击“重试当前开场”。';
      else if (result.generated && result.generated.processed && !result.generated.processed.ok) errorMessage = '回复已生成，但剧情状态包未通过校验；本轮状态未提交。';
    } catch (e) { if (actionId === operationId) errorMessage = '开场生成失败；请检查酒馆连接。不会自动重试。'; }
    finally { if (actionId === operationId) { pending = false; if (mounted) refresh(); } }
  }

  // 继续下一篇：先结算/保存当前体验（回忆则恢复上下文），再进入导航序列下一篇。
  // 只生成一次开场；busy/pending 守卫连点；失败不自动重试。
  async function continueNext(nextEntryId) {
    if (pending || adapter.isBusy()) return;
    pending = true; errorMessage = ''; selectedSnapshotId = null;
    refresh();
    try {
      const fin = await adapter.finishExperience({});
      if (!fin.ok) { errorMessage = '结算当前篇章失败（' + (fin.error || 'unknown') + '）。'; return; }
      if (!fin.completed) { errorMessage = '当前角色线尚未演完，请继续当前幕。'; return; }
      const target = nextEntryId || (fin.next_entry && fin.next_entry.entry_id);
      if (!target) { errorMessage = ''; return; } // 已到导航末尾，回到目录
      const result = await adapter.enterExperience(target);
      if (!result.ok) errorMessage = '进入下一篇失败（' + (result.error || 'unknown') + '）。不会自动重试。';
      else if (result.generated && result.generated.processed && !result.generated.processed.ok) errorMessage = '回复已生成，但剧情状态包未通过校验；本轮状态未提交。';
    } catch (e) { errorMessage = '继续下一篇失败；请检查酒馆连接。不会自动重试。'; }
    finally { pending = false; if (mounted) refresh(); }
  }

  function refresh() {
    if (!mounted) return;
    const st = state();
    const snapshot = selectedSnapshot();
    if (selectedSnapshotId && !snapshot) selectedSnapshotId = null;
    const status = statusForView();
    const showCatalog = pageMode === 'catalog' && !previewRouteId;
    const catalog = showCatalog ? VM.buildCatalogView(runtime, snapshot ? snapshot.state_after : st, { windowMinutes: opts.windowMinutes }) : null;
    const navigation = showCatalog ? VM.buildNavigationView(runtime, snapshot ? snapshot.state_after : st, {}) : null;
    const history = pageMode === 'history' ? VM.buildHistoryView(runtime, st) : [];
    const view = VM.buildStoryPageView(runtime, st, { snapshot, status, catalog, navigation, history, narrativeMax: opts.narrativeMax });
    if (autoCurrentPending && view.has_active && pageMode === 'catalog' && !previewRouteId) { pageMode = 'current'; autoCurrentPending = false; }
    clear(root);
    root.appendChild(renderHead(view));
    const pages = el('nav', { class: 'ark-story-routes', 'aria-label': '剧情页面' });
    for (const [id, label] of [['catalog', '剧情目录'], ['current', '当前剧情'], ['summary', '剧情摘要'], ['portraits', '角色立绘'], ['history', '历史记录']]) {
      pages.appendChild(el('button', { type: 'button', 'aria-pressed': String(pageMode === id && !previewRouteId),
        disabled: ['summary','portraits'].includes(id) && !view.has_active,
        onclick: () => { autoCurrentPending = false; pageMode = id; previewRouteId = null; if (id !== 'history') selectedSnapshotId = null; refresh(); } }, label));
    }
    root.appendChild(pages);
    if (status && SB && !['summary','portraits'].includes(pageMode)) {
      const slot = el('div', { class: 'ark-story-inline-status', 'aria-label': '附加剧情状态栏' });
      SB.renderTurnStatusInto(slot, status, snapshot ? null : adapter);
      root.appendChild(slot);
    }
    if (pageMode === 'current' && !previewRouteId && view.routes.length) root.appendChild(renderRoutes(view));
    if (previewRouteId) {
      const preview = VM.buildRoutePreview(runtime, previewRouteId, { narrativeMax: 800 });
      if (preview) root.appendChild(renderRoutePreview(preview));
      else previewRouteId = null;
    }
    if (!previewRouteId) {
      if (pageMode === 'current') {
        if (view.has_active) { root.appendChild(renderScenePicker(view)); root.appendChild(renderMain(view)); root.appendChild(renderActions(view)); }
        else root.appendChild(el('div', { class: 'ark-story-empty', text: '请从剧情目录选择角色线和起始幕。' }));
      } else if (pageMode === 'summary' || pageMode === 'portraits') {
        root.appendChild(view.has_active ? renderReferencePage(view,status,pageMode) : el('div',{class:'ark-story-empty',text:'尚未进入角色线，请先在剧情目录选择并确认进入。'}));
      } else if (pageMode === 'history') root.appendChild(renderHistory(view, history));
      else root.appendChild(renderCatalog(view, catalog));
    }
    const busy = pending || adapter.isBusy();
    root.setAttribute('aria-busy', String(busy));
    if (busy) {
      root.appendChild(el('div', { role: 'status', text: '正在等待生成，可继续浏览目录或手动切幕。' }));
      root.appendChild(el('button', { type: 'button', onclick: releaseWaiting }, '解除等待'));
    }
    if (errorMessage) root.appendChild(el('div', { role: 'alert', text: errorMessage }));
    if (typeof ctx.onStatusChange === 'function') ctx.onStatusChange(snapshot ? status : null);
  }

  function renderHead(view) {
    const head = el('div', { class: 'ark-story-head' });
    head.appendChild(el('h2', { class: 'ark-story-title', text: view.header.title }));
    const help = el('details', { class: 'ark-story-help ark-story-note' });
    help.appendChild(el('summary', { text: '使用说明' }));
    help.appendChild(el('p', { text: view.header.subtitle }));
    if (view.header.note) help.appendChild(el('p', { text: view.header.note }));
    head.appendChild(help);
    if (selectedSnapshotId != null) head.appendChild(badge('正在查看历史快照', false));
    return head;
  }

  function renderRoutes(view) {
    const wrap = el('div', { class: 'ark-story-routes', role: 'group', 'aria-label': '选择连续角色线' });
    const select = el('select', { 'aria-label': '切换角色线', onchange: e => openPreview(e.target.value) });
    for (const r of view.routes) {
      select.appendChild(el('option', { value: r.route_id, selected: r.active, text: r.label + ' · ' + r.progress_label }));
    }
    wrap.appendChild(select);
    return wrap;
  }

  function renderRoutePreview(preview) {
    const sec = el('section', { class: 'ark-story-preview', role: 'region', 'aria-label': preview.story_title + ' ' + preview.route_label + '完整剧情预览' });
    sec.appendChild(el('h3', { text: '完整剧情预览｜' + preview.story_title + ' · ' + preview.route_label }));
    sec.appendChild(el('div', { class: 'ark-story-note', text: (preview.group_label ? preview.group_label + '｜' : '') + '时间：' + preview.date_display + '｜共' + preview.node_count + '幕。以下按本线发生逻辑顺序列出逐幕梗概；点开每幕可查看完整原文、人物与来源（仅供玩家浏览，不会提前送给模型）。' }));
    const list = el('div', { class: 'ark-story-preview-list' });
    if (!preview.scenes.some(s => s.scene_id === previewSceneId)) previewSceneId = preview.scenes[0] && preview.scenes[0].scene_id;
    const choose = el('select', { 'aria-label': '预览幕', onchange: e => { previewSceneId = e.target.value; refresh(); } });
    for (const s of preview.scenes) choose.appendChild(el('option', { value: s.scene_id, selected: s.scene_id === previewSceneId, text: '第' + (s.index + 1) + '幕 ' + s.title }));
    sec.appendChild(choose);
    for (const s of preview.scenes.filter(s => s.scene_id === previewSceneId)) {
      const row = el('article', { class: 'ark-story-preview-scene' });
      row.appendChild(el('div', { class: 'ark-story-preview-title', text: '第' + (s.index + 1) + '幕｜' + s.title + (s.node_code ? '｜' + s.node_code : '') }));
      row.appendChild(el('div', { class: 'ark-story-note', text: '时间：' + s.date_display + (s.cast_names.length ? '｜焦点人物：' + s.cast_names.join('、') : '') }));
      if (s.narrative) row.appendChild(el('p', { text: s.narrative }));
      row.appendChild(el('div', { class: 'ark-story-goal', text: '完成条件：' + s.goal }));
      const details = el('details', { class: 'ark-story-source-details' });
      details.appendChild(el('summary', { text: '展开完整原文｜' + s.material_status + '｜' + s.full_chars + '字 / ' + s.segment_count + '段' }));
      if (s.full_text) {
        const src = s.source || {};
        details.appendChild(el('div', { class: 'ark-story-note', text: '来源：' + (src.file || '暂无') + '｜' + (src.locator || '') + '｜sha256 ' + String(src.sha256 || '').slice(0, 12) + '…' }));
        if (s.source_speakers && s.source_speakers.length) details.appendChild(el('div', { class: 'ark-story-note', text: '人物：' + s.source_speakers.join('、') }));
        details.appendChild(el('pre', { class: 'ark-story-fulltext', text: s.full_text }));
      } else {
        details.appendChild(el('div', { class: 'ark-story-note', text: '该篇目仅有摘要／目录／链接，需在 PRTS 或游戏内补采具体章节原文；素材原有精度保留。' }));
      }
      if (!s.playable) details.appendChild(el('div', { class: 'ark-story-note', text: '该条为档案／说明／待核条目，可查阅，但不会在玩家点「下一幕」时演出。' }));
      row.appendChild(details);
      list.appendChild(row);
    }
    sec.appendChild(list);
    const actions = el('div', { class: 'ark-story-actions' });
    actions.appendChild(el('button', { type: 'button', class: 'ark-primary',
      onclick: () => jump(preview.route_id, previewSceneId) }, '从选定幕进入（不自动生成）'));
    actions.appendChild(el('button', { type: 'button', class: 'ark-primary', onclick: () => changeRoute(() => preview.entry_id ? adapter.enterExperience(preview.entry_id, { route_id: preview.route_id }) : adapter.enterRoute(preview.route_id, state().entered_routes[preview.route_id] ? 'continue' : 'live')) }, [icon('login'), '确认进入「' + preview.route_label + '」']));
    actions.appendChild(el('button', { type: 'button', onclick: () => { previewRouteId = null; refresh(); } }, [icon('close'), '取消']));
    sec.appendChild(actions);
    return sec;
  }

  function renderScenePicker(view) {
    const active = state().active_route;
    const route = runtime.data.routeById[active.route_id];
    const box = el('div', { class: 'ark-story-section ark-story-scene-picker', 'aria-label': '自由切幕' });
    box.appendChild(el('h3', { text: '自由切幕' }));
    const controls = el('div', { class: 'ark-story-scene-controls' });
    const choose = el('select', { 'aria-label': '当前幕', onchange: e => jump(active.route_id, e.target.value) });
    for (const [index, id] of route.ordered_scene_ids.entries()) {
      const node = runtime.corpusNodeForScene && runtime.corpusNodeForScene(id);
      const scene = runtime.data.sceneById[id];
      choose.appendChild(el('option', { value: id, selected: id === active.scene_id,
        text: '第' + (index + 1) + '幕 ' + (node && node.node_code || scene.completion_criteria || id) }));
    }
    controls.appendChild(choose);
    const node = runtime.corpusNodeForScene && runtime.corpusNodeForScene(active.scene_id);
    const progress = state().corpus_progress && state().corpus_progress[active.route_id];
    if (node && node.segment_count > 1) {
      const parts = el('select', { 'aria-label': '当前段', onchange: e => jump(active.route_id, active.scene_id, Number(e.target.value)) });
      for (let i = 0; i < node.segment_count; i++) parts.appendChild(el('option', { value: String(i), selected: !!progress && progress.segment_index === i, text: '第' + (i + 1) + ' / ' + node.segment_count + '段' }));
      controls.appendChild(parts);
    }
    const at = route.ordered_scene_ids.indexOf(active.scene_id);
    const buttons = el('div', { class: 'ark-story-scene-buttons' });
    for (const [offset, label] of [[-1, '上一幕'], [1, '下一幕']]) {
      if (route.ordered_scene_ids[at + offset]) buttons.appendChild(el('button', { type: 'button', onclick: () => jump(active.route_id, route.ordered_scene_ids[at + offset]) }, label));
    }
    controls.appendChild(buttons);
    box.appendChild(controls);
    box.appendChild(el('div', { class: 'ark-story-note', text: '手动切换立即生效，不补记略过剧情为已完成。切换后可直接聊天。' }));
    return box;
  }

  function renderMain(view, readonly = false) {
    const main = el('div', { class: 'ark-story-main', 'aria-live': 'polite' });
    const stack = el('div', { class: 'ark-story-stack' });
    const c = view.current;
    stack.appendChild(el('div', { class: 'ark-story-meta' }, [el('span', { text: (view.navigation_label || '') + c.route_label + ' · ' + c.progress_label }), el('span', { text: '世界进度 ' + c.world_clock })]));
    // 回忆前情提示：不自动插播；可点击进入/重看，也可继续当前章节。
    if (c.memory_preface && !readonly) {
      const mp = c.memory_preface;
      const banner = el('div', { class: 'ark-story-goal', role: 'note' }, [mp.hint + ' ']);
      banner.appendChild(el('button', { type: 'button', onclick: () => changeRoute(() => adapter.enterExperience(mp.entry_id, { mode: mp.experienced ? 'restart' : 'live' })) }, mp.experienced ? '重看回忆' : '进入前情回忆'));
      stack.appendChild(banner);
    }
    stack.appendChild(el('h3', { class: 'ark-story-scene', text: c.scene_title }));
    if (c.corpus) {
      stack.appendChild(el('div', { class: 'ark-story-goal', text: c.corpus.display + '｜下一步：' + c.corpus.next_step }));
      stack.appendChild(el('div', { class: 'ark-story-note', text: '当段原文：' + (c.corpus.source_file || '暂无') + '｜' + (c.corpus.source_locator || '') + '｜' + c.corpus.material_status + (c.corpus.speakers && c.corpus.speakers.length ? '｜人物：' + c.corpus.speakers.join('、') : '') }));
    }
    if (c.corpus_restore && c.corpus_restore.needs_manual_choice && !readonly) {
      const restore = el('div', { class: 'ark-story-goal', role: 'alert' });
      restore.appendChild(el('div', { text: '旧存档无法可靠定位：' + c.corpus_restore.original_position + '。' + (c.corpus_restore.reason || '') + ' 请选续点：' }));
      restore.appendChild(el('button', { type: 'button', onclick: () => changeRoute(() => adapter.enterRoute(c.route_id, 'live')) }, [icon('restart_alt'), '从本线开头重读']));
      restore.appendChild(el('button', { type: 'button', onclick: () => { adapter.resolveCorpusRestore('keep'); refresh(); } }, [icon('visibility'), '保留原位置，仅按梗概继续']));
      stack.appendChild(restore);
    }
    const guide = el('div', { class: 'ark-story-playguide', role: 'note' });
    guide.appendChild(el('strong', { text: '如何推进：' }));
    guide.appendChild(document.createTextNode('在酒馆聊天框正常行动或对话。AI 每次只续一轮；当“' + c.goal + '”确实达成后，系统自动进入下一幕，无需手动切换。'));
    if (!readonly) stack.appendChild(guide);
    if (c.path) stack.appendChild(el('div', { class: 'ark-story-path', text: c.path }));
    if (c.narrative) stack.appendChild(el('p', { class: 'ark-story-narrative', text: c.narrative }));
    stack.appendChild(el('div', { class: 'ark-story-goal', text: '当前目标：' + c.goal }));
    stack.appendChild(el('div', { class: 'ark-story-next' }, [
      el('strong', { text: '下一幕：' }),
      c.next_scene ? (c.next_scene.title + (c.next_scene.narrative ? '｜' + c.next_scene.narrative : '')) : '本线收束；完成当前幕后可继续下一篇或退出。'
    ]));
    if (c.brief) stack.appendChild(el('div', { class: 'ark-story-note', text: '进度备注：' + c.brief }));
    const footer = el('div', { class: 'ark-story-footer' });
    const clockLabel = view.context_kind === 'memory' ? '回忆时间：' + c.scene_clock : '时间：' + c.date_display;
    footer.appendChild(el('div', { class: 'ark-story-clock', text: clockLabel + (c.scene_clock === '暂无' && c.unknown_date_elapsed_minutes ? '（本段经过' + c.unknown_date_elapsed_minutes + '分钟）' : '') }));
    if (c.chronicle) {
      footer.appendChild(el('div', { text: '大地纪事｜' + c.chronicle.text }));
      footer.appendChild(el('div', { class: 'ark-story-note', text: '事件时间 ' + c.chronicle.time + ' · ' + (c.chronicle.is_repeated ? '沿用上一条' : '最近事件') }));
      if (c.chronicle.others && c.chronicle.others.length) footer.appendChild(el('div', { class: 'ark-story-note', text: '同期其它：' + c.chronicle.others.map(o => o.title || o.text || o.event_id).join('；') }));
    }
    stack.appendChild(footer);
    main.appendChild(stack);
    const links=el('div',{class:'ark-story-actions'});
    for(const [id,label] of [['summary','查看完整剧情摘要'],['portraits','查看角色立绘']])links.appendChild(el('button',{type:'button',onclick:()=>{pageMode=id;refresh();}},label));
    if (!readonly) main.appendChild(links);
    return main;
  }

  function renderReferencePage(view,status,kind) {
    const c=view.current;
    const page=el('section',{class:kind==='summary'?'ark-story-summary-page':'ark-story-cast-page'});
    const heading = el('div', { class: 'ark-story-reference-head' });
    heading.appendChild(el('h3',{text:(kind==='summary'?'完整剧情摘要':'角色立绘与状态')+'｜'+c.route_label}));
    heading.appendChild(el('button',{type:'button',onclick:()=>{pageMode='current';refresh();}},'返回当前剧情'));
    page.appendChild(heading);
    if(kind==='portraits'){
      const castBody=el('div',{class:'ark-story-reference-body'});
      castBody.appendChild(renderSidebar(view));page.appendChild(castBody);return page;
    }
    page.appendChild(el('p',{class:'ark-story-note',text:'共'+(c.guide?c.guide.acts:0)+'幕 · 仅供玩家查阅，不切幕、不提前发送给AI。'}));
    const overview = el('div', {class:'ark-story-reference-body'});
    if (c.guide) {
      if (c.guide.header_lines.length) {
        const details = el('details', { class: 'ark-story-source-details' });
        details.appendChild(el('summary', { text: '路线背景与来源' }));
        details.appendChild(el('pre', { class: 'ark-story-fulltext', text: c.guide.header_lines.join('\n') }));
        overview.appendChild(details);
      }
      for (const act of c.guide.act_summaries) {
        const item = el('article',{class:'ark-story-act-summary'});
        item.appendChild(el('h4',{text:'第' + (act.index + 1) + '幕｜' + act.title}));
        item.appendChild(el('p',{text:act.summary}));
        if (act.source_status === 'legacy') item.appendChild(el('p',{class:'ark-story-note',text:'沿用旧摘要，尚未录入新稿。'}));
        if (act.source_status === 'combat_marker') item.appendChild(el('p',{class:'ark-story-note',text:'原文仅含战斗标记。'}));
        if (act.notes) item.appendChild(el('p',{class:'ark-story-note',text:'稿件备注：' + act.notes}));
        overview.appendChild(item);
      }
    } else overview.appendChild(el('p',{text:'暂无剧情摘要，请从目录查看本线原文。'}));
    page.appendChild(overview);
    return page;
  }

  function renderSidebar(view, status) {
    const side = el('aside', { class: 'ark-story-sidebar', 'aria-label': '本轮人物立绘与状态' });
    const cast = view.cast || [];
    if (!cast.length) side.appendChild(el('div', { class: 'ark-story-empty', text: '本轮无出场人物' }));
    for (const c of cast) side.appendChild(castCard(c, c.presence === 'voice' ? '本轮出声' : '本轮出场'));
    for (const c of (view.memory_cast || [])) side.appendChild(castCard(c, '回忆视图'));
    if (view.mentioned && view.mentioned.length) {
      const m = el('div', { class: 'ark-story-side-label' });
      m.appendChild(document.createTextNode('仅被提及：'));
      const data = runtime.data;
      m.appendChild(document.createTextNode(view.mentioned.map(id => (data.actorById[id] ? data.actorById[id].canonical_name : id)).join('、')));
      side.appendChild(m);
    }
    return side;
  }

  function renderActions(view) {
    const wrap = el('div', { class: 'ark-story-actions' });
    const a = view.actions;
    const active = state().active_route;
    const entry = active && state().entered_routes[active.route_id];
    if (entry && entry.plan && active.scene_id === entry.plan.scene_id) {
      wrap.appendChild(el('button', { type: 'button', onclick: () => changeRoute(async () => {
        const generated = await adapter.generateOpeningOnce(adapter.buildOpening(entry.plan));
        return { ok: generated.sent, error: generated.reason, generated };
      }) }, [icon('refresh'), '重试当前开场']));
    }
    if (a.at_end && a.next_entry) wrap.appendChild(el('button', { type: 'button', class: 'ark-primary', title: '结算当前篇章并进入导航序列下一篇（只生成一次开场）', onclick: () => continueNext(a.next_entry.entry_id) }, [icon('fast_forward'), '继续下一篇：' + a.next_entry.title]));
    if (a.can_restart) wrap.appendChild(el('button', { type: 'button', onclick: () => changeRoute(() => adapter.enterRoute(state().active_route.route_id, 'restart')) }, [icon('replay'), '重开本线']));
    if (a.can_exit) wrap.appendChild(el('button', { type: 'button', onclick: () => changeRoute(() => adapter.exitRoute(null)) }, [icon('logout'), view.context_kind === 'memory' ? '退出回忆' : '退出本线']));
    if (opts.debug && a.can_continue) wrap.appendChild(el('button', { type: 'button', class: 'ark-primary', title: '仅调试：模拟完成当前段', onclick: () => { if (typeof opts.onEarly === 'function') opts.onEarly(); refresh(); } }, [icon('fast_forward'), '提前完成转折(调试)']));
    wrap.appendChild(el('span', { class: 'ark-story-note', text: a.hint }));
    return wrap;
  }

  function renderHistory(view, history) {
    const sec = el('div', { class: 'ark-story-section' });
    sec.appendChild(el('h4', {class:'ark-story-history-title'}, [icon('history'), '历史回复快照']));
    if (!history || !history.length) { sec.appendChild(el('div', { class: 'ark-story-empty', text: '暂无历史快照（产生回复后自动记录）。' })); return sec; }
    const row = el('div', { class: 'ark-story-history' });
    const sel = el('select', { 'aria-label': '选择历史快照', onchange: (e) => { const v = e.target.value; selectedSnapshotId = v || null; refresh(); } });
    sel.appendChild(el('option', { value: '', text: '当前进度' }));
    for (const h of history) sel.appendChild(el('option', { value: h.snapshot_id, selected: h.snapshot_id === selectedSnapshotId, text: '#' + h.revision + ' ' + h.scene_clock + ' · ' + h.progress_label }));
    row.appendChild(sel);
    if (selectedSnapshotId != null) row.appendChild(el('button', { type: 'button', onclick: () => { selectedSnapshotId = null; refresh(); } }, [icon('undo'), '回到当前']));
    sec.appendChild(row);
    if (selectedSnapshot() && view.has_active) {
      sec.appendChild(el('p', { class: 'ark-story-note', text: '历史快照为只读。返回当前剧情后再切幕、推进或退出。' }));
      sec.appendChild(renderMain(view, true));
      sec.appendChild(renderSidebar(view));
    }
    return sec;
  }

  function renderCatalog(view, catalog) {
    const sec = el('div', { class: 'ark-story-section' });
    const tabs = el('div', { class: 'ark-story-routes' });
    const extra = el('details', { class: 'ark-story-source-details' });
    extra.appendChild(el('summary', { text: '辅助检索' }));
    for (const mode of [['main', '主线'], ['side', '支线'], ['supplementary', '其他'], ['nearby', '附近剧情(辅助)'], ['eras', '全部年代(辅助)'], ['undated', '日期待定(辅助)']]) {
      const target = ['main', 'side', 'supplementary'].includes(mode[0]) ? tabs : extra;
      target.appendChild(el('button', { type: 'button', 'aria-pressed': String(catalogMode === mode[0]), onclick: () => { catalogMode = mode[0]; selectedGroupId = null; selectedEntryId = null; refresh(); } }, mode[1]));
    }
    sec.appendChild(tabs);
    sec.appendChild(extra);
    const navigation = view.navigation;
    if (catalogMode === 'main' || catalogMode === 'side') {
      if (!navigation || !navigation.available) {
        sec.appendChild(el('div', { class: 'ark-story-empty', text: '导航数据缺失，请检查构建。' }));
      } else {
        if (catalogMode === 'main') {
          sec.appendChild(el('div', { class: 'ark-story-catalog-path', text: '主线 → 1–8 / 9–14 / 15–17 → 每章' }));
          for (const g of navigation.main) sec.appendChild(groupBlock(g, true, ''));
        } else {
          sec.appendChild(el('div', { class: 'ark-story-catalog-path', text: '支线 → 国家 → 每章' }));
          sec.appendChild(el('div', { class: 'ark-story-note', text: '国家内按剧情顺序排列；没有国家归属的篇目放在“其他”。' }));
          for (const g of navigation.side.filter(x => x.kind === 'country')) sec.appendChild(groupBlock(g, false, '国家'));
        }
      }
    } else if (catalogMode === 'supplementary') {
      if (!navigation || !navigation.available) sec.appendChild(el('div', { class: 'ark-story-empty', text: '暂无其他剧情。' }));
      else {
        sec.appendChild(el('div', { class: 'ark-story-note', text: '无国家归属、人物专题、联动与独立补充剧情；已纳入主线的分章不重复列出。' }));
        for (const g of navigation.side.filter(x=>x.kind!=='country')) sec.appendChild(groupBlock(g,false,g.kind==='unassigned'?'':'专题'));
        const byCategory=new Map();
        for(const e of navigation.supplementary){const key=e.category==='主线'?'无归属补充':e.category||'未分类';if(!byCategory.has(key))byCategory.set(key,[]);byCategory.get(key).push(e);}
        for(const [label,entries] of byCategory)sec.appendChild(groupBlock({group_id:'extra:'+label,label,kind:'other',entries},false,''));
      }
    } else if (catalogMode === 'nearby') {
      if (!catalog.nearby.length) sec.appendChild(el('div', { class: 'ark-story-empty', text: '当前时点附近暂无已定年剧情。' }));
      for (const s of catalog.nearby.slice(0, 24)) sec.appendChild(storyCard(s));
    } else if (catalogMode === 'eras') {
      for (const era of catalog.eras) {
        const d = el('details', { class: 'ark-story-era' });
        d.appendChild(el('summary', { class: 'ark-story-era-label', text: era.era_label + '（' + era.stories.length + '篇）' }));
        for (const s of era.stories) d.appendChild(storyCard(s));
        sec.appendChild(d);
      }
      if (!catalog.eras.length) sec.appendChild(el('div', { class: 'ark-story-empty', text: '暂无已定年剧情。' }));
      if (catalog.undated.length) {
        const d = el('details', { class: 'ark-story-era ark-story-era-undated' });
        d.appendChild(el('summary', { class: 'ark-story-era-label', text: '日期待定（' + catalog.undated.length + '篇）' }));
        for (const s of catalog.undated) d.appendChild(storyCard(s));
        sec.appendChild(d);
      }
    } else {
      if (!catalog.undated.length) sec.appendChild(el('div', { class: 'ark-story-empty', text: '无日期待定篇章。' }));
      for (const s of catalog.undated) sec.appendChild(storyCard(s));
    }
    sec.appendChild(el('div', { class: 'ark-story-note', text: '主线3块 · 支线按原文件夹分组。未确定日期标注“暂无”。' }));
    return sec;
  }

  // 分块（主线三块/国家/专题）：组内按编译期 sequence_order 展示。
  function groupBlock(g, openDefault, kindLabel) {
    const id = g.group_id || g.label;
    const expanded = selectedGroupId === id;
    const d = el('section', { class: 'ark-story-era' });
    d.appendChild(el('button', { type: 'button', class: 'ark-story-era-label', 'aria-expanded': String(expanded),
      onclick: () => { selectedGroupId = expanded ? null : id; selectedEntryId = null; refresh(); },
      text: (kindLabel ? kindLabel + '｜' : '') + g.label + (g.kind === 'main' ? '' : '（' + g.entries.length + '篇）') }));
    if (expanded) for (const e of g.entries) d.appendChild(entryCard(e));
    return d;
  }

  // 导航条目卡：标题+章节/回忆/日期标记+进度+角色线入口。
  function entryCard(e) {
    const card = el('div', { class: 'ark-story-storycard' });
    const expanded = selectedEntryId === e.entry_id;
    const title = el('button', { type: 'button', class: 'ark-story-storytitle', 'aria-expanded': String(expanded),
      onclick: () => { selectedEntryId = expanded ? null : e.entry_id; refresh(); } }, [(e.chapter_number != null ? '第' + e.chapter_number + '章 ' : '') + e.title]);
    if (e.narrative_layer === 'memory') title.appendChild(badge(e.memory && e.memory.experienced ? '回忆·已体验' : '回忆·前置'));
    if (e.category) title.appendChild(badge(e.category));
    title.appendChild(badge(e.available ? '可玩' : '待改编', !e.available));
    title.appendChild(el('span', { class: 'ark-story-note', text: '时间：' + (e.date_display || '暂无') }));
    card.appendChild(title);
    if (!expanded) return card;
    if (e.memory && e.memory.experienced) card.appendChild(el('div', { class: 'ark-story-note', text: '回忆已体验；第八章不再自动插播，可重看。' }));
    if (e.progress && e.progress.entered) card.appendChild(el('div', { class: 'ark-story-note', text: '进度：' + e.progress.label + (e.progress.finished ? ' · 已完成' : '') }));
    if (e.routes && e.routes.length) {
      const entry = el('div', { class: 'ark-story-routeentry' });
      for (const r of e.routes) entry.appendChild(el('button', { type: 'button', title: '查看全部' + r.node_count + '幕，确认后才进入', onclick: () => openPreview(r.route_id) }, [icon('visibility'), '查看完整剧情｜' + r.label + ' · ' + r.node_count + '幕', materialBadge(r.route_id)]));
      card.appendChild(entry);
    } else card.appendChild(el('div', { class: 'ark-story-note', text: '暂无本地素材，待据原文整理角色线。' }));
    if(e.source_relative_path)card.appendChild(el('div',{class:'ark-story-note',text:'素材：'+e.source_relative_path}));
    return card;
  }

  function storyCard(s) {
    const card = el('div', { class: 'ark-story-storycard' });
    const id = 'story:' + s.story_id;
    const expanded = selectedEntryId === id;
    card.appendChild(el('button', { type: 'button', 'aria-expanded': String(expanded),
      onclick: () => { selectedEntryId = expanded ? null : id; refresh(); }, text: s.title }));
    if (!expanded) return card;
    const title = el('div', { class: 'ark-story-storytitle' }, [s.title]);
    if (s.category) title.appendChild(badge(s.category));
    title.appendChild(badge(s.available ? '可玩' : (s.availability === 'official_only_pending' ? '待改编' : s.availability), !s.available));
    if (s.window && s.window.start) title.appendChild(el('span', { class: 'ark-story-note', text: s.window.start + (s.window.end && s.window.end !== s.window.start ? ' ~ ' + s.window.end : '') }));
    card.appendChild(title);
    if (s.routes && s.routes.length) {
      const entry = el('div', { class: 'ark-story-routeentry' });
      for (const r of s.routes) entry.appendChild(el('button', { type: 'button', title: '查看全部' + r.node_count + '幕，确认后才进入', onclick: () => openPreview(r.route_id) }, [icon('visibility'), '查看完整剧情｜' + r.label + ' · ' + r.node_count + '幕', materialBadge(r.route_id)]));
      card.appendChild(entry);
    } else card.appendChild(el('div', { class: 'ark-story-note', text: '暂无本地素材，待据原文整理角色线。' }));
    return card;
  }

  const unsubscribe = adapter.subscribe(event => {
    if (event.reason === 'reload') {
      operationId++; pending = false; errorMessage = '';
      selectedSnapshotId = null; previewRouteId = null; previewSceneId = null;
      selectedGroupId = null; selectedEntryId = null;
      pageMode = state().active_route ? 'current' : 'catalog';
    }
    refresh();
  });
  refresh();
  return { refresh, unmount: () => { mounted = false; unsubscribe(); if (typeof ctx.onStatusChange === 'function') ctx.onStatusChange(null); if (root.parentNode) root.parentNode.removeChild(root); }, getSelectedMessage: () => { const snapshot = selectedSnapshot(); return snapshot ? snapshot.message_id : null; }, root };
}

const api = { mountStoryTab, ensureCss };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_UI_STORYTAB__ = api; }
