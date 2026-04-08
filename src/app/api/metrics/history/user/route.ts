import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/guard';
import { queryUserHistory } from '@/lib/metrics-sqlite';

export const runtime = 'nodejs';

function parseUnix(s: string | null): number | null {
  if (s == null || s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET ?username=xxx&from=<unix>&to=<unix>
 */
export async function GET(req: NextRequest) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;

  const username = (req.nextUrl.searchParams.get('username') || '').trim();
  if (!username || username.length > 256) {
    return NextResponse.json({ error: '缺少或非法的 username' }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  let fromTs = parseUnix(req.nextUrl.searchParams.get('from'));
  let toTs = parseUnix(req.nextUrl.searchParams.get('to'));
  if (toTs == null) toTs = now;
  if (fromTs == null) fromTs = toTs - 86400;
  if (fromTs > toTs) return NextResponse.json({ error: 'from 不能大于 to' }, { status: 400 });

  try {
    const points = await queryUserHistory(username, fromTs, toTs);
    return NextResponse.json({ username, from: fromTs, to: toTs, points });
  } catch (e) {
    console.error('metrics history user', e);
    return NextResponse.json(
      { error: '读取指标库失败', message: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    );
  }
}
