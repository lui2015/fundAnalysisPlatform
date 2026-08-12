'use strict';
/**
 * 限流与配额（需求 F6-2 / F6-3 / S-7）
 * 维度：IP + 设备标识（前端生成并存于 localStorage 的匿名 ID）
 * 命中报告缓存的请求不消耗配额（由路由在复用报告时跳过 consume）
 */
const config = require('../config');

const buckets = new Map();

function keyOf(req) {
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const device = String(req.headers['x-device-id'] || '').slice(0, 64) || 'nodevice';
  return `${ip}|${device}`;
}

function state(key) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = new Date(now).toISOString().slice(0, 10);
  let b = buckets.get(key);
  if (!b) b = { minute, minuteCount: 0, day, dayCount: 0 };
  if (b.minute !== minute) {
    b.minute = minute;
    b.minuteCount = 0;
  }
  if (b.day !== day) {
    b.day = day;
    b.dayCount = 0;
  }
  buckets.set(key, b);
  return b;
}

/** 仅检查，不计数 */
function check(req) {
  const b = state(keyOf(req));
  if (b.minuteCount >= config.rateLimit.perMinute) {
    return {
      allowed: false,
      reason: `操作过于频繁，每分钟最多 ${config.rateLimit.perMinute} 次分析`,
      retryAfterSec: 60 - Math.floor((Date.now() % 60000) / 1000),
    };
  }
  if (b.dayCount >= config.rateLimit.perDay) {
    return {
      allowed: false,
      reason: `今日分析次数已达上限（${config.rateLimit.perDay} 次），请明天再来`,
      retryAfterSec: null,
    };
  }
  return {
    allowed: true,
    remaining: {
      minute: config.rateLimit.perMinute - b.minuteCount,
      day: config.rateLimit.perDay - b.dayCount,
    },
  };
}

/** 计数（仅在真正触发一次新分析时调用） */
function consume(req) {
  const b = state(keyOf(req));
  b.minuteCount += 1;
  b.dayCount += 1;
  return {
    minute: Math.max(0, config.rateLimit.perMinute - b.minuteCount),
    day: Math.max(0, config.rateLimit.perDay - b.dayCount),
  };
}

setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  for (const [k, v] of buckets.entries()) if (v.day !== day) buckets.delete(k);
}, 10 * 60 * 1000).unref();

module.exports = { check, consume, keyOf };
