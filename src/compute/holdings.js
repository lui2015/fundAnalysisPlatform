'use strict';
/**
 * 持仓、风格与漂移检测
 *
 * 注意：本模块只处理「持仓构成」，不含任何价格与估值信息，
 * 输出同时服务于板块②（好业绩·持仓与风格）、板块③（好舵手·风格一致性）与板块⑥（风险·风格漂移）。
 * 漂移检测必须给出可视化证据（需求 R-8），因此这里保留多期行业分布原始数据。
 */
const { isNum, round, mean, scoreLinear } = require('../utils/num');
const { thresholdsFor } = require('../config/riskRules');
const { TYPE } = require('../config/fundTypes');

/** 主题关键词库：用于「名不符实」检测 */
const THEME_KEYWORDS = [
  { theme: '白酒', match: ['白酒', '酒', '食品饮料', '制造业'] },
  { theme: '医药', match: ['医药', '医疗', '生物', '卫生'] },
  { theme: '消费', match: ['消费', '食品', '饮料', '商业', '零售', '家用电器'] },
  { theme: '科技', match: ['电子', '计算机', '通信', '信息', '半导体', '软件'] },
  { theme: '新能源', match: ['电力设备', '新能源', '电气', '有色金属', '汽车'] },
  { theme: '银行', match: ['银行', '金融'] },
  { theme: '军工', match: ['国防', '军工', '航空', '航天'] },
  { theme: '地产', match: ['房地产', '建筑', '建材'] },
  { theme: '农业', match: ['农林牧渔', '农业', '养殖'] },
  { theme: '互联网', match: ['信息传输', '互联网', '传媒', '软件'] },
  { theme: '半导体', match: ['半导体', '电子', '制造业'] },
  { theme: '红利', match: [] },
];

/**
 * 从基金名称与跟踪标的识别主题
 * 只看名称与标的，**不看投资范围文本**：招募说明书的投资范围往往泛泛提及多个行业，
 * 用它识别主题会把宽基/全市场基金误判为主题基金，进而误报「名不符实」（实测已发生）。
 */
function detectTheme(profile) {
  const name = String(profile.name || '');
  const tracks = String(profile.tracks || '');
  for (const t of THEME_KEYWORDS) {
    if (name.includes(t.theme) || tracks.includes(t.theme)) return t;
  }
  return null;
}

/** 归一化行业分布为 name→pct 映射（占比之和归一到 100） */
function normalizeIndustries(industries) {
  const list = (industries || []).filter((x) => x && x.name && isNum(x.pct) && x.pct > 0);
  const sum = list.reduce((s, x) => s + x.pct, 0);
  if (sum <= 0) return null;
  const map = new Map();
  for (const x of list) map.set(x.name, round((x.pct / sum) * 100, 2));
  return map;
}

/**
 * 行业分布偏离度：L1 距离的一半（0~100），等价于「需要调整的仓位占比」
 */
function distributionDistance(a, b) {
  if (!a || !b) return null;
  const keys = new Set([...a.keys(), ...b.keys()]);
  let l1 = 0;
  for (const k of keys) l1 += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
  return round(l1 / 2, 1);
}

