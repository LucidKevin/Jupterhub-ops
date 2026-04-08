/**
 * JupyterHub GET /hub/api/users（及同鉴权方式）。
 * 与 API 路由里原先的 fetch + token 头一致，但底层用 http/https，便于与 collect-metrics 共用，且兼容无全局 fetch 的 Node。
 */
import { httpGet } from './http-fetch';

export interface JupyterHubUserListItem {
  name: string;
  servers: Record<string, unknown>;
  admin: boolean;
  last_activity?: string | null;
}

export async function fetchJupyterHubUsers(options: {
  apiUrl: string;
  token: string;
  timeoutMs: number;
}): Promise<{ ok: true; users: JupyterHubUserListItem[] } | { ok: false; error: string }> {
  const { apiUrl, token, timeoutMs } = options;
  try {
    const res = await httpGet(apiUrl, {
      headers: { Authorization: `token ${token}` },
      timeoutMs,
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 240)}` };
    }
    const data = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(data)) {
      return { ok: false, error: 'JupyterHub 返回非数组' };
    }
    return { ok: true, users: data as JupyterHubUserListItem[] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
