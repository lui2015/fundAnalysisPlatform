'use strict';
/**
 * 内置基金字典
 *
 * 用途：
 *  1) 搜索兜底与拼音首字母支持（远程搜索接口不返回拼音，F1-1）
 *  2) A/C 份额分组（F1-3）
 *  3) 演示数据（DATA_MODE=mock / auto 回退）的生成种子
 *
 * 说明：字段为公开可查的基金基础信息；净值等行情数据一律走数据源或演示生成，不在此硬编码。
 */

/**
 * seed 用于演示数据生成（决定净值走势特征），字段含义：
 *  ann 年化中枢(%) / vol 年化波动(%) / mdd 目标最大回撤(%) / start 成立日
 */
const FUNDS = [
  // ===== 主动权益 =====
  { code: '110022', name: '易方达消费行业股票', company: '易方达基金', typeText: '股票型', py: 'yfdxfhy', benchmark: '中证内地消费主题指数收益率×95%+活期存款利率×5%', start: '2010-08-20', seed: { ann: 13.5, vol: 24, mdd: 46 } },
  { code: '005827', name: '易方达蓝筹精选混合', company: '易方达基金', typeText: '混合型-偏股', py: 'yfdlcjx', benchmark: '沪深300指数收益率×45%+恒生指数收益率×35%+中债总指数×20%', start: '2018-09-05', seed: { ann: 8.2, vol: 26, mdd: 52 } },
  { code: '003096', name: '中欧医疗健康混合A', company: '中欧基金', typeText: '混合型-偏股', py: 'zoyljkA', benchmark: '中证医药卫生指数收益率×85%+中债总指数×15%', start: '2016-09-29', seed: { ann: 11.8, vol: 30, mdd: 58 } },
  { code: '163406', name: '兴全合润混合', company: '兴证全球基金', typeText: '混合型-灵活配置', py: 'xqhr', benchmark: '沪深300指数收益率×80%+中债总指数×20%', start: '2010-04-22', seed: { ann: 14.2, vol: 25, mdd: 44 } },
  { code: '000001', name: '华夏成长混合', company: '华夏基金', typeText: '混合型-灵活配置', py: 'hxcz', benchmark: '沪深300指数收益率×60%+中债总指数×40%', start: '2001-12-18', seed: { ann: 9.1, vol: 22, mdd: 41 } },
  { code: '519674', name: '银河创新成长混合A', company: '银河基金', typeText: '混合型-偏股', py: 'yhcxczA', benchmark: '沪深300指数收益率×80%+中债总指数×20%', start: '2010-08-11', seed: { ann: 12.4, vol: 32, mdd: 55 } },

  // ===== 被动指数 =====
  { code: '161725', name: '招商中证白酒指数A', company: '招商基金', typeText: '指数型-股票', py: 'zszzbjA', benchmark: '中证白酒指数收益率×95%+银行活期存款利率（税后）×5%', start: '2015-05-27', tracks: '中证白酒指数', seed: { ann: 10.6, vol: 31, mdd: 51 } },
  { code: '012414', name: '招商中证白酒指数C', company: '招商基金', typeText: '指数型-股票', py: 'zszzbjC', benchmark: '中证白酒指数收益率×95%+银行活期存款利率（税后）×5%', start: '2021-04-29', tracks: '中证白酒指数', seed: { ann: 2.1, vol: 31, mdd: 48 } },
  { code: '110020', name: '易方达沪深300ETF联接A', company: '易方达基金', typeText: '指数型-股票', py: 'yfdhs300A', benchmark: '沪深300指数收益率×95%+银行活期存款利率×5%', start: '2009-08-26', tracks: '沪深300指数', seed: { ann: 6.4, vol: 20, mdd: 46 } },
  { code: '510300', name: '华泰柏瑞沪深300ETF', company: '华泰柏瑞基金', typeText: '指数型-股票ETF', py: 'htbrhs300etf', benchmark: '沪深300指数收益率', start: '2012-05-04', tracks: '沪深300指数', onMarket: true, seed: { ann: 6.8, vol: 20, mdd: 45 } },
  { code: '001593', name: '天弘中证银行指数A', company: '天弘基金', typeText: '指数型-股票', py: 'thzzyhA', benchmark: '中证银行指数收益率×95%+银行活期存款利率×5%', start: '2015-07-08', tracks: '中证银行指数', seed: { ann: 5.2, vol: 18, mdd: 34 } },
  { code: '000961', name: '天弘沪深300指数A', company: '天弘基金', typeText: '指数型-股票', py: 'thhs300A', benchmark: '沪深300指数收益率×95%+银行活期存款利率×5%', start: '2015-02-11', tracks: '沪深300指数', seed: { ann: 4.9, vol: 20, mdd: 44 } },

  // ===== 债券 =====
  { code: '050027', name: '博时信用债纯债A', company: '博时基金', typeText: '债券型-长债', py: 'bsxydczA', benchmark: '中债企业债总全价指数收益率', start: '2012-06-12', seed: { ann: 4.6, vol: 2.4, mdd: 4.2 } },
  { code: '000032', name: '易方达信用债债券A', company: '易方达基金', typeText: '债券型-长债', py: 'yfdxydA', benchmark: '中债信用债总指数收益率', start: '2013-04-09', seed: { ann: 5.1, vol: 2.8, mdd: 5.1 } },
  { code: '003547', name: '安信目标收益债券A', company: '安信基金', typeText: '债券型-混合二级', py: 'axmbsyA', benchmark: '中债综合全价指数收益率', start: '2017-01-24', seed: { ann: 5.4, vol: 4.2, mdd: 7.8 } },

  // ===== 偏债混合 =====
  { code: '002834', name: '广发稳健优选混合A', company: '广发基金', typeText: '混合型-偏债', py: 'gfwjyxA', benchmark: '中债综合指数收益率×70%+沪深300指数收益率×30%', start: '2016-08-11', seed: { ann: 6.2, vol: 8.5, mdd: 14 } },

  // ===== QDII =====
  { code: '270042', name: '广发纳斯达克100指数A', company: '广发基金', typeText: 'QDII-指数', py: 'gfnsdk100A', benchmark: '纳斯达克100指数收益率（人民币计价）', start: '2012-08-15', tracks: '纳斯达克100指数', seed: { ann: 17.2, vol: 24, mdd: 35 } },
  { code: '164906', name: '交银中证海外中国互联网', company: '交银施罗德基金', typeText: 'QDII-指数LOF', py: 'jyzzhwzghlw', benchmark: '中证海外中国互联网指数收益率', start: '2016-05-27', tracks: '中证海外中国互联网指数', onMarket: true, seed: { ann: 2.4, vol: 30, mdd: 62 } },

  // ===== FOF =====
  { code: '007193', name: '兴全优选进取三个月持有A', company: '兴证全球基金', typeText: 'FOF', py: 'xqyxjqA', benchmark: '沪深300指数收益率×60%+中债总指数×40%', start: '2019-06-27', seed: { ann: 6.1, vol: 14, mdd: 24 } },

  // ===== 货币 =====
  { code: '000198', name: '天弘余额宝货币', company: '天弘基金', typeText: '货币型', py: 'thyebhb', benchmark: '七天通知存款利率（税后）', start: '2013-05-29', seed: { ann: 1.9, vol: 0.12, mdd: 0.02 } },
  { code: '040046', name: '华安日日鑫货币A', company: '华安基金', typeText: '货币型', py: 'harrxhbA', benchmark: '七天通知存款利率（税后）', start: '2012-12-17', seed: { ann: 2.1, vol: 0.12, mdd: 0.02 } },

  // ===== 商品 =====
  { code: '518880', name: '华安黄金ETF', company: '华安基金', typeText: '商品型-黄金ETF', py: 'hahjetf', benchmark: 'Au99.99合约收益率', start: '2013-07-18', tracks: '上海金交所Au99.99', onMarket: true, seed: { ann: 8.4, vol: 14, mdd: 20 } },
  { code: '000216', name: '华安易富黄金ETF联接A', company: '华安基金', typeText: '商品型-黄金', py: 'hayfhjA', benchmark: 'Au99.99合约收益率', start: '2013-08-05', tracks: '上海金交所Au99.99', seed: { ann: 8.1, vol: 14, mdd: 20 } },
];

const BY_CODE = new Map(FUNDS.map((f) => [f.code, f]));

function get(code) {
  return BY_CODE.get(String(code)) || null;
}

function all() {
  return FUNDS;
}

/**
 * 本地搜索：支持名称、代码、拼音首字母、公司名
 * @returns {Array} 命中列表（含匹配得分排序）
 */
function search(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const f of FUNDS) {
    const name = f.name.toLowerCase();
    const py = (f.py || '').toLowerCase();
    let score = 0;
    if (f.code === q) score = 100;
    else if (f.code.startsWith(q)) score = 90;
    else if (name === q) score = 88;
    else if (py === q) score = 86;
    else if (name.includes(q)) score = 70 - name.indexOf(q);
    else if (py.startsWith(q)) score = 65;
    else if (py.includes(q)) score = 55;
    else if (f.company.toLowerCase().includes(q)) score = 40;
    if (score > 0) scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ f }) => ({
      code: f.code,
      name: f.name,
      typeText: f.typeText,
      company: f.company,
      onMarket: Boolean(f.onMarket),
    }));
}

module.exports = { FUNDS, get, all, search };
