'use strict';
/**
 * 分析任务管理
 * - 任务在后台执行，前端通过 SSE 订阅；断线后可凭 taskId 重连并回放已产生的事件（M-7）
 * - 业务失败事件名为 failed 而非 error：EventSource 的连接关闭本身会派发内建 error 事件，
 *   同名会让前端把已完成的报告误判为失败
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

const TASKS = new Map();
const TASK_TTL_MS = 30 * 60 * 1000;

function newTaskId() {
  return `t_${crypto.randomBytes(9).toString('hex')}`;
}

function create({ code, depth }) {
  const id = newTaskId();
  TASKS.set(id, {
    id,
    code,
    depth,
    status: 'running',
    events: [],
    subscribers: new Set(),
    reportId: null,
    error: null,
    createdAt: Date.now(),
  });
  return TASKS.get(id);
}

function get(id) {
  return TASKS.get(id) || null;
}

function push(task, type, data) {
  if (!task) return;
  const evt = { seq: task.events.length + 1, type, data, t: Date.now() };
  task.events.push(evt);
  for (const send of task.subscribers) {
    try {
      send(evt);
    } catch (e) {
      logger.warn('SSE 推送失败', { error: e.message });
    }
  }
}

function finish(task, { reportId, error }) {
  if (!task) return;
  task.status = error ? 'failed' : 'done';
  task.reportId = reportId || null;
  task.error = error ? String(error.message || error) : null;
  if (error) push(task, 'failed', { message: task.error });
}

/**
 * 订阅：先回放历史事件，再接收后续事件。
 * 任务可能在订阅前已结束，回放到终止事件后必须停止，且不再补发 closed。
 */
function subscribe(task, send) {
  const TERMINAL = new Set(['done', 'failed']);
  let sawTerminal = false;
  for (const evt of task.events) {
    send(evt);
    if (TERMINAL.has(evt.type)) {
      sawTerminal = true;
      break;
    }
  }
  if (sawTerminal) return () => {};
  if (task.status !== 'running') {
    send({ seq: task.events.length + 1, type: 'closed', data: { status: task.status } });
    return () => {};
  }
  task.subscribers.add(send);
  return () => task.subscribers.delete(send);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of TASKS.entries()) if (now - t.createdAt > TASK_TTL_MS) TASKS.delete(id);
}, 60 * 1000).unref();

module.exports = { create, get, push, finish, subscribe };
