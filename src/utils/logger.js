'use strict';
/** 极简结构化日志：禁止打印密钥（S-2） */

const SENSITIVE = /(api[_-]?key|authorization|secret|token|password|bearer)/i;

function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) out[k] = '***';
    else if (typeof v === 'string' && /sk-[A-Za-z0-9]{8,}/.test(v)) out[k] = v.replace(/sk-[A-Za-z0-9]+/g, 'sk-***');
    else if (v && typeof v === 'object') out[k] = sanitize(v);
    else out[k] = v;
  }
  return out;
}

function line(level, msg, meta) {
  const rec = { t: new Date().toISOString(), level, msg };
  if (meta !== undefined) rec.meta = sanitize(meta);
  const text = JSON.stringify(rec);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

module.exports = {
  info: (msg, meta) => line('info', msg, meta),
  warn: (msg, meta) => line('warn', msg, meta),
  error: (msg, meta) => line('error', msg, meta),
};
