'use strict';
/**
 * 天天基金 / 东方财富 公开接口适配器
 *
 * 每个方法独立可失败（F2-21：降级而非整体失败），返回 { ok, data, source, asOf } 或 { ok:false, error }
 * 所有请求走 utils/http 的安全客户端（主机白名单 + DNS 后 IP 校验 + 不跟随重定向）
 *
 * 已验证的数据来源：
 *  - fundmobapi.eastmoney.com/FundMNewApi/*      结构化 JSON：基础信息、阶段业绩与同类排名、持仓、行业配置
 *  - fund.eastmoney.com/pingzhongdata/{code}.js  净值全序列、规模、持有人结构、现任经理、资产配置、同类排名日序列
 *  - fundf10.eastmoney.com/jbgk_{code}.html      基金全称、业绩基准、跟踪标的、管理费/托管费/销售服务费、投资范围
 *  - fundf10.eastmoney.com/jjfl_{code}.html      赎回费率阶梯
 *  - api.fund.eastmoney.com/f10/JJGG             公告标题与日期
 *  - push2.eastmoney.com                         场内行情（折溢价）、指数行情
 */
const http = require('../utils/http');
const cache = require('../utils/cache');
const dates = require('../utils/dates');
const { toNum, round } = require('../utils/num');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const MOB = 'https://fundmobapi.eastmoney.com/FundMNewApi';
const MOB_PARAMS = 'deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&appType=ttjj';
const REF_MOB = { Referer: 'https://fundmobapi.eastmoney.com/' };
const REF_F10 = { Referer: 'https://fundf10.eastmoney.com/' };
const REF_FUND = { Referer: 'https://fund.eastmoney.com/' };

const ok = (data, source, asOf) => ({ ok: true, data, source, asOf: asOf || null });
const fail = (error, source) => ({ ok: false, data: null, error: String(error && error.message ? error.message : error), source });

/* ============================== 搜索 ============================== */

