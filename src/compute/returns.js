'use strict';
/**
 * 好业绩（板块②）指标计算 —— 能力分 A
 *
 * 板块正交约束（需求 B-5）：本模块**不产出也不引用**回撤、波动、夏普等风险指标，
 * 避免「因为回撤小所以业绩好」的混淆；风险体验一律由 experience.js 负责。
 */
const dates = require('../utils/dates');
const { isNum, round, mean, stdev, scoreLinear, weightedScore, annualize, percentileRank } = require('../utils/num');
const { weightsOf, TYPE } = require('../config/fundTypes');
const { thresholdsFor } = require('../config/riskRules');

const INTERVALS = [
  { key: '1w', label: '近1周', shift: (d) => dates.addDays(d, -7) },
  { key: '1m', label: '近1月', shift: (d) => dates.addMonths(d, -1) },
  { key: '3m', label: '近3月', shift: (d) => dates.addMonths(d, -3) },
  { key: '6m', label: '近6月', shift: (d) => dates.addMonths(d, -6) },
  { key: 'ytd', label: '今年以来', shift: (d) => `${String(d).slice(0, 4)}-01-01` },
  { key: '1y', label: '近1年', shift: (d) => dates.addYears(d, -1), annualize: true },
  { key: '2y', label: '近2年', shift: (d) => dates.addYears(d, -2), annualize: true },
  { key: '3y', label: '近3年', shift: (d) => dates.addYears(d, -3), annualize: true },
  { key: '5y', label: '近5年', shift: (d) => dates.addYears(d, -5), annualize: true },
  { key: 'since', label: '成立以来', shift: () => null, annualize: true },
];

/** 取 <= date 的最后一个点；date 为 null 时取首个点 */
function pointAt(series, date, valueKey = 'adj') {
  const arr = (series || []).filter((p) => isNum(p[valueKey]));
  if (!arr.length) return null;
  if (!date) return arr[0];
  let found = null;
  for (const p of arr) {
    if (p.date <= date) found = p;
    else break;
  }
  return found;
}

function intervalReturn(series, fromDate, valueKey = 'adj') {
  const arr = (series || []).filter((p) => isNum(p[valueKey]));
  if (arr.length < 2) return null;
  const base = fromDate ? pointAt(arr, fromDate, valueKey) : arr[0];
  const last = arr[arr.length - 1];
  if (!base || !last || base.date === last.date || !(base[valueKey] > 0)) return null;
  return {
    pct: round((last[valueKey] / base[valueKey] - 1) * 100, 2),
    fromDate: base.date,
    toDate: last.date,
    days: dates.diffDays(last.date, base.date),
  };
}

