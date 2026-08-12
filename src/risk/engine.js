'use strict';
/**
 * 风险规则引擎（板块⑥）
 *
 * 设计要求（需求 R-1 / R-2 / R-6）：
 *  - 雷点由确定性规则按阈值扫描产出，可审计、可回归测试；模型只负责解释，不得自行新增雷点
 *  - 每条雷点四要素齐全：风险描述 + 触发依据（数值/公告与日期） + 严重程度 + 关注建议
 *  - 阈值可配置且按基金类型差异化（债基/货币/指数与权益完全不同口径，避免误报）
 *  - 「未发现风险」必须写明实际检查了哪些项（R-5），因此引擎同时返回 checkedItems
 */
const dates = require('../utils/dates');
const { isNum, round } = require('../utils/num');
const { thresholdsFor } = require('../config/riskRules');
const { TYPE } = require('../config/fundTypes');

const CATEGORY_LABELS = {
  style_drift: '风格漂移风险',
  survival: '存续与清盘风险',
  personnel: '人员变动风险',
  capacity: '规模与容量风险',
  holder: '持有人结构风险',
  concentration: '集中度与踩雷风险',
  return_anomaly: '收益异常风险',
  experience: '波动与持有体验风险',
  valuation: '估值透支风险',
  cost: '成本风险',
  liquidity: '交易与流动性风险',
  premium: '折溢价风险',
  tracking: '跟踪偏离风险',
  credit: '信用与杠杆风险',
  compliance: '合规与治理风险',
  systemic: '市场系统性风险',
  transparency: '信息透明度风险',
};

/** 全部规则清单（供 /api/rules 公开口径） */
const RULES = [];
function defineRule(key, category, title, applicableTypes) {
  RULES.push({ key, category, title, applicableTypes: applicableTypes || 'all' });
}

/* 规则清单声明（与下方 scan 实现一一对应） */
defineRule('mini_scale', 'survival', '资产净值低于清盘警戒线');
defineRule('scale_warn', 'survival', '资产净值偏小');
defineRule('clearing_notice', 'survival', '已发布可能触发基金合同终止的公告');
defineRule('redeem_suspended', 'survival', '当前暂停赎回');
defineRule('purchase_suspended', 'survival', '当前暂停申购');
defineRule('scale_shrink', 'survival', '规模单期大幅缩水');
defineRule('share_shrink', 'survival', '总份额连续下降');
defineRule('manager_very_new', 'personnel', '现任基金经理刚接任');
defineRule('manager_new', 'personnel', '现任基金经理任职时间较短');
defineRule('frequent_change', 'personnel', '近三年基金经理更换频繁');
defineRule('manager_left_notice', 'personnel', '近期发布基金经理变更公告');
defineRule('workload_funds', 'personnel', '基金经理在管产品数量偏多');
defineRule('workload_aum', 'personnel', '基金经理在管规模偏大');
defineRule('scale_surge', 'capacity', '规模短期大幅增长');
defineRule('huge_scale', 'capacity', '规模过大可能影响策略灵活度');
defineRule('purchase_limited', 'capacity', '当前处于限制大额申购状态');
defineRule('institution_high', 'holder', '机构持有比例偏高');
defineRule('single_holder_high', 'holder', '单一持有人占比偏高');
defineRule('single_holder_red', 'holder', '单一持有人占比超过红线');
defineRule('top10_high', 'concentration', '前十大重仓集中度偏高');
defineRule('single_industry_high', 'concentration', '单一行业占比偏高');
defineRule('holding_stock_risk', 'concentration', '重仓股存在风险标记');
defineRule('drift_severe', 'style_drift', '风格漂移达严重级');
defineRule('drift_warn', 'style_drift', '持仓行业分布相对历史明显偏移');
defineRule('theme_mismatch', 'style_drift', '主题基金持仓与名称主题匹配度偏低');
defineRule('turnover_high', 'style_drift', '换手率显著偏高');
defineRule('underperform_peer', 'return_anomaly', '长期跑输同类平均');
defineRule('bond_return_anomaly', 'return_anomaly', '债券基金收益显著高于同类');
defineRule('nav_jump', 'return_anomaly', '存在单日净值异常跳变');
defineRule('negative_years_many', 'return_anomaly', '亏损年份占比偏高');
defineRule('drawdown_deep', 'experience', '历史最大回撤较深');
defineRule('current_drawdown_deep', 'experience', '当前仍处于较深回撤中');
defineRule('volatility_high', 'experience', '年化波动率偏高');
defineRule('recovery_long', 'experience', '回撤修复耗时偏长');
defineRule('positive_rate_low', 'experience', '滚动持有一年正收益概率偏低');
defineRule('valuation_high', 'valuation', '持仓估值处于历史高分位');
defineRule('nav_high_position', 'valuation', '净值处于区间高位');
defineRule('surge_3m', 'valuation', '近三月涨幅较大');
defineRule('fee_high', 'cost', '年运作费率高于同类常见水平');
defineRule('premium_red', 'premium', '场内溢价率超过红线');
defineRule('premium_warn', 'premium', '场内存在溢价');
defineRule('turnover_low', 'liquidity', '场内日均成交额偏低');
defineRule('lockup', 'liquidity', '存在最短持有期限制');
defineRule('tracking_error_high', 'tracking', '年化跟踪误差偏高');
defineRule('low_rating_high', 'credit', '低评级债券占比偏高');
defineRule('leverage_high', 'credit', '杠杆率偏高');
defineRule('duration_long', 'credit', '组合久期偏长');
defineRule('convertible_high', 'credit', '可转债占比偏高');
defineRule('regulatory_notice', 'compliance', '存在监管处罚或问询相关公告');
defineRule('litigation_notice', 'compliance', '存在诉讼仲裁相关公告');
defineRule('contract_change', 'compliance', '基金合同或招募说明书发生变更');
defineRule('market_high_percentile', 'systemic', '宽基指数估值处于较高分位');
defineRule('short_history', 'transparency', '成立时间较短，历史数据不足');
defineRule('holdings_stale', 'transparency', '持仓披露期已较久');
defineRule('data_incomplete', 'transparency', '部分公开数据缺失');
defineRule('holder_data_missing', 'transparency', '单一持有人占比数据不可得');
defineRule('tracking_unavailable', 'transparency', '跟踪误差数据不可得');
defineRule('valuation_percentile_unavailable', 'transparency', '持仓估值历史分位不可得');

