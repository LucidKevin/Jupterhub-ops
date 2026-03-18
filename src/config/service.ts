/**
 * 服务侧配置：脚本路径、配置文件路径、请求超时等。
 * 统一管理，避免在各个 route 中散落硬编码常量。
 */

export const SERVICE_MANAGE_SCRIPTS = {
  start: '/opt/jupyterhub/start.sh',
  stop: '/opt/jupyterhub/stop.sh',
  restart: '/opt/jupyterhub/restart.sh',
} as const;

export const SERVICE_MANAGE_WORKDIR = '/opt/jupyterhub';
export const SERVICE_MANAGE_EXEC_TIMEOUT_MS = 60_000;

export const SERVICE_CONFIG_FILES = {
  compose: '/opt/jupyterhub/docker-compose.yml',
  hubConfig: '/opt/jupyterhub/config/jupyterhub_config.py',
} as const;

export const SERVICE_LOG_FILES = {
  jupyterhub: '/opt/jupyterhub/logs/jupyterhub.log',
  logrotateConfig: '/etc/logrotate.d/jupyterhub',
} as const;

export const API_TIMEOUT_MS = {
  sshConnect: 5_000,
  userServerAction: 15_000,
  cleanupAction: 10_000,
  nodeMetrics: 5_000,
} as const;

export const SSH_PORT = 39000;
