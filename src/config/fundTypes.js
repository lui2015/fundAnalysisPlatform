'use strict';
/**
 * 基金类型定义与差异化策略（对应 PRD 附录 C：基金类型差异化矩阵）
 *
 * 实现要点：
 *  - 板块与子模块的「存在性」和「权重」随基金类型变化，由本文件集中定义
 *  - 不适用的维度显式置为 null 并说明原因，禁止用 0 分或默认 60 分代替（S-8）
 *  - 类型判定失败时必须拒绝分析，禁止用权益模板兜底非权益基金
 */

const TYPE = {
  EQUITY_ACTIVE: 'equity_active', // 主动权益（股票型 / 偏股混合 / 灵活配置）
  INDEX_EQUITY: 'index_equity', // 被动指数 / 增强指数（含股票 ETF、LOF）
  BOND: 'bond', // 纯债 / 一级 / 二级债基
  HYBRID_BOND: 'hybrid_bond', // 偏债混合 / 平衡混合
  QDII: 'qdii', // QDII（港美股、海外指数）
  FOF: 'fof', // FOF / 养老目标
  MONEY: 'money', // 货币市场基金
  COMMODITY: 'commodity', // 商品 / 黄金
};

const TYPE_LABEL = {
  [TYPE.EQUITY_ACTIVE]: '主动权益',
  [TYPE.INDEX_EQUITY]: '被动指数',
  [TYPE.BOND]: '债券型',
  [TYPE.HYBRID_BOND]: '偏债混合',
  [TYPE.QDII]: 'QDII',
  [TYPE.FOF]: 'FOF',
  [TYPE.MONEY]: '货币型',
  [TYPE.COMMODITY]: '商品型',
};

/** 板块策略：full=全量 / slim=仅 P0 子模块 / replace=换口径 / na=不适用 */
const POLICY = {
  [TYPE.EQUITY_ACTIVE]: {
    good_performance: 'full',
    good_manager: 'full',
    good_experience: 'full',
    timing_cost: 'full',
    riskFocus: ['style_drift', 'capacity', 'personnel', 'concentration'],
  },
  [TYPE.INDEX_EQUITY]: {
    good_performance: 'replace', // 以跟踪误差 + 增强超额替代主动选股能力
    good_manager: 'na', // 不以经理主动能力评价，M 分为 null
    good_experience: 'full',
    timing_cost: 'full', // 费率权重上调
    riskFocus: ['tracking', 'survival', 'liquidity', 'systemic'],
  },
  [TYPE.BOND]: {
    good_performance: 'replace', // 收益来源拆解：利率 / 信用 / 杠杆 / 转债
    good_manager: 'slim',
    good_experience: 'replace', // 回撤小但需看信用冲击
    timing_cost: 'replace', // 久期与利率环境替代持仓估值分位
    riskFocus: ['credit', 'duration', 'holder', 'return_anomaly'],
  },
  [TYPE.HYBRID_BOND]: {
    good_performance: 'full',
    good_manager: 'full',
    good_experience: 'full',
    timing_cost: 'slim',
    riskFocus: ['style_drift', 'credit', 'holder'],
  },
  [TYPE.QDII]: {
    good_performance: 'full',
    good_manager: 'full',
    good_experience: 'full',
    timing_cost: 'full', // 折溢价与限额为重点
    riskFocus: ['premium', 'liquidity', 'systemic', 'personnel'],
  },
  [TYPE.FOF]: {
    good_performance: 'replace',
    good_manager: 'full',
    good_experience: 'full',
    timing_cost: 'replace', // 双重费率
    riskFocus: ['double_fee', 'lockup', 'concentration'],
  },
  [TYPE.MONEY]: {
    good_performance: 'slim',
    good_manager: 'na',
    good_experience: 'replace', // 是否出现负收益日 + 快赎额度
    timing_cost: 'replace', // 仅费率与流动性
    riskFocus: ['survival', 'liquidity', 'holder'],
  },
  [TYPE.COMMODITY]: {
    good_performance: 'replace',
    good_manager: 'na',
    good_experience: 'full',
    timing_cost: 'full',
    riskFocus: ['premium', 'systemic', 'liquidity'],
  },
};

/** 各维度得分的子模块权重（按类型差异化，供 /api/rules 公开口径） */
const SCORE_WEIGHTS = {
  ability: {
    [TYPE.EQUITY_ACTIVE]: { longTerm: 0.3, excess: 0.25, stability: 0.25, holdingStyle: 0.2 },
    [TYPE.INDEX_EQUITY]: { tracking: 0.5, longTerm: 0.2, scaleLiquidity: 0.3 },
    [TYPE.BOND]: { longTerm: 0.4, excess: 0.2, stability: 0.25, holdingStyle: 0.15 },
    [TYPE.HYBRID_BOND]: { longTerm: 0.3, excess: 0.25, stability: 0.25, holdingStyle: 0.2 },
    [TYPE.QDII]: { longTerm: 0.3, excess: 0.25, stability: 0.25, holdingStyle: 0.2 },
    [TYPE.FOF]: { longTerm: 0.35, excess: 0.25, stability: 0.4 },
    [TYPE.MONEY]: { longTerm: 0.6, stability: 0.4 },
    [TYPE.COMMODITY]: { tracking: 0.5, longTerm: 0.25, scaleLiquidity: 0.25 },
  },
  manager: {
    default: { tenure: 0.25, tenurePerf: 0.35, workload: 0.2, consistency: 0.2 },
  },
  experience: {
    default: { drawdown: 0.3, recovery: 0.15, volatility: 0.2, riskAdjusted: 0.2, positiveRate: 0.15 },
    [TYPE.MONEY]: { drawdown: 0.2, volatility: 0.3, positiveRate: 0.5 },
    [TYPE.BOND]: { drawdown: 0.35, recovery: 0.15, volatility: 0.2, riskAdjusted: 0.15, positiveRate: 0.15 },
  },
  timingCost: {
    default: { valuation: 0.45, navPosition: 0.15, fee: 0.25, scaleStatus: 0.15 },
    [TYPE.INDEX_EQUITY]: { valuation: 0.35, navPosition: 0.1, fee: 0.4, scaleStatus: 0.15 },
    [TYPE.BOND]: { duration: 0.4, navPosition: 0.15, fee: 0.3, scaleStatus: 0.15 },
    [TYPE.MONEY]: { fee: 0.5, scaleStatus: 0.5 },
    [TYPE.FOF]: { valuation: 0.3, navPosition: 0.1, fee: 0.45, scaleStatus: 0.15 },
    [TYPE.COMMODITY]: { valuation: 0.3, navPosition: 0.2, fee: 0.35, scaleStatus: 0.15 },
  },
};

