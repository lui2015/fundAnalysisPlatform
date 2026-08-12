'use strict';
/** 日期工具：净值序列全部以 YYYY-MM-DD 字符串为键，避免时区导致的错位 */

const DAY_MS = 24 * 3600 * 1000;

function toDate(s) {
  if (s instanceof Date) return s;
  const str = String(s || '').slice(0, 10).replace(/\//g, '-');
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fmt(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 自然日差（d1 - d2） */
function diffDays(d1, d2) {
  const a = toDate(d1);
  const b = toDate(d2);
  if (!a || !b) return null;
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function addDays(dateStr, n) {
  const d = toDate(dateStr);
  if (!d) return null;
  return fmt(new Date(d.getTime() + n * DAY_MS));
}

function addMonths(dateStr, n) {
  const d = toDate(dateStr);
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + n, 1));
  // 处理月末（如 3-31 减 1 个月）
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fmt(target);
}

function addYears(dateStr, n) {
  return addMonths(dateStr, n * 12);
}

function yearOf(dateStr) {
  const d = toDate(dateStr);
  return d ? d.getUTCFullYear() : null;
}

function monthKey(dateStr) {
  const s = String(dateStr || '');
  return s.slice(0, 7) || null;
}

function todayStr() {
  return fmt(new Date());
}

/** 中国时区当前时间的 ISO 串（用于报告时间戳展示） */
function nowIso() {
  return new Date().toISOString();
}

module.exports = { DAY_MS, toDate, fmt, diffDays, addDays, addMonths, addYears, yearOf, monthKey, todayStr, nowIso };
