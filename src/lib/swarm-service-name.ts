/**
 * 从 docker stats 容器名推导 Swarm service 名（第一段，如 jupyter-user.1.xxx → jupyter-user）。
 * 若命名与栈前缀不一致，需在集群侧对齐或后续扩展配置。
 */
export function swarmServiceNameFromContainerName(containerName: string | null): string | null {
  if (!containerName || !containerName.startsWith('jupyter-')) return null;
  const segment = containerName.split('.')[0];
  if (!segment || !/^jupyter-[a-zA-Z0-9_-]+$/.test(segment)) return null;
  return segment;
}
