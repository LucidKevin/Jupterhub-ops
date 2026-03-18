import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { SERVICE_LOG_FILES } from '@/config/service';

type LogLevel = 'all' | 'INFO' | 'WARNING' | 'ERROR';

interface LogEntry {
  line: string;
  level: Exclude<LogLevel, 'all'> | 'INFO';
}

function detectLogLevel(line: string): LogEntry['level'] {
  if (line.includes('[ERROR]')) return 'ERROR';
  if (line.includes('[WARNING]')) return 'WARNING';
  return 'INFO';
}

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams;
  const level = (search.get('level') || 'all').toUpperCase() as LogLevel;
  const limit = Number(search.get('limit') || 200);
  const download = search.get('download') === '1';

  const allowedLevels: LogLevel[] = ['all', 'INFO', 'WARNING', 'ERROR'];
  const safeLevel = allowedLevels.includes(level) ? level : 'all';
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 200;

  try {
    const content = await readFile(SERVICE_LOG_FILES.jupyterhub, 'utf-8');
    const lines = content
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const filtered = lines.filter((line) => {
      if (safeLevel === 'all') return true;
      return line.includes(`[${safeLevel}]`);
    });

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
      source: SERVICE_LOG_FILES.jupyterhub,
      entries,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '无法读取日志文件',
        message: error instanceof Error ? error.message : 'unknown error',
        source: SERVICE_LOG_FILES.jupyterhub,
      },
      { status: 500 }
    );
  }
}
