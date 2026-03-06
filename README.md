# JupyterHub Ops

**技术栈：** React、TypeScript、Next.js、Tailwind CSS、Docker Swarm API、JupyterHub API、Node Exporter

**项目简介：** JupyterHub Ops 是一个面向 Docker Swarm 集群的 JupyterHub 可视化运维管理平台，支持集群节点监控、用户容器管理、NFS 存储状态查看、服务启停控制以及资源告警等功能。针对微服务团队在使用 JupyterHub 时面临的资源利用率低、运维操作复杂、OOM 风险频发等痛点，基于 Web 可视化界面实现了集群状态的实时监控与自动化运维能力，显著提升了 JupyterHub 集群的管理效率。

**核心功能特性：**

- **集群可视化监控**：并发调用 Docker Swarm、JupyterHub、Node Exporter 三路 API，使用 `Promise.allSettled` 保证部分接口失败不影响整体渲染，实时展示各节点 CPU / 内存 / 磁盘使用率，支持 30 秒自动刷新；
- **OOM 防控体系**：基于内存使用率阈值（85% / 95%）动态触发告警，配置容器资源上限（2G 内存 / 1 CPU），闲置 30 分钟自动回收容器，有效降低节点 OOM 风险；
- **用户容器管理**：实时展示用户 Notebook Server 运行状态与资源占用，支持管理员一键启停用户容器；提供闲置用户清理工具，可配置 3 / 7 / 15 / 30 天阈值，执行前预览受影响用户，二次确认后批量回收资源；
- **服务生命周期控制**：通过 REST API 一键启动 / 停止 / 重启 JupyterHub 服务，在线查看 `docker-compose.yml` 与 `jupyterhub_config.py` 配置文件；
- **NFS 存储监控**：监控 NFS 服务端运行状态，实时验证各计算节点挂载情况，提供重启 NFS、验证挂载、查看存储空间等快捷操作入口；
