/**
 * 集群节点配置
 * 修改此文件以适配实际的节点信息（hostname、IP、显示名称、角色、标签）
 */
export interface ClusterNodeConfig {
  /** docker node ls 中显示的 HOSTNAME */
  hostname: string;
  /** 节点 IP，格式: 10.9.xxx.xxx */
  ip: string;
  /** 仪表盘显示名称 */
  displayName: string;
  /** 节点角色 */
  role: 'manager' | 'worker';
  /** 节点标签（用于展示） */
  labels: string[];
}

export const CLUSTER_NODES_CONFIG: ClusterNodeConfig[] = [
  {
    hostname: 'sz-glbd-jupterhub-123-235',
    ip: '10.9.123.235',
    displayName: '主节点 (10.9.123.235)',
    role: 'manager',
    labels: ['manager', 'nfs-server'],
  },
  {
    hostname: 'sz-glbd-jupterhub-123-228',
    ip: '10.9.123.228',
    displayName: '计算节点1 (10.9.123.228)',
    role: 'worker',
    labels: ['worker'],
  },
  {
    hostname: 'sz-glbd-jupterhub-123-229',
    ip: '10.9.123.229',
    displayName: '计算节点2 (10.9.123.229)',
    role: 'worker',
    labels: ['worker'],
  },
  {
    hostname: 'sz-glbd-jupterhub-123-230',
    ip: '10.9.123.230',
    displayName: '计算节点3 (10.9.123.230)',
    role: 'worker',
    labels: ['worker'],
  },
];

/** JupyterHub API 配置 */
export const JUPYTERHUB_CONFIG = {
  /** JupyterHub 用户列表 API 地址（manager 节点） */
  apiUrl: 'http://10.9.123.235:8000/jupyterhub/hub/api/users',
  /** API 访问 Token */
  token: '5b1682dcfca4461eb666851a8148bcb6',
};

/** Node Exporter 默认端口 */
export const NODE_EXPORTER_PORT = 9100;
