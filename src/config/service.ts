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

export const SERVICE_LOG_DIR = '/opt/jupyterhub/logs';
export const SERVICE_LOG_RETENTION_DAYS = 15;

export const API_TIMEOUT_MS = {
  sshConnect: 5_000,
  userServerAction: 15_000,
  cleanupAction: 10_000,
  nodeMetrics: 5_000,
} as const;

export const SSH_PORT = 39000;

/**
 * Swarm stack 名（与 `docker stack deploy <name>` 一致）。
 * 用户 notebook 服务全名多为 `${SWARM_STACK_NAME}_jupyter-用户名`；不设则按短名 `jupyter-xxx` 请求。
 * 仅在服务端 API 中读取（勿依赖客户端 bundle）。
 */
export const SWARM_STACK_NAME = (process.env.JUPYTERHUB_OPS_SWARM_STACK ?? '').trim();

/** 用户 Swarm 服务日志（docker service logs）：浏览分页与搜索边界 */
export const USER_SERVICE_LOGS = {
  /** 首次 / 每页 tail 行数 */
  tailDefault: 150,
  /**
   * 向上翻页需要额外“冗余”行数来抵消 docker service logs 的缺陷：
   * - 它没有上界（--until）能力，只能 --since 下界
   * - 因此在 until 边界附近，可能有大量更“新”的日志挤掉更“早”的日志
   * 增大 tailMax 能显著提升向上分页命中率。
   */
  tailMax: 2000,
  execTimeoutMs: 45_000,
  /** 搜索：仅检索最近 N 小时内的日志（全量可检索范围，UI 需同步说明） */
  searchSinceHours: 168,
  /** 搜索单次拉取 stdout 上限，防止占满内存 */
  searchMaxBytes: 8 * 1024 * 1024,
  /** 前端「加载更早」最多请求次数，避免无限翻页压垮 manager */
  browseMaxOlderRequests: 60,

  /**
   * 由于你们的 Docker 版本不支持 `docker service logs --until`，
   * 向上翻页会在服务端用 `--since` 拉取一个“边界前”时间窗口，
   * 然后在 Node 里按行首时间戳过滤 `<= until` 的日志。
   *
   * 该窗口越大，越容易包含足够多的更早日志，但输出也可能更大。
   */
  browseUntilLookbackHours: 24,
} as const;
