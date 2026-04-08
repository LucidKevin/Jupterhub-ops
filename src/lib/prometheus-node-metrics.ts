/**
 * 解析 Node Exporter Prometheus 文本并计算 CPU / 内存 / 磁盘占用（与 dashboard node-metrics API 口径一致）。
 */

import { httpGet } from './http-fetch';

export interface MetricEntry {
  labels: Record<string, string>;
  value: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parsePrometheusMetrics(text: string): Map<string, MetricEntry[]> {
  const result = new Map<string, MetricEntry[]>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.e+\-]+|NaN|Inf|-Inf)/
    );
    if (!match) continue;

    const metricName = match[1];
    const labelsStr = match[2] || '';
    const value = parseFloat(match[3]);

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

export function getCpuSeconds(metrics: Map<string, MetricEntry[]>) {
  const entries = metrics.get('node_cpu_seconds_total') || [];
  let idle = 0;
  let total = 0;
  for (const e of entries) {
    total += e.value;
    if (e.labels.mode === 'idle') idle += e.value;
  }
  return { idle, total };
}

export function getMemoryUsagePercent(metrics: Map<string, MetricEntry[]>): number | null {
  const memTotal = metrics.get('node_memory_MemTotal_bytes')?.[0]?.value;
  const avail = metrics.get('node_memory_MemAvailable_bytes')?.[0]?.value;
  if (!memTotal || avail == null || memTotal === 0) return null;
  return round2((1 - avail / memTotal) * 100);
}

export function getDiskUsagePercent(metrics: Map<string, MetricEntry[]>): number | null {
  const sizeEntries = metrics.get('node_filesystem_size_bytes') || [];
  const availEntries = metrics.get('node_filesystem_avail_bytes') || [];
  const rootSize = sizeEntries.find(
    (e) => e.labels.mountpoint === '/' && !['tmpfs', 'devtmpfs'].includes(e.labels.fstype)
  );
  const rootAvail = availEntries.find(
    (e) => e.labels.mountpoint === '/' && !['tmpfs', 'devtmpfs'].includes(e.labels.fstype)
  );
  if (!rootSize || !rootAvail || rootSize.value === 0) return null;
  return round2((1 - rootAvail.value / rootSize.value) * 100);
}

/** 两次采样间 CPU 使用率（0–100） */
export function cpuUsageFromDelta(
  first: Map<string, MetricEntry[]>,
  second: Map<string, MetricEntry[]>
): number {
  const c1 = getCpuSeconds(first);
  const c2 = getCpuSeconds(second);
  const idleDelta = c2.idle - c1.idle;
  const totalDelta = c2.total - c1.total;
  if (totalDelta <= 0) return 0;
  return round2((1 - idleDelta / totalDelta) * 100);
}

export function averageInts(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null && !Number.isNaN(v));
  if (nums.length === 0) return null;
  return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export interface FetchNodeExporterResult {
  metrics: Map<string, MetricEntry[]> | null;
  /** 首包失败原因，便于采集脚本打日志 */
  error: string | null;
}

export async function tryFetchNodeExporterMetrics(
  ip: string,
  port: number,
  timeoutMs: number
): Promise<FetchNodeExporterResult> {
  const url = `http://${ip}:${port}/metrics`;
  try {
    const res = await httpGet(url, { timeoutMs });
    if (!res.ok) {
      return { metrics: null, error: `HTTP ${res.status} ${res.statusText} (${url})` };
    }
    return { metrics: parsePrometheusMetrics(await res.text()), error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { metrics: null, error: `${msg} (${url})` };
  }
}

export async function fetchNodeExporterMetrics(
  ip: string,
  port: number,
  timeoutMs: number
): Promise<Map<string, MetricEntry[]> | null> {
  const r = await tryFetchNodeExporterMetrics(ip, port, timeoutMs);
  return r.metrics;
}
