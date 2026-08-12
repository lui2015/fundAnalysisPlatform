'use strict';
/**
 * 六板块编排（需求 F3-2 / F3-8 / F3-11）
 *
 * 流程：取数 → 计算与规则扫描 → ②③④⑤⑥ 并行调用模型 → ① 总览汇总 → 合规过滤 → 落库
 * 展示顺序 ≠ 生成顺序：总览排在最上方但最后生成，前端先渲染骨架再回填。
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../db');
const dates = require('../utils/dates');
const { isNum, round } = require('../utils/num');
const datasource = require('../datasource');
const compute = require('../compute');
const client = require('./client');
const prompts = require('./prompts');
const validate = require('./validate');
const compliance = require('./compliance');
const fallback = require('./fallback');
const { labelOf, isApplicable } = require('../config/fundTypes');

const SECTION_META = [
  { key: 'overview', title: '总览', order: 1, dimension: null },
  { key: 'good_performance', title: '好业绩', order: 2, dimension: 'ability' },
  { key: 'good_manager', title: '好舵手', order: 3, dimension: 'manager' },
  { key: 'good_experience', title: '好体验', order: 4, dimension: 'experience' },
  { key: 'timing_cost', title: '好时机与成本', order: 5, dimension: 'timingCost' },
  { key: 'risk_scan', title: '风险排雷', order: 6, dimension: null },
];

const DISCLAIMER =
  '本平台所有内容由 AI 基于公开数据自动生成，仅供学习、研究与参考，不构成任何投资建议、基金推荐、要约或承诺。基金过往业绩不预示其未来表现。数据可能存在延迟或错误，持仓数据来自定期报告存在滞后，请以基金管理人公告与法律文件为准。投资有风险，决策请独立判断，风险自负。';

function newReportId() {
  return `r_${crypto.randomBytes(12).toString('hex')}`;
}

/** 单板块：模型调用 + 校验 + 回校验 + 合规；失败则规则版降级 */
async function runSection({ key, facts, code, promptFn, normalizeFn, fallbackFn, onEvent }) {
  const meta = SECTION_META.find((s) => s.key === key);
  let generatedBy = 'model';
  let payload = null;
  let usage = { promptTokens: 0, outputTokens: 0, ms: 0 };
  let dropped = [];
  let error = null;

  const attempts = config.ai.enabled ? config.ai.maxRetry + 1 : 0;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { system, user, allowedKeys } = promptFn(facts);
      const res = await client.chatJson({ system, user });
      usage = {
        promptTokens: res.usage.promptTokens || 0,
        outputTokens: res.usage.outputTokens || 0,
        ms: res.usage.ms,
      };
      const raw = validate.extractJson(res.content);
      payload = normalizeFn(raw, allowedKeys);
      const verified = validate.verifySection(payload, facts, `${code}:${key}`);
      payload = verified.section;
      dropped = verified.dropped;
      error = null;
      break;
    } catch (e) {
      error = e.message;
      logger.warn('板块模型调用失败', { code, section: key, attempt: i + 1, error: e.message });
    }
  }

  if (!payload) {
    generatedBy = 'rules';
    payload = fallbackFn(facts);
    if (!config.ai.enabled) error = '未配置模型密钥，本板块由指标规则生成';
  }

  // 合规过滤（无论来自模型还是规则版都要过一遍）
  const { value, hitCount } = compliance.sanitizeSection(key, payload, code);

  const section = {
    key,
    title: meta.title,
    order: meta.order,
    generatedBy,
    degradedReason: generatedBy === 'rules' ? error : null,
    complianceRewrites: hitCount,
    droppedByNumberCheck: dropped.length,
    ...value,
  };
  if (onEvent) onEvent('section', section);
  return { section, usage, generatedBy, error };
}

