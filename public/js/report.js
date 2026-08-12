/* 报告页：SSE 流式上屏 + 六板块渲染 + 双端导航
   安全：全部使用 textContent 赋值，不使用 innerHTML（S-4） */
(function () {
  'use strict';
  const U = window.U;
  const el = U.el;

  const SECTIONS = [
    { key: 'overview', n: '01', title: '总览', q: '这只基金现在整体是什么情况？', short: '总览', dim: null },
    { key: 'good_performance', n: '02', title: '好业绩', q: '它到底赚不赚钱、超额从哪来？', short: '业绩', dim: 'ability', dimLabel: 'A' },
    { key: 'good_manager', n: '03', title: '好舵手', q: '管这只基金的人靠不靠谱、还在不在？', short: '舵手', dim: 'manager', dimLabel: 'M' },
    { key: 'good_experience', n: '04', title: '好体验', q: '我拿着难不难受、跌多深、多久回本？', short: '体验', dim: 'experience', dimLabel: 'X' },
    { key: 'timing_cost', n: '05', title: '好时机与成本', q: '它的持仓贵不贵、我要付多少费用？', short: '时机', dim: 'timingCost', dimLabel: 'T' },
    { key: 'risk_scan', n: '06', title: '风险排雷', q: '有没有我没看见的坑？', short: '排雷', dim: null },
  ];

  const params = new URLSearchParams(location.search);
  const reportId = params.get('id');
  const code = params.get('code');
  const presetName = params.get('name');
  const depth = params.get('depth') === 'quick' ? 'quick' : 'deep';

  const $sections = U.$('#sections');
  const $progress = U.$('#progress');
  let report = null;
  let liveMeta = null;
  const liveSections = {};

  /* ===================== 骨架与导航 ===================== */
  function buildSkeleton() {
    U.clear($sections);
    SECTIONS.forEach(function (s) {
      const card = el('section', { class: 'card sec', attrs: { id: 'sec-' + s.key } }, [
        el('div', { class: 'sec__head' }, [
          el('span', { class: 'sec__n', text: s.n }),
          el('div', { class: 'sec__t' }, [
            el('div', { class: 'sec__title' }, [el('span', { text: s.title })]),
            el('div', { class: 'sec__q', text: s.q }),
          ]),
          el('div', { class: 'sec__score', attrs: { id: 'score-' + s.key } }),
        ]),
        el('div', { attrs: { id: 'body-' + s.key } }, [
          el('div', { class: 'skeleton w60' }),
          el('div', { class: 'skeleton' }),
          el('div', { class: 'skeleton w40' }),
        ]),
      ]);
      $sections.appendChild(card);
    });
    buildNav();
  }

  function buildNav() {
    const $tabs = U.$('#navtabs-inner');
    const $side = U.$('#side-nav');
    U.clear($tabs);
    U.clear($side);
    SECTIONS.forEach(function (s, i) {
      const jump = function () {
        const node = U.$('#sec-' + s.key);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      $tabs.appendChild(el('button', {
        class: 'navtab', attrs: { type: 'button', 'data-key': s.key }, on: { click: jump },
      }, [el('span', { text: s.short }), el('span', { class: 'navtab__score', attrs: { id: 'tabscore-' + s.key } })]));
      $side.appendChild(el('button', {
        class: 'sidenav', attrs: { type: 'button', 'data-key': s.key }, on: { click: jump },
      }, [
        el('span', { style: { color: 'var(--c-text-3)', fontFamily: 'var(--font-mono)', fontSize: '11px' }, text: s.n }),
        el('span', { text: s.title }),
        el('span', { class: 'sidenav__s', attrs: { id: 'sidescore-' + s.key } }),
      ]));
      // 桌面端快捷键 1–6
      void i;
    });
  }

  function setNavScore(key, text, color) {
    ['tabscore-', 'sidescore-'].forEach(function (p) {
      const n = U.$('#' + p + key);
      if (!n) return;
      n.textContent = text || '';
      if (color) n.style.color = color;
    });
  }

  function setNavDot(key, level) {
    ['tabscore-', 'sidescore-'].forEach(function (p) {
      const n = U.$('#' + p + key);
      if (!n) return;
      U.clear(n);
      n.appendChild(el('span', { class: 'dot dot--' + level }));
    });
  }

  /** 滚动高亮当前板块 */
  function initScrollSpy() {
    const onScroll = function () {
      let cur = SECTIONS[0].key;
      SECTIONS.forEach(function (s) {
        const node = U.$('#sec-' + s.key);
        if (node && node.getBoundingClientRect().top <= 160) cur = s.key;
      });
      U.$$('.navtab').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-key') === cur); });
      U.$$('.sidenav').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-key') === cur); });
      const active = U.$('.navtab.active');
      if (active && active.scrollIntoView) {
        const bar = U.$('#navtabs');
        if (bar) {
          const r = active.getBoundingClientRect();
          const br = bar.getBoundingClientRect();
          if (r.left < br.left || r.right > br.right) active.scrollIntoView({ inline: 'center', block: 'nearest' });
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ===================== 基金信息条 ===================== */
  function renderFundBar(m) {
    U.$('#fb-name').textContent = m.name || m.code || '—';
    U.$('#fb-code').textContent = m.code || '';
    U.$('#fb-type').textContent = m.fundTypeLabel || m.typeText || '';
    const share = U.$('#fb-share');
    if (m.shareClass && m.shareClass !== '—') {
      share.textContent = m.shareClass + ' 类';
      share.classList.remove('hidden');
    }
    U.$('#fb-nav').textContent = U.isNum(m.unitNav) ? m.unitNav.toFixed(4) : '—';
    const chg = U.$('#fb-chg');
    chg.textContent = U.isNum(m.dayChangePct) ? U.pct(m.dayChangePct) : '';
    chg.className = U.dirClass(m.dayChangePct);

    const meta = U.$('#fb-meta');
    U.clear(meta);
    [
      m.company,
      '净值日期 ' + (m.navDate || '—'),
      m.holdingPeriod ? '持仓 ' + m.holdingPeriod : null,
      U.isNum(m.scaleYi) ? '规模 ' + U.yi(m.scaleYi) + (m.scaleAsOf ? '（' + m.scaleAsOf + '）' : '') : null,
      m.purchaseStatus ? '申购：' + m.purchaseStatus : null,
      m.dataCompleteness ? '数据完整度 ' + m.dataCompleteness.available + '/' + m.dataCompleteness.total : null,
    ].filter(Boolean).forEach(function (t) { meta.appendChild(el('span', { text: t })); });
    document.title = (m.name || '基金') + ' 分析报告 · 基金分析平台';
  }

  /* ===================== 顶部提示条 ===================== */
  function renderBanners(m, ov) {
    const box = el('div');
    // 演示数据必须显著标注
    if (m.mocked) {
      box.appendChild(el('div', { class: 'alert alert--warn' }, [
        el('div', null, [el('b', { text: '演示数据' }), el('span', { text: '真实数据源当前不可用，本报告由内置演示数据生成，不代表该基金的真实情况。' })]),
      ]));
    }
    // 风险红线前置，且不可折叠（A-5）
    if (ov && ov.riskLevel === 'red') {
      const lines = (ov.hardRedLines || []).map(function (h) { return h.title; });
      box.appendChild(el('div', { class: 'alert alert--red' }, [
        el('div', null, [
          el('b', { text: '风险提示：本基金风险等级为红灯' }),
          el('span', { text: lines.length ? '已触发硬红线：' + lines.join('、') + '。请务必阅读「风险排雷」板块。' : '存在高严重度风险项，请务必阅读「风险排雷」板块。' }),
        ]),
      ]));
    }
    // 数据滞后提示（F4-8）
    if (m.navDate) {
      const lag = Math.floor((Date.now() - new Date(m.navDate).getTime()) / 86400000);
      if (lag > 5) {
        box.appendChild(el('div', { class: 'alert alert--info' }, [
          el('div', null, [el('b', { text: '数据已滞后' }), el('span', { text: '净值日期为 ' + m.navDate + '（距今约 ' + lag + ' 天），建议重新分析获取最新数据。' })]),
        ]));
      }
    }
    if (ov && ov.missingSections) {
      box.appendChild(el('div', { class: 'alert alert--info' }, [
        el('div', null, [el('b', { text: '部分板块为规则版' }), el('span', { text: ov.missingSections })]),
      ]));
    }
    if (box.childNodes.length) $sections.parentNode.insertBefore(box, $sections);
  }

  /* ===================== ① 总览 ===================== */
  function renderOverview(ov, m) {
    const body = U.$('#body-overview');
    U.clear(body);

    // 一句话定性
    body.appendChild(el('p', { class: 'sec__summary', style: { fontSize: '15px', fontWeight: '600' }, text: ov.oneLiner || '—' }));

    // 四刻度卡
    const cards = el('div', { class: 'scorecards' });
    const dims = [
      { key: 'ability', label: '能力分 A', tip: '赚不赚钱' },
      { key: 'manager', label: '舵手分 M', tip: '谁在管' },
      { key: 'experience', label: '体验分 X', tip: '拿着难不难受' },
      { key: 'timingCost', label: '时机成本分 T', tip: '贵不贵、花多少' },
    ];
    const naMap = {};
    (ov.notApplicable || []).forEach(function (x) { naMap[x.dimension] = x.reason; });
    dims.forEach(function (d) {
      const v = ov.scores ? ov.scores[d.key] : null;
      const na = !U.isNum(v);
      const card = el('div', { class: 'scorecard' + (na ? ' scorecard--na' : '') }, [
        el('div', { class: 'scorecard__v', style: { color: U.scoreColor(v) }, text: na ? '不适用' : String(v) }),
        el('div', { class: 'scorecard__k', text: d.label }),
        el('div', { class: 'scorecard__t', text: na ? (naMap[d.key] ? '点击查看原因' : '数据不足') : d.tip }),
      ]);
      if (na && naMap[d.key]) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', function () { U.showModal(d.label + ' 为什么不适用', [naMap[d.key]]); });
      }
      cards.appendChild(card);
    });
    // 风险灯卡
    const lvl = ov.riskLevel || 'green';
    cards.appendChild(el('div', { class: 'scorecard' }, [
      el('div', { style: { marginBottom: '2px' } }, [el('span', { class: 'dot dot--' + lvl, style: { width: '18px', height: '18px' } })]),
      el('div', { class: 'scorecard__k', text: U.RISK_TEXT[lvl] || '风险灯' }),
      el('div', { class: 'scorecard__t', text: ov.riskTag || '' }),
    ]));
    body.appendChild(cards);

    // 四维雷达图
    const radar = el('div', { class: 'chart chart--radar', attrs: { id: 'chart-radar' } });
    body.appendChild(radar);
    body.appendChild(el('div', { class: 'chart-note', text: '四刻度相互独立，刻意不给单一综合总分：一个总分会把「业绩好但体验差」这类矛盾抹平。' }));
    window.Charts.radarChart(radar, ov.scores || {}, Object.keys(naMap));

    // 适配画像（纯历史事实）
    const p = ov.profile || {};
    if (U.isNum(p.maxDrawdownPct) || U.isNum(p.positiveRate1y)) {
      const kv = el('div', { class: 'kv' });
      const rows = [
        ['历史最大回撤', U.isNum(p.maxDrawdownPct) ? p.maxDrawdownPct + '%' + (p.maxDrawdownRange ? '（' + p.maxDrawdownRange + '）' : '') : '—', '最大回撤'],
        ['投入 10 万元最多浮亏', p.amountDemo && U.isNum(p.amountDemo.maxLossAmount) ? U.money(p.amountDemo.maxLossAmount) : '—', null],
        ['回撤修复中位时长', U.isNum(p.recoveryMedianMonths) ? p.recoveryMedianMonths + ' 个月' : '—', '回撤修复'],
        ['历史持有 1 年正收益概率', U.isNum(p.positiveRate1y) ? p.positiveRate1y + '%' : '—', '滚动持有正收益概率'],
        ['历史持有 3 年正收益概率', U.isNum(p.positiveRate3y) ? p.positiveRate3y + '%' : '—', null],
      ];
      rows.forEach(function (r) {
        const k = el('span', { class: 'kv__k' }, [el('span', { text: r[0] })]);
        if (r[2]) { const h = U.helpBtn(r[2]); if (h) k.appendChild(h); }
        kv.appendChild(el('div', { class: 'kv__row' }, [k, el('span', { class: 'kv__v', text: r[1] })]));
      });
      body.appendChild(el('div', { class: 'card', style: { margin: '10px 0 0', background: 'var(--c-surface-2)' } }, [
        el('div', { class: 'section-title', style: { margin: '0 0 6px' } }, [el('span', { text: '这只基金历史上是什么持有感受' })]),
        kv,
        el('div', { class: 'chart-note', text: p.note || '以上均为历史数据回溯结果，不代表未来表现，不构成投资建议' }),
      ]));
    }

    // 结论要点（可锚点跳转）
    if ((ov.keyPoints || []).length) {
      const ul = el('div', { class: 'keypoints' });
      ov.keyPoints.forEach(function (k) {
        const label = k.tone === 'positive' ? '正' : k.tone === 'negative' ? '反' : '中';
        ul.appendChild(el('button', {
          class: 'keypoint', attrs: { type: 'button' },
          on: {
            click: function () {
              const node = U.$('#sec-' + (k.anchor || 'overview'));
              if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
          },
        }, [
          el('span', { class: 'keypoint__i keypoint__i--' + (k.tone || 'neutral'), text: label }),
          el('span', { text: k.text }),
        ]));
      });
      body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '结论要点' }), el('small', { text: '点击跳转对应板块' })]));
      body.appendChild(ul);
    }

    // 认知冲突提示
    if (ov.conflictNote) {
      body.appendChild(el('div', { class: 'alert alert--warn', style: { marginTop: '10px' } }, [
        el('div', null, [el('b', { text: '需要注意的矛盾点' }), el('span', { text: ov.conflictNote })]),
      ]));
    }

    if (ov.generatedBy === 'rules') {
      body.appendChild(el('div', { class: 'na-note', text: '本板块由指标规则生成' + (ov.degradedReason ? '（' + ov.degradedReason + '）' : '') }));
    }

    const scoreBox = U.$('#score-overview');
    U.clear(scoreBox);
    scoreBox.appendChild(el('span', { class: 'dot dot--' + lvl, style: { width: '14px', height: '14px' } }));
    setNavDot('overview', lvl);
  }

  /* ===================== 通用板块渲染 ===================== */
  function renderSection(sec) {
    const conf = SECTIONS.filter(function (s) { return s.key === sec.key; })[0];
    if (!conf) return;
    const body = U.$('#body-' + sec.key);
    if (!body) return;
    U.clear(body);

    // 板块头部：分数 / 标签 / 数据完整度 / 生成方式
    const scoreBox = U.$('#score-' + sec.key);
    U.clear(scoreBox);
    const score = report && report.scores ? report.scores[conf.dim] : liveMeta && liveMeta.scores ? liveMeta.scores[conf.dim] : null;
    if (conf.dim && U.isNum(score)) {
      scoreBox.appendChild(el('b', { style: { color: U.scoreColor(score) }, text: String(score) }));
      scoreBox.appendChild(el('span', { text: conf.dimLabel + ' 分' }));
      setNavScore(sec.key, String(score), U.scoreColor(score));
    } else if (conf.dim) {
      scoreBox.appendChild(el('span', { class: 'tag', text: '不适用' }));
      setNavScore(sec.key, '—', 'var(--c-text-3)');
    }
    if (sec.key === 'risk_scan') {
      const lvl = (report && report.riskLevel) || (liveMeta && liveMeta.riskLevel) || 'green';
      scoreBox.appendChild(el('span', { class: 'dot dot--' + lvl, style: { width: '14px', height: '14px' } }));
      setNavDot('risk_scan', lvl);
    }

    const metaRow = el('div', { class: 'sec__meta' });
    if (sec.tag) metaRow.appendChild(el('span', { class: 'tag', text: sec.tag }));
    const dc = (report && report.dataCompleteness) || (liveMeta && liveMeta.dataCompleteness);
    if (dc) metaRow.appendChild(el('span', { class: 'tag', text: '数据完整度 ' + dc.available + '/' + dc.total }));
    if (sec.generatedBy === 'rules') metaRow.appendChild(el('span', { class: 'tag tag--warn', text: sec.notApplicable ? '本类型不适用，改为事实陈述' : '本板块由指标规则生成' }));
    if (sec.droppedByNumberCheck > 0) metaRow.appendChild(el('span', { class: 'tag', text: '已丢弃 ' + sec.droppedByNumberCheck + ' 条未通过数字核验的结论' }));
    if (metaRow.childNodes.length) body.appendChild(metaRow);

    if (sec.summary) body.appendChild(U.clampable(sec.summary));

    // 板块专属图表与明细（插在 modules 之前）
    renderSectionExtras(sec.key, body);

    // 子模块
    if ((sec.modules || []).length) {
      const grid = el('div', { class: 'modules-grid' });
      sec.modules.forEach(function (m) {
        const h = el('div', { class: 'module__h' }, [el('span', { text: m.title })]);
        const help = U.helpBtn(m.title);
        if (help) h.appendChild(help);
        const box = el('div', { class: 'module' }, [h]);
        if (m.summary) box.appendChild(el('div', { class: 'module__s', text: m.summary }));
        if ((m.points || []).length) {
          box.appendChild(el('ul', { class: 'module__p' }, m.points.map(function (p) { return el('li', { text: p }); })));
        }
        grid.appendChild(box);
      });
      body.appendChild(grid);
    }

    // 雷点清单（⑥）
    if (sec.key === 'risk_scan') renderFindings(body);

    // 三亮点 / 三短板
    if ((sec.strengths || []).length || (sec.weaknesses || []).length) {
      const sw = el('div', { class: 'sw' });
      if ((sec.strengths || []).length) {
        sw.appendChild(el('div', { class: 'sw__box sw__box--good' }, [
          el('b', { text: '亮点' }),
          el('ul', null, sec.strengths.map(function (t) { return el('li', { text: t }); })),
        ]));
      }
      if ((sec.weaknesses || []).length) {
        sw.appendChild(el('div', { class: 'sw__box sw__box--bad' }, [
          el('b', { text: '短板' }),
          el('ul', null, sec.weaknesses.map(function (t) { return el('li', { text: t }); })),
        ]));
      }
      body.appendChild(sw);
    }

    if (sec.generatedBy === 'rules' && sec.degradedReason) {
      body.appendChild(el('div', { class: 'na-note', text: '说明：' + sec.degradedReason }));
    }
  }

  /* ===================== 各板块图表与明细 ===================== */
  function renderSectionExtras(key, body) {
    if (!report) return; // 明细数据来自完整报告，流式阶段先只渲染文字
    const c = report.charts || {};
    const d = report.details || {};

    if (key === 'good_performance') {
      // 净值走势（多曲线 + 区间切换）
      const tabs = el('div', { class: 'chart-tabs' });
      const chartNode = el('div', { class: 'chart', attrs: { id: 'chart-nav' } });
      // 近6月单列，因为公开的「同类平均 / 沪深300」日频对照序列只覆盖近半年，
      // 只有在该区间才能与本基金同起点对照
      const ranges = [['6m', '近6月'], ['1y', '近1年'], ['3y', '近3年'], ['5y', '近5年'], ['all', '成立以来']];
      const defRange = window.innerWidth < 768 ? '3y' : '5y';
      ranges.forEach(function (r) {
        tabs.appendChild(el('button', {
          class: 'chart-tab' + (r[0] === defRange ? ' active' : ''), attrs: { type: 'button' }, text: r[1],
          on: {
            click: function (e) {
              U.$$('.chart-tab', tabs).forEach(function (n) { n.classList.remove('active'); });
              e.currentTarget.classList.add('active');
              window.Charts.navChart(chartNode, c, r[0]);
            },
          },
        }));
      });
      body.appendChild(tabs);
      body.appendChild(chartNode);
      body.appendChild(el('div', { class: 'chart-note', text: '曲线为复权净值累计涨幅（已含分红再投）；同类平均（虚线）与沪深300（灰线）的公开日频数据仅近半年，切到「近6月」才作同起点对照。' + (window.innerWidth < 768 ? '长按查看某日数值，双指缩放。' : '悬停查看数值，滚轮缩放。') }));
      window.Charts.navChart(chartNode, c, defRange);

      // 区间收益表
      const iv = d.intervals || {};
      const order = ['1m', '3m', '6m', 'ytd', '1y', '2y', '3y', '5y', 'since'];
      const rows = order.filter(function (k) { return iv[k]; });
      if (rows.length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [
            el('th', { text: '区间' }), el('th', { text: '本基金' }), el('th', { text: '同类平均' }),
            el('th', { text: '沪深300' }), el('th', { text: '同类排名' }),
          ])]),
          el('tbody', null, rows.map(function (k) {
            const r = iv[k];
            return el('tr', null, [
              el('td', { text: r.label + (r.notFullPeriod ? '*' : '') }),
              el('td', { class: 'num ' + U.dirClass(r.pct), text: U.pct(r.pct) }),
              el('td', { class: 'num ' + U.dirClass(r.peerAvgPct), text: U.isNum(r.peerAvgPct) ? U.pct(r.peerAvgPct) : '—' }),
              el('td', { class: 'num ' + U.dirClass(r.hs300Pct), text: U.isNum(r.hs300Pct) ? U.pct(r.hs300Pct) : '—' }),
              el('td', { class: 'num', text: U.isNum(r.rank) ? r.rank + '/' + r.rankTotal : '—' }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
        body.appendChild(el('div', { class: 'chart-note', text: '排名口径：同二级分类基金，截止 ' + (report.navDate || '—') + '；标 * 表示基金成立时间短于该区间。' }));
      }

      // 逐年收益（含亏损年份，完整展示）
      if ((c.yearly || []).length) {
        const y = el('div', { class: 'chart', attrs: { id: 'chart-yearly' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '逐年度收益' }), el('small', { text: '含亏损年份，* 为非完整年度' })]));
        body.appendChild(y);
        window.Charts.yearlyChart(y, c.yearly);
      }

      // 行业分布
      if ((c.industries || []).length) {
        const ind = el('div', { class: 'chart', attrs: { id: 'chart-industry' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [
          el('span', { text: '行业分布' }),
          el('small', { text: (d.holdings && d.holdings.period ? d.holdings.period : '最新报告期') + ' · 存在披露滞后' }),
        ]));
        body.appendChild(ind);
        window.Charts.industryChart(ind, c.industries);
      }

      // 十大重仓
      const stocks = (d.holdings && d.holdings.stocks) || [];
      if (stocks.length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [
            el('th', { text: '重仓股' }), el('th', { text: '占净值' }), el('th', { text: '较上期' }), el('th', { text: '所属行业' }),
          ])]),
          el('tbody', null, stocks.map(function (s) {
            return el('tr', null, [
              el('td', { text: s.name + (s.code ? '（' + s.code + '）' : '') }),
              el('td', { class: 'num', text: U.pctAbs(s.pct) }),
              el('td', { class: 'num ' + U.dirClass(s.chg), text: U.isNum(s.chg) ? U.pct(s.chg) : '—' }),
              el('td', { text: s.industry || '—' }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
      }
    }

    if (key === 'good_manager') {
      const mg = d.manager || {};
      if ((mg.managers || []).length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [
            el('th', { text: '现任基金经理' }), el('th', { text: '任职本基金' }), el('th', { text: '任职期收益' }),
            el('th', { text: '同期同类' }), el('th', { text: '在管只数' }), el('th', { text: '在管规模' }),
          ])]),
          el('tbody', null, mg.managers.map(function (m) {
            return el('tr', null, [
              el('td', { text: m.name }),
              el('td', { class: 'num', text: (U.isNum(m.tenureYears) ? m.tenureYears + ' 年' : '—') + (m.startDate ? '（' + m.startDate + '起）' : '') }),
              el('td', { class: 'num ' + U.dirClass(m.tenureReturnPct), text: U.isNum(m.tenureReturnPct) ? U.pct(m.tenureReturnPct) : '—' }),
              el('td', { class: 'num ' + U.dirClass(m.tenurePeerPct), text: U.isNum(m.tenurePeerPct) ? U.pct(m.tenurePeerPct) : '—' }),
              el('td', { class: 'num', text: U.isNum(m.fundCount) ? String(m.fundCount) : '—' }),
              el('td', { class: 'num', text: U.isNum(m.aumYi) ? U.yi(m.aumYi) : '—' }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
      }
      if (mg.tenure && mg.tenure.isNew) {
        body.appendChild(el('div', { class: 'alert alert--warn' }, [
          el('div', null, [el('b', { text: '现任基金经理任职时间较短' }),
            el('span', { text: '任职约 ' + (mg.tenure.months || '—') + ' 个月，基金过往业绩主要由前任创造，历史业绩的参考价值有限。' })]),
        ]));
      }
      // 带经理更替标记的净值曲线
      if ((report.charts.managerTerms || []).length) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-mgr-nav' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '任期分段净值曲线' }), el('small', { text: '虚线为经理更替时点' })]));
        body.appendChild(node);
        window.Charts.navChart(node, report.charts, 'all');
      }
      // 历任经理
      const hist = mg.changeHistory || [];
      if (hist.length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [el('th', { text: '历任经理' }), el('th', { text: '任期' }), el('th', { text: '任职回报' })])]),
          el('tbody', null, hist.map(function (h) {
            return el('tr', null, [
              el('td', { text: h.name }),
              el('td', { text: (h.startDate || '—') + ' ~ ' + (h.endDate || '至今') }),
              el('td', { class: 'num ' + U.dirClass(h.tenureReturnPct), text: U.isNum(h.tenureReturnPct) ? U.pct(h.tenureReturnPct) : '—' }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
      }
    }

    if (key === 'good_experience') {
      // 回撤水下图
      if ((c.drawdown || []).length) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-dd' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '回撤水下图' }), el('small', { text: '任意时点距历史最高净值的差距' })]));
        body.appendChild(node);
        window.Charts.drawdownChart(node, c.drawdown);
      }
      // 滚动持有正收益概率
      if (c.rollingHold) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-roll' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [
          el('span', { text: '滚动持有正收益概率' }), U.helpBtn('滚动持有正收益概率') || el('small', { text: '' }),
        ]));
        body.appendChild(node);
        window.Charts.rollingChart(node, c.rollingHold);
        body.appendChild(el('div', { class: 'chart-note', text: '含义：历史上任一交易日买入并持有对应时长后取得正收益的比例。为历史回溯统计，不代表未来表现。' }));
      }
      // 关键指标
      const dd = d.drawdown || {};
      const vol = d.volatility || {};
      const ra = d.riskAdjusted || {};
      const kv = el('div', { class: 'kv' });
      [
        ['历史最大回撤', U.isNum(dd.maxPct) ? Math.abs(dd.maxPct) + '%' : '—', '最大回撤'],
        ['回撤区间', dd.maxFrom ? dd.maxFrom + ' ~ ' + (dd.maxBottom || '—') : '—', null],
        ['修复时长（中位/最长）', (U.isNum(dd.recoveryMedianDays) ? dd.recoveryMedianDays + ' 天' : '—') + ' / ' + (U.isNum(dd.recoveryMaxDays) ? dd.recoveryMaxDays + ' 天' : '—'), '回撤修复'],
        ['当前回撤', U.isNum(dd.current && dd.current.ddPct) ? Math.abs(dd.current.ddPct) + '%' : '—', null],
        ['年化波动率', U.isNum(vol.annualPct) ? vol.annualPct + '%' : '—', '年化波动率'],
        ['单日最大跌幅', U.isNum(vol.worstDayPct) ? vol.worstDayPct + '%' : '—', null],
        ['月度胜率', U.isNum(vol.monthWinRatePct) ? vol.monthWinRatePct + '%' : '—', null],
        ['夏普 / 卡玛 / 索提诺', [ra.sharpe, ra.calmar, ra.sortino].map(function (x) { return U.isNum(x) ? x : '—'; }).join(' / '), '夏普比率'],
      ].forEach(function (r) {
        const k = el('span', { class: 'kv__k' }, [el('span', { text: r[0] })]);
        if (r[2]) { const h = U.helpBtn(r[2]); if (h) k.appendChild(h); }
        kv.appendChild(el('div', { class: 'kv__row' }, [k, el('span', { class: 'kv__v', text: r[1] })]));
      });
      body.appendChild(kv);
      // 与同类对比
      const pc = report.details && report.details.drawdown ? null : null;
      void pc;
      // 交叉校验说明
      const cc = d.crossCheck || {};
      if (cc.checked && (cc.items || []).length) {
        const bad = cc.items.filter(function (x) { return !x.pass; });
        body.appendChild(el('div', { class: 'na-note', text: '指标交叉校验：' + cc.items.map(function (x) { return x.item + ' 自算 ' + x.mine + ' / 数据源 ' + x.published + '（差 ' + x.diffPp + '）'; }).join('；') + (bad.length ? '。存在差异，可能源于统计区间口径不同。' : '。一致。') }));
      }
      // 定投历史分布
      const dca = d.dca || {};
      const dcaKeys = Object.keys(dca).filter(function (k) { return dca[k] && dca[k].available; });
      if (dcaKeys.length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [
            el('th', { text: '按月投入期数' }), el('th', { text: '正收益比例' }), el('th', { text: '收益中位数' }),
            el('th', { text: '较差情形' }), el('th', { text: '较好情形' }),
          ])]),
          el('tbody', null, dcaKeys.map(function (k) {
            const x = dca[k];
            return el('tr', null, [
              el('td', { text: x.periods + ' 期' }),
              el('td', { class: 'num', text: x.positiveRatePct + '%' }),
              el('td', { class: 'num ' + U.dirClass(x.medianPct), text: U.pct(x.medianPct) }),
              el('td', { class: 'num ' + U.dirClass(x.p10Pct), text: U.pct(x.p10Pct) }),
              el('td', { class: 'num ' + U.dirClass(x.p90Pct), text: U.pct(x.p90Pct) }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '按月分批投入的历史收益分布' })]));
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
        body.appendChild(el('div', { class: 'chart-note', text: '历史数据回溯，不代表未来表现，不构成任何投资建议或投资方式推荐。' }));
      }
    }

    if (key === 'timing_cost') {
      const fee = d.fee || {};
      if ((fee.totalCost || []).length) {
        const table = el('table', { class: 'data' }, [
          el('thead', null, [el('tr', null, [
            el('th', { text: '持有期' }), el('th', { text: '申购费' }), el('th', { text: '运作费' }), el('th', { text: '赎回费' }), el('th', { text: '总成本' }),
          ])]),
          el('tbody', null, fee.totalCost.map(function (x) {
            return el('tr', null, [
              el('td', { text: x.label }),
              el('td', { class: 'num', text: U.pctAbs(x.purchasePct) }),
              el('td', { class: 'num', text: U.pctAbs(x.runningPct) }),
              el('td', { class: 'num', text: U.isNum(x.redeemPct) ? U.pctAbs(x.redeemPct) : '—' }),
              el('td', { class: 'num', style: { fontWeight: '700' }, text: U.pctAbs(x.totalPct) }),
            ]);
          })),
        ]);
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '持有成本测算' }), el('small', { text: '可核对：申购费 + 年运作费率×持有天数/365 + 赎回费' })]));
        body.appendChild(el('div', { class: 'table-wrap' }, [table]));
        const sc = fee.shareClassCompare || {};
        body.appendChild(el('div', { class: 'chart-note', text: (sc.available ? sc.statement : sc.reason || '') + ' ' + (fee.note || '') }));
      }
      // 规模变化
      if ((c.scale || []).length) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-scale' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [el('span', { text: '规模变化' })]));
        body.appendChild(node);
        window.Charts.scaleChart(node, c.scale);
      }
      // 估值与位置
      const val = d.valuation || {};
      const np = d.navPosition || {};
      const kv = el('div', { class: 'kv' });
      [
        ['重仓加权市盈率', U.isNum(val.pe) ? String(val.pe) : '不可得', null],
        ['重仓加权市净率', U.isNum(val.pb) ? String(val.pb) : '不可得', null],
        ['估值历史分位', U.isNum(val.percentile5y) ? val.percentile5y + '%' : '不可得', '估值分位'],
        ['净值区间分位', U.isNum(np.percentile) ? np.percentile + '%（近' + (np.windowYears || '—') + '年）' : '—', null],
        ['距区间高点', U.isNum(np.distanceFromPeakPct) ? np.distanceFromPeakPct + '%' : '—', null],
        ['近3月涨幅', U.isNum(np.recent3mPct) ? U.pct(np.recent3mPct) : '—', null],
        ['年运作费率', U.isNum(fee.annualRunningPct) ? fee.annualRunningPct + '%' : '—', null],
        ['申购/赎回状态', (d.scaleStatus && d.scaleStatus.purchaseStatus ? d.scaleStatus.purchaseStatus : '—') + ' / ' + (d.scaleStatus && d.scaleStatus.redeemStatus ? d.scaleStatus.redeemStatus : '—'), null],
      ].forEach(function (r) {
        const k = el('span', { class: 'kv__k' }, [el('span', { text: r[0] })]);
        if (r[2]) { const h = U.helpBtn(r[2]); if (h) k.appendChild(h); }
        kv.appendChild(el('div', { class: 'kv__row' }, [k, el('span', { class: 'kv__v', text: r[1] })]));
      });
      body.appendChild(kv);
      if (val.percentileReason) body.appendChild(el('div', { class: 'na-note', text: val.percentileReason }));
      const pm = d.premium || {};
      if (pm.available) {
        body.appendChild(el('div', { class: pm.level === 'normal' ? 'na-note' : 'alert alert--warn' }, [
          el('div', null, [el('b', { text: '场内折溢价 ' + U.pct(pm.premiumPct) }),
            el('span', { text: (pm.level !== 'normal' ? '溢价回归时价格可能下跌而净值不变。' : '') + (pm.note || '') })]),
        ]));
      }
    }

    if (key === 'risk_scan') {
      if ((c.driftStack || []).length >= 2) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-drift' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [
          el('span', { text: '风格漂移证据：多期行业分布' }), U.helpBtn('风格漂移') || el('small', { text: '' }),
        ]));
        body.appendChild(node);
        window.Charts.driftChart(node, c.driftStack);
        const drift = (d.holdings && d.holdings.drift) || {};
        if (drift.available) {
          body.appendChild(el('div', { class: 'chart-note', text: '最新一期相对历史均值的调整幅度为 ' + drift.deviationPct + '%（预警阈值 ' + drift.thresholdPct + '%，严重阈值 ' + drift.severeThresholdPct + '%）。' + (drift.note || '') }));
        }
      }
      if (c.holders) {
        const node = el('div', { class: 'chart', attrs: { id: 'chart-holders' } });
        body.appendChild(el('div', { class: 'section-title', style: { marginBottom: '0' } }, [
          el('span', { text: '持有人结构' }), el('small', { text: c.holders.asOf ? '截止 ' + c.holders.asOf : '' }),
        ]));
        body.appendChild(node);
        window.Charts.holderChart(node, c.holders);
      }
    }
  }

  /* ===================== 雷点清单 ===================== */
  function renderFindings(body) {
    if (!report) return;
    const list = report.riskFindings || [];
    if (!list.length) {
      body.appendChild(el('div', { class: 'alert alert--info' }, [
        el('div', null, [
          el('b', { text: '未发现显著异常（绿灯）' }),
          el('span', { text: report.greenNote || '基于已获取的公开数据，未发现异常。' }),
        ]),
      ]));
    } else {
      const isMobile = window.innerWidth < 768;
      const high = list.filter(function (f) { return f.severity === 'high'; });
      const rest = list.filter(function (f) { return f.severity !== 'high'; });
      const grid = el('div', { class: 'findings-grid' });
      high.forEach(function (f) { grid.appendChild(findingNode(f)); });
      // 移动端：高严重度默认展开，中低折叠
      if (rest.length && isMobile) {
        const box = el('div');
        rest.forEach(function (f) { box.appendChild(findingNode(f)); });
        box.classList.add('hidden');
        const btn = el('button', { class: 'btn-ghost', style: { width: '100%' }, attrs: { type: 'button' }, text: '查看其余 ' + rest.length + ' 项风险' });
        btn.addEventListener('click', function () {
          const hidden = box.classList.toggle('hidden');
          btn.textContent = hidden ? '查看其余 ' + rest.length + ' 项风险' : '收起';
        });
        grid.appendChild(btn);
        grid.appendChild(box);
      } else {
        rest.forEach(function (f) { grid.appendChild(findingNode(f)); });
      }
      body.appendChild(grid);
    }
    body.appendChild(el('div', { class: 'na-note' }, [
      el('span', { text: '本次共检查 ' + (report.checkedRiskItems || 0) + ' 类异常。「未发现」不等于「安全」，仅代表在已检查项目与当前数据完整度下无异常触发。' }),
      el('button', {
        class: 'clamp-toggle', attrs: { type: 'button' }, text: ' 查看检查清单',
        on: { click: function () { U.showModal('本次检查的 ' + (report.checkedRiskItems || 0) + ' 类异常', report.checkedRiskList || []); } },
      }),
    ]));
  }

  function findingNode(f) {
    const sevText = { high: '高', medium: '中', low: '低' }[f.severity] || '—';
    const node = el('div', { class: 'finding finding--' + f.severity }, [
      el('div', { class: 'finding__h' }, [
        el('span', { class: 'sev sev--' + f.severity, text: sevText }),
        el('span', { text: f.title }),
        f.hardRedLine ? el('span', { class: 'tag tag--red', text: '硬红线' }) : null,
        el('span', { class: 'tag', text: f.categoryLabel || '' }),
      ]),
      el('div', { class: 'finding__d', text: f.description || '' }),
      el('div', { class: 'finding__t', text: '依据：' + (f.trigger ? f.trigger.label + ' = ' + f.trigger.value + '（阈值 ' + f.trigger.threshold + (f.trigger.asOf ? '，数据截止 ' + f.trigger.asOf : '') + '）' : '—') }),
    ]);
    if (f.explain) node.appendChild(el('div', { class: 'finding__d', style: { color: 'var(--c-text-2)' }, text: '解读：' + f.explain }));
    if (f.watch) node.appendChild(el('div', { class: 'finding__w', text: '关注建议：' + f.watch }));
    return node;
  }

  /* ===================== 数据来源与免责 ===================== */
  function renderSources() {
    const box = U.$('#sources-list');
    U.clear(box);
    (report.sources || []).forEach(function (s) {
      box.appendChild(el('div', { text: '· ' + s.name + (s.asOf ? '（数据截止 ' + s.asOf + '）' : '') }));
    });
    if (report.dataCompleteness && (report.dataCompleteness.missing || []).length) {
      box.appendChild(el('div', { style: { marginTop: '6px' }, text: '缺失数据项：' + report.dataCompleteness.missing.join('、') + '（对应子模块已标注未做判断）' }));
    }
    box.appendChild(el('div', { style: { marginTop: '6px' }, text: '报告生成时间 ' + U.fmtTime(report.createdAt) + ' · 净值日期 ' + (report.navDate || '—') + (report.holdingPeriod ? ' · 持仓报告期 ' + report.holdingPeriod : '') }));
    if (report.usage) {
      box.appendChild(el('div', { text: '模型调用 ' + report.usage.calls + ' 次 · 耗时 ' + Math.round((report.timing.totalMs || 0) / 100) / 10 + ' 秒' }));
    }
    U.$('#disclaimer-box').textContent = report.disclaimer || U.DISCLAIMER_TEXT;
  }

  /* ===================== 侧栏分数 ===================== */
  function renderSideScores(m) {
    const box = U.$('#side-scores');
    U.clear(box);
    const s = m.scores || {};
    [['能力 A', s.ability], ['舵手 M', s.manager], ['体验 X', s.experience], ['时机成本 T', s.timingCost]].forEach(function (r) {
      box.appendChild(el('div', null, [
        el('span', { style: { color: 'var(--c-text-2)' }, text: r[0] + '：' }),
        el('b', { style: { color: U.scoreColor(r[1]), fontFamily: 'var(--font-mono)' }, text: U.isNum(r[1]) ? String(r[1]) : '不适用' }),
      ]));
    });
    box.appendChild(el('div', null, [
      el('span', { style: { color: 'var(--c-text-2)' }, text: '风险灯：' }),
      el('span', { class: 'dot dot--' + (m.riskLevel || 'green') }),
      el('span', { text: ' ' + (U.RISK_TEXT[m.riskLevel] || '') }),
    ]));
  }

  /* ===================== 渲染完整报告 ===================== */
  function renderAll(r) {
    report = r;
    renderFundBar(r);
    renderSideScores(r);
    U.clear($sections);
    buildSkeleton();
    renderBanners(r, r.overview);
    renderOverview(r.overview, r);
    (r.sections || []).forEach(renderSection);
    renderSources();
    $progress.classList.add('hidden');
    U.$('#sources-card').classList.remove('hidden');
    refreshWatchBtn();
  }

  /* ===================== 分析流程（SSE + 轮询兜底） ===================== */
  function setProgress(pct, text) {
    U.$('#progress-fill').style.width = Math.min(100, pct) + '%';
    if (text) U.$('#progress-text').textContent = text;
  }

  async function loadReport(id) {
    const r = await U.api('report/' + encodeURIComponent(id));
    renderAll(r.data);
  }

  async function startAnalyze(fundCode) {
    buildSkeleton();
    U.$('#fb-name').textContent = presetName || fundCode;
    U.$('#fb-code').textContent = fundCode;
    setProgress(5, '正在提交分析任务…');
    let resp;
    try {
      resp = await U.api('analyze', { method: 'POST', body: { code: fundCode, depth: depth } });
    } catch (e) {
      setProgress(100, '');
      $progress.classList.add('hidden');
      U.clear($sections);
      $sections.appendChild(el('div', { class: 'alert alert--red' }, [
        el('div', null, [el('b', { text: '分析未能开始' }), el('span', { text: e.message + (e.status === 429 ? '' : '') })]),
      ]));
      $sections.appendChild(el('a', { class: 'btn-ghost', attrs: { href: 'index.html' }, text: '返回重新搜索', style: { display: 'inline-flex', alignItems: 'center', padding: '0 14px' } }));
      return;
    }
    if (resp.cached && resp.reportId) {
      setProgress(100, '命中缓存，直接加载报告');
      return loadReport(resp.reportId);
    }
    subscribe(resp.taskId);
  }

  function subscribe(taskId) {
    let finished = false;
    let pollTimer = null;

    const handle = function (type, data) {
      if (type === 'progress') setProgress(data.percent || 30, data.text || '');
      else if (type === 'meta') {
        liveMeta = data;
        renderFundBar(data);
        renderSideScores(data);
        renderBanners(data, { riskLevel: data.riskLevel, hardRedLines: [] });
        setProgress(30, '数据就绪，五个板块正在并行解读…');
      } else if (type === 'section') {
        liveSections[data.key] = data;
        renderSection(data);
        setProgress(Math.min(78, 35 + Object.keys(liveSections).length * 9), '已完成：' + data.title);
      } else if (type === 'overview') {
        renderOverview(data, liveMeta || {});
        setProgress(92, '总览已生成，正在加载完整明细…');
      } else if (type === 'done') {
        finished = true;
        setProgress(100, '完成');
        if (pollTimer) clearInterval(pollTimer);
        loadReport(data.reportId).catch(function (e) { U.toast('报告加载失败：' + e.message); });
      } else if (type === 'failed') {
        finished = true;
        if (pollTimer) clearInterval(pollTimer);
        $progress.classList.add('hidden');
        $sections.insertBefore(el('div', { class: 'alert alert--red' }, [
          el('div', null, [el('b', { text: '分析失败' }), el('span', { text: data.message || '请稍后重试' })]),
        ]), $sections.firstChild);
      }
    };

    // 注意：业务失败事件名为 failed；EventSource 的内建 error 事件只代表连接问题，
    // 不能据此判定分析失败，否则已完成的报告会被误判
    let es = null;
    try {
      es = new EventSource('api/analyze/' + encodeURIComponent(taskId) + '/stream');
      ['progress', 'meta', 'section', 'overview', 'done', 'failed', 'closed'].forEach(function (evt) {
        es.addEventListener(evt, function (e) {
          let data = {};
          try { data = JSON.parse(e.data); } catch (err) { /* 忽略 */ }
          handle(evt, data);
          if (evt === 'done' || evt === 'failed') es.close();
        });
      });
      es.addEventListener('error', function () {
        if (finished) { es.close(); return; }
        // 连接异常 → 转轮询兜底（弱网、微信后台挂起）
        startPolling();
      });
    } catch (e) {
      startPolling();
    }

    let lastSeq = 0;
    function startPolling() {
      if (pollTimer || finished) return;
      pollTimer = setInterval(async function () {
        try {
          const r = await U.api('analyze/' + encodeURIComponent(taskId));
          (r.events || []).forEach(function (ev) {
            if (ev.seq > lastSeq) {
              lastSeq = ev.seq;
              handle(ev.type, ev.data || {});
            }
          });
          if (r.status !== 'running') {
            finished = true;
            clearInterval(pollTimer);
            if (r.status === 'done' && r.reportId) loadReport(r.reportId);
          }
        } catch (e) { /* 下一次重试 */ }
      }, 2500);
    }

    // 页面从后台切回时补拉一次（iOS 微信会挂起 SSE）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !finished) startPolling();
    });
  }

  /* ===================== 操作 ===================== */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { U.toast('已复制'); }, function () { U.toast('复制失败，请长按选择文本'); });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); U.toast('已复制'); } catch (e) { U.toast('复制失败'); }
      ta.remove();
    }
  }

  function overviewText() {
    if (!report) return '';
    const s = report.scores || {};
    const lines = [
      (report.name || '') + '（' + report.code + '）· ' + (report.fundTypeLabel || ''),
      report.overview.oneLiner || '',
      '四刻度：能力 A ' + (U.isNum(s.ability) ? s.ability : '不适用') + ' / 舵手 M ' + (U.isNum(s.manager) ? s.manager : '不适用') +
        ' / 体验 X ' + (U.isNum(s.experience) ? s.experience : '不适用') + ' / 时机成本 T ' + (U.isNum(s.timingCost) ? s.timingCost : '不适用'),
      '风险等级：' + (U.RISK_TEXT[report.riskLevel] || report.riskLevel),
    ];
    (report.overview.keyPoints || []).forEach(function (k) { lines.push('· ' + k.text); });
    if (report.overview.conflictNote) lines.push('矛盾点：' + report.overview.conflictNote);
    lines.push('净值日期 ' + (report.navDate || '—') + (report.holdingPeriod ? ' · 持仓 ' + report.holdingPeriod : ''));
    lines.push('（AI 生成内容，不构成投资建议，不推荐基金，过往业绩不预示未来表现）');
    return lines.join('\n');
  }

  function shareUrl() {
    if (!report) return location.href;
    return location.origin + location.pathname.replace(/report\.html$/, '') + 'report.html?id=' + report.id;
  }

  async function refreshWatchBtn() {
    if (!report && !liveMeta) return;
    const c = (report && report.code) || (liveMeta && liveMeta.code);
    if (!c) return;
    try {
      const r = await U.api('watchlist?code=' + encodeURIComponent(c));
      ['#btn-watch', '#btn-watch-m'].forEach(function (sel) {
        const b = U.$(sel);
        if (b) b.textContent = r.watched ? '已自选' : (sel === '#btn-watch' ? '加自选' : '自选');
      });
    } catch (e) { /* 忽略 */ }
  }

  async function toggleWatch() {
    const c = (report && report.code) || (liveMeta && liveMeta.code);
    if (!c) return;
    const r = await U.api('watchlist?code=' + encodeURIComponent(c)).catch(function () { return { watched: false }; });
    if (r.watched) {
      await U.api('watchlist', { method: 'DELETE', body: { code: c } }).catch(function () {});
      U.toast('已移出自选');
    } else {
      await U.api('watchlist', { method: 'POST', body: { code: c, name: (report && report.name) || '' } }).catch(function () {});
      U.toast('已加入自选');
    }
    refreshWatchBtn();
  }

  function bindActions() {
    const again = function () {
      const c = (report && report.code) || code;
      location.href = 'report.html?code=' + encodeURIComponent(c) + '&t=' + Date.now();
    };
    [['#btn-again', again], ['#btn-again-m', again],
     ['#btn-copy', function () { copyText(overviewText()); }], ['#btn-copy-m', function () { copyText(overviewText()); }],
     ['#btn-share', function () { copyText(shareUrl()); }],
     ['#btn-share-m', function () {
       if (navigator.share && report) navigator.share({ title: report.name + ' 基金分析报告', url: shareUrl() }).catch(function () { copyText(shareUrl()); });
       else copyText(shareUrl());
     }],
     ['#btn-watch', toggleWatch], ['#btn-watch-m', toggleWatch],
     ['#btn-detail', function () {
       if (!report) return;
       const lines = [
         '基金全称：' + (report.fullName || '—'),
         '基金代码：' + report.code + '（' + (report.shareClass || '—') + ' 类）',
         '基金类型：' + (report.typeText || '—') + ' → 平台归类：' + (report.fundTypeLabel || '—'),
         '基金公司：' + (report.company || '—'),
         '成立日期：' + (report.establishDate || '—'),
         '业绩比较基准：' + (report.benchmark || '—'),
         '跟踪标的：' + (report.tracks || '—'),
         '最新规模：' + (U.isNum(report.scaleYi) ? U.yi(report.scaleYi) : '—') + (report.scaleAsOf ? '（' + report.scaleAsOf + '）' : ''),
         '申购状态：' + (report.purchaseStatus || '—') + ' · 赎回状态：' + (report.redeemStatus || '—'),
         '投资范围：' + ((report.details && report.details.scopeNote) || '—'),
       ];
       U.showModal('基金档案', lines);
     }],
    ].forEach(function (p) {
      const n = U.$(p[0]);
      if (n) n.addEventListener('click', p[1]);
    });

    // 桌面端快捷键 1–6 跳转板块
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      const i = parseInt(e.key, 10);
      if (i >= 1 && i <= 6) {
        const node = U.$('#sec-' + SECTIONS[i - 1].key);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /* ===================== 启动 ===================== */
  U.initTheme();
  U.ensureDisclaimer();
  bindActions();
  buildSkeleton();
  initScrollSpy();

  if (reportId) {
    setProgress(60, '正在加载报告快照…');
    loadReport(reportId).catch(function (e) {
      $progress.classList.add('hidden');
      U.clear($sections);
      $sections.appendChild(el('div', { class: 'alert alert--red' }, [
        el('div', null, [el('b', { text: '报告加载失败' }), el('span', { text: e.message })]),
      ]));
    });
  } else if (code) {
    startAnalyze(code);
  } else {
    $progress.classList.add('hidden');
    U.clear($sections);
    $sections.appendChild(el('div', { class: 'alert alert--info' }, [
      el('div', null, [el('b', { text: '缺少参数' }), el('span', { text: '请从首页搜索并选择一只基金。' })]),
    ]));
  }
})();
