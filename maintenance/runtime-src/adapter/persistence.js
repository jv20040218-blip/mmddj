// 持久化：会话状态存聊天范围变量；每条消息映射到独立TurnSnapshot；分支从分歧点fork。
// 优先聊天变量API；缺失时回退按chat_id隔离的localStorage（宿主集成未验证时可见诊断）。
// v3：存储信封名保持 ark_story_v2（兼容旧聊天变量键），状态 schema_version=3；
// migrateSave 幂等迁移 v2→v3：补齐作用域/体验进度字段，并按事件账本重建带时间来源的人物效果，
// 旧快照（state_before/state_after）一并迁移，历史回看与重生成不受影响。
'use strict';

const KEY = 'ark_story_v2';

// 幂等迁移：v2→v3。重复执行结果相同；不丢失旧快照、进度与稳定ID。
function migrateSave(oldState, data) {
  if (!oldState || typeof oldState !== 'object') return oldState;
  const s = JSON.parse(JSON.stringify(oldState));
  const events = (data && data.events) || [];
  const eventById = {};
  for (const e of events) eventById[e.event_id] = e;

  function migrateRunning(st) {
    if (!st || typeof st !== 'object') return st;
    if (!st.narrative_context) st.narrative_context = { kind: 'story', scope_id: 'main', memory_id: null, return_context: null };
    if (!st.experience_progress) st.experience_progress = {};
    if (!st.memory_scopes) st.memory_scopes = {};
    if (!st.memory_progress) st.memory_progress = {};
    if (!Array.isArray(st.hidden_message_ids)) st.hidden_message_ids = [];
    if (!st.segment_entry_snapshots || typeof st.segment_entry_snapshots !== 'object') st.segment_entry_snapshots = {};
    if (!st.scene_experience || typeof st.scene_experience !== 'object') st.scene_experience = {};
    if (!st.ui_settings || typeof st.ui_settings !== 'object') st.ui_settings = { act_summary_injection: false, inspect_hidden_floors: false };
    if (st.ui_settings.act_summary_injection == null) st.ui_settings.act_summary_injection = false;
    if (st.ui_settings.inspect_hidden_floors == null) st.ui_settings.inspect_hidden_floors = false;
    if (!st.lore_mode) st.lore_mode = 'baseline';
    if (!Object.prototype.hasOwnProperty.call(st, 'clone_book')) st.clone_book = st.book || null;
    if (st.sidecar_rev == null) st.sidecar_rev = 0;
    if (!Object.prototype.hasOwnProperty.call(st, 'clone_warning')) st.clone_warning = null;
    // 旧格式人物效果（无时间来源）→按当前分支账本重建来源时间，供早期篇章投影排除未来事实。
    if (st.facts && st.facts.actor_effects && st.event_ledger) {
      const branchId = st.branch_id;
      const ledgerEntries = Object.values(st.event_ledger).filter(l => l && l.branch_id === branchId);
      ledgerEntries.sort((a, b) => {
        const ao = a.occurred_at && a.occurred_at.ordinal_minute, bo = b.occurred_at && b.occurred_at.ordinal_minute;
        return (ao == null ? 0 : ao) - (bo == null ? 0 : bo);
      });
      const rebuilt = {};
      for (const led of ledgerEntries) {
        const ev = eventById[led.event_id];
        if (!ev || !ev.proposed_effect || !(ev.actor_ids || []).length) continue;
        const eff = ev.proposed_effect;
        for (const aid of ev.actor_ids) {
          if (!rebuilt[aid]) rebuilt[aid] = { capabilities: [], availability: null, flags: [], capability_sources: [], availability_history: [], control_history: [], flag_sources: [] };
          const ae = rebuilt[aid];
          if (eff.dimension === 'capabilities' && eff.operation === 'add' && !ae.capabilities.includes(eff.value)) {
            ae.capabilities.push(eff.value);
            ae.capability_sources.push({ value: eff.value, occurred_at: led.occurred_at, event_id: ev.event_id });
          }
          if (eff.dimension === 'availability') {
            ae.availability = eff.value;
            ae.availability_history.push({ value: eff.value, occurred_at: led.occurred_at, event_id: ev.event_id });
          }
          if (eff.dimension === 'control') {
            ae.control = eff.value;
            ae.control_history.push({ value: eff.value, occurred_at: led.occurred_at, event_id: ev.event_id });
          }
          if (eff.dimension === 'flag' && !ae.flags.includes(eff.value)) {
            ae.flags.push(eff.value);
            ae.flag_sources.push({ value: eff.value, occurred_at: led.occurred_at, event_id: ev.event_id });
          }
        }
      }
      // 保留账本无法解释的旧效果（例如外部setState注入），不静默丢弃。
      for (const [aid, old] of Object.entries(st.facts.actor_effects)) {
        if (!rebuilt[aid]) { rebuilt[aid] = old; continue; }
        const r = rebuilt[aid];
        for (const cap of (old.capabilities || [])) if (!r.capabilities.includes(cap)) {
          r.capabilities.push(cap);
          r.capability_sources.push({ value: cap, occurred_at: null, event_id: null, legacy: true });
        }
        if (old.availability != null && !r.availability_history.length) {
          r.availability = old.availability;
          r.availability_history.push({ value: old.availability, occurred_at: null, event_id: null, legacy: true });
        }
        for (const fl of (old.flags || [])) if (!r.flags.includes(fl)) {
          r.flags.push(fl);
          r.flag_sources.push({ value: fl, occurred_at: null, event_id: null, legacy: true });
        }
      }
      st.facts.actor_effects = rebuilt;
    }
    st.schema_version = 3;
    return st;
  }

  migrateRunning(s);
  // 历史快照内的运行态一并迁移（历史库不回滚，迁移不改快照ID/顺序）。
  if (s.snapshots) {
    for (const snap of Object.values(s.snapshots)) {
      if (!snap) continue;
      if (snap.state_before) migrateRunning(snap.state_before);
      if (snap.state_after) migrateRunning(snap.state_after);
    }
  }
  return s;
}

