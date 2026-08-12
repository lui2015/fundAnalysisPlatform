'use strict';
/**
 * 好体验（板块④）指标计算 —— 体验分 X
 *
 * 全部为确定性计算，模型只做解读（F3-1 先算后说）。
 * 一律使用复权净值 adj（已含分红再投），避免分红/拆分导致的收益与回撤失真。
 */
const dates = require('../utils/dates');
const { isNum, round, mean, stdev, quantile, scoreLinear, weightedScore, annualize } = require('../utils/num');
const { thresholdsFor } = require('../config/riskRules');
const { weightsOf, TYPE } = require('../config/fundTypes');

const TRADING_DAYS_YEAR = 252;
const RISK_FREE_PCT = 1.5; // 无风险利率假设，报告中会显式说明

/** 日收益序列（小数） */
function dailyReturns(nav) {
  const out = [];
  for (let i = 1; i < nav.length; i += 1) {
    const a = nav[i - 1].adj;
    const b = nav[i].adj;
    if (isNum(a) && isNum(b) && a > 0) out.push({ date: nav[i].date, r: b / a - 1 });
  }
  return out;
}

/**
 * 回撤序列与回撤区间识别
 * @returns {{series:Array, episodes:Array, current:object}}
 */
function drawdownAnalysis(nav) {
  const series = [];
  let peak = -Infinity;
  let peakDate = null;
  for (const p of nav) {
    if (!isNum(p.adj)) continue;
    if (p.adj > peak) {
      peak = p.adj;
      peakDate = p.date;
    }
    series.push({ date: p.date, dd: round((p.adj / peak - 1) * 100, 2), peakDate });
  }

  // 识别独立回撤区间：从创新高后开始下跌，到重新创新高（或至今）结束
  const episodes = [];
  let cur = null;
  for (let i = 0; i < series.length; i += 1) {
    const s = series[i];
    if (s.dd < 0) {
      if (!cur) cur = { startDate: s.peakDate, bottomDate: s.date, maxDdPct: s.dd, recoverDate: null };
      else if (s.peakDate !== cur.startDate) {
        // 峰值已更新说明上一段已修复，理论上不会走到这里
        episodes.push(cur);
        cur = { startDate: s.peakDate, bottomDate: s.date, maxDdPct: s.dd, recoverDate: null };
      }
      if (s.dd < cur.maxDdPct) {
        cur.maxDdPct = s.dd;
        cur.bottomDate = s.date;
      }
    } else if (cur) {
      cur.recoverDate = s.date;
      episodes.push(cur);
      cur = null;
    }
  }
  const ongoing = cur;
  if (cur) episodes.push(cur);

  for (const e of episodes) {
    e.declineDays = dates.diffDays(e.bottomDate, e.startDate);
    e.recoveryDays = e.recoverDate ? dates.diffDays(e.recoverDate, e.bottomDate) : null;
    e.totalDays = e.recoverDate ? dates.diffDays(e.recoverDate, e.startDate) : null;
  }

  const last = series.length ? series[series.length - 1] : null;
  const current = ongoing
    ? {
        ddPct: last?.dd ?? null,
        sincePeakDate: ongoing.startDate,
        durationDays: dates.diffDays(last?.date, ongoing.startDate),
        bottomDate: ongoing.bottomDate,
        bottomDdPct: ongoing.maxDdPct,
      }
    : { ddPct: last?.dd ?? 0, sincePeakDate: null, durationDays: 0, bottomDate: null, bottomDdPct: null };

  return { series, episodes, current };
}

/** 月度收益 */
function monthlyReturns(nav) {
  const byMonth = new Map();
  for (const p of nav) {
    if (!isNum(p.adj)) continue;
    byMonth.set(dates.monthKey(p.date), p);
  }
  const keys = [...byMonth.keys()].sort();
  const out = [];
  for (let i = 1; i < keys.length; i += 1) {
    const a = byMonth.get(keys[i - 1]).adj;
    const b = byMonth.get(keys[i]).adj;
    if (a > 0) out.push({ month: keys[i], pct: round((b / a - 1) * 100, 2) });
  }
  return out;
}

/**
 * 滚动持有正收益概率（本产品差异化核心）
 * 对每一个可能的买入交易日，计算持有指定时长后的收益，统计正收益比例与分布
 */
