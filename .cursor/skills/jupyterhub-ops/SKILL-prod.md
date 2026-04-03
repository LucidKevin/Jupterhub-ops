---
name: jupyterhub-ops-prod
description: 生产环境运维技能（Next.js + Docker Swarm + NFS），默认读取 `src/config/cluster.ts` 配置（JupyterHub API URL/Token、节点列表等），basePath 为 `/ops`。
---

# JupyterHub Ops（生产环境）运维技能

## 1. 项目概述
- 技术栈：Next.js App Router / React / TypeScript / Tailwind
- 主要能力：节点与容器统计、用户管理（启停/清理）、日志检查（Hub 文件日志）、以及用户服务日志（`docker service logs`）

## 2. 部署路径（必须记住）
- 浏览器访问：`/ops`
- API 实际 URL：`/ops/api/...`
- 前端必须用 `buildApiUrl('/api/...')` 拼接，避免漏 `/ops`
- 修改 `next.config.js` 后需要重新 build 并重启

## 3. 配置文件（生产）
生产环境默认读取：
- `src/config/cluster.ts`
  - `CLUSTER_NODES_CONFIG`
  - `JUPYTERHUB_CONFIG.apiUrl` 与 `token`
  - `MANAGER_NODE`、`NFS_CONFIG`
- `src/config/service.ts`
  - `SSH_PORT`、各种超时
  - `SERVICE_LOG_FILES` / `SERVICE_LOG_DIR` / `SERVICE_LOG_RETENTION_DAYS`
  - `USER_SERVICE_LOGS`（用户服务日志 tail/搜索/分页边界）
- `src/config/dashboard.ts`（页面展示与阈值）

## 4. 鉴权与权限
- `POST /api/auth/login`：LDAP 校验 + 查询 JupyterHub 用户详情中的 `admin` 字段
- 登录后 Cookie：`jupyterhub_ops_session`
- `src/lib/guard.ts`：
  - `requireUser()`：校验 session token 与有效期
  - `requireAdmin()`：基于 `session.isAdmin`

## 5. 运维 API 总览（按模块）
### 5.1 节点与容器统计
- `GET /api/dashboard/cluster-nodes`：`docker node ls` + Docker ps（manager/worker 分别处理）
- `GET /api/dashboard/running-containers`：拉 JupyterHub users，统计 `servers` 非空的用户数
- `GET /api/dashboard/node-metrics`：Node Exporter（9100）抓 Prometheus 指标，计算 CPU/内存/磁盘使用率
- `GET /api/dashboard/user-stats`：聚合
  1) JupyterHub users（status / admin / last_activity）
  2) worker 上 `docker stats`（容器 CPU/Mem）
  3) worker 的 Node Exporter（内存汇总）

### 5.2 用户管理
- `POST /api/users/server`：启停用户 server（start/stop）
- `POST /api/users/cleanup`：闲置清理（dryRun/execute）

### 5.3 日志检查（Hub 宿主机文件）
- `GET /api/logcheck/dates`：扫描日志目录，列出可选日期
- `GET /api/logcheck?date=...&level=...&limit=...`
  - `level`：`all|INFO|WARNING|ERROR`
  - 检测：`[E] / ERROR` -> ERROR；`[W] / WARNING` -> WARNING；其他 -> INFO

### 5.4 用户服务日志（Swarm）
在用户列表表格里点击「日志」打开 Sheet，展示：
- 浏览（向上滚动加载更早）：`GET /api/users/service-logs?service=&tail=&until=`
- 搜索（关键词全量范围内检索）：`GET /api/users/service-logs/search?service=&q=`

注意：
- Docker 可能不支持 `docker service logs --until`，所以向上分页使用兼容策略（`--since` + Node 过滤时间戳）
- 日志级别筛选在 Sheet 内按行内 `[I]/[W]/[E]` 识别并上色

## 6. 常见问题排查
1. API 404/401/500
   - 检查 `basePath: /ops` 与 `buildApiUrl`
   - 检查 cookie 是否存在（`/api/auth/me`）
2. isAdmin 一直 false
   - 检查 `src/config/cluster.ts` 的 JupyterHub API URL/token
   - 以及登录时查询到的用户 JSON 是否真的包含 `admin: true`
3. 用户服务日志翻页到顶不往更早推进
   - 重点检查 `USER_SERVICE_LOGS.tailMax`、向上分页兼容策略与时间戳解析

