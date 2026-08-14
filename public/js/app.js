/* 首页交互：搜索联想、最近搜索、自选、热门、历史报告
   移动端：点击输入框进入全屏搜索层；桌面端：输入框下方浮层 + 键盘 ↑↓ Enter Esc */
(function () {
  'use strict';
  const U = window.U;
  const el = U.el;

  let items = [];
  let activeIndex = -1;
  let debounceTimer = null;

  const $q = U.$('#q');
  const $qm = U.$('#q-mobile');
  const $suggest = U.$('#suggest');
  const $list = U.$('#suggest-list');

  const isMobileLayout = function () { return window.innerWidth < 768; };

  /* ------------------------- 搜索 ------------------------- */
  function openSuggest() {
    $suggest.classList.add('open');
    $q.setAttribute('aria-expanded', 'true');
    if (isMobileLayout()) {
      $qm.value = $q.value;
      setTimeout(function () { $qm.focus(); }, 30);
    }
  }

  function closeSuggest() {
    $suggest.classList.remove('open');
    $q.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function renderSuggest(list, keyword) {
    U.clear($list);
    items = list || [];
    if (!items.length) {
      $list.appendChild(
        el('div', { class: 'sg-empty' }, [
          el('div', { text: keyword ? '没有找到「' + keyword + '」相关的基金' : '输入基金名称、6 位代码或拼音首字母开始搜索' }),
          el('div', { style: { marginTop: '8px', lineHeight: '1.9' } }, [
            el('div', { text: '· 请检查代码是否为 6 位数字（基金代码，不是股票代码）' }),
            el('div', { text: '· 一期支持境内公募开放式基金与 ETF/LOF，暂不支持私募、专户与券商资管' }),
            el('div', { text: '· 拼音首字母搜索仅覆盖内置常见基金，可改用完整名称或代码' }),
          ]),
        ])
      );
      return;
    }
    items.forEach(function (it, i) {
      const tags = [];
      if (it.typeText) tags.push(el('span', { class: 'tag tag--type', text: it.typeText }));
      // A/C 份额必须显式区分（F1-3）
      if (it.shareClass && it.shareClass !== '—') tags.push(el('span', { class: 'tag tag--share', text: it.shareClass + ' 类' }));
      if (it.siblingCount > 1) tags.push(el('span', { class: 'tag', text: '同系列 ' + it.siblingCount + ' 个份额' }));

      const node = el('button', {
        class: 'sg-item' + (i === activeIndex ? ' active' : ''),
        attrs: { type: 'button', role: 'option', 'data-i': i },
        on: { click: function () { go(it); } },
      }, [
        el('div', { class: 'sg-item__main' }, [
          el('div', { class: 'sg-item__name' }, [el('span', { text: it.name })].concat(tags)),
          el('div', { class: 'sg-item__meta', text: [it.code, it.company, it.manager ? '经理 ' + it.manager : ''].filter(Boolean).join(' · ') }),
        ]),
        el('div', { class: 'sg-item__right' }, [
          el('div', { class: 'sg-item__nav', text: U.isNum(it.nav) ? it.nav.toFixed(4) : '—' }),
          el('div', {
            class: 'sg-item__chg ' + U.dirClass(it.dayChangePct),
            text: U.isNum(it.dayChangePct) ? U.pct(it.dayChangePct) : (it.navDate || ''),
          }),
        ]),
      ]);
      $list.appendChild(node);
    });
  }

  async function doSearch(kw) {
    if (!kw) { renderSuggest([], ''); return; }
    try {
      const r = await U.api('search?q=' + encodeURIComponent(kw) + '&limit=10');
      renderSuggest(r.data || [], kw);
    } catch (e) {
      renderSuggest([], kw);
    }
  }

  function onInput(v) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { doSearch(v.trim()); }, 300); // 防抖 300ms（F1-2）
  }

  /** 跳转分析页 */
  function go(it) {
    U.recentAdd(it);
    location.href = 'report.html?code=' + encodeURIComponent(it.code) + '&name=' + encodeURIComponent(it.name || '');
  }

  /** 直接按当前输入分析：命中多个结果时不自动跳转，必须用户显式选择（F1-5） */
  async function analyzeCurrent() {
    const kw = ($q.value || '').trim();
    if (!kw) { U.toast('请先输入基金名称或代码'); $q.focus(); return; }
    if (/^\d{6}$/.test(kw)) {
      go({ code: kw, name: '' });
      return;
    }
    const r = await U.api('search?q=' + encodeURIComponent(kw) + '&limit=10').catch(function () { return { data: [] }; });
    const list = r.data || [];
    if (list.length === 1) { go(list[0]); return; }
    renderSuggest(list, kw);
    openSuggest();
    if (list.length > 1) U.toast('找到 ' + list.length + ' 个结果，请选择具体基金（注意区分 A/C 份额）');
  }

  $q.addEventListener('focus', function () { if (isMobileLayout()) openSuggest(); });
  $q.addEventListener('input', function () {
    if (!$suggest.classList.contains('open')) openSuggest();
    onInput($q.value);
  });
  $qm.addEventListener('input', function () { $q.value = $qm.value; onInput($qm.value); });
  U.$('#btn-suggest-close').addEventListener('click', closeSuggest);
  U.$('#btn-search').addEventListener('click', analyzeCurrent);

  // 桌面端键盘操作（F1-4）
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== $q && document.activeElement !== $qm) {
      e.preventDefault();
      $q.focus();
      return;
    }
    if (e.key === 'Escape') { closeSuggest(); return; }
    if (!$suggest.classList.contains('open') && document.activeElement !== $q) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      activeIndex = e.key === 'ArrowDown'
        ? Math.min(items.length - 1, activeIndex + 1)
        : Math.max(0, activeIndex - 1);
      U.$$('.sg-item', $list).forEach(function (n, i) { n.classList.toggle('active', i === activeIndex); });
      const node = U.$$('.sg-item', $list)[activeIndex];
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && items[activeIndex]) { go(items[activeIndex]); }
      else if (document.activeElement === $q || document.activeElement === $qm) { analyzeCurrent(); }
    }
  });

  // 点击浮层外关闭（仅桌面端）
  document.addEventListener('click', function (e) {
    if (isMobileLayout()) return;
    if (!U.$('#searchbox').contains(e.target)) closeSuggest();
  });

  /* ------------------------- 最近搜索 ------------------------- */
  function renderRecent() {
    const list = U.recentGet();
    const wrap = U.$('#recent-wrap');
    const box = U.$('#recent-list');
    U.clear(box);
    if (!list.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    list.forEach(function (it) {
      box.appendChild(el('button', {
        class: 'chip', attrs: { type: 'button' },
        on: { click: function () { go(it); } },
      }, [el('span', { text: it.name || it.code }), el('span', { class: 'tag', text: it.code })]));
    });
  }
  U.$('#btn-recent-clear').addEventListener('click', function () { U.recentClear(); renderRecent(); });

  /* ------------------------- 自选 ------------------------- */
  async function renderWatchlist() {
    try {
      const r = await U.api('watchlist');
      const list = r.data || [];
      U.$('#watch-count').textContent = String(list.length);
      const wrap = U.$('#watchlist-wrap');
      const box = U.$('#watchlist-list');
      U.clear(box);
      if (!list.length) { wrap.classList.add('hidden'); return; }
      wrap.classList.remove('hidden');

      // 获取热门基金数据以补充收益率等信息
      // 先批量拉取前100条，再对未命中的自选基金逐只用 keyword 精确查询
      var hotData = {};
      try {
        var hr = await U.api('hot?page=1&pageSize=100');
        (hr.data || []).forEach(function (f) { hotData[f.code] = f; });
        // 对未在 top100 中的自选基金，用代码精确搜索补全
        var missing = list.filter(function (it) { return !hotData[it.code]; });
        for (var i = 0; i < missing.length; i++) {
          try {
            var mr = await U.api('hot?page=1&pageSize=5&keyword=' + encodeURIComponent(missing[i].code));
            var found = (mr.data || []).find(function (f) { return f.code === missing[i].code; });
            if (found) hotData[missing[i].code] = found;
          } catch (_) {}
        }
      } catch (_) {}

      list.forEach(function (it) {
        var info = hotData[it.code] || {};
        var ret = info.returnSinceStart;
        var retText = typeof ret === 'number' ? (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%' : '--';
        var retCls = typeof ret === 'number' ? (ret >= 0 ? 'is-up' : 'is-down') : '';

        box.appendChild(el('div', { class: 'watch-card' }, [
          el('div', { class: 'watch-card__body' }, [
            el('button', {
              class: 'watch-card__name', attrs: { type: 'button' },
              text: it.name || it.code,
              on: { click: function () { go(it); } },
            }),
            el('div', { class: 'watch-card__info' }, [
              el('span', { class: 'watch-card__code', text: it.code || '' }),
              el('span', { class: 'watch-card__sep', text: '|' }),
              el('span', { class: 'watch-card__type', text: info.typeText || '--' }),
            ]),
          ]),
          el('span', { class: 'watch-card__return ' + retCls, text: retText }),
          el('button', {
            class: 'watch-card__del', attrs: { type: 'button', 'aria-label': '移出自选' }, text: '×',
            on: {
              click: async function (e) {
                e.stopPropagation();
                await U.api('watchlist', { method: 'DELETE', body: { code: it.code } }).catch(function () {});
                renderWatchlist();
              },
            },
          }),
        ]));
      });
    } catch (e) { /* 自选不可用不影响主流程 */ }
  }
  U.$('#btn-watchlist').addEventListener('click', function () {
    const wrap = U.$('#watchlist-wrap');
    if (wrap.classList.contains('hidden')) { U.toast('自选列表为空，可在报告页添加'); return; }
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ------------------------- 历史报告（侧拉面板） ------------------------- */
  const $drawer = U.$('#history-drawer');
  const $historyList = U.$('#history-list');

  function openHistory() { $drawer.classList.add('open'); }
  function closeHistory() { $drawer.classList.remove('open'); }

  U.$('#btn-history').addEventListener('click', openHistory);
  U.$('#btn-history-close').addEventListener('click', closeHistory);
  $drawer.querySelector('.drawer__overlay').addEventListener('click', closeHistory);

  async function renderReports() {
    try {
      const r = await U.api('reports?limit=10');
      U.clear($historyList);
      const list = r.data || [];
      if (!list.length) {
        $historyList.appendChild(el('div', { class: 'sg-empty', text: '还没有生成过报告，搜索一只基金开始吧' }));
        return;
      }
      list.forEach(function (it) {
        const s = it.scores || {};
        $historyList.appendChild(el('a', { class: 'report-item', attrs: { href: 'report.html?id=' + it.id } }, [
          el('div', { style: { flex: '1', minWidth: '0' } }, [
            el('div', { style: { fontSize: '14px', fontWeight: '600' }, text: it.name || it.code }),
            el('div', { style: { fontSize: '11px', color: 'var(--c-text-3)', marginTop: '2px' },
              text: [it.code, it.fundTypeLabel, '净值 ' + (it.navDate || '—'), U.timeAgo(it.createdAt)].filter(Boolean).join(' · ') }),
          ]),
          el('div', { style: { textAlign: 'right', flex: 'none', fontFamily: 'var(--font-mono)', fontSize: '12px' } }, [
            el('div', { text: 'A ' + (U.isNum(s.ability) ? s.ability : '—') + ' · X ' + (U.isNum(s.experience) ? s.experience : '—') }),
            el('div', { class: 'dot dot--' + (it.riskLevel || 'green'), style: { marginTop: '4px', display: 'inline-block' } }),
          ]),
        ]));
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------- 热门基金（多维度筛选） ------------------------- */

  /** 筛选维度定义 */
  var HOT_DIMS = [
    { key: 'asset', label: '底层资产', options: ['股票', '债券', '混合', '货币', '商品'] },
    { key: 'operation', label: '运作方式', options: ['开放式', 'ETF', 'LOF', 'FOF', '定开'] },
    { key: 'strategy', label: '投资策略', options: ['主动管理', '被动指数', '量化'] },
    { key: 'region', label: '地域', options: ['境内', 'QDII'] },
    { key: 'theme', label: '赛道主题', options: [
      '消费', '科技', '医药', '新能源', '高端制造', '金融地产',
      '红利', '军工国防', '资源周期', '农业', '港股', '美股', '全球配置', '债券纯债',
    ]},
  ];

  // 每个维度的已选项（key → 已选值数组，空数组=不限）
  var hotFilters = {};
  HOT_DIMS.forEach(function (d) { hotFilters[d.key] = []; });
  var hotSearchText = ''; // 模糊搜索关键词
  var hotAllData = [];
  var HOT_PAGE_SIZE = 24; // 3列 × 8行
  var hotPage = 1;

  /**
   * 构建所有筛选下拉框
   * 每个维度一个「标签 ▾」触发器 + 多选 checkbox 面板
   */
  // 缓存面板 DOM 引用，避免重建
  var _dimBtns = {}; // { key: $btn }
  var _dimPanels = {}; // { key: $panel }
  var _filtersBuilt = false; // 防止重复构建 DOM

  function buildFilters(container) {
    if (!container) return;
    // 已构建过则跳过，避免重复追加 DOM
    if (_filtersBuilt) return;
    _filtersBuilt = true;
    U.clear(container);
    var wrap = el('div', { class: 'hot__dims' });

    HOT_DIMS.forEach(function (dim) {
      var selected = hotFilters[dim.key] || [];
      var btnText = selected.length === 0 ? dim.label : dim.label + '(' + selected.length + ')';
      var $btn = el('button', {
        class: 'hot__dim-trigger' + (selected.length > 0 ? ' has-value' : ''),
        attrs: { type: 'button' },
        on: { click: function (e) { e.stopPropagation(); toggleDimPanel(wrap, dim.key); } },
      }, [
        el('span', { class: 'hot__dim-label', text: btnText }),
        el('span', { class: 'hot__dim-arrow', text: '▾' }),
      ]);

      var $panel = el('div', { class: 'hot__dim-panel', attrs: { 'data-dim': dim.key } }, [
        el('label', { class: 'hot__dim-opt' }, [
          el('input', { attrs: { type: 'checkbox', checked: selected.length === 0, 'data-val': '__all__' } }),
          el('span', { text: '全部（不限）' }),
        ]),
        el('div', { class: 'hot__dim-divider' }),
      ]);
      dim.options.forEach(function (opt) {
        $panel.appendChild(el('label', { class: 'hot__dim-opt' }, [
          el('input', { attrs: { type: 'checkbox', checked: selected.indexOf(opt) >= 0, 'data-val': opt } }),
          el('span', { text: opt }),
        ]));
      });

      // 每个维度：按钮+面板包裹在同一容器中，面板在按钮正下方
      var $wrap = el('div', { class: 'hot__dim-wrap' });
      $wrap.appendChild($btn);
      $wrap.appendChild($panel);
      wrap.appendChild($wrap);

      _dimBtns[dim.key] = $btn;
      _dimPanels[dim.key] = $panel;

      // change 委托
      $panel.addEventListener('change', function (ev) {
        if (ev.target.type !== 'checkbox') return;
        var val = ev.target.getAttribute('data-val');
        if (val === '__all__') {
          hotFilters[dim.key] = [];
          // 重置所有 checkbox 状态
          var cbs = $panel.querySelectorAll('input[type=checkbox]');
          for (var i = 0; i < cbs.length; i++) cbs[i].checked = (i === 0);
        } else {
          var arr = hotFilters[dim.key] || [];
          var idx = arr.indexOf(val);
          if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
          hotFilters[dim.key] = arr;
          // 更新"全部" checkbox
          var allCb = $panel.querySelector('input[data-val=__all__]');
          if (allCb) allCb.checked = false;
        }
        // 只更新按钮文字，不重建 DOM
        updateDimBtnText(dim.key);
        hotPage = 1;
        applyHotFilter();
      });
    });

    container.appendChild(wrap);

    // 搜索框（放入 wrap 内，与筛选按钮同行）
    var $search = el('input', {
      class: 'hot__search',
      attrs: {
        type: 'text',
        placeholder: '搜索基金名称/代码...',
        value: hotSearchText,
      },
      on: {
        input: function () {
          hotSearchText = this.value.trim();
          if (hotSearchTimer) clearTimeout(hotSearchTimer);
          hotSearchTimer = setTimeout(function () {
            hotPage = 1;
            applyHotFilter();
          }, 300);
        },
        keydown: function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hotSearchTimer) clearTimeout(hotSearchTimer);
            hotPage = 1;
            applyHotFilter();
          }
        },
      },
    });
    var $searchWrap = el('div', { class: 'hot__search-wrap' }, [$search]);
    wrap.appendChild($searchWrap);

    // 点击外部关闭：仅当点击目标不在任何筛选面板/触发按钮内时才关闭
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && (t.closest('.hot__dim-panel') || t.closest('.hot__dim-trigger'))) return;
      closeAllDimPanels();
    });
  }

  /** 仅更新按钮文字和样式，不重建 DOM */
  function updateDimBtnText(key) {
    var $btn = _dimBtns[key];
    if (!$btn) return;
    var dim = HOT_DIMS.find(function (d) { return d.key === key; });
    if (!dim) return;
    var selected = hotFilters[key] || [];
    var btnText = selected.length === 0 ? dim.label : dim.label + '(' + selected.length + ')';
    var labelEl = $btn.querySelector('.hot__dim-label');
    if (labelEl) labelEl.textContent = btnText;
    $btn.className = 'hot__dim-trigger' + (selected.length > 0 ? ' has-value' : '');
  }

  var hotSearchTimer = null;

  function toggleDimPanel(wrap, dimKey) {
    var wasOpen = false;
    wrap.querySelectorAll('.hot__dim-panel').forEach(function (p) {
      if (p.getAttribute('data-dim') === dimKey) {
        wasOpen = p.classList.contains('open');
        p.classList.toggle('open');
      } else {
        p.classList.remove('open');
      }
    });
    wrap.querySelectorAll('.hot__dim-arrow').forEach(function (a, i) {
      var panel = wrap.querySelectorAll('.hot__dim-panel')[i];
      if (!panel) return;
      a.style.transform = panel.getAttribute('data-dim') === dimKey && !wasOpen ? 'rotate(180deg)' : '';
    });
  }

  /** 渲染热门基金列表（后端分页数据） */
  function renderHotList(data) {
    var $grid = U.$('#hot-list');
    if (!$grid) return;
    U.clear($grid);
    (data || []).forEach(function (it) { $grid.appendChild(hotCardNode(it)); });
    buildPagination(U.$('#hot-pagination'), hotTotal, hotPage, HOT_PAGE_SIZE);
  }

  function closeAllDimPanels() {
    document.querySelectorAll('.hot__dim-panel.open').forEach(function (p) { p.classList.remove('open'); });
    document.querySelectorAll('.hot__dim-arrow').forEach(function (a) { a.style.transform = ''; });
  }

  /** 分页控件（不变） */
  function buildPagination(container, total, page, pageSize) {
    if (!container) return;
    U.clear(container);
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1) { container.style.display = 'none'; return; }
    container.style.display = '';

    // 上一页
    container.appendChild(el('button', {
      class: 'hot__page-btn' + (page <= 1 ? ' disabled' : ''),
      attrs: { type: 'button', disabled: page <= 1 },
      on: { click: function () { if (page > 1) { hotPage = page - 1; applyHotFilter(); } } },
      text: '‹',
    }));

    // 页码（最多显示7个，省略号）
    var pages = [];
    if (totalPages <= 7) { for (var i = 1; i <= totalPages; i++) pages.push(i); }
    else {
      pages.push(1);
      if (page > 3) pages.push('...');
      for (var s = Math.max(2, page - 1), e = Math.min(totalPages - 1, page + 1); s <= e; s++) pages.push(s);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    pages.forEach(function (p) {
      if (p === '...') {
        container.appendChild(el('span', { class: 'hot__page-ellipsis', text: '…' }));
      } else {
        container.appendChild(el('button', {
          class: 'hot__page-btn' + (p === page ? ' active' : ''),
          attrs: { type: 'button' },
          on: { click: function () { hotPage = p; applyHotFilter(); } },
          text: String(p),
        }));
      }
    });

    // 下一页
    container.appendChild(el('button', {
      class: 'hot__page-btn' + (page >= totalPages ? ' disabled' : ''),
      attrs: { type: 'button', disabled: page >= totalPages },
      on: { click: function () { if (page < totalPages) { hotPage = page + 1; applyHotFilter(); } } },
      text: '›',
    }));

    // 总数提示
    container.appendChild(el('span', { class: 'hot__page-info', text: '共 ' + total + ' 只' }));
  }

  /** 渲染单个热门卡片 */
  function hotCardNode(it) {
    var children = [
      el('span', { class: 'hot-card__name', text: it.name || it.code }),
      el('span', { class: 'hot-card__meta', text: it.code }),
      it.typeText ? el('span', { class: 'hot-card__tag', text: it.typeText }) : null,
    ];
    // 成立来年化收益率（不足 1 年不年化，后端返回 null 时不展示）
    if (it.returnSinceStart != null) {
      var val = it.returnSinceStart;
      var tip = '成立以来年化收益率';
      if (it.returnSinceStartCum != null) tip += '（累计 ' + it.returnSinceStartCum.toFixed(2) + '%';
      if (it.establishDate) tip += '，成立于 ' + it.establishDate;
      if (it.returnSinceStartCum != null) tip += '）';
      children.push(el('span', {
        class: 'hot-card__return' + (val >= 0 ? ' is-up' : ' is-down'),
        text: (val >= 0 ? '+' : '') + val.toFixed(2) + '%',
        attrs: { title: tip },
      }));
    }
    return el('a', {
      class: 'hot-card',
      attrs: { href: 'report.html?code=' + encodeURIComponent(it.code) + '&name=' + encodeURIComponent(it.name || '') },
    }, children.filter(Boolean));
  }

  /**
   * 多维度筛选：每个维度内部 OR，维度之间 AND
   * 例如：底层资产=股票|混合 AND 运作方式=ETF AND 赛道=科技
   */
  async function applyHotFilter() {
    // 筛选 DOM 只在 renderHot 首次构建，此处仅重新请求数据
    try {
      var r = await fetchHotPage();
      hotAllData = r.data || [];
      hotTotal = r.total || 0;
      renderHotList(hotAllData);
    } catch (e) {
      // 失败静默处理
    }
  }

  // 后端分页：从服务端获取指定页数据
  var hotTotal = 0;
  async function fetchHotPage() {
    var params = 'page=' + hotPage + '&pageSize=' + HOT_PAGE_SIZE;
    // 收集当前筛选条件
    var hasFilter = false;
    HOT_DIMS.forEach(function (d) {
      if (hotFilters[d.key] && hotFilters[d.key].length > 0) {
        params += '&' + d.key + '=' + encodeURIComponent(hotFilters[d.key].join(','));
        hasFilter = true;
      }
    });
    // 搜索关键词
    if (hotSearchText) {
      params += '&keyword=' + encodeURIComponent(hotSearchText);
      hasFilter = true;
    }
    var r = await U.api('hot?' + params);
    return r;
  }

  async function renderHot() {
    try {
      var r = await fetchHotPage();
      hotAllData = r.data || [];
      hotTotal = r.total || 0;
      buildFilters(U.$('#hot-filters'));
      renderHotList(hotAllData);
    } catch (e) {
      U.$('#hot-list').appendChild(el('div', { class: 'sg-empty', text: '热门列表暂不可用' }));
    }
  }

  /* ------------------------- 初始化 ------------------------- */
  U.initTheme();
  U.$('#disclaimer-text').textContent = U.DISCLAIMER_TEXT;
  renderRecent();
  renderWatchlist();
  renderReports();
  renderHot();
})();
