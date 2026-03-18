/**
 * GET /api/dashboard/user-stats
 *
 * 聚合三个数据源，返回用户管理页面所需的全量数据：
 *
 * 1. JupyterHub REST API（/hub/api/users）
 *    - 用户列表、是否为管理员、servers 字段判断是否运行中、最后活跃时间
 *
 * 2. SSH docker stats（每个 worker 节点）
 *    - `docker stats --no-stream --format "{{json .}}"` 获取容器 CPU / 内存数据
 *    - 容器名格式：jupyter-{username}.{server_suffix}
 *      → 通过正则 /^jupyter-([^.]+)\./ 提取 username 后与 JupyterHub 用户匹配
 *
 * 3. Node Exporter（每个 worker 节点，端口 9100）
 *    - node_memory_MemTotal_bytes / node_memory_MemAvailable_bytes
 *    - 汇总三个 worker 节点的总内存 / 已用内存（不含 Manager 节点）
 *
 * 返回示例：
 * {
 *   totalUsers: 10 ,
 *   runningUsers: 3,
 *   stoppedUsers: 7,
 *   workerMemTotalGB: 22.8,
 *   workerMemUsedGB: 8.5,
 *   users: [
 *     {
 *       username: "kevinhuang2",
 *       admin: false,
 *       status: "running",
 *       containerName: "jupyter-kevinhuang2.1.p1g4z1s15gayizmi2aqzs9h0d",
 *       node: "10.9.123.228",
 *       cpuPercent: 0.0,
 *       memUsageMiB: 107.5,
 *       memLimitMiB: 7802.88,
 *       lastActivity: "2026-03-04T09:30:00.000Z"
 *     },
 *     ...
 *   ]
 * }
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CLUSTER_NODES_CONFIG, JUPYTERHUB_CONFIG, NODE_EXPORTER_PORT } from '@/config/cluster';
import { API_TIMEOUT_MS, SSH_PORT } from '@/config/service';

const execAsync = promisify(exec);

/** JupyterHub GET /hub/api/users 返回的用户字段（仅使用到的部分） */
interface JupyterUser {
  name: string;
  servers: Record<string, unknown>;
  admin: boolean;
  last_activity: string | null;
}

/** docker stats --no-stream --format "{{json .}}" 单行 JSON 结构 */
interface DockerStatEntry {
  Name: string;
  CPUPerc: string;   // "0.00%"
  MemUsage: string;  // "107.5MiB / 7.62GiB"
}

/**
 * 将 docker stats 内存字符串（如 "107.5MiB"、"7.62GiB"、"512kB"）转换为 MiB。
 */
function parseSizeToMiB(s: string): number {
  const val = parseFloat(s);
  if (isNaN(val)) return 0;
  if (/GiB|GB/i.test(s)) return val * 1024;
  if (/MiB|MB/i.test(s)) return val;
  if (/KiB|kB/i.test(s)) return val / 1024;
  return val / (1024 * 1024); // 纯字节
}

/**
 * SSH 到指定 worker 节点，执行 docker stats --no-stream，
 * 仅返回以 "jupyter-" 开头的容器数据。
 * 连接超时 5 秒，失败时返回空数组。
 */
async function fetchWorkerContainerStats(ip: string): Promise<
  { name: string; cpuPercent: number; memUsageMiB: number; memLimitMiB: number; node: string }[]
