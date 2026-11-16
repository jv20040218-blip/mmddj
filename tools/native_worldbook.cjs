'use strict';

// SillyTavern 1.19 convertCharacterBook contract, checked against the installed source.
// Embedded CharacterBook entries and native world-info entries are different schemas.
function toNativeWorldbook(book) {
  const input = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
  const entries = {};
  const fields = {
    excludeRecursion: ['exclude_recursion', false], preventRecursion: ['prevent_recursion', false],
    delayUntilRecursion: ['delay_until_recursion', false], displayIndex: ['display_index', null],
    probability: ['probability', 100], useProbability: ['useProbability', true], depth: ['depth', 4],
    selectiveLogic: ['selectiveLogic', 0], outletName: ['outlet_name', ''], group: ['group', ''],
    groupOverride: ['group_override', false], groupWeight: ['group_weight', 100],
    scanDepth: ['scan_depth', null], caseSensitive: ['case_sensitive', null],
    matchWholeWords: ['match_whole_words', null], useGroupScoring: ['use_group_scoring', null],
    automationId: ['automation_id', ''], role: ['role', 0], vectorized: ['vectorized', false],
    sticky: ['sticky', null], cooldown: ['cooldown', null], delay: ['delay', null],
    matchPersonaDescription: ['match_persona_description', false],
    matchCharacterDescription: ['match_character_description', false],
    matchCharacterPersonality: ['match_character_personality', false],
    matchCharacterDepthPrompt: ['match_character_depth_prompt', false],
    matchScenario: ['match_scenario', false], matchCreatorNotes: ['match_creator_notes', false],
    triggers: ['triggers', []], ignoreBudget: ['ignore_budget', false]
  };
  input.forEach((e, index) => {
    const ext = e.extensions || {}, uid = e.uid ?? e.id;
    if (!Number.isInteger(uid) || uid < 0 || entries[uid]) throw Error('Invalid or duplicate worldbook UID: ' + uid);
    const row = { ...e, uid, key: [...(e.key ?? e.keys ?? [])],
      keysecondary: [...(e.keysecondary ?? e.secondary_keys ?? [])],
      comment: e.comment || '', content: e.content ?? '', constant: e.constant ?? false,
      selective: e.selective ?? false, order: e.order ?? e.insertion_order ?? 100,
      position: typeof e.position === 'number' ? e.position : (ext.position ?? (e.position === 'before_char' ? 0 : 1)),
      disable: typeof e.disable === 'boolean' ? e.disable : e.enabled === false, addMemo: !!e.comment };
    for (const [native, [embedded, fallback]] of Object.entries(fields))
      row[native] = e[native] ?? ext[embedded] ?? (native === 'displayIndex' ? index : fallback);
    entries[uid] = row;
  });
  const result = { name: book.name, entries };
  validateNativeWorldbook(result);
  return result;
}

function validateNativeWorldbook(book) {
  if (!book.entries || Array.isArray(book.entries)) throw Error('Native worldbook must use UID-keyed entries');
  for (const [key, e] of Object.entries(book.entries)) {
    if (String(e.uid) !== key || !Array.isArray(e.key) || !Array.isArray(e.keysecondary))
      throw Error('Native worldbook keyword arrays missing at UID ' + key);
    if (!Number.isInteger(e.position) || e.position < 0 || e.position > 7 || !Number.isFinite(e.order) ||
        !Number.isInteger(e.role) || e.role < 0 || e.role > 2 || typeof e.disable !== 'boolean')
      throw Error('Native worldbook field contract invalid at UID ' + key);
  }
  return true;
}

module.exports = { toNativeWorldbook, validateNativeWorldbook };
