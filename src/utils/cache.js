'use strict';
/**
 * 内存 TTL 缓存（对应需求 F2-20 缓存策略）
 * 一期数据量小，进程内缓存即可；重启后自动回源。缓存命中不消耗模型配额。
 */
const store = new Map();

function set(key, value, ttlMs) {
  store.set(key, { value, expireAt: Date.now() + ttlMs });
}

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expireAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

async function wrap(key, ttlMs, loader) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  if (value !== undefined && value !== null) set(key, value, ttlMs);
  return value;
}

function stats() {
  let alive = 0;
  const now = Date.now();
  for (const v of store.values()) if (v.expireAt > now) alive += 1;
  return { total: store.size, alive };
}

function clear() {
  store.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) if (v.expireAt <= now) store.delete(k);
}, 60 * 1000).unref();

/** 常用 TTL（毫秒），口径见 PRD F2-20 */
const TTL = {
  SEARCH: 10 * 60 * 1000,
  PROFILE: 24 * 60 * 60 * 1000, // 档案 24h
  NAV: 4 * 60 * 60 * 1000, // 净值当日缓存（收盘后更新）
  HOLDING: 24 * 60 * 60 * 1000, // 持仓按报告期，季度级
  MANAGER: 24 * 60 * 60 * 1000,
  SCALE: 12 * 60 * 60 * 1000,
  FEE: 7 * 24 * 60 * 60 * 1000, // 费率 7 天
  NOTICE: 30 * 60 * 1000, // 公告 ≤30min
  MARKET: 5 * 60 * 1000,
  ONMARKET: 60 * 1000, // 场内实时行情/折溢价
  HOT: 5 * 60 * 1000,
};

module.exports = { set, get, wrap, stats, clear, TTL };
