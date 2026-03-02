'use client';

import { useState, useEffect, useCallback } from 'react';
import { 
  LayoutDashboard, 
  Server, 
  HardDrive, 
  Activity, 
  Settings, 
  Terminal, 
  AlertTriangle,
  Users,
  Package,
  FileText,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Power,
  PowerOff,
  CheckCircle,
  XCircle,
  Clock,
  Cpu,
  MemoryStick,
  Database,
  Wifi
} from 'lucide-react';

type TabType = 'dashboard' | 'services' | 'nodes' | 'nfs' | 'resources' | 'logs' | 'operations' | 'users';

interface NodeData {
  id: string;
  name: string;
  role: string;
  status: string;
  cpu: number;
  memory: number;
  disk: number;
  ip: string;
  containers: number;
  labels: string[];
}

// 节点显示配置（与 src/config/cluster.ts 保持同步）
// 作为初始占位数据，确保页面加载时节点列表不为空
const DASHBOARD_NODE_CONFIG: NodeData[] = [
  { id: 'node-235', name: '主节点 (10.9.123.235)',   role: 'Manager', status: '加载中', cpu: 0, memory: 0, disk: 0, ip: '10.9.123.235', containers: 0, labels: ['manager', 'nfs-server'] },
  { id: 'node-228', name: '计算节点1 (10.9.123.228)', role: 'Worker',  status: '加载中', cpu: 0, memory: 0, disk: 0, ip: '10.9.123.228', containers: 0, labels: ['worker'] },
  { id: 'node-229', name: '计算节点2 (10.9.123.229)', role: 'Worker',  status: '加载中', cpu: 0, memory: 0, disk: 0, ip: '10.9.123.229', containers: 0, labels: ['worker'] },
  { id: 'node-230', name: '计算节点3 (10.9.123.230)', role: 'Worker',  status: '加载中', cpu: 0, memory: 0, disk: 0, ip: '10.9.123.230', containers: 0, labels: ['worker'] },
];

