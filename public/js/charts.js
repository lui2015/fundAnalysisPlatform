/* 图表封装（ECharts 按需异步加载，控制首屏体积 ≤300KB gzip / M-6）
   移动端：长按显示数值、双指缩放、单指拖动；桌面端：悬停十字光标 + 框选缩放 */
(function (global) {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';
  let loading = null;
  const instances = [];

  function load() {
    if (global.echarts) return Promise.resolve(global.echarts);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = CDN;
      s.async = true;
      s.onload = function () { resolve(global.echarts); };
      s.onerror = function () { reject(new Error('图表库加载失败')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function isMobile() { return window.innerWidth < 768; }

  function theme() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      text: light ? '#55628a' : '#9aabcd',
      axis: light ? '#dde4f2' : '#253154',
      split: light ? '#eef2fa' : '#1b2440',
      bg: light ? '#ffffff' : '#141b30',
      up: '#ff4d6a',
      down: '#12c48b',
      brand: '#4b8dff',
      brand2: '#7c5cff',
      warn: '#ffb02e',
    };
  }

  function baseOption(t) {
    return {
      backgroundColor: 'transparent',
      animationDuration: 400,
      textStyle: { fontSize: isMobile() ? 11 : 12, color: t.text },
      grid: { left: isMobile() ? 44 : 56, right: isMobile() ? 12 : 20, top: 30, bottom: isMobile() ? 44 : 34 },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: t.bg,
        borderColor: t.axis,
        textStyle: { color: t.text, fontSize: 12 },
        axisPointer: { type: 'cross', label: { backgroundColor: t.brand } },
        // 移动端长按触发（ECharts 默认触摸即触发，配合 confine 防溢出）
        triggerOn: 'mousemove|click',
      },
      legend: { top: 0, textStyle: { color: t.text, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    };
  }

  /** 创建图表容器并渲染 */
  function render(node, builder) {
    return load().then(function (echarts) {
      // 同一容器可能被反复渲染（如切换净值区间）。
      // 若不先销毁旧实例，setOption 会与旧配置合并，导致上一次的 graphic/markLine 等残留，
      // 出现「已有对照线却仍提示缺少对照线」这类矛盾提示。
      const old = echarts.getInstanceByDom(node);
      if (old) {
        old.dispose();
        for (let i = instances.length - 1; i >= 0; i -= 1) {
          if (instances[i].chart === old) instances.splice(i, 1);
        }
      }
      const chart = echarts.init(node);
      const t = theme();
      chart.setOption(builder(t, echarts), true);
      instances.push({ chart: chart, builder: builder });
      return chart;
    }).catch(function (e) {
      node.textContent = '图表加载失败：' + e.message;
      node.style.fontSize = '12px';
      node.style.color = 'var(--c-text-3)';
    });
  }

  window.addEventListener('resize', function () {
    instances.forEach(function (x) { try { x.chart.resize(); } catch (e) {} });
  });
  global.FAP_ON_THEME_CHANGE = function () {
    instances.forEach(function (x) {
      try {
        const t = theme();
        x.chart.setOption(x.builder(t, global.echarts), true);
      } catch (e) {}
    });
  };

  /* ============ 净值走势（本基金 vs 同类平均 vs 沪深300） ============ */
  function navChart(node, data, rangeKey) {
    const rangeDays = { '6m': 182, '1y': 365, '3y': 365 * 3, '5y': 365 * 5, all: 99999 }[rangeKey || (isMobile() ? '3y' : '5y')] || 99999;
    return render(node, function (t) {
      const nav = data.nav || [];
      if (!nav.length) return { title: { text: '暂无净值数据', textStyle: { color: t.text, fontSize: 12 } } };
      const lastDate = new Date(nav[nav.length - 1].d).getTime();
      const from = lastDate - rangeDays * 86400000;
      const pick = function (arr) {
        return (arr || []).filter(function (p) { return new Date(p.d).getTime() >= from; });
      };
      const f = pick(nav);
      if (!f.length) return { title: { text: '区间内无数据', textStyle: { color: t.text, fontSize: 12 } } };
      const base = f[0].v;
      const toPct = function (arr) {
        if (!arr || !arr.length) return [];
        const b = arr[0].v;
        if (!(b > 0)) return []; // 基准值非正会产生 NaN 坐标，直接放弃该条对照线
        return arr.map(function (p) { return [p.d, +(((p.v / b) - 1) * 100).toFixed(2)]; });
      };
      const series = [
        {
          name: '本基金', type: 'line', showSymbol: false, smooth: false,
          data: f.map(function (p) { return [p.d, +(((p.v / base) - 1) * 100).toFixed(2)]; }),
          lineStyle: { width: 2, color: t.brand },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
            { offset: 0, color: 'rgba(75,141,255,0.28)' }, { offset: 1, color: 'rgba(75,141,255,0.02)' }] } },
        },
      ];
      /**
       * 对照线（同类平均 / 沪深300）：公开数据仅提供近半年日频序列。
       * 若窗口远长于其覆盖范围，两条线会从中途才起步，与本基金起点不同源，
       * 视觉上等于用不同起点比较，属于误导；此时不画线，改为文字说明。
       */
      const winStart = f[0].d;
      const covered = function (arr) {
        const a = pick(arr);
        if (a.length <= 5) return null;
        const lagDays = (new Date(a[0].d).getTime() - new Date(winStart).getTime()) / 86400000;
        return lagDays <= 45 ? a : null;
      };
      const hidden = [];
      const peer = covered(data.peerAvg);
      if (peer) series.push({ name: '同类平均', type: 'line', showSymbol: false, data: toPct(peer), lineStyle: { width: 1.4, color: t.warn, type: 'dashed' } });
      else if ((data.peerAvg || []).length) hidden.push('同类平均');
      const csi = covered(data.csi300);
      if (csi) series.push({ name: '沪深300', type: 'line', showSymbol: false, data: toPct(csi), lineStyle: { width: 1.2, color: t.text, opacity: 0.65 } });
      else if ((data.csi300 || []).length) hidden.push('沪深300');

      // 基金经理更替标记（③ 好舵手需要在净值曲线上标注更替时点）
      const marks = (data.managerTerms || []).filter(function (m) { return new Date(m.start).getTime() >= from; });
      if (marks.length) {
        // 同一天可能有多位经理同时接任（共管），必须合并成一条标记，
        // 否则多条竖线与标签会完全重叠成一团无法辨认
        const byDate = {};
        marks.forEach(function (m) {
          if (!byDate[m.start]) byDate[m.start] = [];
          if (byDate[m.start].indexOf(m.name) < 0) byDate[m.start].push(m.name);
        });
        series[0].markLine = {
          symbol: 'none',
          silent: true,
          lineStyle: { color: t.brand2, type: 'dotted', width: 1 },
          // rotate: 0 必须显式指定：markLine 标签默认沿竖线旋转 90°，中文会竖排且相互叠压
          label: {
            formatter: function (p) { return p.name; },
            rotate: 0, fontSize: 10, color: t.brand2, position: 'insideEndTop', distance: [2, 2],
          },
          data: Object.keys(byDate).sort().map(function (d) {
            const names = byDate[d];
            const label = names.length > 2 ? names.slice(0, 2).join('、') + ' 等' : names.join('、');
            return { xAxis: d, name: (label.length > 9 ? label.slice(0, 8) + '…' : label) + ' 接任' };
          }),
        };
      }

      const opt = baseOption(t);
      opt.series = series;
      if (hidden.length) {
        // 明确告知为何缺少对照线，避免用户以为图表出错
        opt.graphic = [{
          type: 'text', right: 8, bottom: 2, silent: true,
          style: { text: hidden.join('、') + '仅公开近半年日频数据，长区间不作同起点对照', fill: t.text, opacity: 0.55, fontSize: 10 },
        }];
      }
      opt.xAxis = { type: 'time', axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, hideOverlap: true } };
      opt.yAxis = {
        type: 'value', name: '累计涨幅(%)', nameTextStyle: { color: t.text, fontSize: 10 },
        axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } },
        axisLabel: { color: t.text, formatter: '{value}%' },
      };
      // 移动端双指缩放 + 单指拖动；桌面端滚轮与框选
      opt.dataZoom = [
        { type: 'inside', zoomOnMouseWheel: !isMobile(), moveOnMouseMove: true, preventDefaultMouseMove: false },
      ];
      opt.tooltip.valueFormatter = function (v) { return (v > 0 ? '+' : '') + v + '%'; };
      return opt;
    });
  }

  /* ============ 四维雷达（A/M/X/T） ============ */
  function radarChart(node, scores, naDims) {
    return render(node, function (t) {
      const allDims = [
        { key: 'ability', name: '能力\nA' },
        { key: 'manager', name: '舵手\nM' },
        { key: 'experience', name: '体验\nX' },
        { key: 'timingCost', name: '时机成本\nT' },
      ];
      const isNa = function (d) {
        return (naDims || []).indexOf(d.key) >= 0 || !U.isNum(scores[d.key]);
      };
      /**
       * 不适用维度直接不画轴，而不是给 0 分、也不是留空值：
       * 给 0 分等于宣称「该维度极差」；留空值时 ECharts 雷达会把该顶点连到圆心，
       * 视觉效果与 0 分完全一样，同样具有误导性（实测已发生）。
       * 雷达至少需要 3 根轴，剩余不足 3 根时退回全量展示并在轴名标注不适用。
       */
      const usable = allDims.filter(function (d) { return !isNa(d); });
      const dropped = allDims.filter(isNa);
      const dims = usable.length >= 3 ? usable : allDims;
      const indicator = dims.map(function (d) {
        const na = isNa(d);
        return { name: d.name + (na ? '\n(不适用)' : ''), max: 100, color: na ? t.text : undefined };
      });
      const values = dims.map(function (d) { return isNa(d) ? '-' : scores[d.key]; });
      const naNote = usable.length >= 3 && dropped.length
        ? dropped.map(function (d) { return d.name.split('\n')[0]; }).join('、') + ' 维度本类型不适用，未纳入雷达'
        : null;
      return {
        backgroundColor: 'transparent',
        tooltip: { confine: true, backgroundColor: t.bg, borderColor: t.axis, textStyle: { color: t.text, fontSize: 12 } },
        graphic: naNote
          ? [{ type: 'text', left: 'center', bottom: 2, silent: true, style: { text: naNote, fill: t.text, opacity: 0.6, fontSize: 10 } }]
          : [],
        radar: {
          center: ['50%', '54%'],
          radius: isMobile() ? '62%' : '66%',
          indicator: indicator,
          axisName: { color: t.text, fontSize: isMobile() ? 11 : 12, lineHeight: 14 },
          splitLine: { lineStyle: { color: t.split } },
          splitArea: { areaStyle: { color: ['transparent'] } },
          axisLine: { lineStyle: { color: t.axis } },
        },
        series: [{
          type: 'radar',
          symbolSize: 5,
          data: [{
            value: values,
            name: '四刻度',
            lineStyle: { color: t.brand, width: 2 },
            itemStyle: { color: t.brand },
            areaStyle: { color: 'rgba(75,141,255,0.22)' },
          }],
        }],
      };
    });
  }

  /* ============ 回撤水下图 ============ */
  function drawdownChart(node, dd) {
    return render(node, function (t) {
      const opt = baseOption(t);
      opt.legend = { show: false };
      opt.series = [{
        name: '回撤', type: 'line', showSymbol: false,
        data: (dd || []).map(function (p) { return [p.d, p.v]; }),
        lineStyle: { width: 1, color: t.up },
        areaStyle: { color: 'rgba(255,77,106,0.26)' },
      }];
      opt.xAxis = { type: 'time', axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, hideOverlap: true } };
      opt.yAxis = {
        type: 'value', name: '回撤(%)', nameTextStyle: { color: t.text, fontSize: 10 }, max: 0,
        axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } },
        axisLabel: { color: t.text, formatter: '{value}%' },
      };
      opt.dataZoom = [{ type: 'inside', zoomOnMouseWheel: !isMobile() }];
      opt.tooltip.valueFormatter = function (v) { return v + '%'; };
      return opt;
    });
  }

  /* ============ 逐年收益柱状图（含同类排名分位标记） ============ */
  function yearlyChart(node, yearly) {
    return render(node, function (t) {
      const opt = baseOption(t);
      const years = (yearly || []).map(function (y) { return String(y.year) + (y.isPartial ? '*' : ''); });
      opt.legend = { show: false };
      opt.grid.bottom = isMobile() ? 30 : 26;
      opt.xAxis = { type: 'category', data: years, axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, interval: 0, fontSize: 10 } };
      opt.yAxis = { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } }, axisLabel: { color: t.text, formatter: '{value}%' } };
      opt.series = [{
        type: 'bar',
        barMaxWidth: 26,
        data: (yearly || []).map(function (y) {
          return { value: y.pct, itemStyle: { color: y.pct >= 0 ? t.up : t.down, borderRadius: 3 } };
        }),
        label: {
          show: true, position: 'top', fontSize: 10, color: t.text,
          formatter: function (p) {
            const y = yearly[p.dataIndex];
            return (y.pct > 0 ? '+' : '') + y.pct + '%' + (U.isNum(y.rankPct) ? '\n前' + y.rankPct + '%' : '');
          },
        },
      }];
      opt.tooltip.formatter = function (ps) {
        const y = yearly[ps[0].dataIndex];
        const lines = [String(y.year) + ' 年：' + (y.pct > 0 ? '+' : '') + y.pct + '%'];
        if (U.isNum(y.peerAvgPct)) lines.push('同类平均：' + (y.peerAvgPct > 0 ? '+' : '') + y.peerAvgPct + '%');
        if (U.isNum(y.rank)) lines.push('同类排名：' + y.rank + '/' + y.rankTotal);
        if (y.isPartial) lines.push('（' + (y.partialReason || '非完整年度') + '）');
        return lines.join('<br/>');
      };
      return opt;
    });
  }

  /* ============ 滚动持有正收益概率 ============ */
  function rollingChart(node, rolling) {
    return render(node, function (t) {
      const keys = ['1m', '6m', '1y', '2y', '3y'];
      const labels = { '1m': '持有1月', '6m': '持有6月', '1y': '持有1年', '2y': '持有2年', '3y': '持有3年' };
      const avail = keys.filter(function (k) { return rolling && rolling[k] && rolling[k].available; });
      const opt = baseOption(t);
      opt.legend = { show: false };
      opt.grid.bottom = isMobile() ? 30 : 26;
      opt.xAxis = { type: 'category', data: avail.map(function (k) { return labels[k]; }), axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, fontSize: 10, interval: 0 } };
      opt.yAxis = { type: 'value', max: 100, axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } }, axisLabel: { color: t.text, formatter: '{value}%' } };
      opt.series = [{
        type: 'bar',
        barMaxWidth: 42,
        data: avail.map(function (k) {
          const v = rolling[k].positiveRatePct;
          return { value: v, itemStyle: { color: v >= 70 ? t.down : v >= 50 ? t.brand : t.up, borderRadius: 3 } };
        }),
        label: { show: true, position: 'top', fontSize: 11, color: t.text, formatter: '{c}%' },
      }];
      opt.tooltip.formatter = function (ps) {
        const r = rolling[avail[ps[0].dataIndex]];
        return [
          labels[avail[ps[0].dataIndex]] + '：正收益概率 ' + r.positiveRatePct + '%',
          '收益中位数 ' + r.medianPct + '%',
          '较差情形(P10) ' + r.p10Pct + '% / 较好情形(P90) ' + r.p90Pct + '%',
          '样本 ' + r.samples + ' 个（' + r.sampleFrom + ' ~ ' + r.sampleTo + '）',
        ].join('<br/>');
      };
      return opt;
    });
  }

  /* ============ 行业分布（条形） ============ */
  function industryChart(node, industries) {
    return render(node, function (t) {
      const list = (industries || []).slice(0, 8).slice().reverse();
      const opt = baseOption(t);
      opt.legend = { show: false };
      opt.grid = { left: isMobile() ? 78 : 100, right: 40, top: 10, bottom: 20 };
      opt.xAxis = { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } }, axisLabel: { color: t.text, formatter: '{value}%' } };
      opt.yAxis = { type: 'category', data: list.map(function (x) { return x.name; }), axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, fontSize: 10 } };
      opt.series = [{
        type: 'bar',
        barMaxWidth: 22,
        data: list.map(function (x) { return x.pct; }),
        itemStyle: { color: t.brand, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', fontSize: 10, color: t.text, formatter: '{c}%' },
      }];
      opt.tooltip.valueFormatter = function (v) { return v + '%'; };
      return opt;
    });
  }

  /* ============ 风格漂移堆叠图（多期行业分布） ============ */
  function driftChart(node, stack) {
    return render(node, function (t) {
      const periods = (stack || []).map(function (s) { return s.period; });
      const names = {};
      (stack || []).forEach(function (s) { (s.industries || []).forEach(function (i) { names[i.name] = 1; }); });
      const keys = Object.keys(names).slice(0, 8);
      const palette = [t.brand, t.brand2, t.warn, t.down, t.up, '#4bc0ff', '#a8b4d8', '#ff9f7f'];
      const opt = baseOption(t);
      opt.legend = { top: 0, textStyle: { color: t.text, fontSize: 10 }, itemWidth: 10, itemHeight: 7, type: 'scroll' };
      opt.grid.top = 34;
      opt.xAxis = { type: 'category', data: periods, axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, fontSize: 10 } };
      opt.yAxis = { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } }, axisLabel: { color: t.text, formatter: '{value}%' } };
      opt.series = keys.map(function (k, i) {
        return {
          name: k, type: 'bar', stack: 'total',
          itemStyle: { color: palette[i % palette.length] },
          data: (stack || []).map(function (s) {
            const hit = (s.industries || []).filter(function (x) { return x.name === k; })[0];
            return hit ? hit.pct : 0;
          }),
        };
      });
      opt.tooltip.valueFormatter = function (v) { return v + '%'; };
      return opt;
    });
  }

  /* ============ 规模变化 ============ */
  function scaleChart(node, trend) {
    return render(node, function (t) {
      const opt = baseOption(t);
      opt.legend = { show: false };
      opt.xAxis = { type: 'category', data: (trend || []).map(function (x) { return x.asOf; }), axisLine: { lineStyle: { color: t.axis } }, axisLabel: { color: t.text, fontSize: 10, hideOverlap: true } };
      opt.yAxis = { type: 'value', name: '亿元', nameTextStyle: { color: t.text, fontSize: 10 }, axisLine: { show: false }, splitLine: { lineStyle: { color: t.split } }, axisLabel: { color: t.text } };
      opt.series = [{
        type: 'bar', barMaxWidth: 46, data: (trend || []).map(function (x) { return x.valueYi; }),
        itemStyle: { color: t.brand2, borderRadius: [4, 4, 0, 0] },
        label: { show: !isMobile(), position: 'top', fontSize: 10, color: t.text },
      }];
      opt.tooltip.valueFormatter = function (v) { return v + ' 亿元'; };
      return opt;
    });
  }

  /* ============ 持有人结构（环形） ============ */
  function holderChart(node, holders) {
    return render(node, function (t) {
      const data = [];
      if (U.isNum(holders.institutionPct)) data.push({ name: '机构持有', value: holders.institutionPct });
      if (U.isNum(holders.individualPct)) data.push({ name: '个人持有', value: holders.individualPct });
      if (U.isNum(holders.internalPct) && holders.internalPct > 0) data.push({ name: '内部持有', value: holders.internalPct });
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', confine: true, backgroundColor: t.bg, borderColor: t.axis, textStyle: { color: t.text, fontSize: 12 }, valueFormatter: function (v) { return v + '%'; } },
        legend: { bottom: 0, textStyle: { color: t.text, fontSize: 11 }, itemWidth: 10, itemHeight: 8 },
        series: [{
          type: 'pie', radius: ['45%', '68%'], center: ['50%', '44%'],
          itemStyle: { borderColor: t.bg, borderWidth: 2 },
          color: [t.warn, t.brand, t.brand2],
          label: { color: t.text, fontSize: 11, formatter: '{b}\n{d}%' },
          data: data,
        }],
      };
    });
  }

  global.Charts = {
    load: load,
    navChart: navChart,
    radarChart: radarChart,
    drawdownChart: drawdownChart,
    yearlyChart: yearlyChart,
    rollingChart: rollingChart,
    industryChart: industryChart,
    driftChart: driftChart,
    scaleChart: scaleChart,
    holderChart: holderChart,
  };
})(window);