/** 逐年度收益（必须完整展示含亏损年份，B-4） */
function yearlyReturns(nav, peerSeries, rankSeries) {
  const byYear = new Map();
  for (const p of nav) {
    if (!isNum(p.adj)) continue;
    byYear.set(dates.yearOf(p.date), p);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (!years.length) return [];
  const firstDate = nav.find((p) => isNum(p.adj)).date;
  const lastDate = nav[nav.length - 1].date;
  const curYear = dates.yearOf(lastDate);

  const peerByYear = new Map();
  for (const p of peerSeries || []) {
    if (isNum(p.value)) peerByYear.set(dates.yearOf(p.date), p);
  }
  const rankByYear = new Map();
  for (const r of rankSeries || []) {
    if (isNum(r.rank) && isNum(r.total) && r.total > 0) rankByYear.set(dates.yearOf(r.date), r);
  }

  const out = [];
  for (const y of years) {
    const end = byYear.get(y);
    const prev = byYear.get(y - 1);
    const base = prev || pointAt(nav, `${y}-01-01`) || nav.find((p) => isNum(p.adj));
    if (!base || base.date === end.date) continue;
    const isFirstYear = dates.yearOf(firstDate) === y;
    const peerEnd = peerByYear.get(y);
    const peerPrev = peerByYear.get(y - 1);
    const rank = rankByYear.get(y);
    out.push({
      year: y,
      pct: round((end.adj / base.adj - 1) * 100, 2),
      peerAvgPct: peerEnd && peerPrev && peerPrev.value > 0 ? round((peerEnd.value / peerPrev.value - 1) * 100, 2) : null,
      rank: rank ? rank.rank : null,
      rankTotal: rank ? rank.total : null,
      rankPct: rank ? round((rank.rank / rank.total) * 100, 1) : null,
      isPartial: isFirstYear || y === curYear,
      partialReason: isFirstYear ? '基金当年成立，非完整年度' : y === curYear ? '当年尚未结束' : null,
      from: base.date,
      to: end.date,
    });
  }
  return out;
}

/** 跟踪误差（需要标的/基准日频序列；公开接口通常不可得，则返回不可用并说明） */
function trackingError(nav, benchSeries, limitPct) {
  const bench = (benchSeries || []).filter((p) => isNum(p.value));
  if (bench.length < 120) {
    return {
      available: false,
      reason: '缺少标的指数日频序列（公开接口不提供），无法计算年化跟踪误差；已改用基金合同约定上限与同类排名作为参考',
      contractLimitPct: limitPct ?? null,
    };
  }
  const navMap = new Map(nav.filter((p) => isNum(p.adj)).map((p) => [p.date, p.adj]));
  const diffs = [];
  let prevF = null;
  let prevB = null;
  for (const p of bench) {
    const f = navMap.get(p.date);
    if (!isNum(f)) continue;
    if (prevF !== null && prevB !== null && prevF > 0 && prevB > 0) {
      diffs.push(f / prevF - p.value / prevB);
    }
    prevF = f;
    prevB = p.value;
  }
  if (diffs.length < 100) {
    return { available: false, reason: '基金与标的指数可对齐的交易日不足', contractLimitPct: limitPct ?? null };
  }
  const sd = stdev(diffs);
  const avgDaily = mean(diffs);
  return {
    available: true,
    annualPct: sd === null ? null : round(sd * Math.sqrt(252) * 100, 2),
    avgDailyDeviationPct: avgDaily === null ? null : round(avgDaily * 100, 4),
    samples: diffs.length,
    contractLimitPct: limitPct ?? null,
  };
}

/** 信息比率（相对同类平均），需足够长的重叠窗口 */
function infoRatio(nav, peerSeries) {
  const peer = (peerSeries || []).filter((p) => isNum(p.value));
  if (peer.length < 120) return { available: false, reason: '同类平均日频序列窗口不足（公开接口仅提供近期数据）' };
  const navMap = new Map(nav.filter((p) => isNum(p.adj)).map((p) => [p.date, p.adj]));
  const ex = [];
  let pf = null;
  let pp = null;
  for (const p of peer) {
    const f = navMap.get(p.date);
    if (!isNum(f)) continue;
    if (pf !== null && pp !== null && pf > 0 && pp > 0) ex.push(f / pf - p.value / pp);
    pf = f;
    pp = p.value;
  }
  if (ex.length < 100) return { available: false, reason: '可对齐交易日不足' };
  const m = mean(ex);
  const sd = stdev(ex);
  if (!isNum(m) || !isNum(sd) || sd === 0) return { available: false, reason: '超额序列无波动' };
  return {
    available: true,
    value: round((m * 252) / (sd * Math.sqrt(252)), 2),
    annualExcessPct: round(m * 252 * 100, 2),
    trackingDiffPct: round(sd * Math.sqrt(252) * 100, 2),
    samples: ex.length,
    windowFrom: peer[0].date,
    windowTo: peer[peer.length - 1].date,
  };
}

/**
 * 主入口
 * @param {object} bundle
 * @param {object} holdingsSummary holdings.js 的输出（持仓与风格，不含价格信息）
 */
function compute(bundle, holdingsSummary) {
  const nav = (bundle.nav || []).filter((p) => isNum(p.adj));
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const th = thresholdsFor(fundType);
  const ps = bundle.periodStats || null;

  if (nav.length < 20) {
    return { applicable: true, insufficient: true, reason: '净值序列过短，无法计算业绩指标', score: null, subScores: {} };
  }

  const lastDate = nav[nav.length - 1].date;
  const establishDate = profile.establishDate || nav[0].date;
  const monthsSinceStart = establishDate ? Math.round((dates.diffDays(lastDate, establishDate) || 0) / 30.44) : null;
  // 合规：不足 6 个月不展示区间收益排名（F7-3 / F2-22）
  const rankSuppressed = isNum(monthsSinceStart) && monthsSinceStart < th.establishedMinMonths;
  const shortHistory = isNum(monthsSinceStart) && monthsSinceStart < th.establishedShortMonths;

  /* ---------------- 区间收益 ---------------- */
  const intervals = {};
  for (const it of INTERVALS) {
    const from = it.shift(lastDate);
    const r = intervalReturn(nav, from);
    if (!r) continue;
    const notFull = from && r.fromDate > from ? true : false;
    const peerFromStats = ps?.[it.key];
    const peerFromSeries = intervalReturn(bundle.peerAvgSeries, from, 'value');
    const hs300FromSeries = intervalReturn(bundle.csi300Series, from, 'value');
    const peerAvgPct = isNum(peerFromStats?.peerAvgPct) ? peerFromStats.peerAvgPct : peerFromSeries?.pct ?? null;
    const hs300Pct = isNum(peerFromStats?.hs300Pct) ? peerFromStats.hs300Pct : hs300FromSeries?.pct ?? null;
    // 排名优先用数据源公布的阶段排名；缺失时对「近1年」用同类排名日序列末值兜底（该序列即近1年滚动排名）
    const lastRank = (bundle.rankSeries || []).filter((r) => isNum(r.rank) && isNum(r.total)).slice(-1)[0] || null;
    const fallbackRank = it.key === '1y' ? lastRank : null;
    const rank = rankSuppressed ? null : peerFromStats?.rank ?? fallbackRank?.rank ?? null;
    const total = rankSuppressed ? null : peerFromStats?.total ?? fallbackRank?.total ?? null;

    intervals[it.key] = {
      label: it.label,
      pct: r.pct,
      annualizedPct: it.annualize ? annualize(r.pct, r.days) : null,
      fromDate: r.fromDate,
      toDate: r.toDate,
      days: r.days,
      notFullPeriod: notFull,
      peerAvgPct,
      hs300Pct,
      excessVsPeerPp: isNum(peerAvgPct) ? round(r.pct - peerAvgPct, 2) : null,
      excessVsHs300Pp: isNum(hs300Pct) ? round(r.pct - hs300Pct, 2) : null,
      rank,
      rankTotal: total,
      rankPct: isNum(rank) && isNum(total) && total > 0 ? round((rank / total) * 100, 1) : null,
      // 排名口径必须可核验（B-3 / F7-3）
      rankNote: isNum(rank) ? `同类 ${total} 只中第 ${rank} 名，截止 ${lastDate}` : null,
      // 若本平台自算与数据源公布的区间收益差异较大，标注以便排查复权口径
      publishedPct: isNum(peerFromStats?.fundPct) ? peerFromStats.fundPct : null,
      publishedDiffPp: isNum(peerFromStats?.fundPct) ? round(Math.abs(r.pct - peerFromStats.fundPct), 2) : null,
    };
  }

  /* ---------------- 逐年度 ---------------- */
  const yearly = yearlyReturns(nav, bundle.peerAvgSeries, bundle.rankSeries);

  /* ---------------- 超额与稳定性 ---------------- */
  const longest = ['5y', '3y', '2y', '1y'].map((k) => intervals[k]).find((x) => x && isNum(x.excessVsPeerPp));
  const annualExcessVsPeerPp = longest
    ? round((longest.annualizedPct ?? longest.pct) - (annualize(longest.peerAvgPct, longest.days) ?? longest.peerAvgPct), 2)
    : null;

  const ir = infoRatio(nav, bundle.peerAvgSeries);
  const te = trackingError(nav, bundle.benchmarkSeries, bundle.fees?.trackingErrorLimitPct);

  const rankPcts = yearly.filter((y) => isNum(y.rankPct) && !y.isPartial).map((y) => y.rankPct);
  const intervalRankPcts = Object.values(intervals).filter((x) => isNum(x.rankPct)).map((x) => x.rankPct);
  const yearsInTop50 = rankPcts.filter((p) => p <= 50).length;
  const yearsInTop25 = rankPcts.filter((p) => p <= 25).length;
  const excessYears = yearly.filter((y) => isNum(y.peerAvgPct));
  const bestYear = yearly.length ? yearly.reduce((a, b) => (a.pct >= b.pct ? a : b)) : null;

  // 是否依赖单一年份：剔除最好年份后累计收益是否转负
  let dependsOnSingleYear = null;
  if (yearly.length >= 3 && bestYear) {
    const prod = yearly
      .filter((y) => y.year !== bestYear.year)
      .reduce((acc, y) => acc * (1 + y.pct / 100), 1);
    dependsOnSingleYear = prod - 1 < 0;
  }

  const stability = {
    yearsCounted: rankPcts.length,
    yearsInTop50,
    yearsInTop25,
    top50RatioPct: rankPcts.length ? round((yearsInTop50 / rankPcts.length) * 100, 1) : null,
    rankPctStdev: rankPcts.length >= 3 ? round(stdev(rankPcts), 1) : null,
    bestYear: bestYear ? { year: bestYear.year, pct: bestYear.pct } : null,
    worstYear: yearly.length ? (() => { const w = yearly.reduce((a, b) => (a.pct <= b.pct ? a : b)); return { year: w.year, pct: w.pct }; })() : null,
    negativeYears: yearly.filter((y) => y.pct < 0).length,
    dependsOnSingleYear,
    excessPositiveYears: excessYears.filter((y) => y.pct > y.peerAvgPct).length,
    excessTotalYears: excessYears.length,
  };

  /* ---------------- 能力分 A ---------------- */
  const w = weightsOf('ability', fundType) || {};
  const avgRankPct = intervalRankPcts.length ? mean(intervalRankPcts) : rankPcts.length ? mean(rankPcts) : null;
  const longTermAnnualized = intervals['3y']?.annualizedPct ?? intervals['since']?.annualizedPct ?? null;

  const subScores = {
    longTerm: isNum(avgRankPct)
      ? Math.round(100 - avgRankPct)
      : scoreLinear(longTermAnnualized, -12, 20),
    excess: scoreLinear(annualExcessVsPeerPp, -12, 12),
    stability: (() => {
      const a = isNum(stability.top50RatioPct) ? stability.top50RatioPct : null;
      const b = isNum(stability.rankPctStdev) ? scoreLinear(stability.rankPctStdev, 35, 5) : null;
      const vals = [a, b].filter(isNum);
      return vals.length ? Math.round(mean(vals)) : null;
    })(),
    holdingStyle: holdingsSummary?.styleScore ?? null,
    tracking: te.available
      ? scoreLinear(te.annualPct, (te.contractLimitPct || th.trackingErrorHighPct) * 2, 0)
      : null,
    scaleLiquidity: (() => {
      const s = profile.scaleYi;
      if (!isNum(s)) return null;
      if (s < th.miniScaleYi) return 15;
      if (s > th.hugeScaleYi) return 55;
      return scoreLinear(Math.log10(Math.max(0.1, s)), Math.log10(th.miniScaleYi), Math.log10(Math.max(th.miniScaleYi * 2, 60)));
    })(),
  };

  const parts = Object.entries(w).map(([k, weight]) => ({ score: subScores[k], weight }));
  let { score, missing } = weightedScore(parts);
  // 成立不足 1 年：结论参考价值有限，得分上限受约束（B-8）
  if (score !== null && shortHistory) score = Math.min(score, 65);

  const tag =
    score === null ? '数据不足' : score >= 80 ? '优秀' : score >= 65 ? '良好' : score >= 45 ? '一般' : '较弱';

  return {
    applicable: true,
    insufficient: false,
    score,
    subScores,
    weights: w,
    missingSubModules: missing,
    tag,
    monthsSinceStart,
    shortHistory,
    shortHistoryNote: shortHistory ? '基金成立不足 1 年，业绩期过短，本板块结论参考价值有限' : null,
    rankSuppressed,
    rankSuppressedNote: rankSuppressed
      ? `基金成立不足 ${th.establishedMinMonths} 个月，按行业规范不展示区间收益排名`
      : null,
    intervals,
    yearly,
    excess: {
      annualExcessVsPeerPp,
      basedOn: longest ? longest.label : null,
      infoRatio: ir,
      byInterval: Object.fromEntries(
        Object.entries(intervals).map(([k, v]) => [k, { excessVsPeerPp: v.excessVsPeerPp, excessVsHs300Pp: v.excessVsHs300Pp }])
      ),
    },
    tracking: te,
    stability,
    holdings: holdingsSummary || null,
    benchmark: profile.benchmark || null,
    tracks: profile.tracks || null,
    peerSource: ps ? '数据源公布的同类平均与同类排名' : '由同类平均净值序列自算',
  };
}

module.exports = { compute, INTERVALS, intervalReturn, yearlyReturns, trackingError, infoRatio };
