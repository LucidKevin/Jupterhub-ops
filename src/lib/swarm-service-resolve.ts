/**
 * Swarm service 名称解析：
 * 将短名 `jupyter-xxx` 变为日志命令可用名称（必要时补 stack 前缀）。
 */
import { SWARM_STACK_NAME } from '@/config/service';

/**
 * 将短名 `jupyter-user` 解析为 `docker service logs` 可用的全名（含可选 stack 前缀）。
 */
export function resolveSwarmServiceNameForLogs(shortService: string): string {
  const s = shortService.trim();
  if (!s) return s;
  const stack = SWARM_STACK_NAME;
  if (
    stack &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(stack) &&
    s.startsWith('jupyter-') &&
    !s.startsWith(`${stack}_`)
  ) {
    return `${stack}_${s}`;
  }
  return s;
}
