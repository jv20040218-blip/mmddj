'use strict';

// ASTER 切片 2 / 任务 5：角色行动整理。
// 与十四段共享有效事实；失败不记成功；承诺未兑现不记完成。

const sidecar = require('./sidecar.js');

const RESULT_KINDS = ['完成', '失败', '受阻', '未决'];

function normalizeResult(result) {
  const r = typeof result === 'string' ? result.trim() : '';
  return RESULT_KINDS.indexOf(r) >= 0 ? r : '未决';
}

function buildActionRecord(input, context) {
  const src = input && typeof input === 'object' ? input : {};
  const ctx = context && typeof context === 'object' ? context : {};
  return {
    character_id: ctx.characterId != null ? String(ctx.characterId) : null,
    situation: typeof src.situation === 'string' ? src.situation.trim() : '',
    behavior: typeof src.behavior === 'string' ? src.behavior.trim() : '',
    target: typeof src.target === 'string' ? src.target.trim() : '',
    result: normalizeResult(src.result),
    known_info: typeof src.known_info === 'string' ? src.known_info.trim() : '',
    promise: typeof src.promise === 'string' ? src.promise.trim() : '',
    lasting_effect: typeof src.lasting_effect === 'string' ? src.lasting_effect.trim() : '',
    related_facts: Array.isArray(src.related_facts) ? src.related_facts.slice() : [],
    source_message_id: ctx.messageId != null ? String(ctx.messageId) : null,
    source_branch_id: ctx.branchId != null ? String(ctx.branchId) : null,
    source_chat_id: ctx.chatId != null ? String(ctx.chatId) : null,
    sequence: ctx.sequence != null ? Number(ctx.sequence) : null,
    idempotency_key: ctx.idempotencyKey || null
  };
}

function hasActionWithKey(sidecarObj, characterId, idempotencyKey) {
  const list = sidecar.actionList(sidecarObj, characterId);
  if (!idempotencyKey) return false;
  return list.some(a => a && a.idempotency_key === idempotencyKey);
}

function appendActions(sidecarObj, characterId, actions, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const appended = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    const record = buildActionRecord(a, Object.assign({ characterId }, ctx));
    if (!record.situation && !record.behavior) continue;
    if (record.idempotency_key && hasActionWithKey(sidecarObj, characterId, record.idempotency_key)) continue;
    const entry = sidecar.appendAction(sidecarObj, characterId, record);
    if (entry) appended.push(entry);
  }
  return appended;
}

function invalidateForBranch(sidecarObj, characterId, messageId, branchId, reason) {
  return sidecar.invalidateActionsByMessage(sidecarObj, characterId, messageId, branchId, reason || 'branch_replaced');
}

function invalidateAfterRollback(sidecarObj, characterId, rollbackPoint) {
  return sidecar.invalidateActionsAfterRollback(sidecarObj, characterId, rollbackPoint);
}

function listEffective(sidecarObj, characterId) {
  return sidecar.actionList(sidecarObj, characterId);
}

module.exports = {
  RESULT_KINDS,
  normalizeResult,
  buildActionRecord,
  appendActions,
  invalidateForBranch,
  invalidateAfterRollback,
  listEffective
};