// On disk each historical state refers to shared values. Large maps share
// individual rows, so appending one event does not copy the whole ledger.
const SHARED_MAPS = new Set(['event_ledger', 'entered_routes', 'route_progress', 'facts',
  'corpus_progress', 'experience_progress', 'memory_scopes', 'segment_entry_snapshots', 'scene_experience']);
function createSnapshotCodec() {
  let pool = [], index = new Map(), encoded = new WeakMap();
  function intern(value) {
    const key = JSON.stringify(value);
    if (index.has(key)) return index.get(key);
    const id = pool.length;
    pool.push(JSON.parse(key));
    index.set(key, id);
    return id;
  }
  function packState(state) {
    return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined).map(([key, value]) => {
      if (SHARED_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        const ids = Object.fromEntries(Object.entries(value).filter(([, row]) => row !== undefined).map(([id, row]) => [id, intern(row)]));
        return [key, intern(ids)];
      }
      return [key, intern(value)];
    }));
  }
  function pack(snapshots) {
    const records = Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => {
      if (!encoded.has(snapshot)) {
        const record = { ...snapshot };
        for (const key of ['state_before', 'state_after']) {
          if (record[key]) record[key] = packState(record[key]);
        }
        encoded.set(snapshot, record);
      }
      return [id, encoded.get(snapshot)];
    }));
    return { version: 1, pool: pool.slice(), records };
  }
  function unpack(store) {
    if (!store || store.version !== 1 || !Array.isArray(store.pool) || !store.records || Array.isArray(store.records)) {
      throw new Error('unsupported_snapshot_storage');
    }
    const copied = JSON.parse(JSON.stringify(store.pool));
    const read = id => {
      if (!Number.isInteger(id) || id < 0 || id >= copied.length) throw new Error('invalid_snapshot_reference');
      return copied[id];
    };
    const sharedMaps = new Map();
    function unpackState(fields) {
      return Object.fromEntries(Object.entries(fields).map(([key, id]) => {
        const value = read(id);
        if (!SHARED_MAPS.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
        if (!sharedMaps.has(id)) {
          sharedMaps.set(id, Object.freeze(Object.fromEntries(Object.entries(value).map(([row, ref]) => [row, read(ref)]))));
        }
        return [key, sharedMaps.get(id)];
      }));
    }
    // Historical states are read-only. Restore/fork copy the selected state
    // before mutating it. Keeping shared values here saves browser memory.
    function freeze(value) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    }
    const snapshots = Object.fromEntries(Object.entries(store.records).map(([id, record]) => {
      const snapshot = JSON.parse(JSON.stringify(record));
      for (const key of ['state_before', 'state_after']) {
        if (snapshot[key]) snapshot[key] = unpackState(snapshot[key]);
      }
      encoded.set(snapshot, record);
      return [id, snapshot];
    }));
    copied.forEach(freeze);
    pool = copied;
    index = new Map(pool.map((value, id) => [JSON.stringify(value), id]));
    return snapshots;
  }
  return { pack, unpack };
}

