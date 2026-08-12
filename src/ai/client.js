'use strict';
/**
 * 大模型客户端（腾讯混元 hy3，OpenAI 兼容的 Chat Completions 协议）
 *
 * 等价的裸调用：
 *   POST https://tokenhub.tencentmaas.com/v1/chat/completions
 *   Authorization: Bearer <HUNYUAN_API_KEY>
 *   { "model": "hy3", "messages": [...], "stream": false }
 *
 * 安全：密钥仅从环境变量读取，绝不进入代码库、前端产物与日志（S-2）
 */
const config = require('../config');
const { postJson } = require('../utils/http');
const logger = require('../utils/logger');
const db = require('../db');

let dailyCalls = 0;
let dailyCallDate = new Date().toISOString().slice(0, 10);

function resetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCallDate) {
    dailyCallDate = today;
    dailyCalls = 0;
  }
}

/** 日预算熔断（风险应对：六板块 = 单次分析多次调用，成本需可控） */
function budgetExceeded() {
  resetIfNewDay();
  let persisted = 0;
  try {
    persisted = db.todayStats?.().modelCalls || 0;
  } catch {
    persisted = 0;
  }
  return Math.max(dailyCalls, persisted) >= config.ai.dailyCallBudget;
}

/**
 * 简易并发闸门：网关并发有限时避免五板块同时打满（对应 PRD F3-3）
 */
let running = 0;
const waiters = [];
async function acquire() {
  if (running < config.ai.concurrency) {
    running += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  running += 1;
}
function release() {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) next();
}

/**
 * 调用模型并要求返回 JSON
 * @returns {{content:string, usage:{promptTokens:number|null, outputTokens:number|null, ms:number}}}
 */
async function chatJson({ system, user, temperature = 0.3, maxTokens = 2800 }) {
  if (!config.ai.enabled) throw new Error('模型未配置（缺少 HUNYUAN_API_URL 或 HUNYUAN_API_KEY）');
  if (budgetExceeded()) throw new Error('已达当日模型调用预算上限，本次降级为规则版分析');

  const body = {
    model: config.ai.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    temperature,
    max_tokens: maxTokens,
  };

  await acquire();
  const started = Date.now();
  try {
    const res = await postJson(config.ai.apiUrl, body, {
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
      timeoutMs: config.ai.timeoutMs,
    });
    dailyCalls += 1;
    const content = res?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型返回内容为空');
    return {
      content,
      usage: {
        promptTokens: res?.usage?.prompt_tokens ?? null,
        outputTokens: res?.usage?.completion_tokens ?? null,
        ms: Date.now() - started,
      },
    };
  } finally {
    release();
  }
}

async function probe() {
  if (!config.ai.enabled) return { ok: false, error: '未配置模型密钥' };
  try {
    const r = await chatJson({
      system: '你是一个只输出 JSON 的健康检查器，不要输出任何解释。',
      user: '请只返回 {"ok":true}',
      maxTokens: 32,
    });
    return { ok: true, error: null, sample: String(r.content).slice(0, 40) };
  } catch (e) {
    logger.warn('模型探测失败', { error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = { chatJson, probe, budgetExceeded, model: config.ai.model };
