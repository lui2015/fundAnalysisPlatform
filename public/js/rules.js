/* 评分口径页：公开四刻度权重、风险规则清单、按类型差异化阈值与硬红线 */
(function () {
  'use strict';
  const U = window.U;
  const el = U.el;

  U.initTheme();
  U.$('#disclaimer-text').textContent = U.DISCLAIMER_TEXT;

  const DIM_LABEL = {
    longTerm: '长期业绩', excess: '超额来源', stability: '业绩稳定性', holdingStyle: '持仓与风格',
    tracking: '跟踪能力', scaleLiquidity: '规模与流动性',
    tenure: '任职与经验', tenurePerf: '任职期表现', workload: '精力分配', consistency: '风格一致性',
    drawdown: '回撤深度', recovery: '回撤修复', volatility: '波动水平', riskAdjusted: '风险调整后收益', positiveRate: '持有正收益概率',
    valuation: '持仓估值位置', navPosition: '净值位置', fee: '费率与成本', scaleStatus: '规模与申赎状态', duration: '久期与利率环境',
  };

  function card(title, nodes, sub) {
    return el('section', { class: 'card' }, [
      el('div', { class: 'section-title', style: { marginTop: '0' } }, [el('span', { text: title }), sub ? el('small', { text: sub }) : null]),
    ].concat(nodes));
  }

  function weightTable(table, typeLabels) {
    const types = Object.keys(table).filter(function (k) { return k !== 'default'; });
    const keys = {};
    Object.keys(table).forEach(function (t) { Object.keys(table[t] || {}).forEach(function (k) { keys[k] = 1; }); });
    const cols = Object.keys(keys);
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', null, [el('tr', null, [el('th', { text: '基金类型' })].concat(cols.map(function (c) { return el('th', { text: DIM_LABEL[c] || c }); })))]),
        el('tbody', null, (table.default ? ['default'] : []).concat(types).map(function (t) {
          return el('tr', null, [el('td', { text: t === 'default' ? '默认' : (typeLabels[t] || t) })].concat(
            cols.map(function (c) {
              const v = (table[t] || {})[c];
              return el('td', { class: 'num', text: U.isNum(v) ? Math.round(v * 100) + '%' : '—' });
            })
          ));
        })),
      ]),
    ]);
  }

  U.api('rules').then(function (r) {
    const d = r.data;
    U.$('#statement').textContent = d.statement;
    const box = U.$('#content');
    const typeLabels = {};
    (d.fundTypes || []).forEach(function (t) { typeLabels[t.key] = t.label; });

    // 四刻度说明
    box.appendChild(card('四刻度 + 风险灯', [
      el('div', { class: 'kv' }, (d.dimensions || []).map(function (x) {
        return el('div', { class: 'kv__row' }, [
          el('span', { class: 'kv__k', text: x.label }),
          el('span', { style: { textAlign: 'right', fontSize: '13px' }, text: x.question }),
        ]);
      })),
    ], '刻意不给单一综合总分'));

    // 各维度权重
    ['ability', 'manager', 'experience', 'timingCost'].forEach(function (k) {
      const label = { ability: '能力分 A', manager: '舵手分 M', experience: '体验分 X', timingCost: '时机成本分 T' }[k];
      if (!d.scoreWeights[k]) return;
      box.appendChild(card(label + ' 的子模块权重', [
        weightTable(d.scoreWeights[k], typeLabels),
        el('div', { class: 'chart-note', text: '子模块数据缺失时，其权重会按剩余项归一化，不会用默认值填补；缺失情况在报告中标注为「数据完整度」。' }),
      ]));
    });

    // 类型差异化矩阵
    box.appendChild(card('基金类型差异化矩阵', [
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, ['基金类型', '好业绩', '好舵手', '好体验', '好时机与成本', '风险侧重'].map(function (t) { return el('th', { text: t }); }))]),
          el('tbody', null, (d.fundTypes || []).map(function (t) {
            const p = t.policy || {};
            const map = { full: '全量', slim: '精简', replace: '替代口径', na: '不适用' };
            return el('tr', null, [
              el('td', { text: t.label }),
              el('td', { text: map[p.good_performance] || '—' }),
              el('td', { text: map[p.good_manager] || '—' }),
              el('td', { text: map[p.good_experience] || '—' }),
              el('td', { text: map[p.timing_cost] || '—' }),
              el('td', { text: (p.riskFocus || []).join('、') }),
            ]);
          })),
        ]),
      ]),
      el('div', { class: 'chart-note', text: '「不适用」的维度在报告中显式置为不适用并说明原因，不会用 0 分或默认分代替。类型识别失败时平台会拒绝分析，不用权益模板兜底非权益基金。' }),
    ]));

    // 硬红线
    box.appendChild(card('硬红线（命中即判定风险红灯，总览必须警示）', [
      el('ul', { style: { margin: '0', paddingLeft: '18px', fontSize: '13px', lineHeight: '2' } },
        (d.hardRedLines || []).map(function (t) { return el('li', { text: t }); })),
    ]));

    // 风险规则清单
    const byCat = {};
    (d.riskRules || []).forEach(function (x) {
      if (!byCat[x.categoryLabel]) byCat[x.categoryLabel] = [];
      byCat[x.categoryLabel].push(x);
    });
    const hits = {};
    (d.riskRuleHitStats || []).forEach(function (x) { hits[x.key] = x.hits; });
    box.appendChild(card('风险规则清单（共 ' + (d.riskRuleCount || 0) + ' 条）', Object.keys(byCat).map(function (cat) {
      return el('div', { class: 'module' }, [
        el('div', { class: 'module__h', text: cat + '（' + byCat[cat].length + ' 条）' }),
        el('ul', { class: 'module__p' }, byCat[cat].map(function (x) {
          return el('li', { text: x.title + (hits[x.key] ? '（历史命中 ' + hits[x.key] + ' 次）' : '') });
        })),
      ]);
    }).concat([
      el('div', { class: 'chart-note', text: '雷点由规则引擎按阈值扫描产出，模型只负责解释，不能自行新增雷点。每条雷点包含风险描述、触发依据、严重程度与关注建议四要素。' }),
    ])));

    // 阈值
    const base = d.thresholdsBase || {};
    box.appendChild(card('通用阈值（可通过 data/risk-thresholds.json 覆盖）', [
      el('div', { class: 'kv' }, Object.keys(base).map(function (k) {
        return el('div', { class: 'kv__row' }, [
          el('span', { class: 'kv__k', text: k }),
          el('span', { class: 'kv__v', text: String(base[k]) }),
        ]);
      })),
    ]));

    const byType = d.thresholdsByType || {};
    box.appendChild(card('按基金类型覆盖的阈值', Object.keys(byType).map(function (t) {
      return el('div', { class: 'module' }, [
        el('div', { class: 'module__h', text: typeLabels[t] || t }),
        el('ul', { class: 'module__p' }, Object.keys(byType[t]).map(function (k) {
          return el('li', { text: k + ' = ' + byType[t][k] });
        })),
      ]);
    }).concat([
      el('div', { class: 'chart-note', text: '差异化的意义：债基负债与回撤阈值、货币基金规模阈值、指数基金一拖多阈值与权益基金完全不同，套用同一套阈值必然误报。' }),
    ])));

    // 合规禁用词
    box.appendChild(card('合规禁用词库', [
      el('div', { style: { fontSize: '13px', lineHeight: '2' }, text: (d.complianceDenyList || []).join('、') }),
      el('div', { class: 'chart-note', text: '模型输出命中上述词汇时会被改写为中性表述并记入审计日志。「买入并持有 N 年」等统计口径描述属于受保护短语，不会被改写。' }),
    ]));

    // 工程说明
    box.appendChild(card('工程约束', [
      el('ul', { style: { margin: '0', paddingLeft: '18px', fontSize: '13px', lineHeight: '2' } },
        (d.notes || []).map(function (t) { return el('li', { text: t }); })),
    ]));
  }).catch(function (e) {
    U.$('#statement').textContent = '规则数据加载失败：' + e.message;
  });
})();
