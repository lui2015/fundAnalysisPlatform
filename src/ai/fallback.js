'use strict';
/**
 * 规则版降级（需求 F3-11）
 *
 * 任一板块模型失败或未配置密钥时，用确定性文案生成同结构的结论并标注 generatedBy=rules，
 * 保证「没有模型也能跑完整报告」，同时让降级路径始终处于被验证状态。
 */
const { isNum, round } = require('../utils/num');

const na = (v, unit = '') => (isNum(v) ? `${v}${unit}` : '数据不可得');

/* ========================= ② 好业绩 ========================= */
function goodPerformance(facts) {
  const i = facts.intervals || {};
  const st = facts.stability || {};
  const modules = [];

  const long = i['3y'] || i['since'] || i['1y'];
  if (long) {
    modules.push({
      key: 'longTerm',
      title: '长期业绩',
      summary: `${long.label}收益 ${na(long.pct, '%')}${isNum(long.annualizedPct) ? `，年化 ${long.annualizedPct}%` : ''}${long.rankNote ? `，${long.rankNote}` : ''}`,
      points: [
        i['1y'] ? `近1年收益 ${na(i['1y'].pct, '%')}，同类平均 ${na(i['1y'].peerAvgPct, '%')}` : '近1年数据不可得',
        i['ytd'] ? `今年以来收益 ${na(i['ytd'].pct, '%')}` : '今年以来数据不可得',
      ].filter(Boolean),
    });
  }

  modules.push({
    key: 'excess',
    title: '超额来源',
    summary: isNum(facts.excess?.annualExcessVsPeerPp)
      ? `以${facts.excess.basedOn || '可得最长区间'}计算，相对同类平均的年化超额为 ${facts.excess.annualExcessVsPeerPp} 个百分点`
      : '因缺少同类平均区间数据，超额收益未做判断',
    points: [
      i['1y'] && isNum(i['1y'].excessVsPeerPp) ? `近1年相对同类平均 ${i['1y'].excessVsPeerPp} 个百分点` : null,
      i['3y'] && isNum(i['3y'].excessVsHs300Pp) ? `近3年相对沪深300 ${i['3y'].excessVsHs300Pp} 个百分点` : null,
    ].filter(Boolean),
  });

  modules.push({
    key: 'stability',
    title: '业绩稳定性',
    summary: isNum(st.top50RatioPct)
      ? `完整年度中有 ${st.yearsInTop50}/${st.yearsCounted} 个年份排在同类前 50%（${st.top50RatioPct}%）`
      : '因缺少逐年同类排名数据，稳定性未做判断',
    points: [
      st.bestYear ? `最好年份 ${st.bestYear.year} 年 ${st.bestYear.pct}%` : null,
      st.worstYear ? `最差年份 ${st.worstYear.year} 年 ${st.worstYear.pct}%` : null,
      isNum(st.negativeYears) ? `亏损年份 ${st.negativeYears} 个` : null,
      st.dependsOnSingleYear === true ? '剔除表现最好的年份后累计收益转负，业绩对单一年份依赖较强' : null,
    ].filter(Boolean),
  });

  const hc = facts.holdingConstruction;
  if (hc && hc.available !== false) {
    modules.push({
      key: 'holdingStyle',
      title: '持仓与风格',
      summary: `${hc.period || '最新报告期'}前十大重仓合计占净值 ${na(hc.top10Pct, '%')}${hc.topIndustry ? `，第一大行业为${hc.topIndustry.name}（${hc.topIndustry.pct}%）` : ''}`,
      points: [
        hc.stocks?.length ? `第一大重仓：${hc.stocks[0].name}（${hc.stocks[0].pct}%）` : null,
        hc.lagNote,
      ].filter(Boolean),
    });
  } else {
    modules.push({
      key: 'holdingStyle',
      title: '持仓与风格',
      summary: '因缺少持仓数据，本项未做判断',
      points: [hc?.reason || '持仓来自定期报告，可能尚未披露'],
    });
  }

  if (facts.tracking) {
    modules.push({
      key: 'tracking',
      title: '跟踪能力',
      summary: facts.tracking.available
        ? `年化跟踪误差 ${na(facts.tracking.annualPct, '%')}${isNum(facts.tracking.contractLimitPct) ? `，基金合同约定不超过 ${facts.tracking.contractLimitPct}%` : ''}`
        : `因缺少标的指数日频序列，跟踪误差未做判断${isNum(facts.tracking.contractLimitPct) ? `（合同约定年跟踪误差不超过 ${facts.tracking.contractLimitPct}%）` : ''}`,
      points: [facts.tracking.reason].filter(Boolean),
    });
  }

  const strengths = [];
  const weaknesses = [];
  if (isNum(i['1y']?.excessVsPeerPp) && i['1y'].excessVsPeerPp > 0) {
    strengths.push(`近1年相对同类平均领先 ${i['1y'].excessVsPeerPp} 个百分点`);
  }
  if (isNum(st.top50RatioPct) && st.top50RatioPct >= 50) strengths.push(`多数完整年度排在同类前 50%（${st.top50RatioPct}%）`);
  if (isNum(long?.annualizedPct) && long.annualizedPct > 5) strengths.push(`${long.label}年化收益 ${long.annualizedPct}%`);
  if (isNum(i['1y']?.excessVsPeerPp) && i['1y'].excessVsPeerPp < 0) {
    weaknesses.push(`近1年落后同类平均 ${Math.abs(i['1y'].excessVsPeerPp)} 个百分点`);
  }
  if (isNum(st.negativeYears) && st.negativeYears > 0) weaknesses.push(`历史上存在 ${st.negativeYears} 个亏损年份`);
  if (facts.shortHistoryNote) weaknesses.push(facts.shortHistoryNote);
  if (facts.rankSuppressedNote) weaknesses.push(facts.rankSuppressedNote);
  while (strengths.length < 2) strengths.push('其余项目因数据缺失未做判断');
  while (weaknesses.length < 2) weaknesses.push('其余项目因数据缺失未做判断');

  return {
    summary: `${facts.fund?.name || '本基金'}${long ? `${long.label}收益 ${na(long.pct, '%')}` : ''}${long?.rankNote ? `，${long.rankNote}` : ''}。本板块由指标规则生成。`,
    tag: facts.scoreFacts?.tag || null,
    modules,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
  };
}

