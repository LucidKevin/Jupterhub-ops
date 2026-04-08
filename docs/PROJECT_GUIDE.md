# JupyterHub Ops 项目使用与运维手册

本文档用于覆盖当前项目的完整使用方式与运维流程，面向：

- 日常使用平台的运维/管理员
- 负责部署、发布、巡检的工程师
- 接手项目的开发同学

---

## 1. 项目概述

`jupyterhub-ops` 是一个面向 JupyterHub + Docker Swarm 集群的可视化运维平台，核心能力：

- 集群节点资源监控（CPU/内存/磁盘）
- 用户容器状态、资源占用、启停管理
- 趋势指标采集（本地 SQLite 历史库）
- 服务管理（重启 JupyterHub、查看核心配置）
- `jupyterhub_config.py` 组织 DN 列表可视化增删
- 日志查看、资源预警、NFS 相关运维展示

---

## 2. 技术架构

### 2.1 技术栈

- 前端/服务端：Next.js 13 + React + TypeScript
- 样式：Tailwind CSS
- 图表：Recharts
- 指标历史存储：`sql.js`（SQLite WASM，文件落盘）
- 外部依赖：
  - JupyterHub API
  - Node Exporter
  - Docker CLI（通过 SSH 到 worker 执行）

### 2.2 主要模块

- 页面入口：`src/app/page.tsx`
- 指标趋势弹窗：`src/components/metrics-trend-sheet.tsx`
- 指标采集脚本：
  - `scripts/collect-metrics.sh`（cron 入口）
  - `scripts/collect-metrics.ts`（采集逻辑）
- 指标库读写：
  - `src/lib/metrics-sqlite.ts`
  - `src/config/metrics-store.ts`
- 服务管理 API：
  - `src/app/api/servicemanage/action/route.ts`
  - `src/app/api/servicemanage/config/route.ts`

---

## 3. 目录与关键文件

```text
src/
  app/
    page.tsx                             # 主页面（各 tab、服务管理、组织增删）
    api/
      dashboard/                         # dashboard 相关 API
      metrics/history/{node,user}/       # 趋势历史查询 API
      servicemanage/{action,config}/     # 服务管理 API
  components/
    metrics-trend-sheet.tsx              # 趋势弹窗
  config/
    cluster.ts                           # 集群节点、JupyterHub API 配置
    service.ts                           # 服务脚本路径、超时、SSH 端口等
    metrics-store.ts                     # SQLite 路径与保留天数
  lib/
    metrics-sqlite.ts                    # SQLite schema、查询/写入
    prometheus-node-metrics.ts           # Prometheus 解析和口径计算

scripts/
  collect-metrics.sh                     # cron 执行入口
  collect-metrics.ts                     # 指标采集主逻辑
  collect-metrics.cjs                    # esbuild 产物（可选）
```

---

## 4. 环境准备

## 4.1 运行要求

- Node.js（建议 >=18；脚本已做兼容，但推荐统一新版本）
- pnpm 8+
- 服务器具备以下访问能力：
  - 可访问 JupyterHub API
  - 可访问各节点 `:9100/metrics`
  - 可 SSH 到 worker 执行 `docker stats`

### 4.2 安装依赖

```bash
pnpm install
```

### 4.3 构建与启动

```bash
# 开发
pnpm dev

# 生产
pnpm build
pnpm start
```

---

## 5. 配置说明

## 5.1 集群与 Hub

文件：`src/config/cluster.ts`

- `CLUSTER_NODES_CONFIG`：节点清单（ip/hostname/role）
- `JUPYTERHUB_CONFIG.apiUrl`：如 `http://x.x.x.x:8002/jupyterhub/hub/api/users`
- `JUPYTERHUB_CONFIG.token`：Hub API token
- `NODE_EXPORTER_PORT`：默认 `9100`

## 5.2 服务管理

文件：`src/config/service.ts`

- `SERVICE_MANAGE_SCRIPTS.start/stop/restart`：脚本路径
- `SERVICE_MANAGE_WORKDIR`：执行目录
- `API_TIMEOUT_MS`：请求超时
- `SSH_PORT`：worker SSH 端口

## 5.3 指标存储

文件：`src/config/metrics-store.ts`

- `METRICS_SQLITE_PATH`
  - 默认：`<cwd>/data/metrics.db`
  - 可由环境变量覆盖
- `METRICS_RETENTION_DAYS`
  - 默认：`7`
  - 范围：`1~365`

---

## 6. 指标采集链路（重点）

### 6.1 执行频率

建议 crontab（每分钟）：

```bash
* * * * * cd /opt/jupyterhub-ops && METRICS_SQLITE_PATH=/opt/jupyterhub/data/metrics.db ./scripts/collect-metrics.sh >> /var/log/jupyterhub-ops-metrics.log 2>&1
```

### 6.2 采样策略

当前脚本参数（`scripts/collect-metrics.ts`）：

- `SAMPLE_COUNT = 15`
- `SLEEP_SEC = 3`
- 单次数据点约覆盖 45 秒窗口（严格说 14 个间隔 * 3s ≈ 42s）

### 6.3 数据来源

1. Node Exporter：节点 CPU/内存/磁盘
2. JupyterHub API：用户列表与运行状态
3. SSH + `docker stats`：用户容器 CPU 与内存占用

### 6.4 写入表

- `node_metric_points`
  - `ts, node_ip, cpu_pct, mem_pct, disk_pct`
- `user_metric_points`
  - `ts, username, cpu_pct, mem_usage_mib, mem_limit_mib, node_ip`