/** 依据结构化结论自动识别板块间矛盾（总览的兜底，也用于校验模型的 conflictNote） */
function detectConflicts(scores, riskLevel, metrics) {
  const out = [];
  const { ability, manager, experience, timingCost } = scores;
  if (isNum(ability) && isNum(experience) && ability >= 70 && experience <= 40) {
    out.push('长期业绩位于同类前列，但历史回撤与波动显著高于同类，业绩与持有体验存在明显反差');
  }
  if (isNum(ability) && isNum(manager) && ability >= 70 && manager <= 50) {
    out.push('基金历史业绩较好，但现任基金经理任职时间较短或管理连续性不足，历史业绩的参考价值需打折');
  }
  if (isNum(ability) && isNum(timingCost) && ability >= 70 && timingCost <= 45) {
    out.push('基金本身表现较好，但当前持仓估值位置或费率成本偏高');
  }
  if (isNum(ability) && isNum(experience) && ability <= 45 && experience >= 70) {
    out.push('波动较小，但长期收益同样落后于同类，低波动并未换来更好的回报');
  }
  const scaleSurge = metrics?.costTiming?.scaleStatus?.surgeRatio;
  if (isNum(scaleSurge) && scaleSurge >= 2 && isNum(ability) && ability >= 65) {
    out.push('业绩表现较好的同时规模快速扩张，需关注策略容量能否支撑更大规模');
  }
  if (riskLevel === 'red' && isNum(ability) && ability >= 70) {
    out.push('业绩指标表现不俗，但风险排雷已触发红灯，风险项应优先于业绩结论看待');
  }
  if (riskLevel === 'red' && isNum(manager) && manager >= 65 && isNum(ability) && ability <= 45) {
    out.push('现任基金经理任职期表现尚可，但基金整体业绩落后且已触发风险红灯，两者需一并看待');
  }
  return out;
}

/** 兜底：模型未给出矛盾提示但规则识别到矛盾时，回填规则版结论（A-6 要求矛盾必须被显式指出） */
function pickConflictNote(modelNote, autoConflicts) {
  if (typeof modelNote === 'string' && modelNote.trim() && !/^null$/i.test(modelNote.trim())) return modelNote.trim();
  return autoConflicts[0] || null;
}

/**
 * 主流程
 * @param {string} rawCode
 * @param {{depth?:string, onEvent?:Function}} opts
 */
