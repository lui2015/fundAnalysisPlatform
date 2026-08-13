'use strict';
/**
 * API 路由
 * 安全要点：入参一律白名单校验（S-5）；报告 ID 不可枚举（S-6）；DB 查询参数绑定（S-3）
 */
const express = require('express');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../db');
const cache = require('../utils/cache');
const datasource = require('../datasource');
const { sanitizeQuery, normalizeCode } = require('../datasource/codes');
const rateLimit = require('../middleware/rateLimit');
const taskManager = require('../services/taskManager');
const orchestrator = require('../ai/orchestrator');
const client = require('../ai/client');
const compute = require('../compute');
const { RULES, CATEGORY_LABELS } = require('../risk/engine');
const { BASE, BY_TYPE, thresholdsFor } = require('../config/riskRules');
const { SCORE_WEIGHTS, TYPE, TYPE_LABEL, POLICY, naReason } = require('../config/fundTypes');
const { DENY_KEYWORDS } = require('../ai/compliance');

const router = express.Router();

const REPORT_ID_RE = /^r_[a-f0-9]{16,48}$/;

/* ============================== 搜索 ============================== */
router.get('/search', async (req, res) => {
  const q = sanitizeQuery(req.query.q);
  if (!q) return res.json({ ok: true, data: [] });
  const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 8));
  try {
    const r = await datasource.search(q, limit);
    res.json({ ok: true, data: r.data || [], source: r.source, degraded: Boolean(r.degraded) });
  } catch (e) {
    logger.warn('搜索失败', { error: e.message });
    res.json({ ok: true, data: [], error: '搜索服务暂不可用' });
  }
});

/* ============================== 热门 ============================== */
router.get('/hot', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  try {
    const r = await datasource.hot({ limit, type: req.query.type, sort: req.query.sort });
    res.json({ ok: true, data: r.data || [], source: r.source, note: '按平台分析次数排序，不按收益率排序' });
  } catch (e) {
    res.json({ ok: true, data: [], error: '热门列表暂不可用' });
  }
});

/* ============================== 快照 ============================== */
router.get('/fund/:code', async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ ok: false, error: '基金代码格式不正确（应为 6 位数字）' });
  try {
    const data = await datasource.quickQuote(code);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || '基金数据暂不可用' });
  }
});

/* ========================= 分析任务 ========================= */
router.post('/analyze', async (req, res) => {
  const code = normalizeCode(req.body?.code);
  const depth = req.body?.depth === 'deep' ? 'deep' : 'quick';
  if (!code) return res.status(400).json({ ok: false, error: '基金代码格式不正确（应为 6 位数字）' });

  // 缓存复用：同一基金同一净值日的报告直接返回，不消耗配额（F6-3）
  try {
    const latest = db.getLatestByCode?.(code);
    if (
      latest &&
      latest.depth === depth &&
      Date.now() - new Date(latest.createdAt).getTime() < config.analyze.reportReuseMs
    ) {
      return res.json({ ok: true, cached: true, reportId: latest.id, quotaConsumed: false });
    }
  } catch (e) {
    logger.warn('报告复用检查失败', { error: e.message });
  }

  const gate = rateLimit.check(req);
  if (!gate.allowed) {
    return res.status(429).json({ ok: false, error: gate.reason, retryAfterSec: gate.retryAfterSec });
  }
  const remaining = rateLimit.consume(req);

  const task = taskManager.create({ code, depth });
  res.json({ ok: true, taskId: task.id, quotaConsumed: true, remaining });

  orchestrator
    .analyze(code, { depth, onEvent: (type, data) => taskManager.push(task, type, data) })
    .then((report) => taskManager.finish(task, { reportId: report.id }))
    .catch((err) => {
      logger.error('分析任务失败', { code, error: err.message });
      try {
        db.logAnalysis({ code, depth, ok: false, err: err.message });
      } catch {
        /* 日志失败不影响主流程 */
      }
      taskManager.finish(task, { error: err });
    });
});

/**
 * SSE 流式推送（F3-8）
 * 注意：业务失败事件名为 failed 而非 error —— EventSource 的连接关闭本身会派发内建 error 事件，
 * 二者同名会让前端把已完成的报告误判为失败。
 */
