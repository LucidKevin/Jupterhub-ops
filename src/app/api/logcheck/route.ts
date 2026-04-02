import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { SERVICE_LOG_DIR, SERVICE_LOG_FILES } from '@/config/service';
import { requireAdmin } from '@/lib/guard';

type LogLevel = 'all' | 'INFO' | 'WARNING' | 'ERROR';

interface LogEntry {
  line: string;
  level: Exclude<LogLevel, 'all'> | 'INFO';
}

function detectLogLevel(line: string): LogEntry['level'] {
  const upperLine = line.toUpperCase();
  // JupyterHub 常见格式: [E 2026-...], [W 2026-...], [I 2026-...]
  if (/^\[\s*E\b/.test(upperLine)) return 'ERROR';
  if (/^\[\s*W\b/.test(upperLine)) return 'WARNING';
  if (/\bERROR\b|\bERR\b|\[ERROR\]/.test(upperLine)) return 'ERROR';
  if (/\bWARNING\b|\bWARN\b|\[WARNING\]|\[WARN\]/.test(upperLine)) return 'WARNING';
  return 'INFO';
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  const search = req.nextUrl.searchParams;
  const level = (search.get('level') || 'all').toUpperCase() as LogLevel;
  const limit = Number(search.get('limit') || 200);
  const download = search.get('download') === '1';
  const date = search.get('date') || 'today';

  const allowedLevels: LogLevel[] = ['all', 'INFO', 'WARNING', 'ERROR'];
  const safeLevel = allowedLevels.includes(level) ? level : 'all';
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 200;

  try {
    let filePath: string;
    if (date === 'today') {
      filePath = SERVICE_LOG_FILES.jupyterhub;
    } else if (/^\d{8}$/.test(date)) {
      filePath = path.join(SERVICE_LOG_DIR, `jupyterhub_${date}.log`);
    } else {
      return NextResponse.json({ error: 'date 参数非法' }, { status: 400 });
    }

    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(SERVICE_LOG_DIR);
    if (date !== 'today' && !resolved.startsWith(`${resolvedDir}${path.sep}`)) {
      return NextResponse.json({ error: '日志路径非法' }, { status: 400 });
    }

    const content = await readFile(resolved, 'utf-8');
    const lines = content
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const filtered = lines.filter((line) =>
      safeLevel === 'all' ? true : detectLogLevel(line) === safeLevel
    );

    const sliced = filtered.slice(Math.max(filtered.length - safeLimit, 0));

    if (download) {
      return new NextResponse(sliced.join('\n'), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="jupyterhub-${safeLevel.toLowerCase()}-logs.txt"`,
        },
      });
    }

    const entries: LogEntry[] = sliced.map((line) => ({
      line,
      level: detectLogLevel(line),
    }));

    return NextResponse.json({
      total: filtered.length,
      level: safeLevel,
      date,
      source: resolved,
      entries,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '无法读取日志文件',
        message: error instanceof Error ? error.message : 'unknown error',
        date,
        source: SERVICE_LOG_FILES.jupyterhub,
      },
      { status: 500 }
    );
  }
}
