'use strict';
/**
 * 好舵手（板块③）指标计算 —— 舵手分 M
 *
 * 核心原则（需求 C-2 / C-5）：
 *  - 严格区分「基金历史业绩」与「现任经理任职期业绩」，现任任职过短必须提示且限制得分上限
 *  - 数据切片不含基金收益排名与净值排行，只用任职期区间业绩与同期同类/沪深300 对照，
 *    避免「涨得好 = 经理牛」的循环论证
 *  - 被动指数/货币/商品型不做经理能力评分，M 分显式为 null 并说明原因（S-8）
 */
const dates = require('../utils/dates');
const { isNum, round, mean, scoreLinear, weightedScore } = require('../utils/num');
const { thresholdsFor } = require('../config/riskRules');
const { weightsOf, isApplicable, naReason, TYPE } = require('../config/fundTypes');

function compute(bundle, holdingsSummary) {
  const profile = bundle.profile;
  const fundType = profile.fundType;
  const th = thresholdsFor(fundType);
  const navDate = profile.navDate || (bundle.nav.length ? bundle.nav[bundle.nav.length - 1].date : null);
  const managers = (bundle.managers || []).filter((m) => m && m.current);
  const past = bundle.pastManagerTerms || [];

  /* -------- 类型不适用：显式 null + 原因 -------- */
  if (!isApplicable(fundType, 'good_manager')) {
    return {
      applicable: false,
      score: null,
      reason: naReason(fundType, 'manager'),
      // 仍然给出可核验的团队与运作稳定性事实，供板块展示
      team: {
        managers: managers.map((m) => ({
          name: m.name,
          startDate: m.startDate,
          tenureYears: m.tenureYears,
          fundCount: m.fundCount,
          aumYi: m.aumYi,
        })),
        changeCount3y: past.filter((t) => t.endDate && dates.diffDays(navDate, t.endDate) <= 365 * 3).length,
        company: profile.company || null,
      },
      changeHistory: past,
    };
  }

  if (!managers.length) {
    return {
      applicable: true,
      insufficient: true,
      reason: '未获取到现任基金经理信息',
      score: null,
      subScores: {},
      changeHistory: past,
    };
  }

  /* -------- 任职与经验 -------- */
  const primary = managers
    .slice()
    .sort((a, b) => (b.tenureYears || 0) - (a.tenureYears || 0))[0];
  const tenureYears = primary.tenureYears;
  const tenureMonths = isNum(tenureYears) ? Math.round(tenureYears * 12) : null;
  const isNewManager = isNum(tenureMonths) && tenureMonths < th.newManagerMonths;
  const isVeryNewManager = isNum(tenureMonths) && tenureMonths < th.newManagerRedMonths;
  const coManaged = managers.length > 1;

  /* -------- 任职期表现（与同期同类、沪深300 对照） -------- */
  const tenurePerf = {
    returnPct: primary.tenureReturnPct ?? null,
    peerAvgPct: primary.tenurePeerPct ?? null,
    hs300Pct: primary.tenureHs300Pct ?? null,
    excessVsPeerPp:
      isNum(primary.tenureReturnPct) && isNum(primary.tenurePeerPct)
        ? round(primary.tenureReturnPct - primary.tenurePeerPct, 2)
        : null,
    excessVsHs300Pp:
      isNum(primary.tenureReturnPct) && isNum(primary.tenureHs300Pct)
        ? round(primary.tenureReturnPct - primary.tenureHs300Pct, 2)
        : null,
    from: primary.startDate,
    to: navDate,
    spanText: primary.tenureSpanText || null,
  };
  // 任职期年化超额（便于跨任期可比）
  const tenureDays = primary.startDate ? dates.diffDays(navDate, primary.startDate) : null;
  if (isNum(tenurePerf.returnPct) && isNum(tenureDays) && tenureDays > 200) {
    const yrs = tenureDays / 365;
    const ann = (v) => (isNum(v) && 1 + v / 100 > 0 ? round(((1 + v / 100) ** (1 / yrs) - 1) * 100, 2) : null);
    tenurePerf.annualizedPct = ann(tenurePerf.returnPct);
    tenurePerf.peerAnnualizedPct = ann(tenurePerf.peerAvgPct);
    tenurePerf.annualExcessVsPeerPp =
      isNum(tenurePerf.annualizedPct) && isNum(tenurePerf.peerAnnualizedPct)
        ? round(tenurePerf.annualizedPct - tenurePerf.peerAnnualizedPct, 2)
        : null;
  }

  /* -------- 精力分配（一拖多） -------- */
  const fundCount = primary.fundCount ?? null;
  const aumYi = primary.aumYi ?? null;
  const workload = {
    fundCount,
    aumYi,
    fundCountThreshold: th.managerFundCount,
    aumThresholdYi: th.managerAumYi,
    overloaded: (isNum(fundCount) && fundCount > th.managerFundCount) || (isNum(aumYi) && aumYi > th.managerAumYi),
    note: '阈值为平台可配置参数（见评分口径页），非行业官方标准；指数型基金一拖多为常态，阈值已单独设定',
  };

  /* -------- 风格一致性（来自持仓漂移） -------- */
  const drift = holdingsSummary?.drift || { available: false };
  const consistency = {
    available: Boolean(drift.available),
    deviationPct: drift.available ? drift.deviationPct : null,
    level: drift.available ? drift.level : null,
    turnoverPct: holdingsSummary?.turnoverPct ?? null,
    reason: drift.available ? null : drift.reason,
  };

  /* -------- 变更历史 -------- */
  const changes3y = past.filter((t) => t.endDate && (dates.diffDays(navDate, t.endDate) ?? 9999) <= 365 * 3);
  const changeHistoryStat = {
    totalTerms: past.length + 1,
    changeCount3y: changes3y.length,
    frequentChange: changes3y.length >= th.managerChangeTimes3y,
    threshold: th.managerChangeTimes3y,
    latestChangeDate: past.length ? past[0].endDate : null,
  };

  /* -------- 代表作（其他在管产品） -------- */
  const otherFunds = primary.otherFunds || [];

  /* -------- 舵手分 M -------- */
  const w = weightsOf('manager', fundType) || weightsOf('manager', 'default');
  const subScores = {
    tenure: scoreLinear(tenureYears, 0.3, 8),
    tenurePerf: scoreLinear(
      tenurePerf.annualExcessVsPeerPp ?? tenurePerf.excessVsPeerPp,
      -15,
      15
    ),
    workload: (() => {
      const a = isNum(fundCount) ? scoreLinear(fundCount, th.managerFundCount * 1.8, 2) : null;
      const b = isNum(aumYi) ? scoreLinear(aumYi, th.managerAumYi * 1.6, 10) : null;
      const vals = [a, b].filter(isNum);
      return vals.length ? Math.round(mean(vals)) : null;
    })(),
    consistency: consistency.available
      ? scoreLinear(consistency.deviationPct, th.styleDriftSeverePct, 5)
      : null,
  };
  const parts = Object.entries(w).map(([k, weight]) => ({ score: subScores[k], weight }));
  let { score, missing } = weightedScore(parts);

  // 现任任职不足 1 年：历史业绩主要由前任创造，得分上限受约束（C-2）
  const tenureCapped = isNum(tenureYears) && tenureYears < 1;
  if (score !== null && tenureCapped) score = Math.min(score, 55);
  if (score !== null && changeHistoryStat.frequentChange) score = Math.min(score, 60);

  const tag =
    score === null
      ? '数据不足'
      : isVeryNewManager
        ? '新任待观察'
        : changeHistoryStat.frequentChange
          ? '频繁更换需警惕'
          : isNum(tenureYears) && tenureYears >= 5 && score >= 65
            ? '稳健老将'
            : score >= 65
              ? '成长中'
              : '一般';

  const notes = [];
  if (tenureCapped) {
    notes.push(
      `现任基金经理任职本基金约 ${tenureMonths} 个月，基金过往业绩主要由前任创造，历史业绩对当前的参考价值有限`
    );
  }
  if (coManaged) notes.push(`本基金由 ${managers.length} 位基金经理共同管理，任职时长与业绩需分别看待`);
  if (workload.overloaded) {
    notes.push(
      `现任基金经理在管 ${isNum(fundCount) ? `${fundCount} 只` : '多只'}基金${isNum(aumYi) ? `、合计约 ${aumYi} 亿元` : ''}，超过平台设定阈值`
    );
  }

  return {
    applicable: true,
    insufficient: false,
    score,
    subScores,
    weights: w,
    missingSubModules: missing,
    tag,
    scoreCapped: tenureCapped || changeHistoryStat.frequentChange,
    managers: managers.map((m) => ({
      name: m.name,
      startDate: m.startDate,
      tenureYears: m.tenureYears,
      tenureSpanText: m.tenureSpanText,
      workYears: m.workYears,
      fundCount: m.fundCount,
      aumYi: m.aumYi,
      tenureReturnPct: m.tenureReturnPct,
      tenurePeerPct: m.tenurePeerPct,
      tenureHs300Pct: m.tenureHs300Pct,
      bio: m.bio || null,
    })),
    primaryManager: primary.name,
    tenure: {
      years: tenureYears,
      months: tenureMonths,
      startDate: primary.startDate,
      workYears: primary.workYears ?? null,
      isNew: isNewManager,
      isVeryNew: isVeryNewManager,
      newThresholdMonths: th.newManagerMonths,
      // 是否经历过完整牛熊：以任职是否覆盖 3 年以上为粗略判断，并明确说明口径
      coveredFullCycle: isNum(tenureYears) ? tenureYears >= 3 : null,
      cycleNote: '以任职满 3 年作为「大致经历一轮完整涨跌」的粗略判断口径，非严格的牛熊周期划分',
    },
    tenurePerf,
    workload,
    consistency,
    changeHistory: past,
    changeStat: changeHistoryStat,
    otherFunds,
    coManaged,
    notes,
    company: { name: profile.company || null },
  };
}

module.exports = { compute };
