'use strict';

// "已被玩家严重影响过" three-state evaluation.
// Implements Sol's testable criteria:
//   - SEVERE  : at least one effective major fact (7 categories)
//   - CLEAR   : record complete, all major-fact checks false, no manual exclusion
//   - UNKNOWN : record missing / not up to date / identity ambiguous / conflicting
//
// A fact counts only if it is: in the current save, clearly tied to the
// character, already happened/confirmed, not revoked, and has player agency.
// Plans, hypotheses, quoted lines, and merely reading the original story do
// NOT count as an effective player change.
//
// evaluateInfluence returns { status } where status is one of SEVERE/CLEAR/UNKNOWN.
// No paid model call is made here; callers pass already-extracted facts.

const SEVERE = 'severe';
const CLEAR = 'clear';
const UNKNOWN = 'unknown';

// The seven major-fact categories (Sol table).
const MAJOR_KINDS = Object.freeze({
  MAJOR_EXPERIENCE: 'major_experience', // 生死/复活/永久伤残/关键救援/长期囚禁/身份状态变化
  PERSISTENT_RELATION: 'persistent_relation', // 恋人/配偶/收养/师徒/正式结盟/持续敌对/背叛/决裂
  AFFECTION_STAGE: 'affection_stage', // 好感跨越现行阶段阈值
  FACTION_DUTY: 'faction_duty', // 阵营/效忠/长期职责/核心目标改变
  PERSONALITY_BELIEF: 'personality_belief', // 持续性格/价值判断/行为原则变化
  PLOT_DIRECTION: 'plot_direction', // 关键偏离事实改变后续行动前提
  PLAYER_RESERVED: 'player_reserved' // 玩家明确要求保留
});

const MAJOR_KIND_SET = new Set(Object.values(MAJOR_KINDS));

// Relation states that conflict with each other when both are "active".
// If a character has both a positive relation and a breakup/severance record
// that is not resolved, the record is contradictory -> UNKNOWN.
const RELATION_POSITIVE = new Set([
  '恋人', '配偶', '夫妻', '伴侣', '收养', '师徒', '正式结盟', '结盟', '盟友',
  'lover', 'spouse', 'partner', 'adopted', 'mentor', 'alliance', 'ally'
]);
const RELATION_NEGATIVE = new Set([
  '分手', '决裂', '背叛', '敌对', '断交', '解除', '离婚',
  'breakup', 'break_up', 'severed', 'betrayal', 'hostile', 'divorce'
]);

