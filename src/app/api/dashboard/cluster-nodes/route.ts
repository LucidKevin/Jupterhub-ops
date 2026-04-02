/**
 * GET /api/dashboard/cluster-nodes
 *
 * 通过在服务端执行 `docker node ls` 获取 Docker Swarm 集群节点列表，
 * 并结合 src/config/cluster.ts 中的配置补全显示名称、IP、角色、标签等信息。
 *
 * 容器数量统计策略：
 *   - Manager 节点：本机执行 `docker ps -q | wc -l`，返回 0 表示 JupyterHub 已停机
 *   - Worker 节点：通过 `ssh -p 39000 root@<ip> 'docker ps -q | wc -l'` 获取实际运行容器数
 *
 * 返回示例：
 * {
 *   totalNodes: 4,
 *   managerNodes: 1,
 *   workerNodes: 3,
 *   totalContainers: 7,
 *   nodes: [
 *     {
 *       id: "9vnsxae28jot4gq4qj2q8smha",
 *       hostname: "sz-glbd-jupterhub-123-235",
 *       displayName: "主节点 (10.9.123.235)",
 *       ip: "10.9.123.235",
 *       role: "manager",
 *       status: "Ready",
 *       availability: "Active",
 *       managerStatus: "Leader",
 *       labels: ["manager", "nfs-server"],
 *       containers: 1
 *     },
 *     ...
 *   ]
 * }
 *
 * 注意：该接口必须在 Docker Swarm Manager 节点上运行才能正常执行 docker node ls。
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CLUSTER_NODES_CONFIG } from '@/config/cluster';
import { API_TIMEOUT_MS, SSH_PORT } from '@/config/service';
import { requireAdmin } from '@/lib/guard';

const execAsync = promisify(exec);

/** docker node ls --format "{{json .}}" 输出的单行 JSON 结构 */
interface DockerNode {
  ID: string;
  Hostname: string;
  Status: string;        // Ready | Down
  Availability: string;  // Active | Pause | Drain
  ManagerStatus: string; // Leader | Reachable | ""（worker 为空）
}

function inferRole(managerStatus: string): 'manager' | 'worker' {
  return managerStatus === 'Leader' || managerStatus === 'Reachable' ? 'manager' : 'worker';
}

/**
 * 获取本机（Manager 节点）正在运行的 Jupyter 用户容器数量。
 * 仅统计容器名以 jupyter- 开头的容器。
 */
async function getManagerContainerCount(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      'sh -lc \'docker ps --format "{{.Names}}" | grep -E -c "(^jupyter-|jupyterhub)" || true\''
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * 通过 SSH 获取指定 worker 节点上正在运行的 Jupyter 用户容器数量。
 * 仅统计容器名以 jupyter- 开头的容器；失败时返回 0。
 */
async function getWorkerContainerCount(ip: string): Promise<number> {
  if (!ip) return 0;
  try {
    const { stdout } = await execAsync(
      `ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=${Math.floor(API_TIMEOUT_MS.sshConnect / 1000)} root@${ip} 'sh -lc '"'"'docker ps --format "{{.Names}}" | grep -E -c "(^jupyter-|jupyterhub)" || true'"'"''`
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** 配置缺失时，回退通过 node inspect 获取节点 IP */
async function getNodeIpByInspect(nodeId: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`docker node inspect ${nodeId} --format '{{ .Status.Addr }}'`);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function GET() {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  try {
    // 以 NDJSON 格式获取节点列表（每行一个 JSON 对象）
    const { stdout } = await execAsync('docker node ls --format "{{json .}}"');
    const lines = stdout.trim().split('\n').filter((l) => l.trim());

    const dockerNodes: DockerNode[] = lines
      .map((line) => {
        try {
          return JSON.parse(line) as DockerNode;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as DockerNode[];

    const totalNodes = dockerNodes.length;
    // ManagerStatus 为 Leader 或 Reachable 的节点视为 Manager
    const managerNodes = dockerNodes.filter(
      (n) => n.ManagerStatus === 'Leader' || n.ManagerStatus === 'Reachable'
    ).length;
    const workerNodes = totalNodes - managerNodes;

    // 用 cluster.ts 配置补全 docker 输出中没有的字段（IP、displayName、role、labels）
    const enriched = await Promise.all(
      dockerNodes.map(async (dockerNode) => {
        const config = CLUSTER_NODES_CONFIG.find((c) => c.hostname === dockerNode.Hostname);
        const fallbackIp = config?.ip || (await getNodeIpByInspect(dockerNode.ID));
        return {
          id: dockerNode.ID,
          hostname: dockerNode.Hostname,
          displayName: config?.displayName ?? dockerNode.Hostname,
          ip: fallbackIp,
          role: config?.role ?? inferRole(dockerNode.ManagerStatus),
          status: dockerNode.Status,
          availability: dockerNode.Availability,
          managerStatus: dockerNode.ManagerStatus,
          labels: config?.labels ?? [],
        };
      })
    );

    // 并发获取各 worker 节点容器数（manager 默认为 1）
    const nodes = await Promise.all(
      enriched.map(async (node) => {
        const containers =
          node.role === 'manager'
            ? await getManagerContainerCount()   // 本机直接执行，0 表示 JupyterHub 已停机
            : await getWorkerContainerCount(node.ip);
        return { ...node, containers };
      })
    );

    const totalContainers = nodes.reduce((sum, n) => sum + n.containers, 0);

    return NextResponse.json({ totalNodes, managerNodes, workerNodes, totalContainers, nodes });
  } catch (error) {
    console.error('Failed to get docker nodes:', error);
    return NextResponse.json({ error: 'Failed to get cluster nodes' }, { status: 500 });
  }
}