/* ========================= ③ 好舵手 ========================= */
function goodManager(facts) {
  if (facts.applicable === false) {
    return {
      summary: facts.reason,
      tag: '不适用',
      modules: [
        {
          key: 'team',
          title: '管理团队与运作稳定性',
          summary: `近3年基金经理变更 ${facts.team?.changeCount3y ?? '—'} 次${facts.team?.company ? `，管理人为${facts.team.company}` : ''}`,
          points: (facts.team?.managers || []).map(
            (m) => `${m.name}：任职约 ${na(m.tenureYears, ' 年')}，在管 ${na(m.fundCount, ' 只')}、约 ${na(m.aumYi, ' 亿元')}`
          ),
        },
      ],
      strengths: [],
      weaknesses: [],
    };
  }

  const t = facts.tenure || {};
  const p = facts.tenurePerf || {};
  const w = facts.workload || {};
  const modules = [
    {
      key: 'tenure',
      title: '任职与经验',
      summary: `${facts.primaryManager || '现任经理'}任职本基金约 ${na(t.years, ' 年')}${isNum(t.workYears) ? `，从业约 ${t.workYears} 年` : ''}`,
      points: [
        t.startDate ? `任职起始日 ${t.startDate}` : null,
        t.coveredFullCycle === false ? '任职未满 3 年，尚未经历一轮完整涨跌' : null,
        facts.coManaged ? `本基金由 ${facts.managers?.length || 2} 位基金经理共同管理` : null,
      ].filter(Boolean),
    },
    {
      key: 'tenurePerf',
      title: '任职期表现',
      summary: isNum(p.returnPct)
        ? `任职期间收益 ${p.returnPct}%${isNum(p.peerAvgPct) ? `，同期同类平均 ${p.peerAvgPct}%` : ''}${isNum(p.hs300Pct) ? `，沪深300 ${p.hs300Pct}%` : ''}`
        : '因缺少任职期业绩数据，本项未做判断',
      points: [
        isNum(p.excessVsPeerPp) ? `任职期相对同类平均 ${p.excessVsPeerPp} 个百分点` : null,
        isNum(p.annualExcessVsPeerPp) ? `任职期年化超额 ${p.annualExcessVsPeerPp} 个百分点` : null,
      ].filter(Boolean),
    },
    {
      key: 'workload',
      title: '精力分配',
      summary: `在管 ${na(w.fundCount, ' 只')}基金、合计约 ${na(w.aumYi, ' 亿元')}${w.overloaded ? '，超过平台设定阈值' : ''}`,
      points: [w.note].filter(Boolean),
    },
    {
      key: 'consistency',
      title: '风格一致性',
      summary: facts.consistency?.available
        ? `最新一期行业分布相对历史均值的调整幅度 ${facts.consistency.deviationPct}%`
        : `因缺少多期持仓数据，风格一致性未做判断`,
      points: [facts.consistency?.reason].filter(Boolean),
    },
    {
      key: 'changes',
      title: '变更历史',
      summary: `历任基金经理共 ${facts.changeStat?.totalTerms ?? '—'} 任，近3年变更 ${facts.changeStat?.changeCount3y ?? '—'} 次`,
      points: (facts.changeHistory || []).slice(0, 3).map(
        (h) => `${h.name}：${h.startDate} 至 ${h.endDate || '至今'}，任职回报 ${na(h.tenureReturnPct, '%')}`
      ),
    },
  ];

  const strengths = [];
  const weaknesses = [];
  if (isNum(t.years) && t.years >= 3) strengths.push(`现任经理任职本基金已约 ${t.years} 年，管理连续性较好`);
  if (isNum(p.excessVsPeerPp) && p.excessVsPeerPp > 0) strengths.push(`任职期相对同类平均领先 ${p.excessVsPeerPp} 个百分点`);
  if (facts.consistency?.level === 'normal') strengths.push('持仓行业分布相对历史保持稳定');
  (facts.notes || []).forEach((n) => weaknesses.push(n));
  if (isNum(p.excessVsPeerPp) && p.excessVsPeerPp < 0) weaknesses.push(`任职期落后同类平均 ${Math.abs(p.excessVsPeerPp)} 个百分点`);
  while (strengths.length < 2) strengths.push('其余项目因数据缺失未做判断');
  while (weaknesses.length < 2) weaknesses.push('其余项目因数据缺失未做判断');

  return {
    summary: `现任基金经理${facts.primaryManager ? `${facts.primaryManager}` : ''}任职约 ${na(t.years, ' 年')}，在管 ${na(w.fundCount, ' 只')}基金。本板块由指标规则生成。`,
    tag: facts.scoreFacts?.tag || null,
    modules,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
  };
}

