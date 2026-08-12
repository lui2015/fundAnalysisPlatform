'use strict';
/**
 * 模型输出校验（需求 F3-4 / F3-6）
 *  1) JSON 提取与结构规范化
 *  2) 数字回校验：模型文本里的数字必须能在计算层事实中找到，否则丢弃该条结论
 *
 * 幻觉防护是本产品的信任底线：经理履历与公告事实同样只允许引用给定字段，不允许模型补全。
 */
const logger = require('../utils/logger');

/** 从模型返回中提取 JSON（兼容 ```json 包裹与前后缀噪声） */
function extractJson(raw) {
  if (typeof raw !== 'string') throw new Error('模型返回不是字符串');
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* 继续尝试括号截取 */
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('模型返回中未找到合法 JSON');
}

/* ===================== 数字回校验 ===================== */

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/** 递归收集事实中出现的所有数值（含字符串内嵌数字），并补充常见派生形式 */
function collectNumbers(obj, out = new Set()) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    out.add(obj);
    out.add(Math.round(obj * 100) / 100);
    out.add(Math.round(obj * 10) / 10);
    out.add(Math.round(obj));
    out.add(Math.abs(obj)); // 回撤等常以正值表述
    out.add(Math.round(Math.abs(obj) * 100) / 100);
    out.add(Math.round(Math.abs(obj) * 10) / 10);
    // 亿元 ↔ 万元 换算
    out.add(Math.round(obj * 1e4) / 100);
    return out;
  }
  if (typeof obj === 'string') {
    const m = obj.match(NUMBER_RE);
    if (m) m.forEach((s) => collectNumbers(parseFloat(s), out));
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => collectNumbers(v, out));
    return out;
  }
  if (typeof obj === 'object') {
    Object.values(obj).forEach((v) => collectNumbers(v, out));
    return out;
  }
  return out;
}

/** 可豁免核验的数字：年份、极小整数、常见基准与分位刻度 */
function isExempt(n) {
  if (!Number.isFinite(n)) return true;
  if (Number.isInteger(n) && n >= 1990 && n <= 2100) return true; // 年份
  if (Number.isInteger(n) && Math.abs(n) <= 12) return true; // 期数、名次、条目数、月份
  if ([10, 20, 25, 30, 50, 60, 70, 75, 80, 90, 95, 100, 252, 365, 1000, 10000, 100000].includes(Math.abs(n))) return true;
  return false;
}

function matches(n, allowed) {
  for (const a of allowed) {
    if (a === n) return true;
    const tol = Math.max(Math.abs(a) * 0.01, 0.02); // 1% 或 0.02 的容差
    if (Math.abs(a - n) <= tol) return true;
  }
  return false;
}

function verifyNumbersInText(text, allowed) {
  if (typeof text !== 'string' || !text) return { ok: true, bad: [] };
  const found = text.match(NUMBER_RE) || [];
  const bad = [];
  for (const s of found) {
    const n = parseFloat(s);
    if (isExempt(n)) continue;
    if (!matches(n, allowed)) bad.push(n);
  }
  return { ok: bad.length === 0, bad };
}

/**
 * 对板块输出做数字回校验：逐条结论检查，不通过即丢弃（F3-6）
 * @returns {{section:object, dropped:Array}}
 */
