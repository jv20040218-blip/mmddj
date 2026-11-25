// 时间核心：区分来源时间/本局排期/实际发生/场景时间。
// 运行日历(terra)采用集中约定：12月×30日=360日/年，1日=1440分钟。
// 该约定仅用于本局排期与排序，不冒充官方精确日期；来源精度单独保存。
'use strict';

const CALENDARS = {
  terra: { id: 'terra', monthsPerYear: 12, daysPerMonth: 30, minutesPerDay: 1440, label: '泰拉历（运行约定360日/年）' }
};
const SEASON_MONTH = { 春: 1, 夏: 4, 秋: 7, 冬: 10 };

function cal(calendarId) { return CALENDARS[calendarId] || CALENDARS.terra; }

// 解析 date_label：支持 YYYY / YYYY-MM / YYYY-MM-DD / 区间YYYY-YYYY / 季节YYYY春
function parseDateLabel(label) {
  if (label == null) return null;
  const s = String(label).trim();
  let m;
  if ((m = s.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/))) return { year: +m[1], month: +m[2], day: +m[3], precision: 'day' };
  if ((m = s.match(/^(\d{3,4})-(\d{1,2})$/))) return { year: +m[1], month: +m[2], day: 1, precision: 'month' };
  if ((m = s.match(/^(\d{3,4})\s*[年]?\s*(春|夏|秋|冬)$/))) return { year: +m[1], month: SEASON_MONTH[m[2]], day: 1, precision: 'season', season: m[2] };
  if ((m = s.match(/^(\d{3,4})-(\d{3,4})$/))) return { year: +m[1], month: 1, day: 1, precision: 'range', end_year: +m[2] };
  if ((m = s.match(/^(\d{3,4})$/))) return { year: +m[1], month: 1, day: 1, precision: 'year' };
  return null;
}

// 来源/排期日期 → 运行ordinal_minute。relative/unknown 返回 null（用约束排序，不造精确日期）。
// provisional_range/conflict/custom_relative 是未核实候选区间、冲突记录或本地剧本设定，
// 同样返回 null：不当作已核实结论，也不把“某年”强制视作元旦参与状态触发。
function dateToOrdinal(label, precision, calendarId) {
  const c = cal(calendarId);
  const p = parseDateLabel(label);
  if (!p) return null;
  const prec = precision || p.precision;
  if (prec === 'relative' || prec === 'unknown' || prec === 'provisional_range' || prec === 'conflict' || prec === 'custom_relative') return null;
  const year = p.year, month = p.month || 1, day = p.day || 1;
  const dayIndex = (year * c.monthsPerYear + (month - 1)) * c.daysPerMonth + (day - 1);
  return dayIndex * c.minutesPerDay;
}

// 运行ordinal_minute → 显示用日期与时刻（运行约定，精度day）。
function ordinalToClock(ordinal, calendarId) {
  const c = cal(calendarId);
  if (ordinal == null || !Number.isFinite(ordinal)) return null;
  const totalDays = Math.floor(ordinal / c.minutesPerDay);
  const minuteOfDay = ordinal - totalDays * c.minutesPerDay;
  const year = Math.floor(totalDays / (c.monthsPerYear * c.daysPerMonth));
  const rem = totalDays - year * c.monthsPerYear * c.daysPerMonth;
  const month = Math.floor(rem / c.daysPerMonth) + 1;
  const day = rem - (month - 1) * c.daysPerMonth + 1;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  const date_label = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { calendar_id: c.id, date_label, time_label: `${hh}:${mm}`, ordinal_minute: ordinal, precision: 'day' };
}

function makeTime(ordinal, calendarId) {
  return { calendar_id: cal(calendarId).id, ordinal_minute: ordinal == null ? null : ordinal };
}

// 比较两个时间点；null 视为未知，排在最后（不可比较时返回 null）。
function compareTime(a, b) {
  const ao = a && a.ordinal_minute, bo = b && b.ordinal_minute;
  if (ao == null && bo == null) return 0;
  if (ao == null) return 1;
  if (bo == null) return -1;
  return ao < bo ? -1 : ao > bo ? 1 : 0;
}

function timeLte(a, b) { const c = compareTime(a, b); return c !== null && c <= 0; }

// 从 canonical_window 取来源时间锚点（保留精度与relation）。
function sourceTimeOf(win) {
  if (!win) return { time: makeTime(null), precision: 'unknown', relation: 'occurs_at', date_label: null };
  const ord = dateToOrdinal(win.date_label, win.precision, win.calendar_id);
  return { time: makeTime(ord, win.calendar_id), precision: win.precision || 'unknown', relation: win.relation || 'occurs_at', date_label: win.date_label || null, raw_text: win.raw_text || null };
}

// 排序可以使用区间起点；自动改变人物状态只能在完整粗日期范围过去后确认到期。
function dateToTriggerOrdinal(label, precision, calendarId) {
  const start = dateToOrdinal(label, precision, calendarId);
  const p = parseDateLabel(label), c = cal(calendarId);
  if (start == null || !p) return null;
  const prec = precision || p.precision;
  if (prec === 'year') return start + c.monthsPerYear * c.daysPerMonth * c.minutesPerDay;
  if (prec === 'month') return start + c.daysPerMonth * c.minutesPerDay;
  if (prec === 'season') return start + 3 * c.daysPerMonth * c.minutesPerDay;
  if (prec === 'range') return dateToOrdinal(String(p.end_year + 1), 'year', calendarId);
  return start;
}

const api = { CALENDARS, SEASON_MONTH, cal, parseDateLabel, dateToOrdinal, dateToTriggerOrdinal, ordinalToClock, makeTime, compareTime, timeLte, sourceTimeOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') { globalThis.__ARK_CORE_TIME__ = api; }