async function analyze(rawCode, opts = {}) {
  const depth = opts.depth === 'deep' ? 'deep' : 'quick';
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const t0 = Date.now();

  /* ---------------- 取数 ---------------- */
  if (onEvent) onEvent('progress', { stage: 'fetch', percent: 5, text: '正在获取基金公开数据…' });
  const tFetch = Date.now();
  const fetched = await datasource.fetchBundle(rawCode, { deep: depth === 'deep' });
  const fetchMs = Date.now() - tFetch;
  const bundle = fetched.bundle;
  const profile = bundle.profile;

  /* ---------------- 计算与规则扫描 ---------------- */
  if (onEvent) onEvent('progress', { stage: 'compute', percent: 20, text: '正在计算指标与扫描风险规则…' });
  const tCompute = Date.now();
  const computed = compute.compute(bundle, fetched.completeness);
  const computeMs = Date.now() - tCompute;

  const reportId = newReportId();
  const meta = {
    id: reportId,
    code: profile.code,
    name: profile.name,
    fullName: profile.fullName,
    shareClass: profile.shareClass,
    fundType: profile.fundType,
    fundTypeLabel: labelOf(profile.fundType),
    typeText: profile.typeText,
    company: profile.company,
    benchmark: profile.benchmark,
    tracks: profile.tracks,
    establishDate: profile.establishDate,
    navDate: profile.navDate,
    unitNav: profile.unitNav,
    accNav: profile.accNav,
    dayChangePct: profile.dayChangePct,
    scaleYi: profile.scaleYi,
    scaleAsOf: profile.scaleAsOf,
    holdingPeriod: computed.metrics.holdings?.period || null,
    purchaseStatus: profile.purchaseStatus,
    redeemStatus: profile.redeemStatus,
    onMarket: profile.onMarket,
    depth,
    createdAt: new Date().toISOString(),
    dataMode: datasource.MODE,
    mocked: fetched.mocked,
    dataCompleteness: fetched.completeness,
    sources: fetched.sources,
    notes: fetched.notes,
    scores: computed.scores,
    riskLevel: computed.risk.level,
    notApplicable: computed.notApplicable,
  };
  if (onEvent) onEvent('meta', meta);

  /* ---------------- ②③④⑤⑥ 并行 ---------------- */
  if (onEvent) onEvent('progress', { stage: 'sections', percent: 35, text: '五个板块正在并行解读…' });
  const slices = computed.slices;
  const managerNotApplicable = slices.good_manager.applicable === false;

  /** 类型不适用的板块直接走规则版，不发起模型调用（省成本、避免无意义解读） */
  function rulesOnlySection(key, title, order, facts, fallbackFn, reason) {
    const payload = fallbackFn(facts);
    const { value, hitCount } = compliance.sanitizeSection(key, payload, profile.code);
    const section = {
      key,
      title,
      order,
      generatedBy: 'rules',
      notApplicable: true,
      degradedReason: reason,
      complianceRewrites: hitCount,
      droppedByNumberCheck: 0,
      ...value,
    };
    if (onEvent) onEvent('section', section);
    return Promise.resolve({ section, usage: { promptTokens: 0, outputTokens: 0, ms: 0 }, generatedBy: 'rules', error: null });
  }

  const tasks = [
    runSection({
      key: 'good_performance',
      facts: slices.good_performance,
      code: profile.code,
      promptFn: prompts.goodPerformance,
      normalizeFn: validate.normalizeAnalysisSection,
      fallbackFn: fallback.goodPerformance,
      onEvent,
    }),
    managerNotApplicable
      ? rulesOnlySection('good_manager', '好舵手', 3, slices.good_manager, fallback.goodManager, slices.good_manager.reason)
      : runSection({
          key: 'good_manager',
          facts: slices.good_manager,
          code: profile.code,
          promptFn: prompts.goodManager,
          normalizeFn: validate.normalizeAnalysisSection,
          fallbackFn: fallback.goodManager,
          onEvent,
        }),
    runSection({
      key: 'good_experience',
      facts: slices.good_experience,
      code: profile.code,
      promptFn: prompts.goodExperience,
      normalizeFn: validate.normalizeAnalysisSection,
      fallbackFn: fallback.goodExperience,
      onEvent,
    }),
    runSection({
      key: 'timing_cost',
      facts: slices.timing_cost,
      code: profile.code,
      promptFn: prompts.timingCost,
      normalizeFn: validate.normalizeAnalysisSection,
      fallbackFn: fallback.timingCost,
      onEvent,
    }),
    runSection({
      key: 'risk_scan',
      facts: slices.risk_scan,
      code: profile.code,
      promptFn: prompts.riskScan,
      normalizeFn: validate.normalizeRiskSection,
      fallbackFn: fallback.riskScan,
      onEvent,
    }),
  ];

  const results = await Promise.all(tasks);
  const sections = results.map((r) => r.section).sort((a, b) => a.order - b.order);
  /**
   * 真正的「降级」只包括模型调用失败而回退规则版的板块。
   * 「本基金类型不适用」（如指数基金的好舵手）是设计内的正确行为，不是降级，
   * 否则会给用户一个「分析出问题了」的错误印象。
   */
  const degraded = results
    .filter((r) => r.generatedBy === 'rules' && !r.section.notApplicable)
    .map((r) => r.section.title || r.section.key);

  /* ---------------- ① 总览 ---------------- */
  if (onEvent) onEvent('progress', { stage: 'overview', percent: 80, text: '正在汇总总览…' });
  const autoConflicts = detectConflicts(computed.scores, computed.risk.level, computed.metrics);
  const riskSection = sections.find((s) => s.key === 'risk_scan');
  const overviewFacts = {
    fund: {
      name: profile.name,
      code: profile.code,
      typeLabel: labelOf(profile.fundType),
      shareClass: profile.shareClass,
      navDate: profile.navDate,
      currentManager: computed.metrics.manager?.primaryManager || null,
      managerTenureYears: computed.metrics.manager?.tenure?.years ?? null,
    },
    scores: computed.scores,
    notApplicable: computed.notApplicable,
    riskLevel: computed.risk.level,
    hardRedLines: computed.risk.hardRedLines,
    riskSummary: riskSection?.summary || null,
    // 只给结构化结论，不给原始数据（A-7）
    sections: sections.map((s) => ({
      key: s.key,
      title: s.title,
      tag: s.tag || null,
      summary: s.summary,
      strengths: s.strengths || [],
      weaknesses: s.weaknesses || [],
      generatedBy: s.generatedBy,
    })),
    profileFacts: {
      maxDrawdownPct: computed.metrics.experience?.drawdown?.maxPct ?? null,
      recoveryMedianDays: computed.metrics.experience?.drawdown?.recoveryMedianDays ?? null,
      positiveRate1y: computed.metrics.experience?.rollingHold?.['1y']?.positiveRatePct ?? null,
      positiveRate3y: computed.metrics.experience?.rollingHold?.['3y']?.positiveRatePct ?? null,
    },
    autoConflictNote: autoConflicts[0] || null,
    allConflicts: autoConflicts,
    dataCompleteness: fetched.completeness,
  };

  const ovResult = await runSection({
    key: 'overview',
    facts: overviewFacts,
    code: profile.code,
    promptFn: prompts.overview,
    normalizeFn: validate.normalizeOverviewSection,
    fallbackFn: fallback.overview,
    onEvent: null,
  });

  // 适配画像（A-3）：纯历史事实，不含任何建议
  const exp = computed.metrics.experience || {};
  const profileCard = {
    maxDrawdownPct: isNum(exp.drawdown?.maxPct) ? Math.abs(exp.drawdown.maxPct) : null,
    maxDrawdownRange:
      exp.drawdown?.maxFrom && exp.drawdown?.maxBottom ? `${exp.drawdown.maxFrom} ~ ${exp.drawdown.maxBottom}` : null,
    recoveryMedianMonths: isNum(exp.drawdown?.recoveryMedianDays) ? round(exp.drawdown.recoveryMedianDays / 30.44, 1) : null,
    positiveRate1y: exp.rollingHold?.['1y']?.available ? exp.rollingHold['1y'].positiveRatePct : null,
    positiveRate3y: exp.rollingHold?.['3y']?.available ? exp.rollingHold['3y'].positiveRatePct : null,
    amountDemo: exp.amountDemo || null,
    note: '以上均为历史数据回溯结果，不代表未来表现，不构成投资建议',
  };

  const overview = {
    oneLiner: ovResult.section.oneLiner,
    scores: computed.scores,
    riskLevel: computed.risk.level,
    riskTag: riskSection?.tag || null,
    hardRedLines: computed.risk.hardRedLines,
    keyPoints: ovResult.section.keyPoints || [],
    conflictNote: pickConflictNote(ovResult.section.conflictNote, autoConflicts),
    allConflicts: autoConflicts,
    profile: profileCard,
    notApplicable: computed.notApplicable,
    generatedBy: ovResult.generatedBy,
    degradedReason: ovResult.section.degradedReason,
    missingSections: degraded.length ? `以下板块由指标规则生成：${degraded.join('、')}` : null,
  };
  if (onEvent) onEvent('overview', overview);

  /* ---------------- 组装报告 ---------------- */
  const usageTotal = [...results, ovResult].reduce(
    (acc, r) => ({
      promptTokens: acc.promptTokens + (r.usage.promptTokens || 0),
      outputTokens: acc.outputTokens + (r.usage.outputTokens || 0),
      ms: acc.ms + (r.usage.ms || 0),
      calls: acc.calls + (r.generatedBy === 'model' ? 1 : 0),
    }),
    { promptTokens: 0, outputTokens: 0, ms: 0, calls: 0 }
  );

  const report = {
    ...meta,
    schemaVersion: 1,
    overview,
    sections,
    // 图表与明细数据（前端渲染用，不参与 Prompt）
    charts: {
      nav: bundle.nav.map((p) => ({ d: p.date, v: p.adj, u: p.unit })),
      peerAvg: (bundle.peerAvgSeries || []).map((p) => ({ d: p.date, v: p.value })),
      csi300: (bundle.csi300Series || []).map((p) => ({ d: p.date, v: p.value })),
      drawdown: (computed.metrics.experience?.drawdown?.series || []).map((p) => ({ d: p.date, v: p.dd })),
      yearly: computed.metrics.returns?.yearly || [],
      rollingHold: computed.metrics.experience?.rollingHold || {},
      scale: computed.metrics.costTiming?.scaleStatus?.trend || [],
      managerTerms: [
        ...(computed.metrics.manager?.managers || []).map((m) => ({
          name: m.name,
          start: m.startDate,
          end: null,
          current: true,
        })),
        ...(bundle.pastManagerTerms || []).map((t) => ({ name: t.name, start: t.startDate, end: t.endDate, current: false })),
      ].filter((t) => t.start),
      industries: computed.metrics.holdings?.industries || [],
      driftStack: computed.metrics.holdings?.drift?.stack || [],
      holders: bundle.holders || null,
      feeCost: computed.metrics.costTiming?.fee?.totalCost || [],
      monthly: computed.metrics.experience?.monthly || [],
    },
    details: {
      intervals: computed.metrics.returns?.intervals || {},
      stability: computed.metrics.returns?.stability || {},
      excess: computed.metrics.returns?.excess || {},
      tracking: computed.metrics.returns?.tracking || null,
      drawdown: compute.slim(computed.metrics.experience?.drawdown, ['series']) || {},
      volatility: computed.metrics.experience?.volatility || {},
      riskAdjusted: computed.metrics.experience?.riskAdjusted || {},
      dca: computed.metrics.experience?.dca || {},
      crossCheck: computed.metrics.experience?.crossCheck || {},
      manager: computed.metrics.manager || {},
      valuation: computed.metrics.costTiming?.valuation || {},
      navPosition: computed.metrics.costTiming?.navPosition || {},
      fee: computed.metrics.costTiming?.fee || {},
      scaleStatus: computed.metrics.costTiming?.scaleStatus || {},
      premium: computed.metrics.costTiming?.premium || {},
      liquidity: computed.metrics.costTiming?.liquidity || {},
      duration: computed.metrics.costTiming?.duration || {},
      holdings: compute.slim(computed.metrics.holdings, ['stack']) || {},
      notices: (bundle.notices || []).slice(0, 12),
      scopeNote: profile.scopeNote || null,
    },
    riskFindings: computed.risk.findings.map((f) => {
      const explained = (riskSection?.findings || []).find((x) => x.key === f.key);
      return { ...f, explain: explained?.explain || null };
    }),
    checkedRiskItems: computed.risk.checkedCount,
    checkedRiskList: computed.risk.checkedItems.map((c) => c.title),
    riskStat: computed.risk.summaryStat,
    greenNote: computed.risk.greenNote,
    usage: usageTotal,
    timing: { fetchMs, computeMs, modelMs: usageTotal.ms, totalMs: Date.now() - t0 },
    degradedSections: degraded,
    disclaimer: DISCLAIMER,
    aiGenerated: true,
  };

  try {
    db.saveReport(report);
    db.logRiskHits(profile.code, computed.risk.findings);
    db.logAnalysis({
      code: profile.code,
      depth,
      ok: true,
      totalMs: report.timing.totalMs,
      fetchMs,
      computeMs,
      modelMs: usageTotal.ms,
      modelCalls: usageTotal.calls,
      promptTokens: usageTotal.promptTokens,
      outputTokens: usageTotal.outputTokens,
      degraded,
    });
  } catch (e) {
    logger.error('报告落库失败', { code: profile.code, error: e.message });
  }

  if (onEvent) onEvent('done', { reportId, totalMs: report.timing.totalMs, degraded });
  logger.info('分析完成', {
    code: profile.code,
    fundType: profile.fundType,
    scores: computed.scores,
    riskLevel: computed.risk.level,
    modelCalls: usageTotal.calls,
    degraded,
    ms: report.timing.totalMs,
  });
  return report;
}

module.exports = { analyze, SECTION_META, DISCLAIMER, detectConflicts };
