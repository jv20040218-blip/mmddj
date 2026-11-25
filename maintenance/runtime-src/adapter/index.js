// 剧情适配器：仅在当前聊天中投影、注入和提交；不自动重试付费生成。
'use strict';

function pick(requirePath, globalKey) {
  try { if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require(requirePath); } catch (e) {}
  return typeof globalThis !== 'undefined' ? globalThis[globalKey] : null;
}
const Core = pick('../core', '__ARK_STORY_CORE__');
const Protocol = pick('./protocol', '__ARK_ADAPTER_PROTOCOL__');
const Persist = pick('./persistence', '__ARK_ADAPTER_PERSIST__');
const Tavern = pick('./tavern', '__ARK_ADAPTER_HOST__');
const WorldSync = pick('./worldbook_sync', '__ARK_WORLDBOOK_SYNC__');
const RULES_ENTRY_NAME = 'ARK剧情运行规则';
const INJECTION_ID = 'ark-story-runtime';
const RULES_PROMPT_ID = 'ark-story-rules';
const INJECTION_IDS = [RULES_PROMPT_ID, INJECTION_ID];
const clone = value => JSON.parse(JSON.stringify(value));

function createStoryAdapter(opts) {
  const o = opts || {};
  const runtime = o.runtime || Core.createRuntime(o.data);
  const host = o.host || Tavern.createHost();
  const data = runtime.data;
  const worldbookName = o.worldbookName || null;
  const diag = { applied: [], pending: [], warnings: [] };
  const unsubs = [], listeners = new Set();
  let loadedChatId = host.chatId(), epoch = 0, busy = false, initialized = false, destroyed = false;
  let state, messageIndex = {}, messageVersions = {};
  let snapshotCodec, loadFailed = false;
  let regeneration = null;
  let projectionOff = null;
  const projection = { registered: false, method: 'per_generation_projection', hook_calls: 0, matches: 0, last_matches: 0 };

  function note(kind, msg) {
    const list = diag[kind] || (diag[kind] = []);
    list.push(msg);
    if (list.length > 100) list.shift();
  }
  function notify(reason) {
    for (const listener of listeners) {
      try { listener({ reason, state, busy, statusView: currentStatus() }); } catch (e) { note('warnings', 'subscriber_error:' + e.message); }
    }
  }
  function fail(reason, extra) { notify('failure'); return { ok: false, reason, error: reason, ...extra }; }
  function validChat() { return !loadFailed && loadedChatId != null && loadedChatId !== '' && host.chatId() === loadedChatId && state.chat_id === loadedChatId; }
  function readChatVar(id, key) {
    return host.readChatVar ? host.readChatVar(id, key) : (host.readChatVars(id) || {})[key];
  }
  function load() {
    snapshotCodec = Persist.createSnapshotCodec();
    loadFailed = false;
    let bundle = null;
    try { bundle = loadedChatId != null ? readChatVar(loadedChatId, Persist.KEY) : null; } catch (e) { loadFailed = true; note('warnings', 'chat_load_failed:' + e.message); }
    if (bundle?.state?.chat_id === loadedChatId && bundle.state.schema_version === 4) {
      try {
        const { snapshots, ...running } = bundle.state;
        const restored = snapshotCodec.unpack(bundle.snapshot_store);
        if ((running.snapshot_order || []).some(id => !Object.hasOwn(restored, id))) throw Error('missing_snapshot');
        bundle = { ...bundle, state: { ...running, schema_version: 3, snapshots: restored } };
      } catch (e) { loadFailed = true; note('warnings', 'snapshot_load_failed:' + e.message); bundle = null; }
    } else if (bundle?.state?.chat_id === loadedChatId && ![2, 3].includes(bundle.state.schema_version)) {
      loadFailed = true;
      note('warnings', 'unsupported_save_schema');
    }
    if (bundle && bundle.state && (bundle.state.schema_version === 2 || bundle.state.schema_version === 3) && bundle.state.chat_id === loadedChatId) {
      // v2旧存档幂等迁移到v3；v3直接恢复。旧快照/进度/稳定ID保留。
      state = bundle.state.schema_version === 3
        ? (bundle.snapshot_store ? { ...clone({ ...bundle.state, snapshots: undefined }), snapshots: bundle.state.snapshots } : clone(bundle.state))
        : Persist.migrateSave(bundle.state, data);
      messageIndex = clone(bundle.message_index || {});
      messageVersions = clone(bundle.message_versions || {});
      if (bundle.state.schema_version === 2) note('applied', 'save_migrated_v2_to_v3');
    } else {
      state = runtime.createState({ chat_id: loadedChatId, branch_id: 'branch_1' });
      state.chat_id = loadedChatId; // 无聊天时保持 null，不继承核心的演示默认值。
      messageIndex = {}; messageVersions = {};
      if (bundle) note('warnings', 'ignored_foreign_chat_bundle');
    }
    // 旧存档恢复：优先按稳定节点 ID 定位当前线/节点/段落游标；无法可靠匹配时交给 UI 让玩家选续点。
    if (runtime.corpus && runtime.corpus.available && Core.corpus) {
      const ep = Core.corpus.ensureProgress(runtime.corpus, state, data);
      state.corpus_restore = ep.needs_manual_choice
        ? { needs_manual_choice: true, original_position: ep.original_position, reason: ep.reason }
        : { needs_manual_choice: false, restored: ep.restored };
    }
    // 升级后的旧聊天也重新检测后缀，不要求玩家重新开局。
    if (state.active_route) {
      const active = state.active_route, route = data.routeById[active.route_id], scene = data.sceneById[active.scene_id];
      if (route && scene) {
        const anchors = Core.routes.collectEntryAnchors(data, route, active.scene_id, state);
        const aliases = data.worldbook_binding && data.worldbook_binding.actor_aliases || {};
        const cast = new Set([...Core.routes.castForScene(route, scene, data), ...Object.keys(state.actor_scene_states || {})].map(id => aliases[id] || id));
        const ctx = { story_id: route.story_id, scene_id: active.scene_id, scene_time: active.scene_time, anchors };
        state.actor_scene_states = Object.fromEntries([...cast].map(id => [id, runtime.resolveActorAtScene(id, ctx, state.facts)]));
      }
    }
  }
  load();
  if (o.state && o.state.chat_id === loadedChatId) state = clone(o.state);
  const physical = WorldSync.createWorldbookSync({
    read: host.g && typeof host.g.getWorldbook === 'function' ? name => host.g.getWorldbook(name) : null,
    update: host.g && typeof host.g.updateWorldbookWith === 'function' ? (name, apply) => host.g.updateWorldbookWith(name, apply) : null,
    load: () => { try { return readChatVar(loadedChatId, 'ark_story_worldbook_sync') || null; } catch (_) { return null; } },
    save: (context, snapshot) => { if (context.chat !== host.chatId()) return; const vars = host.readChatVar ? {} : (host.readChatVars(context.chat) || {});
      host.writeChatVars(context.chat, { ...vars, ark_story_worldbook_sync: snapshot ? clone(snapshot) : null }); },
    changed: () => { if (!destroyed) notify('worldbook_synced'); }
  });
  function syncPhysical() {
    if (loadFailed || !data.worldbook_binding || !data.worldbook_binding.physical) return null;
    const chat = loadedChatId, book = detectWorldbookName();
    return physical.sync(computeWorldbookView(), { book, chat, active: !!state.active_route,
      valid: () => !destroyed && chat === host.chatId() && book === detectWorldbookName() });
  }
  async function flushWorldbook() {
    const result = await physical.flush();
    if (o.strictPhysical && data.worldbook_binding && state.active_route && result && !result.ok && !result.stale)
      throw Error('世界书条目切换未完成：' + (result.error || '宿主缺少读写接口'));
    return result;
  }
  async function resetWorldbook(name) {
    if (busy) throw Error('剧情操作仍在进行，请完成后再重置世界书');
    if (name !== detectWorldbookName()) throw Error('重置目标不是当前角色的主世界书');
    const baseline = data.worldbook_binding && data.worldbook_binding.reset_baseline;
    if (!baseline || !physical.available()) throw Error('完整世界书重置数据或宿主接口未就绪');
    // Preserve progress, while leaving all active/recalled scenes before restoring defaults.
    for (let i = 0; i < 3 && state.active_route; i++) {
      const r = runtime.exitRoute(state, null); if (!r.ok) throw Error(r.error); state = r.state;
    }
    state.actor_scene_states = {}; save(); refresh(); await physical.flush();
    const expected = new Map(baseline.map(e => [String(e.uid), e]));
    await host.g.updateWorldbookWith(name, entries => entries.map(e => {
      const target = expected.get(String(e.uid));
      return target ? { ...e, enabled: target.enabled, strategy: { ...e.strategy, type: target.type } } : e;
    }));
    const rows = await host.g.getWorldbook(name), actual = new Map(rows.map(e => [String(e.uid), e]));
    for (const target of baseline) {
      const e = actual.get(String(target.uid));
      if (!e || !!e.enabled !== target.enabled || e.strategy.type !== target.type) throw Error('世界书重置回读失败 UID ' + target.uid);
    }
    physical.forget({ book: name, chat: loadedChatId });
    save(); notify('worldbook_reset');
    return { ok: true, entries: baseline.length, progress_preserved: true };
  }

  function save() {
    if (!validChat()) return false;
    try {
      const vars = host.readChatVar ? {} : (host.readChatVars(loadedChatId) || {});
      const { snapshots, ...running } = state;
      const ok = host.writeChatVars(loadedChatId, { ...vars, [Persist.KEY]: {
        state: { ...clone(running), schema_version: 4 },
        snapshot_store: snapshotCodec.pack(snapshots || {}), message_index: { ...messageIndex },
        message_versions: clone(messageVersions), saved_at: Date.now()
      } });
      if (!ok) note('warnings', 'chat_save_failed');
      return !!ok;
    } catch (e) { note('warnings', 'chat_save_failed:' + e.message); return false; }
  }
  function syncChat() { if (host.chatId() !== loadedChatId) reload(); return validChat(); }
  function token() { return { chatId: loadedChatId, epoch, routeId: state.active_route && state.active_route.route_id }; }
  function tokenValid(t) { return !destroyed && t.epoch === epoch && t.chatId === host.chatId() && t.chatId === loadedChatId; }
  let generationForFormatting = null;
  let replyTiming = null;
  const formattingMessages = new Set();
  async function repairLastDialogue(t) {
    if (!tokenValid(t) || t.routeId !== state.active_route?.route_id || !host.g.setChatMessages) return;
    const message = readMessage(-1);
    if (!message || message.role !== 'assistant' || !Number.isInteger(Number(message.message_id))) return;
    if (String(message.message_id) === String(t.lastMessageId) && !['regenerate', 'swipe'].includes(t.generationType)) return;
    const before = messageText(message);
    if (typeof before !== 'string') return;
    const after = Protocol.repairDialogueParagraphs(before);
    if (after === before) return;
    const key = String(message.message_id), guard = loadedChatId + ':' + key + ':' + message.swipe_id;
    if (formattingMessages.has(guard)) return;
    const version = messageVersions[key];
    if (version && (version.pending || version.text !== before)) return;
    formattingMessages.add(guard);
    // Rerender emits CHARACTER_MESSAGE_RENDERED: mark this formatting-only
    // version first, so its identical control packet cannot commit twice.
    if (version) version.text = after;
    try {
      if (!tokenValid(t)) return;
      await host.g.setChatMessages([{ message_id: Number(message.message_id), message: after }], { refresh: 'affected' });
      if (tokenValid(t)) { save(); note('applied', 'dialogue_paragraph_quotes_paired'); }
    } catch (e) {
      if (version && tokenValid(t) && messageVersions[key] === version && version.text === after) { version.text = before; save(); }
      note('warnings', 'dialogue_quote_format_failed:' + e.message);
    } finally { formattingMessages.delete(guard); }
  }

  function computeWorldbookView(st) {
    const s = st || state;
    const enable = new Set(), disable = new Set(), pending = [];
    // 剧情档案只在所属篇章、当前人物出场时投影，切线/退出后全部关闭。
    for (const actor of Object.values(data.actorById)) {
      for (const p of actor.profile_variants || []) disable.add(p.entry_id);
    }
    for (const [id, ast] of Object.entries(s.active_route ? s.actor_scene_states || {} : {})) {
      if (data.worldbook_binding && data.worldbook_binding.preserve_choice_actor_ids.includes(id)) continue;
      if (ast && ast.profile_entry_id != null) enable.add(ast.profile_entry_id);
      if (ast && ast.entry_id != null) {
        enable.add(ast.entry_id);
        const actor = data.actorById[id];
        for (const alt of actor && actor.states || []) if (alt.entry_id != null && alt.entry_id !== ast.entry_id) disable.add(alt.entry_id);
      } else pending.push(id);
    }
    // 进入某条角色线时启用该线的剧情指导世界书条目（其余线保持关闭）。
    if (data.route_guide_uids) {
      for (const uid of Object.values(data.route_guide_uids)) disable.add(Number(uid));
    }
    if (s.active_route && data.route_guide_uids) {
      const uid = data.route_guide_uids[s.active_route.route_id];
      if (uid != null) enable.add(Number(uid));
    }
    for (const id of enable) disable.delete(id);
    return { enable: [...enable].sort((a, b) => a - b), disable: [...disable].sort((a, b) => a - b), pending, rules_entry: RULES_ENTRY_NAME, basis: 'actor_state_projection' };
  }
  function detectWorldbookName() {
    try {
      const names = host.g.getCharWorldbookNames && host.g.getCharWorldbookNames('current');
      if (names && names.primary && typeof names.then !== 'function') {
        if (!worldbookName || names.primary === worldbookName || names.primary.startsWith(worldbookName + ' (') || names.primary.startsWith(worldbookName + '(')) return names.primary;
        if (data.worldbook_binding) return null;
      }
    } catch (_) {}
    if (worldbookName) return worldbookName;
    try { if (host.worldbookName) return host.worldbookName(); } catch (e) {}
    try { const name = host.g.getChatWorldbookName && host.g.getChatWorldbookName('current'); if (name) return name; } catch (e) {}
    try { const names = host.g.getCharWorldbookNames && host.g.getCharWorldbookNames('current'); return names && names.primary || null; } catch (e) { return null; }
  }
  function projectLores(lores) {
    projection.hook_calls++;
    projection.last_matches = 0;
    if (!validChat() || destroyed) return;
    const name = detectWorldbookName();
    if (!name) return;
    const view = computeWorldbookView();
    const enable = new Set(view.enable.map(String)), disable = new Set(view.disable.map(String));
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
      const entries = lores && lores[key];
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        if (!entry || entry.world !== name || entry.uid == null) return;
        // The existing book remains intact; override its legacy performance
        // instructions only in this generation, retaining all entry flags.
        if (state.active_route && (entry.comment === RULES_ENTRY_NAME || entry.name === RULES_ENTRY_NAME)) {
          const currentRules = pick('./rules', '__ARK_ADAPTER_RULES__');
          if (currentRules && currentRules.RULES_CONTENT) entries[index] = { ...entry, content: currentRules.RULES_CONTENT };
          return;
        }
        const uid = String(entry.uid);
        if (!enable.has(uid) && !disable.has(uid)) return;
        const on = enable.has(uid);
        // ST 随后使用原数组合并；替换元素，不改共享原书或缓存对象。
        const projected = { ...entry, disable: !on, constant: on };
        if (on && data.route_guide_uids && Number(data.route_guide_uids[state.active_route && state.active_route.route_id]) === Number(uid)) {
          // 完整逐幕对白只供玩家查看；世界书仅传递无未来台词的概况。
          const guide = runtime.guideForRoute(state.active_route.route_id);
          projected.content = guide ? guide.header_lines.join('\n') : '';
        }
        if ('enabled' in entry) projected.enabled = on;
        if ('disabled' in entry) projected.disabled = !on;
        entries[index] = projected;
        projection.last_matches++;
      });
    }
    projection.matches += projection.last_matches;
    projection.worldbook = name;
    projection.chat_id = loadedChatId;
    projection.revision = state.revision;
    note('applied', 'worldbook_projection_hook:matches=' + projection.last_matches);
  }
  function applyWorldbookView(view) {
    const v = view || computeWorldbookView();
    if (!projectionOff && !destroyed) {
      try { projectionOff = host.on('WORLDINFO_ENTRIES_LOADED', projectLores); } catch (e) { note('warnings', 'projection_registration_failed:' + e.message); }
    }
    projection.registered = !!projectionOff;
    const name = detectWorldbookName();
    const reason = !projection.registered ? 'worldbook_hook_unavailable' : !name ? 'worldbook_name_unknown' : null;
    if (reason) note('pending', reason);
    return { applied: false, registered: projection.registered, method: 'per_generation_projection', reason, worldbook: name, view: v };
  }

  function buildInjection(st) {
    const s = st || state, inj = runtime.buildPromptInjection(s);
    if (!inj) return null;
    const ended = s.last_ending && s.active_route && s.last_ending.route_id === s.active_route.route_id;
    return { ...inj, base_revision: s.revision, rules_entry: RULES_ENTRY_NAME, line_phase: ended ? 'finished' : 'playing',
      ...(ended ? { scene_material: '', corpus_segment: null, corpus_boundary: null, possible_events: [], allowed_completed_scene_ids: [],
        ending_receipt: { label: s.last_ending.label, summary: s.last_ending.summary },
        current_goal: '本线已结算，按玩家输入进行尾声对话；不重演结尾、不自动进入下一篇。' } : {}) };
  }
  function injectRules(st) {
    const inj = validChat() ? buildInjection(st) : null;
    if (!inj) {
      let cleared = false;
      try {
        if (host.uninject) cleared = host.uninject(INJECTION_IDS);
        else if (host.g.uninjectPrompts) { host.g.uninjectPrompts(INJECTION_IDS); cleared = true; }
      } catch (e) { note('warnings', 'uninject_failed:' + e.message); }
      return { injected: false, cleared, reason: 'no_active_route', injection: null };
    }
    // 在浏览器 bundle 中 rules 可能后载入，因此到实际注入时解析。
    const rules = pick('./rules', '__ARK_ADAPTER_RULES__');
    if (!rules || !rules.RULES_CONTENT) return { injected: false, reason: 'rules_unavailable', injection: inj };
    // Source material stays system context; never impersonate a newer user turn.
    const b = inj.corpus_boundary || null;
    const example = { v: 2, base_revision: inj.base_revision, route_id: inj.route_id, scene_id: inj.scene_id,
      elapsed_minutes: 0, completed_scene_ids: [], event_results: [],
      ...(b ? { segment_node_id: b.node_id } : {}) };
    const tailReminder = [
      '',
      '',
      '# 本轮硬性收尾要求（必须执行，脚本校验）',
      '先回应玩家最新行动，再结合聊天上下文续演；资料不要求逐字复读，长度服从当前预设和互动需要，台词使用成对引号，不截断句子。正文后输出一行玩家可见状态摘要：> **当前情况**｜时间：...｜当前剧情：...｜同时事件：...｜下一步剧情：...。必须依据本轮权威值；无日期写“暂无”，无新事件沿用上一条。',
      '可见状态摘要后必须在同一条回复的结尾附上且仅附上一个控制块——无论正文长短，控制块都不可省略。控制块内是合法 JSON（双引号、无注释、无代码围栏），格式如下：',
      '<ark_turn>' + JSON.stringify(example) + '</ark_turn>',
      '上面仅为控制包的最小字段格式，不是正文模板；base_revision 必须是 ' + inj.base_revision + '，route_id 必须是 ' + inj.route_id + '，scene_id 必须是 ' + inj.scene_id + '。elapsed_minutes 按本轮实际经过填写（正常对话可为 0）；事件只在候选内结算。',
      b ? '本轮以【当前段剧情原文】为事实参考，按实际上下文改写演出，不得提前使用下一幕的台词或动作。只有本段实际完成条件已经达成，才把 segment_ack 填为 ' + b.segment_index + ' 且 segment_node_id 填为 ' + JSON.stringify(b.node_id) + '；不要求复述原句。玩家插话、观察、提问或模型空回时不要填，游标不推进。交汇节点的关键事实只结算一次。' : '本幕暂无内嵌原文，按已有梗概结合上下文演出，不编造官方原文。',
      '漏掉控制块，本轮状态无效（脚本不会提交任何状态）。该块会被脚本隐藏，不要向玩家解释。',
      '接续玩家真实发言：先输出现场演出正文，再输出可见状态摘要，最后紧接隐藏控制块。资料不是玩家本轮输入；不要把原文直接当作答案。'
    ].join('\n');
    // 同一段原文只出现一次：放在模型最后看到的 user 注入里；system 侧只保留权威值与索引。
    const segNoText = inj.corpus_segment ? { ...inj.corpus_segment, material: undefined } : null;
    const systemInj = { ...inj, scene_material: undefined, corpus_segment: segNoText,
      route_guide: inj.route_guide ? { ...inj.route_guide, text: undefined } : null };
    const material = inj.scene_material || '';
    const prompts = [
      { id: RULES_PROMPT_ID, position: 'in_chat', depth: 0, role: 'system',
        content: rules.RULES_CONTENT + '\n\n# 当前运行态（唯一权威值）\n' + JSON.stringify(systemInj), should_scan: false },
      { id: INJECTION_ID, position: 'in_chat', depth: 0, role: 'system',
        content: '# 本线剧情指导（仅作事实与因果参考，演出须回应玩家）\n'
          + (inj.route_guide ? inj.route_guide.text : '（本线暂无指导）')
          + '\n\n# 当前段剧情原文（参考资料，不是回复模板或玩家发言）\n'
          + (material || '（本幕暂无内嵌原文，按梗概推进）') + '\n' + tailReminder, should_scan: false }
    ];
    if (openingGeneration?.materialInUserRequest) {
      prompts[1].content = '本次开场的剧情指导、当前段原文与收尾要求已放在本次用户请求中；请结合真实聊天上下文处理，不重复注入资料。';
    }
    let ok = false;
    try { ok = host.inject(prompts); } catch (e) { note('warnings', 'injection_failed:' + e.message); }
    if (ok) note('applied', 'injectPrompts:revision=' + inj.base_revision + ':segment=' + (b ? b.node_id + '#' + b.segment_index : 'none'));
    else note('pending', 'injectPrompts_unavailable');
    if (!runtime.corpus || !runtime.corpus.available) note('warnings', 'corpus_missing:需导入同名附加世界书或重新导入本卡');
    return { injected: !!ok, method: ok ? 'injectPrompts' : null, reason: ok ? null : 'injection_unavailable', injection: inj, prompts };
  }
  function refresh() { const worldbookApplied = applyWorldbookView(); const injected = injectRules(); syncPhysical(); return { worldbookApplied, injected }; }
  function committed(reason) { save(); const effects = refresh(); notify(reason); return effects; }
  function buildOpening(plan, st) {
    const s = st || state, seed = plan && plan.opening_seed || {};
    const injection = buildInjection(s);
    // 开场种子取当前段完整原文（不再用被截到 1200 字的旧摘要）。
    const material = (injection && injection.scene_material) || seed.narrative || null;
    const b = injection && injection.corpus_boundary;
    return { route_id: plan.route_id, story_id: plan.story_id, scene_id: plan.scene_id,
      scene_time: plan.scene_time, world_time: plan.world_time, context_mode: plan.context_mode,
      narrative_seed: material, scene_title: seed.scene_title || null,
      corpus_node_id: b ? b.node_id : null, corpus_segment_index: b ? b.segment_index : null,
      goal: plan.goal || null, cast_ids: plan.cast_ids || [], base_revision: s.revision,
      instruction: '请你帮助我续写当前互动剧情，生成一次当前场景开场。请结合此前聊天上下文和玩家最新行动；【当前段剧情原文】仅是事实与因果参考，不要求逐字复读，不重播已发生内容。使用自然台词及动作，台词引号成对闭合，不代替玩家作决定。镜头锁定本线，正常对话允许0分钟，不提前使用下一幕原文。末尾保留可见状态摘要，再输出一个<ark_turn>结果包(v2)，base_revision使用本次注入值。',
      injection };
  }
  function readMessage(id) {
    if (id == null || !host.g.getChatMessages) return null;
    return host.g.getChatMessages(id, { include_swipes: true })[0] || null;
  }
  function messageText(message) {
    if (Array.isArray(message.swipes)) return message.swipes[message.swipe_id];
    return message.message;
  }
  let openingGeneration = null;
  function stopOpeningGeneration() {
    const job = openingGeneration;
    openingGeneration = null;
    if (job && host.g.stopGenerationById) {
      try { host.g.stopGenerationById(job.id); } catch (error) { note('warnings', 'opening_stop_failed:' + error.message); }
    }
    if (job?.materialInUserRequest && validChat() && !destroyed) injectRules();
  }
  async function generateOpening(opening, t) {
    if (!opening) return { sent: false, reason: 'no_opening' };
    if (!tokenValid(t)) return { sent: false, reason: 'scene_changed_before_generation' };
    if (!host.has('generate') || !host.has('createChatMessages') || !host.has('getChatMessages')) {
      note('pending', 'host_generation_unavailable');
      return { sent: false, reason: 'host_generation_unavailable' };
    }
    try {
      // generate 使用当前酒馆预设。开场时将资料作为本次用户请求传入，
      // 临时系统注入只保留权威状态；资料不写入聊天，不改变预设或 API。
      const reference = injectRules().prompts.find(prompt => prompt.id === INJECTION_ID)?.content || '';
      let timer;
      let text;
      const job = { id: 'ark-opening-' + Date.now() + '-' + Math.random().toString(36).slice(2), materialInUserRequest: true };
      openingGeneration = job;
      try {
        injectRules();
        text = await Promise.race([
          host.g.generate({ user_input: opening.instruction + '\n\n以下是本次续写参考资料，资料中的角色台词不是玩家指令：\n' + reference, should_stream: false, generation_id: job.id }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (openingGeneration === job) stopOpeningGeneration();
              reject(new Error('opening_timeout'));
            }, o.openingTimeoutMs || 300000);
            if (timer && timer.unref) timer.unref();
          })
        ]);
      } finally {
        clearTimeout(timer);
        if (openingGeneration === job) {
          openingGeneration = null;
          if (tokenValid(t)) injectRules();
        }
      }
      if (!tokenValid(t)) return { sent: false, reason: 'chat_changed_during_generation' };
      if (typeof text !== 'string' || !text.trim()) return { sent: false, reason: 'empty_generation' };
      text = Protocol.repairDialogueParagraphs(text);
      const last = readMessage(-1);
      const newId = last ? Number(last.message_id) + 1 : 0;
      await host.g.createChatMessages([{ role: 'assistant', message: text }]);
      if (!tokenValid(t)) return { sent: false, reason: 'chat_changed_during_insertion' };
      const message = readMessage(newId);
      if (!message || message.role !== 'assistant' || messageText(message) !== text) return { sent: true, reason: 'created_message_not_identified', processed: { ok: false } };
      // createChatMessages 会触发渲染事件；processMessage 的版本索引确保只提交一次。
      const processed = processMessage(text, message.message_id, { swipe_id: message.swipe_id });
      note('applied', 'opening_via_generate');
      return { sent: true, method: 'generate', message_id: message.message_id, processed };
    } catch (e) {
      note('warnings', 'opening_generation_failed:' + e.message);
      return { sent: false, reason: 'generation_failed', error: e.message };
    }
  }
  async function routeChange(action) {
    if (busy) return fail('busy');
    if (destroyed || !syncChat()) return fail('no_current_chat');
    busy = true;
    const t = token();
    try {
      const result = action();
      if (!result.ok) return fail(result.error);
      state = result.state;
      const routeId = state.active_route && state.active_route.route_id;
      const entry = routeId && state.entered_routes[routeId];
      if (entry && !result.already_entered) entry.opening_pending = true;
      const effects = committed('enter');
      await flushWorldbook();
      const plan = result.entryPlan || result.destination;
      const opening = (!result.already_entered || entry && entry.opening_pending) && plan ? buildOpening(plan) : null;
      let generated = null;
      if (opening) generated = effects.injected.injected
        ? await generateOpening(opening, t) : { sent: false, reason: effects.injected.reason };
      if (!tokenValid(t)) { if (host.chatId() !== loadedChatId) reload(); return fail('chat_changed_during_generation', { generated }); }
      const ok = !generated || generated.sent;
      if (opening && generated && generated.sent && state.entered_routes[routeId]) {
        state.entered_routes[routeId].opening_pending = false;
        save();
      }
      if (!ok) notify('failure');
      return { ...result, ok, error: ok ? null : generated.reason, route_entered: true,
        worldbookView: computeWorldbookView(), ...effects, opening, generated, state };
    } catch (e) { note('warnings', 'route_change_failed:' + e.message); return fail('route_change_failed', { detail: e.message }); }
    finally { if (t.epoch === epoch) { busy = false; notify('idle'); } }
  }
  async function enterRoute(routeId, mode) { return routeChange(() => runtime.enterRoute(state, routeId, mode)); }
  async function exitRoute(destination) { return routeChange(() => runtime.exitRoute(state, destination)); }
  // v3 导航入口：按 entry_id 进入体验（含回忆作用域切换与父章前情提示）。
  async function enterExperience(entryId, options) { return routeChange(() => runtime.enterExperience(state, entryId, options)); }
  function cancelPending() {
    stopOpeningGeneration();
    epoch++;
    busy = false;
    notify('waiting_released');
    return { ok: true };
  }
  function jumpToScene(routeId, sceneId, segmentIndex = 0) {
    if (destroyed || !syncChat()) return fail('no_current_chat');
    const route = data.routeById[routeId];
    if (!route || !route.ordered_scene_ids.includes(sceneId)) return fail('scene_not_in_route');
    const node = runtime.corpusNodeForScene && runtime.corpusNodeForScene(sceneId);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 ||
        (node ? segmentIndex >= node.segment_count : segmentIndex !== 0)) return fail('invalid_segment');
    cancelPending();
    const entry = Core.navigation.entryForStory(data, route.story_id);
    const result = entry ? runtime.enterExperience(state, entry.entry_id, { route_id: routeId, scene_id: sceneId })
      : runtime.enterRoute(state, routeId, { scene_id: sceneId });
    if (!result.ok) return fail(result.error);
    state = result.state;
    delete state.last_ending;
    if (node) {
      Core.corpus.resetProgress(state, routeId, node);
      state.corpus_progress[routeId].segment_index = segmentIndex;
    }
    if (state.entered_routes[routeId]) state.entered_routes[routeId].opening_pending = false;
    const effects = committed('manual_jump');
    return { ok: true, state, ...effects };
  }
  // 玩家明确确认当前段已体验；只确认当前段，不补写跳过的幕，也不伪造关键事件。
  function advanceCurrentSegment(expectedRevision) {
    if (destroyed || !syncChat()) return fail('no_current_chat');
    if (expectedRevision != null && expectedRevision !== state.revision) return fail('stale_status_action');
    if (!state.active_route) return fail('no_active_route');
    if (state.corpus_restore && state.corpus_restore.needs_manual_choice) return fail('corpus_restore_requires_choice');
    if (flowStatus().stage !== 'playing') return fail('line_already_completed');
    cancelPending();
    const seg = runtime.corpusStatus(state);
    if (seg && seg.needs_manual_choice) return fail('corpus_restore_requires_choice');
    const tr = { v: 2, base_revision: state.revision, route_id: state.active_route.route_id,
      scene_id: state.active_route.scene_id, elapsed_minutes: 0, event_results: [],
      completed_scene_ids: [], sync_status: 'player_confirmed' };
    if (seg) { tr.segment_ack = seg.segment_index; tr.segment_node_id = seg.node_id; }
    else tr.completed_scene_ids = [state.active_route.scene_id];
    const r = runtime.reduceTurn(state, tr, { storeHistory: true });
    if (!r.ok) return fail('invalid_turn', { errors: r.errors });
    state = r.state;
    return { ok: true, state, ...committed('player_advance') };
  }
  function flowStatus() {
    const active = state.active_route;
    if (!active) return { stage: state.last_ending ? 'finished' : 'idle', ending: state.last_ending || null };
    const route = data.routeById[active.route_id], rp = state.route_progress[active.route_id] || {};
    const seg = runtime.corpusStatus(state);
    const atLast = active.scene_id === route.ordered_scene_ids.at(-1);
    const completed = atLast && (rp.completed_scene_ids || []).includes(active.scene_id) && (!seg || seg.is_last_segment);
    const finished = state.last_ending && state.last_ending.route_id === active.route_id && completed;
    const index = route.ordered_scene_ids.indexOf(active.scene_id);
    const next = data.sceneById[route.ordered_scene_ids[index + 1]];
    return { stage: finished ? 'finished' : completed ? 'ready_to_finish' : 'playing',
      segment_label: seg ? '本幕第 ' + (seg.segment_index + 1) + ' / ' + seg.segment_count + ' 段' : '本幕暂无分段原文',
      next_hint: seg && !seg.is_last_segment ? '下一步：本幕下一段' : next ? '下一幕：' + next.completion_criteria : '下一步：确认末段后结算本线',
      completed_scenes: (rp.completed_scene_ids || []).filter(id => route.ordered_scene_ids.includes(id)).length,
      total_scenes: route.ordered_scene_ids.length, ending: state.last_ending || null };
  }
  // v3 结束体验：结算/保存进度/回忆恢复/给出下一篇（不自动连续生成）。
  async function finishExperience(result) {
    if (busy) return fail('busy');
    if (destroyed || !syncChat()) return fail('no_current_chat');
    busy = true;
    try {
      const endingStatus = currentStatus();
      const endingRoute = data.routeById[state.active_route && state.active_route.route_id];
      const endingNode = runtime.corpusStatus(state);
      const endedProgress = state.route_progress[endingRoute && endingRoute.route_id] || {};
      const endedCount = endingRoute && endingRoute.ordered_scene_ids.filter(id => (endedProgress.completed_scene_ids || []).includes(id)).length;
      if (endingStatus) delete endingStatus.flow;
      const r = runtime.finishExperience(state, result);
      if (!r.ok) return fail(r.error);
      state = r.state;
      const done = endedCount;
      state.last_ending = { route_id: endingRoute.route_id, status: endingStatus,
        label: endingStatus.route_label, completed_scenes: done, total_scenes: endingRoute.ordered_scene_ids.length,
        summary: done === endingRoute.ordered_scene_ids.length ? '本线所有幕均已确认完成。' : '已体验到本线结尾；跳过或未确认的幕保持未完成。',
        final_goal: endingStatus.goal || endingNode && (endingNode.title || endingNode.act_name || endingNode.node_code),
        ending_node_id: endingNode && endingNode.node_id, source_locator: endingNode && endingNode.source_locator,
        memory_exited: r.memory_exited,
        next_entry: r.next_entry, chapter_complete: !!r.chapter_complete,
        revision: state.revision };
      const effects = committed('finish');
      return { ...r, ok: true, ...effects, state };
    } catch (e) { note('warnings', 'finish_failed:' + e.message); return fail('finish_failed', { detail: e.message }); }
    finally { busy = false; notify('idle'); }
  }
  function buildNavigation(options) { return runtime.buildNavigation(state, options); }
  async function generateOpeningOnce(opening) {
    if (busy) return { sent: false, reason: 'busy' };
    if (!syncChat() || destroyed) return { sent: false, reason: 'no_current_chat' };
    if (!opening || opening.base_revision !== state.revision || !state.active_route || opening.route_id !== state.active_route.route_id) return { sent: false, reason: 'stale_opening' };
    busy = true; notify('generating');
    const operationEpoch = epoch, t = token();
    try {
      const effects = refresh();
      await flushWorldbook();
      const result = effects.injected.injected ? await generateOpening(opening, t) : { sent: false, reason: effects.injected.reason };
      if (result.sent && tokenValid(t) && state.entered_routes[opening.route_id]) {
        state.entered_routes[opening.route_id].opening_pending = false;
        save();
      }
      return result;
    }
    finally { if (operationEpoch === epoch) { busy = false; notify('idle'); } }
  }

  function snapshotForMessage(messageId) {
    const sid = messageIndex[String(messageId)];
    if (sid && state.snapshots[sid]) return state.snapshots[sid];
    return (state.snapshot_order || []).slice().reverse().map(id => state.snapshots[id]).find(s => s && String(s.message_id) === String(messageId) && s.branch_id === state.branch_id) || null;
  }
  function originalSnapshot(messageId) {
    const version = messageVersions[String(messageId)];
    return version && state.snapshots[version.original_snapshot_id] || snapshotForMessage(messageId);
  }
  function processMessage(text, messageId, options = {}) {
    if (destroyed || !syncChat()) return fail('no_current_chat');
    const key = String(messageId), version = messageId != null ? messageVersions[key] : null;
    const ex = Protocol.extractTurnBlock(text);
    const snapshot = messageId != null ? originalSnapshot(messageId) : null;
    if (version && !version.pending && version.text === text && (options.swipe_id == null || version.swipe_id === options.swipe_id)) {
      const current = snapshotForMessage(messageId);
      return { ok: true, duplicate: true, turnSnapshot: current, statusView: current && runtime.renderTurnStatus(current), cleanText: ex.cleanText };
    }
    if (ex.parseError) { note('warnings', 'turn_parse_error:' + ex.parseError); return fail('parse_error', { error: ex.parseError, cleanText: ex.cleanText }); }
    let before = state;
    if (snapshot) {
      const original = snapshot.state_before;
      if (!original || original.branch_id !== state.branch_id || !state.active_route || !original.active_route || original.active_route.route_id !== state.active_route.route_id) return fail('historical_message_not_active_route');
      const restored = runtime.revertToSnapshot(state, snapshot.snapshot_id);
      if (!restored.ok) return fail(restored.error);
      before = restored.state;
    }
    // 普通模型偶尔漏掉控制块。此时只提交“零变化快照”：不猜经过时间、
    // 不推进节点、不结算关键事件，但让本条回复拥有可恢复的状态栏/人物快照。
    // 有控制块但JSON损坏或内容非法时仍拒绝，避免把未知变化误提交。
    const degraded = !ex.found;
    if (degraded && (!before.active_route || messageId == null)) return fail('no_turn_block', { cleanText: ex.cleanText, statusView: currentStatus() });
    const tr = degraded ? {
      v: 2, base_revision: before.revision,
      route_id: before.active_route.route_id, scene_id: before.active_route.scene_id,
      elapsed_minutes: 0, completed_scene_ids: [], event_results: [],
      sync_status: 'fallback_zero_delta'
    } : { ...ex.json, sync_status: 'model' };
    if (messageId != null) tr.message_id = messageId;
    // 明确暂停指令以玩家输入为准，防止模型照抄示例误确认演出完成。
    const userMessage = messageId != null && Number(messageId) > 0 ? readMessage(Number(messageId) - 1) : null;
    if (userMessage && userMessage.role === 'user' &&
        /不推进(?:剧情)?|保留当前段|停留当前段/.test(messageText(userMessage) || '')) {
      delete tr.segment_ack;
      tr.completed_scene_ids = [];
      tr.event_results = [];
      tr.elapsed_minutes = 0;
      tr.sync_status = 'explicit_hold';
    }
    if (tr.base_revision == null) tr.base_revision = before.revision;
    const r = runtime.reduceTurn(before, tr, { storeHistory: true });
    if (!r.ok) { note('warnings', 'turn_invalid:' + r.errors.join('|')); return fail('invalid_turn', { errors: r.errors, cleanText: ex.cleanText }); }
    state = r.state;
    if (messageId != null) {
      // 宿主楼层 id 是权威标识，0 也是合法楼层；不要保留核心的缺省消息名。
      r.turnSnapshot.message_id = messageId;
      messageIndex[key] = r.turnSnapshot.snapshot_id;
      messageVersions[key] = { text, swipe_id: options.swipe_id == null ? null : options.swipe_id,
        snapshot_id: r.turnSnapshot.snapshot_id, original_snapshot_id: snapshot ? snapshot.snapshot_id : r.turnSnapshot.snapshot_id,
        history: [...(version && version.history || []), r.turnSnapshot.snapshot_id], pending: false };
    }
    const effects = committed('commit');
    if (degraded) note('warnings', 'turn_block_missing:fallback_zero_delta');
    return { ok: true, degraded, reason: degraded ? 'fallback_zero_delta' : null, turnSnapshot: r.turnSnapshot, statusView: runtime.renderTurnStatus(r.turnSnapshot), cleanText: ex.cleanText, worldbookView: computeWorldbookView(), ...effects };
  }
  function getStatusForMessage(messageId) { const snap = snapshotForMessage(messageId); return snap ? runtime.renderTurnStatus(snap) : null; }
  function currentStatus() {
    if (!validChat()) return null;
    if (!state.active_route) {
      if (!state.last_ending) return null;
      const ending = state.last_ending.status;
      const snapshot = ending?.snapshot_id && state.snapshots[ending.snapshot_id];
      const portraits = snapshot ? runtime.renderTurnStatus(snapshot) : null;
      return { ...ending, ...(portraits ? { cast: portraits.cast, memory_cast: portraits.memory_cast } : {}),
        flow: flowStatus(), revision: state.revision };
    }
    const active = state.active_route;
    const snap = (state.snapshot_order || []).slice().reverse().map(id => state.snapshots[id]).find(s => s && s.revision === state.revision && s.branch_id === state.branch_id && s.chat_id === loadedChatId && s.route.route_id === active.route_id && s.route.scene_id === active.scene_id && (!s.route.performed_scene_id || s.route.performed_scene_id === active.scene_id));
    if (snap) return { ...runtime.renderTurnStatus(snap), flow: flowStatus() };
    // 不复用 entered_routes 中的旧 entryPlan：按当前运行态构建。
    const route = data.routeById[active.route_id], scene = data.sceneById[active.scene_id];
    const progress = state.route_progress[active.route_id] || {};
    const context = runtime.resolveSceneContext(state, active.scene_id);
    const cast = Object.entries(state.actor_scene_states || {}).map(([id, ast]) => ({ actor_id: id, canonical_name: ast.canonical_name, presence: 'onstage', state: ast,
      period_label: context.period_label, portrait_context: context,
      portrait: runtime.resolvePortrait(id, ast, { scene_time: active.scene_time, period_tags: context.period_tags, period_label: context.period_label }) }));
    return { ...runtime.renderTurnStatus({ snapshot_id: null, message_id: null, revision: state.revision,
      clock: { scene_time: active.scene_time, world_time: state.world_time },
      route: { route_id: active.route_id, story_id: route.story_id, scene_id: active.scene_id, scene_index: route.ordered_scene_ids.indexOf(active.scene_id), node_count: route.ordered_scene_ids.length },
      narrative_context: state.narrative_context,
      cast, mentioned: [], event_display: progress.last_event_display || runtime.selectEventDisplay(Core.state.cloneRunningState(state), { scene_time: active.scene_time, route_id: active.route_id, route_story_id: route.story_id }),
      progress: { current_goal_id: scene && scene.completion_criteria || progress.current_goal_id, brief: progress.brief } }), flow: flowStatus() };
  }
  function listNearby(options) { return runtime.listNearbyStories(state.active_route ? state.active_route.scene_time : state.world_time, options); }
  function revertToSnapshot(snapshotId) {
    if (busy || !syncChat()) return fail(busy ? 'busy' : 'no_current_chat');
    const r = runtime.revertToSnapshot(state, snapshotId);
    if (r.ok) {
      state = r.state;
      for (const v of Object.values(messageVersions)) if (v.snapshot_id === snapshotId || v.original_snapshot_id === snapshotId) v.pending = true;
      committed('revert');
    } else notify('failure');
    return r;
  }
  function forkBranch(newBranchId, atRevision) {
    if (busy || !syncChat()) return fail(busy ? 'busy' : 'no_current_chat');
    try { state = Persist.forkBranch(runtime, state, newBranchId, atRevision); messageIndex = {}; messageVersions = {}; committed('fork'); return { ok: true, state }; }
    catch (e) { return fail('fork_failed', { detail: e.message }); }
  }
  function reload() { stopOpeningGeneration(); epoch++; busy = false; regeneration = null; generationForFormatting = null; loadedChatId = host.chatId(); load(); refresh(); notify('reload'); return state; }
  function onHostEvent(name, args) {
    if (name === 'STREAM_TOKEN_RECEIVED') {
      if (replyTiming && replyTiming.first == null) replyTiming.first = Date.now();
      return;
    }
    if (name === 'CHAT_CHANGED') { replyTiming = null; generationForFormatting = null; reload(); return; }
    if (!syncChat()) return;
    if (name === 'GENERATION_ENDED' || name === 'GENERATION_STOPPED') {
      if (replyTiming) {
        const t = replyTiming;
        console.info('[ARK_STORY] 回复耗时（毫秒）', {
          剧情发送准备: t.ready == null ? null : t.ready - t.start,
          准备后至首段: t.ready == null || t.first == null ? null : t.first - t.ready,
          首段至结束: t.first == null ? null : Date.now() - t.first,
          生成事件总时长: Date.now() - t.start
        });
        replyTiming = null;
      }
      const formatToken = generationForFormatting;
      generationForFormatting = null;
      const tx = regeneration;
      regeneration = null;
      let restored = false;
      if (tx && tx.chatId === loadedChatId && tx.epoch === epoch && messageVersions[tx.messageId]?.pending && state.active_route?.route_id === tx.routeId) {
        // 没有新的合法版本提交：保留仍在显示的原回复所对应的完整状态。
        state = tx.state; messageIndex = tx.messageIndex; messageVersions = tx.messageVersions;
        restored = true;
        committed('regenerate_uncommitted_restored');
      }
      return name === 'GENERATION_ENDED' && !restored && formatToken ? repairLastDialogue(formatToken) : undefined;
    }
    if (name === 'GENERATION_AFTER_COMMANDS') {
      const [type, , dryRun] = args;
      if (dryRun) {
        applyWorldbookView();
        injectRules();
        return flushWorldbook();
      }
      generationForFormatting = !dryRun ? { ...token(), generationType: type, lastMessageId: readMessage(-1)?.message_id } : null;
      if (!dryRun && (type === 'regenerate' || type === 'swipe')) {
        const message = readMessage(-1);
        const snap = message && message.role === 'assistant' && originalSnapshot(message.message_id);
        if (snap && snap.state_before && state.active_route && snap.state_before.active_route && snap.state_before.active_route.route_id === state.active_route.route_id) {
          const r = runtime.revertToSnapshot(state, snap.snapshot_id);
          if (r.ok) {
            regeneration = { state: clone(state), messageIndex: clone(messageIndex), messageVersions: clone(messageVersions), chatId: loadedChatId, epoch, routeId: state.active_route.route_id, messageId: String(message.message_id) };
            state = r.state; const v = messageVersions[String(message.message_id)]; if (v) v.pending = true; save(); notify('regenerate');
          }
        }
      }
      const timing = { start: Date.now(), first: null, ready: null };
      replyTiming = timing;
      refresh(); return flushWorldbook().then(result => { timing.ready = Date.now(); return result; });
    }
    if (name === 'CHARACTER_MESSAGE_RENDERED' && host.g.getLastMessageId) {
      // Scrolling or reopening the chat may render old replies. Only a real
      // edit/swipe event should change the state associated with those rows.
      const last = host.g.getLastMessageId();
      if (last != null && String(args[0]) !== String(last)) return;
    }
    const message = readMessage(args[0]);
    if (!message || message.role !== 'assistant') return;
    const text = messageText(message);
    if (typeof text === 'string') processMessage(text, message.message_id, { swipe_id: message.swipe_id });
  }
  function init() {
    if (initialized || destroyed) return diagnostics();
    initialized = true;
    for (const name of ['CHAT_CHANGED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED']) {
      try {
        const off = host.on(name, (...args) => { try {
          const result = onHostEvent(name, args);
          if (result && typeof result.then === 'function') return result.catch(e => { note('warnings', 'listener_error:' + name + ':' + e.message); notify('failure'); throw e; });
          return result;
        } catch (e) { note('warnings', 'listener_error:' + name + ':' + e.message); notify('failure'); } });
        if (off) unsubs.push(off);
      } catch (e) { note('warnings', 'listener_registration_failed:' + name); }
    }
    refresh();
    return diagnostics();
  }
  function stop(off) { try { if (off && typeof off.stop === 'function') off.stop(); else if (typeof off === 'function') off(); } catch (e) {} }
  function destroy() {
    stopOpeningGeneration();
    destroyed = true; epoch++;
    for (const off of unsubs) stop(off);
    stop(projectionOff); projectionOff = null; projection.registered = false; unsubs.length = 0;
    try { if (host.uninject) host.uninject(INJECTION_IDS); else if (host.g.uninjectPrompts) host.g.uninjectPrompts(INJECTION_IDS); } catch (e) {}
    listeners.clear();
  }
  function diagnostics() {
    return { schema_version: state.schema_version, data_version: data.data_version, host_integration: 'unverified', host_capabilities: host.capabilities,
      chat_id: loadedChatId, busy, worldbook_projection: { ...projection }, worldbook_sync: { ...physical.status },
      counts: { routes: data.routes.length, scenes: data.scenes.length, stories: data.stories.length, events: data.events.length, actors: Object.keys(data.actorById).length, portraits: data.portraits.length },
      active_route: state.active_route ? state.active_route.route_id : null, revision: state.revision,
      narrative_context: state.narrative_context ? { kind: state.narrative_context.kind, memory_id: state.narrative_context.memory_id || null } : null,
      snapshots: (state.snapshot_order || []).length, ledger: Object.keys(state.event_ledger || {}).length,
      applied: diag.applied.slice(), pending: diag.pending.slice(), warnings: diag.warnings.slice() };
  }
  // 旧存档无法按稳定节点 ID 匹配时，由玩家显式选择续点；不静默猜测位置。
  function resolveCorpusRestore(choice) {
    if (!state.active_route) return fail('no_active_route');
    if (choice === 'keep') {
      state.corpus_restore = { needs_manual_choice: false, restored: 'player_kept_original', summary_only: true };
      const effects = committed('corpus_restore_keep');
      return { ok: true, choice, ...effects };
    }
    return fail('unknown_restore_choice');
  }
  return { runtime, host, data, getState: () => state, isBusy: () => busy,
    cancelPending, jumpToScene, advanceCurrentSegment, flushWorldbook, resetWorldbook,
    setState: s => { if (busy || s.chat_id !== loadedChatId) return false; state = clone(s); committed('set_state'); return true; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    enterRoute, exitRoute, enterExperience, finishExperience, buildNavigation, processMessage, computeWorldbookView, applyWorldbookView, buildOpening, buildInjection, injectRules, generateOpeningOnce, resolveCorpusRestore,
    getStatusForMessage, currentStatus, snapshotForMessage, listNearby, revertToSnapshot, forkBranch, reload, init, destroy, diagnostics, RULES_ENTRY_NAME };
}

const api = { createStoryAdapter, RULES_ENTRY_NAME, INJECTION_ID };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_ADAPTER__ = api; }

