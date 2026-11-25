// 角色线剧情指导运行时：按当前角色线取「全线概览 + 当前幕及相邻幕逐幕要点」注入。
// 指导来自按章按线生成的原文摘录；注入时与当段原文排重，避免同一句台词出现两次。
'use strict';

function buildGuideIndex(raw) {
  const r = raw && raw.guides ? raw : null;
  const byRoute = new Map();
  for (const g of (r ? r.guides : [])) byRoute.set(g.route_id, g);
  return { raw: r, byRoute, available: byRoute.size > 0, count: byRoute.size };
}

function focusedInjection(idx, routeId, nodeId, material) {
  const g = idx && idx.byRoute.get(routeId);
  if (!g) return null;
  const acts = g.acts || [], briefs = g.act_briefs || [];
  const i = nodeId ? acts.findIndex(a => a.node_id === nodeId) : -1;
  const near = i < 0 ? [] : briefs.slice(Math.max(0, i - 1), i + 1);
  const lines = (g.header_lines || []).slice();
  for (const b of near) {
    let line = b.line;
    // 该要点引用的台词若已在本轮当段原文里出现，就只留索引提示，不重复拼接。
    if (b.quote && b.quote.text && material && material.includes(b.quote.text)) {
      line = line.split('｜要点：')[0] + '｜要点：见本轮当段原文（不重复引用）';
    }
    lines.push(line);
  }
  lines.push(i < 0 ? '（本幕暂无逐幕要点，按章手册与当段原文推进）'
    : '（以上为当前幕及相邻幕要点；完整逐幕要点可在剧情页展开或查阅按章手册）');
  if (g.status !== '有完整原文且已接入') lines.push('本线素材仅有摘要／目录，按原有概括精度继续，不编造原文。');
  const text = lines.join('\n');
  return { guide_id: g.guide_id, status: g.status, acts: acts.length,
    current_act: i >= 0 ? i + 1 : null, text, chars: text.length };
}

// 玩家主动展开：当前幕的完整要点（原文摘录 + 人物 + 来源）。
function actDetail(idx, routeId, nodeId) {
  const g = idx && idx.byRoute.get(routeId);
  if (!g) return null;
  const a = (g.acts || []).find(x => x.node_id === nodeId);
  if (!a) return null;
  return { guide_id: g.guide_id, route_id: routeId, node_id: a.node_id, node_code: a.node_code,
    act_name: a.act_name, completion: a.completion, cast: a.cast || [],
    key_dialogues: a.key_dialogues || [], key_actions: a.key_actions || [],
    next_node_code: a.next_node_code || null, source: a.source || null };
}

const api = { buildGuideIndex, focusedInjection, actDetail };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_GUIDE__ = api; }

