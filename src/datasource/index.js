'use strict';
/**
 * 数据源编排层
 *
 * 职责：
 *  1) 把多个独立接口拼装成统一的 bundle（计算层完全不感知数据来自何处）
 *  2) 逐项降级：任一项失败只影响对应子模块，并计入「数据完整度 N/M」（F2-21）
 *  3) DATA_MODE：auto（真实源失败回退演示数据并显著标注）/ live（只用真实源）/ mock（纯离线演示）
 *  4) 基金类型识别失败时拒绝分析，禁止用权益模板兜底（附录 C 实现要求）
 */
const config = require('../config');
const logger = require('../utils/logger');
const cache = require('../utils/cache');
const dates = require('../utils/dates');
const { round, toNum } = require('../utils/num');
const tiantian = require('./tiantian');
const mock = require('./mock');
const dict = require('./dictionary');
const { classify, TYPE, labelOf } = require('../config/fundTypes');
const { normalizeCode, shareClassOf, seriesKeyOf, looksOnMarket, sanitizeQuery } = require('./codes');

const MODE = ['auto', 'live', 'mock'].includes(process.env.DATA_MODE) ? process.env.DATA_MODE : 'auto';

/* ============================== 搜索 ============================== */

/** 合并远程与本地字典结果，并按同系列分组（F1-3：A/C 份额必须显式区分） */
function groupShareClasses(list) {
  const bySeries = new Map();
  for (const item of list) {
    const key = seriesKeyOf(item.name);
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push(item);
  }
  return list.map((item) => {
    const key = seriesKeyOf(item.name);
    const siblings = bySeries.get(key) || [];
    return {
      ...item,
      shareClass: shareClassOf(item.name),
      seriesKey: key,
      siblingCount: siblings.length,
    };
  });
}

async function search(query, limit = 8) {
  const q = sanitizeQuery(query);
  if (!q) return { data: [], source: 'none' };

  const local = dict.search(q, limit);
  if (MODE === 'mock') {
    return { data: groupShareClasses(mock.search(q, limit)), source: 'mock', degraded: true };
  }

  const remote = await tiantian.search(q, limit);
  if (remote.ok && remote.data.length) {
    // 远程结果优先，本地字典补充拼音命中（远程接口不支持拼音首字母）
    const seen = new Set(remote.data.map((x) => x.code));
    const merged = [...remote.data];
    for (const l of local) if (!seen.has(l.code) && merged.length < limit) merged.push(l);
    return { data: groupShareClasses(merged), source: remote.source };
  }
  if (local.length) return { data: groupShareClasses(local), source: 'local-dict', degraded: true };
  if (MODE === 'live') return { data: [], source: 'none', error: remote.error };
  return { data: groupShareClasses(mock.search(q, limit)), source: 'mock', degraded: true };
}

/* ============================== 热门 ============================== */

/** 热门基金列表（支持按类型筛选与排序） */
async function hot(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 12, 50);
  const type = (opts.type || '').trim();
  const sort = (opts.sort || '').trim(); // 'count' | 'name'

  try {
    const db = require('../db');
    let rows = db.hotByAnalysisCount(limit * 3); // 多取一些用于筛选
    if (rows.length >= Math.min(6, limit)) {
      let data = rows.map((r) => ({ code: r.code, name: r.name, analyzedCount: r.count }));
      if (type) data = data.filter((f) => f.name && f.name.includes(type));
      if (sort === 'name') data.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
      return { data: data.slice(0, limit), source: 'platform' };
    }
  } catch (e) {
    logger.warn('热门统计读取失败', { error: e.message });
  }

  // 回退到本地字典
  let local = dict.all().slice(0, limit * 2).map((f) => ({
    code: f.code, name: f.name, typeText: f.typeText, company: f.company,
  }));
  if (type) local = local.filter((f) => (f.typeText || '').includes(type));
  if (sort === 'name') local.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  return { data: local.slice(0, limit), source: 'local-dict' };
}

/* ========================= 单项工具 ========================= */

