/**
 * GET /api/dashboard/cluster-nodes
 *
 * 通过在服务端执行 `docker node ls` 获取 Docker Swarm 集群节点列表，
 * 并结合 src/config/cluster.ts 中的配置补全显示名称、IP、角色、标签等信息。
 *
 * 返回示例：
 * {
 *   totalNodes: 4,
 *   managerNodes: 1,
 *   workerNodes: 3,
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
 *       labels: ["manager", "nfs-server"]
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

const execAsync = promisify(exec);

/** docker node ls --format "{{json .}}" 输出的单行 JSON 结构 */
interface DockerNode {
  ID: string;
  Hostname: string;
  Status: string;        // Ready | Down
  Availability: string;  // Active | Pause | Drain
  ManagerStatus: string; // Leader | Reachable | ""（worker 为空）
}

export async function GET() {
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
    const nodes = dockerNodes.map((dockerNode) => {
      const config = CLUSTER_NODES_CONFIG.find((c) => c.hostname === dockerNode.Hostname);
      return {
        id: dockerNode.ID,
        hostname: dockerNode.Hostname,
        displayName: config?.displayName ?? dockerNode.Hostname,
        ip: config?.ip ?? '',
        role: config?.role ?? 'worker',
        status: dockerNode.Status,
        availability: dockerNode.Availability,
        managerStatus: dockerNode.ManagerStatus,
        labels: config?.labels ?? [],
      };
    });

    return NextResponse.json({ totalNodes, managerNodes, workerNodes, nodes });
  } catch (error) {
    console.error('Failed to get docker nodes:', error);
    return NextResponse.json({ error: 'Failed to get cluster nodes' }, { status: 500 });
  }
}