function loadBundle(host) {
  const vars = host.readChatVars(host.chatId());
  const b = vars && vars[KEY];
  if (b?.state?.schema_version === 4) {
    return { ...b, state: { ...b.state, schema_version: 3, snapshots: createSnapshotCodec().unpack(b.snapshot_store) } };
  }
  if (b && b.state && (b.state.schema_version === 2 || b.state.schema_version === 3)) {
    return b;
  }
  return null;
}

function loadState(host, runtime) {
  const b = loadBundle(host);
  if (b) return b.state.schema_version === 3 ? b.state : migrateSave(b.state, runtime && runtime.data);
  return runtime.createState({ chat_id: host.chatId(), branch_id: 'branch_1' });
}

function saveState(host, state, messageIndex) {
  const vars = host.readChatVars(host.chatId()) || {};
  vars[KEY] = { state, message_index: messageIndex || {}, saved_at: Date.now() };
  return host.writeChatVars(host.chatId(), vars);
}

function getMessageIndex(host) { const b = loadBundle(host); return (b && b.message_index) || {}; }

function snapshotForMessage(state, messageId) {
  const id = Object.keys(state.snapshots).find(k => state.snapshots[k].message_id === messageId);
  return id ? state.snapshots[id] : null;
}

// fork复制完整运行态和历史；历史仍归属原分支，运行账本按新分支去重。
// 回忆作用域中fork→标注独立改写分支，不静默合并到当前主线。
function forkBranch(runtime, state, newBranchId, atRevision) {
  const revision = atRevision == null ? state.revision : atRevision;
  let source = revision === state.revision ? state : null;
  if (!source && Number.isInteger(revision) && revision >= 0) {
    // 同revision存在重生成版本时取最新完整运行态；继承的祖先历史也可分歧。
    for (const id of (state.snapshot_order || []).slice().reverse()) {
      const snap = state.snapshots[id];
      if (!snap) continue;
      source = [snap.state_after, snap.state_before].find(s => s && s.revision === revision && s.branch_id === snap.branch_id);
      if (source) break;
    }
  }
  if (!source) throw new RangeError('unknown_revision:' + revision);
  const { snapshots, snapshot_order, ...running } = source;
  const ns = JSON.parse(JSON.stringify({ ...running, snapshots: state.snapshots, snapshot_order: state.snapshot_order }));
  ns.branch_id = newBranchId;
  ns.event_ledger = {};
  for (const entry of Object.values(source.event_ledger || {})) {
    if (entry.branch_id !== source.branch_id) continue;
    ns.event_ledger[newBranchId + '|' + entry.event_id] = Object.assign(JSON.parse(JSON.stringify(entry)), { branch_id: newBranchId });
  }
  ns.forked_from = { branch_id: state.branch_id, at_revision: revision };
  if (source.narrative_context && source.narrative_context.kind === 'memory') {
    ns.memory_rewrite_branch = { memory_id: source.narrative_context.memory_id, note: '玩家在回忆中直接参与过去形成的独立改写分支；不静默合并到当前主线' };
  }
  return ns;
}

const api = { KEY, migrateSave, loadBundle, loadState, saveState, getMessageIndex, snapshotForMessage, forkBranch, createSnapshotCodec };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_ADAPTER_PERSIST__ = api; }
