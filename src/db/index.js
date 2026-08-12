'use strict';
/**
 * 存储层
 * - 首选 SQLite（better-sqlite3），所有查询使用参数绑定（S-3，禁止拼接 SQL）
 * - 若 better-sqlite3 不可用（未编译安装），自动降级为 JSON 文件存储，保证服务可启动
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

fs.mkdirSync(config.dataDir, { recursive: true });

/* ------------------------- SQLite 实现 ------------------------- */
function createSqliteImpl() {
  const Database = require('better-sqlite3');
  const db = new Database(config.dbFile);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id           TEXT PRIMARY KEY,
      code         TEXT NOT NULL,
      name         TEXT NOT NULL,
      fund_type    TEXT,
      depth        TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      nav_date     TEXT,
      score_a      INTEGER,
      score_m      INTEGER,
      score_x      INTEGER,
      score_t      INTEGER,
      risk_level   TEXT,
      payload      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_code ON reports(code, created_at DESC);

    CREATE TABLE IF NOT EXISTS analysis_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      code          TEXT,
      depth         TEXT,
      ok            INTEGER,
      total_ms      INTEGER,
      fetch_ms      INTEGER,
      compute_ms    INTEGER,
      model_ms      INTEGER,
      model_calls   INTEGER,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      degraded      TEXT,
      err           TEXT
    );

    CREATE TABLE IF NOT EXISTS compliance_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      code       TEXT,
      section    TEXT,
      kind       TEXT,
      original   TEXT,
      rewritten  TEXT
    );

    CREATE TABLE IF NOT EXISTS risk_hit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      code       TEXT,
      rule_key   TEXT,
      severity   TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      code     TEXT NOT NULL UNIQUE,
      name     TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL
    );
  `);

  const stmtInsertReport = db.prepare(
    `INSERT OR REPLACE INTO reports
     (id,code,name,fund_type,depth,created_at,nav_date,score_a,score_m,score_x,score_t,risk_level,payload)
     VALUES (@id,@code,@name,@fund_type,@depth,@created_at,@nav_date,@score_a,@score_m,@score_x,@score_t,@risk_level,@payload)`
  );
  const stmtGetReport = db.prepare('SELECT payload FROM reports WHERE id = ?');
  const stmtLatestByCode = db.prepare(
    'SELECT payload FROM reports WHERE code = ? ORDER BY created_at DESC LIMIT 1'
  );
  const stmtList = db.prepare(
    `SELECT id,code,name,fund_type,created_at,nav_date,score_a,score_m,score_x,score_t,risk_level
     FROM reports ORDER BY created_at DESC LIMIT ?`
  );
  const stmtLog = db.prepare(
    `INSERT INTO analysis_log
     (created_at,code,depth,ok,total_ms,fetch_ms,compute_ms,model_ms,model_calls,prompt_tokens,output_tokens,degraded,err)
     VALUES (@created_at,@code,@depth,@ok,@total_ms,@fetch_ms,@compute_ms,@model_ms,@model_calls,@prompt_tokens,@output_tokens,@degraded,@err)`
  );
  const stmtCompliance = db.prepare(
    `INSERT INTO compliance_log (created_at,code,section,kind,original,rewritten)
     VALUES (@created_at,@code,@section,@kind,@original,@rewritten)`
  );
  const stmtRiskHit = db.prepare(
    'INSERT INTO risk_hit_log (created_at,code,rule_key,severity) VALUES (@created_at,@code,@rule_key,@severity)'
  );
  const stmtTodayStats = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok_count,
            SUM(COALESCE(model_calls,0)) AS model_calls,
            SUM(COALESCE(prompt_tokens,0)+COALESCE(output_tokens,0)) AS tokens
     FROM analysis_log WHERE substr(created_at,1,10) = ?`
  );
  const stmtRiskStats = db.prepare(
    `SELECT rule_key, COUNT(*) AS hits FROM risk_hit_log GROUP BY rule_key ORDER BY hits DESC LIMIT 40`
  );
  const stmtWatchAdd = db.prepare(
    'INSERT OR IGNORE INTO watchlist (code,name,added_at) VALUES (@code,@name,@added_at)'
  );
  const stmtWatchRemove = db.prepare('DELETE FROM watchlist WHERE code = ?');
  const stmtWatchCheck = db.prepare('SELECT id FROM watchlist WHERE code = ? LIMIT 1');
  const stmtWatchList = db.prepare('SELECT code,name,added_at FROM watchlist ORDER BY added_at DESC');
  const stmtHotCount = db.prepare(
    `SELECT code, name, COUNT(*) AS n FROM reports GROUP BY code ORDER BY n DESC, MAX(created_at) DESC LIMIT ?`
  );

  const scoreOf = (r, k) => {
    const v = r?.overview?.scores?.[k];
    return typeof v === 'number' ? v : null;
  };

  return {
    kind: 'sqlite',
    saveReport(report) {
      stmtInsertReport.run({
        id: report.id,
        code: report.code,
        name: report.name,
        fund_type: report.fundType || null,
        depth: report.depth,
        created_at: report.createdAt,
        nav_date: report.navDate || null,
        score_a: scoreOf(report, 'ability'),
        score_m: scoreOf(report, 'manager'),
        score_x: scoreOf(report, 'experience'),
        score_t: scoreOf(report, 'timingCost'),
        risk_level: report.overview?.riskLevel ?? null,
        payload: JSON.stringify(report),
      });
    },
    getReport(id) {
      const row = stmtGetReport.get(id);
      return row ? JSON.parse(row.payload) : null;
    },
    getLatestByCode(code) {
      const row = stmtLatestByCode.get(code);
      return row ? JSON.parse(row.payload) : null;
    },
    listReports(limit = 20) {
      return stmtList.all(limit).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        fundType: r.fund_type,
        createdAt: r.created_at,
        navDate: r.nav_date,
        scores: { ability: r.score_a, manager: r.score_m, experience: r.score_x, timingCost: r.score_t },
        riskLevel: r.risk_level,
      }));
    },
    hotByAnalysisCount(limit = 12) {
      return stmtHotCount.all(limit).map((r) => ({ code: r.code, name: r.name, count: r.n }));
    },
    logAnalysis(rec) {
      stmtLog.run({
        created_at: new Date().toISOString(),
        code: rec.code || null,
        depth: rec.depth || null,
        ok: rec.ok ? 1 : 0,
        total_ms: rec.totalMs ?? null,
        fetch_ms: rec.fetchMs ?? null,
        compute_ms: rec.computeMs ?? null,
        model_ms: rec.modelMs ?? null,
        model_calls: rec.modelCalls ?? null,
        prompt_tokens: rec.promptTokens ?? null,
        output_tokens: rec.outputTokens ?? null,
        degraded: rec.degraded ? JSON.stringify(rec.degraded) : null,
        err: rec.err ? String(rec.err).slice(0, 500) : null,
      });
    },
    logCompliance(rec) {
      stmtCompliance.run({
        created_at: new Date().toISOString(),
        code: rec.code || null,
        section: rec.section || null,
        kind: rec.kind || null,
        original: (rec.original || '').slice(0, 500),
        rewritten: (rec.rewritten || '').slice(0, 500),
      });
    },
    logRiskHits(code, findings) {
      const now = new Date().toISOString();
      for (const f of findings || []) {
        try {
          stmtRiskHit.run({ created_at: now, code: code || null, rule_key: f.key || null, severity: f.severity || null });
        } catch {
          /* 统计用，失败不影响主流程 */
        }
      }
    },
    todayStats() {
      const day = new Date().toISOString().slice(0, 10);
      const r = stmtTodayStats.get(day) || {};
      return {
        total: r.total || 0,
        okCount: r.ok_count || 0,
        modelCalls: r.model_calls || 0,
        tokens: r.tokens || 0,
      };
    },
    riskRuleStats() {
      return stmtRiskStats.all().map((r) => ({ key: r.rule_key, hits: r.hits }));
    },
    watchAdd(code, name) {
      stmtWatchAdd.run({ code, name: name || '', added_at: Math.floor(Date.now() / 1000) });
      return true;
    },
    watchRemove(code) {
      stmtWatchRemove.run(code);
      return true;
    },
    watchCheck(code) {
      return !!stmtWatchCheck.get(code);
    },
    watchList() {
      return stmtWatchList.all().map((r) => ({ code: r.code, name: r.name, addedAt: r.added_at }));
    },
  };
}

