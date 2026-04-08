/**
 * 采集约 45s 窗口内 Node Exporter / docker stats 均值，写入 SQLite（sql.js，无原生模块）。
 * 由 cron 调用：scripts/collect-metrics.sh 或 pnpm exec tsx scripts/collect-metrics.ts
 *
 * 环境变量（可选）：
 * - JHOPS_JUPYTERHUB_API_URL / JHOPS_JUPYTERHUB_TOKEN：覆盖 cluster 里写死的 Hub API（防火墙、反代路径不同时用）
 * - JHOPS_COLLECT_DEBUG=1：打印 SSH docker stats 失败原因（默认吞掉以免刷满 cron 日志）
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { CLUSTER_NODES_CONFIG, JUPYTERHUB_CONFIG, NODE_EXPORTER_PORT } from '../src/config/cluster';
import { METRICS_RETENTION_DAYS } from '../src/config/metrics-store';
import { API_TIMEOUT_MS, SSH_PORT } from '../src/config/service';
import { fetchJupyterHubUsers } from '../src/lib/jupyterhub-client';
import {
  openMetricsSqlDatabase,
  persistMetricsDatabase,
} from '../src/lib/metrics-sqlite';
import {
  averageInts,
  cpuUsageFromDelta,
  getDiskUsagePercent,
  getMemoryUsagePercent,
  tryFetchNodeExporterMetrics,
} from '../src/lib/prometheus-node-metrics';

const execAsync = promisify(exec);

const SAMPLE_SEP = '---JHOPS_SAMPLE---';
const SAMPLE_COUNT = 15;
const SLEEP_SEC = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface DockerStatEntry {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
}

function parseSizeToMiB(s: string): number {
  const val = parseFloat(s);
  if (Number.isNaN(val)) return 0;
  if (/GiB|GB/i.test(s)) return val * 1024;
  if (/MiB|MB/i.test(s)) return val;
  if (/KiB|kB/i.test(s)) return val / 1024;
  return val / (1024 * 1024);
}

function usernameFromJupyterContainer(name: string): string | null {
  const m = name.match(/^jupyter-([^.]+)\./);
  return m?.[1] ?? null;
}

function parseDockerStatsBlock(
  block: string,
  nodeIp: string
): Map<string, { cpu: number; memUsageMiB: number; memLimitMiB: number; node: string }> {
  const map = new Map<string, { cpu: number; memUsageMiB: number; memLimitMiB: number; node: string }>();
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t) as DockerStatEntry;
      if (!entry.Name?.startsWith('jupyter-')) continue;
      const user = usernameFromJupyterContainer(entry.Name);
      if (!user) continue;
      const [usage, limit] = entry.MemUsage.split(' / ');
      map.set(user, {
        cpu: parseFloat(entry.CPUPerc) || 0,
        memUsageMiB: parseSizeToMiB(usage || ''),
        memLimitMiB: parseSizeToMiB(limit || ''),
        node: nodeIp,
      });
    } catch {
      /* skip */
    }
  }
  return map;
}

interface AggTriple {
  avg: number | null;
  max: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function maxOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return round2(Math.max(...nums));
}

function summarize(nums: number[]): AggTriple {
  if (nums.length === 0) return { avg: null, max: null };
  const avg = round2(nums.reduce((a, b) => a + b, 0) / nums.length);
  return { avg, max: maxOf(nums) };
}

async function collectNodeWindow(ip: string): Promise<
  | {
      ok: true;
      row: {
        cpu_pct: number;
        cpu_max: number | null;
        mem_pct: number | null;
        mem_max: number | null;
        disk_pct: number | null;
        disk_max: number | null;
      };
    }
  | { ok: false; error: string }
