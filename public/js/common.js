/* 公共工具：DOM、格式化、请求、免责确认
   安全约定：一律使用 textContent 赋值，不使用 innerHTML 注入动态内容（S-4 防 XSS） */
(function (global) {
  'use strict';

  /* ---------------------- DOM ---------------------- */
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.class) node.className = opts.class;
      if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
      if (opts.attrs) {
        for (const k in opts.attrs) {
          const v = opts.attrs[k];
          if (v !== null && v !== undefined) node.setAttribute(k, String(v));
        }
      }
      if (opts.on) for (const k in opts.on) node.addEventListener(k, opts.on[k]);
      if (opts.style) for (const k in opts.style) node.style[k] = opts.style[k];
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined || c === false || c === '') return;
        node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return node;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  /* ---------------------- 格式化 ---------------------- */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function num(v, d) {
    if (!isNum(v)) return '—';
    return v.toFixed(d === undefined ? 2 : d);
  }

  function pct(v, d) {
    if (!isNum(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(d === undefined ? 2 : d) + '%';
  }

  function pctAbs(v, d) {
    if (!isNum(v)) return '—';
    return v.toFixed(d === undefined ? 2 : d) + '%';
  }

  function yi(v) {
    if (!isNum(v)) return '—';
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(2) + ' 万亿';
    return v.toFixed(2) + ' 亿';
  }

  function money(v) {
    if (!isNum(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + ' 亿元';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + ' 万元';
    return v.toFixed(0) + ' 元';
  }

  function dirClass(v) {
    if (!isNum(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  /* ---------------------- 请求 ---------------------- */
  function deviceId() {
    let id = localStorage.getItem('fap_device_id');
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('fap_device_id', id);
    }
    return id;
  }

  async function api(path, opts) {
    const options = Object.assign({ headers: {} }, opts || {});
    options.headers = Object.assign(
      { 'Content-Type': 'application/json', 'X-Device-Id': deviceId() },
      options.headers
    );
    if (options.body && typeof options.body !== 'string') options.body = JSON.stringify(options.body);
    // 全部相对路径，保证子路径部署（/fundAnalysis/）时无需前缀
    const res = await fetch('api/' + path.replace(/^\/+/, ''), options);
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || ('请求失败 (' + res.status + ')'));
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  /* ---------------------- 提示 ---------------------- */
  let toastTimer = null;
  function toast(msg) {
    let node = $('#toast');
    if (!node) {
      node = el('div', { class: 'toast', attrs: { id: 'toast', role: 'status' } });
      document.body.appendChild(node);
    }
    node.textContent = msg;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, 2800);
  }

  /* ---------------------- 主题 ---------------------- */
  function initTheme() {
    const btn = $('#theme-toggle');
    const apply = function (t) {
      if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
      if (btn) btn.textContent = t === 'light' ? '☀' : '☾';
    };
    let cur = localStorage.getItem('fap_theme');
    // 默认暗色（赛博朋克风格），忽略系统偏好
    if (!cur) cur = 'dark';
    apply(cur);
    if (btn) {
      btn.addEventListener('click', function () {
        cur = cur === 'light' ? 'dark' : 'light';
        localStorage.setItem('fap_theme', cur);
        apply(cur);
        if (global.FAP_ON_THEME_CHANGE) global.FAP_ON_THEME_CHANGE();
      });
    }
  }

  /* ---------------------- 免责声明（F7-1） ---------------------- */
  const DISCLAIMER_KEY = 'fap_disclaimer_ack_v1';
  const DISCLAIMER_LINES = [
    '本平台所有内容由 AI 基于公开数据自动生成，仅供学习、研究与参考，不构成任何投资建议、基金推荐、要约或承诺。',
    '平台不销售基金、不提供购买渠道，不对任何基金作推荐或评级。',
    '基金过往业绩不预示其未来表现，基金管理人管理的其他基金业绩不构成对本基金业绩的保证。',
    '数据可能存在延迟或错误，持仓数据来自定期报告存在滞后，请以基金管理人公告与法律文件为准。',
    '投资有风险，决策请独立判断，风险自负。',
  ];
  const DISCLAIMER_TEXT = DISCLAIMER_LINES.join('');

  function ensureDisclaimer() {
    if (localStorage.getItem(DISCLAIMER_KEY)) return;
    const modal = el('div', { class: 'modal open', attrs: { role: 'dialog', 'aria-modal': 'true' } });
    const panel = el('div', { class: 'modal__panel' }, [
      el('h2', { class: 'modal__title', text: '使用前请阅读' }),
    ].concat(
      DISCLAIMER_LINES.map(function (t) { return el('p', { class: 'modal__text', text: t }); })
    ).concat([
      el('div', { class: 'modal__actions' }, [
        el('button', {
          class: 'btn-primary',
          text: '我已阅读并理解',
          on: { click: function () { localStorage.setItem(DISCLAIMER_KEY, String(Date.now())); modal.remove(); } },
        }),
      ]),
    ]));
    modal.appendChild(panel);
    document.body.appendChild(modal);
  }

  /* ---------------------- 最近搜索（F1-8） ---------------------- */
  const RECENT_KEY = 'fap_recent_v1';
  function recentGet() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
  }
  function recentAdd(item) {
    const list = recentGet().filter(function (x) { return x.code !== item.code; });
    list.unshift({ code: item.code, name: item.name, typeText: item.typeText || '' });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  }
  function recentClear() { localStorage.removeItem(RECENT_KEY); }

  /* ---------------------- 术语解释（F4-9） ---------------------- */
  const GLOSSARY = {
    最大回撤: '历史上从最高点跌到最低点的幅度，衡量「最难受的时候有多难受」。',
    回撤修复: '从回撤最低点重新回到原来最高点所需的时间。',
    年化波动率: '净值日常上下起伏的剧烈程度，数值越大颠簸越明显。',
    夏普比率: '每承担一单位波动获得的超额回报，越高越好；为负说明承担波动却没跑赢无风险收益。',
    卡玛比率: '年化收益除以最大回撤，衡量「用多深的回撤换来多少收益」。',
    索提诺比率: '与夏普类似，但只考虑下跌方向的波动。',
    跟踪误差: '指数基金的净值走势与标的指数的偏离程度，越小说明跟得越紧。',
    折溢价: '场内交易价格相对基金净值的偏离；溢价过高时价格回归会造成损失而净值不变。',
    信息比率: '相对基准的超额收益除以超额收益的波动，衡量超额收益的稳定性。',
    一拖多: '同一位基金经理同时管理多只基金，数量过多可能影响精力分配。',
    复权净值: '把分红再投资考虑进去的净值口径，用于正确计算区间收益，避免分红造成的「假下跌」。',
    滚动持有正收益概率: '历史上任一交易日买入并持有指定时长后，取得正收益的比例（历史回溯，不预示未来）。',
    同类排名: '在同一二级分类的基金中按区间收益的排名，需同时看样本数量与截止日期。',
    估值分位: '当前估值在自身历史区间中的位置，80% 分位表示历史上仅 20% 的时间比现在更贵。',
    机构持有比例: '基金份额中由机构投资者持有的比例，过高时大额赎回可能冲击净值。',
    风格漂移: '基金实际持仓与其历史风格或合同约定范围出现明显偏离。',
    体验分: '衡量持有过程的难受程度（回撤、波动、修复时间、正收益概率），分数高不代表收益高。',
  };

  function helpBtn(term) {
    if (!GLOSSARY[term]) return null;
    return el('button', {
      class: 'help',
      text: '?',
      attrs: { type: 'button', 'aria-label': term + ' 是什么' },
      on: {
        click: function (e) {
          e.stopPropagation();
          showModal(term, [GLOSSARY[term]]);
        },
      },
    });
  }

  function showModal(title, lines, extraNodes) {
    const modal = el('div', { class: 'modal open', attrs: { role: 'dialog', 'aria-modal': 'true' } });
    const panel = el('div', { class: 'modal__panel' }, [el('h2', { class: 'modal__title', text: title })]
      .concat((lines || []).map(function (t) { return el('p', { class: 'modal__text', text: t }); }))
      .concat(extraNodes || [])
      .concat([
        el('div', { class: 'modal__actions' }, [
          el('button', { class: 'btn-ghost', text: '关闭', on: { click: function () { modal.remove(); } } }),
        ]),
      ]));
    modal.appendChild(panel);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    return modal;
  }

  /** 长文本折叠（移动端默认 3 行） */
  function clampable(text, cls) {
    const p = el('p', { class: (cls || 'sec__summary') + ' clamp', text: text });
    const btn = el('button', { class: 'clamp-toggle', text: '展开全部' });
    btn.addEventListener('click', function () {
      const on = p.classList.toggle('clamp');
      btn.textContent = on ? '展开全部' : '收起';
    });
    const box = el('div', null, [p, btn]);
    requestAnimationFrame(function () {
      if (p.scrollHeight <= p.clientHeight + 2) btn.style.display = 'none';
    });
    return box;
  }

  /** 按分数取颜色 */
  function scoreColor(v) {
    if (!isNum(v)) return 'var(--c-text-3)';
    if (v >= 75) return 'var(--c-risk-green)';
    if (v >= 55) return 'var(--c-brand)';
    if (v >= 40) return 'var(--c-warn)';
    return 'var(--c-risk-red)';
  }

  const RISK_TEXT = { red: '风险红灯', yellow: '风险黄灯', green: '风险绿灯' };

  global.U = {
    el: el, $: $, $$: $$, clear: clear,
    isNum: isNum, num: num, pct: pct, pctAbs: pctAbs, yi: yi, money: money, dirClass: dirClass,
    fmtTime: fmtTime, timeAgo: timeAgo,
    api: api, deviceId: deviceId, toast: toast,
    initTheme: initTheme,
    ensureDisclaimer: ensureDisclaimer, DISCLAIMER_TEXT: DISCLAIMER_TEXT, DISCLAIMER_LINES: DISCLAIMER_LINES,
    recentGet: recentGet, recentAdd: recentAdd, recentClear: recentClear,
    GLOSSARY: GLOSSARY, helpBtn: helpBtn, showModal: showModal, clampable: clampable,
    scoreColor: scoreColor, RISK_TEXT: RISK_TEXT,
  };
})(window);
