// <ark_turn> 控制块协议：从正文提取/隐藏，解析为结果包。显示时隐藏（正则由导出提供）。
'use strict';

const TURN_RE = /<ark_turn>\s*([\s\S]*?)\s*<\/ark_turn>/;
const TURN_RE_G = /<ark_turn>\s*[\s\S]*?\s*<\/ark_turn>/g;

// Pair explicit Chinese speech openings per paragraph, never rewrite words.
// Code and control payloads are preserved byte-for-byte. Not a general quote guesser.
function repairDialogueParagraphs(text) {
  if (typeof text !== 'string') return text;
  const protectedParts = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`|<ark_turn>[\s\S]*?(?:<\/ark_turn>|$)/g;
  const protectedRanges = [...text.matchAll(protectedParts)].map(match => [match.index, match.index + match[0].length]);
  let protectedIndex = 0;
  return text.replace(/[^\r\n]+/g, (line, offset) => {
    while (protectedRanges[protectedIndex] && protectedRanges[protectedIndex][1] <= offset) protectedIndex++;
    const range = protectedRanges[protectedIndex];
    // Skip the entire line if it intersects code: never split a balanced
    // speech line around an inline code span and invent another quote.
    if (range && range[0] < offset + line.length && range[1] > offset) return line;
    const at = line.lastIndexOf('“');
    if (at < 0 || line.indexOf('”', at) >= 0) return line;
    const prefix = line.slice(0, at).trimEnd();
    if (prefix && !/[：，,:]$/.test(prefix)) return line;
    if (!line.slice(at + 1).trim()) return line;
    const trailing = line.match(/[ \t]*$/)[0];
    return line.slice(0, line.length - trailing.length) + '”' + trailing;
  });
}

function extractTurnBlock(text) {
  if (typeof text !== 'string') return { found: false, json: null, raw: null, cleanText: text || '' };
  const m = text.match(TURN_RE);
  if (!m) return { found: false, json: null, raw: null, cleanText: text };
  let json = null, parseError = null;
  try { json = JSON.parse(m[1]); } catch (e) { parseError = e.message; }
  return { found: true, json, raw: m[0], parseError, cleanText: text.replace(TURN_RE, '').trim() };
}

function stripTurnBlock(text) { return typeof text === 'string' ? text.replace(TURN_RE_G, '').trim() : (text || ''); }

// 供宿主导出的显示正则（匹配并隐藏控制块）。
const DISPLAY_REGEX = { find: '<ark_turn>\\s*[\\s\\S]*?\\s*</ark_turn>', replace: '', flags: 'g', name: 'ARK剧情控制块隐藏' };

const api = { TURN_RE, TURN_RE_G, extractTurnBlock, stripTurnBlock, repairDialogueParagraphs, DISPLAY_REGEX };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_ADAPTER_PROTOCOL__ = api; }