function trim(value) {
  return String(value == null ? '' : value).trim();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// A fact is "effective" if it is confirmed, not revoked, and has player agency.
// Facts that are plans/hypotheses/quotes/reading-only are not effective.
function isEffectiveFact(fact) {
  if (!fact || typeof fact !== 'object') return false;
  if (fact.revoked === true) return false;
  if (fact.confirmed === false) return false;
  // Player agency required for a "player change".
  if (fact.player_agency === false) return false;
  // Plans / hypotheses / quotes / reading-only never count.
  if (fact.plan === true) return false;
  if (fact.hypothesis === true) return false;
  if (fact.quote_only === true) return false;
  if (fact.reading_only === true) return false;
  if (fact.kind === 'reading' || fact.kind === 'plan' || fact.kind === 'hypothesis') return false;
  return true;
}

function relationStateOf(fact) {
  if (!fact) return '';
  const raw = fact.relation_state != null ? fact.relation_state : fact.value;
  return trim(raw);
}

function isPositiveRelation(state) {
  return RELATION_POSITIVE.has(state);
}

function isNegativeRelation(state) {
  return RELATION_NEGATIVE.has(state);
}

// Detect contradictory persistent-relation facts for the same character:
// a positive relation and a negative/breakup record both active.
function hasConflictingRelations(facts) {
  let positive = false;
  let negative = false;
  for (const f of facts) {
    if (!f || f.kind !== MAJOR_KINDS.PERSISTENT_RELATION) continue;
    if (!isEffectiveFact(f)) continue;
    const st = relationStateOf(f);
    if (isPositiveRelation(st)) positive = true;
    if (isNegativeRelation(st)) negative = true;
  }
  return positive && negative;
}

// Affection: severe only if a stage threshold was actually crossed AND a
// scale/stage definition exists. If only a numeric change is recorded with no
// scale and no stage fields, it is UNKNOWN (cannot judge importance).
function affectionVerdict(fact) {
  if (!fact || fact.kind !== MAJOR_KINDS.AFFECTION_STAGE) return null;
  if (!isEffectiveFact(fact)) return null;
  const hasScale = isNonEmptyString(fact.scale) || isNonEmptyString(fact.scale_id);
  const hasStages = isNonEmptyString(fact.stage_before) || isNonEmptyString(fact.stage_after);
  const crossed = fact.crossed_stage === true ||
    (isNonEmptyString(fact.stage_before) && isNonEmptyString(fact.stage_after) &&
      trim(fact.stage_before) !== trim(fact.stage_after));
  if (!hasScale && !hasStages) {
    // No scale and no stage definition -> cannot judge -> UNKNOWN.
    return UNKNOWN;
  }
  if (crossed) return SEVERE;
  // Has scale/stages but did not cross -> not severe (small change).
  return null;
}

// Evaluate a single character's influence state.
// input: {
//   character_id,
//   record_complete: boolean,   // false/undefined => record missing
//   up_to_date: boolean,        // false => not processed to latest message
//   identity_ambiguous: boolean,
//   manual_excluded: boolean,   // player set to manual / reserved
//   facts: [ { kind, ... } ]
// }
function evaluateInfluence(input) {
  const rec = input || {};
  const facts = Array.isArray(rec.facts) ? rec.facts : [];

  // Manual exclusion / player reserved -> protected (severe-equivalent: no auto).
  if (rec.manual_excluded === true) {
    return { status: SEVERE, reason: 'manual_excluded' };
  }

  // Identity ambiguity -> UNKNOWN.
  if (rec.identity_ambiguous === true) {
    return { status: UNKNOWN, reason: 'identity_ambiguous' };
  }

  // Record missing or not up to date -> UNKNOWN (never treat "no archive" as clear).
  if (rec.record_complete !== true) {
    return { status: UNKNOWN, reason: 'record_missing' };
  }
  if (rec.up_to_date === false) {
    return { status: UNKNOWN, reason: 'not_up_to_date' };
  }

  // Conflicting persistent relations -> UNKNOWN before counting as severe.
  if (hasConflictingRelations(facts)) {
    return { status: UNKNOWN, reason: 'conflicting_relations' };
  }

  // Player reserved fact -> SEVERE.
  for (const f of facts) {
    if (f && f.kind === MAJOR_KINDS.PLAYER_RESERVED && isEffectiveFact(f)) {
      return { status: SEVERE, reason: 'player_reserved' };
    }
  }

  // Affection: may yield UNKNOWN (missing scale) or SEVERE (crossed).
  let affectionUnknown = false;
  for (const f of facts) {
    if (!f || f.kind !== MAJOR_KINDS.AFFECTION_STAGE) continue;
    const v = affectionVerdict(f);
    if (v === SEVERE) return { status: SEVERE, reason: 'affection_stage_crossed' };
    if (v === UNKNOWN) affectionUnknown = true;
  }

  // Other major kinds -> SEVERE if effective.
  const severeKinds = [
    MAJOR_KINDS.MAJOR_EXPERIENCE,
    MAJOR_KINDS.PERSISTENT_RELATION,
    MAJOR_KINDS.FACTION_DUTY,
    MAJOR_KINDS.PERSONALITY_BELIEF,
    MAJOR_KINDS.PLOT_DIRECTION
  ];
  for (const f of facts) {
    if (!f || !MAJOR_KIND_SET.has(f.kind)) continue;
    if (severeKinds.indexOf(f.kind) === -1) continue;
    if (isEffectiveFact(f)) {
      return { status: SEVERE, reason: f.kind };
    }
  }

  // Affection with missing scale but no other severe fact -> UNKNOWN.
  if (affectionUnknown) {
    return { status: UNKNOWN, reason: 'affection_scale_missing' };
  }

  // All checks false, record complete -> CLEAR.
  return { status: CLEAR, reason: 'no_major_evidence' };
}

// Convenience: should the auto flow touch this character?
function allowsAutoModification(status) {
  return status === CLEAR;
}

const api = {
  SEVERE,
  CLEAR,
  UNKNOWN,
  MAJOR_KINDS,
  evaluateInfluence,
  allowsAutoModification,
  isEffectiveFact,
  hasConflictingRelations
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_INFLUENCE__ = api;
