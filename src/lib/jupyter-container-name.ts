/**
 * 兼容常见命名：
 * - jupyter-{username}.1.xxxxx
 * - jupyter-{username}
 * - <stack>-jupyter-{username}.1.xxxxx
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