/**
 * 扫描
 * @param {object} ctx { bundle, metrics:{returns, experience, manager, costTiming, holdings}, completeness }
 * @returns {{level:string, findings:Array, checkedItems:Array, hardRedLines:Array, summaryStat:object}}
 */
function scan(ctx) {
  const { bundle, metrics, completeness } = ctx;
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const th = thresholdsFor(fundType);
  const navDate = profile.navDate;
  const findings = [];
  const checked = [];

  /** 登记一次检查（无论是否命中，用于绿灯文案 R-5） */
  const check = (key) => {
    const r = RULES.find((x) => x.key === key);
    checked.push({ key, category: r?.category || null, title: r?.title || key });
  };

  /**
   * 命中雷点
   * @param {string} key
   * @param {object} o { severity, hardRedLine, desc, trigger:{label,value,threshold,asOf}, watch }
   */
  const hit = (key, o) => {
    const r = RULES.find((x) => x.key === key);
    findings.push({
      key,
      category: r?.category || 'transparency',
      categoryLabel: CATEGORY_LABELS[r?.category] || '其他',
      title: o.title || r?.title || key,
      severity: o.severity || 'medium',
      hardRedLine: Boolean(o.hardRedLine),
      description: o.desc,
      trigger: o.trigger,
      watch: o.watch,
      explain: null, // 由模型填充解释，规则层不臆测
    });
  };

  const notices = bundle.notices || [];
  const recentNotice = (cat, months) =>
    notices.find((n) => n.category === cat && (dates.diffDays(navDate, n.date) ?? 9999) <= months * 31);

  /* ==================== 存续与清盘 ==================== */
  const scaleYi = metrics.costTiming?.scaleStatus?.valueYi ?? profile.scaleYi ?? null;
  const scaleAsOf = metrics.costTiming?.scaleStatus?.asOf ?? profile.scaleAsOf ?? null;

  check('mini_scale');
  check('scale_warn');
  if (isNum(scaleYi)) {
    if (scaleYi < th.miniScaleYi) {
      hit('mini_scale', {
        severity: 'high',
        hardRedLine: true,
        desc: `基金资产净值 ${scaleYi} 亿元，低于 ${th.miniScaleYi} 亿元的清盘警戒线。基金合同通常约定连续一定期限低于该规模可能触发合同终止`,
        trigger: { label: '资产净值', value: `${scaleYi}亿元`, threshold: `< ${th.miniScaleYi}亿元`, asOf: scaleAsOf },
        watch: '关注基金管理人后续公告中是否出现持续低于合同约定规模的提示',
      });
    } else if (scaleYi < th.miniScaleWarnYi) {
      hit('scale_warn', {
        severity: 'medium',
        desc: `基金资产净值 ${scaleYi} 亿元，规模偏小，若继续下降可能触及清盘警戒线`,
        trigger: { label: '资产净值', value: `${scaleYi}亿元`, threshold: `< ${th.miniScaleWarnYi}亿元`, asOf: scaleAsOf },
        watch: '关注下一期定期报告的规模变化',
      });
    }
  }

  check('clearing_notice');
  const clearNotice = recentNotice('clearing', 12);
  if (clearNotice) {
    hit('clearing_notice', {
      severity: 'high',
      hardRedLine: true,
      desc: '近 12 个月内发布过与基金合同终止/清算相关的公告',
      trigger: { label: '公告', value: clearNotice.title, threshold: '存在清算或合同终止相关公告', asOf: clearNotice.date },
      watch: '以基金管理人公告为准，关注是否进入清算程序及份额处理安排',
    });
  }

  check('redeem_suspended');
  if (metrics.costTiming?.scaleStatus?.redeemSuspended) {
    hit('redeem_suspended', {
      severity: 'high',
      hardRedLine: true,
      desc: `当前赎回状态为「${profile.redeemStatus}」，资金流动性受限`,
      trigger: { label: '赎回状态', value: profile.redeemStatus, threshold: '正常应为开放赎回', asOf: profile.asOf },
      watch: '关注恢复赎回的公告与具体安排',
    });
  }

  check('purchase_suspended');
  if (/暂停/.test(String(profile.purchaseStatus || ''))) {
    hit('purchase_suspended', {
      severity: 'medium',
      desc: `当前申购状态为「${profile.purchaseStatus}」`,
      trigger: { label: '申购状态', value: profile.purchaseStatus, threshold: '正常应为开放申购', asOf: profile.asOf },
      watch: '关注恢复申购公告；暂停申购的原因可能涉及规模控制或运作调整',
    });
  }

  check('scale_shrink');
  const scaleChange = metrics.costTiming?.scaleStatus?.changePct;
  if (isNum(scaleChange) && scaleChange < -th.scaleShrinkPct) {
    hit('scale_shrink', {
      severity: 'medium',
      desc: `最新一期资产净值相比上期变化 ${scaleChange}%，出现较大幅度缩水`,
      trigger: { label: '规模环比', value: `${scaleChange}%`, threshold: `< -${th.scaleShrinkPct}%`, asOf: scaleAsOf },
      watch: '关注是否为机构大额赎回导致，以及对基金正常运作与调仓的影响',
    });
  }

  check('share_shrink');
  const shares = bundle.shares || [];
  if (shares.length >= 3) {
    const last3 = shares.slice(-3).map((s) => s.totalSharesYi).filter(isNum);
    if (last3.length === 3 && last3[0] > last3[1] && last3[1] > last3[2]) {
      const dropPct = round((last3[2] / last3[0] - 1) * 100, 2);
      hit('share_shrink', {
        severity: 'low',
        desc: `最近三期总份额连续下降，累计变化 ${dropPct}%`,
        trigger: { label: '总份额（近三期）', value: last3.map((x) => `${x}亿份`).join(' → '), threshold: '连续三期下降', asOf: shares[shares.length - 1].asOf },
        watch: '关注份额持续流出是否影响基金运作与持仓调整',
      });
    }
  }

  /* ==================== 人员变动 ==================== */
  const mgr = metrics.manager || {};
  const mgrApplicable = mgr.applicable !== false;
  if (mgrApplicable) {
    check('manager_very_new');
    check('manager_new');
    const months = mgr.tenure?.months ?? null;
    const hasPast = (bundle.pastManagerTerms || []).length > 0;
    if (isNum(months) && months < th.newManagerRedMonths && hasPast) {
      hit('manager_very_new', {
        severity: 'high',
        hardRedLine: true,
        desc: `现任基金经理${mgr.primaryManager ? `（${mgr.primaryManager}）` : ''}任职本基金约 ${months} 个月，前任已离任，基金过往业绩与当前管理人关联度低`,
        trigger: { label: '现任经理任职时长', value: `${months} 个月`, threshold: `< ${th.newManagerRedMonths} 个月`, asOf: navDate },
        watch: '关注新任经理的历史管理业绩与其在其他产品上的风格，以及下一期持仓是否发生明显调整',
      });
    } else if (isNum(months) && months < th.newManagerMonths) {
      hit('manager_new', {
        severity: 'medium',
        desc: `现任基金经理任职本基金约 ${months} 个月，任职时间较短`,
        trigger: { label: '现任经理任职时长', value: `${months} 个月`, threshold: `< ${th.newManagerMonths} 个月`, asOf: navDate },
        watch: '关注其任职以来的持仓与业绩变化，历史业绩需区分前任贡献',
      });
    }

    check('frequent_change');
    if (mgr.changeStat?.frequentChange) {
      hit('frequent_change', {
        severity: 'medium',
        desc: `近 3 年基金经理变更 ${mgr.changeStat.changeCount3y} 次，管理连续性不足`,
        trigger: { label: '近3年变更次数', value: `${mgr.changeStat.changeCount3y} 次`, threshold: `≥ ${th.managerChangeTimes3y} 次`, asOf: navDate },
        watch: '关注管理人投研团队稳定性，以及每次更换后的策略延续性',
      });
    }

    check('manager_left_notice');
    const mgrNotice = recentNotice('manager_change', 3);
    if (mgrNotice) {
      hit('manager_left_notice', {
        severity: 'medium',
        desc: '近 3 个月内发布过基金经理变更公告',
        trigger: { label: '公告', value: mgrNotice.title, threshold: '近3个月存在经理变更公告', asOf: mgrNotice.date },
        watch: '确认变更后的管理人构成，并关注后续持仓是否出现明显调整',
      });
    }

    check('workload_funds');
    const fc = mgr.workload?.fundCount;
    if (isNum(fc) && fc > th.managerFundCount) {
      hit('workload_funds', {
        severity: 'low',
        desc: `现任基金经理同时管理 ${fc} 只基金，精力分配可能受影响`,
        trigger: { label: '在管基金数量', value: `${fc} 只`, threshold: `> ${th.managerFundCount} 只`, asOf: navDate },
        watch: '关注其新增在管产品的节奏，以及本基金持仓与其代表作的差异',
      });
    }

    check('workload_aum');
    const aum = mgr.workload?.aumYi;
    if (isNum(aum) && aum > th.managerAumYi) {
      hit('workload_aum', {
        severity: 'low',
        desc: `现任基金经理在管总规模约 ${aum} 亿元，规模较大可能影响策略容量`,
        trigger: { label: '在管总规模', value: `${aum}亿元`, threshold: `> ${th.managerAumYi}亿元`, asOf: navDate },
        watch: '关注在管规模继续上升时，其超额收益是否出现衰减',
      });
    }
  }

  /* ==================== 规模与容量 ==================== */
  check('scale_surge');
  const surge = metrics.costTiming?.scaleStatus?.surgeRatio;
  if (isNum(surge) && surge >= th.scaleSurgeRatio) {
    hit('scale_surge', {
      severity: 'medium',
      desc: `资产净值相比可得最早一期增长约 ${surge} 倍，规模快速扩张可能影响原有策略的有效性`,
      trigger: { label: '规模增长倍数', value: `${surge} 倍`, threshold: `≥ ${th.scaleSurgeRatio} 倍`, asOf: scaleAsOf },
      watch: '关注规模上升后超额收益是否衰减、持仓是否被迫分散',
    });
  }

  check('huge_scale');
  if (metrics.costTiming?.scaleStatus?.huge) {
    hit('huge_scale', {
      severity: 'low',
      desc: `资产净值约 ${scaleYi} 亿元，规模较大，调仓灵活度与小盘策略容量可能受限`,
      trigger: { label: '资产净值', value: `${scaleYi}亿元`, threshold: `> ${th.hugeScaleYi}亿元`, asOf: scaleAsOf },
      watch: '关注持仓是否向大市值集中，以及换手率是否明显下降',
    });
  }

  check('purchase_limited');
  if (metrics.costTiming?.scaleStatus?.limited && !/暂停/.test(String(profile.purchaseStatus || ''))) {
    hit('purchase_limited', {
      severity: 'low',
      desc: `当前申购状态为「${profile.purchaseStatus}」${profile.purchaseStatusMark ? `（${profile.purchaseStatusMark}）` : ''}`,
      trigger: { label: '申购状态', value: profile.purchaseStatus, threshold: '存在大额申购限制', asOf: profile.asOf },
      watch: '限购通常用于控制规模或应对溢价，关注限购原因与后续调整公告',
    });
  }

  /* ==================== 持有人结构 ==================== */
  const holders = bundle.holders;
  check('institution_high');
  if (holders && isNum(holders.institutionPct) && holders.institutionPct > th.institutionHoldPct) {
    hit('institution_high', {
      severity: 'medium',
      desc: `机构持有比例 ${holders.institutionPct}%，机构大额赎回可能对净值与持仓产生冲击`,
      trigger: { label: '机构持有比例', value: `${holders.institutionPct}%`, threshold: `> ${th.institutionHoldPct}%`, asOf: holders.asOf },
      watch: '关注下一期定期报告中持有人结构与总份额的变化',
    });
  }

  check('single_holder_high');
  check('single_holder_red');
  if (holders && isNum(holders.singleTopPct)) {
    if (holders.singleTopPct > th.singleHolderRedPct) {
      hit('single_holder_red', {
        severity: 'high',
        hardRedLine: true,
        desc: `单一持有人占比 ${holders.singleTopPct}%，超过红线，该持有人赎回将对基金造成重大冲击`,
        trigger: { label: '单一持有人占比', value: `${holders.singleTopPct}%`, threshold: `> ${th.singleHolderRedPct}%`, asOf: holders.asOf },
        watch: '关注该持有人份额变动，以及基金是否发生巨额赎回相关公告',
      });
    } else if (holders.singleTopPct > th.singleHolderPct) {
      hit('single_holder_high', {
        severity: 'medium',
        desc: `单一持有人占比 ${holders.singleTopPct}%，集中度偏高`,
        trigger: { label: '单一持有人占比', value: `${holders.singleTopPct}%`, threshold: `> ${th.singleHolderPct}%`, asOf: holders.asOf },
        watch: '关注该持有人后续份额变化对净值的潜在影响',
      });
    }
  } else {
    check('holder_data_missing');
    hit('holder_data_missing', {
      severity: 'low',
      desc: '单一持有人占比数据需从基金定期报告全文获取，公开接口不提供，本项未做判断',
      trigger: { label: '单一持有人占比', value: '数据不可得', threshold: `红线 > ${th.singleHolderRedPct}%`, asOf: holders?.asOf || null },
      watch: '如需确认，可查阅基金定期报告中「基金份额持有人信息」章节',
    });
  }

  /* ==================== 集中度 ==================== */
  const hold = metrics.holdings || {};
  check('top10_high');
  if (hold.available && isNum(hold.top10Pct) && hold.top10Pct > th.top10ConcentrationPct) {
    hit('top10_high', {
      severity: 'medium',
      desc: `前十大重仓合计占净值 ${hold.top10Pct}%，个股集中度偏高，单一标的波动对净值影响放大`,
      trigger: { label: '前十大集中度', value: `${hold.top10Pct}%`, threshold: `> ${th.top10ConcentrationPct}%`, asOf: hold.asOf },
      watch: '关注下一期重仓变化与第一大重仓的占比',
    });
  }

  check('single_industry_high');
  if (hold.available && hold.topIndustry && isNum(hold.topIndustry.pct) && hold.topIndustry.pct > th.singleIndustryPct) {
    hit('single_industry_high', {
      severity: 'medium',
      desc: `第一大行业「${hold.topIndustry.name}」占比 ${hold.topIndustry.pct}%，行业集中度高，行业景气回落时缺乏缓冲`,
      trigger: { label: '第一大行业占比', value: `${hold.topIndustry.pct}%`, threshold: `> ${th.singleIndustryPct}%`, asOf: hold.asOf },
      watch: '关注该行业景气度变化与基金是否具备行业切换能力',
    });
  }

  check('holding_stock_risk');
  const riskyStocks = (hold.stocks || []).filter((s) => /ST|退|\*/.test(String(s.name || '')));
  if (riskyStocks.length) {
    hit('holding_stock_risk', {
      severity: 'high',
      desc: `重仓股中存在带风险标记的个股：${riskyStocks.map((s) => s.name).join('、')}`,
      trigger: { label: '风险标记重仓股', value: riskyStocks.map((s) => `${s.name}(${s.pct}%)`).join('、'), threshold: '不应出现 ST/退市风险标记', asOf: hold.asOf },
      watch: '关注该持仓是否已在最新报告期中调出',
    });
  }

  /* ==================== 风格漂移 ==================== */
  if (fundType !== TYPE.INDEX_EQUITY && fundType !== TYPE.COMMODITY && fundType !== TYPE.MONEY) {
    check('drift_severe');
    check('drift_warn');
    if (hold.drift?.available) {
      const dev = hold.drift.deviationPct;
      if (isNum(dev) && dev >= th.styleDriftSeverePct) {
        hit('drift_severe', {
          severity: 'high',
          hardRedLine: true,
          desc: `最新一期行业分布相对历史各期均值的调整幅度达 ${dev}%，风格发生大幅切换`,
          trigger: { label: '行业分布偏离度', value: `${dev}%`, threshold: `≥ ${th.styleDriftSeverePct}%`, asOf: hold.asOf },
          watch: '关注下一期持仓是否回归原有风格，以及是否与基金合同约定的投资范围一致',
        });
      } else if (isNum(dev) && dev >= th.styleDriftPct) {
        hit('drift_warn', {
          severity: 'medium',
          desc: `最新一期行业分布相对历史各期均值的调整幅度为 ${dev}%，持仓风格出现明显偏移`,
          trigger: { label: '行业分布偏离度', value: `${dev}%`, threshold: `≥ ${th.styleDriftPct}%`, asOf: hold.asOf },
          watch: '关注这一调整是主动策略变化还是行业轮动，以及是否延续到下一期',
        });
      }
    }

    check('theme_mismatch');
    if (hold.themeMatch?.available && hold.themeMatch.mismatch) {
      hit('theme_mismatch', {
        severity: 'medium',
        desc: `基金名称/标的指向「${hold.themeMatch.theme}」主题，但相关行业持仓仅占 ${hold.themeMatch.matchedPct}%`,
        trigger: { label: '主题相关持仓占比', value: `${hold.themeMatch.matchedPct}%`, threshold: `< ${th.themeMismatchPct}%`, asOf: hold.asOf },
        watch: '核对基金合同约定的投资范围，关注是否存在名不符实的情况（也可能是行业分类粒度导致的低估）',
      });
    }

    check('turnover_high');
    if (isNum(hold.turnoverPct) && hold.turnoverPct > 400) {
      hit('turnover_high', {
        severity: 'low',
        desc: `换手率约 ${hold.turnoverPct}%，交易较为频繁，交易成本对净值的损耗需关注`,
        trigger: { label: '换手率', value: `${hold.turnoverPct}%`, threshold: '> 400%', asOf: hold.asOf },
        watch: '关注高换手是否带来相应的超额收益',
      });
    }
  }

  /* ==================== 收益异常 ==================== */
  const ret = metrics.returns || {};
  check('underperform_peer');
  const ex3y = ret.intervals?.['3y']?.excessVsPeerPp;
  if (isNum(ex3y) && ex3y < -15) {
    hit('underperform_peer', {
      severity: 'medium',
      desc: `近 3 年相对同类平均落后 ${Math.abs(ex3y)} 个百分点，长期竞争力偏弱`,
      trigger: { label: '近3年超额（对同类平均）', value: `${ex3y} 个百分点`, threshold: '< -15 个百分点', asOf: navDate },
      watch: '关注落后是风格阶段性不适应还是策略持续失效',
    });
  }

  if (fundType === TYPE.BOND) {
    check('bond_return_anomaly');
    const ex1y = ret.intervals?.['1y']?.excessVsPeerPp;
    if (isNum(ex1y) && ex1y > th.bondReturnAnomalyPct) {
      hit('bond_return_anomaly', {
        severity: 'medium',
        desc: `近 1 年收益高于同类平均 ${ex1y} 个百分点，债券基金显著超额通常隐含信用下沉、久期拉长或杠杆提升`,
        trigger: { label: '近1年超额（对同类平均）', value: `${ex1y} 个百分点`, threshold: `> ${th.bondReturnAnomalyPct} 个百分点`, asOf: navDate },
        watch: '关注定期报告中的券种结构、评级分布与杠杆率',
      });
    }
  }

  check('nav_jump');
  const jumps = [];
  const navArr = bundle.nav || [];
  for (let i = 1; i < navArr.length; i += 1) {
    const p = navArr[i];
    if (isNum(p.dailyPct) && Math.abs(p.dailyPct) > Math.max(th.navJumpPct, th.volatilityHigh * 0.6)) {
      jumps.push({ date: p.date, pct: p.dailyPct });
    }
  }
  if (jumps.length && (fundType === TYPE.BOND || fundType === TYPE.MONEY)) {
    const j = jumps.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
    hit('nav_jump', {
      severity: 'medium',
      desc: `存在单日净值异常跳变，最大单日变动 ${j.pct}%（${j.date}），对该类型基金而言幅度异常`,
      trigger: { label: '最大单日净值变动', value: `${j.pct}%`, threshold: `绝对值 > ${round(Math.max(th.navJumpPct, th.volatilityHigh * 0.6), 2)}%`, asOf: j.date },
      watch: '核对当日是否发生分红、份额折算、估值调整或持仓债券信用事件',
    });
  }

  check('negative_years_many');
  const yrs = (ret.yearly || []).filter((y) => !y.isPartial);
  if (yrs.length >= 3) {
    const neg = yrs.filter((y) => y.pct < 0).length;
    if (neg / yrs.length >= 0.5) {
      hit('negative_years_many', {
        severity: 'medium',
        desc: `完整年度中有 ${neg}/${yrs.length} 个年份为负收益`,
        trigger: { label: '亏损年份占比', value: `${neg}/${yrs.length}`, threshold: '≥ 50%', asOf: navDate },
        watch: '关注亏损年份是否集中于特定市场环境，以及策略对下行的应对',
      });
    }
  }

  /* ==================== 体验类 ==================== */
  const exp = metrics.experience || {};
  check('drawdown_deep');
  const mdd = exp.drawdown?.maxPct;
  if (isNum(mdd) && Math.abs(mdd) > th.maxDrawdownHigh) {
    hit('drawdown_deep', {
      severity: Math.abs(mdd) > th.maxDrawdownHigh * 1.25 ? 'high' : 'medium',
      desc: `历史最大回撤 ${Math.abs(mdd)}%（${exp.drawdown.maxFrom} 至 ${exp.drawdown.maxBottom}），持有过程波动剧烈`,
      trigger: { label: '历史最大回撤', value: `${Math.abs(mdd)}%`, threshold: `> ${th.maxDrawdownHigh}%`, asOf: navDate },
      watch: '结合自身可承受的波动范围评估，关注回撤是否伴随策略失效',
    });
  }

  check('current_drawdown_deep');
  const cdd = exp.drawdown?.current?.ddPct;
  if (isNum(cdd) && Math.abs(cdd) > th.currentDrawdownDeep) {
    hit('current_drawdown_deep', {
      severity: 'medium',
      desc: `当前净值距历史高点仍有 ${Math.abs(cdd)}% 的回撤，已持续 ${exp.drawdown.current.durationDays} 天`,
      trigger: { label: '当前回撤', value: `${Math.abs(cdd)}%`, threshold: `> ${th.currentDrawdownDeep}%`, asOf: navDate },
      watch: '关注回撤是行业普遍现象还是本基金特有',
    });
  }

  check('volatility_high');
  const vol = exp.volatility?.annualPct;
  if (isNum(vol) && vol > th.volatilityHigh) {
    hit('volatility_high', {
      severity: 'low',
      desc: `年化波动率 ${vol}%，高于该类型基金的常见水平`,
      trigger: { label: '年化波动率', value: `${vol}%`, threshold: `> ${th.volatilityHigh}%`, asOf: navDate },
      watch: '波动本身不等于亏损，但会显著影响持有体验',
    });
  }

  check('recovery_long');
  const rec = exp.drawdown?.recoveryMedianDays;
  if (isNum(rec) && rec > th.recoveryLongDays) {
    hit('recovery_long', {
      severity: 'low',
      desc: `历史回撤修复时长中位数约 ${rec} 天，回本过程较为漫长`,
      trigger: { label: '回撤修复中位时长', value: `${rec} 天`, threshold: `> ${th.recoveryLongDays} 天`, asOf: navDate },
      watch: '关注修复时长是否与市场整体节奏一致',
    });
  }

  check('positive_rate_low');
  const pr = exp.rollingHold?.['1y'];
  if (pr?.available && isNum(pr.positiveRatePct) && pr.positiveRatePct < 40) {
    hit('positive_rate_low', {
      severity: 'medium',
      desc: `历史上任一交易日买入并持有 1 年，仅 ${pr.positiveRatePct}% 的情形取得正收益（样本 ${pr.samples} 个）`,
      trigger: { label: '滚动持有1年正收益概率', value: `${pr.positiveRatePct}%`, threshold: '< 40%', asOf: navDate },
      watch: '为历史回溯统计，不代表未来；可结合持有 3 年的概率一并看待',
    });
  }

  /* ==================== 估值与位置 ==================== */
  const ct = metrics.costTiming || {};
  check('valuation_high');
  const vp = ct.valuation?.percentile5y;
  if (isNum(vp) && vp >= th.valuationHighPct) {
    hit('valuation_high', {
      severity: 'medium',
      desc: `重仓持仓加权估值处于近 5 年 ${vp}% 分位，位置偏高`,
      trigger: { label: '持仓估值历史分位', value: `${vp}%`, threshold: `≥ ${th.valuationHighPct}%`, asOf: ct.valuation.asOf || navDate },
      watch: '关注盈利增速能否消化当前估值；估值基于滞后披露的持仓',
    });
  } else if (ct.valuation?.available && !ct.valuation.percentileAvailable) {
    check('valuation_percentile_unavailable');
    hit('valuation_percentile_unavailable', {
      severity: 'low',
      desc: '持仓估值历史分位数据不可得，本项未做判断（仅提供当前加权 PE/PB）',
      trigger: { label: '估值历史分位', value: '数据不可得', threshold: `高位阈值 ${th.valuationHighPct}%`, asOf: navDate },
      watch: '可结合净值位置与行业估值水平自行判断',
    });
  }

  check('nav_high_position');
  const np = ct.navPosition?.percentile;
  // 债券/货币基金净值近似单调上升，区间分位天然接近 100%，不具备「位置偏高」含义，不做判断
  const navPositionMeaningful = fundType !== TYPE.BOND && fundType !== TYPE.MONEY;
  if (navPositionMeaningful && isNum(np) && np >= th.navHighPct) {
    hit('nav_high_position', {
      severity: 'low',
      desc: `复权净值处于近 ${ct.navPosition.windowYears} 年区间的 ${np}% 分位，位于区间高位`,
      trigger: { label: '净值区间分位', value: `${np}%`, threshold: `≥ ${th.navHighPct}%`, asOf: navDate },
      watch: '仅描述位置，不预示后续走势',
    });
  }

  check('surge_3m');
  const s3 = ct.navPosition?.recent3mPct;
  if (isNum(s3) && s3 > th.surge3mPct) {
    hit('surge_3m', {
      severity: 'low',
      desc: `近 3 个月净值上涨 ${s3}%，短期涨幅较大`,
      trigger: { label: '近3月涨幅', value: `${s3}%`, threshold: `> ${th.surge3mPct}%`, asOf: navDate },
      watch: '短期大幅上涨后波动通常放大，关注估值与拥挤度',
    });
  }

  /* ==================== 成本 ==================== */
  check('fee_high');
  if (ct.fee?.available && ct.fee.highFee) {
    hit('fee_high', {
      severity: 'low',
      desc: `年运作费率合计 ${ct.fee.annualRunningPct}%，高于该类型常见水平 ${th.totalFeeHighPct}%`,
      trigger: { label: '年运作费率', value: `${ct.fee.annualRunningPct}%`, threshold: `> ${th.totalFeeHighPct}%`, asOf: ct.fee.asOf },
      watch: '费率对长期收益的损耗是确定性的，可对照同类同标的产品的费率水平',
    });
  }

  /* ==================== 折溢价与流动性 ==================== */
  if (profile.onMarket) {
    check('premium_red');
    check('premium_warn');
    if (ct.premium?.available) {
      if (ct.premium.level === 'red') {
        hit('premium_red', {
          severity: 'high',
          hardRedLine: true,
          desc: `场内价格相对净值溢价 ${ct.premium.premiumPct}%，溢价回归时价格可能下跌而净值不变`,
          trigger: { label: '折溢价率', value: `${ct.premium.premiumPct}%`, threshold: `≥ ${th.premiumRedPct}%`, asOf: navDate },
          watch: '关注管理人是否发布溢价风险提示与停牌安排；溢价率按滞后净值估算',
        });
      } else if (ct.premium.level === 'warn') {
        hit('premium_warn', {
          severity: 'medium',
          desc: `场内价格相对净值溢价 ${ct.premium.premiumPct}%`,
          trigger: { label: '折溢价率', value: `${ct.premium.premiumPct}%`, threshold: `≥ ${th.premiumWarnPct}%`, asOf: navDate },
          watch: '关注溢价是否持续扩大，以及是否有限购导致的套利受阻',
        });
      }
    }

    check('turnover_low');
    if (ct.liquidity?.lowTurnover) {
      hit('turnover_low', {
        severity: 'medium',
        desc: `场内成交额约 ${ct.liquidity.turnoverWan} 万元，流动性偏弱，较大金额买卖可能造成明显冲击成本`,
        trigger: { label: '成交额', value: `${ct.liquidity.turnoverWan}万元`, threshold: `< ${th.turnoverLowWan}万元`, asOf: navDate },
        watch: '关注日均成交额变化；流动性弱的品种买卖价差通常更大',
      });
    }
  }

  check('lockup');
  if (isNum(profile.minHoldDays) && profile.minHoldDays > 0) {
    hit('lockup', {
      severity: 'low',
      desc: `本基金存在最短持有期 ${profile.minHoldDays} 天，期间无法赎回`,
      trigger: { label: '最短持有期', value: `${profile.minHoldDays} 天`, threshold: '> 0 天', asOf: profile.asOf },
      watch: '确认资金使用期限与最短持有期匹配',
    });
  }

  /* ==================== 跟踪偏离（指数/商品） ==================== */
  if (fundType === TYPE.INDEX_EQUITY || fundType === TYPE.COMMODITY) {
    check('tracking_error_high');
    check('tracking_unavailable');
    const te = ret.tracking;
    if (te?.available && isNum(te.annualPct) && te.annualPct > (te.contractLimitPct || th.trackingErrorHighPct)) {
      hit('tracking_error_high', {
        severity: 'medium',
        desc: `年化跟踪误差 ${te.annualPct}%，超过${te.contractLimitPct ? `基金合同约定的 ${te.contractLimitPct}%` : `参考阈值 ${th.trackingErrorHighPct}%`}`,
        trigger: { label: '年化跟踪误差', value: `${te.annualPct}%`, threshold: `> ${te.contractLimitPct || th.trackingErrorHighPct}%`, asOf: navDate },
        watch: '关注跟踪偏离的原因（如成分股停牌、申赎冲击、抽样复制）',
      });
    } else if (te && !te.available) {
      hit('tracking_unavailable', {
        severity: 'low',
        desc: `跟踪误差需要标的指数日频序列，公开接口不提供，本项未做判断${te.contractLimitPct ? `（基金合同约定年跟踪误差不超过 ${te.contractLimitPct}%）` : ''}`,
        trigger: { label: '年化跟踪误差', value: '数据不可得', threshold: te.contractLimitPct ? `合同约定 ≤ ${te.contractLimitPct}%` : `参考 ≤ ${th.trackingErrorHighPct}%`, asOf: navDate },
        watch: '可对照同标的其他指数基金的近一年收益差异做粗略判断',
      });
    }
  }

  /* ==================== 债券信用与杠杆 ==================== */
  if (fundType === TYPE.BOND || fundType === TYPE.HYBRID_BOND) {
    check('low_rating_high');
    check('leverage_high');
    check('duration_long');
    check('convertible_high');
    const d = ct.duration;
    if (d?.available) {
      if (isNum(d.lowRatingPct) && d.lowRatingPct > th.lowRatingPct) {
        hit('low_rating_high', {
          severity: 'high',
          desc: `AA 及以下评级债券占比 ${d.lowRatingPct}%，存在信用下沉特征`,
          trigger: { label: '低评级债占比', value: `${d.lowRatingPct}%`, threshold: `> ${th.lowRatingPct}%`, asOf: d.asOf },
          watch: '关注持仓债券的付息与兑付情况，以及是否出现评级下调',
        });
      }
      if (isNum(d.leveragePct) && d.leveragePct > th.leveragePct) {
        hit('leverage_high', {
          severity: 'medium',
          desc: `杠杆率 ${d.leveragePct}%，放大了利率波动与信用风险的影响`,
          trigger: { label: '杠杆率', value: `${d.leveragePct}%`, threshold: `> ${th.leveragePct}%`, asOf: d.asOf },
          watch: '关注资金利率上行时的负债成本与去杠杆压力',
        });
      }
      if (d.longDuration) {
        hit('duration_long', {
          severity: 'medium',
          desc: `组合久期 ${d.durationYear} 年，利率上行时净值回撤压力更大`,
          trigger: { label: '组合久期', value: `${d.durationYear} 年`, threshold: `> ${th.durationLongYear} 年`, asOf: d.asOf },
          watch: '关注 10 年期国债收益率变化与货币政策取向',
        });
      }
      if (isNum(d.convertiblePct) && d.convertiblePct > th.convertibleHighPct) {
        hit('convertible_high', {
          severity: 'medium',
          desc: `可转债占比 ${d.convertiblePct}%，权益属性较强，波动会明显高于纯债`,
          trigger: { label: '可转债占比', value: `${d.convertiblePct}%`, threshold: `> ${th.convertibleHighPct}%`, asOf: d.asOf },
          watch: '关注股市波动对本基金净值的传导',
        });
      }
    }
  }

  /* ==================== 合规与治理 ==================== */
  check('regulatory_notice');
  const reg = recentNotice('regulatory', 12);
  if (reg) {
    hit('regulatory_notice', {
      severity: 'high',
      desc: '近 12 个月内存在与监管处罚/问询/整改相关的公告',
      trigger: { label: '公告', value: reg.title, threshold: '不应存在监管处罚类公告', asOf: reg.date },
      watch: '以监管与管理人公告为准，关注事项进展及对基金运作的影响',
    });
  }

  check('litigation_notice');
  const lit = recentNotice('litigation', 12);
  if (lit) {
    hit('litigation_notice', {
      severity: 'medium',
      desc: '近 12 个月内存在诉讼或仲裁相关公告',
      trigger: { label: '公告', value: lit.title, threshold: '不应存在诉讼仲裁类公告', asOf: lit.date },
      watch: '关注诉讼进展及是否涉及基金资产',
    });
  }

  check('contract_change');
  const cc = recentNotice('contract_change', 6);
  if (cc) {
    hit('contract_change', {
      severity: 'low',
      desc: '近 6 个月内基金合同或招募说明书发生变更',
      trigger: { label: '公告', value: cc.title, threshold: '关注合同关键条款变化', asOf: cc.date },
      watch: '核对变更内容是否涉及投资范围、费率或申赎规则',
    });
  }

  /* ==================== 系统性 ==================== */
  check('market_high_percentile');
  const mp = bundle.market?.csi300Percentile;
  if (isNum(mp) && mp >= 80 && fundType !== TYPE.MONEY && fundType !== TYPE.BOND) {
    hit('market_high_percentile', {
      severity: 'low',
      desc: `宽基指数估值处于 ${mp}% 分位，市场整体位置偏高，权益类基金的回撤敏感度上升`,
      trigger: { label: '宽基估值分位', value: `${mp}%`, threshold: '≥ 80%', asOf: bundle.market.asOf },
      watch: '系统性风险影响全部权益类产品，非本基金特有',
    });
  }

  /* ==================== 透明度 ==================== */
  check('short_history');
  if (ret.shortHistory) {
    hit('short_history', {
      severity: 'medium',
      desc: `基金成立约 ${ret.monthsSinceStart} 个月，历史数据不足，回撤与滚动持有统计的样本代表性有限`,
      trigger: { label: '成立时长', value: `${ret.monthsSinceStart} 个月`, threshold: `< ${th.establishedShortMonths} 个月`, asOf: navDate },
      watch: '拉长观察期后再评估，短期业绩排名易受单一行情影响',
    });
  }

  check('holdings_stale');
  if (hold.available && hold.asOf) {
    const lag = dates.diffDays(navDate, hold.asOf);
    if (isNum(lag) && lag > 120) {
      hit('holdings_stale', {
        severity: 'low',
        desc: `最新可得持仓报告期为 ${hold.asOf}，距今 ${lag} 天，持仓可能已发生较大变化`,
        trigger: { label: '持仓披露滞后', value: `${lag} 天`, threshold: '> 120 天', asOf: hold.asOf },
        watch: '等待下一期定期报告披露后复核持仓与估值结论',
      });
    }
  }

  check('data_incomplete');
  if (completeness && completeness.missing && completeness.missing.length >= 3) {
    hit('data_incomplete', {
      severity: 'low',
      desc: `本次分析有 ${completeness.missing.length} 项公开数据缺失：${completeness.missing.join('、')}`,
      trigger: {
        label: '数据完整度',
        value: `${completeness.available}/${completeness.total}`,
        threshold: '缺失项 ≥ 3 项时提示',
        asOf: navDate,
      },
      watch: '缺失项对应的子模块未做判断，相关结论请结合基金定期报告核对',
    });
  }

  /* ==================== 等级判定 ==================== */
  const hardRedLines = findings.filter((f) => f.hardRedLine);
  const highs = findings.filter((f) => f.severity === 'high');
  const mediums = findings.filter((f) => f.severity === 'medium');
  const level = hardRedLines.length || highs.length ? 'red' : mediums.length ? 'yellow' : 'green';

  // 严重度降序
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    level,
    findings,
    hardRedLines: hardRedLines.map((f) => ({ key: f.key, title: f.title })),
    checkedItems: checked,
    checkedCount: checked.length,
    summaryStat: {
      high: highs.length,
      medium: mediums.length,
      low: findings.filter((f) => f.severity === 'low').length,
      total: findings.length,
    },
    thresholds: th,
    greenNote:
      level === 'green'
        ? `基于已获取的公开数据，未发现以下 ${checked.length} 类异常。「未发现」不等于「安全」，仅代表在已检查项目与当前数据完整度下无异常触发`
        : null,
  };
}

module.exports = { scan, RULES, CATEGORY_LABELS };
