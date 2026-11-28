'use strict';

// ASTER 切片 2 / 任务 3-4：可见生成结果中的机器可读摘要解析与增量嵌合。
// 约定：可见回复末尾可携带
//   <!--ARK_ARCHIVE_SUMMARY
//   { "characters": [ { "character_id": "...", "no_change": false, "sections": {...}, "actions": [...] } ] }
//   -->
// 边界必须能从原始完整结果读取，不依赖渲染后可见正文。

const SUMMARY_OPEN = '<!--ARK_ARCHIVE_SUMMARY';
const SUMMARY_CLOSE = '-->';

const SECTION_TITLES = [
  '基本信息', '外貌', '服装', '武器', '特点', '源石技艺', '能力',
  '喜欢', '讨厌', '经历', '人际关系', '语言示例', '秘密', '备注'
];

const PRIMARY_SECTIONS = ['经历', '人际关系', '特点', '备注'];

const INTERNAL_SOURCES = new Set([
  'internal', 'generateRaw', 'generateraw', 'design', 'summarize', 'summary', 'merge', 'timeline_merge'
]);

function isInternalSource(source) {
  if (source == null) return false;
  return INTERNAL_SOURCES.has(String(source));
}

function extractSummaryBlock(rawText) {
  if (typeof rawText !== 'string' || !rawText) return { ok: false, reason: 'empty' };
  const open = rawText.lastIndexOf(SUMMARY_OPEN);
  if (open < 0) return { ok: false, reason: 'missing' };
  const afterOpen = rawText.indexOf(SUMMARY_CLOSE, open + SUMMARY_OPEN.length);
  if (afterOpen < 0) return { ok: false, reason: 'unterminated' };
  const body = rawText.slice(open + SUMMARY_OPEN.length, afterOpen).trim();
  if (!body) return { ok: false, reason: 'empty_body' };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { ok: false, reason: 'bad_json', error: e.message };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'bad_shape' };
  return { ok: true, data: parsed, raw: body, start: open, end: afterOpen + SUMMARY_CLOSE.length };
}

function normalizeSectionName(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  return SECTION_TITLES.indexOf(t) >= 0 ? t : null;
}

function normalizeSections(sections) {
  const out = {};
  if (!sections || typeof sections !== 'object') return out;
  for (const key of Object.keys(sections)) {
    const title = normalizeSectionName(key);
    if (!title) continue;
    const v = sections[key];
    if (v == null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) out[title] = s;
    } else if (Array.isArray(v)) {
      const arr = v.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      if (arr.length) out[title] = arr;
    }
  }
  return out;
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const situation = typeof a.situation === 'string' ? a.situation.trim() : '';
    const behavior = typeof a.behavior === 'string' ? a.behavior.trim() : '';
    if (!situation && !behavior) continue;
    const result = typeof a.result === 'string' ? a.result.trim() : '';
    const resultKind = ['完成', '失败', '受阻', '未决'].indexOf(result) >= 0 ? result : '未决';
    out.push({
      situation,
      behavior,
      target: typeof a.target === 'string' ? a.target.trim() : '',
      result: resultKind,
      known_info: typeof a.known_info === 'string' ? a.known_info.trim() : '',
      promise: typeof a.promise === 'string' ? a.promise.trim() : '',
      lasting_effect: typeof a.lasting_effect === 'string' ? a.lasting_effect.trim() : '',
      related_facts: Array.isArray(a.related_facts) ? a.related_facts.slice() : []
    });
  }
  return out;
}

// 校验归属：只允许已确认关联的角色 id。
function resolveCharacterId(entry, allowedIds) {
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.character_id != null ? String(entry.character_id) : null;
  if (!id) return null;
  if (allowedIds && allowedIds.size > 0 && !allowedIds.has(id)) return null;
  return id;
}

function parseArchiveSummary(rawText, options) {
  const r = parseAndValidate(rawText, options);
  if (!r.ok) return r;
  return { ok: true, characters: r.accepted, rejected: r.rejected, block: r.block };
}

function buildIdempotencyKey(chatId, messageId, branchId) {
  return [String(chatId == null ? '' : chatId), String(messageId == null ? '' : messageId), String(branchId == null ? '' : branchId)].join('|');
}

// 将增量嵌合进现有动态层。不覆盖底板，不改固定标题。
function mergeIncrement(existingDynamic, sections) {
  const base = existingDynamic && typeof existingDynamic === 'object' ? existingDynamic : {};
  const out = Object.assign({}, base);
  for (const title of Object.keys(sections)) {
    const inc = sections[title];
    const prev = out[title];
    if (Array.isArray(inc)) {
      const prevArr = Array.isArray(prev) ? prev.slice() : (typeof prev === 'string' && prev ? [prev] : []);
      const seen = new Set(prevArr.map(x => String(x)));
      for (const item of inc) {
        const s = String(item);
        if (!seen.has(s)) { prevArr.push(s); seen.add(s); }
      }
      out[title] = prevArr;
    } else if (typeof inc === 'string') {
      if (typeof prev === 'string' && prev.trim()) {
        if (prev.indexOf(inc) >= 0) {
          out[title] = prev;
        } else {
          out[title] = prev + '\n' + inc;
        }
      } else if (Array.isArray(prev)) {
        if (prev.map(x => String(x)).indexOf(inc) < 0) out[title] = prev.concat([inc]);
        else out[title] = prev;
      } else {
        out[title] = inc;
      }
    }
  }
  return out;
}

function parseAndValidate(rawText, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const allowedIds = opts.allowedCharacterIds instanceof Set
    ? opts.allowedCharacterIds
    : new Set(Array.isArray(opts.allowedCharacterIds) ? opts.allowedCharacterIds.map(String) : []);
  const block = extractSummaryBlock(rawText);
  if (!block.ok) return { ok: false, reason: block.reason, error: block.error };
  const data = block.data;
  const list = Array.isArray(data.characters) ? data.characters : [];
  const accepted = [];
  const rejected = [];
  for (const entry of list) {
    const id = resolveCharacterId(entry, allowedIds);
    if (!id) { rejected.push({ reason: 'unattributed', entry }); continue; }
    const noChange = entry.no_change === true;
    const sections = normalizeSections(entry.sections);
    const actions = normalizeActions(entry.actions);
    if (noChange && Object.keys(sections).length === 0 && actions.length === 0) {
      accepted.push({ character_id: id, no_change: true, sections: {}, actions: [] });
      continue;
    }
    if (Object.keys(sections).length === 0 && actions.length === 0) {
      rejected.push({ reason: 'empty_entry', character_id: id });
      continue;
    }
    accepted.push({ character_id: id, no_change: false, sections, actions });
  }
  return { ok: true, accepted, rejected, block };
}

module.exports = {
  SUMMARY_OPEN,
  SUMMARY_CLOSE,
  SECTION_TITLES,
  PRIMARY_SECTIONS,
  INTERNAL_SOURCES,
  isInternalSource,
  extractSummaryBlock,
  normalizeSectionName,
  normalizeSections,
  normalizeActions,
  resolveCharacterId,
  buildIdempotencyKey,
  mergeIncrement,
  parseAndValidate,
  parseArchiveSummary
};
