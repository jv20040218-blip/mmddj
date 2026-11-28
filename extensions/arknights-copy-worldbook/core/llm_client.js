'use strict';

// OpenAI-compatible client for explicit, on-demand actions only:
// chat summarization into the 14-section schema, and timeline/form merge.
// Never called from the story hot path (form switch is local compile).

const Schema = (typeof require === 'function' && require('./schema')) || (typeof globalThis !== 'undefined' && globalThis.__ARK_CWB_SCHEMA__);

const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';

function sectionKeyList() {
  return Schema.SECTIONS.join('、');
}

function summarizerMessages(input) {
  const existing = input.existing_profile || input.existing || {};
  const chat = Array.isArray(input.messages)
    ? input.messages.map(m => (typeof m === 'string' ? m : ((m.role || 'user') + ': ' + (m.content || m.mes || '')))).join('\n')
    : String(input.transcript || input.chat || '');
  const system = [
    '你是明日方舟角色档案整理助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    'JSON 必须且仅包含以下 14 个键，值为字符串：' + sectionKeyList() + '。',
    '小节标题必须与上面完全一致，不得改写、不得增减键名。',
    '不要编造底板未出现的固定身份信息；把本存档的经历、性格偏移、以及对 {{user}} 的好感与关系分别写入「经历」「特点」「人际关系」。',
    '「语言示例」只收录能代表该角色语气的短句。不确定的内容留空字符串。'
  ].join('\n');
  const user = [
    '角色：' + (input.canonical_name || input.character_id || ''),
    existing && Object.keys(existing).length ? '现有十四段档案：\n' + JSON.stringify(existing, null, 2) : '现有十四段档案：（空）',
    '需要整理的聊天摘录：\n' + chat
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function mergeMessages(input) {
  const system = [
    '你是明日方舟角色档案时间线合并助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    'JSON 必须且仅包含以下 14 个键，值为字符串：' + sectionKeyList() + '。',
    '小节标题必须与上面完全一致。这是字段差分合并后的完整十四段正文，不是自由改写。',
    '调和正史冲突时：保留本存档已发生的经历、好感与对 {{user}} 的关系，不得丢弃动态层；',
    '当前时间线（目标）的正史形态正文优先于被离开的时间线的形态正文；冲突处用简短说明写入「备注」。'
  ].join('\n');
  const user = [
    '角色：' + (input.canonical_name || input.character_id || ''),
    '目标时间线：' + (input.to_timeline || 'main'),
    '来源时间线：' + (input.from_timeline || 'parallel'),
    '目标形态正文（十四段）：\n' + JSON.stringify(input.target_profile || {}, null, 2),
    '来源形态正文（十四段）：\n' + JSON.stringify(input.source_profile || {}, null, 2),
    '需保留的存档动态层：\n' + JSON.stringify(input.dynamic_layer || {}, null, 2)
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function parseStructuredOutput(text) {
  const extracted = Schema.extractStructured(text);
  if (!extracted) return { ok: false, reason: 'unparseable_structured_output' };
  const missing = Schema.SECTIONS.filter(s => !Object.prototype.hasOwnProperty.call(extracted, s));
  if (missing.length) return { ok: false, reason: 'missing_sections', missing };
  return { ok: true, sections: extracted };
}

async function defaultFetch(url, init) {
  if (typeof fetch === 'function') return fetch(url, init);
  throw new Error('fetch_unavailable');
}

function normalizeApi(api) {
  const a = api || {};
  return {
    url: a.url || a.endpoint || DEFAULT_URL,
    key: a.key || a.api_key || a.apiKey || '',
    model: a.model || DEFAULT_MODEL,
    temperature: a.temperature == null ? 0.2 : a.temperature
  };
}

async function viaTavernGenerate(api, messages) {
  globalThis.__ARK_CWB_INTERNAL_CALLS__ = (globalThis.__ARK_CWB_INTERNAL_CALLS__ || 0) + 1;
  try {
  const system = (messages || []).filter(m => m && m.role === 'system').map(m => m.content || '').filter(Boolean).join('\n');
  const rest = (messages || []).filter(m => m && m.role !== 'system');
  const prompt = rest.length ? rest : messages;
  if (typeof api.generateRaw === 'function') {
    const text = await api.generateRaw({
      prompt,
      systemPrompt: system,
      instructOverride: true
    });
    return { ok: true, text: String(text || ''), llm_calls: 1, model: api.model || '', source: api.source || 'tavern' };
  }
  if (typeof api.generateRawData === 'function') {
    const data = await api.generateRawData({
      prompt,
      systemPrompt: system,
      instructOverride: true
    });
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      || (data && data.content)
      || (typeof data === 'string' ? data : '');
    return { ok: true, text: String(text || ''), raw: data, llm_calls: 1, model: api.model || '', source: api.source || 'tavern' };
  }
  return { ok: false, reason: 'missing_tavern_api', llm_calls: 0 };
  } finally { globalThis.__ARK_CWB_INTERNAL_CALLS__ = Math.max(0, (globalThis.__ARK_CWB_INTERNAL_CALLS__ || 1) - 1); }
}

async function chatCompletions(api, messages, fetcher) {
  const a = api || {};
  if (typeof a.generateRaw === 'function' || typeof a.generateRawData === 'function') {
    try {
      return await viaTavernGenerate(a, messages);
    } catch (_) {
      return { ok: false, reason: 'tavern_generate_failed', llm_calls: 1 };
    }
  }
  const cfg = normalizeApi(a);
  if (!cfg.key) return { ok: false, reason: 'missing_api_key', llm_calls: 0 };
  if (!cfg.url) return { ok: false, reason: 'missing_api_url', llm_calls: 0 };
  const doFetch = fetcher || defaultFetch;
  const res = await doFetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.key
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature
    })
  });
  if (!res || !res.ok) {
    const status = res && res.status;
    return { ok: false, reason: 'http_' + status, llm_calls: 1 };
  }
  const body = typeof res.json === 'function' ? await res.json() : res.body;
  const text = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : (body && body.content) || '';
  return { ok: true, text: String(text || ''), raw: body, llm_calls: 1, model: cfg.model };
}