router.get('/analyze/:taskId/stream', (req, res) => {
  const task = taskManager.get(req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在或已过期' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let ended = false;
  const TERMINAL = new Set(['done', 'failed', 'closed']);
  const send = (evt) => {
    if (ended) return;
    res.write(`id: ${evt.seq}\n`);
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.data ?? {})}\n\n`);
    if (TERMINAL.has(evt.type)) {
      ended = true;
      setTimeout(() => {
        try {
          res.end();
        } catch {
          /* 客户端可能已断开 */
        }
      }, 300);
    }
  };

  const unsubscribe = taskManager.subscribe(task, send);
  const heartbeat = setInterval(() => {
    if (ended) return clearInterval(heartbeat);
    res.write(': ping\n\n');
  }, 15000);
  res.on('error', (err) => {
    ended = true;
    clearInterval(heartbeat);
    unsubscribe();
    logger.warn('SSE 连接异常', { error: err.message });
  });
  req.on('close', () => {
    ended = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** 轮询任务状态（弱网 / 微信后台挂起兜底） */
router.get('/analyze/:taskId', (req, res) => {
  const task = taskManager.get(req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在或已过期' });
  res.json({ ok: true, status: task.status, reportId: task.reportId, error: task.error, events: task.events });
});

/* =========================== 报告 =========================== */
router.get('/report/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!REPORT_ID_RE.test(id)) return res.status(400).json({ ok: false, error: '报告 ID 格式不正确' });
  const report = db.getReport(id);
  if (!report) return res.status(404).json({ ok: false, error: '报告不存在或已过期' });
  res.json({ ok: true, data: report });
});

router.get('/reports', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  res.json({ ok: true, data: db.listReports(limit) });
});

/* =========================== 同类对比 =========================== */
router.get('/compare', (req, res) => {
  const codes = String(req.query.codes || '')
    .split(',')
    .map((c) => normalizeCode(c))
    .filter(Boolean)
    .slice(0, 4);
  if (!codes.length) return res.status(400).json({ ok: false, error: '请提供 1–4 个基金代码' });
  const rows = codes.map((code) => {
    const r = db.getLatestByCode(code);
    if (!r) return { code, available: false, reason: '尚无分析报告，请先分析该基金' };
    return {
      code,
      available: true,
      reportId: r.id,
      name: r.name,
      fundTypeLabel: r.fundTypeLabel,
      shareClass: r.shareClass,
      navDate: r.navDate,
      scores: r.scores,
      riskLevel: r.riskLevel,
      intervals: {
        '1y': r.details?.intervals?.['1y']?.pct ?? null,
        '3y': r.details?.intervals?.['3y']?.pct ?? null,
        '5y': r.details?.intervals?.['5y']?.pct ?? null,
      },
      rank1y: r.details?.intervals?.['1y']?.rankNote ?? null,
      maxDrawdownPct: r.details?.drawdown?.maxPct ?? null,
      sharpe: r.details?.riskAdjusted?.sharpe ?? null,
      annualFeePct: r.details?.fee?.annualRunningPct ?? null,
      scaleYi: r.scaleYi,
      managerName: r.details?.manager?.primaryManager ?? null,
      managerTenureYears: r.details?.manager?.tenure?.years ?? null,
      createdAt: r.createdAt,
    };
  });
  res.json({ ok: true, data: rows, note: '对比数据来自各基金最近一次生成的报告快照，口径与生成时一致' });
});

/* =========================== 自选 =========================== */
router.get('/watchlist', (req, res) => {
  try {
    if (req.query.code) {
      const code = normalizeCode(req.query.code);
      if (!code) return res.status(400).json({ ok: false, error: '基金代码格式不正确' });
      return res.json({ ok: true, watched: db.watchCheck(code) });
    }
    res.json({ ok: true, data: db.watchList() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/watchlist', (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ ok: false, error: '基金代码格式不正确' });
  const name = String(req.body?.name || '').slice(0, 60);
  db.watchAdd(code, name);
  res.json({ ok: true, added: true });
});

router.delete('/watchlist', (req, res) => {
  const code = normalizeCode(req.body?.code || req.query.code);
  if (!code) return res.status(400).json({ ok: false, error: '基金代码格式不正确' });
  db.watchRemove(code);
  res.json({ ok: true, removed: true });
});

/* ===================== 评分与规则口径说明 ===================== */
router.get('/rules', (req, res) => {
  res.json({
    ok: true,
    data: {
      statement:
        '本平台的评分是对公开数据的程序化描述，用于帮助理解基金特征，不构成投资建议、不是基金评级，也不预测收益。刻意不给单一综合总分：一个总分会把「业绩好但体验差」「业绩好但刚换经理」这类最需要被看见的矛盾抹平。',
      dimensions: [
        { key: 'ability', label: '能力分 A', question: '它到底赚不赚钱、超额从哪来' },
        { key: 'manager', label: '舵手分 M', question: '谁在管、任职多久、忙不忙（被动型与货币型不适用）' },
        { key: 'experience', label: '体验分 X', question: '拿着难不难受（分数高不代表收益高）' },
        { key: 'timingCost', label: '时机成本分 T', question: '持仓贵不贵、要付多少费用' },
        { key: 'risk', label: '风险灯 R', question: '有没有没看见的坑（红/黄/绿）' },
      ],
      scoreWeights: SCORE_WEIGHTS,
      fundTypes: Object.entries(TYPE_LABEL).map(([key, label]) => ({
        key,
        label,
        policy: POLICY[key],
        managerNotApplicable: POLICY[key]?.good_manager === 'na',
        managerNaReason: POLICY[key]?.good_manager === 'na' ? naReason(key, 'manager') : null,
      })),
      riskRules: RULES.map((r) => ({ key: r.key, category: r.category, categoryLabel: CATEGORY_LABELS[r.category], title: r.title })),
      riskRuleCount: RULES.length,
      thresholdsBase: BASE,
      thresholdsByType: BY_TYPE,
      hardRedLines: [
        '已发布可能触发基金合同终止/清算的公告',
        `资产净值低于清盘警戒线（默认 ${BASE.miniScaleYi} 亿元，按类型差异化）`,
        '当前暂停赎回',
        `现任基金经理任职不足 ${BASE.newManagerRedMonths} 个月且前任已离任`,
        `风格漂移达严重级（行业分布偏离度 ≥ ${BASE.styleDriftSeverePct}%）`,
        `单一持有人占比 > ${BASE.singleHolderRedPct}%`,
        `场内溢价率 ≥ ${BASE.premiumRedPct}%（QDII 为 ${BY_TYPE[TYPE.QDII].premiumRedPct}%）`,
        '重仓股出现 ST / 退市风险标记',
      ],
      complianceDenyList: DENY_KEYWORDS,
      riskRuleHitStats: (() => {
        try {
          return db.riskRuleStats();
        } catch {
          return [];
        }
      })(),
      notes: [
        '所有数字均由后端确定性代码计算，模型只做解读；模型输出中的数字会与计算层结果回校验，不一致即丢弃该条结论',
        '风险雷点由规则引擎按阈值扫描产出，模型不能自行新增雷点',
        '阈值可通过 data/risk-thresholds.json 覆盖，并支持按基金类型差异化',
      ],
    },
  });
});

/* =========================== 健康检查 =========================== */
router.get('/health', async (req, res) => {
  const deep = req.query.deep === '1';
  const ds = await datasource.healthProbe();
  const ai = deep
    ? await client.probe()
    : { ok: config.ai.enabled, error: config.ai.enabled ? null : '未配置模型密钥（将使用规则版分析）' };
  let stats = { total: 0, okCount: 0, modelCalls: 0, tokens: 0 };
  try {
    stats = db.todayStats();
  } catch {
    /* 忽略 */
  }
  res.json({
    ok: true,
    service: 'fund-analysis-platform',
    version: require('../../package.json').version,
    time: new Date().toISOString(),
    dataSource: ds,
    model: { configured: config.ai.enabled, name: config.ai.model, concurrency: config.ai.concurrency, ...ai },
    storage: { kind: db.kind },
    cache: cache.stats(),
    today: stats,
    quota: { perMinute: config.rateLimit.perMinute, perDay: config.rateLimit.perDay },
  });
});

module.exports = router;
