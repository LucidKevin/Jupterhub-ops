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
import { parseJupyterUsernameFromContainerName } from '../src/lib/jupyter-container-name';
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

/** Promise 化 exec，统一 async/await 风格 */
const execAsync = promisify(exec);

/** docker 多次采样在 stdout 中的分块分隔符 */
const SAMPLE_SEP = '---JHOPS_SAMPLE---';
/** 窗口采样次数：15 次 */
const SAMPLE_COUNT = 15;
/** 采样间隔：3 秒（总窗口约 45 秒） */
const SLEEP_SEC = 3;

/** 通用 sleep */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** docker stats 的单行 JSON 结构（仅保留会用到的字段） */
interface DockerStatEntry {
  Name: string;
  CPUPerc: string;
  MemUsage: string;
}

/** docker 容量字符串统一换算为 MiB */
function parseSizeToMiB(s: string): number {
  const val = parseFloat(s);
  if (Number.isNaN(val)) return 0;
  if (/GiB|GB/i.test(s)) return val * 1024;
  if (/MiB|MB/i.test(s)) return val;
  if (/KiB|kB/i.test(s)) return val / 1024;
  return val / (1024 * 1024);
}

/** 统一容器名解析入口，避免与 API 路由口径不一致 */
function usernameFromJupyterContainer(name: string): string | null {
  return parseJupyterUsernameFromContainerName(name);
}

/**
 * 解析单个采样块（多行 docker stats）并按用户聚合。
 * @returns Map<username, {cpu, memUsageMiB, memLimitMiB, node}>
 */
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

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 求序列最大值（并四舍五入） */
function maxOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return round2(Math.max(...nums));
}

/** 求序列 avg + max（并四舍五入） */
function summarize(nums: number[]): AggTriple {
  if (nums.length === 0) return { avg: null, max: null };
  const avg = round2(nums.reduce((a, b) => a + b, 0) / nums.length);
  return { avg, max: maxOf(nums) };
}

/** 采集单节点 node exporter 一个窗口的数据，并输出 avg/max */
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
  console.error(`[collect-metrics] node-window start node=${ip} sample_count=${SAMPLE_COUNT} sleep_sec=${SLEEP_SEC}`);
  const samples: NonNullable<Awaited<ReturnType<typeof tryFetchNodeExporterMetrics>>['metrics']>[] = [];
  let lastError = '';
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    console.error(`[collect-metrics] node-window sample node=${ip} idx=${i + 1}/${SAMPLE_COUNT}`);
    const { metrics, error } = await tryFetchNodeExporterMetrics(
      ip,
      NODE_EXPORTER_PORT,
      API_TIMEOUT_MS.nodeMetrics
    );
    if (!metrics) {
      if (error) lastError = error;
      console.error(`[collect-metrics] node-window fail node=${ip} idx=${i + 1} error=${lastError || 'unknown'}`);
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
  console.error(
    `[collect-metrics] node-window done node=${ip} cpu_avg=${cpu.avg} cpu_max=${cpu.max} mem_avg=${mem_pct} mem_max=${mem.max} disk_avg=${disk_pct} disk_max=${disk.max}`
  );
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
  console.error(`[collect-metrics] docker-window start node=${ip} sample_count=${SAMPLE_COUNT} sleep_sec=${SLEEP_SEC}`);
  // 聚合窗口内每次采样，最终得到 user -> cpu[]/mem[]/limit[]
  const agg = new Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>();
  const connectSec = Math.floor(API_TIMEOUT_MS.sshConnect / 1000);
  const sampleRounds = Array.from({ length: SAMPLE_COUNT }, (_, i) => String(i + 1)).join(' ');
  // 在远端节点循环执行 docker stats，按 SAMPLE_SEP 断开采样块
  const remote = [
    `for n in ${sampleRounds}; do`,
    `docker stats --no-stream --format '{{json .}}';`,
    `echo '${SAMPLE_SEP}';`,
    `sleep ${SLEEP_SEC};`,
    'done',
  ].join(' ');
  try {
    const { stdout, stderr } = await execAsync(
      `ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=${connectSec} root@${ip} ${JSON.stringify(remote)}`
    );
    const rawLines = stdout.split('\n').filter((l) => l.trim().length > 0).length;
    const parts = stdout.split(SAMPLE_SEP);
    let parsedUsers = 0;
    for (const part of parts) {
      const map = parseDockerStatsBlock(part, ip);
      parsedUsers += map.size;
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
    // 诊断信息：原始行数/解析命中数/窗口内用户数
    console.error(
      `[collect-metrics] docker-sample node=${ip} raw_lines=${rawLines} parsed_users=${parsedUsers} unique_users=${agg.size}`
    );
    if (rawLines === 0 && stderr.trim()) {
      console.error(`[collect-metrics] docker-sample node=${ip} stderr=${stderr.trim().slice(0, 500)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[collect-metrics] docker-sample node=${ip} error=${msg}`);
    if (process.env.JHOPS_COLLECT_DEBUG === '1') {
      console.error(`[collect-metrics] docker stats via ssh ${ip}: ${msg}`);
    }
  }
  console.error(`[collect-metrics] docker-window done node=${ip} unique_users=${agg.size}`);
  return agg;
}

function mean(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * 用户名匹配兜底策略：
 * 1) 精确匹配
 * 2) lower key 直取
 * 3) 全量大小写不敏感扫描
 */