function compute(bundle) {
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const th = thresholdsFor(fundType);
  const periods = (bundle.holdings || []).filter(Boolean);
  const latest = periods[0] || null;

  if (!latest) {
    return {
      available: false,
      reason: '未获取到持仓数据（持仓来自定期报告，可能尚未披露）',
      styleScore: null,
      drift: { available: false, reason: '缺少持仓数据' },
    };
  }

  const stocks = (latest.stocks || []).filter((s) => isNum(s.pct));
  const top10Pct = isNum(latest.top10Pct)
    ? latest.top10Pct
    : stocks.length
      ? round(stocks.slice(0, 10).reduce((s, x) => s + x.pct, 0), 2)
      : null;

  const latestInd = normalizeIndustries(latest.industries);
  const topIndustry = latestInd
    ? [...latestInd.entries()].sort((a, b) => b[1] - a[1])[0]
    : null;

  /* -------------------- 风格漂移检测 -------------------- */
  let drift = { available: false, reason: '历史期数不足（需至少 2 期行业配置）' };
  if (periods.length >= 2) {
    const historyMaps = periods.slice(1).map((p) => normalizeIndustries(p.industries)).filter(Boolean);
    if (latestInd && historyMaps.length) {
      // 历史基准 = 过去各期行业分布的均值
      const baseline = new Map();
      const keys = new Set();
      historyMaps.forEach((m) => m.forEach((_, k) => keys.add(k)));
      for (const k of keys) {
        baseline.set(k, round(mean(historyMaps.map((m) => m.get(k) || 0)), 2));
      }
      const deviationPct = distributionDistance(latestInd, baseline);
      // 逐项偏离，用于前端高亮
      const items = [...new Set([...latestInd.keys(), ...baseline.keys()])]
        .map((k) => ({
          name: k,
          latestPct: latestInd.get(k) || 0,
          historyAvgPct: baseline.get(k) || 0,
          deltaPp: round((latestInd.get(k) || 0) - (baseline.get(k) || 0), 2),
        }))
        .sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp))
        .slice(0, 8);

      drift = {
        available: true,
        deviationPct,
        thresholdPct: th.styleDriftPct,
        severeThresholdPct: th.styleDriftSeverePct,
        level: deviationPct >= th.styleDriftSeverePct ? 'severe' : deviationPct >= th.styleDriftPct ? 'warn' : 'normal',
        items,
        periodsCompared: periods.map((p) => p.period || p.asOf),
        // 可视化证据：多期行业分布堆叠图数据
        stack: periods
          .slice()
          .reverse()
          .map((p) => ({
            period: p.period || p.asOf,
            asOf: p.asOf,
            industries: [...(normalizeIndustries(p.industries) || new Map()).entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([name, pct]) => ({ name, pct })),
          })),
        note:
          fundType === TYPE.INDEX_EQUITY || fundType === TYPE.COMMODITY
            ? '被动型基金按标的指数复制持仓，行业分布变化通常源于指数成分调整，不作为漂移判断'
            : '偏离度为最新一期行业分布相对历史各期均值的调整幅度（L1 距离的一半）',
      };
    }
  }

  /* -------------------- 主题一致性（名不符实） -------------------- */
  const theme = detectTheme(profile);
  let themeMatch = { available: false, reason: '未识别到明确的主题/赛道约定' };
  if (theme && latestInd) {
    const matched = [...latestInd.entries()]
      .filter(([name]) => theme.match.some((kw) => name.includes(kw)) || name.includes(theme.theme))
      .reduce((s, [, pct]) => s + pct, 0);
    themeMatch = {
      available: true,
      theme: theme.theme,
      matchedPct: round(matched, 1),
      thresholdPct: th.themeMismatchPct,
      mismatch: matched < th.themeMismatchPct,
      note: '按证监会行业分类与主题关键词匹配估算，行业分类粒度较粗时可能低估匹配度',
    };
  }

  /* -------------------- 集中度与风格得分 -------------------- */
  const industryCount = latestInd ? latestInd.size : null;
  const singleIndustryPct = topIndustry ? topIndustry[1] : null;
  const turnoverPct = isNum(latest.turnoverPct) ? latest.turnoverPct : null;

  // 风格得分：集中度适中、行业不过度单一、换手不极端为佳（无价格信息参与）
  const concentrationScore = isNum(top10Pct)
    ? top10Pct > th.top10ConcentrationPct
      ? scoreLinear(top10Pct, 100, th.top10ConcentrationPct)
      : scoreLinear(Math.abs(top10Pct - 45), 55, 0)
    : null;
  const industryScore = isNum(singleIndustryPct)
    ? singleIndustryPct > th.singleIndustryPct
      ? scoreLinear(singleIndustryPct, 100, th.singleIndustryPct)
      : 80
    : null;
  const turnoverScore = isNum(turnoverPct) ? scoreLinear(turnoverPct, 600, 80) : null;
  const styleParts = [concentrationScore, industryScore, turnoverScore].filter(isNum);
  const styleScore = styleParts.length ? Math.round(mean(styleParts)) : null;

  return {
    available: true,
    period: latest.period || null,
    asOf: latest.asOf || null,
    lagNote: '持仓数据来自基金定期报告，存在披露滞后；十大重仓之外的持仓（隐形持仓）无法从公开数据获取',
    stocks: stocks.slice(0, 10),
    top10Pct,
    industries: latestInd ? [...latestInd.entries()].map(([name, pct]) => ({ name, pct })).sort((a, b) => b.pct - a.pct) : [],
    industryCount,
    topIndustry: topIndustry ? { name: topIndustry[0], pct: topIndustry[1] } : null,
    assetAlloc: (bundle.assetAlloc || []).slice(-1)[0] || latest.assetAlloc || null,
    assetAllocHistory: bundle.assetAlloc || [],
    turnoverPct,
    drift,
    themeMatch,
    styleScore,
    styleSubScores: { concentration: concentrationScore, industry: industryScore, turnover: turnoverScore },
    scopeNote: profile.scopeNote || null,
  };
}

module.exports = { compute, detectTheme, normalizeIndustries, distributionDistance };