function pickLatest(series) {
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

/** 从行业配置多期结果构造持仓期数组（与 mock 结构对齐） */
function buildHoldings(sector, positions) {
  const periods = [];
  const sectorPeriods = sector?.ok ? sector.data.periods : [];
  const stocks = positions?.ok ? positions.data.stocks : [];
  if (!sectorPeriods.length && !stocks.length) return periods;

  const periodLabel = (asOf) => {
    const m = String(asOf).match(/^(\d{4})-(\d{2})/);
    if (!m) return String(asOf);
    const q = Math.ceil(Number(m[2]) / 3);
    return `${m[1]}Q${q}`;
  };

  if (sectorPeriods.length) {
    sectorPeriods.forEach((p, i) => {
      periods.push({
        period: periodLabel(p.asOf),
        asOf: p.asOf,
        industries: p.industries,
        // 十大重仓只有最新一期，历史期次不提供（公开接口限制）
        stocks: i === 0 ? stocks : [],
        top10Pct: i === 0 ? positions?.data?.top10Pct ?? null : null,
        assetAlloc: null,
        turnoverPct: null,
      });
    });
  } else if (stocks.length) {
    periods.push({
      period: '最新披露期',
      asOf: null,
      industries: [],
      stocks,
      top10Pct: positions.data.top10Pct,
      assetAlloc: null,
      turnoverPct: null,
    });
  }
  return periods;
}

/* ========================= 主流程：取数 ========================= */

/**
 * 拉取一只基金的完整数据包
 * @param {string} rawCode
 * @param {{deep?:boolean}} opts
 */
async function fetchBundle(rawCode, opts = {}) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error('基金代码格式不正确（应为 6 位数字）');

  if (MODE === 'mock') {
    const bundle = mock.buildBundle(code);
    return {
      bundle,
      mocked: true,
      degraded: true,
      sources: [{ name: '演示数据（非真实行情）', asOf: bundle.profile.asOf }],
      completeness: { available: 15, total: 15, missing: [] },
      notes: ['本报告使用演示数据生成，不代表真实基金情况'],
    };
  }

  const t0 = Date.now();
  const [basic, pz, arc] = await Promise.all([tiantian.basicInfo(code), tiantian.pingzhong(code), tiantian.archive(code)]);

  // 三项核心数据全部失败 → 按模式处理
  if (!basic.ok && !pz.ok && !arc.ok) {
    if (MODE === 'live') {
      throw new Error(`真实数据源不可用（${basic.error || pz.error || arc.error}）`);
    }
    logger.warn('真实数据源全部失败，回退演示数据', { code, error: basic.error || pz.error });
    const bundle = mock.buildBundle(code);
    return {
      bundle,
      mocked: true,
      degraded: true,
      sources: [{ name: '演示数据（真实数据源不可用时的兜底）', asOf: bundle.profile.asOf }],
      completeness: { available: 15, total: 15, missing: [] },
      notes: ['真实数据源当前不可用，本报告使用演示数据生成，不代表真实基金情况'],
    };
  }

  const typeText = basic.ok ? basic.data.typeText : arc.ok ? arc.data.typeText : '';
  const name = basic.ok ? basic.data.name : arc.ok ? arc.data.shortName : pz.ok ? pz.data.name : '';
  const cls = classify({ typeText, name, code });
  if (!cls.type) {
    throw new Error(
      `${cls.reason}。本平台一期支持境内公募开放式基金与 ETF/LOF（权益/指数/债券/货币/QDII/FOF/商品），暂不支持该类型`
    );
  }
  const fundType = cls.type;

  const navSeries = pz.ok ? pz.data.nav : [];
  const latestNav = pickLatest(navSeries);
  const navDate = latestNav?.date || (basic.ok ? basic.data.navDate : null);

  // 第二批：依赖类型/持仓的接口
  const needOnMarket = (basic.ok && basic.data.isOnMarket) || looksOnMarket(code);
  const [period, positions, sector, notices, feeT, mgrHist, onMkt, market] = await Promise.all([
    tiantian.periodStats(code),
    tiantian.positions(code),
    tiantian.sectorAlloc(code),
    tiantian.notices(code),
    tiantian.feeTiers(code),
    tiantian.managerHistory(code),
    needOnMarket ? tiantian.onMarketQuote(code, latestNav?.unit) : Promise.resolve({ ok: false, error: '非场内基金' }),
    tiantian.marketEnv(),
  ]);

  // 重仓股加权估值（权益类才有意义）
  let valuation = { ok: false, error: '该类型基金不适用持仓估值' };
  if ([TYPE.EQUITY_ACTIVE, TYPE.INDEX_EQUITY, TYPE.HYBRID_BOND, TYPE.QDII].includes(fundType) && positions.ok) {
    valuation = await tiantian.holdingValuation(positions.data.stocks);
  }

  /* -------- 组装 bundle -------- */
  const scale = pz.ok ? pz.data.scale : [];
  const latestScale = pickLatest(scale);
  const holdings = buildHoldings(sector, positions);

  const fees = {
    management: arc.ok ? arc.data.managementFeePct : null,
    custody: arc.ok ? arc.data.custodyFeePct : null,
    salesService: arc.ok ? arc.data.salesServiceFeePct : null,
    purchase: basic.ok ? basic.data.purchaseRatePct : pz.ok ? pz.data.feeRate.purchaseRatePct : null,
    purchaseOriginal: basic.ok ? basic.data.purchaseRateOriginalPct : pz.ok ? pz.data.feeRate.purchaseRateOriginalPct : null,
    redeemTiers: feeT.ok
      ? feeT.data.redeemTiers.map((t) => ({ maxDays: t.maxDays, ratePct: t.ratePct }))
      : arc.ok && arc.data.redeemFeeMaxPct !== null
        ? [{ maxDays: 7, ratePct: arc.data.redeemFeeMaxPct }, { maxDays: null, ratePct: null }]
        : [],
    asOf: dates.todayStr(),
    trackingErrorLimitPct: arc.ok ? arc.data.trackingErrorLimitPct : null,
  };

  /**
   * 基金经理：把「现任经理面板数据」与「历任任职区间」合并
   * pingzhongdata 提供现任经理的从业年限、在管只数与规模、任期收益 vs 同类/沪深300
   * jjjl 页提供每一任的任职起止日与任职回报（区分基金历史业绩与现任经理业绩的关键）
   */
  const terms = mgrHist.ok ? mgrHist.data.terms : [];
  const panel = pz.ok ? pz.data.managers : [];
  const currentTerm = terms.find((t) => t.current) || null;

  /**
   * 某位现任经理「自己」的任职起始日：
   * 共同管理会把一段任期拆成多条记录（如新增经理时），
   * 需沿着包含该经理姓名且首尾相接的任期链向前回溯，取最早的起始日。
   * 否则会把「管了 8 年的老将」误判为「刚上任 2 个月的新人」。
   */
  function tenureStartOf(managerName) {
    if (!currentTerm) return null;
    const asc = terms.slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    let start = currentTerm.startDate;
    let guard = 0;
    while (guard < 30) {
      guard += 1;
      const prev = asc
        .filter((t) => t.endDate && Math.abs(dates.diffDays(start, t.endDate) ?? 99) <= 3)
        .find((t) => t.names.some((n) => n === managerName));
      if (!prev) break;
      start = prev.startDate;
    }
    return start;
  }

  const managers = [];
  if (panel.length) {
    panel.forEach((m, i) => {
      const start = tenureStartOf(m.name) || currentTerm?.startDate || null;
      managers.push({
        ...m,
        startDate: start,
        endDate: null,
        current: true,
        tenureYears: start && navDate ? round(dates.diffDays(navDate, start) / 365, 1) : null,
        tenureSpanText: start === currentTerm?.startDate ? currentTerm?.spanText || null : null,
        tenureReturnPct: m.tenureReturnPct ?? (i === 0 ? currentTerm?.tenureReturnPct ?? null : null),
        bio: i === 0 && mgrHist.ok ? mgrHist.data.currentBio : null,
      });
    });
  } else if (currentTerm) {
    managers.push({
      name: currentTerm.names.join('、'),
      startDate: currentTerm.startDate,
      endDate: null,
      current: true,
      workYears: null,
      fundCount: null,
      aumYi: null,
      tenureReturnPct: currentTerm.tenureReturnPct,
      tenurePeerPct: null,
      tenureHs300Pct: null,
      tenureYears: round(dates.diffDays(navDate, currentTerm.startDate) / 365, 1),
      tenureSpanText: currentTerm.spanText,
      otherFunds: [],
      bio: mgrHist.ok ? mgrHist.data.currentBio : null,
    });
  }
  // 历任（不含现任），用于「变更历史」与人员变动风险规则
  const pastTerms = terms
    .filter((t) => !t.current)
    .map((t) => ({
      name: t.names.join('、'),
      startDate: t.startDate,
      endDate: t.endDate,
      current: false,
      tenureReturnPct: t.tenureReturnPct,
      tenureSpanText: t.spanText,
    }));

  const profile = {
    code,
    name: name || `基金${code}`,
    fullName: arc.ok ? arc.data.fullName : null,
    company: (basic.ok && basic.data.company) || (arc.ok ? arc.data.company : null),
    custodian: arc.ok ? arc.data.custodian : null,
    typeText: typeText || labelOf(fundType),
    fundType,
    typeReason: cls.reason,
    shareClass: shareClassOf(name),
    establishDate: (basic.ok && basic.data.establishDate) || (arc.ok ? arc.data.establishDate : null),
    benchmark: arc.ok ? arc.data.benchmark : null,
    tracks: (basic.ok && basic.data.indexName) || (arc.ok ? arc.data.tracks : null),
    trackIndexCode: basic.ok ? basic.data.indexCode : null,
    onMarket: Boolean(needOnMarket),
    purchaseStatus: basic.ok ? basic.data.purchaseStatus : null,
    purchaseStatusMark: basic.ok ? basic.data.purchaseStatusMark : null,
    redeemStatus: basic.ok ? basic.data.redeemStatus : null,
    largePurchaseLimit: basic.ok ? basic.data.maxPurchase : null,
    largePurchaseLimitText: basic.ok ? basic.data.largePurchaseLimitText : null,
    minHoldDays: 0,
    riskLevel: basic.ok ? basic.data.riskLevel : null,
    redeemArrivalText: basic.ok ? basic.data.redeemArrivalText : null,
    scopeNote: arc.ok ? arc.data.scopeNote : null,
    scaleYi: latestScale?.valueYi ?? (basic.ok ? basic.data.scaleYi : null),
    scaleAsOf: latestScale?.asOf ?? (basic.ok ? basic.data.scaleAsOf : null),
    navDate,
    unitNav: latestNav?.unit ?? (basic.ok ? basic.data.unitNav : null),
    accNav: latestNav?.acc ?? (basic.ok ? basic.data.accNav : null),
    dayChangePct: basic.ok ? basic.data.dayChangePct : null,
    asOf: dates.todayStr(),
  };

  const bundle = {
    profile,
    nav: navSeries,
    dividends: pz.ok ? pz.data.dividends : [],
    benchmarkSeries: [],
    peerAvgSeries: pz.ok ? pz.data.peerAvgSeries : [],
    csi300Series: pz.ok ? pz.data.csi300Series : [],
    selfCumSeries: pz.ok ? pz.data.selfCumSeries : [],
    periodStats: period.ok ? period.data : null,
    rankSeries: pz.ok ? pz.data.rankSeries : [],
    scale,
    shares: pz.ok ? pz.data.shares : [],
    assetAlloc: pz.ok ? pz.data.assetAlloc : [],
    holders: pz.ok ? pz.data.holders : null,
    managers,
    pastManagerTerms: pastTerms,
    holdings,
    fees,
    notices: notices.ok ? notices.data : [],
    valuation: valuation.ok
      ? { ...valuation.data, asOf: navDate, holdingPeriod: holdings[0]?.period || null }
      : null,
    onMarketQuote: onMkt.ok ? onMkt.data : null,
    bondDetail: null, // 久期/评级分布需定期报告全文，公开接口不提供，标注为不可用
    market: market.ok ? { ...market.data, csi300Percentile: null, sentiment: null } : null,
    crossCheck: basic.ok ? basic.data.crossCheck : null,
  };

  /* -------- 数据完整度统计（F2-21 / F4-4） -------- */
  const checks = [
    ['基础信息', basic.ok],
    ['净值序列', navSeries.length > 20],
    ['阶段业绩与同类排名', period.ok],
    ['同类排名日序列', (bundle.rankSeries || []).length > 20],
    ['规模序列', scale.length > 0],
    ['持有人结构', Boolean(bundle.holders)],
    ['资产配置', (bundle.assetAlloc || []).length > 0],
    ['申赎与份额', (bundle.shares || []).length > 0],
    ['基金经理', managers.length > 0],
    ['经理任期区间', mgrHist.ok],
    ['十大重仓', positions.ok],
    ['行业配置', sector.ok],
    ['费率明细', fees.management !== null || fees.purchase !== null],
    ['赎回费阶梯', feeT.ok],
    ['公告', notices.ok && notices.data.length > 0],
    ['持仓估值', Boolean(bundle.valuation)],
  ];
  if (needOnMarket) checks.push(['场内折溢价', onMkt.ok]);

  const missing = checks.filter(([, v]) => !v).map(([k]) => k);
  const completeness = { available: checks.length - missing.length, total: checks.length, missing };

  const sources = [
    basic.ok && { name: '天天基金-基础信息', asOf: basic.data.navDate },
    pz.ok && { name: '天天基金-净值与面板数据', asOf: navDate },
    arc.ok && { name: '天天基金-基金概况', asOf: profile.asOf },
    period.ok && { name: '天天基金-阶段业绩与同类排名', asOf: navDate },
    mgrHist.ok && { name: '天天基金-基金经理变动一览', asOf: profile.asOf },
    positions.ok && { name: '天天基金-十大重仓', asOf: holdings[0]?.asOf || null },
    sector.ok && { name: '天天基金-行业配置', asOf: sector.asOf },
    notices.ok && { name: '天天基金-基金公告', asOf: notices.asOf },
    feeT.ok && { name: '天天基金-费率明细', asOf: fees.asOf },
    onMkt.ok && { name: '东方财富-场内行情', asOf: navDate },
    valuation.ok && { name: '东方财富-重仓股估值', asOf: navDate },
  ].filter(Boolean);

  logger.info('取数完成', {
    code,
    fundType,
    ms: Date.now() - t0,
    completeness: `${completeness.available}/${completeness.total}`,
    missing,
  });

  return { bundle, mocked: false, degraded: missing.length > 0, sources, completeness, notes: [] };
}

