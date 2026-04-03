import { NextRequest, NextResponse } from 'next/server';
import { USER_SERVICE_LOGS } from '@/config/service';
import { requireAdmin } from '@/lib/guard';
import { mergeDockerCliLogStreams, parseDockerServiceLogLineTimeMs } from '@/lib/docker-log-line-utils';
import {
  assertValidSwarmServiceName,
  isoUntilBeforeLine,
  runDockerServiceLogs,
  sortLogLinesAscending,
} from '@/lib/docker-service-logs';
import { resolveSwarmServiceNameForLogs } from '@/lib/swarm-service-resolve';

// 向上分页需要把更大的 docker 输出缓冲到 stdout/stderr 合并后再做时间过滤
const BROWSE_MAX_BUFFER = 12 * 1024 * 1024;

/**
 * GET /api/users/service-logs?service=...&tail=150&until=ISO8601
 * - 首次不传 until：最近 tail 行
 * - 传 until：该时间点之前的最近 tail 行（用于向上滚动加载更早）
 */
export async function GET(req: NextRequest) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;

  const sp = req.nextUrl.searchParams;
  let service: string;
  try {
    service = assertValidSwarmServiceName(sp.get('service') ?? '');
  } catch {
    return NextResponse.json({ error: '非法 service 参数' }, { status: 400 });
  }

  const tailRaw = Number(sp.get('tail') ?? USER_SERVICE_LOGS.tailDefault);
  const tail = Number.isFinite(tailRaw)
    ? Math.min(Math.max(Math.floor(tailRaw), 1), USER_SERVICE_LOGS.tailMax)
    : USER_SERVICE_LOGS.tailDefault;

  const untilParam = sp.get('until')?.trim();
  let untilIso: string | undefined;
  if (untilParam) {
    const parsed = Date.parse(untilParam);
    if (!Number.isFinite(parsed)) {
      return NextResponse.json({ error: '非法 until 时间参数' }, { status: 400 });
    }
    untilIso = new Date(parsed).toISOString();
  }

  const resolved = resolveSwarmServiceNameForLogs(service);

  const dockerTail = untilIso ? USER_SERVICE_LOGS.tailMax : tail;
  const { stdout, stderr, code } = await runDockerServiceLogs({
    service: resolved,
    tail: dockerTail,
    untilIso,
    maxBuffer: BROWSE_MAX_BUFFER,
  });

  const rawLines = mergeDockerCliLogStreams(stdout, stderr);
  const fatalDocker =
    /no such service|not a swarm manager|cannot connect to the docker daemon/i.test(stderr);

  /** 翻更早一页时 Docker 常对「已无更早」返回非 0 或空输出，不应当作全局失败 */
  if (code !== 0) {
    if (fatalDocker) {
      return NextResponse.json(
        {
          error: 'docker service logs 失败',
          detail: stderr.slice(0, 2000),
          resolvedService: resolved,
        },
        { status: 502 }
      );
    }
    if (untilIso && rawLines.length === 0) {
      return NextResponse.json({
        resolvedService: resolved,
        lines: [],
        hasMoreOlder: false,
        nextOlderUntil: null,
        endOfHistory: true,
      });
    }
  }

  const lines = sortLogLinesAscending(rawLines);

  if (untilIso) {
    const untilMs = Date.parse(untilIso);
    if (!Number.isFinite(untilMs)) {
      return NextResponse.json({
        resolvedService: resolved,
        lines: [],
        hasMoreOlder: false,
        nextOlderUntil: null,
      });
    }

    // 过滤出 <= untilIso 的更早日志，再取“最接近边界”的那 tail 行
    const olderLines = lines.filter((line) => {
      const t = parseDockerServiceLogLineTimeMs(line);
      if (!Number.isFinite(t) || t === 0) return false;
      return t <= untilMs;
    });

    const pageLines = olderLines.slice(Math.max(olderLines.length - tail, 0));
    const nextOlderUntil = pageLines.length > 0 ? isoUntilBeforeLine(pageLines[0]) : null;
    const hasMoreOlder = olderLines.length > tail && nextOlderUntil != null;

    return NextResponse.json({
      resolvedService: resolved,
      lines: pageLines,
      hasMoreOlder,
      /** 下一页请求请原样传入 GET 参数 until= */
      nextOlderUntil,
      stderrHint: stderr.trim() ? stderr.slice(0, 500) : undefined,
    });
  }

  const nextOlderUntil = lines.length > 0 ? isoUntilBeforeLine(lines[0]) : null;
  const hasMoreOlder = lines.length >= tail && nextOlderUntil != null;

  return NextResponse.json({
    resolvedService: resolved,
    lines,
    hasMoreOlder,
    /** 下一页请求请原样传入 GET 参数 until= */
    nextOlderUntil,
    stderrHint: stderr.trim() ? stderr.slice(0, 500) : undefined,
  });
}
