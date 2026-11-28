'use strict';

// Chapter adaptation table for the three chapters confirmed by the Sol guide.
// Only exact, explicitly confirmed targets are listed here. Anything not in
// this table must NOT be treated as adapted, and no form may be guessed.
//
// Matching is by full character name (exact string equality after trim) and
// by full comment primary key. NEVER substring-match.

const keys = (typeof require === 'function')
  ? require('./keys.js')
  : (typeof globalThis !== 'undefined' ? globalThis.__ARK_CWB_KEYS__ : null);

function trim(value) {
  return String(value == null ? '' : value).trim();
}

// ---------------------------------------------------------------------------
// Adapted chapter set (exactly these three, nothing else)
// ---------------------------------------------------------------------------

const ADAPTED_CHAPTERS = ['雪原线', '时间啊，向前！', '孤星'];

function adaptedChapters() {
  return ADAPTED_CHAPTERS.slice();
}

function isAdapted(chapter) {
  const name = trim(chapter);
  if (!name) return false;
  return ADAPTED_CHAPTERS.indexOf(name) !== -1;
}

// ---------------------------------------------------------------------------
// Target tables. Each entry: { character, comment_pk, label, note }
// comment_pk is the full Sol primary key, preserving the space after the colon.
// ---------------------------------------------------------------------------

// 《雪原线》 — only the two explicit snowfield suffixes plus Talulah's
// scene-conditional rule. Talulah's snowfield target is the same斗士 entry as
// her daily default; it is only switched when the current scene binding says so.
const SNOWFIELD_TARGETS = [
  {
    character: '霜星',
    comment_pk: '[角色]:霜星(雪原,与本格选一开)',
    label: '雪原',
    note: '仅当当前场景确实需要霜星且角色未被保护时切换'
  },
  {
    character: '爱国者',
    comment_pk: '[角色]:爱国者(雪原,与本格、博卓卡斯替选一开)',
    label: '雪原',
    note: '仅当当前场景确实需要爱国者且角色未被保护时切换'
  },
  {
    character: '塔露拉',
    comment_pk: '[角色]:塔露拉(斗士,与幼年、黑蛇、新整合运动选一开)',
    label: '斗士',
    note: '雪原斗士场景对应目标；须与现行场景绑定核对，不覆盖明确的幼年或其他回忆绑定'
  }
];

