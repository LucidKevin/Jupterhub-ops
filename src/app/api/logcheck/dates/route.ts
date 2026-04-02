import { NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { SERVICE_LOG_DIR, SERVICE_LOG_RETENTION_DAYS, SERVICE_LOG_FILES } from '@/config/service';
import { requireAdmin } from '@/lib/guard';

function yyyymmddToIso(d: string) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function daysBetweenUtc(aIso: string, bIso: string) {
  const a = new Date(`${aIso}T00:00:00Z`).getTime();
  const b = new Date(`${bIso}T00:00:00Z`).getTime();
  return Math.floor((a - b) / (24 * 60 * 60 * 1000));
}

function todayIsoUtc() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function GET() {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  try {
    const names = await readdir(SERVICE_LOG_DIR).catch(() => []);
    const archived = names
      .map((name) => {
        const m = name.match(/^jupyterhub_(\d{8})\.log$/);
        if (!m) return null;
        const yyyymmdd = m[1];
        const iso = yyyymmddToIso(yyyymmdd);
        return { key: yyyymmdd, iso, filename: name };
      })
      .filter(Boolean) as { key: string; iso: string; filename: string }[];

    const todayIso = todayIsoUtc();
    const withinRetention = archived.filter((d) => {
      const diff = daysBetweenUtc(todayIso, d.iso);
      return diff >= 0 && diff <= SERVICE_LOG_RETENTION_DAYS;
    });

    withinRetention.sort((a, b) => (a.key < b.key ? 1 : -1));

    const options = [
      {
        key: 'today' as const,
        label: '今天',
        iso: todayIso,
        filename: SERVICE_LOG_FILES.jupyterhub,
      },
      ...withinRetention.slice(0, SERVICE_LOG_RETENTION_DAYS).map((d) => ({
        key: d.key,
        label: d.iso,
        iso: d.iso,
        filename: `${SERVICE_LOG_DIR}/${d.filename}`,
      })),
    ];

    return NextResponse.json({ retentionDays: SERVICE_LOG_RETENTION_DAYS, options });
  } catch (error) {
    return NextResponse.json(
      { error: '无法扫描日志目录', message: error instanceof Error ? error.message : 'unknown error' },
      { status: 500 }
    );
  }
}

