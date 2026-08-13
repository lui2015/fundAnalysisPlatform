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
      list.forEach(function (it) {
        box.appendChild(el('span', { class: 'chip' }, [
          el('button', {
            class: 'clamp-toggle', attrs: { type: 'button' }, style: { color: 'inherit', fontSize: '13px' },
            text: (it.name || it.code) + ' ',
            on: { click: function () { go(it); } },
          }),
          el('button', {
            class: 'chip__x', attrs: { type: 'button', 'aria-label': '移出自选' }, text: '×',
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

  /* ------------------------- 热门基金 ------------------------- */
  const HOT_TYPES = [
    { key: '', label: '全部' },
    { key: '股票型', label: '股票型' },
    { key: '混合型', label: '混合型' },
    { key: '债券型', label: '债券型' },
    { key: '指数型', label: '指数型' },
    { key: 'QDII', label: 'QDII' },
    { key: 'FOF', label: 'FOF' },
    { key: '货币型', label: '货币型' },
    { key: '商品型', label: '商品型' },
  ];

  let hotType = '';
  let hotAllData = []; // 缓存全量数据用于客户端筛选

  function buildFilters(container, activeKey) {
    U.clear(container);
    HOT_TYPES.forEach(function (t) {
      container.appendChild(el('button', {
        class: 'hot__filter' + (t.key === activeKey ? ' active' : ''),
        attrs: { type: 'button', 'data-type': t.key },
        on: { click: function () { hotType = t.key; applyHotFilter(); } },
        text: t.label,
      }));
    });
  }

  /** 渲染单个热门卡片 */
  function hotCardNode(it) {
    return el('a', {
      class: 'hot-card',
      attrs: { href: 'report.html?code=' + encodeURIComponent(it.code) + '&name=' + encodeURIComponent(it.name || '') },
    }, [
      el('span', { class: 'hot-card__name', text: it.name || it.code }),
      el('span', { class: 'hot-card__meta', text: it.code }),
      it.typeText ? el('span', { class: 'hot-card__tag', text: it.typeText }) : null,
    ].filter(Boolean));
  }

  function applyHotFilter() {
    // 更新两组筛选按钮状态
    [U.$('#hot-filters'), U.$('#hot-drawer-filters')].forEach(function ($c) {
      if (!$c) return;
      U.$$c('.hot__filter', $c).forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-type') === hotType);
      });
    });

    var filtered = hotType
      ? hotAllData.filter(function (f) { return (f.typeText || '').includes(hotType); })
      : hotAllData;

    // 首页网格（最多8个）
    var $grid = U.$('#hot-list');
    U.clear($grid);
    filtered.slice(0, 8).forEach(function (it) { $grid.appendChild(hotCardNode(it)); });

    // 侧拉面板网格（全部）
    var $dGrid = U.$('#hot-drawer-list');
    if ($dGrid) { U.clear($dGrid); filtered.forEach(function (it) { $dGrid.appendChild(hotCardNode(it)); }); }
  }

  async function renderHot() {
    try {
      var r = await U.api('hot?limit=50');
      hotAllData = r.data || [];
      buildFilters(U.$('#hot-filters'), '');
      buildFilters(U.$('#hot-drawer-filters'), '');
      applyHotFilter();
    } catch (e) {
      U.$('#hot-list').appendChild(el('div', { class: 'sg-empty', text: '热门列表暂不可用' }));
    }
  }

  // 查看全部侧拉面板
  var $hotDrawer = U.$('#hot-drawer');
  U.$('#btn-hot-all').addEventListener('click', function () { $hotDrawer.classList.add('open'); });
  U.$('#btn-hot-close').addEventListener('click', function () { $hotDrawer.classList.remove('open'); });
  $hotDrawer && $hotDrawer.querySelector('.drawer__overlay').addEventListener('click', function () { $hotDrawer.classList.remove('open'); });

  /* ------------------------- 初始化 ------------------------- */
  U.initTheme();
  U.$('#disclaimer-text').textContent = U.DISCLAIMER_TEXT;
  renderRecent();
  renderWatchlist();
  renderReports();
  renderHot();
})();
