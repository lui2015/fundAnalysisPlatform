'use strict';
/**
 * 好时机与成本（板块⑤）指标计算 —— 时机成本分 T
 *
 * 板块正交约束（需求 E-6）：本模块不评价基金好坏与经理能力，只描述「价格位置」与「成本」。
 * 费率测算必须给出可核对的计算过程（E-3），A/C 对照只陈述成本事实（E-4）。
 */
const dates = require('../utils/dates');
const { isNum, round, percentileRank, scoreLinear, weightedScore, quantile } = require('../utils/num');
const { thresholdsFor } = require('../config/riskRules');
const { weightsOf, TYPE, policyOf } = require('../config/fundTypes');

/** 按持有天数取赎回费率 */
function redeemRateFor(tiers, days) {
  const list = (tiers || []).filter((t) => isNum(t.ratePct));
  if (!list.length) return null;
  for (const t of list) {
    if (t.maxDays === null || t.maxDays === undefined) return t.ratePct;
    if (days < t.maxDays) return t.ratePct;
  }
  return list[list.length - 1].ratePct;
}

/**
 * 总持有成本测算（可核对）
 * 成本 = 申购费 + 年运作费率 × 持有年数 + 赎回费
 */
function totalCostFor(fees, days) {
  const annual = ['management', 'custody', 'salesService']
    .map((k) => (isNum(fees[k]) ? fees[k] : 0))
    .reduce((a, b) => a + b, 0);
  const purchase = isNum(fees.purchase) ? fees.purchase : 0;
  const redeem = redeemRateFor(fees.redeemTiers, days);
  const running = round((annual * days) / 365, 4);
  const total = round(purchase + running + (isNum(redeem) ? redeem : 0), 4);
  return {
    holdDays: days,
    purchasePct: round(purchase, 4),
    annualRunningPct: round(annual, 4),
    runningPct: running,
    redeemPct: isNum(redeem) ? round(redeem, 4) : null,
    totalPct: total,
    formula: `申购费 ${round(purchase, 3)}% + 年运作费率 ${round(annual, 3)}% × ${days}/365 + 赎回费 ${isNum(redeem) ? `${round(redeem, 3)}%` : '未知'}`,
  };
}

const HOLD_PERIODS = [
  { key: '1m', label: '持有1个月', days: 30 },
  { key: '6m', label: '持有6个月', days: 182 },
  { key: '1y', label: '持有1年', days: 365 },
  { key: '3y', label: '持有3年', days: 1095 },
];

/** A/C 类成本对照与成本反转点（仅陈述事实，不给选择建议） */
function shareClassCompare(selfFees, selfClass, siblings) {
  const sib = (siblings || []).find((s) => s.fees && s.shareClass && s.shareClass !== selfClass);
  if (!sib) {
    return {
      available: false,
      reason: '未获取到同系列其他份额（A/C 类）的费率数据，无法给出成本对照',
      selfShareClass: selfClass || null,
      siblingCodes: (siblings || []).map((s) => ({ code: s.code, name: s.name, shareClass: s.shareClass })),
    };
  }
  const rows = HOLD_PERIODS.map((p) => ({
    label: p.label,
    holdDays: p.days,
    selfPct: totalCostFor(selfFees, p.days).totalPct,
    siblingPct: totalCostFor(sib.fees, p.days).totalPct,
  }));
  // 成本反转点：逐日扫描第一次出现「自身成本高于对照份额」的持有天数
  let crossoverDays = null;
  let prevSign = null;
  for (let d = 1; d <= 1460; d += 1) {
    const a = totalCostFor(selfFees, d).totalPct;
    const b = totalCostFor(sib.fees, d).totalPct;
    const sign = Math.sign(round(a - b, 4));
    if (prevSign !== null && sign !== 0 && sign !== prevSign) {
      crossoverDays = d;
      break;
    }
    if (sign !== 0) prevSign = sign;
  }
  return {
    available: true,
    selfShareClass: selfClass || null,
    sibling: { code: sib.code, name: sib.name, shareClass: sib.shareClass },
    rows,
    crossoverDays,
    statement: crossoverDays
      ? `按当前公开费率测算，持有约 ${crossoverDays} 天（约 ${Math.round(crossoverDays / 30)} 个月）时两类份额总成本相等；短于该期限时成本更低的是${
          totalCostFor(selfFees, Math.max(1, crossoverDays - 20)).totalPct <
          totalCostFor(sib.fees, Math.max(1, crossoverDays - 20)).totalPct
            ? `本份额（${selfClass}）`
            : `${sib.shareClass} 类`
        }`
      : '两类份额在 4 年内的总成本高低关系未发生反转',
    note: '测算基于公开费率，不含各销售平台的费率折扣差异；本平台不提供份额选择建议',
  };
}

