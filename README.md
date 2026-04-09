# JupyterHub-Ops
中文 | English

JupyterHub-Ops — Multi-Node JupyterHub Operations Console

手工运维 JupyterHub + Swarm 的成本很高：看状态靠 SSH、看趋势靠零散脚本、排障靠人肉。
这个项目把常用运维链路收敛到一个控制台里：监控、用户管理、日志、服务管理、指标历史。

Next.js React TypeScript Tailwind Recharts sql.js Docker Swarm JupyterHub MIT
ZH EN

## Demo Snapshot

- 实时节点资源视图（CPU / 内存 / 磁盘）
- 用户容器运行状态与资源占用
- 指标趋势（avg/max）
- 服务重启与配置文件在线查看/编辑

## What Is This

JupyterHub-Ops 是一个面向 **JupyterHub + Docker Swarm** 的运维 Web 控制台。它不是托管平台，而是你自部署的本地运维工具，核心目标是：

- 把分散在 SSH / API / 脚本中的操作统一到 UI
- 提供可追踪的历史指标（SQLite）与趋势图
- 降低 OOM 和资源浪费风险
- 提升日常巡检、启停、日志排查效率

它适合：

- 有 1~N 个计算节点（worker）的 JupyterHub 团队
- 需要可视化、可审查、可扩展的运维面板
- 希望将“脚本式运维”逐步产品化的内部平台团队

## Features

| Feature | Description |
|---|---|
| Dashboard | 聚合 Node Exporter / Hub / Docker 信息，展示节点与用户实时状态 |
| User Management | 用户容器启停、资源展示、闲置用户清理（阈值可选） |
| Metrics History | 定时采集写入 SQLite，支持节点/用户趋势（avg/max） |
| Service Management | 服务重启；在线查看/编辑 `docker-compose.yml` 与 `jupyterhub_config.py` |
| Config DN Management | 在 `jupyterhub_config.py` 中可视化增删组织 DN 模板 |
| Logs | Hub/服务日志查看与检索，支持向上翻页与过滤 |
| OOM Risk Visibility | 高内存占用告警提示，辅助提前处理风险 |
| Cron Collector | `collect-metrics.sh` + `collect-metrics.ts`，支持 Node 版本兼容与诊断日志 |

## Quick Start

```bash
# 1) Clone
git clone <your-repo-url>
cd jupyterhub-ops

# 2) Install
pnpm install

# 3) Dev
pnpm dev

# 4) Build & Start
pnpm build
pnpm start
```

打开：

- 默认：`http://localhost:3000`
- 若设置 `basePath: '/ops'`：`http://localhost:3000/ops`

## Metrics Collector Setup (Cron)

```bash
# 先构建采集 bundle（推荐）
pnpm run build:collect-metrics

# 手动运行一次
./scripts/collect-metrics.sh
```

Crontab 示例（每分钟）：

```cron
* * * * * cd /opt/jupyterhub-ops && METRICS_SQLITE_PATH=/opt/jupyterhub/data/metrics.db ./scripts/collect-metrics.sh >> /var/log/jupyterhub-ops-metrics.log 2>&1
```

可选环境变量：

- `METRICS_SQLITE_PATH`：指标库路径
- `METRICS_RETENTION_DAYS`：保留天数（默认 7）
- `JHOPS_JUPYTERHUB_API_URL` / `JHOPS_JUPYTERHUB_TOKEN`：覆盖 Hub API 配置
- `NODE_BINARY`：cron 下指定 node 绝对路径
- `JHOPS_COLLECT_DEBUG=1`：输出采集详细诊断

## Usage

主要页面能力：

- 仪表盘：节点资源总览
- 用户管理：用户容器状态、启停、闲置清理
- 趋势图：节点/用户历史指标（`/api/metrics/history/node|user`）
- 服务管理：重启服务、查看与保存配置
- 日志：服务日志浏览与检索

常用脚本命令：

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm run collect-metrics
pnpm run build:collect-metrics
```

## How It Works

```text
Browser UI (src/app/page.tsx)
        │
        ▼
Next.js API Routes (src/app/api/*)
        │
        ├── JupyterHub API
        ├── Node Exporter
        ├── SSH + docker stats/service logs
        └── SQLite (sql.js)
                │
                ▼
        metrics.db (history)

Cron (collect-metrics.sh -> collect-metrics.ts)
        └── 定时采集并清理过期数据
```

## Project Structure

```text
jupyterhub-ops/
├── src/
│   ├── app/
│   │   ├── page.tsx
│   │   └── api/
│   │       ├── dashboard/
│   │       ├── metrics/history/
│   │       ├── servicemanage/
│   │       └── users/
│   ├── components/
│   │   ├── metrics-trend-sheet.tsx
│   │   └── ui/*
│   ├── config/
│   │   ├── cluster.ts
│   │   ├── service.ts
│   │   └── metrics-store.ts
│   └── lib/
│       ├── metrics-sqlite.ts
│       ├── prometheus-node-metrics.ts
│       ├── jupyterhub-client.ts
│       └── ...
├── scripts/
│   ├── collect-metrics.sh
│   ├── collect-metrics.ts
│   └── collect-metrics.cjs
├── docs/
│   └── PROJECT_GUIDE.md
├── .cursor/rules/
└── README.md
```

## Tech Stack

- **Frontend**: Next.js 13, React 18, TypeScript, Tailwind CSS, shadcn/ui
- **Charts**: Recharts
- **Backend/BFF**: Next.js Route Handlers
- **Metrics Storage**: sql.js (SQLite WASM)
- **Infra Integration**: Docker Swarm, JupyterHub API, Node Exporter, SSH
- **Package Manager**: pnpm

## Disclaimer

JupyterHub-Ops 是本地部署的开源运维工具，不是托管服务。使用时请注意：

- 你需自行管理集群访问权限、Hub token、SSH 凭据与日志内容。
- 本工具会执行运维动作（如启停、重启、配置写入），请先在测试环境验证。
- 指标和评估结果用于辅助决策，不构成绝对正确性保证。
- 请遵守你所在组织的安全规范与第三方系统使用条款。

## License

MIT

## Contributing

欢迎提交 Issue / PR：

- Bug 修复
- 监控与可观测性增强
- API 与 UI 体验改进
- 文档完善（`docs/PROJECT_GUIDE.md`）

---

如果这个项目对你的团队有帮助，欢迎 Star。