> {
  const samples: NonNullable<Awaited<ReturnType<typeof tryFetchNodeExporterMetrics>>['metrics']>[] = [];
  let lastError = '';
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const { metrics, error } = await tryFetchNodeExporterMetrics(
      ip,
      NODE_EXPORTER_PORT,
      API_TIMEOUT_MS.nodeMetrics
    );
    if (!metrics) {
      if (error) lastError = error;
      return { ok: false, error: lastError || 'unknown fetch failure' };
    }
    samples.push(metrics);
    if (i < SAMPLE_COUNT - 1) await sleep(SLEEP_SEC * 1000);
  }
  const cpuSeries: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    cpuSeries.push(cpuUsageFromDelta(samples[i - 1]!, samples[i]!));
  }
  const memSeries = samples
    .map((s) => getMemoryUsagePercent(s))
    .filter((v): v is number => v != null && !Number.isNaN(v));
  const diskSeries = samples
    .map((s) => getDiskUsagePercent(s))
    .filter((v): v is number => v != null && !Number.isNaN(v));

  const cpu = summarize(cpuSeries);
  const mem = summarize(memSeries);
  const disk = summarize(diskSeries);
  const mem_pct = averageInts(samples.map((s) => getMemoryUsagePercent(s)));
  const disk_pct = averageInts(samples.map((s) => getDiskUsagePercent(s)));
  return {
    ok: true,
    row: {
      cpu_pct: cpu.avg ?? 0,
      cpu_max: cpu.max,
      mem_pct,
      mem_max: mem.max,
      disk_pct,
      disk_max: disk.max,
    },
  };
}

