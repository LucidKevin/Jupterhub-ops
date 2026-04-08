/**
 * 仅服务端 / 采集脚本使用（勿从 client 组件引用，避免打入 path 等 Node 模块）。
 */
import path from 'path';

export const METRICS_SQLITE_PATH =
  (process.env.METRICS_SQLITE_PATH ?? '').trim() || path.join(process.cwd(), 'data', 'metrics.db');

export const METRICS_RETENTION_DAYS = Math.min(
  365,
  Math.max(1, parseInt(process.env.METRICS_RETENTION_DAYS || '7', 10) || 7)
);
