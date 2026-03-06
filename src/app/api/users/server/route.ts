/**
 * POST /api/users/server
 *
 * 启动或停止指定用户的 JupyterHub Notebook Server。
 *
 * 请求体：{ action: 'start' | 'stop', username: string }
 *
 * start → POST   /hub/api/users/{username}/server  (201 或 202 = 成功)
 * stop  → DELETE /hub/api/users/{username}/server  (204 或 202 = 成功)
 */
import { NextRequest, NextResponse } from 'next/server';
import { JUPYTERHUB_CONFIG } from '@/config/cluster';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });

  const { action, username } = body as { action: string; username: string };

  if (!['start', 'stop'].includes(action) || !username) {
    return NextResponse.json({ error: 'action 必须是 start 或 stop，username 不能为空' }, { status: 400 });
  }

  const apiBase = JUPYTERHUB_CONFIG.apiUrl.replace(/\/users$/, '');
  const url = `${apiBase}/users/${encodeURIComponent(username)}/server`;

  try {
    const res = await fetch(url, {
      method: action === 'start' ? 'POST' : 'DELETE',
      headers: { Authorization: `token ${JUPYTERHUB_CONFIG.token}` },
      signal: AbortSignal.timeout(15000),
    });

    const success = [201, 202, 204].includes(res.status);
    return NextResponse.json({
      success,
      message: success
        ? action === 'start' ? '启动成功' : '停止成功'
        : `操作失败 (HTTP ${res.status})`,
    });
  } catch {
    return NextResponse.json({ success: false, message: '请求超时或网络错误' }, { status: 502 });
  }
}
