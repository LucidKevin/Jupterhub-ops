/**
 * 仪表盘侧配置：轮询周期、清理阈值、节点占位展示等。
 */

import { CLUSTER_NODES_CONFIG } from '@/config/cluster';

export const DASHBOARD_REFRESH_INTERVAL_MS = 10_000;
export const TOAST_HIDE_DELAY_MS = 3_000;

export const CLEANUP_THRESHOLD_OPTIONS = [3, 7, 15, 30] as const;
export type CleanupThreshold = (typeof CLEANUP_THRESHOLD_OPTIONS)[number];
export const DEFAULT_CLEANUP_THRESHOLD: CleanupThreshold = 7;

export interface DashboardNodePlaceholder {
  id: string;
  name: string;
  role: string;
  status: string;
  cpu: number;
  memory: number;
  disk: number;
  ip: string;
  containers: number;
  labels: string[];
}

export const DASHBOARD_NODE_PLACEHOLDERS: DashboardNodePlaceholder[] =
  CLUSTER_NODES_CONFIG.map((node, idx) => ({
    id: `node-${idx + 1}`,
    name: node.displayName,
    role: node.role === 'manager' ? 'Manager' : 'Worker',
    status: '加载中',
    cpu: 0,
    memory: 0,
    disk: 0,
    ip: node.ip,
    containers: 0,
    labels: node.labels,
  }));
