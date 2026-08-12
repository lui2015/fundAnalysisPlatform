'use strict';
/**
 * 安全出网 HTTP 客户端（对应需求 S-1：防 SSRF）
 *
 * 四重防护：
 *  1) 协议白名单：仅 http/https
 *  2) 主机白名单：只允许配置中显式列出的数据源域名
 *  3) DNS 解析后校验 IP：拒绝回环、私有、链路本地及内网段（含 9/10/11/21/30 段）
 *  4) 不自动跟随重定向：避免被 302 到内网地址
 */
const dns = require('dns').promises;
const net = require('net');
const config = require('../config');

function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true; // 本机/回环
  if (a === 10) return true; // 私有
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a >= 224) return true; // 组播 / 保留
  if ([9, 11, 21, 30].includes(a)) return true; // 安全规范额外要求的内网段
  return false;
}

function isBlockedIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isBlockedIPv4(m[1]);
  return false;
}

function isBlockedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedIPv4(ip);
  if (type === 6) return isBlockedIPv6(ip);
  return true;
}

async function assertNotInternal(host) {
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`目标 IP 被禁止: ${host}`);
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error(`域名无法解析: ${host}`);
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error(`域名解析到受限地址: ${host} -> ${r.address}`);
  }
}

async function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('非法 URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`协议不允许: ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (!config.http.allowHosts.includes(host)) throw new Error(`主机不在白名单: ${host}`);
  await assertNotInternal(host);
  return u;
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  // 天天基金多数接口要求带 Referer，否则返回空或 403
  Referer: 'https://fundf10.eastmoney.com/',
};

async function fetchRaw(url, { headers = {}, timeoutMs } = {}) {
  await assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || config.http.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual', // 不跟随重定向，避免绕过白名单
      signal: ctrl.signal,
      headers: { ...DEFAULT_HEADERS, ...headers },
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`拒绝跟随重定向 (${res.status})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** 安全 GET，返回 UTF-8 文本 */
async function safeGetText(url, opts = {}) {
  const res = await fetchRaw(url, opts);
  return res.text();
}

/** 安全 GET，按指定编码解码（部分东财档案页为 GBK） */
async function safeGetTextEncoded(url, encoding = 'utf-8', opts = {}) {
  const res = await fetchRaw(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 安全 GET，解析 JSON（兼容 jsonp 包裹） */
async function safeGetJson(url, opts = {}) {
  const text = await safeGetText(url, opts);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const m = trimmed.match(/^[^(]*\(([\s\S]*)\)\s*;?$/);
  if (m) return JSON.parse(m[1]);
  throw new Error('响应不是合法 JSON');
}

/**
 * 安全 POST JSON（大模型网关）
 * 网关域名来自环境变量而非固定白名单，但同样校验协议与内网地址
 */
async function postJson(url, body, { headers = {}, timeoutMs } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('非法 URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('协议不允许');
  await assertNotInternal(u.hostname.toLowerCase());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  safeGetText,
  safeGetTextEncoded,
  safeGetJson,
  postJson,
  assertSafeUrl,
  isBlockedIp,
};
