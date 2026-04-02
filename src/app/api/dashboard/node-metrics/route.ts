/**
 * GET /api/dashboard/node-metrics
 *
 * 从每个节点的 Node Exporter（默认端口 9100）抓取 Prometheus 格式指标，
 * 计算各节点的 CPU、内存、磁盘使用率，并返回所有节点的平均值。
 *
 * 节点列表从 src/config/cluster.ts 读取，无需在此文件中硬编码 IP。
 *
 * CPU 计算方式（需要两次抓取）：
 *   - 由于 node_cpu_seconds_total 是累计计数器，需要两次采样计算差值
 *   - cpuUsage = (1 - idleDelta / totalDelta) × 100
 *   - 两次采样间隔 1 秒
 *
 * 内存计算方式（单次抓取）：
 *   - memUsage = (1 - MemAvailable / MemTotal) × 100
 *
 * 磁盘计算方式（单次抓取，根分区）：
 *   - diskUsage = (1 - avail / size) × 100
 *   - 仅统计 mountpoint="/" 且非 tmpfs/devtmpfs 的文件系统
 *
 * 返回示例：
 * {
 *   avgCpu: 35,
 *   avgMemory: 62,
 *   nodes: [
 *     { ip: "10.9.123.228", hostname: "sz-glbd-jupterhub-123-228", cpuUsage: 40, memoryUsage: 70, diskUsage: 45 },
 *     { ip: "10.9.123.229", hostname: "sz-glbd-jupterhub-123-229", cpuUsage: 30, memoryUsage: 55, diskUsage: 48 },
 *     ...
 *   ]
 * }
 *
 * 注意：接口耗时约 1~2 秒（两次 Node Exporter 抓取 + 1s 等待）。
 *       若某节点不可达，该节点会被跳过，不影响其他节点返回。
 */
import { NextResponse } from 'next/server';
import { CLUSTER_NODES_CONFIG, NODE_EXPORTER_PORT } from '@/config/cluster';
import { API_TIMEOUT_MS } from '@/config/service';
import { requireAdmin } from '@/lib/guard';

/** Prometheus 文本格式中的单条指标记录 */
interface MetricEntry {
  labels: Record<string, string>;
  value: number;
}

/**
 * 解析 Prometheus 文本格式（exposition format）为结构化 Map。
 * 每个指标名称对应一组 { labels, value } 记录。
 *
 * 示例输入：
 *   node_cpu_seconds_total{cpu="0",mode="idle"} 12345.67
 *   node_memory_MemTotal_bytes 16769363968
 */
function parsePrometheusMetrics(text: string): Map<string, MetricEntry[]> {
  const result = new Map<string, MetricEntry[]>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // 跳过注释行（# HELP / # TYPE）和空行
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // 匹配格式：metric_name{label="val",...} value
    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.e+\-]+|NaN|Inf|-Inf)/
    );
    if (!match) continue;

    const metricName = match[1];
    const labelsStr = match[2] || '';
    const value = parseFloat(match[3]);

    // 解析标签键值对
    const labels: Record<string, string> = {};
    if (labelsStr) {
      for (const lm of labelsStr.slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)) {
        labels[lm[1]] = lm[2];
      }
    }

    if (!result.has(metricName)) result.set(metricName, []);
    result.get(metricName)!.push({ labels, value });
  }

  return result;
}

/**
 * 抓取指定节点的 Node Exporter 指标。
 * 超时 5 秒，失败返回 null（不抛异常，允许部分节点不可达）。
 */
async function fetchMetrics(ip: string): Promise<Map<string, MetricEntry[]> | null> {
  try {
    const res = await fetch(`http://${ip}:${NODE_EXPORTER_PORT}/metrics`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS.nodeMetrics),
    });
    if (!res.ok) return null;
    return parsePrometheusMetrics(await res.text());
  } catch {
    return null;
  }
}

/**
 * 从 node_cpu_seconds_total 指标中提取 idle 和 total 的累计秒数。
 * 用于两次采样之间计算差值，得到 CPU 使用率。
 */
function getCpuSeconds(metrics: Map<string, MetricEntry[]>) {
  const entries = metrics.get('node_cpu_seconds_total') || [];
  let idle = 0, total = 0;
  for (const e of entries) {
    total += e.value;
    if (e.labels.mode === 'idle') idle += e.value;
  }
  return { idle, total };
}