> {
  try {
    const { stdout } = await execAsync(
      `ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=${Math.floor(API_TIMEOUT_MS.sshConnect / 1000)} root@${ip} 'docker stats --no-stream --format "{{json .}}"'`
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as DockerStatEntry;
          // 只处理 JupyterHub 用户容器
          if (!entry.Name.startsWith('jupyter-')) return [];
          const [usage, limit] = entry.MemUsage.split(' / ');
          return [{
            name: entry.Name,
            cpuPercent: parseFloat(entry.CPUPerc) || 0,
            memUsageMiB: parseSizeToMiB(usage),
            memLimitMiB: parseSizeToMiB(limit),
            node: ip,
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * 从 Node Exporter 获取指定节点的内存总量和已用量（单位：GB）。
 * 超时 5 秒，失败时返回 { totalGB: 0, usedGB: 0 }。
 */
async function fetchWorkerMemoryGB(ip: string): Promise<{ totalGB: number; usedGB: number }> {
  try {
    const res = await fetch(`http://${ip}:${NODE_EXPORTER_PORT}/metrics`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS.nodeMetrics),
    });
    const text = await res.text();
    let memTotal = 0, memAvail = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('node_memory_MemTotal_bytes ')) {
        memTotal = parseFloat(line.split(' ')[1]);
      } else if (line.startsWith('node_memory_MemAvailable_bytes ')) {
        memAvail = parseFloat(line.split(' ')[1]);
      }
    }
    const GB = 1024 ** 3;
    return { totalGB: memTotal / GB, usedGB: (memTotal - memAvail) / GB };
  } catch {
    return { totalGB: 0, usedGB: 0 };
  }
}

export async function GET() {
  const workerNodes = CLUSTER_NODES_CONFIG.filter((n) => n.role === 'worker');

  // 并发请求：JupyterHub 用户列表 + 各 worker 节点的容器统计和内存数据
  const [jupyterResult, ...workerResults] = await Promise.allSettled([
    fetch(JUPYTERHUB_CONFIG.apiUrl, {
      headers: { Authorization: `token ${JUPYTERHUB_CONFIG.token}` },
      cache: 'no-store',
    }).then((r) => r.json() as Promise<JupyterUser[]>),
    ...workerNodes.map(async (node) => ({
      ip: node.ip,
      stats: await fetchWorkerContainerStats(node.ip),
      memory: await fetchWorkerMemoryGB(node.ip),
    })),
  ]);

  const jupyterUsers: JupyterUser[] =
    jupyterResult.status === 'fulfilled' && Array.isArray(jupyterResult.value)
      ? jupyterResult.value
      : [];

  // 汇总所有 worker 节点的容器数据和内存数据
  const allContainerStats: ReturnType<typeof fetchWorkerContainerStats> extends Promise<infer T> ? T : never =
    [] as { name: string; cpuPercent: number; memUsageMiB: number; memLimitMiB: number; node: string }[];
  let workerMemTotalGB = 0;
  let workerMemUsedGB = 0;

  for (const result of workerResults) {
    if (result.status === 'fulfilled') {
      const { stats, memory } = result.value as {
        ip: string;
        stats: { name: string; cpuPercent: number; memUsageMiB: number; memLimitMiB: number; node: string }[];
        memory: { totalGB: number; usedGB: number };
      };
      allContainerStats.push(...stats);
      workerMemTotalGB += memory.totalGB;
      workerMemUsedGB += memory.usedGB;
    }
  }

  // 将 JupyterHub 用户与容器数据合并
  // 容器名格式 jupyter-{username}.{suffix}，用正则提取 username
  const users = jupyterUsers.map((u) => {
    const isRunning = u.servers && Object.keys(u.servers).length > 0;
    const container = allContainerStats.find((c) => {
      const match = c.name.match(/^jupyter-([^.]+)\./);
      return match?.[1] === u.name;
    });
    return {
      username: u.name,
      admin: u.admin,
      status: isRunning ? 'running' : 'stopped',
      containerName: container?.name ?? null,
      node: container?.node ?? null,
      cpuPercent: container?.cpuPercent ?? 0,
      memUsageMiB: container?.memUsageMiB ?? 0,
      memLimitMiB: container?.memLimitMiB ?? 0,
      lastActivity: u.last_activity,
    };
  });

  const runningUsers = users.filter((u) => u.status === 'running').length;

  return NextResponse.json({
    totalUsers: users.length,
    runningUsers,
    stoppedUsers: users.length - runningUsers,
    workerMemTotalGB: Math.round(workerMemTotalGB * 10) / 10,
    workerMemUsedGB: Math.round(workerMemUsedGB * 10) / 10,
    users,
  });
}