/* ========================= ④ 好体验 ========================= */
function goodExperience(facts) {
  const d = facts.drawdown || {};
  const v = facts.volatility || {};
  const ra = facts.riskAdjusted || {};
  const r1 = facts.rollingHold?.['1y'];
  const r3 = facts.rollingHold?.['3y'];
  const amt = facts.amountDemo || {};

  const modules = [
    {
      key: 'drawdown',
      title: '回撤深度',
      summary: isNum(d.maxPct)
        ? `历史最大回撤 ${Math.abs(d.maxPct)}%（${d.maxFrom} 至 ${d.maxBottom}），投入 10 万元期间最多浮亏约 ${amt.maxLossAmount} 元`
        : '因缺少净值序列，回撤未做判断',
      points: [amt.note, isNum(d.current?.ddPct) ? `当前距历史高点回撤 ${Math.abs(d.current.ddPct)}%` : null].filter(Boolean),
    },
    {
      key: 'recovery',
      title: '回撤修复',
      summary: isNum(d.recoveryMedianDays)
        ? `历史回撤修复时长中位数约 ${d.recoveryMedianDays} 天，最长约 ${na(d.recoveryMaxDays, ' 天')}`
        : '有效回撤样本不足，修复时长未做判断',
      points: [isNum(d.current?.durationDays) && d.current.durationDays > 0 ? `当前回撤已持续 ${d.current.durationDays} 天` : null].filter(Boolean),
    },
    {
      key: 'volatility',
      title: '波动水平',
      summary: `年化波动率 ${na(v.annualPct, '%')}，下行波动率 ${na(v.downsidePct, '%')}`,
      points: [
        isNum(v.worstDayPct) ? `单日最大跌幅 ${v.worstDayPct}%` : null,
        isNum(v.monthWinRatePct) ? `月度胜率 ${v.monthWinRatePct}%（样本 ${v.monthlySamples} 个月）` : null,
      ].filter(Boolean),
    },
    {
      key: 'riskAdjusted',
      title: '风险调整后收益',
      summary: `夏普比率 ${na(ra.sharpe)}，卡玛比率 ${na(ra.calmar)}，索提诺比率 ${na(ra.sortino)}`,
      points: ['夏普比率衡量每承担一单位波动获得的超额回报，数值越高越好'],
    },
    {
      key: 'positiveRate',
      title: '持有正收益概率',
      summary: r1?.available
        ? `历史上任一交易日买入并持有 1 年，${r1.positiveRatePct}% 的情形为正收益（样本 ${r1.samples} 个，区间 ${r1.sampleFrom} 至 ${r1.sampleTo}）`
        : '历史样本不足，滚动持有概率未做判断',
      points: [
        r3?.available ? `持有 3 年的正收益比例为 ${r3.positiveRatePct}%，收益中位数 ${r3.medianPct}%` : null,
        '为历史数据回溯，不代表未来表现，不构成投资建议',
      ].filter(Boolean),
    },
  ];

  const strengths = [];
  const weaknesses = [];
  if (isNum(ra.sharpe) && ra.sharpe > 0.5) strengths.push(`夏普比率 ${ra.sharpe}，风险调整后回报为正`);
  if (r3?.available && r3.positiveRatePct >= 70) strengths.push(`历史持有 3 年的正收益比例达 ${r3.positiveRatePct}%`);
  if (isNum(d.maxPct) && isNum(facts.peerComparison?.maxDrawdownPct) && Math.abs(d.maxPct) < Math.abs(facts.peerComparison.maxDrawdownPct)) {
    strengths.push('同期最大回撤小于同类平均');
  }
  if (isNum(d.maxPct) && Math.abs(d.maxPct) > 20) weaknesses.push(`历史最大回撤达 ${Math.abs(d.maxPct)}%，持有过程波动明显`);
  if (r1?.available && r1.positiveRatePct < 60) weaknesses.push(`历史持有 1 年正收益比例仅 ${r1.positiveRatePct}%`);
  if (isNum(d.recoveryMedianDays) && d.recoveryMedianDays > 200) weaknesses.push(`回撤修复中位时长约 ${d.recoveryMedianDays} 天，回本较慢`);
  while (strengths.length < 2) strengths.push('其余项目因数据缺失未做判断');
  while (weaknesses.length < 2) weaknesses.push('其余项目因数据缺失未做判断');

  return {
    summary: `历史最大回撤 ${isNum(d.maxPct) ? `${Math.abs(d.maxPct)}%` : '数据不可得'}，年化波动率 ${na(v.annualPct, '%')}${r1?.available ? `，历史持有 1 年正收益比例 ${r1.positiveRatePct}%` : ''}。本板块由指标规则生成。`,
    tag: facts.scoreFacts?.tag || null,
    modules,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
  };
}

