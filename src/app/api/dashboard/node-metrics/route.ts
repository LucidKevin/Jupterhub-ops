/**
 * GET /api/dashboard/node-metrics
 *
 * 从每个节点的 Node Exporter（默认端口 9100）抓取 Prometheus 格式指标，
 * 计算各节点的 CPU、内存、磁盘使用率，并返回所有节点的平均值。
 */
import { NextResponse } from 'next/server';
import { CLUSTER_NODES_CONFIG, NODE_EXPORTER_PORT } from '@/config/cluster';
import { API_TIMEOUT_MS } from '@/config/service';
import { requireAdmin } from '@/lib/guard';
import {
  cpuUsageFromDelta,
  fetchNodeExporterMetrics,
  getDiskUsagePercent,
  getMemoryUsagePercent,
} from '@/lib/prometheus-node-metrics';

export async function GET() {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  try {
    const ips = CLUSTER_NODES_CONFIG.map((n) => n.ip);

    const first = await Promise.all(
      ips.map((ip) => fetchNodeExporterMetrics(ip, NODE_EXPORTER_PORT, API_TIMEOUT_MS.nodeMetrics))
    );
    await new Promise((r) => setTimeout(r, 1000));
    const second = await Promise.all(
      ips.map((ip) => fetchNodeExporterMetrics(ip, NODE_EXPORTER_PORT, API_TIMEOUT_MS.nodeMetrics))
    );

    const nodeMetrics = ips
      .map((ip, i) => {
        const f = first[i];
        const s = second[i];
        const config = CLUSTER_NODES_CONFIG.find((n) => n.ip === ip);
        if (!f || !s) return null;

        const cpuUsage = cpuUsageFromDelta(f, s);

        return {
          ip,
          hostname: config?.hostname ?? '',
          cpuUsage,
          memoryUsage: getMemoryUsagePercent(s),
          diskUsage: getDiskUsagePercent(s),
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

    const avgCpu =
      Math.round((nodeMetrics.reduce((a, n) => a + n.cpuUsage, 0) / nodeMetrics.length) * 100) / 100;
    const memNodes = nodeMetrics.filter((n) => n.memoryUsage !== null);
    const avgMemory =
      memNodes.length > 0
        ? Math.round((memNodes.reduce((a, n) => a + (n.memoryUsage ?? 0), 0) / memNodes.length) * 100) /
          100
        : null;

    return NextResponse.json({ avgCpu, avgMemory, nodes: nodeMetrics });
  } catch (error) {
    console.error('Failed to get node metrics:', error);
    return NextResponse.json({ error: 'Failed to get node metrics' }, { status: 500 });
  }
}