// 《时间啊，向前！》 — 35 explicit chapter character entries.
const TIME_FORWARD_TARGETS = [
  { character: '瓦莲汀·沃尔金娜', comment_pk: '[角色]: 瓦莲汀·沃尔金娜（剧情·时间啊，向前！·25）', label: '本篇', note: '无独立通用条目' },
  { character: '拉夫连·卡尔诺夫', comment_pk: '[角色]: 拉夫连·卡尔诺夫（剧情·时间啊，向前！·26）', label: '本篇', note: '无独立通用条目' },
  { character: '雅罗米尔', comment_pk: '[角色]: 雅罗米尔（剧情·时间啊，向前！·27）', label: '本篇', note: '无独立通用条目' },
  { character: '罗季昂', comment_pk: '[角色]: 罗季昂（剧情·时间啊，向前！·28）', label: '本篇', note: '无独立通用条目' },
  { character: '卡特琳娜', comment_pk: '[角色]: 卡特琳娜（剧情·时间啊，向前！·29）', label: '本篇', note: '别名关联候选（乔万娜关键词含卡特琳娜），需核对现行身份标识' },
  { character: '西尔卡', comment_pk: '[角色]: 西尔卡（剧情·时间啊，向前！·30）', label: '本篇', note: '通用来源 [角色]:西尔卡' },
  { character: '斯韦特兰纳', comment_pk: '[角色]: 斯韦特兰纳（剧情·时间啊，向前！·31）', label: '本篇', note: '通用来源 [角色]:斯韦特兰纳' },
  { character: '叶甫根尼', comment_pk: '[角色]: 叶甫根尼（剧情·时间啊，向前！·32）', label: '本篇', note: '通用来源 [角色]:叶甫根尼' },
  { character: '雷尔金', comment_pk: '[角色]: 雷尔金（剧情·时间啊，向前！·33）', label: '本篇', note: '通用来源 [角色]:雷尔金' },
  { character: '希尔达', comment_pk: '[角色]: 希尔达（剧情·时间啊，向前！·34）', label: '本篇', note: '通用来源 [角色]:希尔达' },
  { character: '纳斯塔霞', comment_pk: '[角色]: 纳斯塔霞（剧情·时间啊，向前！·35）', label: '本篇', note: '通用来源 [角色]:纳斯塔霞' },
  { character: '叶莉莎女大公', comment_pk: '[角色]: 叶莉莎女大公（剧情·时间啊，向前！·36）', label: '本篇', note: '明示别名 叶莉莎女大公 / 叶莉莎' },
  { character: '尼克托', comment_pk: '[角色]: 尼克托（剧情·时间啊，向前！·37）', label: '本篇', note: '通用来源 [角色]:尼克托' },
  { character: '维特', comment_pk: '[角色]: 维特（剧情·时间啊，向前！·38）', label: '本篇', note: '只选本篇，不能选遗尘漫步同名条目' },
  { character: '凛冬', comment_pk: '[角色]: 凛冬（剧情·时间啊，向前！·39）', label: '本篇', note: '现行凛冬互斥组，日常默认本格' },
  { character: '费奥多尔', comment_pk: '[角色]: 费奥多尔（剧情·时间啊，向前！·40）', label: '本篇', note: '通用来源 [角色]:费奥多尔' },
  { character: '阿洛伊泽', comment_pk: '[角色]: 阿洛伊泽（剧情·时间啊，向前！·41）', label: '本篇', note: '通用来源 [角色]:阿洛伊泽' },
  { character: '奥尔佳', comment_pk: '[角色]: 奥尔佳（剧情·时间啊，向前！·42）', label: '本篇', note: '通用来源 [角色]:奥尔佳' },
  { character: '安托沙', comment_pk: '[角色]: 安托沙（剧情·时间啊，向前！·43）', label: '本篇', note: '通用来源 [角色]:安托沙' },
  { character: '九', comment_pk: '[角色]: 九（剧情·时间啊，向前！·44）', label: '本篇', note: '通用来源 [角色]:九；不得与九色鹿或雪原九线合并' },
  { character: '雷德', comment_pk: '[角色]: 雷德（剧情·时间啊，向前！·45）', label: '本篇', note: '通用来源 [角色]:雷德；不与红合并' },
  { character: '米拉娜', comment_pk: '[角色]: 米拉娜（剧情·时间啊，向前！·46）', label: '本篇', note: '明示别名 米拉娜 / “伊凡·图林”' },
  { character: '塔露拉', comment_pk: '[角色]: 塔露拉（剧情·时间啊，向前！·47）', label: '本篇', note: '现行塔露拉互斥组，日常默认斗士' },
  { character: 'Raidian', comment_pk: '[角色]: Raidian（剧情·时间啊，向前！·48）', label: '本篇', note: '通用来源 [角色]:Raidian' },
  { character: 'Mantra', comment_pk: '[角色]: Mantra（剧情·时间啊，向前！·49）', label: '本篇', note: '通用来源 [角色]:Mantra' },
  { character: '卡德尔', comment_pk: '[角色]: 卡德尔（剧情·时间啊，向前！·50）', label: '本篇', note: '无独立通用条目；不与卡铎尔合并' },
  { character: '奥妮拉', comment_pk: '[角色]: 奥妮拉（剧情·时间啊，向前！·51）', label: '本篇', note: '无独立通用条目' },
  { character: '塔拉斯', comment_pk: '[角色]: 塔拉斯（剧情·时间啊，向前！·52）', label: '本篇', note: '无独立通用条目' },
  { character: '弑君者', comment_pk: '[角色]: 弑君者（剧情·时间啊，向前！·53）', label: '本篇', note: '通用来源 [角色]:弑君者' },
  { character: '赫拉格', comment_pk: '[角色]: 赫拉格（剧情·时间啊，向前！·54）', label: '本篇', note: '通用来源 [角色]:赫拉格' },
  { character: '维伊', comment_pk: '[角色]: 维伊（剧情·时间啊，向前！·55）', label: '本篇', note: '通用来源 [角色]:维伊' },
  { character: '折桠', comment_pk: '[角色]: 折桠（剧情·时间啊，向前！·56）', label: '本篇', note: '通用来源 [角色]:折桠' },
  { character: '卡谢娜', comment_pk: '[角色]: 卡谢娜（剧情·时间啊，向前！·57）', label: '本篇', note: '通用来源 [角色]:卡谢娜；不与黑蛇/科西切合并' },
  { character: '谢尔戈', comment_pk: '[角色]: 谢尔戈（剧情·时间啊，向前！·58）', label: '本篇', note: '无独立通用条目' },
  { character: '奥列格', comment_pk: '[角色]: 奥列格（剧情·时间啊，向前！·59）', label: '本篇', note: '无独立通用条目' }
];