/* ===================== ⑤ 好时机与成本 ===================== */
function timingCost(facts) {
  const val = facts.valuation || {};
  const np = facts.navPosition || {};
  const fee = facts.fee || {};
  const sc = facts.scaleStatus || {};
  const pm = facts.premium || {};

  const modules = [
    {
      key: 'valuation',
      title: '持仓估值位置',
      summary: val.available
        ? `重仓加权市盈率 ${na(val.pe)}、市净率 ${na(val.pb)}（覆盖权重 ${na(val.coveredWeightPct, '%')}，报告期 ${val.holdingPeriod || '未知'}）${isNum(val.percentile5y) ? `，处于近5年 ${val.percentile5y}% 分位` : ''}`
        : `因${val.reason || '数据缺失'}，持仓估值未做判断`,
      points: [val.percentileReason, val.lagNote].filter(Boolean),
    },
    {
      key: 'navPosition',
      title: '净值位置',
      summary: np.available
        ? `复权净值处于近 ${np.windowYears} 年区间的 ${na(np.percentile, '%')} 分位，距区间高点 ${na(np.distanceFromPeakPct, '%')}`
        : '因净值序列不足，净值位置未做判断',
      points: [isNum(np.recent3mPct) ? `近3个月净值变动 ${np.recent3mPct}%` : null, np.note].filter(Boolean),
    },
    {
      key: 'fee',
      title: '费率与成本',
      summary: fee.available
        ? `年运作费率合计 ${na(fee.annualRunningPct, '%')}（管理费 ${na(fee.managementPct, '%')}+托管费 ${na(fee.custodyPct, '%')}+销售服务费 ${na(fee.salesServicePct, '%')}）`
        : '因缺少费率数据，成本未做测算',
      points: [
        ...(fee.totalCost || []).map((c) => `${c.label}总成本约 ${c.totalPct}%（${c.formula}）`),
        fee.shareClassCompare?.available ? fee.shareClassCompare.statement : fee.shareClassCompare?.reason,
        fee.indexFeeImpact,
        fee.note,
      ].filter(Boolean),
    },
    {
      key: 'scaleStatus',
      title: '规模与申赎状态',
      summary: sc.available
        ? `资产净值约 ${na(sc.valueYi, ' 亿元')}（截止 ${sc.asOf || '未知'}），申购状态「${sc.purchaseStatus || '未知'}」，赎回状态「${sc.redeemStatus || '未知'}」`
        : '因缺少规模数据，本项未做判断',
      points: [
        isNum(sc.changePct) ? `最新一期规模环比 ${sc.changePct}%` : null,
        sc.purchaseStatusMark || null,
        sc.mini ? `规模低于 ${sc.miniThresholdYi} 亿元的警戒线` : null,
      ].filter(Boolean),
    },
  ];

  if (pm.available) {
    modules.push({
      key: 'premium',
      title: '折溢价',
      summary: `场内价格 ${na(pm.pricePct)}，相对净值 ${na(pm.premiumPct, '%')}`,
      points: ['场内溢价回归时价格可能下跌而净值不变', pm.note].filter(Boolean),
    });
  }

  const strengths = [];
  const weaknesses = [];
  if (isNum(fee.annualRunningPct) && !fee.highFee) strengths.push(`年运作费率 ${fee.annualRunningPct}%，低于该类型常见水平`);
  if (isNum(val.percentile5y) && val.percentile5y <= 40) strengths.push(`持仓估值处于近5年 ${val.percentile5y}% 分位，位置偏低`);
  if (isNum(np.percentile) && np.percentile <= 40) strengths.push(`净值处于区间 ${np.percentile}% 分位`);
  if (fee.highFee) weaknesses.push(`年运作费率 ${fee.annualRunningPct}%，高于该类型常见水平 ${fee.highFeeThresholdPct}%`);
  if (sc.limited) weaknesses.push(`当前申购状态为「${sc.purchaseStatus}」`);
  if (pm.available && pm.level !== 'normal') weaknesses.push(`场内溢价 ${pm.premiumPct}%，存在溢价回归风险`);
  if (!val.available) weaknesses.push('持仓估值分位数据不可得，本项未做判断');
  while (strengths.length < 2) strengths.push('其余项目因数据缺失未做判断');
  while (weaknesses.length < 2) weaknesses.push('其余项目因数据缺失未做判断');

  return {
    summary: `年运作费率 ${na(fee.annualRunningPct, '%')}，持有1年总成本约 ${na((fee.totalCost || []).find((c) => c.key === '1y')?.totalPct, '%')}${np.available ? `，净值处于近 ${np.windowYears} 年区间 ${np.percentile}% 分位` : ''}。本板块由指标规则生成。`,
    tag: facts.scoreFacts?.tag || null,
    modules,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
  };
}

