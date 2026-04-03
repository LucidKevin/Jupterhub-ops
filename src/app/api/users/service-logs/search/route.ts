import { NextRequest, NextResponse } from 'next/server';
import { USER_SERVICE_LOGS } from '@/config/service';
import { requireAdmin } from '@/lib/guard';
import { mergeDockerCliLogStreams, sortLogLinesAscending } from '@/lib/docker-log-line-utils';
import { assertValidSwarmServiceName, runDockerServiceLogsForSearch } from '@/lib/docker-service-logs';
import { resolveSwarmServiceNameForLogs } from '@/lib/swarm-service-resolve';

function normalizeSearchQuery(raw: string): string | null {
  const q = raw.trim();
  if (q.length < 1 || q.length > 200) return null;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(q)) return null;
  return q;
}

/**
 * GET /api/users/service-logs/search?service=...&q=...
 * 在「最近 searchSinceHours 小时」内拉取日志后在进程内匹配（不将 q 拼进 shell）。
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

  const q = normalizeSearchQuery(sp.get('q') ?? '');
  if (!q) {
    return NextResponse.json({ error: '搜索关键词长度应为 1～200 且不含非法字符' }, { status: 400 });
  }

  const resolved = resolveSwarmServiceNameForLogs(service);

  const { stdout, stderr, code } = await runDockerServiceLogsForSearch({
    service: resolved,
    sinceHours: USER_SERVICE_LOGS.searchSinceHours,
    maxBuffer: USER_SERVICE_LOGS.searchMaxBytes,
  });

  if (code !== 0) {
    return NextResponse.json(
      {
        error: 'docker service logs 失败',
        detail: stderr.slice(0, 2000),
        resolvedService: resolved,
      },
      { status: 502 }
    );
  }

  const rawLines = mergeDockerCliLogStreams(stdout, stderr);

  const truncatedByDocker =
    stdout.length >= USER_SERVICE_LOGS.searchMaxBytes - 1024 || (code !== 0 && rawLines.length > 0);

  const sorted = sortLogLinesAscending(rawLines);
  const lower = q.toLowerCase();
  const matches = sorted.filter((line) => line.toLowerCase().includes(lower));

  return NextResponse.json({
    resolvedService: resolved,
    matches,
    matchCount: matches.length,
    scannedLineCount: sorted.length,
    truncated: truncatedByDocker,
    searchedWithinHours: USER_SERVICE_LOGS.searchSinceHours,
    stderrHint: stderr.trim() ? stderr.slice(0, 500) : undefined,
  });
}