// 《孤星》 — 6 explicit chapter character entries.
const LONE_STAR_TARGETS = [
  { character: '洛肯·威廉姆斯', comment_pk: '[角色]: 洛肯·威廉姆斯（剧情·孤星·11）', label: '本篇', note: '无独立通用条目；只使用完整姓名，不合并到杰斯顿等' },
  { character: '布莱克上校', comment_pk: '[角色]: 布莱克上校（剧情·孤星·12）', label: '本篇', note: '无独立通用条目；不按“上校”称谓匹配其他人' },
  { character: '杰克逊', comment_pk: '[角色]: 杰克逊（剧情·孤星·13）', label: '本篇', note: '通用来源 [角色]:杰克逊' },
  { character: '帕尔维斯', comment_pk: '[角色]: 帕尔维斯（剧情·孤星·14）', label: '本篇', note: '只能选孤星条目，不能选绿野幻梦条目' },
  { character: '斐尔迪南', comment_pk: '[角色]: 斐尔迪南（剧情·孤星·15）', label: '本篇', note: '通用来源 [角色]:斐尔迪南' },
  { character: '伊芙利特', comment_pk: '[角色]: 伊芙利特（剧情·孤星·16）', label: '本篇', note: '有专属目标，不能因通用来源无后缀而漏切' }
];

const TARGETS_BY_CHAPTER = {
  '雪原线': SNOWFIELD_TARGETS,
  '时间啊，向前！': TIME_FORWARD_TARGETS,
  '孤星': LONE_STAR_TARGETS
};

// ---------------------------------------------------------------------------
// Characters that must NOT be auto-switched even though they appear in a
// chapter. These are recorded so callers can surface "不应自动切" reasons.
// ---------------------------------------------------------------------------

const DO_NOT_AUTO_SWITCH = {
  '雪原线': [
    { character: '九', reason: '雪原短暂出场，无雪原专属条目；不得借用《时间啊，向前！》九条目，无明确场景绑定则保持当前资料' },
    { character: '博卓卡斯替', reason: '898 年条目不是雪原后缀，仅在现行明确场景确需该时期时使用' },
    { character: '塔露拉', reason: '幼年、黑蛇、新整合运动形态不能从整篇名称确定逐幕时期，仅现行明确场景绑定才能切' }
  ],
  '时间啊，向前！': [
    { character: '真理', reason: '不得因篇名自行指定成年形态；无本篇目标时只有现行明确场景绑定才能切' },
    { character: '霜星', reason: '不得因篇名自行指定雪原形态' },
    { character: '阿米娅', reason: '历史清单提到但当前索引无本篇命名条目，使用现行明确场景绑定' },
    { character: '博士', reason: '性别及玩家身份属于开局选择，不得擅自改性别或重开独立 NPC 条目' },
    { character: '爱国者', reason: '不得因篇名自行指定雪原/博卓卡斯替形态' },
    { character: '凯尔希', reason: '不得自行指定巴别塔等形态，使用现行明确场景绑定' },
    { character: '维娜', reason: '历史清单提到但无本篇命名条目；ED2 维娜幼年 scene_anchor 为现行明确绑定' },
    { character: '推进之王', reason: '同维娜，使用现行明确场景绑定' }
  ],
  '孤星': [
    { character: '克丽斯腾', reason: '有大学、本格，无孤星命名条目；依现行场景绑定，不整篇切大学' },
    { character: '娜斯提', reason: '有幼年、本格，无孤星命名条目；依现行场景绑定，不整篇切幼年' },
    { character: '赫默', reason: '当前默认淬羽赫默（异格 entry 533，本格 144 关闭）；保留现行默认与明确场景切换' },
    { character: '博士', reason: '不得擅自改性别，不重开玩家博士独立 NPC 条目' },
    { character: '凯尔希', reason: '不借用遗尘漫步条目；复用现行明确场景绑定' }
  ]
};