/** 不适用维度的说明文案（S-8 要求必须说明原因） */
const NA_REASON = {
  manager: {
    [TYPE.INDEX_EQUITY]: '被动指数基金以复制指数为目标，不以基金经理主动选股能力评价，本板块改看跟踪能力与团队稳定性',
    [TYPE.MONEY]: '货币基金投资于短期货币工具，收益差异主要来自费率与规模，不做基金经理能力评分',
    [TYPE.COMMODITY]: '商品基金以跟踪标的价格为目标，不做基金经理主动能力评分',
  },
};

function weightsOf(dimension, fundType) {
  const table = SCORE_WEIGHTS[dimension] || {};
  return table[fundType] || table.default || null;
}

function policyOf(fundType) {
  return POLICY[fundType] || null;
}

function labelOf(fundType) {
  return TYPE_LABEL[fundType] || '未知类型';
}

/** 该类型下某板块是否适用 */
function isApplicable(fundType, sectionKey) {
  const p = policyOf(fundType);
  if (!p) return false;
  return p[sectionKey] !== 'na';
}

function naReason(fundType, dimension) {
  return NA_REASON[dimension]?.[fundType] || `该类型基金（${labelOf(fundType)}）不适用本维度评分`;
}

/**
 * 按数据源给出的类型文本 + 名称推断内部类型
 * 顺序敏感：先判货币/债券/QDII/FOF/商品，最后才落到权益，避免误判
 * @param {{typeText?:string, name?:string, code?:string, isOnMarket?:boolean}} input
 * @returns {{type:string|null, raw:string, reason:string}}
 */
function classify({ typeText = '', name = '', code = '' } = {}) {
  const t = String(typeText || '');
  const n = String(name || '');
  const all = `${t} ${n}`;

  const has = (...kw) => kw.some((k) => all.includes(k));

  if (has('货币', '现金管理', '理财债券')) return { type: TYPE.MONEY, raw: t, reason: '类型或名称含货币/现金管理' };
  if (has('FOF', '基金中基金', '养老目标', '目标日期', '目标风险')) {
    return { type: TYPE.FOF, raw: t, reason: '类型或名称含 FOF/养老目标' };
  }
  if (has('QDII', '海外', '纳斯达克', '标普', '道琼斯', '恒生', '港股通', '美元债', '中概')) {
    return { type: TYPE.QDII, raw: t, reason: '类型或名称含 QDII/海外市场标识' };
  }
  if (has('黄金', '白银', '商品', '原油', '豆粕', '能源化工')) {
    return { type: TYPE.COMMODITY, raw: t, reason: '类型或名称含商品/黄金标识' };
  }
  // 债券类：需在指数之前判断「债券指数」，避免被当作股票指数
  if (has('债券', '纯债', '短债', '中短债', '可转债', '信用债', '利率债', '同业存单')) {
    if (has('偏债混合', '平衡混合')) return { type: TYPE.HYBRID_BOND, raw: t, reason: '偏债/平衡混合' };
    return { type: TYPE.BOND, raw: t, reason: '类型或名称含债券标识' };
  }
  if (has('偏债', '平衡混合')) return { type: TYPE.HYBRID_BOND, raw: t, reason: '偏债/平衡混合' };
  if (has('指数', 'ETF', '联接', 'LOF', '被动', '增强指数')) {
    return { type: TYPE.INDEX_EQUITY, raw: t, reason: '类型或名称含指数/ETF/联接标识' };
  }
  if (has('股票型', '偏股', '混合型', '灵活配置', '股票', '混合')) {
    return { type: TYPE.EQUITY_ACTIVE, raw: t, reason: '类型为股票型/混合型' };
  }
  if (/^\d{6}$/.test(String(code)) && t) {
    // 有类型文本但未能匹配任何关键词：拒绝而非兜底（避免误导性结论）
    return { type: null, raw: t, reason: `未支持的基金类型：${t}` };
  }
  return { type: null, raw: t, reason: '无法识别基金类型' };
}

module.exports = {
  TYPE,
  TYPE_LABEL,
  POLICY,
  SCORE_WEIGHTS,
  classify,
  policyOf,
  labelOf,
  weightsOf,
  isApplicable,
  naReason,
};