function rollingHold(nav, windows) {
  const adj = nav.filter((p) => isNum(p.adj));
  const out = {};
  for (const [key, days] of Object.entries(windows)) {
    if (adj.length <= days + 5) {
      out[key] = { available: false, reason: '历史数据长度不足，样本不可用', windowDays: days };
      continue;
    }
    const rets = [];
    for (let i = 0; i + days < adj.length; i += 1) {
      rets.push((adj[i + days].adj / adj[i].adj - 1) * 100);
    }
    const positive = rets.filter((r) => r > 0).length;
    out[key] = {
      available: true,
      windowDays: days,
      samples: rets.length,
      positiveRatePct: round((positive / rets.length) * 100, 1),
      medianPct: round(quantile(rets, 0.5), 2),
      p10Pct: round(quantile(rets, 0.1), 2),
      p90Pct: round(quantile(rets, 0.9), 2),
      worstPct: round(Math.min(...rets), 2),
      bestPct: round(Math.max(...rets), 2),
      sampleFrom: adj[0].date,
      sampleTo: adj[adj.length - 1].date,
    };
  }
  return out;
}

/**
 * 定投历史模拟（按月首个交易日投入等额资金）
 * 输出不同期数下的最终收益率分布，纯历史回溯，不构成建议
 */
function dcaSimulation(nav, periodsList = [12, 24, 36]) {
  const firstOfMonth = new Map();
  for (const p of nav) {
    if (!isNum(p.adj)) continue;
    const mk = dates.monthKey(p.date);
    if (!firstOfMonth.has(mk)) firstOfMonth.set(mk, p);
  }
  const points = [...firstOfMonth.values()];
  const out = {};
  for (const n of periodsList) {
    if (points.length <= n + 1) {
      out[`${n}m`] = { available: false, reason: '月度样本不足', periods: n };
      continue;
    }
    const results = [];
    for (let s = 0; s + n < points.length; s += 1) {
      let shares = 0;
      for (let k = 0; k < n; k += 1) shares += 1 / points[s + k].adj; // 每期投入 1 元
      const endValue = shares * points[s + n].adj;
      results.push((endValue / n - 1) * 100);
    }
    const positive = results.filter((r) => r > 0).length;
    out[`${n}m`] = {
      available: true,
      periods: n,
      samples: results.length,
      positiveRatePct: round((positive / results.length) * 100, 1),
      medianPct: round(quantile(results, 0.5), 2),
      p10Pct: round(quantile(results, 0.1), 2),
      p90Pct: round(quantile(results, 0.9), 2),
    };
  }
  return out;
}

/** 同类平均的对照指标（数据窗口可能较短，需标注） */
function peerComparison(peerSeries) {
  const s = (peerSeries || []).filter((p) => isNum(p.value));
  if (s.length < 60) return { available: false, reason: '同类平均序列长度不足（公开接口仅提供近期数据）' };
  const rets = [];
  for (let i = 1; i < s.length; i += 1) rets.push(s[i].value / s[i - 1].value - 1);
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of s) {
    if (p.value > peak) peak = p.value;
    maxDd = Math.min(maxDd, p.value / peak - 1);
  }
  const sd = stdev(rets);
  return {
    available: true,
    windowDays: s.length,
    from: s[0].date,
    to: s[s.length - 1].date,
    maxDrawdownPct: round(maxDd * 100, 2),
    volatilityPct: sd === null ? null : round(sd * Math.sqrt(TRADING_DAYS_YEAR) * 100, 2),
  };
}

/**
 * 主入口
 * @param {object} bundle 数据包
 * @returns {object} 体验指标 + 体验分 X
 */