// ---------------------------------------------------------------------------
// Missing / ambiguous items recorded by the Sol guide. These are NOT targets.
// ---------------------------------------------------------------------------

const MISSING_OR_AMBIGUOUS = {
  '雪原线': [
    { character: '九', issue: '无雪原专属条目，不得借用《时间啊，向前！》九条目' },
    { character: '其余出场人物及称谓', issue: '1.7.0 的 8 人仅为历史统计，材料无现行完整名单，需逐项核对现行场景绑定' }
  ],
  '时间啊，向前！': [
    { character: '瓦莲汀·沃尔金娜', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '拉夫连·卡尔诺夫', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '雅罗米尔', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '罗季昂', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '卡德尔', issue: '有本篇条目但无独立通用条目；不与卡铎尔合并' },
    { character: '奥妮拉', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '塔拉斯', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '谢尔戈', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '奥列格', issue: '有本篇条目但无独立通用条目，不虚构通用条目' },
    { character: '卡特琳娜', issue: '别名关联候选（乔万娜关键词含卡特琳娜），需核对现行身份标识；冲突则列歧义' },
    { character: '米拉娜', issue: '明示别名“伊凡·图林”，需验证唯一身份，不通过删称谓/去引号/子串转换实现' },
    { character: '叶莉莎女大公', issue: '明示别名 叶莉莎，需验证唯一身份' },
    { character: '维特', issue: '同时存在《遗尘漫步》同名本篇条目，只选本篇 38' },
    { character: '雷德', issue: '另有角色“红”，不因译名/近义/外观推断合并' },
    { character: '卡谢娜', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '塔露拉', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '科西切', issue: '“黑蛇”等关键词可能交叉，保留独立身份' },
    { character: '其余出场人物、回忆人物和称谓', issue: '材料无完整名单和逐幕绑定，35 条不能冒称全篇全部角色覆盖' }
  ],
  '孤星': [
    { character: '洛肯·威廉姆斯', issue: '“威廉姆斯”也出现在其他角色关键词中，只使用完整姓名和现行身份' },
    { character: '克丽斯腾', issue: '有大学、本格，无孤星命名条目；不整篇统一切大学' },
    { character: '娜斯提', issue: '有幼年、本格，无孤星命名条目；不因本篇含回忆就全部切幼年' },
    { character: '赫默', issue: '当前默认淬羽赫默，本格关闭；不根据剧情印象自行重设' },
    { character: '博士', issue: '性别及玩家身份属于开局选择，不得擅自改性别' },
    { character: '凯尔希', issue: '有多种资料及遗尘漫步本篇条目，无孤星命名条目；不借用遗尘漫步条目' },
    { character: '其他角色与称谓', issue: '历史“17 个有独立条目人物”不能提供当前完整名单，6 条不能称为全员适配' }
  ]
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function normalizeName(name) {
  return trim(name);
}

function findTargetInTable(table, characterName) {
  const name = normalizeName(characterName);
  if (!name) return null;
  const hits = table.filter(t => t.character === name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Multiple targets for the same character in one chapter is ambiguous.
    return { ambiguous: true, candidates: hits };
  }
  return null;
}

// Optional catalog: when provided, verify the target comment_pk exists in the
// catalog and that the character identity is unique. The catalog is expected
// to be an array of { character_id, canonical_name, aliases[], forms[] }.
function verifyAgainstCatalog(target, characterName, catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return { ok: true };
  }
  const name = normalizeName(characterName);
  const identityHits = [];
  for (const rec of catalog) {
    if (!rec || typeof rec !== 'object') continue;
    const names = [rec.canonical_name].concat(rec.aliases || []);
    if (names.some(n => trim(n) === name)) identityHits.push(rec);
  }
  if (identityHits.length === 0) {
    // Catalog does not know this character; still allow the explicit table
    // target, but flag it so callers can surface a warning.
    return { ok: true, warning: 'character_not_in_catalog' };
  }
  if (identityHits.length > 1) {
    return { ok: false, reason: 'ambiguous_identity', candidates: identityHits.map(r => r.character_id) };
  }
  const rec = identityHits[0];
  const forms = rec.forms || rec.states || [];
  const formHit = forms.find(f => trim(f && f.comment_pk) === trim(target.comment_pk));
  if (!formHit) {
    return { ok: false, reason: 'target_not_in_catalog', character_id: rec.character_id };
  }
  return { ok: true, character_id: rec.character_id, form: formHit };
}

