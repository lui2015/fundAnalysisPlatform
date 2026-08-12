'use strict';
/**
 * 基金代码与输入校验（S-5：白名单校验，绝不拼进任何 shell 命令）
 */

/** 输入清洗：只保留中文、字母、数字与少量分隔符 */
function sanitizeQuery(q) {
  const s = String(q ?? '').trim();
  if (!s) return '';
  const cleaned = s.replace(/[^\u4e00-\u9fa5A-Za-z0-9()（）·\-\s]/g, '').trim();
  return cleaned.slice(0, 32);
}

/**
 * 归一化基金代码
 * 支持：161725 / sh510300 / SZ159915 / 510300.OF / of161725
 * @returns {string|null} 6 位数字代码
 */
function normalizeCode(input) {
  const raw = String(input ?? '').trim().toUpperCase();
  if (!raw) return null;
  const m = raw.match(/(\d{6})/);
  if (!m) return null;
  // 校验前缀合法性：只允许空、SH/SZ/BJ/OF 前缀
  const prefix = raw.slice(0, raw.indexOf(m[1])).replace(/[^A-Z]/g, '');
  if (prefix && !['SH', 'SZ', 'BJ', 'OF'].includes(prefix)) return null;
  return m[1];
}

/** 是否可能为场内基金代码（ETF/LOF），用于决定是否取折溢价 */
function looksOnMarket(code) {
  const c = String(code || '');
  if (!/^\d{6}$/.test(c)) return false;
  // 沪市 ETF 51/56/58 开头，深市 ETF 15 开头，LOF 16/50 开头
  return /^(51|56|58|15|16|50)/.test(c);
}

/** 从名称中识别份额类型 */
function shareClassOf(name) {
  const n = String(name || '');
  if (/ETF联接|ETF链接/.test(n)) {
    const m = n.match(/(?:联接|链接)\s*([ACEIR])/);
    return m ? m[1] : '联接';
  }
  if (/ETF/.test(n)) return 'ETF';
  if (/LOF/.test(n)) return 'LOF';
  const m = n.match(/([ACEIR])$/);
  if (m) return m[1];
  if (/后端/.test(n)) return '后端';
  return '—';
}

/** 同系列分组键：去掉份额后缀，用于把 A/C 类归到一组展示（F1-3） */
function seriesKeyOf(name) {
  return String(name || '')
    .replace(/[ACEIR]$/, '')
    .replace(/[（(](前端|后端|美元|人民币|现汇|现钞)[)）]/g, '')
    .trim();
}

module.exports = { sanitizeQuery, normalizeCode, looksOnMarket, shareClassOf, seriesKeyOf };