/* ---------------------- JSON 文件降级实现 ---------------------- */
function createFileImpl() {
  const reportsDir = path.join(config.dataDir, 'reports');
  const logFile = path.join(config.dataDir, 'analysis-log.jsonl');
  const complianceFile = path.join(config.dataDir, 'compliance-log.jsonl');
  const riskFile = path.join(config.dataDir, 'risk-hit-log.jsonl');
  const watchFile = path.join(config.dataDir, 'watchlist.json');
  fs.mkdirSync(reportsDir, { recursive: true });

  const safeId = (id) => /^[A-Za-z0-9_-]{6,64}$/.test(id);
  const readJson = (f, dft) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return dft;
    }
  };

  return {
    kind: 'file',
    saveReport(report) {
      if (!safeId(report.id)) throw new Error('非法报告 ID');
      fs.writeFileSync(path.join(reportsDir, `${report.id}.json`), JSON.stringify(report), 'utf8');
    },
    getReport(id) {
      if (!safeId(id)) return null;
      const f = path.join(reportsDir, `${id}.json`);
      if (!fs.existsSync(f)) return null;
      return readJson(f, null);
    },
    listAll() {
      return fs
        .readdirSync(reportsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(path.join(reportsDir, f), null))
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    getLatestByCode(code) {
      return this.listAll().find((r) => r.code === code) || null;
    },
    listReports(limit = 20) {
      return this.listAll()
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          fundType: r.fundType,
          createdAt: r.createdAt,
          navDate: r.navDate,
          scores: r.overview?.scores || {},
          riskLevel: r.overview?.riskLevel,
        }));
    },
    hotByAnalysisCount(limit = 12) {
      const m = new Map();
      for (const r of this.listAll()) {
        const k = r.code;
        if (!m.has(k)) m.set(k, { code: k, name: r.name, count: 0 });
        m.get(k).count += 1;
      }
      return [...m.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    },
    logAnalysis(rec) {
      fs.appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`);
    },
    logCompliance(rec) {
      fs.appendFileSync(complianceFile, `${JSON.stringify({ t: new Date().toISOString(), ...rec })}\n`);
    },
    logRiskHits(code, findings) {
      for (const f of findings || []) {
        fs.appendFileSync(
          riskFile,
          `${JSON.stringify({ t: new Date().toISOString(), code, key: f.key, severity: f.severity })}\n`
        );
      }
    },
    todayStats() {
      if (!fs.existsSync(logFile)) return { total: 0, okCount: 0, modelCalls: 0, tokens: 0 };
      const day = new Date().toISOString().slice(0, 10);
      let total = 0;
      let okCount = 0;
      let modelCalls = 0;
      let tokens = 0;
      for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (!String(r.t).startsWith(day)) continue;
          total += 1;
          if (r.ok) okCount += 1;
          modelCalls += r.modelCalls || 0;
          tokens += (r.promptTokens || 0) + (r.outputTokens || 0);
        } catch {
          /* 跳过坏行 */
        }
      }
      return { total, okCount, modelCalls, tokens };
    },
    riskRuleStats() {
      if (!fs.existsSync(riskFile)) return [];
      const m = new Map();
      for (const line of fs.readFileSync(riskFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          m.set(r.key, (m.get(r.key) || 0) + 1);
        } catch {
          /* 跳过坏行 */
        }
      }
      return [...m.entries()].map(([key, hits]) => ({ key, hits })).sort((a, b) => b.hits - a.hits);
    },
    watchAdd(code, name) {
      const list = readJson(watchFile, []);
      if (!list.some((x) => x.code === code)) {
        list.unshift({ code, name: name || '', addedAt: Math.floor(Date.now() / 1000) });
        fs.writeFileSync(watchFile, JSON.stringify(list), 'utf8');
      }
      return true;
    },
    watchRemove(code) {
      const list = readJson(watchFile, []).filter((x) => x.code !== code);
      fs.writeFileSync(watchFile, JSON.stringify(list), 'utf8');
      return true;
    },
    watchCheck(code) {
      return readJson(watchFile, []).some((x) => x.code === code);
    },
    watchList() {
      return readJson(watchFile, []);
    },
  };
}

let impl = null;
try {
  impl = createSqliteImpl();
  logger.info('存储层已就绪', { kind: 'sqlite', file: config.dbFile });
} catch (e) {
  impl = createFileImpl();
  logger.warn('better-sqlite3 不可用，已降级为 JSON 文件存储', { reason: e.message });
}

module.exports = impl;
