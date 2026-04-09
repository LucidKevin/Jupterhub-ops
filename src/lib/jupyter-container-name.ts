/**
 * 兼容常见命名：
 * - jupyter-{username}.1.xxxxx
 * - jupyter-{username}
 * - <stack>-jupyter-{username}.1.xxxxx
 *
 * 返回 null 的场景：
 * - 未包含 `jupyter-` 前缀
 * - `jupyter-` 后用户名为空
 * - 用户名包含非法字符
 */
export function parseJupyterUsernameFromContainerName(name: string): string | null {
  const idx = name.indexOf('jupyter-');
  if (idx < 0) return null;
  const raw = name.slice(idx + 'jupyter-'.length).trim();
  if (!raw) return null;
  const username = raw.split('.')[0]?.trim() ?? '';
  if (!username || !/^[a-zA-Z0-9._-]+$/.test(username)) return null;
  return username;
}
