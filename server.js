'use strict';
/**
 * 服务入口
 * 全站 HTTPS 由前置 nginx 终止；本进程只监听内网端口
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const apiRouter = require('./src/routes/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '32kb' }));

/** 安全响应头（含 CSP，防 XSS） */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // ECharts 由 CDN 按需加载；如需完全自托管可改为 'self'
      "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  next();
});

/** 请求日志（只记录路径与耗时，不记录敏感头） */
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t });
    }
  });
  next();
});

app.use('/api', apiRouter);

/** 静态资源（express.static 实时读盘，覆盖静态文件即时生效） */
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '5m',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/**
 * 报告分享短链：/report/:id → report.html?id=xxx
 * 用相对重定向，保证子路径部署（/fundAnalysis/）时页面内相对资源解析正确
 */
app.get('/report/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^r_[a-f0-9]{16,48}$/.test(id)) return res.redirect(302, '../');
  res.setHeader('Cache-Control', 'no-cache');
  res.redirect(302, `../report.html?id=${encodeURIComponent(id)}`);
});

app.get('/rules', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: '接口不存在' });
  return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  logger.error('未捕获异常', { path: req.path, error: err.message });
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: '服务内部错误' });
});

const server = app.listen(config.port, () => {
  logger.info('服务已启动', {
    port: config.port,
    env: config.env,
    dataMode: require('./src/datasource').MODE,
    modelConfigured: config.ai.enabled,
    dataDir: config.dataDir,
  });
});

process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM，准备退出');
  server.close(() => process.exit(0));
});

/** 进程级兜底：单个请求的异常不应导致整个服务退出（致命错误由 PM2 重启） */
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常（服务继续运行）', {
    error: err.message,
    stack: String(err.stack).split('\n').slice(0, 3).join(' | '),
  });
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { error: String(reason && reason.message ? reason.message : reason) });
});

module.exports = app;
