import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/guard';
import { queryNodeHistory } from '@/lib/metrics-sqlite';

export const runtime = 'nodejs';

function parseUnix(s: string | null): number | null {
  if (s == null || s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET ?ip=10.x&from=<unix>&to=<unix>
 * 缺省 from/to：最近 24 小时
 */
export async function GET(req: NextRequest) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;

  const ip = (req.nextUrl.searchParams.get('ip') || '').trim();
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return NextResponse.json({ error: '缺少或非法的 ip' }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  let fromTs = parseUnix(req.nextUrl.searchParams.get('from'));
  let toTs = parseUnix(req.nextUrl.searchParams.get('to'));
  if (toTs == null) toTs = now;
  if (fromTs == null) fromTs = toTs - 86400;
  if (fromTs > toTs) return NextResponse.json({ error: 'from 不能大于 to' }, { status: 400 });

  try {
    const points = await queryNodeHistory(ip, fromTs, toTs);
    return NextResponse.json({ ip, from: fromTs, to: toTs, points });
  } catch (e) {
    console.error('metrics history node', e);
    return NextResponse.json(
      { error: '读取指标库失败', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}
