---
name: jupyterhub-ops-stable
description: Stable 环境运维技能（Next.js + Docker Swarm + NFS），默认读取 `src/config/cluster_pro.ts` 配置（JupyterHub API URL/Token、节点列表等），basePath 为 `/ops`。
---

# JupyterHub Ops（Stable 环境）运维技能

## 1. 项目概述
- 同生产环境的功能范围：节点/容器统计、用户管理、Hub 文件日志检查、用户服务日志（`docker service logs`）
- 差异点主要在配置来源：Stable 默认使用 `cluster_pro.ts`

## 2. 部署路径（必须记住）
- 浏览器访问：`/ops`
- API 实际 URL：`/ops/api/...`
- 前端必须用 `buildApiUrl('/api/...')` 拼接

## 3. 配置文件（Stable）
Stable 环境默认读取：
- `src/config/cluster_pro.ts`
  - `CLUSTER_NODES_CONFIG`
  - `JUPYTERHUB_CONFIG.apiUrl` 与 `token`
  - `MANAGER_NODE`、`NFS_CONFIG`
- `src/config/service.ts`
  - `SSH_PORT`、日志目录与保留策略
  - `USER_SERVICE_LOGS`（用户服务日志 tail/搜索/分页边界）
- `src/config/dashboard.ts`

## 4. 鉴权与权限
- `POST /api/auth/login`：LDAP 校验 + 查询 JupyterHub 用户详情中的 `admin`
- Cookie：`jupyterhub_ops_session`
- 权限守卫：`src/lib/guard.ts`（`requireUser` / `requireAdmin`）

## 5. 运维 API 总览
（接口与生产环境相同）
- `GET /api/dashboard/cluster-nodes`
- `GET /api/dashboard/running-containers`
- `GET /api/dashboard/node-metrics`
- `GET /api/dashboard/user-stats`
- `POST /api/users/server`
- `POST /api/users/cleanup`
- `GET /api/logcheck/dates`
- `GET /api/logcheck?...`
- 用户服务日志：
  - Sheet 内浏览：`/api/users/service-logs?service=&tail=&until=`
  - Sheet 内搜索：`/api/users/service-logs/search?service=&q=`

## 6. Stable 常见排查点（比生产更容易出现）
1. 登录后 `isAdmin` 一直 false
   - 重点核对 Stable 使用的 `src/config/cluster_pro.ts` 中 `apiUrl/token`
2. 用户服务日志向上分页不向更早推进
   - 重点核对 `USER_SERVICE_LOGS.tailMax`
   - 重点核对向上分页使用的 Docker 兼容策略与时间戳解析

