/**
 * POST /api/users/cleanup
 *
 * 停止超过指定天数未活跃用户的 JupyterHub Server。
 *
 * 请求体：{ thresholdDays: 3 | 7 | 15 | 30, dryRun: boolean }
 *
 * dryRun=true：仅预览，返回会被影响的用户列表，不执行任何操作
 * dryRun=false：实际调用 DELETE /hub/api/users/{username}/server 停止 Server
 *
 * 筛选条件：
 *   - 用户 Server 正在运行（servers 字段非空）
 *   - last_activity 不为 null（为 null 表示新用户从未操作，跳过）
 *   - 距今天数 >= thresholdDays
 *
 * 返回示例：
 * {
 *   total: 2,
 *   affected: [
 *     { username: "user1", lastActivity: "2026-01-01T00:00:00Z", daysIdle: 62, admin: false }
 *   ],
 *   results: [          // dryRun=false 时才有
 *     { username: "user1", success: true, message: "已停止" }
 *   ]
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { JUPYTERHUB_CONFIG } from '@/config/cluster';

const ALLOWED_THRESHOLDS = [3, 7, 15, 30] as const;
type ThresholdDays = typeof ALLOWED_THRESHOLDS[number];

interface JupyterUser {
  name: string;
  last_activity: string | null;
  servers: Record<string, unknown>;
  admin: boolean;
}

/** 计算距今空闲天数，last_activity 为 null / 无效时返回 null */
function calcDaysIdle(lastActivity: string | null): number | null {
  if (!lastActivity) return null;
  try {
    const dt = new Date(lastActivity);
    return Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });

  const { thresholdDays, dryRun } = body as { thresholdDays: number; dryRun: boolean };

  if (!(ALLOWED_THRESHOLDS as readonly number[]).includes(thresholdDays)) {
    return NextResponse.json(
      { error: `thresholdDays 必须是 ${ALLOWED_THRESHOLDS.join(' / ')}` },
      { status: 400 }
    );
  }

  // 获取 JupyterHub 用户列表
  let users: JupyterUser[] = [];
  try {
    const res = await fetch(JUPYTERHUB_CONFIG.apiUrl, {
      headers: { Authorization: `token ${JUPYTERHUB_CONFIG.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!Array.isArray(data)) {
      return NextResponse.json({ error: '获取用户列表失败，JupyterHub 返回非数组响应' }, { status: 502 });
    }
    users = data;
  } catch {
    return NextResponse.json({ error: '无法连接 JupyterHub API' }, { status: 502 });
  }

  // 筛选：正在运行 + last_activity 已知 + 空闲天数 >= 阈值
  const affected = users
    .filter((u) => {
      const isRunning = u.servers && Object.keys(u.servers).length > 0;
      const idle = calcDaysIdle(u.last_activity);
      return isRunning && idle !== null && idle >= (thresholdDays as ThresholdDays);
    })
    .map((u) => ({
      username: u.name,
      lastActivity: u.last_activity,
      daysIdle: calcDaysIdle(u.last_activity)!,
      admin: u.admin,
    }));

  if (dryRun) {
    return NextResponse.json({ total: affected.length, affected, results: null });
  }

  // 执行停止：DELETE /hub/api/users/{username}/server
  const apiBase = JUPYTERHUB_CONFIG.apiUrl.replace(/\/users$/, '');
  const results = await Promise.all(
    affected.map(async ({ username }) => {
      try {
        const res = await fetch(`${apiBase}/users/${encodeURIComponent(username)}/server`, {
          method: 'DELETE',
          headers: { Authorization: `token ${JUPYTERHUB_CONFIG.token}` },
          signal: AbortSignal.timeout(10000),
        });
        const success = res.status === 204 || res.status === 202;
        return { username, success, message: success ? '已停止' : `失败 (HTTP ${res.status})` };
      } catch {
        return { username, success: false, message: '请求超时或网络错误' };
      }
    })
  );

  return NextResponse.json({ total: affected.length, affected, results });
}