/* ========================= ⑥ 风险排雷 ========================= */
function riskScan(facts) {
  const n = facts.summaryStat || {};
  const levelText = { red: '红灯', yellow: '黄灯', green: '绿灯' }[facts.level] || '未知';
  const summary =
    facts.level === 'green'
      ? facts.greenNote || `基于已获取的公开数据，未发现 ${facts.checkedCount} 类异常。「未发现」不等于「安全」。`
      : `风险等级为${levelText}：命中高严重度 ${n.high || 0} 项、中等 ${n.medium || 0} 项、低 ${n.low || 0} 项，共检查 ${facts.checkedCount} 类异常。${
          facts.hardRedLines?.length ? `其中触发硬红线：${facts.hardRedLines.map((h) => h.title).join('、')}。` : ''
        }本板块由指标规则生成。`;
  return {
    summary,
    tag: levelText,
    findings: (facts.findings || []).map((f) => ({ key: f.key, explain: null })),
  };
}

/* ========================= ① 总览 ========================= */
const PLACEHOLDER = '其余项目因数据缺失未做判断';

function overview(facts) {
  const s = facts.scores || {};
  const parts = [];
  if (facts.fund?.typeLabel) parts.push(facts.fund.typeLabel);
  if (isNum(s.ability)) parts.push(`能力分 ${s.ability}`);
  if (isNum(s.experience)) parts.push(`体验分 ${s.experience}`);
  if (isNum(s.timingCost)) parts.push(`时机成本分 ${s.timingCost}`);
  const levelText = { red: '风险红灯', yellow: '风险黄灯', green: '风险绿灯' }[facts.riskLevel] || '';

  // 占位文案不得进入总览要点，否则总览会出现「其余项目因数据缺失未做判断」这种无信息量条目
  const pick = (arr) => (arr || []).find((x) => x && x !== PLACEHOLDER) || null;
  const keyPoints = [];
  for (const sec of facts.sections || []) {
    const good = pick(sec.strengths);
    const bad = pick(sec.weaknesses);
    if (good) keyPoints.push({ text: good, tone: 'positive', anchor: sec.key });
    if (bad) keyPoints.push({ text: bad, tone: 'negative', anchor: sec.key });
  }
  if (facts.riskLevel !== 'green' && facts.riskSummary) {
    keyPoints.unshift({ text: facts.riskSummary.replace(/本板块由指标规则生成。?/, '').slice(0, 60), tone: 'negative', anchor: 'risk_scan' });
  }
  // 保证正反兼有（A-4）
  const hasPos = keyPoints.some((k) => k.tone === 'positive');
  const hasNeg = keyPoints.some((k) => k.tone === 'negative');
  const ordered = [];
  if (hasPos && hasNeg) {
    // 正反交替，避免出现连续同向
    const pos = keyPoints.filter((k) => k.tone === 'positive');
    const neg = keyPoints.filter((k) => k.tone === 'negative');
    while (ordered.length < 5 && (pos.length || neg.length)) {
      if (neg.length && ordered.length % 2 === 0) ordered.push(neg.shift());
      else if (pos.length) ordered.push(pos.shift());
      else if (neg.length) ordered.push(neg.shift());
    }
  } else {
    ordered.push(...keyPoints.slice(0, 5));
  }

  return {
    oneLiner: `${facts.fund?.name || '本基金'}：${parts.join('、')}${levelText ? `，${levelText}` : ''}`.slice(0, 120),
    keyPoints: ordered.slice(0, 5),
    conflictNote: facts.autoConflictNote || null,
  };
}

module.exports = { goodPerformance, goodManager, goodExperience, timingCost, riskScan, overview };