/**
 * Find the confirmed chapter target for a character.
 *
 * @param {string} characterName  Full character name (exact match).
 * @param {string} chapterName    Chapter name (exact match).
 * @param {Array}  [catalog]      Optional character catalog for identity check.
 * @returns {object} Always an object, never null.
 *   - { ok: true, comment_pk, target }
 *   - { ok: false, reason: 'chapter_not_adapted' }
 *   - { ok: false, reason: 'no_target' }
 *   - { ok: false, reason: 'ambiguous_target', candidates }
 *   - { ok: false, reason: 'ambiguous_identity', candidates }
 *   - { ok: false, reason: 'target_not_in_catalog', character_id }
 */
function findTarget(characterName, chapterName, catalog) {
  const chapter = trim(chapterName);
  const name = normalizeName(characterName);

  if (!chapter) {
    return { ok: false, reason: 'chapter_not_adapted' };
  }
  if (!isAdapted(chapter)) {
    return { ok: false, reason: 'chapter_not_adapted' };
  }
  if (!name) {
    return { ok: false, reason: 'no_target' };
  }

  const table = TARGETS_BY_CHAPTER[chapter] || [];
  const hit = findTargetInTable(table, name);

  if (!hit) {
    return { ok: false, reason: 'no_target' };
  }
  if (hit.ambiguous) {
    return { ok: false, reason: 'ambiguous_target', candidates: hit.candidates.map(c => c.comment_pk) };
  }

  const verify = verifyAgainstCatalog(hit, name, catalog);
  if (!verify.ok) {
    return { ok: false, reason: verify.reason, character_id: verify.character_id, candidates: verify.candidates };
  }

  const result = {
    ok: true,
    comment_pk: hit.comment_pk,
    target: {
      character: hit.character,
      chapter,
      comment_pk: hit.comment_pk,
      label: hit.label,
      note: hit.note
    }
  };
  if (verify.warning) result.warning = verify.warning;
  if (verify.character_id) result.character_id = verify.character_id;
  return result;
}

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

function targetsForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (TARGETS_BY_CHAPTER[chapter] || []).map(t => ({
    character: t.character,
    comment_pk: t.comment_pk,
    label: t.label,
    note: t.note
  }));
}

function doNotAutoSwitchForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (DO_NOT_AUTO_SWITCH[chapter] || []).map(x => ({ character: x.character, reason: x.reason }));
}

function missingOrAmbiguousForChapter(chapterName) {
  const chapter = trim(chapterName);
  if (!isAdapted(chapter)) return [];
  return (MISSING_OR_AMBIGUOUS[chapter] || []).map(x => ({ character: x.character, issue: x.issue }));
}

function allTargets() {
  const out = [];
  for (const chapter of ADAPTED_CHAPTERS) {
    for (const t of (TARGETS_BY_CHAPTER[chapter] || [])) {
      out.push({
        chapter,
        character: t.character,
        comment_pk: t.comment_pk,
        label: t.label,
        note: t.note
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const api = {
  adaptedChapters,
  isAdapted,
  findTarget,
  targetsForChapter,
  doNotAutoSwitchForChapter,
  missingOrAmbiguousForChapter,
  allTargets,
  // Exposed for tests / callers that need the raw tables.
  ADAPTED_CHAPTERS: ADAPTED_CHAPTERS.slice(),
  TARGETS_BY_CHAPTER,
  DO_NOT_AUTO_SWITCH,
  MISSING_OR_AMBIGUOUS
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_CHAPTER_ADAPT__ = api;