/** 行情快照（供搜索结果与自选列表使用） */
async function quickQuote(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) throw new Error('基金代码格式不正确');
  if (MODE === 'mock') {
    const b = mock.buildBundle(code);
    const last = pickLatest(b.nav);
    return {
      code,
      name: b.profile.name,
      typeText: b.profile.typeText,
      navDate: last?.date,
      unitNav: last?.unit,
      dayChangePct: round((last.adj / b.nav[b.nav.length - 2].adj - 1) * 100, 2),
      mocked: true,
    };
  }
  const basic = await tiantian.basicInfo(code);
  if (!basic.ok) throw new Error('行情暂不可用');
  return {
    code,
    name: basic.data.name,
    typeText: basic.data.typeText,
    navDate: basic.data.navDate,
    unitNav: basic.data.unitNav,
    accNav: basic.data.accNav,
    dayChangePct: basic.data.dayChangePct,
    return1y: basic.data.crossCheck?.return1y ?? null,
    purchaseStatus: basic.data.purchaseStatus,
    mocked: false,
  };
}

/** 健康探测 */
async function healthProbe() {
  if (MODE === 'mock') return { mode: MODE, items: [{ name: 'mock', ok: true }] };
  const [basic, pz] = await Promise.all([tiantian.basicInfo('161725'), tiantian.pingzhong('161725')]);
  return {
    mode: MODE,
    items: [
      { name: '天天基金-基础信息', ok: basic.ok, error: basic.ok ? null : basic.error },
      { name: '天天基金-净值序列', ok: pz.ok, error: pz.ok ? null : pz.error },
    ],
  };
}

module.exports = { MODE, search, hot, fetchBundle, quickQuote, healthProbe, groupShareClasses };
