import fs from 'fs';
import path from 'path';
import type { Database } from 'sql.js';
import { METRICS_SQLITE_PATH } from '../config/metrics-store';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_metric_points (
  ts INTEGER NOT NULL,
  node_ip TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  cpu_max REAL,
  cpu_p95 REAL,
  mem_pct REAL,
  mem_max REAL,
  mem_p95 REAL,
  disk_pct REAL,
  disk_max REAL,
  disk_p95 REAL,
  PRIMARY KEY (ts, node_ip)
);
CREATE INDEX IF NOT EXISTS idx_node_metric_ip_ts ON node_metric_points (node_ip, ts);

CREATE TABLE IF NOT EXISTS user_metric_points (
  ts INTEGER NOT NULL,
  username TEXT NOT NULL,
  cpu_pct REAL NOT NULL,
  cpu_max REAL,
  cpu_p95 REAL,
  mem_usage_mib REAL NOT NULL,
  mem_usage_max_mib REAL,
  mem_usage_p95_mib REAL,
  mem_limit_mib REAL,
  node_ip TEXT,
  PRIMARY KEY (ts, username)
);
CREATE INDEX IF NOT EXISTS idx_user_metric_user_ts ON user_metric_points (username, ts);
`;

let initPromise: Promise<Awaited<ReturnType<(typeof import('sql.js'))['default']>>> | null = null;

/** 不用 createRequire（Next 打包时可能解析失败），在磁盘上找 sql-wasm.wasm */
function resolveSqlJsWasmDir(): string {
  const root = process.cwd();
  const wasmName = 'sql-wasm.wasm';

  const tryDir = (distDir: string) =>
    fs.existsSync(path.join(distDir, wasmName)) ? distDir : null;

  const flat = path.join(root, 'node_modules', 'sql.js', 'dist');
  const foundFlat = tryDir(flat);
  if (foundFlat) return foundFlat;

  const pnpmRoot = path.join(root, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmRoot)) {
    try {
      for (const name of fs.readdirSync(pnpmRoot)) {
        if (!name.startsWith('sql.js@')) continue;
        const candidate = path.join(pnpmRoot, name, 'node_modules', 'sql.js', 'dist');
        const ok = tryDir(candidate);
        if (ok) return ok;
      }
    } catch {
      /* ignore */
    }
  }

  return flat;
}

async function getSqlJs() {
  if (!initPromise) {
    initPromise = (async () => {
      const initSqlJs = (await import('sql.js')).default;
      const wasmDir = resolveSqlJsWasmDir();
      return initSqlJs({
        locateFile: (file: string) => path.join(wasmDir, file),
      });
    })();
  }
  return initPromise;
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  let exists = false;
  while (stmt.step()) {
    const row = stmt.getAsObject() as { name?: unknown };
    if (String(row.name) === column) {
      exists = true;
      break;
    }
  }
  stmt.free();
  return exists;
}

function ensureColumn(db: Database, table: string, column: string, typeDef: string) {
  if (!tableHasColumn(db, table, column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
  }
}

function migrateMetricsSchema(db: Database): void {
  ensureColumn(db, 'node_metric_points', 'cpu_max', 'REAL');
  ensureColumn(db, 'node_metric_points', 'cpu_p95', 'REAL');
  ensureColumn(db, 'node_metric_points', 'mem_max', 'REAL');
  ensureColumn(db, 'node_metric_points', 'mem_p95', 'REAL');
  ensureColumn(db, 'node_metric_points', 'disk_max', 'REAL');
  ensureColumn(db, 'node_metric_points', 'disk_p95', 'REAL');

  ensureColumn(db, 'user_metric_points', 'cpu_max', 'REAL');
  ensureColumn(db, 'user_metric_points', 'cpu_p95', 'REAL');
  ensureColumn(db, 'user_metric_points', 'mem_usage_max_mib', 'REAL');
  ensureColumn(db, 'user_metric_points', 'mem_usage_p95_mib', 'REAL');
}

/** 打开可写库（采集脚本用）；读 API 用内部 openDatabase */
export async function openMetricsSqlDatabase(): Promise<Database> {
  const SQL = await getSqlJs();
  const dir = path.dirname(METRICS_SQLITE_PATH);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  let db: Database;
  if (fs.existsSync(METRICS_SQLITE_PATH)) {
    const buf = fs.readFileSync(METRICS_SQLITE_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.exec(SCHEMA);
  migrateMetricsSchema(db);
  return db;
}

export function persistMetricsDatabase(db: Database): void {
  const data = db.export();
  fs.writeFileSync(METRICS_SQLITE_PATH, Buffer.from(data));
}

export interface NodeHistoryRow {
  ts: number;
  cpu_pct: number;
  cpu_max: number | null;
  cpu_p95: number | null;
  mem_pct: number | null;
  mem_max: number | null;
  mem_p95: number | null;
  disk_pct: number | null;
  disk_max: number | null;
  disk_p95: number | null;
}

export interface UserHistoryRow {
  ts: number;
  cpu_pct: number;
  cpu_max: number | null;
  cpu_p95: number | null;
  mem_usage_mib: number;
  mem_usage_max_mib: number | null;
  mem_usage_p95_mib: number | null;
  mem_limit_mib: number | null;
  node_ip: string | null;
}

function stmtAll<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params: (string | number | null)[]
): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export async function queryNodeHistory(
  ip: string,
  fromTs: number,
  toTs: number,
  limit = 5000
): Promise<NodeHistoryRow[]> {
  const db = await openMetricsSqlDatabase();
  try {
    const raw = stmtAll<{
      ts: number;
      cpu_pct: number;
      cpu_max: number | null;
      cpu_p95: number | null;
      mem_pct: number | null;
      mem_max: number | null;
      mem_p95: number | null;
      disk_pct: number | null;
      disk_max: number | null;
      disk_p95: number | null;
    }>(
      db,
      `SELECT ts, cpu_pct, cpu_max, cpu_p95, mem_pct, mem_max, mem_p95, disk_pct, disk_max, disk_p95
       FROM node_metric_points
       WHERE node_ip = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC
       LIMIT ?`,
      [ip, fromTs, toTs, limit]
    );
    return raw.map((r) => ({
      ts: Number(r.ts),
      cpu_pct: Number(r.cpu_pct),
      cpu_max: r.cpu_max == null ? null : Number(r.cpu_max),
      cpu_p95: r.cpu_p95 == null ? null : Number(r.cpu_p95),
      mem_pct: r.mem_pct == null ? null : Number(r.mem_pct),
      mem_max: r.mem_max == null ? null : Number(r.mem_max),
      mem_p95: r.mem_p95 == null ? null : Number(r.mem_p95),
      disk_pct: r.disk_pct == null ? null : Number(r.disk_pct),
      disk_max: r.disk_max == null ? null : Number(r.disk_max),
      disk_p95: r.disk_p95 == null ? null : Number(r.disk_p95),
    }));
  } finally {
    db.close();
  }
}

export async function queryUserHistory(
  username: string,
  fromTs: number,
  toTs: number,
  limit = 5000
): Promise<UserHistoryRow[]> {
  const db = await openMetricsSqlDatabase();
  try {
    const raw = stmtAll<{
      ts: number;
      cpu_pct: number;
      cpu_max: number | null;
      cpu_p95: number | null;
      mem_usage_mib: number;
      mem_usage_max_mib: number | null;
      mem_usage_p95_mib: number | null;
      mem_limit_mib: number | null;
      node_ip: string | null;
    }>(
      db,
      `SELECT ts, cpu_pct, cpu_max, cpu_p95, mem_usage_mib, mem_usage_max_mib, mem_usage_p95_mib, mem_limit_mib, node_ip
       FROM user_metric_points
       WHERE username = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC
       LIMIT ?`,
      [username, fromTs, toTs, limit]
    );
    return raw.map((r) => ({
      ts: Number(r.ts),
      cpu_pct: Number(r.cpu_pct),
      cpu_max: r.cpu_max == null ? null : Number(r.cpu_max),
      cpu_p95: r.cpu_p95 == null ? null : Number(r.cpu_p95),
      mem_usage_mib: Number(r.mem_usage_mib),
      mem_usage_max_mib: r.mem_usage_max_mib == null ? null : Number(r.mem_usage_max_mib),
      mem_usage_p95_mib: r.mem_usage_p95_mib == null ? null : Number(r.mem_usage_p95_mib),
      mem_limit_mib: r.mem_limit_mib == null ? null : Number(r.mem_limit_mib),
      node_ip: r.node_ip == null ? null : String(r.node_ip),
    }));
  } finally {
    db.close();
  }
}