export default function JupyterHubDashboard() {
  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    monitoring: true,
    services: true,
    nodes: false,
  });

  // ── 动态数据：仪表盘顶部四张统计卡片 ────────────────────────────────────────
  // 初始值为 null（加载中），API 返回后更新；若 API 失败则保持 null 并回退到占位值
  const [totalNodes, setTotalNodes] = useState<number | null>(null);
  const [managerNodes, setManagerNodes] = useState<number>(1);
  const [workerNodes, setWorkerNodes] = useState<number>(3);
  const [runningContainers, setRunningContainers] = useState<number | null>(null);
  const [stoppedContainers, setStoppedContainers] = useState<number>(0);
  const [avgCpu, setAvgCpu] = useState<number | null>(null);      // 来自 node-metrics API
  const [avgMemory, setAvgMemory] = useState<number | null>(null); // 来自 node-metrics API
  const [metricsLoading, setMetricsLoading] = useState(true);
  // 刷新成功 toast 提示（true 时显示，3 秒后自动隐藏）
  const [refreshToast, setRefreshToast] = useState(false);
  /**
   * 节点列表 —— 以 DASHBOARD_NODE_CONFIG 为初始值（静态占位），
   * 页面加载后由 /api/dashboard/cluster-nodes 和 /api/dashboard/node-metrics 的数据更新。
   */
  const [nodes, setNodes] = useState<NodeData[]>(DASHBOARD_NODE_CONFIG);

  /**
   * 仪表盘数据拉取函数（useCallback 避免在 useEffect 依赖中重复创建）
   *
   * 并发请求三个 Dashboard API：
   *   1. /api/dashboard/cluster-nodes    → docker node ls，获取节点状态
   *   2. /api/dashboard/running-containers → JupyterHub API，获取运行中容器数
   *   3. /api/dashboard/node-metrics     → Node Exporter，获取 CPU/内存/磁盘
   *
   * 使用 Promise.allSettled 确保某个 API 失败不影响其他数据渲染。
   */
  const fetchDashboardData = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const [nodesRes, containersRes, metricsRes] = await Promise.allSettled([
        fetch('/api/dashboard/cluster-nodes').then((r) => r.json()),
        fetch('/api/dashboard/running-containers').then((r) => r.json()),
        fetch('/api/dashboard/node-metrics').then((r) => r.json()),
      ]);

      // 提取各 API 的 nodes 数组，失败时为空数组（不中断后续合并）
      const clusterNodes =
        nodesRes.status === 'fulfilled' && !nodesRes.value.error
          ? nodesRes.value.nodes
          : [];
      const metricsNodes =
        metricsRes.status === 'fulfilled' && !metricsRes.value.error
          ? metricsRes.value.nodes
          : [];

      // 更新顶部统计卡片数据
      if (nodesRes.status === 'fulfilled' && !nodesRes.value.error) {
        setTotalNodes(nodesRes.value.totalNodes);
        setManagerNodes(nodesRes.value.managerNodes);
        setWorkerNodes(nodesRes.value.workerNodes);
        // 运行容器总数来自 cluster-nodes（SSH docker ps + manager 默认1）
        setRunningContainers(nodesRes.value.totalContainers);
      }
      if (containersRes.status === 'fulfilled' && !containersRes.value.error) {
        // stoppedContainers 仍从 JupyterHub API 获取（已停止的用户数）
        setStoppedContainers(containersRes.value.stoppedContainers);
      }
      if (metricsRes.status === 'fulfilled' && !metricsRes.value.error) {
        setAvgCpu(metricsRes.value.avgCpu);
        setAvgMemory(metricsRes.value.avgMemory);
      }

      /**
       * 节点列表合并策略：
       * 始终以 DASHBOARD_NODE_CONFIG 为基准（保证 4 个节点始终可见），
       * - cluster-nodes 成功时更新节点 id、status、containers
       * - node-metrics 成功时更新 cpu/memory/disk
       * - API 失败时 status 回退为 '未知'，containers 保留占位值 0
       */
      const merged: NodeData[] = DASHBOARD_NODE_CONFIG.map((base) => {
        const cn = clusterNodes.find((n: { ip: string }) => n.ip === base.ip);
        const m  = metricsNodes.find((n: { ip: string }) => n.ip === base.ip);
        return {
          id:         cn?.id          ?? base.id,
          name:       base.name,
          role:       base.role,
          status:     cn?.status      ?? '未知',
          cpu:        m?.cpuUsage     ?? 0,
          memory:     m?.memoryUsage  ?? 0,
          disk:       m?.diskUsage    ?? 0,
          ip:         base.ip,
          containers: cn?.containers  ?? base.containers,
          labels:     base.labels,
        };
      });
      setNodes(merged);

      // 刷新成功，3 秒后自动隐藏提示
      setRefreshToast(true);
      setTimeout(() => setRefreshToast(false), 3000);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  // 页面加载后立即拉取，并每 30 秒自动刷新一次
  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  // 模拟数据 - 集群状态（用于侧边栏显示）
  const clusterStatus = {
    totalNodes: totalNodes ?? 4,
    managerNode: managerNodes,
    workerNodes: workerNodes,
    onlineNodes: totalNodes ?? 4,
    offlineNodes: 0,
    totalContainers: (runningContainers ?? 0) + stoppedContainers,
    runningContainers: runningContainers ?? 0,
    stoppedContainers,
  };

  // 服务管理状态
  const [serviceConfig, setServiceConfig] = useState<{ compose: string | null; hubConfig: string | null } | null>(null);
  const [serviceConfigLoading, setServiceConfigLoading] = useState(false);
  const [serviceAction, setServiceAction] = useState<'idle' | 'starting' | 'stopping' | 'restarting'>('idle');
  const [serviceResult, setServiceResult] = useState<{ success: boolean; output: string; error?: string } | null>(null);
  const [activeConfigTab, setActiveConfigTab] = useState<'compose' | 'hubConfig'>('compose');

  // 模拟数据 - 用户管理
  const [users, setUsers] = useState([
    {
      id: 1,
      username: 'admin',
      email: 'admin@company.com',
      serverName: 'jupyter-admin',
      status: 'Running',
      node: 'node-228',
      memory: 1.2,
      memoryLimit: 2.0,
      cpu: 15,
      uptime: '2h 30m',
      lastLogin: '2024-01-15 14:30:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 3,
      isAdmin: true,
    },
    {
      id: 2,
      username: 'user1',
      email: 'user1@company.com',
      serverName: 'jupyter-user1',
      status: 'Running',
      node: 'node-229',
      memory: 1.5,
      memoryLimit: 2.0,
      cpu: 25,
      uptime: '1h 45m',
      lastLogin: '2024-01-15 13:45:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 5,
      isAdmin: false,
    },
    {
      id: 3,
      username: 'user2',
      email: 'user2@company.com',
      serverName: 'jupyter-user2',
      status: 'Running',
      node: 'node-230',
      memory: 1.8,
      memoryLimit: 2.0,
      cpu: 32,
      uptime: '3h 10m',
      lastLogin: '2024-01-15 11:20:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 7,
      isAdmin: false,
    },
    {
      id: 4,
      username: 'user3',
      email: 'user3@company.com',
      serverName: 'jupyter-user3',
      status: 'Running',
      node: 'node-228',
      memory: 1.1,
      memoryLimit: 2.0,
      cpu: 18,
      uptime: '0h 45m',
      lastLogin: '2024-01-15 15:30:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 2,
      isAdmin: false,
    },
    {
      id: 5,
      username: 'user4',
      email: 'user4@company.com',
      serverName: 'jupyter-user4',
      status: 'Stopped',
      node: '-',
      memory: 0,
      memoryLimit: 2.0,
      cpu: 0,
      uptime: '-',
      lastLogin: '2024-01-14 18:00:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 0,
      isAdmin: false,
    },
    {
      id: 6,
      username: 'user5',
      email: 'user5@company.com',
      serverName: 'jupyter-user5',
      status: 'Stopped',
      node: '-',
      memory: 0,
      memoryLimit: 2.0,
      cpu: 0,
      uptime: '-',
      lastLogin: '2024-01-14 16:30:00',
      notebookPort: 8888,
      image: 'my-scipy-notebook:latest',
      notebookCount: 0,
      isAdmin: false,
    },
  ]);

  // 根据实际节点内存数据动态生成 OOM 告警（内存使用率 >= 85% 时触发）
  const oomAlerts = nodes
    .filter((n) => n.memory >= 85)
    .map((n, i) => ({
      id: i + 1,
      node: n.name,
      memoryUsage: Math.round(n.memory),
      threshold: 85,
      timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
      severity: n.memory >= 95 ? 'critical' : 'high',
      message: `节点内存使用率达到 ${Math.round(n.memory)}%，接近 OOM 阈值`,
    }));

  // 模拟数据 - 镜像列表
  const images = [
    {
      name: 'myjupyterhub',
      tag: 'latest',
      size: '2.3GB',
      createdAt: '2024-01-15 10:00:00',
    },
    {
      name: 'my-scipy-notebook',
      tag: 'latest',
      size: '4.5GB',
      createdAt: '2024-01-15 10:00:00',
    },
  ];

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
      case 'ready':
        return 'text-green-500';
      case 'stopped':
      case 'offline':
        return 'text-red-500';
      case 'warning':
        return 'text-yellow-500';
      default:
        return 'text-gray-500';
    }
  };

  /** Docker node status → 中文显示 + 圆点颜色 */
  const getNodeStatus = (status: string): { label: string; dotClass: string; textClass: string } => {
    switch (status) {
      case 'Ready':
        return { label: '正常', dotClass: 'bg-green-500', textClass: 'text-green-600' };
      case 'Down':
        return { label: '离线', dotClass: 'bg-red-500', textClass: 'text-red-600' };
      case '加载中':
        return { label: '加载中', dotClass: 'bg-slate-300 animate-pulse', textClass: 'text-slate-400' };
      default:
        return { label: '未知', dotClass: 'bg-slate-400', textClass: 'text-slate-500' };
    }
  };

  const getHealthColor = (usage: number) => {
    if (usage >= 90) return 'bg-red-500';
    if (usage >= 75) return 'bg-yellow-500';
    if (usage >= 60) return 'bg-blue-500';
    return 'bg-green-500';
  };

  // 启动用户 server
  const startUserServer = (userId: number) => {
    setUsers(prevUsers =>
      prevUsers.map(user =>
        user.id === userId
          ? {
              ...user,
              status: 'Running',
              memory: 0.5,
              cpu: 5,
              uptime: '刚刚启动',
            }
          : user
      )
    );
  };

  // 停止用户 server
  const stopUserServer = (userId: number) => {
    setUsers(prevUsers =>
      prevUsers.map(user =>
        user.id === userId
          ? {
              ...user,
              status: 'Stopped',
              memory: 0,
              cpu: 0,
              uptime: '-',
              node: '-',
            }
          : user
      )
    );
  };

  const renderSidebar = () => (
    <div className="w-64 bg-slate-900 text-white p-4 min-h-screen">
      <div className="mb-8">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Server className="w-6 h-6" />
          JupyterHub 运维
        </h1>
        <p className="text-xs text-slate-400 mt-1">Docker Swarm 集群管理</p>
      </div>

      <nav className="space-y-2">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'dashboard' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <LayoutDashboard className="w-5 h-5" />
          <span>仪表盘</span>
        </button>

        <button
          onClick={() => setActiveTab('services')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'services' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <Server className="w-5 h-5" />
          <span>服务管理</span>
        </button>

        <button
          onClick={() => setActiveTab('nodes')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'nodes' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <Cpu className="w-5 h-5" />
          <span>节点管理</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'users' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <Users className="w-5 h-5" />
          <span>用户管理</span>
        </button>

        <button
          onClick={() => setActiveTab('nfs')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'nfs' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <HardDrive className="w-5 h-5" />
          <span>NFS 存储</span>
        </button>

        <button
          onClick={() => setActiveTab('resources')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'resources' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <MemoryStick className="w-5 h-5" />
          <span>资源监控 & OOM</span>
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'logs' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <FileText className="w-5 h-5" />
          <span>日志查看</span>
        </button>

        <button
          onClick={() => setActiveTab('operations')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
            activeTab === 'operations' ? 'bg-blue-600' : 'hover:bg-slate-800'
          }`}
        >
          <Terminal className="w-5 h-5" />
          <span>运维操作</span>
        </button>
      </nav>

      <div className="mt-8 p-4 bg-slate-800 rounded-lg">
        <div className="flex items-center gap-2 text-sm mb-2">
          <Activity className="w-4 h-4 text-green-400" />
          <span className="text-slate-300">系统状态</span>
        </div>
        <div className="text-xs text-slate-400">
          <div className="flex justify-between">
            <span>在线节点:</span>
            <span className="text-green-400">{clusterStatus.onlineNodes}/{clusterStatus.totalNodes}</span>
          </div>
          <div className="flex justify-between mt-1">
            <span>运行容器:</span>
            <span className="text-green-400">{clusterStatus.runningContainers}</span>
          </div>
        </div>
      </div>
    </div>
  );

  const renderDashboard = () => (
    <div className="space-y-6">
      {/* 顶部统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">总节点数</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {metricsLoading && totalNodes === null ? '…' : (totalNodes ?? clusterStatus.totalNodes)}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {managerNodes} Manager + {workerNodes} Workers
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <Server className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">运行容器</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {metricsLoading && runningContainers === null ? '…' : (runningContainers ?? clusterStatus.runningContainers)}
              </p>
              <p className="text-xs text-slate-500 mt-1">{stoppedContainers} 个已停止</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">平均 CPU 使用率</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {metricsLoading && avgCpu === null ? '…' : `${avgCpu ?? (nodes.length > 0 ? Math.round(nodes.reduce((acc, n) => acc + n.cpu, 0) / nodes.length) : 0)}%`}
              </p>
              {(avgCpu ?? 0) >= 80 && (
                <p className="text-xs text-yellow-500 mt-1">⚠️ 部分节点负载较高</p>
              )}
            </div>
            <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
              <Cpu className="w-6 h-6 text-yellow-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">平均内存使用率</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {metricsLoading && avgMemory === null ? '…' : `${avgMemory ?? (nodes.length > 0 ? Math.round(nodes.reduce((acc, n) => acc + n.memory, 0) / nodes.length) : 0)}%`}
              </p>
              {(avgMemory ?? 0) >= 85 && (
                <p className="text-xs text-red-500 mt-1">🔥 接近 OOM 阈值</p>
              )}
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
              <MemoryStick className="w-6 h-6 text-red-600" />
            </div>
          </div>
        </div>
      </div>

      {/* OOM 告警 */}
      {oomAlerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="w-5 h-5 text-red-600" />
            <h3 className="text-lg font-semibold text-red-900">OOM 告警</h3>
          </div>
          <div className="space-y-3">
            {oomAlerts.map((alert) => (
              <div key={alert.id} className="bg-white border border-red-200 rounded-lg p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium text-red-900">{alert.message}</p>
                    <p className="text-sm text-red-700 mt-1">
                      节点: {alert.node} | 内存使用率: {alert.memoryUsage}%
                    </p>
                  </div>
                  <span className="text-xs text-slate-500">{alert.timestamp}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <button className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors">
                    查看容器
                  </button>
                  <button className="px-3 py-1 bg-red-100 text-red-700 text-sm rounded hover:bg-red-200 transition-colors">
                    清理缓存
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 节点状态 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">节点状态</h3>
            <button
              onClick={fetchDashboardData}
              disabled={metricsLoading}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60">
              <RefreshCw className={`w-4 h-4 ${metricsLoading ? 'animate-spin' : ''}`} />
              {metricsLoading ? '刷新中...' : '刷新状态'}
            </button>
          </div>
        </div>
        <div className="p-6">
          <div className="space-y-4">
            {nodes.map((node) => (
              <div key={node.id} className="border border-slate-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${getNodeStatus(node.status).dotClass}`} />
                    <div>
                      <p className="font-medium text-slate-900">{node.name}</p>
                      <p className="text-xs text-slate-500">{node.role} | {node.ip}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-slate-400" />
                      <span>{node.containers} 容器</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-slate-400" />
                      <span className={getNodeStatus(node.status).textClass}>
                        {getNodeStatus(node.status).label}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">CPU</span>
                      <span className={`font-medium ${node.cpu >= 80 ? 'text-red-600' : 'text-slate-900'}`}>
                        {node.cpu}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${getHealthColor(node.cpu)}`}
                        style={{ width: `${node.cpu}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">内存</span>
                      <span className={`font-medium ${node.memory >= 80 ? 'text-red-600' : 'text-slate-900'}`}>
                        {node.memory}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${getHealthColor(node.memory)}`}
                        style={{ width: `${node.memory}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">磁盘</span>
                      <span className="font-medium text-slate-900">{node.disk}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${getHealthColor(node.disk)}`}
                        style={{ width: `${node.disk}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {node.labels.map((label) => (
                    <span key={label} className="px-2 py-1 bg-slate-100 text-slate-700 text-xs rounded">
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );

  const renderServices = () => {
    // 首次切换到服务管理 tab 时加载配置文件
    if (!serviceConfig && !serviceConfigLoading) {
      setServiceConfigLoading(true);
      fetch('/api/dashboard/service/config')
        .then((r) => r.json())
        .then((data) => setServiceConfig(data))
        .catch(() => setServiceConfig({ compose: null, hubConfig: null }))
        .finally(() => setServiceConfigLoading(false));
    }

    const handleAction = async (action: 'start' | 'stop' | 'restart') => {
      setServiceAction(action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting');
      setServiceResult(null);
      try {
        const res = await fetch('/api/dashboard/service/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const data = await res.json();
        setServiceResult(data);
      } catch {
        setServiceResult({ success: false, output: '', error: '请求失败，请检查网络' });
      } finally {
        setServiceAction('idle');
      }
    };

    const actionBusy = serviceAction !== 'idle';
    const configContent = activeConfigTab === 'compose' ? serviceConfig?.compose : serviceConfig?.hubConfig;
    const configLabel = activeConfigTab === 'compose' ? 'docker-compose.yml' : 'jupyterhub_config.py';
    const configPath = activeConfigTab === 'compose'
      ? '/opt/jupyterhub/docker-compose.yml'
      : '/opt/jupyterhub/config/jupyterhub_config.py';

    return (
      <div className="space-y-6">
        {/* 操作区 */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">JupyterHub 服务</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAction('start')}
                  disabled={actionBusy}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
                  <Power className="w-4 h-4" />
                  {serviceAction === 'starting' ? '启动中...' : '启动服务'}
                </button>
                <button
                  onClick={() => handleAction('restart')}
                  disabled={actionBusy}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-60">
                  <RefreshCw className={`w-4 h-4 ${serviceAction === 'restarting' ? 'animate-spin' : ''}`} />
                  {serviceAction === 'restarting' ? '重启中...' : '重启服务'}
                </button>
                <button
                  onClick={() => handleAction('stop')}
                  disabled={actionBusy}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60">
                  <PowerOff className="w-4 h-4" />
                  {serviceAction === 'stopping' ? '停止中...' : '停止服务'}
                </button>
              </div>
            </div>
          </div>

          {/* 操作结果输出 */}
          {serviceResult && (
            <div className={`mx-6 mt-4 p-4 rounded-lg border text-sm ${
              serviceResult.success
                ? 'bg-green-50 border-green-200 text-green-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}>
              <p className="font-medium mb-1">{serviceResult.success ? '✓ 执行成功' : '✗ 执行失败'}</p>
              {serviceResult.error && <p className="text-xs mb-1 opacity-80">{serviceResult.error}</p>}
              {serviceResult.output && (
                <pre className="text-xs font-mono whitespace-pre-wrap bg-black/5 rounded p-2 mt-2 max-h-40 overflow-y-auto">
                  {serviceResult.output}
                </pre>
              )}
            </div>
          )}

          <div className="p-6">
            <div className="text-sm text-slate-500 space-y-1">
              <p>启动脚本：<code className="bg-slate-100 px-1 rounded">/opt/jupyterhub/start.sh</code></p>
              <p>停止脚本：<code className="bg-slate-100 px-1 rounded">/opt/jupyterhub/stop.sh</code></p>
              <p>重启脚本：<code className="bg-slate-100 px-1 rounded">/opt/jupyterhub/restart.sh</code></p>
            </div>
          </div>
        </div>

        {/* 配置文件查看 */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">配置文件</h3>
              {/* Tab 切换 */}
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
                <button
                  onClick={() => setActiveConfigTab('compose')}
                  className={`px-4 py-2 transition-colors ${activeConfigTab === 'compose' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                  docker-compose.yml
                </button>
                <button
                  onClick={() => setActiveConfigTab('hubConfig')}
                  className={`px-4 py-2 transition-colors ${activeConfigTab === 'hubConfig' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                  jupyterhub_config.py
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-2">{configPath}</p>
          </div>
          <div className="p-6">
            {serviceConfigLoading ? (
              <div className="text-sm text-slate-400 text-center py-8">加载配置文件中...</div>
            ) : configContent ? (
              <pre className="text-xs font-mono bg-slate-900 text-slate-100 rounded-lg p-4 overflow-auto max-h-[480px] whitespace-pre">
                {configContent}
              </pre>
            ) : (
              <div className="text-sm text-red-500 text-center py-8">
                无法读取 {configLabel}，请确认文件路径是否正确
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderNodes = () => (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Swarm 集群节点</h3>
            <button className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
              <Wifi className="w-4 h-4" />
              获取加入令牌
            </button>
          </div>
        </div>
        <div className="p-6">
          <div className="space-y-4">
            {nodes.map((node) => (
              <div key={node.id} className="border border-slate-200 rounded-lg p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-4 h-4 rounded-full ${node.status === 'Ready' ? 'bg-green-500' : 'bg-red-500'}`} />
                    <div>
                      <h4 className="text-lg font-semibold text-slate-900">{node.name}</h4>
                      <p className="text-sm text-slate-600">ID: {node.id}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button className="px-3 py-1 text-xs bg-slate-100 text-slate-700 rounded hover:bg-slate-200">
                      标签管理
                    </button>
                    <button className="px-3 py-1 text-xs bg-yellow-100 text-yellow-700 rounded hover:bg-yellow-200">
                      驱逐
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div className="bg-slate-50 p-3 rounded-lg">
                    <p className="text-xs text-slate-600 mb-1">角色</p>
                    <p className="text-sm font-medium text-slate-900">{node.role}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg">
                    <p className="text-xs text-slate-600 mb-1">IP 地址</p>
                    <p className="text-sm font-medium text-slate-900">{node.ip}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg">
                    <p className="text-xs text-slate-600 mb-1">容器数</p>
                    <p className="text-sm font-medium text-slate-900">{node.containers}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg">
                    <p className="text-xs text-slate-600 mb-1">状态</p>
                    <p className={`text-sm font-medium ${getNodeStatus(node.status).textClass}`}>
                      {getNodeStatus(node.status).label}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">CPU</span>
                      <span className="font-medium text-slate-900">{node.cpu}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${getHealthColor(node.cpu)}`}
                        style={{ width: `${node.cpu}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">内存</span>
                      <span className="font-medium text-slate-900">{node.memory}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${getHealthColor(node.memory)}`}
                        style={{ width: `${node.memory}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600">磁盘</span>
                      <span className="font-medium text-slate-900">{node.disk}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${getHealthColor(node.disk)}`}
                        style={{ width: `${node.disk}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-200">
                  <p className="text-xs text-slate-600 mb-2">标签:</p>
                  <div className="flex flex-wrap gap-2">
                    {node.labels.map((label) => (
                      <span key={label} className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">
                        {label}
                      </span>
                    ))}
                    <button className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded hover:bg-slate-200">
                      + 添加标签
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const renderNFS = () => (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">NFS 共享存储</h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-base font-medium text-slate-900 mb-4">NFS 服务端 (10.9.123.235)</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium text-green-900">nfs-server</span>
                  </div>
                  <span className="text-xs text-green-700">运行中</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium text-green-900">rpcbind</span>
                  </div>
                  <span className="text-xs text-green-700">运行中</span>
                </div>
              </div>
              <div className="mt-4 p-4 bg-slate-50 rounded-lg">
                <p className="text-xs text-slate-600 mb-2">共享目录:</p>
                <code className="text-sm text-slate-900 bg-white p-2 rounded border border-slate-200 block">
                  10.9.123.235:/nfs/jupyterhub
                </code>
              </div>
            </div>

            <div>
              <h4 className="text-base font-medium text-slate-900 mb-4">NFS 客户端挂载状态</h4>
              <div className="space-y-3">
                {nodes.filter(n => n.role === 'Worker').map((node) => (
                  <div key={node.id} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-slate-900">{node.name}</span>
                      <span className="text-xs text-green-600">已挂载</span>
                    </div>
                    <code className="text-xs text-slate-600 bg-slate-100 p-2 rounded block">
                      {node.ip}:/nfs/jupyterhub → /nfs/jupyterhub
                    </code>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6">
            <h4 className="text-base font-medium text-slate-900 mb-4">操作面板</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <button className="p-4 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors text-left">
                <RefreshCw className="w-5 h-5 text-blue-600 mb-2" />
                <p className="text-sm font-medium text-blue-900">重启 NFS 服务</p>
                <p className="text-xs text-blue-700 mt-1">重启主节点 NFS 服务</p>
              </button>
              <button className="p-4 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors text-left">
                <CheckCircle className="w-5 h-5 text-green-600 mb-2" />
                <p className="text-sm font-medium text-green-900">验证挂载状态</p>
                <p className="text-xs text-green-700 mt-1">检查所有计算节点挂载</p>
              </button>
              <button className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg hover:bg-yellow-100 transition-colors text-left">
                <Database className="w-5 h-5 text-yellow-600 mb-2" />
                <p className="text-sm font-medium text-yellow-900">查看存储空间</p>
                <p className="text-xs text-yellow-700 mt-1">检查 NFS 磁盘使用情况</p>
              </button>
            </div>
          </div>

          <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-yellow-900">注意事项</p>
                <p className="text-xs text-yellow-700 mt-1">
                  部署文档中存在笔误：软链接命令应为 ln -s /nfs/jupyterhub/share /opt/py_package/share
                  （原文档错误为 /nfs/jupyterbub/share），请确保所有计算节点已修正此配置。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderResources = () => (
    <div className="space-y-6">
      {/* OOM 配置 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">OOM 防控配置</h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-base font-medium text-slate-900 mb-4">容器资源限制 (jupyterhub_config.py)</h4>
              <div className="space-y-3">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">单个容器内存限制</span>
                    <span className="text-sm font-bold text-slate-900">2G</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.DockerSpawner.mem_limit = '2G'
                  </code>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">单个容器 CPU 限制</span>
                    <span className="text-sm font-bold text-slate-900">1 核</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.DockerSpawner.cpu_limit = 1
                  </code>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">内存软限制</span>
                    <span className="text-sm font-bold text-slate-900">1G</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.DockerSpawner.mem_reservation = '1G'
                  </code>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">最大容器数/用户</span>
                    <span className="text-sm font-bold text-slate-900">2</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.JupyterHub.max_nspawns_per_user = 2
                  </code>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-base font-medium text-slate-900 mb-4">闲置容器清理策略</h4>
              <div className="space-y-3">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">闲置超时时间</span>
                    <span className="text-sm font-bold text-slate-900">30 分钟</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.JupyterHub.cull_idle_timeout = 1800
                  </code>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">检查间隔</span>
                    <span className="text-sm font-bold text-slate-900">10 分钟</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.JupyterHub.cull_interval = 600
                  </code>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-slate-700">是否关闭运行中任务</span>
                    <span className="text-sm font-bold text-slate-900">否</span>
                  </div>
                  <code className="text-xs text-slate-600 block">
                    c.JupyterHub.cull_pending = False
                  </code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 资源监控 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">实时资源监控</h3>
        </div>
        <div className="p-6">
          <div className="space-y-4">
            {nodes.map((node) => (
              <div key={node.id} className="border border-slate-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-base font-medium text-slate-900">{node.name}</h4>
                  <div className="flex items-center gap-2">
                    {node.memory >= 85 && (
                      <span className="px-2 py-1 bg-red-100 text-red-700 text-xs rounded flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        OOM 风险
                      </span>
                    )}
                    {node.cpu >= 80 && (
                      <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded">
                        CPU 高负载
                      </span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-slate-600 mb-2">CPU 使用率</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-slate-200 rounded-full h-3">
                        <div
                          className={`h-3 rounded-full ${getHealthColor(node.cpu)}`}
                          style={{ width: `${node.cpu}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold text-slate-900">{node.cpu}%</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-600 mb-2">内存使用率</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-slate-200 rounded-full h-3">
                        <div
                          className={`h-3 rounded-full ${getHealthColor(node.memory)}`}
                          style={{ width: `${node.memory}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold text-slate-900">{node.memory}%</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-600 mb-2">磁盘使用率</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-slate-200 rounded-full h-3">
                        <div
                          className={`h-3 rounded-full ${getHealthColor(node.disk)}`}
                          style={{ width: `${node.disk}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold text-slate-900">{node.disk}%</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 应急操作 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">应急操作</h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button className="p-4 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors text-left">
              <XCircle className="w-5 h-5 text-red-600 mb-2" />
              <p className="text-sm font-medium text-red-900">停止高内存容器</p>
              <p className="text-xs text-red-700 mt-1">停止占用内存最高的容器</p>
            </button>
            <button className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg hover:bg-yellow-100 transition-colors text-left">
              <RefreshCw className="w-5 h-5 text-yellow-600 mb-2" />
              <p className="text-sm font-medium text-yellow-900">重启节点服务</p>
              <p className="text-xs text-yellow-700 mt-1">重启节点的 Docker/NFS 服务</p>
            </button>
            <button className="p-4 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors text-left">
              <Wifi className="w-5 h-5 text-blue-600 mb-2" />
              <p className="text-sm font-medium text-blue-900">节点下线</p>
              <p className="text-xs text-blue-700 mt-1">将节点从 Swarm 集群移除</p>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderLogs = () => (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">JupyterHub 日志</h3>
            <div className="flex gap-2">
              <select className="px-3 py-2 text-sm border border-slate-300 rounded-lg">
                <option>所有日志</option>
                <option>INFO</option>
                <option>WARNING</option>
                <option>ERROR</option>
              </select>
              <button className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                <RefreshCw className="w-4 h-4" />
                刷新
              </button>
              <button className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-600 text-white rounded-lg hover:bg-slate-700">
                下载
              </button>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="bg-slate-900 text-slate-100 rounded-lg p-4 font-mono text-sm max-h-96 overflow-y-auto">
            <div className="space-y-1">
              <p className="text-green-400">[2024-01-15 14:30:00] [INFO] Starting JupyterHub server...</p>
              <p className="text-blue-400">[2024-01-15 14:30:05] [INFO] Using authenticator: jupyterhub.auth.PAMAuthenticator</p>
              <p className="text-blue-400">[2024-01-15 14:30:06] [INFO] Using spawner: dockerspawner.DockerSpawner</p>
              <p className="text-green-400">[2024-01-15 14:30:10] [INFO] JupyterHub is now running at http://10.9.123.235:8000</p>
              <p className="text-yellow-400">[2024-01-15 14:31:15] [WARNING] Node 10.9.123.230 memory usage at 85%</p>
              <p className="text-green-400">[2024-01-15 14:32:00] [INFO] User 'admin' logged in</p>
              <p className="text-green-400">[2024-01-15 14:32:05] [INFO] Spawning container for user 'admin' on node-228</p>
              <p className="text-green-400">[2024-01-15 14:32:30] [INFO] Container 'jupyter-admin' is running</p>
              <p className="text-green-400">[2024-01-15 14:33:00] [INFO] User 'user1' logged in</p>
              <p className="text-green-400">[2024-01-15 14:33:05] [INFO] Spawning container for user 'user1' on node-229</p>
              <p className="text-red-400">[2024-01-15 14:35:00] [ERROR] Container jupyter-user4 OOM Killed</p>
              <p className="text-yellow-400">[2024-01-15 14:35:05] [WARNING] Node 10.9.123.230 is approaching OOM threshold</p>
              <p className="text-green-400">[2024-01-15 14:36:00] [INFO] Idle container 'jupyter-user2' has been culled after 30 minutes</p>
              <p className="text-blue-400">[2024-01-15 14:37:00] [INFO] Health check passed for all services</p>
            </div>
          </div>
          <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <p className="text-xs text-slate-600">
              <strong>日志文件位置:</strong> /opt/jupyterhub/logs/jupyterhub.log<br />
              <strong>日志轮转:</strong> 保留 15 天，配置文件: /etc/logrotate.d/jupyterhub
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderUsers = () => (
    <div className="space-y-6">
      {/* 用户统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">总用户数</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">{users.length}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
              <Users className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">运行中用户</p>
              <p className="text-3xl font-bold text-green-600 mt-2">
                {users.filter(u => u.status === 'Running').length}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">已停止用户</p>
              <p className="text-3xl font-bold text-red-600 mt-2">
                {users.filter(u => u.status === 'Stopped').length}
              </p>
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
              <XCircle className="w-6 h-6 text-red-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600">总内存使用</p>
              <p className="text-3xl font-bold text-slate-900 mt-2">
                {users.reduce((acc, u) => acc + u.memory, 0).toFixed(1)} GB
              </p>
              <p className="text-xs text-slate-500 mt-1">
                限制: {users.length * 2} GB
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center">
              <MemoryStick className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </div>
      </div>

      {/* 用户列表 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">用户列表</h3>
            <div className="flex gap-2">
              <select className="px-3 py-2 text-sm border border-slate-300 rounded-lg">
                <option value="all">所有用户</option>
                <option value="running">运行中</option>
                <option value="stopped">已停止</option>
              </select>
              <button className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                <RefreshCw className="w-4 h-4" />
                刷新
              </button>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">用户名</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">Server 名称</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">状态</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">节点</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">内存占用</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">CPU</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">运行时间</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">最后登录</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center">
                          <span className="text-sm font-semibold text-slate-700">
                            {user.username.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-900">{user.username}</p>
                          <p className="text-xs text-slate-600">{user.email}</p>
                          {user.isAdmin && (
                            <span className="inline-block mt-1 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                              管理员
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-sm text-slate-900">{user.serverName}</td>
                    <td className="py-4 px-4">
                      <span className={`px-3 py-1 text-xs rounded-full font-medium ${
                        user.status === 'Running' 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {user.status === 'Running' ? '运行中' : '已停止'}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-sm text-slate-600">{user.node}</td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 w-24 bg-slate-200 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${getHealthColor((user.memory / user.memoryLimit) * 100)}`}
                            style={{ width: `${(user.memory / user.memoryLimit) * 100}%` }}
                          />
                        </div>
                        <span className="text-sm font-medium text-slate-900">
                          {user.memory.toFixed(1)} / {user.memoryLimit} GB
                        </span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-sm text-slate-900">{user.cpu}%</td>
                    <td className="py-4 px-4 text-sm text-slate-600">{user.uptime}</td>
                    <td className="py-4 px-4 text-sm text-slate-600">{user.lastLogin}</td>
                    <td className="py-4 px-4">
                      <div className="flex gap-2">
                        {user.status === 'Running' ? (
                          <button
                            onClick={() => stopUserServer(user.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
                          >
                            <PowerOff className="w-3 h-3" />
                            停止
                          </button>
                        ) : (
                          <button
                            onClick={() => startUserServer(user.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
                          >
                            <Power className="w-3 h-3" />
                            启动
                          </button>
                        )}
                        <button className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors">
                          详情
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 内存使用率警告 */}
      {users.some(u => u.memory / u.memoryLimit >= 0.9) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="text-base font-semibold text-red-900 mb-2">内存使用率警告</h4>
              <p className="text-sm text-red-700">
                以下用户内存使用率已超过 90%，可能触发 OOM：
              </p>
              <ul className="mt-2 space-y-1 text-sm text-red-700">
                {users
                  .filter(u => u.memory / u.memoryLimit >= 0.9)
                  .map(user => (
                    <li key={user.id} className="flex items-center gap-2">
                      <span className="font-medium">{user.username}</span>
                      <span>
                        ({((user.memory / user.memoryLimit) * 100).toFixed(0)}% - {user.memory.toFixed(1)} GB)
                      </span>
                    </li>
                  ))}
              </ul>
              <div className="mt-4 flex gap-2">
                <button className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors">
                  查看详情
                </button>
                <button className="px-4 py-2 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors">
                  发送通知
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 用户操作说明 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">用户操作说明</h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h5 className="text-sm font-medium text-blue-900 mb-2 flex items-center gap-2">
                <Power className="w-4 h-4" />
                启动用户 Server
              </h5>
              <p className="text-xs text-blue-700">
                启动用户的 Jupyter Notebook 容器，系统会自动分配一个计算节点。启动后用户可以访问其 Notebook 环境。
              </p>
            </div>
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <h5 className="text-sm font-medium text-red-900 mb-2 flex items-center gap-2">
                <PowerOff className="w-4 h-4" />
                停止用户 Server
              </h5>
              <p className="text-xs text-red-700">
                停止用户的 Jupyter Notebook 容器，释放资源。用户数据会保留在 NFS 存储中，下次启动时可以恢复。
              </p>
            </div>
          </div>
          <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <h5 className="text-sm font-medium text-yellow-900 mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              注意事项
            </h5>
            <ul className="text-xs text-yellow-700 space-y-1 list-disc list-inside">
              <li>单个用户容器内存限制为 2G，超过限制会被 OOM Killer 终止</li>
              <li>用户空闲 30 分钟后，系统会自动关闭其容器以释放资源</li>
              <li>停止用户 server 不会删除用户数据，数据存储在 NFS 共享存储中</li>
              <li>建议定期监控高内存使用用户，必要时联系用户优化代码</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );

  const renderOperations = () => (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">常用运维命令</h3>
        </div>
        <div className="p-6">
          <div className="space-y-6">
            {/* JupyterHub 服务管理 */}
            <div>
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => toggleSection('services')}
              >
                <h4 className="text-base font-medium text-slate-900 flex items-center gap-2">
                  <Server className="w-5 h-5 text-blue-600" />
                  JupyterHub 服务管理
                </h4>
                {expandedSections.services ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </div>
              {expandedSections.services && (
                <div className="mt-4 space-y-2">
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker stack deploy -c docker-compose.yml jupyterhub</code>
                    <p className="text-xs text-slate-500 mt-1">启动/更新 JupyterHub 服务</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker stack rm jupyterhub</code>
                    <p className="text-xs text-slate-500 mt-1">停止 JupyterHub 服务</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker service ls | grep jupyterhub</code>
                    <p className="text-xs text-slate-500 mt-1">查看服务状态</p>
                  </div>
                </div>
              )}
            </div>

            {/* Docker Swarm 集群管理 */}
            <div>
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => toggleSection('monitoring')}
              >
                <h4 className="text-base font-medium text-slate-900 flex items-center gap-2">
                  <Cpu className="w-5 h-5 text-green-600" />
                  Docker Swarm 集群管理
                </h4>
                {expandedSections.monitoring ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </div>
              {expandedSections.monitoring && (
                <div className="mt-4 space-y-2">
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker node ls</code>
                    <p className="text-xs text-slate-500 mt-1">查看集群节点列表</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker swarm join-token worker</code>
                    <p className="text-xs text-slate-500 mt-1">获取 worker 节点加入令牌</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker node update --label-add role=worker &lt;节点ID&gt;</code>
                    <p className="text-xs text-slate-500 mt-1">为节点添加标签</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <code className="text-sm text-slate-700 block">docker stats</code>
                    <p className="text-xs text-slate-500 mt-1">监控容器资源使用</p>
                  </div>
                </div>
              )}
            </div>

            {/* NFS 存储 */}
            <div>
              <h4 className="text-base font-medium text-slate-900 flex items-center gap-2 mb-4">
                <HardDrive className="w-5 h-5 text-yellow-600" />
                NFS 存储管理
              </h4>
              <div className="space-y-2">
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">showmount -e localhost</code>
                  <p className="text-xs text-slate-500 mt-1">验证 NFS 共享配置（主节点）</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">df -h | grep nfs</code>
                  <p className="text-xs text-slate-500 mt-1">验证 NFS 挂载状态（计算节点）</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">mount -t nfs 10.9.123.235:/nfs/jupyterhub /nfs/jupyterhub</code>
                  <p className="text-xs text-slate-500 mt-1">手动重新挂载 NFS（计算节点）</p>
                </div>
              </div>
            </div>

            {/* 镜像管理 */}
            <div>
              <h4 className="text-base font-medium text-slate-900 flex items-center gap-2 mb-4">
                <Package className="w-5 h-5 text-purple-600" />
                镜像管理
              </h4>
              <div className="space-y-2">
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">docker images</code>
                  <p className="text-xs text-slate-500 mt-1">查看本地镜像</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">docker save myjupyterhub:latest my-scipy-notebook:latest -o full-jupyterhub-stack.tar</code>
                  <p className="text-xs text-slate-500 mt-1">打包镜像</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">docker load -i full-jupyterhub-stack.tar</code>
                  <p className="text-xs text-slate-500 mt-1">加载镜像</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <code className="text-sm text-slate-700 block">docker image prune -a -f</code>
                  <p className="text-xs text-slate-500 mt-1">清理无用镜像（谨慎）</p>
                </div>
              </div>
            </div>

            {/* 镜像列表 */}
            <div>
              <h4 className="text-base font-medium text-slate-900 mb-4">当前镜像</h4>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">镜像名称</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">标签</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">大小</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {images.map((image, idx) => (
                      <tr key={idx} className="border-b border-slate-100">
                        <td className="py-3 px-4 text-sm text-slate-900">{image.name}</td>
                        <td className="py-3 px-4 text-sm text-slate-600">{image.tag}</td>
                        <td className="py-3 px-4 text-sm text-slate-900">{image.size}</td>
                        <td className="py-3 px-4 text-sm text-slate-600">{image.createdAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 运维优化建议 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">运维优化建议</h3>
        </div>
        <div className="p-6">
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <CheckCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-blue-900">修正部署文档笔误</p>
                <p className="text-xs text-blue-700 mt-1">
                  修正计算节点的软链接命令为 ln -s /nfs/jupyterhub/share /opt/py_package/share
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <Activity className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-green-900">配置监控告警</p>
                <p className="text-xs text-green-700 mt-1">
                  部署 Prometheus+Grafana 监控，CPU &gt; 80%、内存 &gt; 85%、磁盘 &gt; 90% 时触发告警
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <Database className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-yellow-900">NFS 容灾优化</p>
                <p className="text-xs text-yellow-700 mt-1">
                  配置 NFS 数据定期备份（如每天备份 /nfs/jupyterhub/user 用户数据）
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 bg-purple-50 border border-purple-200 rounded-lg">
              <Terminal className="w-5 h-5 text-purple-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-purple-900">统一节点操作脚本</p>
                <p className="text-xs text-purple-700 mt-1">
                  将常用运维操作编写为 shell 脚本，放在 /usr/local/bin 下
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <Settings className="w-5 h-5 text-slate-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-slate-900">配置文件版本管理</p>
                <p className="text-xs text-slate-700 mt-1">
                  将核心配置文件纳入 Git 版本管理，便于追溯和回滚
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return renderDashboard();
      case 'services':
        return renderServices();
      case 'nodes':
        return renderNodes();
      case 'users':
        return renderUsers();
      case 'nfs':
        return renderNFS();
      case 'resources':
        return renderResources();
      case 'logs':
        return renderLogs();
      case 'operations':
        return renderOperations();
      default:
        return renderDashboard();
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/* 刷新成功 Toast 提示 */}
      {refreshToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg shadow-lg">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm font-medium">数据刷新成功</span>
        </div>
      )}
      {renderSidebar()}
      <div className="flex-1 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">
            {activeTab === 'dashboard' && '运维仪表盘'}
            {activeTab === 'services' && '服务管理'}
            {activeTab === 'nodes' && '节点管理'}
            {activeTab === 'users' && '用户管理'}
            {activeTab === 'nfs' && 'NFS 存储管理'}
            {activeTab === 'resources' && '资源监控 & OOM 防控'}
            {activeTab === 'logs' && '日志查看'}
            {activeTab === 'operations' && '运维操作'}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            基于 Docker Swarm + NFS 的 JupyterHub 集群运维平台
          </p>
        </div>
        {renderContent()}
      </div>
    </div>
  );
}
