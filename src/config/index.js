'use strict';
/**
 * 全局配置
 * 安全要求 S-2：所有密钥仅从环境变量读取，不得出现在代码库、前端产物与日志中
 */
const path = require('path');

function int(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dft;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

/** 出网主机白名单（S-1 防 SSRF）：只允许基金公开数据接口所在域名 */
const DEFAULT_ALLOW_HOSTS = [
  'fund.eastmoney.com', // pingzhongdata：净值/规模/经理/持有人/费率/阶段业绩
  'fundf10.eastmoney.com', // 档案：持仓、行业配置、经理变动、费率
  'api.fund.eastmoney.com', // 历史净值、公告
  'fundsuggest.eastmoney.com', // 搜索联想
  'fundmobapi.eastmoney.com', // 移动端接口（部分数据更全）
  'push2.eastmoney.com', // 场内行情（ETF/LOF 折溢价）、指数
  'push2his.eastmoney.com', // 场内 K 线
  'np-cnotice-fund.eastmoney.com', // 基金公告
];

module.exports = {
  port: int(process.env.PORT, 3250),
  env: process.env.NODE_ENV || 'development',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'analysis.db'),

  ai: {
    apiUrl: process.env.HUNYUAN_API_URL || '',
    apiKey: process.env.HUNYUAN_API_KEY || '',
    model: process.env.HUNYUAN_MODEL || 'hy3',
    timeoutMs: int(process.env.HUNYUAN_TIMEOUT_MS, 45000),
    maxRetry: int(process.env.AI_MAX_RETRY, 1),
    // 六板块并行的实际并发上限（PRD F3-3：网关并发不足时下调）
    concurrency: Math.max(1, int(process.env.AI_CONCURRENCY, 3)),
    mergeStrategy: process.env.AI_MERGE_STRATEGY === 'merge' ? 'merge' : 'none',
    dailyCallBudget: int(process.env.DAILY_MODEL_CALL_BUDGET, 2000),
    get enabled() {
      return Boolean(this.apiUrl && this.apiKey);
    },
  },

  rateLimit: {
    perMinute: int(process.env.RATE_LIMIT_PER_MINUTE, 5),
    perDay: int(process.env.RATE_LIMIT_PER_DAY, 30),
  },

  http: {
    allowHosts: (process.env.HTTP_ALLOW_HOSTS || DEFAULT_ALLOW_HOSTS.join(','))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeoutMs: int(process.env.HTTP_TIMEOUT_MS, 9000),
  },

  analyze: {
    sectionTimeoutMs: int(process.env.HUNYUAN_TIMEOUT_MS, 45000),
    // 同一基金同一净值日的报告复用窗口
    reportReuseMs: int(process.env.REPORT_REUSE_MS, 10 * 60 * 1000),
  },
};
