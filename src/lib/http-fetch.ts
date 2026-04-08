/**
 * 用 Node 内置 http/https 发 GET，不依赖全局 fetch。
 * - 页面 / 浏览器仍用 `fetch` 调本站 API（见 `src/app/page.tsx`）。
 * - 服务端出站：原先多在 route 里写 `fetch(JUPYTERHUB_CONFIG.apiUrl, { Authorization: token … })`；
 *   与 Hub、Node Exporter 相关的逻辑请优先走本模块或 `jupyterhub-client`、`prometheus-node-metrics`，
 *   与 `scripts/collect-metrics` 保持一致，并兼容老 Node（无 fetch / 无 AbortSignal.timeout）。
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface HttpGetResult {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export function httpGet(
  urlStr: string,
  options: { timeoutMs: number; headers?: Record<string, string> }
): Promise<HttpGetResult> {
  const { timeoutMs, headers = {} } = options;
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`unsupported URL protocol: ${u.protocol}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      urlStr,
      {
        method: 'GET',
        headers: { ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const code = res.statusCode ?? 0;
          resolve({
            ok: code >= 200 && code < 300,
            status: code,
            statusText: res.statusMessage ?? '',
            text: async () => body,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms (${urlStr})`));
    });
    req.on('error', reject);
    req.end();
  });
}