### 6.5 数据清理

每次采集完成后自动执行按天数清理：

- `DELETE FROM ... WHERE ts < now - retention_days * 86400`

---

## 7. 服务管理与配置编辑

## 7.1 服务重启

页面服务管理 tab 目前仅开放“重启服务”。

- 前端调用：`POST /api/servicemanage/action`
- 入参：`{ action: "restart" }`
- 服务端执行：`bash /opt/jupyterhub/restart.sh`

## 7.2 配置文件读取/写入

- 读取：`GET /api/servicemanage/config`
- 写入：`PUT /api/servicemanage/config`

写入时会统一行尾为 LF，避免 Linux 出现 `^M`。

---

## 8. 组织 DN 管理（jupyterhub_config.py）

## 8.1 目标

在 `jupyterhub_config.py` 的 `CN={username},...` DN 模板列表中新增/删除组织条目。

示例目标条目：

```python
"CN={username},OU=反欺诈组,OU=通用风险中心,OU=R线,OU=乐信,DC=lexinfintech,DC=com"
```

### 8.2 新增逻辑

- UI 输入组织层级（默认仅“乐信”）
- 转换为 OU 链（反序）
- 自动补完整 DN 前缀/后缀：
  - `CN={username}`
  - `DC=lexinfintech,DC=com`（从现有模板提取，异常时兜底）
- 插入到 DN 列表尾部
- 自动规整逗号，避免 Python 列表语法错误

### 8.3 删除逻辑

- “已新增组织（可删除）”列表中点击删除
- 二次确认后执行
- 从 DN 模板列表删除对应项并保存

### 8.4 注意事项

- 该功能现在是修改真实配置条目（不是只加注释）
- 修改后通常需要重启 JupyterHub 服务生效

---

## 9. 页面使用说明（管理员）

## 9.1 用户管理

- 查看运行用户、节点归属、CPU、内存占用
- 支持用户服务启停
- 支持趋势查看（CPU 与内存分图）
- 支持按阈值筛选闲置用户并清理

## 9.2 节点管理

- 查看各节点 CPU/内存/磁盘
- 趋势图已拆分为三张：
  - CPU
  - 内存
  - 磁盘
- 浮点显示统一 1 位小数

## 9.3 趋势窗口

- 时间范围：1h / 3h / 6h / 1d / 3d
- 数据来自 SQLite 历史库，不是实时 API

---

## 10. 常见故障与排查

## 10.1 `fetch is not defined`

原因：服务器 Node 太老 + 运行时使用了全局 fetch。  
当前项目已规避：采集链路使用 Node `http/https` 包装，不依赖全局 fetch。

## 10.2 `^M` 出现在配置文件

原因：CRLF 行尾。  
解决：保存接口已统一转 LF；历史文件可执行：

```bash
sed -i 's/\r$//' /opt/jupyterhub/config/jupyterhub_config.py
```

## 10.3 指标库为空

排查顺序：

1. `METRICS_SQLITE_PATH` 是否和 Next 读取路径一致
2. cron 是否真的执行（看日志文件）
3. 采集日志是否有 `done`，是否大量 `unreachable`
4. 采集机到 Node Exporter/JupyterHub/SSH 是否可达

## 10.4 `TransformError` / esbuild 相关

建议使用 bundle 执行：

```bash
pnpm run build:collect-metrics
./scripts/collect-metrics.sh
```

---

## 11. 运维SOP（建议）

## 11.1 日常巡检（每天）

- 检查 cron 日志是否持续有新点位
- 抽查趋势图是否更新
- 检查服务管理是否可正常重启
- 检查数据库文件大小是否异常增长

## 11.2 发布流程（建议）

1. 拉代码
2. `pnpm install`
3. `pnpm build`
4. `pnpm run build:collect-metrics`
5. 替换服务并重启 Next
6. 验证页面与采集日志

## 11.3 回滚策略

- 应用回滚：回到上个版本并重启
- 配置回滚：恢复 `jupyterhub_config.py` 备份
- 指标库回滚：替换 `metrics.db` 备份文件

---

## 12. 数据清理与备份

## 12.1 清空历史数据

方式一：删库文件（会自动重建）

```bash
rm -f /opt/jupyterhub/data/metrics.db
```

方式二：SQL 删除两表数据

```sql
DELETE FROM node_metric_points;
DELETE FROM user_metric_points;
```

## 12.2 调整保留天数

设置环境变量后重启采集：

```bash
export METRICS_RETENTION_DAYS=7
```

---

## 13. 安全建议

- JupyterHub token 不要写死在仓库，建议改为环境变量注入
- 配置写入接口仅管理员可访问（项目已做 admin guard）
- 对“删除组织/重启服务”建议保留审计日志
- 生产环境建议关闭不必要的调试输出

---

## 14. 后续可优化项

- 增加“组织变更审计记录”
- 增加“配置变更预览 diff”
- 增加“采集健康页”（最近一次成功时间、失败原因）
- 将指标库从单机 SQLite 升级到集中式 TSDB（如 Prometheus/ClickHouse）

---

## 15. 快速命令汇总

```bash
# 安装
pnpm install

# 开发
pnpm dev

# 生产构建
pnpm build

# 启动
pnpm start

# 采集脚本（直接跑一次）
./scripts/collect-metrics.sh

# 采集脚本打包（推荐生产）
pnpm run build:collect-metrics
```

---

如需补充“按你们实际生产拓扑（单机/多机）的一键部署脚本版本文档”，可在本文档基础上再加 `docs/DEPLOY_PROD.md`。