/**
 * 计算内存使用率（百分比）。
 * 公式：(1 - MemAvailable / MemTotal) × 100
 */
function getMemoryUsage(metrics: Map<string, MetricEntry[]>): number | null {
  const total = metrics.get('node_memory_MemTotal_bytes')?.[0]?.value;
  const avail = metrics.get('node_memory_MemAvailable_bytes')?.[0]?.value;
  if (!total || avail == null || total === 0) return null;
  return Math.round((1 - avail / total) * 100);
}

/**
 * 计算根分区磁盘使用率（百分比）。
 * 仅统计 mountpoint="/" 且非 tmpfs/devtmpfs 的文件系统。
 * 公式：(1 - avail / size) × 100
 */
function getDiskUsage(metrics: Map<string, MetricEntry[]>): number | null {
  const sizeEntries = metrics.get('node_filesystem_size_bytes') || [];
  const availEntries = metrics.get('node_filesystem_avail_bytes') || [];
  // 取根文件系统，排除 tmpfs/devtmpfs 等虚拟文件系统
  const rootSize = sizeEntries.find(
    (e) => e.labels.mountpoint === '/' && !['tmpfs', 'devtmpfs'].includes(e.labels.fstype)
  );
  const rootAvail = availEntries.find(
    (e) => e.labels.mountpoint === '/' && !['tmpfs', 'devtmpfs'].includes(e.labels.fstype)
  );
  if (!rootSize || !rootAvail || rootSize.value === 0) return null;
  return Math.round((1 - rootAvail.value / rootSize.value) * 100);
}

export async function GET() {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  try {
    // 从配置文件读取所有节点 IP，不在此处硬编码
    const ips = CLUSTER_NODES_CONFIG.map((n) => n.ip);

    // 第一次并发抓取所有节点指标
    const first = await Promise.all(ips.map(fetchMetrics));
    // 等待 1 秒，让 CPU 计数器产生足够的差值
    await new Promise((r) => setTimeout(r, 1000));
    // 第二次并发抓取，用于计算 CPU 使用率增量
    const second = await Promise.all(ips.map(fetchMetrics));

    const nodeMetrics = ips
      .map((ip, i) => {
        const f = first[i];
        const s = second[i];
        const config = CLUSTER_NODES_CONFIG.find((n) => n.ip === ip);
        // 两次抓取任一失败则跳过该节点
        if (!f || !s) return null;

        // CPU：用差值计算，避免累计计数器的影响
        const c1 = getCpuSeconds(f);
        const c2 = getCpuSeconds(s);
        const idleDelta = c2.idle - c1.idle;
        const totalDelta = c2.total - c1.total;
        const cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;

        return {
          ip,
          hostname: config?.hostname ?? '',
          cpuUsage,
          memoryUsage: getMemoryUsage(s),   // 内存：非累计，直接读当前值
          diskUsage: getDiskUsage(s),        // 磁盘：非累计，直接读当前值
        };
      })
      .filter(Boolean) as {
        ip: string;
        hostname: string;
        cpuUsage: number;
        memoryUsage: number | null;
        diskUsage: number | null;
      }[];

    if (nodeMetrics.length === 0) {
      return NextResponse.json({ error: 'No node metrics available' }, { status: 503 });
    }

    // 计算所有可达节点的平均 CPU
    const avgCpu = Math.round(
      nodeMetrics.reduce((a, n) => a + n.cpuUsage, 0) / nodeMetrics.length
    );
    // 计算有效内存数据的节点平均内存（排除 null）
    const memNodes = nodeMetrics.filter((n) => n.memoryUsage !== null);
    const avgMemory =
      memNodes.length > 0
        ? Math.round(memNodes.reduce((a, n) => a + (n.memoryUsage ?? 0), 0) / memNodes.length)
        : null;

    return NextResponse.json({ avgCpu, avgMemory, nodes: nodeMetrics });
  } catch (error) {
    console.error('Failed to get node metrics:', error);
    return NextResponse.json({ error: 'Failed to get node metrics' }, { status: 500 });
  }
}