function compute(bundle) {
  const nav = (bundle.nav || []).filter((p) => isNum(p.adj));
  const fundType = bundle.profile.fundType;
  const th = thresholdsFor(fundType);

  if (nav.length < 30) {
    return {
      applicable: true,
      insufficient: true,
      reason: '净值序列过短（不足 30 个交易日），无法计算回撤与波动指标',
      score: null,
      subScores: {},
    };
  }

  const rets = dailyReturns(nav);
  const rArr = rets.map((x) => x.r);
  const dd = drawdownAnalysis(nav);
  const monthly = monthlyReturns(nav);

  const totalDays = dates.diffDays(nav[nav.length - 1].date, nav[0].date);
  const totalPct = round((nav[nav.length - 1].adj / nav[0].adj - 1) * 100, 2);
  const annualizedPct = annualize(totalPct, totalDays);

  const sd = stdev(rArr);
  const volatilityPct = sd === null ? null : round(sd * Math.sqrt(TRADING_DAYS_YEAR) * 100, 2);
  const negRets = rArr.filter((r) => r < 0);
  const downSd = stdev(negRets);
  const downsideVolPct = downSd === null ? null : round(downSd * Math.sqrt(TRADING_DAYS_YEAR) * 100, 2);

  const sharpe =
    isNum(annualizedPct) && isNum(volatilityPct) && volatilityPct > 0
      ? round((annualizedPct - RISK_FREE_PCT) / volatilityPct, 2)
      : null;
  const sortino =
    isNum(annualizedPct) && isNum(downsideVolPct) && downsideVolPct > 0
      ? round((annualizedPct - RISK_FREE_PCT) / downsideVolPct, 2)
      : null;

  const sortedEpisodes = dd.episodes.slice().sort((a, b) => a.maxDdPct - b.maxDdPct);
  const worst = sortedEpisodes[0] || null;
  /**
   * 修复时长只统计「有意义的回撤」：日常 1~2% 的小波动会在几天内自动回补，
   * 若把它们计入中位数，会得出「回撤 0.3 个月就能修复」这类误导性结论。
   * 门槛取该类型基金的中等回撤阈值。
   */
  const significantDdPct = Math.max(3, th.maxDrawdownMid);
  const significantEpisodes = dd.episodes.filter((e) => e.maxDdPct <= -significantDdPct);
  const recoveredDaysList = significantEpisodes.filter((e) => isNum(e.recoveryDays)).map((e) => e.recoveryDays);
  const recoveryMedianDays = recoveredDaysList.length ? Math.round(quantile(recoveredDaysList, 0.5)) : null;
  const recoveryMaxDays = recoveredDaysList.length ? Math.max(...recoveredDaysList) : null;

  const maxDrawdownPct = worst ? worst.maxDdPct : 0;
  const calmar = isNum(annualizedPct) && maxDrawdownPct < 0 ? round(annualizedPct / Math.abs(maxDrawdownPct), 2) : null;

  // 单日极值与连续下跌
  const worstDay = rArr.length ? round(Math.min(...rArr) * 100, 2) : null;
  const bestDay = rArr.length ? round(Math.max(...rArr) * 100, 2) : null;
  let streak = 0;
  let maxStreak = 0;
  for (const r of rArr) {
    if (r < 0) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  }
  let mStreak = 0;
  let maxMonthStreak = 0;
  for (const m of monthly) {
    if (m.pct < 0) {
      mStreak += 1;
      maxMonthStreak = Math.max(maxMonthStreak, mStreak);
    } else mStreak = 0;
  }
  const monthWinRatePct = monthly.length ? round((monthly.filter((m) => m.pct > 0).length / monthly.length) * 100, 1) : null;

  const rolling = rollingHold(nav, {
    '1m': 21,
    '6m': 126,
    '1y': TRADING_DAYS_YEAR,
    '2y': TRADING_DAYS_YEAR * 2,
    '3y': TRADING_DAYS_YEAR * 3,
  });
  const dca = dcaSimulation(nav);
  const peer = peerComparison(bundle.peerAvgSeries);

  // 10 万元金额换算（需求 D-2；固定基准、明确为历史情形演示而非收益预测）
  const amountDemo = {
    baseAmount: 100000,
    maxLossAmount: worst ? Math.round(100000 * Math.abs(worst.maxDdPct)) / 100 : 0,
    note: '按投入 10 万元换算的历史最大浮亏金额，为历史情形演示，不代表未来表现，也非收益预测',
  };

  /* ---------------- 交叉校验（应对净值复权处理错误的致命风险） ---------------- */
  const crossCheck = { checked: false, items: [] };
  const cc = bundle.crossCheck;
  if (cc) {
    crossCheck.checked = true;
    // 近 1 年回撤：用第三方公布值与自算值比对
    const oneYearFrom = dates.addYears(nav[nav.length - 1].date, -1);
    const nav1y = nav.filter((p) => p.date >= oneYearFrom);
    if (nav1y.length > 60) {
      let pk = -Infinity;
      let md = 0;
      for (const p of nav1y) {
        if (p.adj > pk) pk = p.adj;
        md = Math.min(md, p.adj / pk - 1);
      }
      const mine = round(Math.abs(md * 100), 2);
      if (isNum(cc.maxDrawdown1y)) {
        const diff = round(Math.abs(mine - cc.maxDrawdown1y), 2);
        crossCheck.items.push({
          item: '近1年最大回撤',
          mine,
          published: round(cc.maxDrawdown1y, 2),
          diffPp: diff,
          pass: diff <= 2,
        });
      }
      const my1y = round((nav1y[nav1y.length - 1].adj / nav1y[0].adj - 1) * 100, 2);
      if (isNum(cc.return1y)) {
        const diff = round(Math.abs(my1y - cc.return1y), 2);
        crossCheck.items.push({
          item: '近1年收益率',
          mine: my1y,
          published: round(cc.return1y, 2),
          diffPp: diff,
          pass: diff <= 1.5,
        });
      }
    }
    if (isNum(cc.stddev1y) && nav1y.length > 60) {
      // 必须用同口径（近 1 年）比对，否则全区间波动率与公布的近 1 年值天然不同，会产生假失败
      const r1y = dailyReturns(nav1y).map((x) => x.r);
      const sd1y = stdev(r1y);
      const mine1y = sd1y === null ? null : round(sd1y * Math.sqrt(TRADING_DAYS_YEAR) * 100, 2);
      if (isNum(mine1y)) {
        const diff = round(Math.abs(mine1y - cc.stddev1y), 2);
        crossCheck.items.push({
          item: '近1年年化波动率',
          mine: mine1y,
          published: round(cc.stddev1y, 2),
          diffPp: diff,
          pass: diff <= 2,
        });
      }
    }
    crossCheck.allPass = crossCheck.items.every((x) => x.pass);
    crossCheck.note = crossCheck.allPass
      ? '自算指标与数据源公布值一致'
      : '自算指标与数据源公布值存在差异，可能源于统计区间口径不同，报告中已标注';
  }

  /* ---------------- 体验分 X ---------------- */
  const w = weightsOf('experience', fundType) || {};
  const oneYearPositive = rolling['1y']?.available ? rolling['1y'].positiveRatePct : null;
  const subScores = {
    drawdown: scoreLinear(Math.abs(maxDrawdownPct), th.maxDrawdownHigh * 1.5, 0),
    recovery: scoreLinear(recoveryMedianDays, th.recoveryLongDays, 20),
    volatility: scoreLinear(volatilityPct, th.volatilityHigh * 1.6, 0),
    riskAdjusted: scoreLinear(sharpe, -1, 2),
    positiveRate: scoreLinear(oneYearPositive, 25, 95),
  };
  const parts = Object.entries(w).map(([k, weight]) => ({ score: subScores[k], weight }));
  const { score, missing } = weightedScore(parts);

  const tag =
    score === null
      ? '数据不足'
      : Math.abs(maxDrawdownPct) <= th.maxDrawdownMid * 0.6
        ? '平稳'
        : Math.abs(maxDrawdownPct) <= th.maxDrawdownMid
          ? '中等波动'
          : Math.abs(maxDrawdownPct) <= th.maxDrawdownHigh
            ? '较大波动'
            : '剧烈波动';

  return {
    applicable: true,
    insufficient: false,
    score,
    subScores,
    weights: w,
    missingSubModules: missing,
    tag,
    scoreNote: '体验分衡量的是持有过程的难受程度，分数高不代表收益高',
    window: { from: nav[0].date, to: nav[nav.length - 1].date, days: totalDays, points: nav.length },
    totalPct,
    annualizedPct,
    riskFreePct: RISK_FREE_PCT,
    drawdown: {
      maxPct: maxDrawdownPct,
      maxFrom: worst?.startDate || null,
      maxBottom: worst?.bottomDate || null,
      maxRecoverDate: worst?.recoverDate || null,
      maxDeclineDays: worst?.declineDays ?? null,
      maxRecoveryDays: worst?.recoveryDays ?? null,
      top3: sortedEpisodes.slice(0, 3).map((e) => ({
        maxDdPct: e.maxDdPct,
        from: e.startDate,
        bottom: e.bottomDate,
        recoverDate: e.recoverDate,
        recoveryDays: e.recoveryDays,
      })),
      current: dd.current,
      recoveryMedianDays,
      recoveryMaxDays,
      recoveredEpisodes: recoveredDaysList.length,
      significantDdThresholdPct: significantDdPct,
      significantEpisodes: significantEpisodes.length,
      unrecoveredSignificant: significantEpisodes.filter((e) => !isNum(e.recoveryDays)).length,
      series: dd.series,
    },
    volatility: {
      annualPct: volatilityPct,
      downsidePct: downsideVolPct,
      worstDayPct: worstDay,
      bestDayPct: bestDay,
      maxConsecutiveDownDays: maxStreak,
      maxConsecutiveDownMonths: maxMonthStreak,
      monthWinRatePct,
      monthlySamples: monthly.length,
    },
    riskAdjusted: { sharpe, sortino, calmar },
    rollingHold: rolling,
    dca,
    peerComparison: peer,
    amountDemo,
    crossCheck,
    monthly,
  };
}

module.exports = { compute, dailyReturns, drawdownAnalysis, rollingHold, dcaSimulation, TRADING_DAYS_YEAR };