function verifySection(section, facts, label) {
  const allowed = collectNumbers(facts);
  const dropped = [];

  const checkList = (list, path) => {
    if (!Array.isArray(list)) return list;
    return list.filter((item, i) => {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      const r = verifyNumbersInText(text, allowed);
      if (!r.ok) {
        dropped.push({ path: `${path}[${i}]`, text: String(text).slice(0, 200), bad: r.bad });
        return false;
      }
      return true;
    });
  };

  const out = { ...section };

  // summary 若含无法核验的数字，剥离数字而不整条丢弃（避免板块空白）
  if (typeof out.summary === 'string') {
    const r = verifyNumbersInText(out.summary, allowed);
    if (!r.ok) {
      dropped.push({ path: 'summary', text: out.summary.slice(0, 200), bad: r.bad });
      out.summary = out.summary.replace(NUMBER_RE, (s) => {
        const n = parseFloat(s);
        return isExempt(n) || matches(n, allowed) ? s : '—';
      });
    }
  }

  if (Array.isArray(out.modules)) {
    out.modules = out.modules.map((m) => ({
      ...m,
      points: checkList(m.points, `modules.${m.key || m.title}.points`),
    }));
  }
  out.strengths = checkList(out.strengths, 'strengths');
  out.weaknesses = checkList(out.weaknesses, 'weaknesses');
  out.points = checkList(out.points, 'points');
  if (Array.isArray(out.findings)) {
    out.findings = out.findings.filter((f, i) => {
      const r = verifyNumbersInText(`${f.explain || ''}`, allowed);
      if (!r.ok) {
        dropped.push({ path: `findings[${i}].explain`, text: String(f.explain).slice(0, 200), bad: r.bad });
        f.explain = null; // 解释被丢弃，但规则命中的雷点本身保留
      }
      return true;
    });
  }
  if (Array.isArray(out.keyPoints)) {
    out.keyPoints = out.keyPoints.filter((kp, i) => {
      const r = verifyNumbersInText(typeof kp === 'string' ? kp : kp?.text || '', allowed);
      if (!r.ok) {
        dropped.push({ path: `keyPoints[${i}]`, text: JSON.stringify(kp).slice(0, 200), bad: r.bad });
        return false;
      }
      return true;
    });
  }
  if (typeof out.oneLiner === 'string') {
    const r = verifyNumbersInText(out.oneLiner, allowed);
    if (!r.ok) {
      dropped.push({ path: 'oneLiner', text: out.oneLiner.slice(0, 200), bad: r.bad });
      out.oneLiner = out.oneLiner.replace(NUMBER_RE, (s) => {
        const n = parseFloat(s);
        return isExempt(n) || matches(n, allowed) ? s : '—';
      });
    }
  }
  if (typeof out.conflictNote === 'string') {
    const r = verifyNumbersInText(out.conflictNote, allowed);
    if (!r.ok) {
      dropped.push({ path: 'conflictNote', text: out.conflictNote.slice(0, 160), bad: r.bad });
      out.conflictNote = null;
    }
  }

  if (dropped.length) {
    logger.warn('数字回校验丢弃了模型结论', { label, dropped: dropped.slice(0, 5), total: dropped.length });
  }
  return { section: out, dropped };
}

/* ===================== 结构规范化 ===================== */

function asString(v, fallback = '') {
  return typeof v === 'string' ? v.trim() : fallback;
}

function asStringArray(v, max = 8) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : typeof x?.text === 'string' ? x.text.trim() : ''))
    .filter(Boolean)
    .slice(0, max);
}

/** ②③④⑤ 四个分析型板块的统一结构 */
function normalizeAnalysisSection(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('板块结果不是对象');
  const summary = asString(raw.summary);
  if (!summary) throw new Error('缺少 summary');
  const modules = Array.isArray(raw.modules)
    ? raw.modules
        .map((m) => ({
          key: asString(m.key) || null,
          title: asString(m.title),
          summary: asString(m.summary),
          points: asStringArray(m.points, 5),
        }))
        .filter((m) => m.title && (m.summary || m.points.length))
    : [];
  if (!modules.length) throw new Error('缺少 modules');
  return {
    summary: summary.slice(0, 400),
    tag: asString(raw.tag) || null,
    modules,
    strengths: asStringArray(raw.strengths, 4),
    weaknesses: asStringArray(raw.weaknesses, 4),
  };
}

/** ⑥ 风险排雷板块：模型只能解释已命中的雷点，不能新增 */
function normalizeRiskSection(raw, allowedKeys) {
  if (!raw || typeof raw !== 'object') throw new Error('板块结果不是对象');
  const summary = asString(raw.summary);
  if (!summary) throw new Error('缺少 summary');
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .map((f) => ({
          key: asString(f.key) || null,
          explain: asString(f.explain) || null,
        }))
        .filter((f) => f.key && (!allowedKeys || allowedKeys.includes(f.key)))
    : [];
  return { summary: summary.slice(0, 400), tag: asString(raw.tag) || null, findings };
}

/** ① 总览 */
const ANCHORS = ['good_performance', 'good_manager', 'good_experience', 'timing_cost', 'risk_scan'];
function normalizeOverviewSection(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('总览结果不是对象');
  const oneLiner = asString(raw.oneLiner);
  if (!oneLiner) throw new Error('缺少 oneLiner');
  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints
        .map((k) => ({
          text: asString(k.text),
          tone: ['positive', 'negative', 'neutral'].includes(k.tone) ? k.tone : 'neutral',
          anchor: ANCHORS.includes(k.anchor) ? k.anchor : null,
        }))
        .filter((k) => k.text)
        .slice(0, 6)
    : [];
  return {
    oneLiner: oneLiner.slice(0, 120),
    keyPoints,
    conflictNote: asString(raw.conflictNote) || null,
  };
}

module.exports = {
  extractJson,
  collectNumbers,
  verifyNumbersInText,
  verifySection,
  normalizeAnalysisSection,
  normalizeRiskSection,
  normalizeOverviewSection,
  ANCHORS,
};