async function search(query, limit = 8) {
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?callback=cb&m=1&key=${encodeURIComponent(query)}`;
  try {
    const json = await cache.wrap(`tt:search:${query}`, cache.TTL.SEARCH, () => http.safeGetJson(url, { headers: REF_FUND }));
    const rows = Array.isArray(json?.Datas) ? json.Datas : [];
    const data = rows
      .filter((r) => r && r.CODE && String(r.CATEGORYDESC || '').includes('基金'))
      .slice(0, limit)
      .map((r) => {
        const b = r.FundBaseInfo || {};
        return {
          code: String(r.CODE),
          name: String(r.NAME || b.SHORTNAME || ''),
          typeText: String(b.FTYPE || ''),
          company: String(b.JJGS || ''),
          manager: String(b.JJJL || ''),
          navDate: b.FSRQ || null,
          nav: toNum(b.DWJZ),
          dayChangePct: toNum(b.RZDF),
          return1y: toNum(b.SYL_1N),
          pinyin: String(r.JP || ''),
          onMarket: /LOF|ETF/i.test(String(r.NAME || '')),
        };
      });
    return ok(data, 'eastmoney:suggest');
  } catch (e) {
    return fail(e, 'eastmoney:suggest');
  }
}

/* ========================= 基础信息（JSON） ========================= */

async function basicInfo(code) {
  const url = `${MOB}/FundMNBasicInformation?FCODE=${code}&${MOB_PARAMS}`;
  try {
    const json = await cache.wrap(`tt:basic:${code}`, cache.TTL.PROFILE, () => http.safeGetJson(url, { headers: REF_MOB }));
    const d = json?.Datas;
    if (!d || !d.FCODE) throw new Error('基础信息为空');
    const data = {
      code: String(d.FCODE),
      name: String(d.SHORTNAME || ''),
      typeText: String(d.FTYPE || ''),
      company: String(d.JJGS || ''),
      managerName: String(d.JJJL || ''),
      establishDate: d.ESTABDATE && d.ESTABDATE !== '--' ? String(d.ESTABDATE) : null,
      navDate: d.FSRQ && d.FSRQ !== '--' ? String(d.FSRQ) : null,
      unitNav: toNum(d.DWJZ),
      accNav: toNum(d.LJJZ),
      dayChangePct: toNum(d.RZDF),
      purchaseStatus: String(d.SGZT || ''),
      purchaseStatusMark: String(d.SGZTMARK || ''),
      redeemStatus: String(d.SHZT || ''),
      largePurchaseLimitText: Array.isArray(d.TRADEMARKLIST) ? d.TRADEMARKLIST.join('；') : '',
      purchaseRatePct: toNum(String(d.RATE || '').replace('%', '')),
      purchaseRateOriginalPct: toNum(String(d.SOURCERATE || '').replace('%', '')),
      minPurchase: toNum(d.MINSG),
      maxPurchase: toNum(d.MAXSG),
      scaleYi: toNum(d.FEGM),
      scaleAsOf: d.FEGMRQ && d.FEGMRQ !== '--' ? String(d.FEGMRQ) : null,
      riskLevel: String(d.RISKLEVEL || ''),
      indexCode: d.INDEXCODE && d.INDEXCODE !== '--' ? String(d.INDEXCODE) : null,
      indexName: d.INDEXNAME && d.INDEXNAME !== '--' ? String(d.INDEXNAME) : null,
      isOnMarket: String(d.ISEXCHG || '0') === '1' || /LOF|ETF/i.test(String(d.SHORTNAME || '')),
      redeemArrivalText: String(d.YZBA || ''),
      // 东财公布的近 1 年指标，用于与本平台自算结果交叉校验（风险应对：净值复权错误）
      crossCheck: {
        sharpe1y: toNum(d.SHARP1),
        maxDrawdown1y: toNum(d.MAXRETRA1),
        stddev1y: toNum(d.STDDEV1),
        return1y: toNum(d.SYL_1N),
        return3y: toNum(d.SYL_3N),
        returnSinceStart: toNum(d.SYL_LN),
      },
    };
    return ok(data, 'eastmoney:mobapi', data.navDate);
  } catch (e) {
    return fail(e, 'eastmoney:mobapi');
  }
}

/* ================== 阶段业绩 + 同类排名（JSON） ================== */

const PERIOD_MAP = {
  Z: '1w',
  Y: '1m',
  '3Y': '3m',
  '6Y': '6m',
  '1N': '1y',
  '2N': '2y',
  '3N': '3y',
  '5N': '5y',
  JN: 'ytd',
  LN: 'since',
};

async function periodStats(code) {
  const url = `${MOB}/FundMNPeriodIncrease?FCODE=${code}&${MOB_PARAMS}`;
  try {
    const json = await cache.wrap(`tt:period:${code}`, cache.TTL.NAV, () => http.safeGetJson(url, { headers: REF_MOB }));
    const rows = Array.isArray(json?.Datas) ? json.Datas : [];
    if (!rows.length) throw new Error('阶段业绩为空');
    const data = {};
    for (const r of rows) {
      const key = PERIOD_MAP[String(r.title)];
      if (!key) continue;
      data[key] = {
        fundPct: toNum(r.syl),
        peerAvgPct: toNum(r.avg),
        hs300Pct: toNum(r.hs300),
        rank: toNum(r.rank),
        total: toNum(r.sc),
      };
    }
    return ok(data, 'eastmoney:mobapi');
  } catch (e) {
    return fail(e, 'eastmoney:mobapi');
  }
}

/* ============ pingzhongdata：净值全序列与多项面板数据 ============ */

function grabVar(text, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*([\\s\\S]*?);\\s*(?:/\\*|var\\s|$)`);
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    // 单引号数组（swithSameType）不做解析，其余均为合法 JSON
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function pingzhong(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
  try {
    const text = await cache.wrap(`tt:pz:${code}`, cache.TTL.NAV, () =>
      http.safeGetText(url, { headers: REF_FUND, timeoutMs: 15000 })
    );
    const nameM = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
    const isMoneyFund = /var\s+ishb\s*=\s*true/.test(text);
    const netWorth = grabVar(text, 'Data_netWorthTrend');

    const nav = [];
    const dividends = [];

    if (isMoneyFund) {
      /**
       * 货币基金没有净值序列，pingzhongdata 提供「每万份收益」与「7日年化」。
       * 用每万份收益（元/万份/日）换算日收益率：dailyPct = income / 10000 * 100，
       * 再链式累乘得到等价的复权净值，使下游回撤/波动/滚动持有等计算完全复用同一套逻辑。
       */
      const mci = grabVar(text, 'Data_millionCopiesIncome');
      const seven = grabVar(text, 'Data_sevenDaysYearIncome');
      if (!Array.isArray(mci) || mci.length < 20) throw new Error('货币基金万份收益序列为空');
      let adj = 1;
      for (let i = 0; i < mci.length; i += 1) {
        const date = dates.fmt(new Date(mci[i][0]));
        if (!date) continue;
        const income = toNum(mci[i][1]);
        const dailyPct = income === null ? 0 : round((income / 10000) * 100, 6);
        adj *= 1 + dailyPct / 100;
        nav.push({ date, unit: 1, acc: round(adj, 8), adj: round(adj, 8), dailyPct, millionIncome: income });
      }
      const sevenMap = new Map(
        (Array.isArray(seven) ? seven : []).map((x) => [dates.fmt(new Date(x[0])), toNum(x[1])])
      );
      for (const p of nav) p.sevenDayYieldPct = sevenMap.get(p.date) ?? null;
    } else {
      if (!Array.isArray(netWorth) || netWorth.length < 20) throw new Error('净值序列为空或过短');
      // 复权净值：用日增长率(equityReturn，已含分红再投)链式相乘，避免分红/拆分导致的收益失真
      let adj = 1;
      for (let i = 0; i < netWorth.length; i += 1) {
        const p = netWorth[i];
        const date = dates.fmt(new Date(p.x));
        if (!date) continue;
        const r = toNum(p.equityReturn);
        if (i > 0 && r !== null) adj *= 1 + r / 100;
        nav.push({ date, unit: toNum(p.y), acc: null, adj: round(adj, 8), dailyPct: r });
        const um = String(p.unitMoney || '').trim();
        if (um) {
          const per = toNum((um.match(/([\d.]+)/) || [])[1]);
          dividends.push({ date, text: um, perUnit: per });
        }
      }
      // 累计净值
      const acWorth = grabVar(text, 'Data_ACWorthTrend');
      if (Array.isArray(acWorth)) {
        const map = new Map(acWorth.map((x) => [dates.fmt(new Date(x[0])), toNum(x[1])]));
        for (const p of nav) p.acc = map.get(p.date) ?? null;
      }
    }
    if (nav.length < 20) throw new Error('净值序列过短');

    // 规模
    const fs = grabVar(text, 'Data_fluctuationScale');
    const scale = [];
    if (fs && Array.isArray(fs.categories)) {
      fs.categories.forEach((c, i) => {
        scale.push({ asOf: String(c), valueYi: toNum(fs.series?.[i]?.y), momPct: toNum(fs.series?.[i]?.mom) });
      });
    }

    // 持有人结构
    const hs = grabVar(text, 'Data_holderStructure');
    let holders = null;
    if (hs && Array.isArray(hs.categories) && hs.categories.length) {
      const pick = (nm) => hs.series?.find((s) => String(s.name).includes(nm))?.data || [];
      const inst = pick('机构');
      const indiv = pick('个人');
      const inner = pick('内部');
      const last = hs.categories.length - 1;
      holders = {
        asOf: String(hs.categories[last]),
        institutionPct: toNum(inst[last]),
        individualPct: toNum(indiv[last]),
        internalPct: toNum(inner[last]),
        singleTopPct: null, // 单一持有人占比需定期报告全文，公开接口不提供
        holderCount: null,
        history: hs.categories.map((c, i) => ({ asOf: String(c), institutionPct: toNum(inst[i]) })),
      };
    }

    // 资产配置
    const aa = grabVar(text, 'Data_assetAllocation');
    const assetAlloc = [];
    if (aa && Array.isArray(aa.categories)) {
      const pick = (nm) => aa.series?.find((s) => String(s.name).includes(nm))?.data || [];
      const st = pick('股票');
      const bd = pick('债券');
      const csh = pick('现金');
      const na = pick('净资产');
      aa.categories.forEach((c, i) => {
        assetAlloc.push({
          asOf: String(c),
          stock: toNum(st[i]),
          bond: toNum(bd[i]),
          cash: toNum(csh[i]),
          netAssetYi: toNum(na[i]),
        });
      });
    }

    // 申购赎回与总份额
    const bs = grabVar(text, 'Data_buySedemption');
    const shares = [];
    if (bs && Array.isArray(bs.categories)) {
      const pick = (nm) => bs.series?.find((s) => String(s.name).includes(nm))?.data || [];
      const buy = pick('申购');
      const red = pick('赎回');
      const tot = pick('总份额');
      bs.categories.forEach((c, i) => {
        shares.push({ asOf: String(c), purchaseYi: toNum(buy[i]), redeemYi: toNum(red[i]), totalSharesYi: toNum(tot[i]) });
      });
    }

    // 同类排名日序列
    const rt = grabVar(text, 'Data_rateInSimilarType');
    const rankSeries = Array.isArray(rt)
      ? rt
          .map((p) => ({ date: dates.fmt(new Date(p.x)), rank: toNum(p.y), total: toNum(p.sc) }))
          .filter((p) => p.date && p.rank !== null)
      : [];

    // 近期三线对照（本基金 / 同类平均 / 沪深300）
    // 注意：Data_grandTotal 的取值是**累计涨幅百分比且首日为 0**，不是净值。
    // 若原样当作净值序列使用，下游「区间收益 = 末值/初值-1」会除以 0 得到 NaN/Inf，
    // 图表上还会因 NaN 坐标污染画布导致折线渲染错乱（实测已发生）。
    // 因此统一换算成以 1 起步的等价净值序列，使全链路口径一致。
    const gt = grabVar(text, 'Data_grandTotal');
    let benchmarkSeries = [];
    let peerAvgSeries = [];
    let csi300Series = [];
    if (Array.isArray(gt)) {
      const toLevel = (arr) =>
        (arr || [])
          .map((x) => {
            const pct = toNum(x[1]);
            return { date: dates.fmt(new Date(x[0])), value: pct === null ? null : round(1 + pct / 100, 8) };
          })
          .filter((x) => x.date && isFinite(x.value) && x.value > 0);
      const find = (kw) => gt.find((s) => String(s.name).includes(kw));
      peerAvgSeries = toLevel(find('同类平均')?.data);
      csi300Series = toLevel(find('沪深300')?.data);
      // 第一条通常是本基金自身，仅作为对照基线（与净值序列同期，用于口径校验）
      benchmarkSeries = toLevel(gt[0]?.data);
    }

    // 现任基金经理
    const cm = grabVar(text, 'Data_currentFundManager');
    const managers = [];
    if (Array.isArray(cm)) {
      for (const m of cm) {
        const workYears = (() => {
          const s = String(m.workTime || '');
          const y = toNum((s.match(/(\d+)\s*年/) || [])[1]) || 0;
          const d = toNum((s.match(/又?\s*(\d+)\s*天/) || [])[1]) || 0;
          return round(y + d / 365, 1);
        })();
        const sizeText = String(m.fundSize || '');
        const profitSeries = m.profit?.series?.[0]?.data || [];
        managers.push({
          name: String(m.name || ''),
          startDate: null, // pingzhongdata 不含任职本基金起始日，由 managerHistory 补齐
          endDate: null,
          current: true,
          workYears,
          fundCount: toNum((sizeText.match(/(\d+)\s*只/) || [])[1]),
          aumYi: toNum((sizeText.match(/([\d.]+)\s*亿/) || [])[1]),
          // 面板给的任职收益带 4 位小数（如 -4.4612），统一收敛到 2 位，避免前端出现伪精度
          tenureReturnPct: round(toNum(profitSeries[0]?.y), 2),
          tenurePeerPct: round(toNum(profitSeries[1]?.y), 2),
          tenureHs300Pct: round(toNum(profitSeries[2]?.y), 2),
          otherFunds: [],
        });
      }
    }

    const feeRate = {
      purchaseRatePct: toNum(String((text.match(/var\s+fund_Rate\s*=\s*"([^"]*)"/) || [])[1] || '')),
      purchaseRateOriginalPct: toNum(String((text.match(/var\s+fund_sourceRate\s*=\s*"([^"]*)"/) || [])[1] || '')),
    };

    return ok(
      {
        name: nameM ? nameM[1] : null,
        nav,
        dividends,
        scale,
        holders,
        assetAlloc,
        shares,
        rankSeries,
        peerAvgSeries,
        csi300Series,
        selfCumSeries: benchmarkSeries,
        managers,
        feeRate,
      },
      'eastmoney:pingzhongdata',
      nav.length ? nav[nav.length - 1].date : null
    );
  } catch (e) {
    return fail(e, 'eastmoney:pingzhongdata');
  }
}

/* ================= 基本概况页（全称/基准/费率/范围） ================= */

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** 从「标签||值||」结构中取值 */
function fieldAfter(text, label, maxLen = 200) {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const seg = text.slice(i + label.length, i + label.length + maxLen);
  const parts = seg.split('|').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[0] : null;
}

async function archive(code) {
  const url = `https://fundf10.eastmoney.com/jbgk_${code}.html`;
  try {
    const html = await cache.wrap(`tt:jbgk:${code}`, cache.TTL.PROFILE, () =>
      http.safeGetText(url, { headers: REF_F10, timeoutMs: 12000 })
    );
    const text = htmlToText(html);
    const pctOf = (label) => {
      const v = fieldAfter(text, label);
      return v ? toNum(v.replace(/[^\d.]/g, '')) : null;
    };
    const estab = fieldAfter(text, '成立日期/规模');
    const data = {
      fullName: fieldAfter(text, '基金全称'),
      shortName: fieldAfter(text, '基金简称'),
      typeText: fieldAfter(text, '基金类型'),
      establishDate: estab ? String(estab).replace(/年|月/g, '-').replace(/日.*$/, '').replace(/-$/, '') : null,
      company: fieldAfter(text, '基金管理人'),
      custodian: fieldAfter(text, '基金托管人'),
      managerName: fieldAfter(text, '基金经理人'),
      dividendSinceStart: fieldAfter(text, '成立来分红'),
      managementFeePct: pctOf('管理费率'),
      custodyFeePct: pctOf('托管费率'),
      salesServiceFeePct: pctOf('销售服务费率'),
      purchaseFeeMaxPct: pctOf('最高申购费率'),
      redeemFeeMaxPct: pctOf('最高赎回费率'),
      benchmark: fieldAfter(text, '业绩比较基准', 300),
      tracks: fieldAfter(text, '跟踪标的', 120),
      // 投资目标里常含「年跟踪误差不超过X%」的合同约定
      trackingErrorLimitPct: (() => {
        const m = text.match(/年跟踪误差[^%]{0,12}?([\d.]+)\s*%/);
        return m ? toNum(m[1]) : null;
      })(),
      scopeNote: (() => {
        const i = text.indexOf('投资范围');
        if (i < 0) return null;
        const seg = text.slice(i + 4, i + 500).split('|').map((s) => s.trim()).filter((s) => s.length > 12);
        return seg.length ? seg[0].slice(0, 260) : null;
      })(),
    };
    if (!data.fullName && !data.benchmark) throw new Error('基本概况解析为空');
    return ok(data, 'eastmoney:jbgk');
  } catch (e) {
    return fail(e, 'eastmoney:jbgk');
  }
}

/* ===================== 费率页（赎回费阶梯） ===================== */

async function feeTiers(code) {
  const url = `https://fundf10.eastmoney.com/jjfl_${code}.html`;
  try {
    const html = await cache.wrap(`tt:jjfl:${code}`, cache.TTL.FEE, () =>
      http.safeGetText(url, { headers: REF_F10, timeoutMs: 12000 })
    );
    const text = htmlToText(html);
    const i = text.indexOf('赎回费率');
    if (i < 0) throw new Error('未找到赎回费率');
    const seg = text.slice(i, i + 900);
    const tiers = [];
    // 形如「小于7天||1.50%」「大于等于7天，小于365天||0.50%」「大于等于730天||0.00%」
    const re = /(小于\s*(\d+)\s*(天|年)|大于等于\s*(\d+)\s*(天|年)\s*[，,]\s*小于\s*(\d+)\s*(天|年)|大于等于\s*(\d+)\s*(天|年))[^%\d]{0,12}([\d.]+)\s*%/g;
    let m = re.exec(seg);
    while (m && tiers.length < 8) {
      const unitDays = (u, v) => (u === '年' ? Number(v) * 365 : Number(v));
      let minDays = 0;
      let maxDays = null;
      if (m[2]) maxDays = unitDays(m[3], m[2]);
      else if (m[6]) {
        minDays = unitDays(m[5], m[4]);
        maxDays = unitDays(m[7], m[6]);
      } else if (m[8]) {
        minDays = unitDays(m[9], m[8]);
        maxDays = null;
      }
      tiers.push({ minDays, maxDays, ratePct: toNum(m[10]) });
      m = re.exec(seg);
    }
    if (!tiers.length) throw new Error('赎回费率阶梯解析失败');
    return ok({ redeemTiers: tiers }, 'eastmoney:jjfl');
  } catch (e) {
    return fail(e, 'eastmoney:jjfl');
  }
}

/* ========================= 持仓与行业配置 ========================= */

async function positions(code) {
  const url = `${MOB}/FundMNInverstPosition?FCODE=${code}&${MOB_PARAMS}`;
  try {
    const json = await cache.wrap(`tt:pos:${code}`, cache.TTL.HOLDING, () => http.safeGetJson(url, { headers: REF_MOB }));
    const rows = json?.Datas?.fundStocks;
    if (!Array.isArray(rows) || !rows.length) throw new Error('持仓为空');
    const stocks = rows.map((r) => ({
      code: String(r.GPDM || ''),
      name: String(r.GPJC || ''),
      pct: toNum(r.JZBL),
      chg: toNum(r.PCTNVCHG),
      chgType: String(r.PCTNVCHGTYPE || ''),
      industry: String(r.INDEXNAME || ''),
      market: String(r.NEWTEXCH || r.TEXCH || ''),
    }));
    const top10Pct = round(
      stocks.slice(0, 10).reduce((s, x) => s + (x.pct || 0), 0),
      2
    );
    return ok({ stocks, top10Pct }, 'eastmoney:mobapi');
  } catch (e) {
    return fail(e, 'eastmoney:mobapi');
  }
}

async function sectorAlloc(code) {
  const url = `${MOB}/FundMNSectorAllocation?FCODE=${code}&${MOB_PARAMS}`;
  try {
    const json = await cache.wrap(`tt:sector:${code}`, cache.TTL.HOLDING, () => http.safeGetJson(url, { headers: REF_MOB }));
    const rows = Array.isArray(json?.Datas) ? json.Datas : [];
    if (!rows.length) throw new Error('行业配置为空');
    // 按报告期分组，最多保留 4 期
    const byPeriod = new Map();
    for (const r of rows) {
      const asOf = String(r.FSRQ || '');
      const pct = toNum(r.ZJZBL);
      if (!asOf || pct === null) continue;
      const nm = String(r.HYMC || '');
      if (!nm || nm === '合计') continue; // 接口会返回「合计」行，需剔除
      if (!byPeriod.has(asOf)) byPeriod.set(asOf, []);
      byPeriod.get(asOf).push({ name: nm, pct });
    }
    const periods = [...byPeriod.entries()]
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      .slice(0, 4)
      .map(([asOf, industries]) => ({
        asOf,
        industries: industries.filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10),
      }));
    return ok({ periods }, 'eastmoney:mobapi', periods[0]?.asOf);
  } catch (e) {
    return fail(e, 'eastmoney:mobapi');
  }
}

/* ==================== 基金经理变动一览（HTML） ==================== */

/**
 * 解析「基金经理变动一览」，得到每任经理的任职起止日与任职回报
 * 这是区分「基金历史业绩」与「现任经理任职期业绩」的关键数据（需求 C-2）
 */
async function managerHistory(code) {
  const url = `https://fundf10.eastmoney.com/jjjl_${code}.html`;
  try {
    const html = await cache.wrap(`tt:jjjl:${code}`, cache.TTL.MANAGER, () =>
      http.safeGetText(url, { headers: REF_F10, timeoutMs: 12000 })
    );
    const text = htmlToText(html);
    const a = text.indexOf('基金经理变动一览');
    if (a < 0) throw new Error('未找到经理变动表');
    const b = text.indexOf('现任基金经理简介');
    const seg = text.slice(a, b > a ? b : a + 4000);
    const re =
      /(\d{4}-\d{2}-\d{2})\s*\|+\s*(至今|\d{4}-\d{2}-\d{2})\s*\|+\s*([^%]*?)\|+\s*((?:\d+年又)?\d+\s*[年天])\s*\|+\s*(-?[\d.]+)%/g;
    const rows = [];
    let m = re.exec(seg);
    while (m && rows.length < 20) {
      const names = m[3]
        .split('|')
        .map((s) => s.trim())
        .filter((s) => s && !/^\d/.test(s) && s.length <= 12);
      rows.push({
        startDate: m[1],
        endDate: m[2] === '至今' ? null : m[2],
        current: m[2] === '至今',
        names,
        spanText: m[4].trim(),
        tenureReturnPct: toNum(m[5]),
      });
      m = re.exec(seg);
    }
    if (!rows.length) throw new Error('经理变动表解析为空');

    // 现任经理简介中的从业描述（截断，仅用于展示可核验事实）
    let currentBio = null;
    if (b > 0) {
      const bio = text.slice(b, b + 900).split('|').filter((s) => s.trim().length > 30);
      currentBio = bio.length ? bio[0].trim().slice(0, 300) : null;
    }
    return ok({ terms: rows, currentBio }, 'eastmoney:jjjl');
  } catch (e) {
    return fail(e, 'eastmoney:jjjl');
  }
}

/* ============================== 公告 ============================== */

/**
 * 公告归类
 * 注意：必须避免误报。例如「终止与某销售机构的合作」「终止费率优惠」都含「终止」，
 * 但与基金清盘无关；若不排除会把健康基金误判为存在清盘风险（实测已发生）。
 */
const NOTICE_EXCLUDE_FOR_CLEARING = /(销售机构|代销|销售业务|合作|渠道|定期定额|费率|折扣|优惠|服务机构|转换业务|平台)/;

const NOTICE_CATEGORY = [
  [/(基金经理|管理人员)(变更|变动)|增聘|解聘|离任/, 'manager_change'],
  [/(基金合同终止|清算|清盘|基金财产清算|终止基金合同|触发.*终止)/, 'clearing'],
  [/暂停(申购|大额申购|定期定额)|限制大额|恢复(申购|大额申购)|调整.*(申购|限额)/, 'purchase_limit'],
  [/暂停赎回|巨额赎回|延期办理赎回/, 'redeem_limit'],
  [/(溢价|折价)(风险|提示)/, 'premium_risk'],
  [/(基金合同|招募说明书)(修订|变更|更新)/, 'contract_change'],
  [/分红|收益分配/, 'dividend'],
  [/份额折算|基金份额拆分/, 'split'],
  [/(行政处罚|立案|监管措施|监管函|问询|整改|警示函)/, 'regulatory'],
  [/(诉讼|仲裁|涉诉)/, 'litigation'],
  [/(季度报告|中期报告|半年度报告|年度报告|报告提示)/, 'report'],
  [/(费率|优惠|折扣)/, 'fee'],
];

function classifyNotice(title) {
  const t = String(title || '');
  for (const [re, cat] of NOTICE_CATEGORY) {
    if (!re.test(t)) continue;
    if (cat === 'clearing' && NOTICE_EXCLUDE_FOR_CLEARING.test(t)) continue; // 排除销售机构类「终止」
    return cat;
  }
  return 'other';
}

async function notices(code, pageSize = 25) {
  const url = `https://api.fund.eastmoney.com/f10/JJGG?callback=cb&fundcode=${code}&pageIndex=1&pageSize=${pageSize}&type=0`;
  try {
    const json = await cache.wrap(`tt:notice:${code}`, cache.TTL.NOTICE, () => http.safeGetJson(url, { headers: REF_F10 }));
    const rows = Array.isArray(json?.Data) ? json.Data : [];
    const data = rows
      .map((r) => ({
        date: String(r.PUBLISHDATEDesc || String(r.PUBLISHDATE || '').slice(0, 10)),
        title: String(r.TITLE || ''),
        category: classifyNotice(String(r.TITLE || '')),
      }))
      .filter((x) => x.date && x.title);
    return ok(data, 'eastmoney:f10-notice', data[0]?.date);
  } catch (e) {
    return fail(e, 'eastmoney:f10-notice');
  }
}

/* ==================== 场内行情（折溢价） ==================== */

function guessSecid(code) {
  const c = String(code);
  if (/^(5|6|9)/.test(c)) return `1.${c}`; // 沪市
  return `0.${c}`; // 深市
}

async function onMarketQuote(code, latestNav) {
  // ulist.np 比 stock/get 更稳定；f1 为价格小数位数，需按位缩放
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${guessSecid(code)}&fields=f1,f2,f3,f6,f12,f14`;
  try {
    const json = await cache.wrap(`tt:onmkt:${code}`, cache.TTL.ONMARKET, () =>
      http.safeGetJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 })
    );
    const d = json?.data?.diff?.[0];
    if (!d || d.f2 === undefined || d.f2 === null || d.f2 === '-') throw new Error('场内行情为空');
    const decimals = Number.isFinite(Number(d.f1)) ? Number(d.f1) : 3;
    const price = round(Number(d.f2) / 10 ** decimals, 4);
    const turnoverWan = Number.isFinite(Number(d.f6)) ? round(Number(d.f6) / 1e4, 1) : null;
    const premiumPct = latestNav ? round((price / latestNav - 1) * 100, 2) : null;
    return ok(
      {
        name: String(d.f14 || ''),
        price,
        nav: latestNav ?? null,
        premiumPct,
        turnoverWan,
        dayChangePct: Number.isFinite(Number(d.f3)) ? round(Number(d.f3) / 100, 2) : null,
        premiumSeries: [], // 历史折溢价需逐日净值与收盘价对齐，一期不提供
        note: '溢价率按最近披露单位净值与最新场内价格估算，与实时 IOPV 存在差异',
      },
      'eastmoney:push2'
    );
  } catch (e) {
    return fail(e, 'eastmoney:push2');
  }
}

/* ==================== 市场环境（宽基指数） ==================== */

async function marketEnv() {
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000300,1.000001,0.399006&fields=f12,f14,f2,f3';
  try {
    const json = await cache.wrap('tt:market', cache.TTL.MARKET, () =>
      http.safeGetJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 })
    );
    const rows = json?.data?.diff;
    if (!Array.isArray(rows) || !rows.length) throw new Error('指数行情为空');
    const indexes = rows.map((r) => ({
      code: String(r.f12),
      name: String(r.f14),
      point: round(Number(r.f2) / 100, 2),
      changePct: round(Number(r.f3) / 100, 2),
    }));
    return ok({ indexes, asOf: dates.todayStr() }, 'eastmoney:push2');
  } catch (e) {
    return fail(e, 'eastmoney:push2');
  }
}

/* ==================== 重仓股估值（加权 PE/PB） ==================== */

async function holdingValuation(stocks) {
  const list = (stocks || []).filter((s) => /^\d{6}$/.test(String(s.code))).slice(0, 10);
  if (!list.length) return fail('无可用重仓股', 'eastmoney:push2');
  const secids = list.map((s) => guessSecid(s.code)).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f12,f14,f9,f23`;
  try {
    const json = await cache.wrap(`tt:val:${secids}`, cache.TTL.ONMARKET, () =>
      http.safeGetJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' }, timeoutMs: 8000 })
    );
    const rows = json?.data?.diff;
    if (!Array.isArray(rows) || !rows.length) throw new Error('估值数据为空');
    const byCode = new Map(rows.map((r) => [String(r.f12), r]));
    let wsum = 0;
    let peSum = 0;
    let pbSum = 0;
    const details = [];
    for (const s of list) {
      const r = byCode.get(String(s.code));
      if (!r) continue;
      const pe = Number(r.f9) / 100;
      const pb = Number(r.f23) / 100;
      if (!Number.isFinite(pe) || pe <= 0) continue;
      const w = s.pct || 0;
      wsum += w;
      peSum += pe * w;
      pbSum += (Number.isFinite(pb) ? pb : 0) * w;
      details.push({ code: s.code, name: s.name, pct: w, pe: round(pe, 2), pb: round(pb, 2) });
    }
    if (wsum <= 0) throw new Error('加权估值不可用');
    return ok(
      {
        pe: round(peSum / wsum, 2),
        pb: round(pbSum / wsum, 2),
        coveredWeightPct: round(wsum, 2),
        details,
        peSeries: [], // 组合历史 PE 序列需逐股历史盈利数据，公开接口不可得
        note: '按最新披露十大重仓股权重加权计算；历史分位因缺少组合历史盈利数据暂不提供',
      },
      'eastmoney:push2'
    );
  } catch (e) {
    return fail(e, 'eastmoney:push2');
  }
}

/* ============================== 热门 ============================== */

/**
 * FUNDTYPE 编码映射（天天基金 FundMNRank 接口返回数字编码）
 */
const FUNDTYPE_MAP = {
  '001': '股票型',
  '002': '混合型',
  '003': '债券型',
  '004': '指数型',
  '005': 'QDII',
  '006': 'FOF',
  '007': '货币型',
  '008': '商品型',
};

/** 从 FUNDTYPE 编码获取文字类型 */
function fundTypeLabel(code) {
  return FUNDTYPE_MAP[String(code)] || String(code || '');
}

/**
 * 多维度分类器 —— 基于天天基金公开接口字段做启发式打标
 *
 * 维度设计：
 *   asset      底层资产（股票/债券/货币/商品/混合）
 *   operation  运作方式（开放式/ETF/LOF/FOF/定开）
 *   strategy   投资策略（主动管理/被动指数/量化增强）
 *   region     地域（境内/QDII境外）
 *   theme      赛道主题（消费/科技/医药/新能源/红利/军工等，从名称提取）
 */
function classifyFund(row) {
  var ft = String(row.FUNDTYPE || '');
  var bft = String(row.BFUNDTYPE || '');
  var name = String(row.SHORTNAME || '');
  var listExch = String(row.LISTTEXCH || '');
  var feature = String(row.FEATURE || '');

  // ---- 底层资产 ----
  var asset = '混合';
  if (ft === '001') asset = '股票';
  else if (ft === '003') asset = '债券';
  else if (ft === '007') asset = '货币';
  else if (ft === '008') asset = '商品';
  else if (ft === '002') {
    if (/偏股|股票/.test(bft)) asset = '股票';
    else if (/偏债|债券/.test(bft)) asset = '债券';
    else asset = '混合';
  }

  // ---- 运作方式 ----
  var operation = '开放式';
  if (listExch && listExch !== '--') {
    operation = /701/.test(feature) ? 'ETF' : 'LOF';
  }
  if (ft === '006') operation = 'FOF';
  if (/定开|定期开放|持有期|封闭/.test(name)) operation = '定开';

  // ---- 投资策略 ----
  var strategy = '主动管理';
  if (ft === '004' || /指数|跟踪|标的/.test(bft) || /指数/.test(name)) strategy = '被动指数';
  if (/量化|对冲|套利|CTA/.test(name)) strategy = '量化';

  // ---- 地域 ----
  var region = ft === '005' ? 'QDII' : '境内';

  // ---- 赛道主题（从基金名称提取关键词） ----
  var THEME_KEYWORDS = [
    ['消费', /消费|食品|饮料|白酒|家电|零售|商贸|超市/],
    ['科技', /科技|技术|信息|软件|互联网|计算机|半导体|芯片|电子/],
    ['医药', /医药|医疗|健康|生物|创新药|中药|疫苗|器械/],
    ['新能源', /新能源|光伏|风电|锂电|储能|电池|清洁能源/],
    ['高端制造', /制造|工业|机械|装备|机器人|自动化|智能/],
    ['金融地产', /金融|银行|证券|保险|地产|基建|建筑/],
    ['红利', /红利|高股息|价值|低波|稳健/],
    ['军工国防', /军工|国防|航天|航空|航海|核/],
    ['资源周期', /资源|有色|煤炭|钢铁|化工|石油|天然气|材料/],
    ['农业', /农业|养殖|畜牧|种业/],
    ['港股', /港股|恒生|H股|沪港通|深港通/],
    ['美股', /美股|纳斯达克|标普|道琼斯/],
    ['全球配置', /全球|世界|国际|海外/],
    ['债券纯债', /纯债|短债|长债|信用债|利率债|可转债/],
  ];
  var themes = [];
  for (var ti = 0; ti < THEME_KEYWORDS.length; ti++) {
    if (THEME_KEYWORDS[ti][1].test(name)) themes.push(THEME_KEYWORDS[ti][0]);
  }
  if (!themes.length && !['货币'].includes(asset)) themes.push(asset);

  return { asset: asset, operation: operation, strategy: strategy, region: region, themes: themes };
}

/**
 * 热门基金榜（天天基金近1年收益率排行）
 * 分页循环获取全量基金数据，按近1年收益率降序排列
 * 注意：FundMNRank API 每页固定返回30条，Total 约24000+，需分页约800+次
 * 使用文件持久化缓存 + 内存双层缓存，避免重启后重拉
 */
async function hot() {
  var PER_PAGE = 30; // API 固定每页返回30条
  var MAX_PAGES = 900; // 上限900页（约2.7万只），覆盖全部基金
  var CACHE_FILE = path.join(process.cwd(), '.cache', 'hot_full.json');
  var CACHE_TTL_MS = cache.TTL.HOT * 1000; // 与内存缓存 TTL 一致

  // 1️⃣ 尝试从文件缓存加载（优先级最高，重启后立即可用）
  try {
    if (fs.existsSync(CACHE_FILE)) {
      var stat = fs.statSync(CACHE_FILE);
      var age = Date.now() - stat.mtimeMs;
      if (age < CACHE_TTL_MS) {
        var fileData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        logger.info('热门榜从文件缓存加载', { count: fileData.length, ageMs: Math.round(age) });
        return ok(fileData, 'eastmoney:mobapi:file-cache');
      }
    }
  } catch (e) {
    logger.warn('热门榜文件缓存读取失败', { error: e.message });
  }

  // 2️⃣ 文件缓存未命中或已过期，分页拉取全量数据
  var allRows = [];
  for (var page = 1; page <= MAX_PAGES; page++) {
    var url = MOB + '/FundMNRank?FundType=all&SortColumn=SYL_1N&Sort=desc&pageIndex=' + page + '&pageSize=' + PER_PAGE + '&' + MOB_PARAMS;
    try {
      var json = await http.safeGetJson(url, { headers: REF_MOB });
      var rows = Array.isArray(json && json.Datas) ? json.Datas : [];
      if (!rows.length) break;
      allRows = allRows.concat(rows);
      if (rows.length < PER_PAGE) break;
    } catch (e) {
      logger.warn('热门榜分页获取第' + page + '页失败', { error: e.message });
      break;
    }
    if (page % 100 === 0) await new Promise(function (r) { setTimeout(r, 200); });
  }

  if (!allRows.length) throw new Error('热门榜为空');

  var result = allRows.map(function (r) {
    var cls = classifyFund(r);
    return {
      code: String(r.FCODE || ''),
      name: String(r.SHORTNAME || ''),
      typeText: fundTypeLabel(r.FUNDTYPE),
      company: String(r.JJGS || ''),
      return1y: toNum(r.SYL_1N),
      returnSinceStart: toNum(r.SYL_LN),
      asset: cls.asset,
      operation: cls.operation,
      strategy: cls.strategy,
      region: cls.region,
      themes: cls.themes,
    };
  });

  // 3️⃣ 写入文件缓存（异步，不阻塞响应）
  try {
    var cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(result), 'utf-8');
    logger.info('热门榜文件缓存已写入', { count: result.length, path: CACHE_FILE });
  } catch (e) {
    logger.warn('热门榜文件缓存写入失败', { error: e.message });
  }

  return ok(result, 'eastmoney:mobapi');
}

module.exports = {
  search,
  basicInfo,
  periodStats,
  pingzhong,
  archive,
  feeTiers,
  managerHistory,
  positions,
  sectorAlloc,
  notices,
  onMarketQuote,
  marketEnv,
  holdingValuation,
  hot,
  classifyNotice,
};