async function summarizeChat(input, api, fetcher) {
  const messages = summarizerMessages(input);
  const res = await chatCompletions(api, messages, fetcher);
  if (!res.ok) return res;
  const parsed = parseStructuredOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, missing: parsed.missing, llm_calls: 1, text: res.text };
  return { ok: true, sections: parsed.sections, llm_calls: 1, model: res.model };
}

function designMessages(input) {
  const src = input || {};
  const system = [
    '你是明日方舟存档剧情设计助手。只输出一个 JSON 对象，不要 markdown 围栏，不要额外说明。',
    '你只返回修订建议。不要生成聊天楼层，不要推进游标，不要结算未演的事件，不要改写已有 route_id、scene_id、node_id。',
    'brief_facts 只允许写入已经发生的事实。未来安排写入 future_summaries，不得写入 brief_facts。',
    '不能为了保住原终点而发明一次等效事件抵消玩家已经做成的事。',
    '人物档案只写有现场证据的经历、处境、认知和关系，且 evidence 必须是 on_site。可能的未来发展不要写入档案。',
    '世界书改动只能使用输入里给出的 entry_id 或 comment_pk。摘要改动只能使用输入里给出的 node_id。',
    '若某节点的全部内容只依赖已经作废的前提，status 填 inapplicable。被略过的事件不要记成已发生。',
    'chat_id、route_id、base_revision 必须原样回填输入中的值。'
  ].join('\n');
  const user = JSON.stringify({
    chat_id: src.chat_id,
    route_id: src.route_id,
    scene_id: src.scene_id,
    node_id: src.node_id,
    base_revision: src.base_revision,
    settled_facts: src.settled_facts || [],
    brief: src.brief || '',
    summaries: src.summaries || [],
    completions: src.completions || [],
    entry_keys: (src.entry_keys || []).map(entry => ({
      entry_id: entry.entry_id,
      comment_pk: entry.comment_pk,
      character_id: entry.character_id || null,
      premise: entry.premise || null,
      content: entry.content || ''
    })),
    node_ids: src.node_ids || [],
    sideline: src.sideline || null,
    profiles: src.profiles || [],
    effective_actions: src.effective_actions || [],
    archive_version: src.archive_version != null ? src.archive_version : null,
    character_archives: src.character_archives || {},
    required_characters: src.required_characters || [],
    protection: src.protection || null,
    manual_selection: src.manual_selection || null
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function parseDesignOutput(text) {
  const stripped = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'unparseable_design_output' };
  try {
    const obj = JSON.parse(stripped.slice(start, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'design_output_not_object' };
    return { ok: true, revision: obj };
  } catch (_) {
    return { ok: false, reason: 'unparseable_design_output' };
  }
}

async function designPlot(input, api, fetcher) {
  const res = await chatCompletions(api, designMessages(input), fetcher);
  if (!res.ok) return { ok: false, reason: res.reason, llm_calls: res.llm_calls || 0 };
  const parsed = parseDesignOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, llm_calls: 1 };
  return { ok: true, revision: parsed.revision, llm_calls: 1, model: res.model };
}

async function mergeTimelines(input, api, fetcher) {
  const messages = mergeMessages(input);
  const res = await chatCompletions(api, messages, fetcher);
  if (!res.ok) return res;
  const parsed = parseStructuredOutput(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, missing: parsed.missing, llm_calls: 1, text: res.text };
  return { ok: true, sections: parsed.sections, llm_calls: 1, model: res.model };
}

const api = {
  DEFAULT_MODEL, DEFAULT_URL,
  summarizerMessages, mergeMessages, designMessages, parseStructuredOutput, parseDesignOutput,
  normalizeApi, viaTavernGenerate, chatCompletions, summarizeChat, mergeTimelines, designPlot
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.__ARK_CWB_LLM__ = api;
