/**
 * docker service logs 调用封装：
 * - 构建参数
 * - 执行命令并统一返回 stdout/stderr/code
 * - 对日志分页（since 近似 until）提供能力
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { USER_SERVICE_LOGS } from '@/config/service';
import {
  isoUntilBeforeLine,
  sortLogLinesAscending,
} from '@/lib/docker-log-line-utils';

const execFileAsync = promisify(execFile);

/** 输入 service 名白名单校验，避免命令注入风险。 */
export function assertValidSwarmServiceName(raw: string): string {
  const s = raw.trim();
  if (!s || s.length > 200) throw new Error('非法 service 名');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) throw new Error('非法 service 名');
  return s;
}

export { isoUntilBeforeLine, sortLogLinesAscending };

/** 组装 `docker service logs` 参数（兼容不支持 `--until` 的版本）。 */
function buildDockerArgs(options: {
  service: string;
  tail: number;
  untilIso?: string;
}): string[] {
  const args = [
    'service',
    'logs',
    '--no-trunc',
    '--timestamps',
    '--tail',
    String(options.tail),
  ];
  // 注意：你的 Docker 版本不支持 `docker service logs --until`。
  // 这里把 `untilIso` 当作“游标（更早边界）”，转换为 `--since <duration>` 的时间窗口近似：
  // - docker 只能做下界（since），无法做上界（until）
  // - 因此向上翻页：先用 `--since` 拉取“边界前 lookback 窗口”内的日志
  // - 真正把 >= untilIso 的行剔除，会在服务端做时间过滤
  if (options.untilIso) {
    const untilMs = Date.parse(options.untilIso);
    if (Number.isFinite(untilMs)) {
      const lookbackMs = USER_SERVICE_LOGS.browseUntilLookbackHours * 3600 * 1000;
      const sinceStartMs = Math.max(untilMs - lookbackMs, 0);
      const secondsRaw = Math.floor((Date.now() - sinceStartMs) / 1000);
      const seconds = Math.min(Math.max(secondsRaw, 1), 24 * 3600 * 180); // clamp：最多 180 天
      args.push('--since', `${seconds}s`);
    }
  }
  args.push(options.service);
  return args;
}

export async function runDockerServiceLogs(options: {
  service: string;
  tail: number;
  untilIso?: string;
  maxBuffer: number;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  // 普通浏览日志：tail + (可选) since 窗口
  const args = buildDockerArgs(options);
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      maxBuffer: options.maxBuffer,
      timeout: USER_SERVICE_LOGS.execTimeoutMs,
      encoding: 'utf8',
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export async function runDockerServiceLogsForSearch(options: {
  service: string;
  sinceHours: number;
  maxBuffer: number;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  // 搜索日志：固定 sinceHours 范围，不做 until 游标逻辑
  const sinceArg = `${Math.min(Math.max(options.sinceHours, 1), 24 * 90)}h`;
  const args = [
    'service',
    'logs',
    '--no-trunc',
    '--timestamps',
    '--since',
    sinceArg,
    options.service,
  ];
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      maxBuffer: options.maxBuffer,
      timeout: USER_SERVICE_LOGS.execTimeoutMs,
      encoding: 'utf8',
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}
