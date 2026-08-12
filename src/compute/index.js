'use strict';
/**
 * 计算层编排 + 板块数据切片
 *
 * 「板块正交」在这里从数据层面强制实现（需求 F3-2 / B-5 / C-5 / D-6 / E-6）：
 * 每个板块的 Prompt 只能看到自己的切片，看不到其他板块的字段。
 * 例如「好业绩」切片里不含任何回撤/波动字段，「好舵手」切片里不含基金收益排名，
 * 从而杜绝「回撤小所以业绩好」「涨得好所以经理牛」这类循环论证。
 */
const returnsMod = require('./returns');
const experienceMod = require('./experience');
const managerMod = require('./manager');
const costTimingMod = require('./costTiming');
const holdingsMod = require('./holdings');
const riskEngine = require('../risk/engine');
const { isApplicable, naReason, labelOf, policyOf } = require('../config/fundTypes');
const { isNum, round } = require('../utils/num');

/** 深拷贝并剔除大数组，避免 Prompt 体积过大 */
function slim(obj, dropKeys = []) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((x) => slim(x, dropKeys));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (dropKeys.includes(k)) continue;
    out[k] = slim(v, dropKeys);
  }
  return out;
}

function compute(bundle, completeness) {
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const policy = policyOf(fundType) || {};

  /* ---------------- 1) 各维度指标 ---------------- */
  const holdings = holdingsMod.compute(bundle);
  const returns = returnsMod.compute(bundle, holdings);
  const experience = experienceMod.compute(bundle);
  const manager = managerMod.compute(bundle, holdings);
  const costTiming = costTimingMod.compute(bundle);

  const metrics = { returns, experience, manager, costTiming, holdings };

  /* ---------------- 2) 风险规则扫描 ---------------- */
  const risk = riskEngine.scan({ bundle, metrics, completeness });

  /* ---------------- 3) 四刻度 ---------------- */
  const scores = {
    ability: returns.score ?? null,
    manager: manager.applicable === false ? null : manager.score ?? null,
    experience: experience.score ?? null,
    timingCost: costTiming.score ?? null,
  };
  const notApplicable = [];
  if (!isApplicable(fundType, 'good_manager')) {
    notApplicable.push({ dimension: 'manager', reason: naReason(fundType, 'manager') });
  }

  /* ---------------- 4) 板块切片（严格白名单） ---------------- */

  // ② 好业绩：只谈收益、超额、排名、稳定性与持仓构成；不含任何风险/回撤/费率/估值字段
  const performanceSlice = {
    fund: {
      name: profile.name,
      code: profile.code,
      typeLabel: labelOf(fundType),
      typeText: profile.typeText,
      shareClass: profile.shareClass,
      establishDate: profile.establishDate,
      benchmark: profile.benchmark,
      tracks: profile.tracks,
      navDate: profile.navDate,
      policy: policy.good_performance,
    },
    intervals: returns.intervals,
    yearly: returns.yearly,
    excess: { ...returns.excess, byInterval: undefined },
    stability: returns.stability,
    tracking: returns.tracking,
    monthsSinceStart: returns.monthsSinceStart,
    shortHistoryNote: returns.shortHistoryNote,
    rankSuppressedNote: returns.rankSuppressedNote,
    peerSource: returns.peerSource,
    scoreFacts: { score: returns.score, tag: returns.tag, subScores: returns.subScores, weights: returns.weights },
    holdingConstruction: holdings.available
      ? {
          period: holdings.period,
          asOf: holdings.asOf,
          top10Pct: holdings.top10Pct,
          topIndustry: holdings.topIndustry,
          industries: holdings.industries.slice(0, 6),
          stocks: holdings.stocks.slice(0, 10).map((s) => ({ name: s.name, pct: s.pct, chg: s.chg, industry: s.industry })),
          industryCount: holdings.industryCount,
          turnoverPct: holdings.turnoverPct,
          lagNote: holdings.lagNote,
        }
      : { available: false, reason: holdings.reason },
    dataCompleteness: completeness,
  };

  // ③ 好舵手：只谈人；不含基金收益排名与净值排行（防循环论证）
  const managerSlice =
    manager.applicable === false
      ? { applicable: false, reason: manager.reason, team: manager.team, changeHistory: manager.changeHistory }
      : {
          fund: { name: profile.name, code: profile.code, typeLabel: labelOf(fundType), company: profile.company, navDate: profile.navDate },
          managers: manager.managers,
          primaryManager: manager.primaryManager,
          tenure: manager.tenure,
          tenurePerf: manager.tenurePerf,
          workload: manager.workload,
          consistency: manager.consistency,
          changeStat: manager.changeStat,
          changeHistory: (manager.changeHistory || []).slice(0, 6),
          otherFunds: manager.otherFunds,
          coManaged: manager.coManaged,
          notes: manager.notes,
          scoreFacts: { score: manager.score, tag: manager.tag, subScores: manager.subScores, weights: manager.weights },
          styleConsistencyEvidence: holdings.drift?.available
            ? { deviationPct: holdings.drift.deviationPct, level: holdings.drift.level, periods: holdings.drift.periodsCompared }
            : { available: false, reason: holdings.drift?.reason },
        };

  // ④ 好体验：只谈波动与持有过程；不含业绩排名与经理信息
  const experienceSlice = {
    fund: { name: profile.name, code: profile.code, typeLabel: labelOf(fundType), navDate: profile.navDate, policy: policy.good_experience },
    window: experience.window,
    drawdown: slim(experience.drawdown, ['series']),
    volatility: experience.volatility,
    riskAdjusted: experience.riskAdjusted,
    rollingHold: experience.rollingHold,
    dca: experience.dca,
    peerComparison: experience.peerComparison,
    amountDemo: experience.amountDemo,
    crossCheck: experience.crossCheck,
    scoreFacts: {
      score: experience.score,
      tag: experience.tag,
      subScores: experience.subScores,
      weights: experience.weights,
      note: experience.scoreNote,
    },
    dataCompleteness: completeness,
  };

  // ⑤ 好时机与成本：只谈位置与成本；不评价基金好坏与经理
  const timingCostSlice = {
    fund: {
      name: profile.name,
      code: profile.code,
      typeLabel: labelOf(fundType),
      shareClass: profile.shareClass,
      onMarket: profile.onMarket,
      navDate: profile.navDate,
      policy: policy.timing_cost,
    },
    valuation: costTiming.valuation,
    navPosition: slim(costTiming.navPosition, ['series']),
    fee: costTiming.fee,
    scaleStatus: slim(costTiming.scaleStatus, ['trend']),
    premium: slim(costTiming.premium, ['series']),
    liquidity: costTiming.liquidity,
    duration: costTiming.duration,
    scoreFacts: { score: costTiming.score, tag: costTiming.tag, subScores: costTiming.subScores, weights: costTiming.weights },
    disclaimer: costTiming.disclaimer,
  };

  // ⑥ 风险排雷：只给规则命中结果，模型不得新增雷点
  const riskSlice = {
    fund: {
      name: profile.name,
      code: profile.code,
      typeLabel: labelOf(fundType),
      navDate: profile.navDate,
      purchaseStatus: profile.purchaseStatus,
      redeemStatus: profile.redeemStatus,
      riskFocus: policy.riskFocus,
    },
    level: risk.level,
    summaryStat: risk.summaryStat,
    checkedCount: risk.checkedCount,
    checkedItems: risk.checkedItems.map((c) => c.title),
    findings: risk.findings.map((f) => ({
      key: f.key,
      category: f.category,
      categoryLabel: f.categoryLabel,
      title: f.title,
      severity: f.severity,
      hardRedLine: f.hardRedLine,
      description: f.description,
      trigger: f.trigger,
      watch: f.watch,
    })),
    hardRedLines: risk.hardRedLines,
    market: bundle.market || null,
    styleDriftEvidence: holdings.drift?.available
      ? { deviationPct: holdings.drift.deviationPct, level: holdings.drift.level, items: holdings.drift.items.slice(0, 5) }
      : null,
    dataCompleteness: completeness,
    greenNote: risk.greenNote,
  };

  return {
    metrics,
    risk,
    scores,
    notApplicable,
    slices: {
      good_performance: performanceSlice,
      good_manager: managerSlice,
      good_experience: experienceSlice,
      timing_cost: timingCostSlice,
      risk_scan: riskSlice,
    },
  };
}

module.exports = { compute, slim };