function pickUserSeries(
  perUser: Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>,
  username: string
) {
  const direct = perUser.get(username);
  if (direct) return direct;
  const lower = username.toLowerCase();
  if (lower !== username) {
    const hit = perUser.get(lower);
    if (hit) return hit;
  }
  for (const [k, v] of perUser) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
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
  // 本窗口统一时间戳（秒）
  const ts = Math.floor(Date.now() / 1000);
  console.error(`[collect-metrics] stage=main-start ts=${ts}`);
  const db = await openMetricsSqlDatabase();
  console.error('[collect-metrics] stage=db-opened');

  // A) 采集节点资源
  const nodeIps = CLUSTER_NODES_CONFIG.map((n) => n.ip);
  console.error(`[collect-metrics] ts=${ts} nodejs=${process.version} nodes=${nodeIps.join(',')}`);
  console.error(`[collect-metrics] stage=parallel-start node_count=${nodeIps.length}`);

  // B) 拉取 Hub 用户列表（支持环境变量覆盖）
  const hubApiUrl = (process.env.JHOPS_JUPYTERHUB_API_URL ?? '').trim() || JUPYTERHUB_CONFIG.apiUrl;
  const hubToken = (process.env.JHOPS_JUPYTERHUB_TOKEN ?? '').trim() || JUPYTERHUB_CONFIG.token;

  // C) 采集用户容器资源（按你的要求仅 worker）
  const dockerStatNodes = CLUSTER_NODES_CONFIG.filter((n) => n.role === 'worker');
  console.error(
    `[collect-metrics] stage=parallel-subtasks-start worker_nodes=${dockerStatNodes.map((n) => n.ip).join(',') || '-'}`
  );

  // 1) 节点窗口采集（并发）
  const nodeRowsPromise: Promise<NodeCollectRow[]> = Promise.all(
    nodeIps.map(async (ip): Promise<NodeCollectRow> => {
      const r = await collectNodeWindow(ip);
      return r.ok ? { ip, row: r.row } : { ip, row: null, err: r.error };
    })
  );
  // 2) Hub 用户拉取（并发）
  const hubUsersPromise = fetchJupyterHubUsers({
    apiUrl: hubApiUrl,
    token: hubToken,
    timeoutMs: API_TIMEOUT_MS.userServerAction,
  });
  // 3) docker 窗口采集（并发）
  const perUser = new Map<string, { cpu: number[]; mem: number[]; limit: number[]; node: string }>();
  const workerMapsPromise = Promise.all(dockerStatNodes.map((w) => collectDockerSamplesOverWindow(w.ip)));

  // 等待三个并行子任务结束
  const [nodeRows, hubUsersResult, workerMaps] = await Promise.all([
    nodeRowsPromise,
    hubUsersPromise,
    workerMapsPromise,
  ]);
  console.error(
    `[collect-metrics] stage=parallel-done node_rows=${nodeRows.length} docker_maps=${workerMaps.length}`
  );

  let jupyterUsers: JupyterUser[] = [];
  if (!hubUsersResult.ok) {
    console.error(`[collect-metrics] JupyterHub users fetch failed: ${hubUsersResult.error}`);
  } else {
    jupyterUsers = hubUsersResult.users;
    console.error(`[collect-metrics] stage=hub-fetch-done users=${jupyterUsers.length}`);
  }

  // 将多节点结果合并为全局 perUser
  for (let wi = 0; wi < dockerStatNodes.length; wi++) {
    const local = workerMaps[wi]!;
    const wip = dockerStatNodes[wi]!.ip;
    for (const [user, v] of local) {
      if (!perUser.has(user)) perUser.set(user, { cpu: [], mem: [], limit: [], node: wip });
      const p = perUser.get(user)!;
      p.cpu.push(...v.cpu);
      p.mem.push(...v.mem);
      p.limit.push(...v.limit);
      p.node = v.node || wip;
    }
  }
  console.error(`[collect-metrics] stage=docker-merge-done users=${perUser.size}`);

  // D) 写库：开启事务，保证窗口内数据一致落库
  db.run('BEGIN TRANSACTION');
  console.error('[collect-metrics] stage=txn-begin');

  // D1) 写 node 维度
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
  console.error('[collect-metrics] stage=node-insert-done');

  // D2) 写 user 维度（仅 Hub 运行中用户）
  const insertUser = db.prepare(
    `INSERT OR REPLACE INTO user_metric_points (
      ts, username, cpu_pct, cpu_max, mem_usage_mib, mem_usage_max_mib, mem_limit_mib, node_ip
    ) VALUES (?,?,?,?,?,?,?,?)`
  );
  let runningHubUsers = 0;
  let matchedDockerUsers = 0;
  let insertedUserPoints = 0;
  const runningHubNames: string[] = [];
  for (const u of jupyterUsers) {
    const running = u.servers && Object.keys(u.servers).length > 0;
    if (!running) continue;
    runningHubUsers += 1;
    runningHubNames.push(u.name);
    const s = pickUserSeries(perUser, u.name); // 处理大小写等命名差异
    if (!s || s.cpu.length === 0) continue;
    matchedDockerUsers += 1;
    const cpu = summarize(s.cpu);
    const mem = summarize(s.mem);
    const cpu_pct = cpu.avg ?? 0;
    const mem_usage_mib = mem.avg ?? 0;
    // 若限制值均为 0，则视为无有效 limit，写 null
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
    insertedUserPoints += 1;
    console.error(
      `[collect-metrics] user ${u.name} cpu_avg=${cpu_pct} cpu_max=${cpu.max} mem_avg=${mem_usage_mib}MiB mem_max=${mem.max}MiB`
    );
  }
  insertUser.free();
  console.error('[collect-metrics] stage=user-insert-done');
  console.error(
    `[collect-metrics] user-summary hub_running=${runningHubUsers} docker_matched=${matchedDockerUsers} inserted=${insertedUserPoints}`
  );
  if (runningHubUsers > 0 && matchedDockerUsers === 0) {
    const dockerNames = Array.from(perUser.keys()).sort();
    console.error(
      `[collect-metrics] user-debug hub_names=${runningHubNames.join('|') || '-'} docker_names=${dockerNames.join('|') || '-'}`
    );
  }

  // E) 清理保留期外历史数据
  const cutoff = ts - METRICS_RETENTION_DAYS * 86400;
  console.error(`[collect-metrics] stage=retention-cleanup-start cutoff=${cutoff} retention_days=${METRICS_RETENTION_DAYS}`);
  db.run('DELETE FROM node_metric_points WHERE ts < ?', [cutoff]);
  db.run('DELETE FROM user_metric_points WHERE ts < ?', [cutoff]);
  console.error('[collect-metrics] stage=retention-cleanup-done');

  // F) 事务提交并持久化到磁盘
  db.run('COMMIT');
  console.error('[collect-metrics] stage=txn-commit');

  persistMetricsDatabase(db);
  console.error('[collect-metrics] stage=db-persisted');
  db.close();
  console.error('[collect-metrics] stage=db-closed');
  console.error('[collect-metrics] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
