'use strict';
/**
 * 风险阈值配置（需求 R-6：阈值可配置 + 按基金类型差异化）
 *
 * 支持用 data/risk-thresholds.json 覆盖，格式：
 *   { "base": { "miniScaleYi": 0.5 }, "byType": { "bond": { "maxDrawdownHigh": 8 } } }
 * 差异化的意义：债基负债/杠杆阈值、指数基金跟踪误差阈值、货币基金规模阈值与权益基金完全不同，
 * 套用同一套阈值必然误报。
 */
const fs = require('fs');
const path = require('path');
const config = require('./index');
const { TYPE } = require('./fundTypes');
const logger = require('../utils/logger');

/** 通用基准阈值 */
const BASE = {
  // —— 存续与规模 ——
  miniScaleYi: 0.5, // 迷你基金：规模低于 0.5 亿（5000 万，合同终止条款常用口径）
  miniScaleWarnYi: 1.0, // 规模预警线
  hugeScaleYi: 300, // 巨无霸基金：规模过大影响调仓
  scaleSurgeRatio: 2.0, // 规模单季暴增倍数（>200%）
  scaleShrinkPct: 40, // 规模单季缩水比例(%)

  // —— 持有人结构 ——
  institutionHoldPct: 70, // 机构持有占比过高(%)
  singleHolderPct: 20, // 单一持有人占比警戒(%)
  singleHolderRedPct: 50, // 单一持有人占比红线(%)

  // —— 人员 ——
  newManagerMonths: 6, // 现任经理任职不足（月）
  newManagerRedMonths: 3, // 硬红线：任职不足 3 个月且前任已离任
  managerChangeTimes3y: 3, // 近 3 年更换次数
  managerFundCount: 10, // 一拖多只数
  managerAumYi: 500, // 在管总规模（亿）

  // —— 集中度与漂移 ——
  top10ConcentrationPct: 70, // 前十大集中度过高(%)
  singleIndustryPct: 60, // 单一行业占比过高(%)
  styleDriftPct: 30, // 风格漂移：行业分布相对历史的偏离度(%)
  styleDriftSeverePct: 50, // 严重漂移（硬红线）
  themeMismatchPct: 50, // 主题基金重仓与主题相符比例低于此值

  // —— 体验 ——
  maxDrawdownHigh: 40, // 最大回撤过深(%)
  maxDrawdownMid: 25,
  recoveryLongDays: 540, // 回撤修复过久（自然日）
  volatilityHigh: 28, // 年化波动率过高(%)
  currentDrawdownDeep: 25, // 当前回撤仍深(%)

  // —— 估值与拥挤 ——
  valuationHighPct: 80, // 持仓估值历史分位过高
  navHighPct: 95, // 净值处于历史极高分位
  surge3mPct: 60, // 近 3 月涨幅过大(%)

  // —— 费率 ——
  totalFeeHighPct: 2.0, // 年综合费率过高(%)

  // —— 场内 ——
  premiumWarnPct: 5, // 折溢价警戒(%)
  premiumRedPct: 10, // 折溢价红线(%)
  turnoverLowWan: 500, // 场内日均成交额过低（万元）

  // —— 指数基金 ——
  trackingErrorHighPct: 4, // 年化跟踪误差过高(%)
  trackingDeviationPct: 3, // 与标的年度收益偏离(%)

  // —— 债券基金 ——
  lowRatingPct: 30, // 低评级债占比过高(%)
  leveragePct: 140, // 杠杆率过高(%)
  durationLongYear: 5, // 久期偏长（年）
  convertibleHighPct: 30, // 可转债占比过高(%)
  bondReturnAnomalyPct: 6, // 债基年化收益显著高于同类的绝对差(个百分点)

  // —— 其他 ——
  benchmarkDeviateYears: 3, // 与基准长期背离的年数
  navJumpPct: 5, // 单日净值异常跳变(%)
  establishedShortMonths: 12, // 成立时间过短（月）
  establishedMinMonths: 6, // 不足 6 个月不展示排名（合规）
};

/** 按基金类型覆盖 */
const BY_TYPE = {
  [TYPE.BOND]: {
    maxDrawdownHigh: 8,
    maxDrawdownMid: 4,
    volatilityHigh: 6,
    top10ConcentrationPct: 95, // 债基集中度天然高，不应误报
    singleIndustryPct: 100,
    styleDriftPct: 60,
    totalFeeHighPct: 1.0,
    recoveryLongDays: 270,
    currentDrawdownDeep: 5,
    valuationHighPct: 101, // 不适用估值分位
    // 债基经理管理多只同策略产品是常态，阈值单独放宽
    managerFundCount: 16,
    managerAumYi: 900,
    surge3mPct: 12,
  },
  [TYPE.HYBRID_BOND]: {
    maxDrawdownHigh: 15,
    maxDrawdownMid: 8,
    volatilityHigh: 12,
    totalFeeHighPct: 1.6,
  },
  [TYPE.MONEY]: {
    maxDrawdownHigh: 0.5,
    maxDrawdownMid: 0.1,
    volatilityHigh: 0.5,
    miniScaleYi: 2, // 货币基金规模天然大，阈值另设
    hugeScaleYi: 5000,
    top10ConcentrationPct: 100,
    singleIndustryPct: 100,
    totalFeeHighPct: 0.6,
    valuationHighPct: 101,
    institutionHoldPct: 95, // 机构占比高是货币基金常态
    managerFundCount: 20,
    managerAumYi: 3000,
    navJumpPct: 0.2,
    surge3mPct: 2,
    recoveryLongDays: 60,
    currentDrawdownDeep: 0.3,
  },
  [TYPE.INDEX_EQUITY]: {
    styleDriftPct: 100, // 指数基金按指数复制，不做漂移判断
    top10ConcentrationPct: 90, // 窄基指数集中度天然高
    singleIndustryPct: 101,
    totalFeeHighPct: 1.0,
    managerFundCount: 25, // 指数基金经理一拖多为常态
    managerAumYi: 2000,
    newManagerMonths: 3,
  },
  [TYPE.COMMODITY]: {
    styleDriftPct: 100,
    top10ConcentrationPct: 101,
    singleIndustryPct: 101,
    valuationHighPct: 101,
    totalFeeHighPct: 1.0,
    managerFundCount: 25,
    managerAumYi: 2000,
  },
  [TYPE.QDII]: {
    premiumWarnPct: 3, // QDII 溢价更敏感
    premiumRedPct: 8,
    totalFeeHighPct: 2.4,
    trackingErrorHighPct: 6,
  },
  [TYPE.FOF]: {
    top10ConcentrationPct: 90,
    singleIndustryPct: 101,
    totalFeeHighPct: 2.2,
    maxDrawdownHigh: 25,
    maxDrawdownMid: 15,
  },
};

let override = { base: {}, byType: {} };
const overrideFile = path.join(config.dataDir, 'risk-thresholds.json');
try {
  if (fs.existsSync(overrideFile)) {
    const raw = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      override = { base: raw.base || {}, byType: raw.byType || {} };
      logger.info('已加载风险阈值覆盖配置', { file: overrideFile });
    }
  }
} catch (e) {
  logger.warn('风险阈值覆盖配置读取失败，使用内置阈值', { error: e.message });
}

/** 取某基金类型下的完整阈值表 */
function thresholdsFor(fundType) {
  return {
    ...BASE,
    ...(BY_TYPE[fundType] || {}),
    ...(override.base || {}),
    ...((override.byType || {})[fundType] || {}),
  };
}

module.exports = { BASE, BY_TYPE, thresholdsFor, overrideFile };