function compute(bundle) {
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const th = thresholdsFor(fundType);
  const policy = policyOf(fundType) || {};
  const nav = (bundle.nav || []).filter((p) => isNum(p.adj));
  const navDate = profile.navDate || (nav.length ? nav[nav.length - 1].date : null);

  /* -------------------- 1) 持仓估值位置 -------------------- */
  const val = bundle.valuation;
  let valuation = { available: false, reason: '该类型基金不适用持仓估值分位，或未获取到重仓股估值数据' };
  if (val && isNum(val.pe)) {
    const peSeries = (val.peSeries || []).map((x) => x.pe).filter(isNum);
    const pct3y = null;
    const pct5y = peSeries.length >= 250 ? percentileRank(peSeries, val.pe) : null;
    valuation = {
      available: true,
      pe: val.pe,
      pb: isNum(val.pb) ? val.pb : null,
      coveredWeightPct: val.coveredWeightPct ?? null,
      holdingPeriod: val.holdingPeriod || null,
      percentile5y: pct5y,
      percentile3y: pct3y,
      percentileAvailable: isNum(pct5y),
      percentileReason: isNum(pct5y)
        ? null
        : '组合历史估值序列需要逐只重仓股的历史盈利数据，公开接口不可得，因此不提供估值历史分位',
      details: val.details || [],
      lagNote: `估值基于最新披露持仓（${val.holdingPeriod || '报告期未知'}）计算，持仓存在披露滞后`,
      note: val.note || null,
    };
  }
  if (fundType === TYPE.BOND || fundType === TYPE.MONEY) {
    valuation = {
      available: false,
      reason:
        fundType === TYPE.BOND
          ? '债券型基金不适用股票估值分位，本板块以久期与利率环境替代'
          : '货币基金不适用估值分位，本板块仅保留费率与流动性',
    };
  }

  /* -------------------- 2) 净值位置 -------------------- */
  let navPosition = { available: false, reason: '净值序列不足' };
  if (nav.length > 60) {
    const from5y = dates.addYears(navDate, -5);
    const window = nav.filter((p) => p.date >= from5y);
    const vals = window.map((p) => p.adj);
    const cur = nav[nav.length - 1].adj;
    const peak = Math.max(...vals);
    const trough = Math.min(...vals);
    const peakPoint = window.find((p) => p.adj === peak);
    const from3m = dates.addMonths(navDate, -3);
    const base3m = nav.filter((p) => p.date <= from3m).slice(-1)[0] || nav[0];
    navPosition = {
      available: true,
      windowFrom: window[0].date,
      windowTo: navDate,
      windowYears: round((dates.diffDays(navDate, window[0].date) || 0) / 365, 1),
      percentile: percentileRank(vals, cur),
      distanceFromPeakPct: round((cur / peak - 1) * 100, 2),
      peakDate: peakPoint ? peakPoint.date : null,
      distanceFromTroughPct: round((cur / trough - 1) * 100, 2),
      recent3mPct: round((cur / base3m.adj - 1) * 100, 2),
      note: '净值位置基于复权净值在区间内的分位，仅描述位置，不预测走势',
    };
  }

  /* -------------------- 3) 费率与成本 -------------------- */
  const fees = bundle.fees || {};
  const annualRunningPct = ['management', 'custody', 'salesService']
    .map((k) => (isNum(fees[k]) ? fees[k] : 0))
    .reduce((a, b) => a + b, 0);
  const feeKnown = isNum(fees.management) || isNum(fees.purchase);
  const totalCost = HOLD_PERIODS.map((p) => ({ ...totalCostFor(fees, p.days), label: p.label, key: p.key }));
  const feeBlock = {
    available: feeKnown,
    managementPct: isNum(fees.management) ? fees.management : null,
    custodyPct: isNum(fees.custody) ? fees.custody : null,
    salesServicePct: isNum(fees.salesService) ? fees.salesService : null,
    purchasePct: isNum(fees.purchase) ? fees.purchase : null,
    purchaseOriginalPct: isNum(fees.purchaseOriginal) ? fees.purchaseOriginal : null,
    annualRunningPct: round(annualRunningPct, 3),
    redeemTiers: fees.redeemTiers || [],
    totalCost,
    highFee: annualRunningPct > th.totalFeeHighPct,
    highFeeThresholdPct: th.totalFeeHighPct,
    shareClassCompare: shareClassCompare(fees, profile.shareClass, bundle.siblings),
    asOf: fees.asOf || null,
    note: '费率为公开披露值；申购费为常见折扣后费率，实际以销售平台披露为准',
    indexFeeImpact:
      fundType === TYPE.INDEX_EQUITY && isNum(annualRunningPct)
        ? `按年运作费率 ${round(annualRunningPct, 2)}% 计算，持有 10 年累计扣减约 ${round(annualRunningPct * 10, 1)}% 的净值（不考虑复利差异）`
        : null,
  };

  /* -------------------- 4) 规模与申赎状态 -------------------- */
  const scale = bundle.scale || [];
  const latestScale = scale.length ? scale[scale.length - 1] : null;
  const prevScale = scale.length > 1 ? scale[scale.length - 2] : null;
  const scaleChangePct =
    latestScale && prevScale && isNum(latestScale.valueYi) && isNum(prevScale.valueYi) && prevScale.valueYi > 0
      ? round((latestScale.valueYi / prevScale.valueYi - 1) * 100, 2)
      : null;
  const firstScale = scale.length ? scale[0] : null;
  const scaleStatus = {
    available: Boolean(latestScale) || isNum(profile.scaleYi),
    valueYi: latestScale?.valueYi ?? profile.scaleYi ?? null,
    asOf: latestScale?.asOf ?? profile.scaleAsOf ?? null,
    changePct: scaleChangePct,
    trend: scale.map((s) => ({ asOf: s.asOf, valueYi: s.valueYi })),
    surgeRatio:
      firstScale && latestScale && isNum(firstScale.valueYi) && firstScale.valueYi > 0
        ? round(latestScale.valueYi / firstScale.valueYi, 2)
        : null,
    mini: isNum(latestScale?.valueYi ?? profile.scaleYi) && (latestScale?.valueYi ?? profile.scaleYi) < th.miniScaleYi,
    huge: isNum(latestScale?.valueYi ?? profile.scaleYi) && (latestScale?.valueYi ?? profile.scaleYi) > th.hugeScaleYi,
    miniThresholdYi: th.miniScaleYi,
    hugeThresholdYi: th.hugeScaleYi,
    purchaseStatus: profile.purchaseStatus || null,
    purchaseStatusMark: profile.purchaseStatusMark || profile.largePurchaseLimitText || null,
    redeemStatus: profile.redeemStatus || null,
    limited: /限|暂停/.test(String(profile.purchaseStatus || '')),
    redeemSuspended: /暂停/.test(String(profile.redeemStatus || '')),
  };

  /* -------------------- 5) 场内折溢价 -------------------- */
  const q = bundle.onMarketQuote;
  const premium = q
    ? {
        available: isNum(q.premiumPct),
        pricePct: q.price ?? null,
        nav: q.nav ?? null,
        premiumPct: q.premiumPct ?? null,
        warnThresholdPct: th.premiumWarnPct,
        redThresholdPct: th.premiumRedPct,
        level:
          isNum(q.premiumPct) && q.premiumPct >= th.premiumRedPct
            ? 'red'
            : isNum(q.premiumPct) && q.premiumPct >= th.premiumWarnPct
              ? 'warn'
              : 'normal',
        turnoverWan: q.turnoverWan ?? null,
        series: q.premiumSeries || [],
        note: q.note || null,
      }
    : { available: false, reason: profile.onMarket ? '场内行情暂不可用' : '本基金非场内交易基金，不涉及折溢价' };

  /* -------------------- 6) 流动性与交易规则 -------------------- */
  const liquidity = {
    turnoverWan: q?.turnoverWan ?? null,
    lowTurnover: isNum(q?.turnoverWan) ? q.turnoverWan < th.turnoverLowWan : null,
    turnoverThresholdWan: th.turnoverLowWan,
    redeemArrivalText: profile.redeemArrivalText || null,
    minHoldDays: profile.minHoldDays || 0,
    onMarket: Boolean(profile.onMarket),
  };

  /* -------------------- 7) 债券久期与利率环境（替代口径） -------------------- */
  let duration = { available: false, reason: '久期与券种结构需定期报告全文，公开接口不提供' };
  if (bundle.bondDetail) {
    const b = bundle.bondDetail;
    duration = {
      available: true,
      durationYear: b.durationYear ?? null,
      leveragePct: b.leveragePct ?? null,
      convertiblePct: b.convertiblePct ?? null,
      lowRatingPct: b.lowRatingPct ?? null,
      ratingDist: b.ratingDist || [],
      bond10yPct: bundle.market?.bond10yPct ?? null,
      longDuration: isNum(b.durationYear) ? b.durationYear > th.durationLongYear : null,
      thresholdYear: th.durationLongYear,
      asOf: b.asOf || null,
    };
  }

  /* -------------------- 时机成本分 T -------------------- */
  const w = weightsOf('timingCost', fundType) || weightsOf('timingCost', 'default');
  const subScores = {
    valuation: valuation.available && isNum(valuation.percentile5y) ? scoreLinear(valuation.percentile5y, 98, 15) : null,
    navPosition: navPosition.available ? scoreLinear(navPosition.percentile, 98, 10) : null,
    fee: feeBlock.available ? scoreLinear(annualRunningPct, th.totalFeeHighPct * 1.3, 0.15) : null,
    scaleStatus: (() => {
      if (!scaleStatus.available) return null;
      let s = 78;
      if (scaleStatus.mini) s -= 45;
      if (scaleStatus.huge) s -= 18;
      if (scaleStatus.limited) s -= 12;
      if (scaleStatus.redeemSuspended) s -= 35;
      if (premium.available && premium.level === 'red') s -= 25;
      else if (premium.available && premium.level === 'warn') s -= 10;
      if (isNum(scaleStatus.changePct) && Math.abs(scaleStatus.changePct) > th.scaleShrinkPct) s -= 10;
      return Math.max(0, Math.min(100, s));
    })(),
    duration: duration.available ? scoreLinear(duration.durationYear, th.durationLongYear * 2, 0.5) : null,
  };
  const parts = Object.entries(w).map(([k, weight]) => ({ score: subScores[k], weight }));
  const { score, missing } = weightedScore(parts);

  const tag = (() => {
    if (score === null) return '数据不足';
    if (feeBlock.highFee && score < 55) return '成本偏高';
    if (isNum(valuation.percentile5y)) {
      if (valuation.percentile5y >= th.valuationHighPct) return '位置偏高';
      if (valuation.percentile5y <= 35) return '位置偏低';
    } else if (navPosition.available) {
      if (navPosition.percentile >= 90) return '位置偏高';
      if (navPosition.percentile <= 30) return '位置偏低';
    }
    return '中性';
  })();

  return {
    applicable: true,
    insufficient: false,
    score,
    subScores,
    weights: w,
    missingSubModules: missing,
    tag,
    valuation,
    navPosition,
    fee: feeBlock,
    scaleStatus,
    premium,
    liquidity,
    duration,
    replacedByType: policy.timing_cost === 'replace' ? `本类型基金采用替代口径（${policy.timing_cost}）` : null,
    disclaimer: '本板块仅描述当前价格位置与成本事实，不提供买入时点、择时或份额选择建议',
  };
}

module.exports = { compute, totalCostFor, redeemRateFor, HOLD_PERIODS };
