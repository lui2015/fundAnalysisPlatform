'use strict';
/**
 * 演示数据（DATA_MODE=mock，或 auto 模式下真实源全部失败时的兜底）
 *
 * 设计原则：
 *  1) 完全确定性：同一代码在同一净值日必然生成同一份数据，满足「可复现性」验收（A/M/X/T 极差 ≤5）
 *  2) 结构与真实数据源完全一致，计算层无需感知数据来自何处
 *  3) 任何使用演示数据的报告都会被显著标注，绝不冒充真实数据
 *  4) 预置若干「问题基金」场景（999001~999005），用于风险规则引擎的回归验证
 */
const dates = require('../utils/dates');
const dict = require('./dictionary');
const { TYPE, classify } = require('../config/fundTypes');
const { shareClassOf, looksOnMarket } = require('./codes');

/* ------------------------- 确定性随机 ------------------------- */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态（Box-Muller） */
function normalGen(rnd) {
  let cached = null;
  return function next() {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    cached = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** 交易日序列（跳过周末，忽略节假日，演示用途足够） */
function tradingDays(startStr, endStr) {
  const out = [];
  let d = dates.toDate(startStr);
  const end = dates.toDate(endStr);
  if (!d || !end) return out;
  while (d.getTime() <= end.getTime()) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(dates.fmt(d));
    d = new Date(d.getTime() + dates.DAY_MS);
  }
  return out;
}

/**
 * 生成日收益序列：多段行情制度（牛/震荡/熊）叠加，产生真实感的回撤
 * @returns {number[]} 每日收益率（小数）
 */
function genDailyReturns(n, { ann, vol, seed }) {
  const rnd = mulberry32(seed);
  const nrm = normalGen(rnd);
  const dailyVol = vol / 100 / Math.sqrt(252);
  const out = [];
  // 把时间切成若干段，每段一个漂移，段长 120~380 交易日
  let i = 0;
  const regimes = [];
  while (i < n) {
    const len = 120 + Math.floor(rnd() * 260);
    const kind = rnd();
    // 牛 35% / 震荡 40% / 熊 25%
    const mult = kind < 0.35 ? 2.6 : kind < 0.75 ? 0.4 : -2.1;
    regimes.push({ len: Math.min(len, n - i), mult });
    i += len;
  }
  const baseDaily = ann / 100 / 252;
  for (const r of regimes) {
    for (let k = 0; k < r.len; k += 1) {
      out.push(baseDaily * r.mult + dailyVol * nrm());
    }
  }
  return out.slice(0, n);
}

function seriesFromReturns(days, rets, base = 1) {
  const out = [];
  let v = base;
  for (let i = 0; i < days.length; i += 1) {
    if (i > 0) v *= 1 + (rets[i] || 0);
    out.push({ date: days[i], value: Math.round(v * 1e6) / 1e6 });
  }
  return out;
}

/* ------------------------- 场景配置 ------------------------- */
/** 预置问题基金场景，用于风险规则回归 */
const SCENARIOS = {
  '999001': {
    name: '演示·迷你规模清盘风险基金A',
    typeText: '混合型-偏股',
    company: '演示基金管理有限公司',
    seed: { ann: -6.5, vol: 30, mdd: 55 },
    start: '2019-03-15',
    tweaks: { tinyScale: true, clearingNotice: true, shrink: true },
  },
  '999002': {
    name: '演示·风格漂移主题基金A',
    typeText: '混合型-偏股',
    company: '演示基金管理有限公司',
    seed: { ann: 3.2, vol: 27, mdd: 42 },
    start: '2018-06-11',
    themeName: '医药',
    tweaks: { styleDrift: true, highTurnover: true },
  },
  '999003': {
    name: '演示·机构定制债券基金A',
    typeText: '债券型-长债',
    company: '演示基金管理有限公司',
    seed: { ann: 5.8, vol: 3.1, mdd: 6.2 },
    start: '2017-09-20',
    tweaks: { singleHolder: 63.4, institution: 96.8, lowRating: 42, leverage: 158 },
  },
  '999004': {
    name: '演示·新任经理接管基金A',
    typeText: '混合型-偏股',
    company: '演示基金管理有限公司',
    seed: { ann: 11.4, vol: 25, mdd: 40 },
    start: '2016-04-08',
    tweaks: { newManagerMonths: 2, frequentChange: true, managerLeftNotice: true },
  },
  '999005': {
    name: '演示·高溢价QDII指数基金',
    typeText: 'QDII-指数LOF',
    company: '演示基金管理有限公司',
    seed: { ann: 14.2, vol: 26, mdd: 38 },
    start: '2017-11-02',
    tracks: '纳斯达克100指数',
    onMarket: true,
    tweaks: { premium: 12.6, purchaseLimited: 1000 },
  },
};

/* ------------------------- 主生成器 ------------------------- */

function baseMetaOf(code) {
  const scenario = SCENARIOS[code];
  if (scenario) {
    return {
      code,
      name: scenario.name,
      company: scenario.company,
      typeText: scenario.typeText,
      benchmark: '沪深300指数收益率×80%+中债总指数收益率×20%',
      start: scenario.start,
      tracks: scenario.tracks || null,
      onMarket: Boolean(scenario.onMarket),
      seed: scenario.seed,
      tweaks: scenario.tweaks || {},
      themeName: scenario.themeName || null,
    };
  }
  const d = dict.get(code);
  if (d) {
    return {
      code,
      name: d.name,
      company: d.company,
      typeText: d.typeText,
      benchmark: d.benchmark,
      start: d.start,
      tracks: d.tracks || null,
      onMarket: Boolean(d.onMarket),
      seed: d.seed,
      tweaks: {},
      themeName: null,
    };
  }
  // 未知代码：生成一只通用主动权益演示基金
  const rnd = mulberry32(hashSeed(code));
  return {
    code,
    name: `演示基金${code}`,
    company: '演示基金管理有限公司',
    typeText: '混合型-偏股',
    benchmark: '沪深300指数收益率×80%+中债总指数收益率×20%',
    start: '2017-05-18',
    tracks: null,
    onMarket: looksOnMarket(code),
    seed: { ann: 4 + rnd() * 12, vol: 18 + rnd() * 14, mdd: 30 + rnd() * 25 },
    tweaks: {},
    themeName: null,
  };
}

const INDUSTRY_POOL = {
  白酒: ['贵州茅台', '五粮液', '泸州老窖', '山西汾酒', '洋河股份', '古井贡酒', '今世缘', '迎驾贡酒', '口子窖', '舍得酒业'],
  医药: ['迈瑞医疗', '恒瑞医药', '药明康德', '爱尔眼科', '智飞生物', '片仔癀', '长春高新', '泰格医药', '凯莱英', '华东医药'],
  食品饮料: ['伊利股份', '海天味业', '双汇发展', '中炬高新', '安井食品', '涪陵榨菜', '洽洽食品', '桃李面包', '绝味食品', '妙可蓝多'],
  电子: ['立讯精密', '歌尔股份', '京东方A', '兆易创新', '韦尔股份', '北方华创', '中芯国际', '闻泰科技', '三安光电', '沪电股份'],
  电力设备: ['宁德时代', '阳光电源', '隆基绿能', '亿纬锂能', '汇川技术', '通威股份', '天合光能', '德业股份', '思源电气', '当升科技'],
  银行: ['招商银行', '兴业银行', '宁波银行', '平安银行', '工商银行', '建设银行', '农业银行', '江苏银行', '成都银行', '杭州银行'],
  非银金融: ['中国平安', '东方财富', '中信证券', '华泰证券', '中国太保', '国泰君安', '招商证券', '广发证券', '新华保险', '同花顺'],
  计算机: ['金山办公', '恒生电子', '用友网络', '科大讯飞', '广联达', '深信服', '中科曙光', '海康威视', '大华股份', '启明星辰'],
  汽车: ['比亚迪', '长城汽车', '长安汽车', '福耀玻璃', '拓普集团', '华域汽车', '均胜电子', '伯特利', '爱柯迪', '新泉股份'],
  有色金属: ['紫金矿业', '洛阳钼业', '华友钴业', '赣锋锂业', '中国铝业', '山东黄金', '北方稀土', '天齐锂业', '云铝股份', '中金岭南'],
};

function pickIndustries(rnd, themeName, driftTo) {
  const names = Object.keys(INDUSTRY_POOL);
  const chosen = [];
  if (themeName && INDUSTRY_POOL[themeName]) chosen.push(themeName);
  if (driftTo && INDUSTRY_POOL[driftTo] && !chosen.includes(driftTo)) chosen.push(driftTo);
  while (chosen.length < 5) {
    const n = names[Math.floor(rnd() * names.length)];
    if (!chosen.includes(n)) chosen.push(n);
  }
  return chosen;
}

/** 生成 4 期持仓（最近期在前） */
function genHoldings(meta, fundType, navLast) {
  const rnd = mulberry32(hashSeed(`${meta.code}-hold`));
  const isBondLike = fundType === TYPE.BOND || fundType === TYPE.MONEY;
  const periods = [];
  const lastDate = navLast;
  // 报告期：按季度回溯
  const y = Number(String(lastDate).slice(0, 4));
  const m = Number(String(lastDate).slice(5, 7));
  let q = Math.floor((m - 1) / 3) + 1;
  let yy = y;
  // 最新可得报告期通常为上一个季度
  q -= 1;
  if (q === 0) {
    q = 4;
    yy -= 1;
  }
  const qEnd = { 1: '-03-31', 2: '-06-30', 3: '-09-30', 4: '-12-31' };

  for (let i = 0; i < 4; i += 1) {
    const period = `${yy}Q${q}`;
    const asOf = `${yy}${qEnd[q]}`;
    const drifting = meta.tweaks?.styleDrift && i === 0;
    const inds = pickIndustries(mulberry32(hashSeed(`${meta.code}-ind-${i}`)), meta.themeName, drifting ? '电子' : null);
    let remain = isBondLike ? 12 : 78 + rnd() * 12;
    const industries = [];
    for (let k = 0; k < inds.length; k += 1) {
      const share = k === 0 ? remain * (drifting ? 0.28 : 0.46) : remain * (0.34 - k * 0.05);
      industries.push({ name: inds[k], pct: Math.round(share * 100) / 100 });
    }
    if (drifting) industries.push({ name: '电子', pct: Math.round(remain * 0.31 * 100) / 100 });

    const stocks = [];
    if (!isBondLike) {
      let acc = 0;
      for (let k = 0; k < 10; k += 1) {
        const pool = INDUSTRY_POOL[industries[k % industries.length].name];
        const nm = pool[(k * 3 + i) % pool.length];
        const pct = Math.round((9.6 - k * 0.72 + rnd() * 0.5) * 100) / 100;
        acc += pct;
        stocks.push({
          code: String(600000 + ((hashSeed(nm) % 3000) | 0)),
          name: nm,
          pct,
          chg: Math.round((rnd() * 2 - 1) * 180) / 100,
        });
      }
      periods.push({
        period,
        asOf,
        stocks,
        industries,
        top10Pct: Math.round(acc * 100) / 100,
        assetAlloc: {
          stock: Math.round((acc + 20 + rnd() * 8) * 100) / 100,
          bond: Math.round(rnd() * 6 * 100) / 100,
          cash: Math.round((3 + rnd() * 5) * 100) / 100,
        },
        turnoverPct: Math.round((meta.tweaks?.highTurnover ? 420 + rnd() * 200 : 120 + rnd() * 160) * 10) / 10,
      });
    } else {
      periods.push({
        period,
        asOf,
        stocks: [],
        industries,
        top10Pct: Math.round((55 + rnd() * 30) * 100) / 100,
        assetAlloc: {
          stock: fundType === TYPE.BOND ? Math.round(rnd() * 8 * 100) / 100 : 0,
          bond: Math.round((88 + rnd() * 8) * 100) / 100,
          cash: Math.round((2 + rnd() * 6) * 100) / 100,
        },
        turnoverPct: Math.round((80 + rnd() * 120) * 10) / 10,
      });
    }
    q -= 1;
    if (q === 0) {
      q = 4;
      yy -= 1;
    }
  }
  return periods;
}

function genManagers(meta, fundType, navLast) {
  const rnd = mulberry32(hashSeed(`${meta.code}-mgr`));
  const tw = meta.tweaks || {};
  const surnames = ['张', '李', '王', '刘', '陈', '杨', '赵', '周', '吴', '徐'];
  const givens = ['明远', '思齐', '博', '晨', '雅雯', '君毅', '文彬', '子墨', '灏', '若薇'];
  const nameOf = (i) =>
    `${surnames[(hashSeed(meta.code) + i * 7) % surnames.length]}${givens[(hashSeed(meta.code) + i * 5) % givens.length]}`;

  const list = [];
  if (tw.newManagerMonths) {
    const startCur = dates.addMonths(navLast, -tw.newManagerMonths);
    list.push({
      name: nameOf(0),
      startDate: startCur,
      endDate: null,
      current: true,
      workYears: Math.round((1.5 + rnd()) * 10) / 10,
      fundCount: 2,
      aumYi: Math.round(18 + rnd() * 20),
      isNew: true,
      otherFunds: [],
    });
    // 前两任（频繁更换场景）
    let cursor = startCur;
    const spans = tw.frequentChange ? [14, 11, 16] : [40, 36];
    for (let i = 0; i < spans.length; i += 1) {
      const end = cursor;
      const st = dates.addMonths(cursor, -spans[i]);
      list.push({
        name: nameOf(i + 1),
        startDate: st,
        endDate: end,
        current: false,
        workYears: Math.round((4 + rnd() * 5) * 10) / 10,
        fundCount: 3,
        aumYi: Math.round(30 + rnd() * 60),
        isNew: false,
        otherFunds: [],
      });
      cursor = st;
    }
    return list;
  }

  const tenureYears =
    fundType === TYPE.INDEX_EQUITY || fundType === TYPE.MONEY || fundType === TYPE.COMMODITY
      ? 3.5 + rnd() * 4
      : 2.5 + rnd() * 5;
  const startCur = dates.addMonths(navLast, -Math.round(tenureYears * 12));
  const fundCount =
    fundType === TYPE.INDEX_EQUITY || fundType === TYPE.COMMODITY
      ? 8 + Math.floor(rnd() * 14)
      : 2 + Math.floor(rnd() * 5);
  list.push({
    name: nameOf(0),
    startDate: startCur < meta.start ? meta.start : startCur,
    endDate: null,
    current: true,
    workYears: Math.round((tenureYears + 2 + rnd() * 4) * 10) / 10,
    fundCount,
    aumYi: Math.round(20 + rnd() * 260),
    isNew: false,
    otherFunds: Array.from({ length: Math.min(3, fundCount - 1) }, (_, i) => ({
      code: String(100000 + ((hashSeed(`${meta.code}-of${i}`) % 800000) | 0)),
      name: `${meta.company.slice(0, 3)}代表作${i + 1}号混合`,
      return3y: Math.round((rnd() * 60 - 12) * 10) / 10,
      peerPct: Math.round(rnd() * 100),
    })),
  });
  if (dates.diffDays(startCur, meta.start) > 400) {
    list.push({
      name: nameOf(1),
      startDate: meta.start,
      endDate: startCur,
      current: false,
      workYears: Math.round((6 + rnd() * 5) * 10) / 10,
      fundCount: 4,
      aumYi: Math.round(40 + rnd() * 120),
      isNew: false,
      otherFunds: [],
    });
  }
  return list;
}

function genNotices(meta, fundType, navLast) {
  const rnd = mulberry32(hashSeed(`${meta.code}-notice`));
  const tw = meta.tweaks || {};
  const out = [];
  const add = (monthsAgo, title, category) =>
    out.push({ date: dates.addMonths(navLast, -monthsAgo), title, category });

  if (tw.clearingNotice) {
    add(0.4, `关于${meta.name}可能触发基金合同终止情形的提示性公告`, 'clearing');
    add(2, `关于${meta.name}资产净值连续低于5000万元的提示性公告`, 'clearing');
  }
  if (tw.managerLeftNotice) {
    add(Math.max(1, tw.newManagerMonths || 2), `关于${meta.name}基金经理变更的公告`, 'manager_change');
  }
  if (tw.purchaseLimited) {
    add(0.6, `关于${meta.name}调整大额申购限额的公告`, 'purchase_limit');
    add(1.2, `关于${meta.name}二级市场交易价格溢价风险提示的公告`, 'premium_risk');
  }
  if (tw.styleDrift) {
    add(3, `关于${meta.name}基金合同修订的公告`, 'contract_change');
  }
  add(1 + rnd() * 2, `${meta.name}${new Date().getFullYear()}年第二季度报告提示性公告`, 'report');
  add(4 + rnd() * 2, `关于${meta.name}参加部分销售机构费率优惠活动的公告`, 'fee');
  add(7 + rnd() * 3, `关于${meta.name}分红的公告`, 'dividend');
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * 生成一只基金的完整数据包
 * @param {string} code
 * @returns {object} bundle（结构与真实数据源一致）
 */
function buildBundle(code) {
  const meta = baseMetaOf(code);
  const cls = classify({ typeText: meta.typeText, name: meta.name, code });
  const fundType = cls.type || TYPE.EQUITY_ACTIVE;
  const tw = meta.tweaks || {};

  const today = dates.todayStr();
  // 演示数据最多回溯 8 年，兼顾覆盖度与体积
  const start = dates.diffDays(today, meta.start) > 8 * 365 ? dates.addYears(today, -8) : meta.start;
  const days = tradingDays(start, today);
  const n = days.length;

  // 1) 基准/标的指数
  const benchVol = Math.max(0.5, meta.seed.vol * 0.92);
  const benchAnn = fundType === TYPE.INDEX_EQUITY || fundType === TYPE.COMMODITY ? meta.seed.ann + 1.1 : meta.seed.ann - 2.4;
  const benchRets = genDailyReturns(n, { ann: benchAnn, vol: benchVol, seed: hashSeed(`bench-${meta.benchmark}-${meta.tracks || ''}`) });

  // 2) 本基金：以基准为骨架叠加 beta / alpha / 特异波动
  const isPassive = fundType === TYPE.INDEX_EQUITY || fundType === TYPE.COMMODITY;
  const beta = isPassive ? 0.995 : fundType === TYPE.BOND ? 0.85 : 0.9;
  const idioVol = isPassive ? 0.0009 : fundType === TYPE.MONEY ? 0.00002 : 0.006;
  const alphaDaily = (meta.seed.ann - benchAnn) / 100 / 252;
  const rndF = mulberry32(hashSeed(`${code}-fund`));
  const nrmF = normalGen(rndF);
  const fundRets = benchRets.map((r) => beta * r + alphaDaily + idioVol * nrmF());

  const navAdj = seriesFromReturns(days, fundRets, 1);
  // 单位净值：叠加分红（每年一次，权益类）造成的跳变，复权净值不受影响
  const dividends = [];
  const unit = [];
  let divFactor = 1;
  for (let i = 0; i < navAdj.length; i += 1) {
    const d = navAdj[i].date;
    const isDivDay = !isPassive && fundType !== TYPE.MONEY && d.slice(5) === '07-15';
    if (isDivDay && i > 20) {
      const perUnit = Math.round(navAdj[i].value * divFactor * 0.06 * 1e4) / 1e4;
      dividends.push({ date: d, perUnit });
      divFactor *= 1 - 0.06;
    }
    unit.push({ date: d, value: Math.round(navAdj[i].value * divFactor * 1e4) / 1e4 });
  }
  const nav = navAdj.map((p, i) => ({
    date: p.date,
    unit: unit[i].value,
    acc: Math.round(p.value * 1e4) / 1e4, // 累计净值（含分红）
    adj: p.value, // 复权净值（计算一律用它）
    dailyPct: i === 0 ? 0 : Math.round((p.value / navAdj[i - 1].value - 1) * 1e6) / 1e4,
  }));

  // 3) 同类平均与宽基
  const peerRets = benchRets.map((r, i) => 0.88 * r + (isPassive ? -0.00002 : 0.000012) + 0.0025 * nrmF() * (i % 3 === 0 ? 1 : 0.5));
  const peerAvg = seriesFromReturns(days, peerRets, 1);
  const csiRets = genDailyReturns(n, { ann: 5.2, vol: 19, seed: hashSeed('csi300-market') });
  const csi300 = seriesFromReturns(days, csiRets, 1);
  const benchSeries = seriesFromReturns(days, benchRets, 1);

  // 4) 规模序列（近 8 期）
  const rndS = mulberry32(hashSeed(`${code}-scale`));
  const scale = [];
  let baseScale = tw.tinyScale ? 0.9 : fundType === TYPE.MONEY ? 900 + rndS() * 1200 : 8 + rndS() * 160;
  for (let i = 7; i >= 0; i -= 1) {
    const asOf = dates.addMonths(nav[nav.length - 1].date, -i * 3);
    let v = baseScale * (0.85 + rndS() * 0.4);
    if (tw.tinyScale) v = Math.max(0.18, 1.6 - (7 - i) * 0.2);
    if (tw.shrink && i < 2) v *= 0.55;
    scale.push({ asOf, valueYi: Math.round(v * 100) / 100 });
  }

  // 5) 持有人结构
  const rndH = mulberry32(hashSeed(`${code}-holder`));
  const institution = tw.institution ?? (fundType === TYPE.BOND ? 55 + rndH() * 35 : 8 + rndH() * 30);
  const holders = {
    asOf: scale[scale.length - 1].asOf,
    institutionPct: Math.round(institution * 100) / 100,
    individualPct: Math.round((100 - institution) * 100) / 100,
    singleTopPct: tw.singleHolder ?? Math.round((2 + rndH() * 14) * 100) / 100,
    holderCount: Math.round(2000 + rndH() * 400000),
  };

  // 6) 费率
  const feeByType = {
    [TYPE.EQUITY_ACTIVE]: { management: 1.2, custody: 0.2, salesServiceC: 0.4, purchase: 0.15, purchaseOriginal: 1.5 },
    [TYPE.INDEX_EQUITY]: { management: 0.5, custody: 0.1, salesServiceC: 0.2, purchase: 0.1, purchaseOriginal: 1.2 },
    [TYPE.BOND]: { management: 0.6, custody: 0.15, salesServiceC: 0.3, purchase: 0.08, purchaseOriginal: 0.8 },
    [TYPE.HYBRID_BOND]: { management: 0.8, custody: 0.18, salesServiceC: 0.35, purchase: 0.08, purchaseOriginal: 1.0 },
    [TYPE.QDII]: { management: 0.8, custody: 0.26, salesServiceC: 0.3, purchase: 0.12, purchaseOriginal: 1.2 },
    [TYPE.FOF]: { management: 0.8, custody: 0.2, salesServiceC: 0.4, purchase: 0.1, purchaseOriginal: 1.2 },
    [TYPE.MONEY]: { management: 0.25, custody: 0.05, salesServiceC: 0.25, purchase: 0, purchaseOriginal: 0 },
    [TYPE.COMMODITY]: { management: 0.5, custody: 0.1, salesServiceC: 0.2, purchase: 0.06, purchaseOriginal: 0.8 },
  };
  const f = feeByType[fundType] || feeByType[TYPE.EQUITY_ACTIVE];
  const shareClass = shareClassOf(meta.name);
  const isC = shareClass === 'C';
  const fees = {
    management: f.management,
    custody: f.custody,
    salesService: isC ? f.salesServiceC : 0,
    purchase: isC ? 0 : f.purchase,
    purchaseOriginal: isC ? 0 : f.purchaseOriginal,
    redeemTiers: isC
      ? [
          { maxDays: 7, ratePct: 1.5 },
          { maxDays: 30, ratePct: 0.5 },
          { maxDays: null, ratePct: 0 },
        ]
      : [
          { maxDays: 7, ratePct: 1.5 },
          { maxDays: 365, ratePct: 0.5 },
          { maxDays: 730, ratePct: 0.25 },
          { maxDays: null, ratePct: 0 },
        ],
    asOf: today,
  };

  // 7) 持仓估值（重仓加权 PE/PB 及历史分位序列）
  const rndV = mulberry32(hashSeed(`${code}-val`));
  const peBase = fundType === TYPE.BOND || fundType === TYPE.MONEY ? null : 14 + rndV() * 34;
  let peSeries = [];
  if (peBase !== null) {
    const peRets = genDailyReturns(Math.min(n, 1250), { ann: 1.2, vol: 22, seed: hashSeed(`${code}-pe`) });
    const s = seriesFromReturns(days.slice(-peRets.length), peRets, peBase);
    peSeries = s.map((p) => ({ date: p.date, pe: Math.round(p.value * 100) / 100 }));
  }
  const valuation = {
    asOf: nav[nav.length - 1].date,
    holdingPeriod: null, // 由 datasource 填充为持仓报告期
    pe: peSeries.length ? peSeries[peSeries.length - 1].pe : null,
    pb: peBase === null ? null : Math.round((1.4 + rndV() * 4.2) * 100) / 100,
    peSeries,
    industryValuation: [],
    note: '基于最新披露的十大重仓股加权计算，存在披露滞后',
  };

  // 8) 场内行情与折溢价
  let onMarketQuote = null;
  if (meta.onMarket) {
    const last = nav[nav.length - 1];
    const premium = tw.premium ?? Math.round((rndV() * 2.4 - 1.0) * 100) / 100;
    const premiumSeries = days.slice(-250).map((d, i) => ({
      date: d,
      premiumPct: Math.round(((tw.premium ? tw.premium * (0.5 + i / 500) : rndV() * 2 - 1) + Math.sin(i / 9) * 0.4) * 100) / 100,
    }));
    onMarketQuote = {
      asOf: last.date,
      nav: last.unit,
      price: Math.round(last.unit * (1 + premium / 100) * 1e4) / 1e4,
      premiumPct: premium,
      premiumSeries,
      turnoverWan: Math.round((tw.premium ? 8000 : 300 + rndV() * 40000) * 10) / 10,
    };
  }

  // 9) 债券专项
  let bondDetail = null;
  if (fundType === TYPE.BOND || fundType === TYPE.HYBRID_BOND) {
    bondDetail = {
      asOf: scale[scale.length - 1].asOf,
      durationYear: Math.round((1.2 + rndV() * 3.4) * 100) / 100,
      leveragePct: tw.leverage ?? Math.round((105 + rndV() * 30) * 10) / 10,
      convertiblePct: Math.round(rndV() * 18 * 10) / 10,
      ratingDist: [
        { rating: 'AAA', pct: Math.round((tw.lowRating ? 45 : 78) * 10) / 10 },
        { rating: 'AA+', pct: Math.round((tw.lowRating ? 13 : 15) * 10) / 10 },
        { rating: 'AA及以下', pct: Math.round((tw.lowRating ?? 7) * 10) / 10 },
      ],
      lowRatingPct: tw.lowRating ?? 7,
      defaultedBonds: [],
    };
  }

  // 10) 市场环境
  const market = {
    asOf: nav[nav.length - 1].date,
    csi300Percentile: Math.round(38 + mulberry32(hashSeed('market-env'))() * 40),
    sentiment: '中性',
    bond10yPct: 2.28,
    usdCny: 7.14,
  };

  const purchaseStatus = tw.purchaseLimited ? '限大额' : tw.clearingNotice ? '暂停申购' : '开放申购';

  // 11) 同类排名日序列：以「本基金 vs 同类平均」的近一年累计超额映射为排名
  const rankSeries = [];
  const rankTotal = fundType === TYPE.MONEY ? 780 : fundType === TYPE.BOND ? 2600 : 3900;
  for (let i = 250; i < nav.length; i += 5) {
    const f = nav[i].adj / nav[i - 250].adj - 1;
    const p = peerAvg[i].value / peerAvg[i - 250].value - 1;
    // 超额 +30% → 排名前 3%；超额 -30% → 排名后 3%
    const pos = Math.min(0.97, Math.max(0.03, 0.5 - (f - p) * 1.6));
    rankSeries.push({ date: nav[i].date, rank: Math.max(1, Math.round(rankTotal * pos)), total: rankTotal });
  }

  // 12) 份额与资产配置（与规模序列同期）
  const shares = scale.map((s, i) => ({
    asOf: s.asOf,
    purchaseYi: Math.round(s.valueYi * (0.06 + rndS() * 0.2) * 100) / 100,
    redeemYi: Math.round(s.valueYi * (0.06 + rndS() * 0.22) * 100) / 100,
    totalSharesYi: Math.round((s.valueYi / Math.max(0.2, nav[nav.length - 1].unit)) * 100) / 100,
  }));
  const holdingsList = genHoldings(meta, fundType, nav[nav.length - 1].date);
  const assetAlloc = holdingsList
    .slice()
    .reverse()
    .map((h) => ({
      asOf: h.asOf,
      stock: h.assetAlloc.stock,
      bond: h.assetAlloc.bond,
      cash: h.assetAlloc.cash,
      netAssetYi: scale[scale.length - 1].valueYi,
    }));

  // 13) 经理任期口径（与真实数据源结构对齐：任期收益、任期同类/沪深300 对照）
  const navAt = (d) => {
    for (let i = nav.length - 1; i >= 0; i -= 1) if (nav[i].date <= d) return nav[i];
    return nav[0];
  };
  const seriesAt = (arr, d) => {
    for (let i = arr.length - 1; i >= 0; i -= 1) if (arr[i].date <= d) return arr[i];
    return arr[0];
  };
  const lastNav = nav[nav.length - 1];
  const managerList = genManagers(meta, fundType, lastNav.date).map((m) => {
    const st = m.startDate;
    const en = m.endDate || lastNav.date;
    const a = navAt(st);
    const b = navAt(en);
    const pa = seriesAt(peerAvg, st);
    const pb = seriesAt(peerAvg, en);
    const ha = seriesAt(csi300, st);
    const hb = seriesAt(csi300, en);
    const spanDays = Math.max(1, dates.diffDays(en, st) || 1);
    return {
      ...m,
      tenureYears: Math.round((spanDays / 365) * 10) / 10,
      tenureSpanText: `${Math.floor(spanDays / 365)}年又${spanDays % 365}天`,
      tenureReturnPct: Math.round((b.adj / a.adj - 1) * 1e4) / 100,
      tenurePeerPct: Math.round((pb.value / pa.value - 1) * 1e4) / 100,
      tenureHs300Pct: Math.round((hb.value / ha.value - 1) * 1e4) / 100,
      bio: null,
    };
  });
  const currentManagers = managerList.filter((m) => m.current);
  const pastManagerTerms = managerList
    .filter((m) => !m.current)
    .map((m) => ({
      name: m.name,
      startDate: m.startDate,
      endDate: m.endDate,
      current: false,
      tenureReturnPct: m.tenureReturnPct,
      tenureSpanText: m.tenureSpanText,
    }));

  return {
    profile: {
      code,
      name: meta.name,
      fullName: `${meta.name}型证券投资基金`,
      company: meta.company,
      typeText: meta.typeText,
      fundType,
      typeReason: cls.reason,
      shareClass,
      establishDate: meta.start,
      benchmark: meta.benchmark,
      tracks: meta.tracks,
      trackIndexCode: null,
      onMarket: Boolean(meta.onMarket),
      purchaseStatus,
      purchaseStatusMark: tw.purchaseLimited ? `单日累计购买上限${tw.purchaseLimited}元。` : '',
      redeemStatus: tw.clearingNotice ? '暂停赎回' : '开放赎回',
      largePurchaseLimit: tw.purchaseLimited || null,
      largePurchaseLimitText: tw.purchaseLimited ? `单日累计购买上限${tw.purchaseLimited}元` : '',
      minHoldDays: fundType === TYPE.FOF ? 90 : 0,
      riskLevel: fundType === TYPE.MONEY ? '低风险' : fundType === TYPE.BOND ? '中低风险' : '中高风险',
      redeemArrivalText: fundType === TYPE.QDII ? '7-10个工作日' : '2-4个工作日',
      scopeNote: meta.themeName
        ? `本基金主要投资于${meta.themeName}相关行业上市公司股票，投资于该行业股票的比例不低于非现金资产的80%`
        : '本基金股票资产占基金资产的比例为60%-95%',
      scaleYi: scale[scale.length - 1].valueYi,
      scaleAsOf: scale[scale.length - 1].asOf,
      navDate: nav[nav.length - 1].date,
      unitNav: nav[nav.length - 1].unit,
      accNav: nav[nav.length - 1].acc,
      dayChangePct: nav[nav.length - 1].dailyPct,
      asOf: today,
    },
    nav,
    dividends,
    benchmarkSeries: benchSeries,
    peerAvgSeries: peerAvg,
    csi300Series: csi300,
    selfCumSeries: [],
    periodStats: null, // 演示数据不提供阶段口径，由计算层从序列自行推导
    rankSeries,
    scale,
    shares,
    assetAlloc,
    holders,
    managers: currentManagers,
    pastManagerTerms,
    holdings: holdingsList,
    fees,
    notices: genNotices(meta, fundType, nav[nav.length - 1].date),
    valuation: { ...valuation, holdingPeriod: holdingsList[0].period },
    onMarketQuote,
    bondDetail,
    market,
    crossCheck: null, // 演示数据无第三方公布值可交叉校验
  };
}

/** 演示搜索 */
function search(q, limit = 8) {
  const local = dict.search(q, limit);
  const extra = Object.entries(SCENARIOS)
    .filter(([code, s]) => code.includes(q) || s.name.includes(q) || String(q).toLowerCase() === 'demo')
    .slice(0, 3)
    .map(([code, s]) => ({ code, name: s.name, typeText: s.typeText, company: s.company, onMarket: Boolean(s.onMarket) }));
  return [...local, ...extra].slice(0, limit);
}

/** 演示热门（按内置字典顺序，非收益率排序，符合 F1-9） */
function hot(limit = 12) {
  return dict
    .all()
    .slice(0, limit)
    .map((f) => ({ code: f.code, name: f.name, typeText: f.typeText, company: f.company }));
}

module.exports = { buildBundle, search, hot, SCENARIOS, tradingDays, hashSeed, mulberry32 };
