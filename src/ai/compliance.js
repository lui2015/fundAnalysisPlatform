'use strict';
/**
 * 合规过滤（需求 F3-9 / 附录 B）
 *
 * 基金场景的合规边界比个股解读更严：不得推荐基金、不得预测收益、不得给申赎时点与份额选择建议、
 * 不得使用「明星基金经理」等营销化措辞、不得与官方评级混淆。
 * 两层处理：先短语级中性改写，再词级兜底；每次命中都写 compliance_log 以便审计。
 */
const db = require('../db');
const logger = require('../utils/logger');

/** 短语规则（顺序敏感，先长后短） */
const PHRASE_RULES = [
  // —— 操作建议类 ——
  [/建议(买入|购入|申购|加仓|买进|上车)/g, '当前数据呈现偏积极特征'],
  [/建议(卖出|赎回|减仓|清仓|离场|止盈|止损)/g, '当前数据呈现偏谨慎特征'],
  [/(建议|可以|适合)(定投|分批买入|分批建仓)/g, '历史数据可用于观察分批投入的收益分布'],
  [/(值得|适合|可以)(买入|入手|申购|介入|布局|配置|持有)/g, '相关指标当前处于以下状态'],
  [/(逢低|择机|分批)(买入|申购|介入|布局)/g, '价格处于区间下沿时的数据特征'],
  [/(可以|建议)(选择|优先选)\s*[ACE]\s*类/g, '两类份额的成本对照事实如下'],
  [/(应该|建议)(长期持有|持有\d+年)/g, '历史持有期与收益分布的关系如下'],
  [/(现在|当前)(是|为)(买入|加仓|建仓)(的)?(好)?(时机|时点)/g, '当前价格位置的客观描述如下'],
  [/(抄底|逃顶|波段操作|高抛低吸)/g, '在区间极值附近交易'],
  [/(加仓|减仓|清仓|建仓|止损位|止盈位|仓位建议)/g, '仓位调整（本平台不提供操作建议）'],

  // —— 收益承诺与预测类 ——
  [/(预计|预期|有望)(收益|涨幅|回报)[^，。；]{0,12}/g, '（本平台不预测收益）'],
  [/(收益|回报)(可达|将达|能达到)\s*[\d.]+\s*%/g, '（本平台不预测收益）'],
  [/(目标净值|目标收益率|合理净值)[为是]?\s*[\d.]+/g, '（本平台不提供目标值）'],
  [/(必涨|稳赚|包赚|无风险|保本|一定会涨|肯定上涨|旱涝保收)/g, '存在不确定性'],
  [/(翻倍|暴涨|躺赚|稳稳的幸福)/g, '波动幅度可能较大'],
  [/(未来|后续)(将|会|大概率)(上涨|下跌|走强|走弱)/g, '后续走势存在不确定性'],

  // —— 推荐与评级类 ——
  [/(强烈推荐|重点推荐|首推|最佳选择|首选|不二之选|闭眼买)/g, '数据表现相对突出'],
  [/(明星基金经理|顶流基金经理|顶流|公募一哥|公募一姐|王牌基金经理)/g, '该基金经理'],
  [/(五星基金|四星基金|金牛基金|评级为?[五四三]星)/g, '（本平台不提供评级）'],
  [/(必买|必选)(清单|名单)?/g, '数据表现相对突出的品种'],
  [/(推荐|安利)(这只|该|此)?基金/g, '对该基金的数据解读如下'],
];

/** 残留禁用词兜底 */
const WORD_RULES = [
  [/买入/g, '偏积极信号'],
  [/卖出/g, '偏谨慎信号'],
  [/赎回时机/g, '流动性安排'],
  [/看多/g, '数据偏强'],
  [/看空/g, '数据偏弱'],
  [/割肉/g, '止损性卖出（本平台不提供操作建议）'],
];

/** 禁用词库（供 Prompt 声明与规则页展示） */
const DENY_KEYWORDS = [
  '买入', '卖出', '申购', '赎回', '加仓', '减仓', '清仓', '抄底', '逃顶', '止盈', '止损',
  '建议定投', '值得买', '可以上车', '必涨', '稳赚', '保本', '无风险', '翻倍',
  '收益可达', '预计收益', '目标净值', '明星基金经理', '顶流', '最佳选择', '首选', '推荐',
  '五星基金', '金牛基金',
];

/**
 * 受保护短语：这些表述是**统计口径描述**而非操作建议，不能被改写。
 * 例如「历史上任一交易日买入并持有 1 年的正收益比例」是滚动持有概率的标准定义，
 * 若把其中的「买入」改写掉会让本产品最核心的指标失去可读性（实测已发生）。
 */
const PROTECTED_PHRASES = ['买入并持有', '任一交易日买入', '买入并长期持有', '申购赎回费率', '申购状态', '赎回状态', '暂停申购', '暂停赎回', '限制大额申购', '巨额赎回', '申购费', '赎回费', '申购限额'];

function protect(text) {
  let out = text;
  const marks = [];
  PROTECTED_PHRASES.forEach((p, i) => {
    if (out.includes(p)) {
      const mark = `\u0001P${i}\u0001`;
      out = out.split(p).join(mark);
      marks.push([mark, p]);
    }
  });
  return { text: out, marks };
}

function restore(text, marks) {
  let out = text;
  for (const [mark, p] of marks) out = out.split(mark).join(p);
  return out;
}

function filterText(text) {
  if (typeof text !== 'string' || !text) return { text, hits: [] };
  const p = protect(text);
  let out = p.text;
  const hits = [];
  for (const [re, rep] of PHRASE_RULES) {
    const m = out.match(re);
    if (m) {
      hits.push(...m);
      out = out.replace(re, rep);
    }
  }
  for (const [re, rep] of WORD_RULES) {
    const m = out.match(re);
    if (m) {
      hits.push(...m);
      out = out.replace(re, rep);
    }
  }
  return { text: restore(out, p.marks), hits: [...new Set(hits)] };
}

function filterDeep(value, path = '') {
  const hits = [];
  if (typeof value === 'string') {
    const r = filterText(value);
    if (r.hits.length) hits.push({ path, original: value, rewritten: r.text, words: r.hits });
    return { value: r.text, hits };
  }
  if (Array.isArray(value)) {
    const arr = value.map((v, i) => {
      const r = filterDeep(v, `${path}[${i}]`);
      hits.push(...r.hits);
      return r.value;
    });
    return { value: arr, hits };
  }
  if (value && typeof value === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value)) {
      const r = filterDeep(v, path ? `${path}.${k}` : k);
      hits.push(...r.hits);
      obj[k] = r.value;
    }
    return { value: obj, hits };
  }
  return { value, hits };
}

/** 对板块结果做合规过滤并落审计日志 */
function sanitizeSection(sectionKey, payload, code) {
  const { value, hits } = filterDeep(payload);
  for (const h of hits) {
    try {
      db.logCompliance({ code, section: sectionKey, kind: h.words.join(','), original: h.original, rewritten: h.rewritten });
    } catch (e) {
      logger.warn('合规日志写入失败', { error: e.message });
    }
  }
  if (hits.length) {
    logger.warn('模型输出命中合规规则并已改写', {
      code,
      section: sectionKey,
      count: hits.length,
      words: [...new Set(hits.flatMap((h) => h.words))].slice(0, 10),
    });
  }
  return { value, hitCount: hits.length };
}

function denyListText() {
  return DENY_KEYWORDS.join('、');
}

module.exports = { filterText, filterDeep, sanitizeSection, denyListText, DENY_KEYWORDS };
