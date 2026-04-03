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

/** 新一条 JupyterHub 日志行以 [I/W/E 开头；续行（缩进 dict 等）归入上一条，避免按级别过滤时只剩半句 */
const JUPYTER_LOG_LINE_START = /^\[\s*[IWE]\b/;

function groupLinesIntoRecords(lines: string[]): string[] {
  const records: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const isStart = JUPYTER_LOG_LINE_START.test(line);
    if (isStart && buf.length > 0) {
      records.push(buf.join('\n'));
      buf = [line];
    } else if (isStart && buf.length === 0) {
      buf = [line];
    } else if (buf.length === 0) {
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) records.push(buf.join('\n'));
  return records;
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  const search = req.nextUrl.searchParams;
  const level = (search.get('level') || 'all').toUpperCase() as LogLevel;
  const limit = Number(search.get('limit') || 200);
  const download = search.get('download') === '1';
  const date = search.get('date') || 'today';
  const qRaw = (search.get('q') || '').trim();
  const q = qRaw.length > 200 ? qRaw.slice(0, 200) : qRaw;
  const qLower = q ? q.toLowerCase() : '';

  const allowedLevels: LogLevel[] = ['all', 'INFO', 'WARNING', 'ERROR'];
  const safeLevel = allowedLevels.includes(level) ? level : 'all';
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 2000) : 200;
  /** 有关键词时在整文件内匹配；为避免超大 JSON，命中条数超过此值时只返回文件末尾一段并标记截断 */
  const MAX_SEARCH_RESULTS = 10000;
  /** 带关键词下载时可包含更多条（仍防单响应过大） */
  const MAX_DOWNLOAD_SEARCH_RESULTS = 50000;

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

    const records = groupLinesIntoRecords(lines);

    const filtered = records.filter((rec) => {
      if (safeLevel !== 'all') {
        const first = rec.split('\n')[0] ?? rec;
        if (detectLogLevel(first) !== safeLevel) return false;
      }
      if (qLower && !rec.toLowerCase().includes(qLower)) return false;
      return true;
    });

    let sliced: string[];
    let searchTruncated = false;
    if (qLower) {
      if (filtered.length <= MAX_SEARCH_RESULTS) {
        sliced = filtered;
      } else {
        sliced = filtered.slice(filtered.length - MAX_SEARCH_RESULTS);
        searchTruncated = true;
      }
    } else {
      sliced = filtered.slice(Math.max(filtered.length - safeLimit, 0));
    }

    if (download) {
      const downloadRecords = qLower
        ? filtered.length <= MAX_DOWNLOAD_SEARCH_RESULTS
          ? filtered
          : filtered.slice(filtered.length - MAX_DOWNLOAD_SEARCH_RESULTS)
        : sliced;
      return new NextResponse(downloadRecords.join('\n\n'), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="jupyterhub-${safeLevel.toLowerCase()}-logs.txt"`,
        },
      });
    }

    const entries: LogEntry[] = sliced.map((rec) => {
      const first = rec.split('\n')[0] ?? rec;
      return {
        line: rec,
        level: detectLogLevel(first),
      };
    });

    return NextResponse.json({
      total: filtered.length,
      level: safeLevel,
      date,
      source: resolved,
      entries,
      ...(qLower
        ? {
            searchFullFile: true,
            searchMatchTotal: filtered.length,
            searchTruncated,
            searchResultCap: MAX_SEARCH_RESULTS,
          }
        : {}),
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
