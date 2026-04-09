/**
 * 仅服务端 / 采集脚本使用（勿从 client 组件引用，避免打入 path 等 Node 模块）。
 */
import fs from 'fs';
import path from 'path';

function pickDefaultMetricsPath(): string {
  // 优先使用显式环境变量，避免任何歧义。
  const envPath = (process.env.METRICS_SQLITE_PATH ?? '').trim();
  if (envPath) return envPath;

  // 无 env 时，兼容不同启动方式（cron 常写 /opt/jupyterhub/data/metrics.db，
  // Web 进程常按 process.cwd()/data/metrics.db 读取），自动选择“已存在且最新”的库。
  const candidates = [
    path.join(process.cwd(), 'data', 'metrics.db'),
    '/opt/jupyterhub/data/metrics.db',
  ];

  let best = candidates[0]!;
  let bestMtime = -1;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.mtimeMs > bestMtime) {
        best = p;
        bestMtime = st.mtimeMs;
      }
    } catch {
      // ignore missing candidate
    }
  }
  return best;
}

export const METRICS_SQLITE_PATH = pickDefaultMetricsPath();

export const METRICS_RETENTION_DAYS = Math.min(
  365,
  Math.max(1, parseInt(process.env.METRICS_RETENTION_DAYS || '7', 10) || 7)
);