async function collectDockerSamplesOverWindow(
  ip: string
): Promise<Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>> {
  const agg = new Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>();
  const connectSec = Math.floor(API_TIMEOUT_MS.sshConnect / 1000);
  const remote = [
    `n=1; while [ "$n" -le ${SAMPLE_COUNT} ]; do`,
    `docker stats --no-stream --format '{{json .}}' 2>/dev/null;`,
    `echo '${SAMPLE_SEP}';`,
    `sleep ${SLEEP_SEC};`,
    'n=$((n+1));',
    'done',
  ].join(' ');
  try {
    const { stdout } = await execAsync(
      `ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=${connectSec} root@${ip} ${JSON.stringify(remote)}`
    );
    const parts = stdout.split(SAMPLE_SEP);
    for (const part of parts) {
      const map = parseDockerStatsBlock(part, ip);
      for (const [user, v] of map) {
        if (!agg.has(user)) {
          agg.set(user, { cpu: [], mem: [], limit: [], node: ip });
        }
        const a = agg.get(user)!;
        a.cpu.push(v.cpu);
        a.mem.push(v.memUsageMiB);
        a.limit.push(v.memLimitMiB);
        a.node = v.node;
      }
    }
  } catch (e) {
    if (process.env.JHOPS_COLLECT_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[collect-metrics] docker stats via ssh ${ip}: ${msg}`);
    }
  }
  return agg;
}

function mean(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

interface JupyterUser {
  name: string;
  servers: Record<string, unknown>;
}

type NodeCollectRow =
  | {
      ip: string;
      row: {
        cpu_pct: number;
        cpu_max: number | null;
        mem_pct: number | null;
        mem_max: number | null;
        disk_pct: number | null;
        disk_max: number | null;
      };
      err?: undefined;
    }
  | { ip: string; row: null; err: string };

async function main() {
  const ts = Math.floor(Date.now() / 1000);
  const db = await openMetricsSqlDatabase();

  const nodeIps = CLUSTER_NODES_CONFIG.map((n) => n.ip);
  console.error(`[collect-metrics] ts=${ts} nodejs=${process.version} nodes=${nodeIps.join(',')}`);

  const nodeRows: NodeCollectRow[] = await Promise.all(
    nodeIps.map(async (ip): Promise<NodeCollectRow> => {
      const r = await collectNodeWindow(ip);
      return r.ok ? { ip, row: r.row } : { ip, row: null, err: r.error };
    })
  );

  const hubApiUrl = (process.env.JHOPS_JUPYTERHUB_API_URL ?? '').trim() || JUPYTERHUB_CONFIG.apiUrl;
  const hubToken = (process.env.JHOPS_JUPYTERHUB_TOKEN ?? '').trim() || JUPYTERHUB_CONFIG.token;

  const hubUsersResult = await fetchJupyterHubUsers({
    apiUrl: hubApiUrl,
    token: hubToken,
    timeoutMs: API_TIMEOUT_MS.userServerAction,
  });
  let jupyterUsers: JupyterUser[] = [];
  if (!hubUsersResult.ok) {
    console.error(`[collect-metrics] JupyterHub users fetch failed: ${hubUsersResult.error}`);
  } else {
    jupyterUsers = hubUsersResult.users;
  }

  const workers = CLUSTER_NODES_CONFIG.filter((n) => n.role === 'worker');
  const perUser = new Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>();

  const workerMaps = await Promise.all(workers.map((w) => collectDockerSamplesOverWindow(w.ip)));
  for (let wi = 0; wi < workers.length; wi++) {
    const local = workerMaps[wi]!;
    const wip = workers[wi]!.ip;
    for (const [user, v] of local) {
      if (!perUser.has(user)) perUser.set(user, { cpu: [], mem: [], limit: [], node: wip });
      const p = perUser.get(user)!;
      p.cpu.push(...v.cpu);
      p.mem.push(...v.mem);
      p.limit.push(...v.limit);
      p.node = v.node || wip;
    }
  }

  db.run('BEGIN TRANSACTION');

  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO node_metric_points (
      ts, node_ip, cpu_pct, cpu_max, mem_pct, mem_max, disk_pct, disk_max
    ) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const { ip, row, err } of nodeRows) {
    if (row) {
      insertNode.run([
        ts,
        ip,
        row.cpu_pct,
        row.cpu_max,
        row.mem_pct ?? null,
        row.mem_max,
        row.disk_pct ?? null,
        row.disk_max,
      ]);
      console.error(
        `[collect-metrics] node ${ip} cpu_avg=${row.cpu_pct} cpu_max=${row.cpu_max} mem_avg=${row.mem_pct} mem_max=${row.mem_max} disk_avg=${row.disk_pct} disk_max=${row.disk_max}`
      );
    } else {
      console.error(`[collect-metrics] node ${ip} skip (unreachable)${err ? `: ${err}` : ''}`);
    }
  }
  insertNode.free();

  const insertUser = db.prepare(
    `INSERT OR REPLACE INTO user_metric_points (
      ts, username, cpu_pct, cpu_max, mem_usage_mib, mem_usage_max_mib, mem_limit_mib, node_ip
    ) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const u of jupyterUsers) {
    const running = u.servers && Object.keys(u.servers).length > 0;
    if (!running) continue;
    const s = perUser.get(u.name);
    if (!s || s.cpu.length === 0) continue;
    const cpu = summarize(s.cpu);
    const mem = summarize(s.mem);
    const cpu_pct = cpu.avg ?? 0;
    const mem_usage_mib = mem.avg ?? 0;
    const mem_limit_mib = mean(s.limit) > 0 ? Math.round(mean(s.limit) * 100) / 100 : null;
    insertUser.run([
      ts,
      u.name,
      cpu_pct,
      cpu.max,
      mem_usage_mib,
      mem.max,
      mem_limit_mib,
      s.node,
    ]);
    console.error(
      `[collect-metrics] user ${u.name} cpu_avg=${cpu_pct} cpu_max=${cpu.max} mem_avg=${mem_usage_mib}MiB mem_max=${mem.max}MiB`
    );
  }
  insertUser.free();

  const cutoff = ts - METRICS_RETENTION_DAYS * 86400;
  db.run('DELETE FROM node_metric_points WHERE ts < ?', [cutoff]);
  db.run('DELETE FROM user_metric_points WHERE ts < ?', [cutoff]);

  db.run('COMMIT');

  persistMetricsDatabase(db);
  db.close();
  console.error('[collect-metrics] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
