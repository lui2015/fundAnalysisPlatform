'use strict';
/** 数值与格式化工具（所有报告中的数字最终都由计算层经这里产出） */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '-' || v === '--') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  if (!isNum(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function pct(v, d = 2) {
  if (!isNum(v)) return '—';
  return `${round(v, d)}%`;
}

/** 大数字中文化：1.23亿 / 4567万 */
function humanMoney(v) {
  if (!isNum(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${round(v / 1e12, 2)}万亿`;
  if (abs >= 1e8) return `${round(v / 1e8, 2)}亿`;
  if (abs >= 1e4) return `${round(v / 1e4, 2)}万`;
  return String(round(v, 2));
}

function mean(arr) {
  const a = (arr || []).filter(isNum);
  if (!a.length) return null;
  return round(a.reduce((s, x) => s + x, 0) / a.length, 6);
}

function median(arr) {
  const a = (arr || []).filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2, 6);
}

function stdev(arr) {
  const a = (arr || []).filter(isNum);
  if (a.length < 2) return null;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return round(Math.sqrt(v), 8);
}

/** 序列分位：value 在 series 中处于多少百分位（0-100） */
function percentileRank(series, value) {
  const arr = (series || []).filter(isNum);
  if (!arr.length || !isNum(value)) return null;
  const below = arr.filter((x) => x <= value).length;
  return round((below / arr.length) * 100, 1);
}

/** 取序列的第 p 百分位数值 */
function quantile(series, p) {
  const a = (series || []).filter(isNum).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = (a.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(a[lo], 6);
  return round(a[lo] + (a[hi] - a[lo]) * (idx - lo), 6);
}

function clamp(v, lo, hi) {
  if (!isNum(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 线性映射打分：把指标值映射到 0-100
 * worst 对应 0 分，best 对应 100 分（worst 可以大于 best，用于「越小越好」的指标）
 */
function scoreLinear(value, worst, best) {
  if (!isNum(value)) return null;
  if (worst === best) return 50;
  const r = (value - worst) / (best - worst);
  return Math.round(clamp(r, 0, 1) * 100);
}

/**
 * 加权合成得分：忽略为 null 的项并按剩余权重归一化
 * @param {Array<{score:number|null, weight:number}>} parts
 * @returns {{score:number|null, usedWeight:number, missing:number}}
 */
function weightedScore(parts) {
  let sum = 0;
  let w = 0;
  let missing = 0;
  for (const p of parts || []) {
    if (isNum(p.score) && isNum(p.weight) && p.weight > 0) {
      sum += p.score * p.weight;
      w += p.weight;
    } else {
      missing += 1;
    }
  }
  if (w <= 0) return { score: null, usedWeight: 0, missing };
  return { score: Math.round(clamp(sum / w, 0, 100)), usedWeight: round(w, 4), missing };
}

function safeDiv(a, b) {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  return a / b;
}

/** 年化换算：把区间累计收益率(%)按天数年化(%) */
function annualize(totalPct, days) {
  if (!isNum(totalPct) || !isNum(days) || days <= 0) return null;
  const years = days / 365;
  if (years <= 0) return null;
  const base = 1 + totalPct / 100;
  if (base <= 0) return null;
  return round((base ** (1 / years) - 1) * 100, 2);
}

module.exports = {
  isNum,
  toNum,
  round,
  pct,
  humanMoney,
  mean,
  median,
  stdev,
  percentileRank,
  quantile,
  clamp,
  scoreLinear,
  weightedScore,
  safeDiv,
  annualize,
};
