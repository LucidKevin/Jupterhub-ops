'use client';

import { useState, useEffect, useCallback, useRef, type FormEvent, type ReactNode } from 'react';
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
  Wifi,
  Search,
} from 'lucide-react';
import {
  CLEANUP_THRESHOLD_OPTIONS,
  DASHBOARD_NODE_PLACEHOLDERS,
  DASHBOARD_REFRESH_INTERVAL_MS,
  DEFAULT_CLEANUP_THRESHOLD,
  TOAST_HIDE_DELAY_MS,
  type CleanupThreshold,
} from '@/config/dashboard';
import {
  SERVICE_CONFIG_FILES,
  SERVICE_LOG_FILES,
  SERVICE_MANAGE_SCRIPTS,
} from '@/config/service';
import { MANAGER_NODE, NFS_CONFIG } from '@/config/cluster';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { USER_SERVICE_LOGS } from '@/config/service';
import { swarmServiceNameFromContainerName } from '@/lib/swarm-service-name';
import { sortLogLinesAscending } from '@/lib/docker-log-line-utils';

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

interface UserEntry {
  username: string;
  admin: boolean;
  status: 'running' | 'stopped';
  containerName: string | null;
  node: string | null;
  cpuPercent: number;
  memUsageMiB: number;
  memLimitMiB: number;
  lastActivity: string | null;
}

interface UserStatsData {
  totalUsers: number;
  runningUsers: number;
  stoppedUsers: number;
  workerMemTotalGB: number;
  workerMemUsedGB: number;
  users: UserEntry[];
}

interface CleanupPreviewUser {
  username: string;
  lastActivity: string | null;
  daysIdle: number;
  admin: boolean;
}

interface CleanupResult {
  username: string;
  success: boolean;
  message: string;
}

type LogLevel = 'all' | 'INFO' | 'WARNING' | 'ERROR';

interface LogEntry {
  line: string;
  level: 'INFO' | 'WARNING' | 'ERROR';
}

interface LogDateOption {
  key: 'today' | string; // today | YYYYMMDD
  label: string;         // 今天 | YYYY-MM-DD
  iso: string;           // YYYY-MM-DD
  filename: string;      // server-side path (for display only)
}

interface AuthUser {
  username: string;
  isAdmin: boolean;
}

/** 用户 Swarm 服务日志行级别（与 logcheck 规则一致，支持 task 前缀 + `| [I/W/E ...]`） */
function detectUserServiceLogLineLevel(line: string): 'INFO' | 'WARNING' | 'ERROR' {
  const upperLine = line.toUpperCase();
  if (/\[\s*E\b/.test(upperLine)) return 'ERROR';
  if (/\[\s*W\b/.test(upperLine)) return 'WARNING';
  if (/\bERROR\b|\bERR\b|\[ERROR\]/.test(upperLine)) return 'ERROR';
  if (/\bWARNING\b|\bWARN\b|\[WARNING\]|\[WARN\]/.test(upperLine)) return 'WARNING';
  return 'INFO';
}

function highlightLogLine(line: string, q: string): ReactNode {
  const qq = q.trim().toLowerCase();
  if (!qq) return line;
  const lower = line.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let i = lower.indexOf(qq, start);
  let key = 0;
  while (i >= 0) {
    parts.push(line.slice(start, i));
    parts.push(
      <mark key={`m${key++}`} className="rounded-sm bg-yellow-200 px-0.5">
        {line.slice(i, i + qq.length)}
      </mark>
    );
    start = i + qq.length;
    i = lower.indexOf(qq, start);
  }
  parts.push(line.slice(start));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function buildApiUrl(path: string): string {
  const APP_BASE_PATH = '/ops';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath.startsWith(`${APP_BASE_PATH}/`)) return normalizedPath;
  return `${APP_BASE_PATH}${normalizedPath}`;
}

export default function JupyterHubDashboard() {
  const [authChecking, setAuthChecking] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
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
  const [totalContainers, setTotalContainers] = useState<number | null>(null);
  const [avgCpu, setAvgCpu] = useState<number | null>(null);      // 来自 node-metrics API
  const [avgMemory, setAvgMemory] = useState<number | null>(null); // 来自 node-metrics API
  const [metricsLoading, setMetricsLoading] = useState(true);
  // 刷新成功 toast 提示（true 时显示，3 秒后自动隐藏）
  const [refreshToast, setRefreshToast] = useState(false);
  /**
   * 节点列表 —— 以 DASHBOARD_NODE_CONFIG 为初始值（静态占位），
   * 页面加载后由 /api/dashboard/cluster-nodes 和 /api/dashboard/node-metrics 的数据更新。
   */
  const [nodes, setNodes] = useState<NodeData[]>(DASHBOARD_NODE_PLACEHOLDERS);

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
        fetch(buildApiUrl('/api/dashboard/cluster-nodes')).then((r) => r.json()),
        fetch(buildApiUrl('/api/dashboard/running-containers')).then((r) => r.json()),
        fetch(buildApiUrl('/api/dashboard/node-metrics')).then((r) => r.json()),
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
        setTotalContainers(nodesRes.value.totalContainers);
        // running-containers 接口失败时，运行容器数兜底使用 cluster-nodes 的 totalContainers
        if (!(containersRes.status === 'fulfilled' && !containersRes.value.error)) {
          setRunningContainers(nodesRes.value.totalContainers);
        }
      }
      if (containersRes.status === 'fulfilled' && !containersRes.value.error) {
        // 运行中/已停止容器统一使用 running-containers 接口口径（JupyterHub users API）
        setRunningContainers(containersRes.value.runningContainers);
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
      const merged: NodeData[] = DASHBOARD_NODE_PLACEHOLDERS.map((base) => {
        const cn = clusterNodes.find((n: { ip: string }) => n.ip === base.ip);
        const m = metricsNodes.find((n: { ip: string }) => n.ip === base.ip);
        return {
          id: cn?.id ?? base.id,
          name: base.name,
          role: base.role,
          status: cn?.status ?? '未知',
          cpu: m?.cpuUsage ?? 0,
          memory: m?.memoryUsage ?? 0,
          disk: m?.diskUsage ?? 0,
          ip: base.ip,
          containers: cn?.containers ?? base.containers,
          labels: base.labels,
        };
      });
      setNodes(merged);

      // 刷新成功，3 秒后自动隐藏提示
      setRefreshToast(true);
      setTimeout(() => setRefreshToast(false), TOAST_HIDE_DELAY_MS);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    fetch(buildApiUrl('/api/auth/me'), { cache: 'no-store' })
      .then(async (res) => {
        if (!mounted) return;
        if (!res.ok) {
          setAuthUser(null);
          return;
        }
        const data = (await res.json()) as AuthUser;
        setAuthUser(data);
      })
      .catch(() => {
        if (mounted) setAuthUser(null);
      })
      .finally(() => {
        if (mounted) setAuthChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // 页面加载后立即拉取，并每 30 秒自动刷新一次
  useEffect(() => {
    if (!authUser) return;
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, DASHBOARD_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [authUser, fetchDashboardData]);

  // 模拟数据 - 集群状态（用于侧边栏显示）
  const clusterStatus = {
    totalNodes: totalNodes ?? 4,
    managerNode: managerNodes,
    workerNodes: workerNodes,
    onlineNodes: totalNodes ?? 4,
    offlineNodes: 0,
    totalContainers: totalContainers ?? ((runningContainers ?? 0) + stoppedContainers),
    runningContainers: runningContainers ?? 0,
    stoppedContainers,
  };

  // 服务管理状态
  const [serviceConfig, setServiceConfig] = useState<{ compose: string | null; hubConfig: string | null } | null>(null);
  const [serviceConfigLoading, setServiceConfigLoading] = useState(false);
  const [serviceAction, setServiceAction] = useState<'idle' | 'starting' | 'stopping' | 'restarting'>('idle');
  const [serviceResult, setServiceResult] = useState<{ success: boolean; output: string; error?: string } | null>(null);
  const [activeConfigTab, setActiveConfigTab] = useState<'compose' | 'hubConfig'>('compose');

  // 用户管理实时数据
  const [userStatsData, setUserStatsData] = useState<UserStatsData | null>(null);
  const [userStatsLoading, setUserStatsLoading] = useState(false);
  const [userNodeFilter, setUserNodeFilter] = useState<'all' | string>('all');

  const userLogScrollRef = useRef<HTMLDivElement>(null);
  const userLogInitialScrollDone = useRef(false);

  const [userLogSheetOpen, setUserLogSheetOpen] = useState(false);
  const [userLogTarget, setUserLogTarget] = useState<{
    username: string;
    service: string;
    containerName: string;
  } | null>(null);
  const [userLogBrowseLines, setUserLogBrowseLines] = useState<string[]>([]);
  const [userLogHasMoreOlder, setUserLogHasMoreOlder] = useState(false);
  const [userLogNextOlderUntil, setUserLogNextOlderUntil] = useState<string | null>(null);
  const [userLogBrowseLoading, setUserLogBrowseLoading] = useState(false);
  const [userLogBrowseLoadingOlder, setUserLogBrowseLoadingOlder] = useState(false);
  const [userLogBrowseError, setUserLogBrowseError] = useState<string | null>(null);
  /** 仅「向上加载更早」失败时使用，避免首屏已有日志仍显示全局 docker 失败 */
  const [userLogOlderError, setUserLogOlderError] = useState<string | null>(null);
  const [userLogSheetLevel, setUserLogSheetLevel] = useState<LogLevel>('all');
  const [userLogResolvedService, setUserLogResolvedService] = useState<string | null>(null);
  const [userLogBrowseDiagnostics, setUserLogBrowseDiagnostics] = useState<string | null>(null);
  const [userLogOlderRequests, setUserLogOlderRequests] = useState(0);
  const [userLogEndOfHistory, setUserLogEndOfHistory] = useState(false);

  const [userLogSearchInput, setUserLogSearchInput] = useState('');
  const [userLogSearchDebounced, setUserLogSearchDebounced] = useState('');
  const [userLogSearchMatches, setUserLogSearchMatches] = useState<string[] | null>(null);
  const [userLogSearchLoading, setUserLogSearchLoading] = useState(false);
  const [userLogSearchError, setUserLogSearchError] = useState<string | null>(null);
  const [userLogSearchMeta, setUserLogSearchMeta] = useState<{
    truncated: boolean;
    scanned: number;
    matchCount: number;
  } | null>(null);

  // 日志查看
  const [logLevel, setLogLevel] = useState<LogLevel>('all');
  const [logDateOptions, setLogDateOptions] = useState<LogDateOption[]>([]);
  const [logDate, setLogDate] = useState<'today' | string>('today');
  const [logLineLimit, setLogLineLimit] = useState<number>(300);
  const [hubLogSearchInput, setHubLogSearchInput] = useState('');
  const [hubLogSearchQ, setHubLogSearchQ] = useState('');
  const [logsData, setLogsData] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsSource, setLogsSource] = useState<string | null>(null);
  const [hubLogSearchMeta, setHubLogSearchMeta] = useState<{
    matchTotal: number;
    truncated: boolean;
    cap: number;
  } | null>(null);

  // 切换到用户管理 tab 时懒加载用户数据（避免在 render 阶段 setState）
  useEffect(() => {
    if (activeTab !== 'users' || userStatsData || userStatsLoading) return;
    setUserStatsLoading(true);
    fetch(buildApiUrl('/api/dashboard/user-stats'))
      .then((r) => r.json())
      .then((data: UserStatsData) => setUserStatsData(data))
      .catch(() => setUserStatsData({ totalUsers: 0, runningUsers: 0, stoppedUsers: 0, workerMemTotalGB: 0, workerMemUsedGB: 0, users: [] }))
      .finally(() => setUserStatsLoading(false));
  }, [activeTab, userStatsData, userStatsLoading]);

  const fetchLogDates = useCallback(async () => {
    try {
      const res = await fetch(buildApiUrl('/api/logcheck/dates'), { cache: 'no-store' });
      const data = await res.json();
      const options: LogDateOption[] = Array.isArray(data.options) ? data.options : [];
      setLogDateOptions(options);
      // 若当前选中的 key 不在列表内，则回退到 today
      if (options.length > 0 && !options.some((o) => o.key === logDate)) {
        setLogDate('today');
      }
    } catch {
      setLogDateOptions([{ key: 'today', label: '今天', iso: '', filename: '' }]);
      setLogDate('today');
    }
  }, [logDate]);

  useEffect(() => {
    const t = setTimeout(() => setHubLogSearchQ(hubLogSearchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [hubLogSearchInput]);

  const fetchLogs = useCallback(async (level: LogLevel, dateKey: string, limitLines: number, searchQ: string) => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const safeLimit = Number.isFinite(limitLines) ? Math.min(Math.max(limitLines, 1), 2000) : 300;
      const query = new URLSearchParams({ level, limit: String(safeLimit), date: dateKey });
      if (searchQ) query.set('q', searchQ);
      const res = await fetch(buildApiUrl(`/api/logcheck?${query.toString()}`), {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.message || data.error || '日志加载失败');
      }
      setLogsData(Array.isArray(data.entries) ? data.entries : []);
      setLogsSource(typeof data.source === 'string' ? data.source : null);
      if (searchQ && typeof data.searchMatchTotal === 'number') {
        setHubLogSearchMeta({
          matchTotal: data.searchMatchTotal,
          truncated: Boolean(data.searchTruncated),
          cap: typeof data.searchResultCap === 'number' ? data.searchResultCap : 10000,
        });
      } else {
        setHubLogSearchMeta(null);
      }
    } catch (error) {
      setLogsError(error instanceof Error ? error.message : '日志加载失败');
      setLogsData([]);
      setLogsSource(null);
      setHubLogSearchMeta(null);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'logs') return;
    fetchLogDates();
    fetchLogs(logLevel, logDate, logLineLimit, hubLogSearchQ);
  }, [activeTab, logLevel, logDate, logLineLimit, hubLogSearchQ, fetchLogDates, fetchLogs]);

  // 闲置用户清理
  const [cleanupThreshold, setCleanupThreshold] = useState<CleanupThreshold>(DEFAULT_CLEANUP_THRESHOLD);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<{ total: number; affected: CleanupPreviewUser[] } | null>(null);
  const [cleanupResults, setCleanupResults] = useState<CleanupResult[] | null>(null);
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  // 正在执行启动/停止操作的用户名（null 表示无）
  const [userActionLoading, setUserActionLoading] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setUserLogSearchDebounced(userLogSearchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [userLogSearchInput]);

  const fetchUserLogBrowsePage = useCallback(
    async (service: string, opts: { until: string | null }) => {
      const params = new URLSearchParams({
        service,
        tail: String(USER_SERVICE_LOGS.tailDefault),
      });
      if (opts.until) params.set('until', opts.until);
      const res = await fetch(buildApiUrl(`/api/users/service-logs?${params}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || '加载失败');
      return {
        lines: data.lines ?? [],
        hasMoreOlder: Boolean(data.hasMoreOlder),
        nextOlderUntil: data.nextOlderUntil ?? null,
        resolvedService: typeof data.resolvedService === 'string' ? data.resolvedService : null,
        stderrHint: typeof data.stderrHint === 'string' ? data.stderrHint : undefined,
      };
    },
    []
  );

  const openUserServiceLogSheet = useCallback(
    (user: UserEntry) => {
      const service = swarmServiceNameFromContainerName(user.containerName);
      if (!service || user.containerName == null) return;
      userLogInitialScrollDone.current = false;
      setUserLogTarget({ username: user.username, service, containerName: user.containerName });
      setUserLogSearchInput('');
      setUserLogSearchDebounced('');
      setUserLogSearchMatches(null);
      setUserLogSearchMeta(null);
      setUserLogSearchError(null);
      setUserLogOlderRequests(0);
      setUserLogBrowseError(null);
      setUserLogOlderError(null);
      setUserLogEndOfHistory(false);
      setUserLogSheetLevel('all');
      setUserLogBrowseDiagnostics(null);
      setUserLogResolvedService(null);
      setUserLogBrowseLines([]);
      setUserLogHasMoreOlder(false);
      setUserLogNextOlderUntil(null);
      setUserLogSheetOpen(true);
      setUserLogBrowseLoading(true);
      fetchUserLogBrowsePage(service, { until: null })
        .then((r) => {
          setUserLogBrowseError(null);
          setUserLogBrowseLines(sortLogLinesAscending(r.lines));
          setUserLogHasMoreOlder(r.hasMoreOlder);
          setUserLogNextOlderUntil(r.nextOlderUntil);
          setUserLogResolvedService(r.resolvedService ?? service);
          setUserLogBrowseDiagnostics(
            r.lines.length === 0 && r.stderrHint ? r.stderrHint : null
          );
        })
        .catch((e) => {
          setUserLogBrowseError(e instanceof Error ? e.message : '加载失败');
        })
        .finally(() => setUserLogBrowseLoading(false));
    },
    [fetchUserLogBrowsePage]
  );

  const loadUserLogOlder = useCallback(async () => {
    if (!userLogTarget || !userLogNextOlderUntil || userLogBrowseLoadingOlder || !userLogHasMoreOlder)
      return;
    if (userLogOlderRequests >= USER_SERVICE_LOGS.browseMaxOlderRequests) return;

    const el = userLogScrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;

    setUserLogBrowseLoadingOlder(true);
    setUserLogOlderError(null);
    try {
      const r = await fetchUserLogBrowsePage(userLogTarget.service, {
        until: userLogNextOlderUntil,
      });
      if (r.lines.length === 0) {
        setUserLogEndOfHistory(true);
        setUserLogHasMoreOlder(false);
        setUserLogNextOlderUntil(null);
        return;
      }
      setUserLogEndOfHistory(false);
      setUserLogBrowseLines((prev) =>
        sortLogLinesAscending(Array.from(new Set([...r.lines, ...prev])))
      );
      setUserLogHasMoreOlder(r.hasMoreOlder);
      setUserLogNextOlderUntil(r.nextOlderUntil);
      setUserLogOlderRequests((n) => n + 1);
      requestAnimationFrame(() => {
        const e = userLogScrollRef.current;
        if (e) e.scrollTop = e.scrollHeight - prevScrollHeight + prevScrollTop;
      });
    } catch (e) {
      setUserLogOlderError(e instanceof Error ? e.message : '加载更早日志失败');
    } finally {
      setUserLogBrowseLoadingOlder(false);
    }
  }, [
    userLogTarget,
    userLogNextOlderUntil,
    userLogBrowseLoadingOlder,
    userLogHasMoreOlder,
    userLogOlderRequests,
    fetchUserLogBrowsePage,
  ]);

  const handleUserLogScroll = useCallback(() => {
    const el = userLogScrollRef.current;
    if (!el || userLogSearchDebounced) return;
    if (el.scrollTop > 56) return;
    void loadUserLogOlder();
  }, [userLogSearchDebounced, loadUserLogOlder]);

  useEffect(() => {
    if (!userLogSheetOpen || !userLogTarget) return;
    const q = userLogSearchDebounced;
    if (!q) {
      setUserLogSearchMatches(null);
      setUserLogSearchMeta(null);
      setUserLogSearchError(null);
      setUserLogSearchLoading(false);
      return;
    }
    let cancelled = false;
    setUserLogSearchLoading(true);
    setUserLogSearchError(null);
    const params = new URLSearchParams({
      service: userLogTarget.service,
      q,
    });
    fetch(buildApiUrl(`/api/users/service-logs/search?${params}`))
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setUserLogSearchMatches(data.matches ?? []);
        setUserLogSearchMeta({
          truncated: Boolean(data.truncated),
          scanned: data.scannedLineCount ?? 0,
          matchCount: data.matchCount ?? 0,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setUserLogSearchError(e instanceof Error ? e.message : '搜索失败');
        setUserLogSearchMatches(null);
        setUserLogSearchMeta(null);
      })
      .finally(() => {
        if (!cancelled) setUserLogSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userLogSheetOpen, userLogTarget, userLogSearchDebounced]);

  useEffect(() => {
    if (!userLogSheetOpen || userLogSearchDebounced) return;
    if (userLogBrowseLoading || userLogBrowseLines.length === 0) return;
    if (userLogInitialScrollDone.current) return;
    const el = userLogScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      userLogInitialScrollDone.current = true;
    }
  }, [userLogSheetOpen, userLogSearchDebounced, userLogBrowseLoading, userLogBrowseLines]);

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
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'dashboard' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <LayoutDashboard className="w-5 h-5" />
          <span>仪表盘</span>
        </button>

        <button
          onClick={() => setActiveTab('services')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'services' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <Server className="w-5 h-5" />
          <span>服务管理</span>
        </button>

        <button
          onClick={() => setActiveTab('nodes')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'nodes' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <Cpu className="w-5 h-5" />
          <span>节点管理</span>
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'users' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <Users className="w-5 h-5" />
          <span>用户管理</span>
        </button>

        <button
          onClick={() => setActiveTab('nfs')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'nfs' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <HardDrive className="w-5 h-5" />
          <span>NFS 存储</span>
        </button>

        <button
          onClick={() => setActiveTab('resources')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'resources' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <MemoryStick className="w-5 h-5" />
          <span>资源监控 & OOM</span>
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'logs' ? 'bg-blue-600' : 'hover:bg-slate-800'
            }`}
        >
          <FileText className="w-5 h-5" />
          <span>日志查看</span>
        </button>

        <button
          onClick={() => setActiveTab('operations')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'operations' ? 'bg-blue-600' : 'hover:bg-slate-800'
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
      fetch(buildApiUrl('/api/servicemanage/config'))
        .then((r) => r.json())
        .then((data) => setServiceConfig(data))
        .catch(() => setServiceConfig({ compose: null, hubConfig: null }))
        .finally(() => setServiceConfigLoading(false));
    }

    const handleAction = async (action: 'start' | 'stop' | 'restart') => {
      setServiceAction(action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting');
      setServiceResult(null);
      try {
        const res = await fetch(buildApiUrl('/api/servicemanage/action'), {
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
    const actionDisabled = true;
    const configContent = activeConfigTab === 'compose' ? serviceConfig?.compose : serviceConfig?.hubConfig;
    const configLabel = activeConfigTab === 'compose' ? 'docker-compose.yml' : 'jupyterhub_config.py';
    const configPath = activeConfigTab === 'compose'
      ? SERVICE_CONFIG_FILES.compose
      : SERVICE_CONFIG_FILES.hubConfig;

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
                  disabled={actionBusy || actionDisabled}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-60">
                  <Power className="w-4 h-4" />
                  {serviceAction === 'starting' ? '启动中...' : '启动服务'}
                </button>
                <button
                  onClick={() => handleAction('restart')}
                  disabled={actionBusy || actionDisabled}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-60">
                  <RefreshCw className={`w-4 h-4 ${serviceAction === 'restarting' ? 'animate-spin' : ''}`} />
                  {serviceAction === 'restarting' ? '重启中...' : '重启服务'}
                </button>
                <button
                  onClick={() => handleAction('stop')}
                  disabled={actionBusy || actionDisabled}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-60">
                  <PowerOff className="w-4 h-4" />
                  {serviceAction === 'stopping' ? '停止中...' : '停止服务'}
                </button>
              </div>
            </div>
            {actionDisabled && (
              <p className="text-xs text-slate-500 mt-3">当前环境已禁用服务启停操作</p>
            )}
          </div>

          {/* 操作结果输出 */}
          {serviceResult && (
            <div className={`mx-6 mt-4 p-4 rounded-lg border text-sm ${serviceResult.success
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
              <p>启动脚本：<code className="bg-slate-100 px-1 rounded">{SERVICE_MANAGE_SCRIPTS.start}</code></p>
              <p>停止脚本：<code className="bg-slate-100 px-1 rounded">{SERVICE_MANAGE_SCRIPTS.stop}</code></p>
              <p>重启脚本：<code className="bg-slate-100 px-1 rounded">{SERVICE_MANAGE_SCRIPTS.restart}</code></p>
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
              <h4 className="text-base font-medium text-slate-900 mb-4">
                NFS 服务端 ({MANAGER_NODE.ip})
              </h4>
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
                  {`${MANAGER_NODE.ip}:${NFS_CONFIG.exportPath}`}
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
              <select
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                {(logDateOptions.length > 0 ? logDateOptions : [{ key: 'today', label: '今天', iso: '', filename: '' }]).map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <input
                type="search"
                value={hubLogSearchInput}
                onChange={(e) => setHubLogSearchInput(e.target.value)}
                placeholder="搜索关键词"
                className="min-w-[140px] flex-1 max-w-xs px-3 py-2 text-sm border border-slate-300 rounded-lg"
                aria-label="JupyterHub 日志搜索"
              />
              <select
                value={String(logLineLimit)}
                onChange={(e) => setLogLineLimit(parseInt(e.target.value, 10) || 300)}
                disabled={Boolean(hubLogSearchQ)}
                title={hubLogSearchQ ? '有搜索词时按整文件匹配，不再用条数截取' : undefined}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="100">100 行</option>
                <option value="300">300 行</option>
                <option value="500">500 行</option>
                <option value="1000">1000 行</option>
                <option value="2000">2000 行</option>
              </select>
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value as LogLevel)}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                <option value="all">所有日志</option>
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="ERROR">ERROR</option>
              </select>
              <button
                onClick={() => fetchLogs(logLevel, logDate, logLineLimit, hubLogSearchQ)}
                disabled={logsLoading}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${logsLoading ? 'animate-spin' : ''}`} />
                {logsLoading ? '刷新中...' : '刷新'}
              </button>
              <a
                href={buildApiUrl(
                  `/api/logcheck?level=${encodeURIComponent(logLevel)}&limit=${encodeURIComponent(String(logLineLimit))}&date=${encodeURIComponent(logDate)}${hubLogSearchQ ? `&q=${encodeURIComponent(hubLogSearchQ)}` : ''}&download=1`
                )}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-600 text-white rounded-lg hover:bg-slate-700"
              >
                下载
              </a>
            </div>
          </div>
          {hubLogSearchQ && hubLogSearchMeta ? (
            <div className="px-6 pb-2 text-xs text-slate-600">
              已在当前日志文件中全文匹配 <strong>{hubLogSearchMeta.matchTotal}</strong> 条
              {hubLogSearchMeta.truncated ? (
                <span className="text-amber-700">
                  {' '}
                  （页面最多展示末尾 {hubLogSearchMeta.cap} 条；下载最多 5 万条）
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="p-6">
          <div className="bg-slate-900 text-slate-100 rounded-lg p-4 font-mono text-sm max-h-[720px] overflow-y-auto">
            {logsError ? (
              <p className="text-red-400">{logsError}</p>
            ) : logsLoading && logsData.length === 0 ? (
              <p className="text-slate-400">日志加载中...</p>
            ) : logsData.length === 0 ? (
              <p className="text-slate-400">暂无日志数据</p>
            ) : (
              <div className="space-y-1">
                {logsData.map((entry, idx) => {
                  const levelClass =
                    entry.level === 'ERROR'
                      ? 'text-red-400'
                      : entry.level === 'WARNING'
                        ? 'text-yellow-400'
                        : 'text-blue-400';
                  return (
                    <p key={`${idx}-${entry.line.slice(0, 80)}`} className={`${levelClass} whitespace-pre-wrap break-words`}>
                      {entry.line}
                    </p>
                  );
                })}
              </div>
            )}
          </div>
          <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
            <p className="text-xs text-slate-600">
              <strong>日志文件位置:</strong> {logsSource ?? SERVICE_LOG_FILES.jupyterhub}<br />
              <strong>日志轮转:</strong> 保留 15 天，配置文件: {SERVICE_LOG_FILES.logrotateConfig}
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderUsers = () => {
    const doFetchUserStats = () => {
      setUserStatsLoading(true);
      fetch(buildApiUrl('/api/dashboard/user-stats'))
        .then((r) => r.json())
        .then((data: UserStatsData) => setUserStatsData(data))
        .catch(() => { })
        .finally(() => setUserStatsLoading(false));
    };

    const handleCleanupPreview = async () => {
      setCleanupLoading(true);
      setCleanupPreview(null);
      setCleanupResults(null);
      setCleanupConfirming(false);
      try {
        const res = await fetch(buildApiUrl('/api/users/cleanup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thresholdDays: cleanupThreshold, dryRun: true }),
        });
        const data = await res.json();
        setCleanupPreview({ total: data.total, affected: data.affected ?? [] });
      } catch {
        setCleanupPreview({ total: 0, affected: [] });
      } finally {
        setCleanupLoading(false);
      }
    };

    const handleCleanupExecute = async () => {
      setCleanupLoading(true);
      setCleanupConfirming(false);
      try {
        const res = await fetch(buildApiUrl('/api/users/cleanup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thresholdDays: cleanupThreshold, dryRun: false }),
        });
        const data = await res.json();
        setCleanupResults(data.results ?? []);
        doFetchUserStats();
      } catch {
        setCleanupResults([]);
      } finally {
        setCleanupLoading(false);
      }
    };

    const users = (userStatsData?.users ?? []).slice().sort((a, b) => b.memUsageMiB - a.memUsageMiB);
    const runningUsers = users.filter((u) => u.status === 'running' && u.node);
    const nodeOptions = Array.from(new Set(runningUsers.map((u) => u.node))).filter(Boolean) as string[];
    const visibleUsers =
      userNodeFilter === 'all'
        ? runningUsers
        : runningUsers.filter((u) => u.node === userNodeFilter);
    const usedMemGB = userStatsData?.workerMemUsedGB ?? 0;
    const totalMemGB = userStatsData?.workerMemTotalGB ?? 0;
    const userLogSearchDays = Math.max(1, Math.round(USER_SERVICE_LOGS.searchSinceHours / 24));

    return (
      <>
      <div className="space-y-6">
        {/* 用户统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white rounded-xl shadow-sm p-6 border border-slate-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">总用户数</p>
                <p className="text-3xl font-bold text-slate-900 mt-2">
                  {userStatsLoading && !userStatsData ? '…' : (userStatsData?.totalUsers ?? '—')}
                </p>
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
                  {userStatsLoading && !userStatsData ? '…' : (userStatsData?.runningUsers ?? '—')}
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
                  {userStatsLoading && !userStatsData ? '…' : (userStatsData?.stoppedUsers ?? '—')}
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
                <p className="text-sm font-medium text-slate-600">Worker 内存使用</p>
                <p className="text-3xl font-bold text-slate-900 mt-2">
                  {userStatsLoading && !userStatsData ? '…' : `${usedMemGB.toFixed(1)} GB`}
                </p>
                <p className="text-xs text-slate-500 mt-1">共 {totalMemGB.toFixed(1)} GB</p>
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
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <h3 className="text-lg font-semibold text-slate-900 min-w-0">用户列表</h3>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                <span className="text-xs font-medium text-slate-500 whitespace-nowrap">节点</span>
                <Select value={userNodeFilter} onValueChange={setUserNodeFilter}>
                  <SelectTrigger className="h-9 w-[7.5rem] sm:w-36 rounded-lg border-slate-200 bg-slate-50 text-slate-800 text-sm shadow-sm hover:bg-white focus:ring-2 focus:ring-blue-500/25 data-[placeholder]:text-slate-500 [&_[data-slot=select-value]]:truncate [&_[data-slot=select-value]]:text-left">
                    <SelectValue placeholder="全部" />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    sideOffset={6}
                    className="rounded-xl border border-slate-200 bg-white p-1 shadow-lg min-w-[var(--radix-select-trigger-width)] max-w-[min(20rem,calc(100vw-2rem))]"
                  >
                    <SelectItem
                      value="all"
                      className="rounded-lg py-2 pl-3 pr-8 text-slate-800 focus:bg-blue-50 focus:text-blue-900 data-[highlighted]:bg-slate-100"
                    >
                      全部节点
                    </SelectItem>
                    {nodeOptions.map((n) => (
                      <SelectItem
                        key={n}
                        value={n}
                        className="rounded-lg py-2 pl-3 pr-8 font-mono text-sm text-slate-800 focus:bg-blue-50 focus:text-blue-900 data-[highlighted]:bg-slate-100"
                      >
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  onClick={doFetchUserStats}
                  disabled={userStatsLoading}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
                >
                  <RefreshCw className={`w-4 h-4 ${userStatsLoading ? 'animate-spin' : ''}`} />
                  {userStatsLoading ? '刷新中...' : '刷新'}
                </button>
              </div>
            </div>
          </div>
          <div className="p-6">
            {userStatsLoading && !userStatsData ? (
              <div className="text-sm text-slate-400 text-center py-8">加载用户数据中...</div>
            ) : visibleUsers.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">暂无该节点运行中用户数据</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">用户名</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">容器名称</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">状态</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">节点</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">内存占用</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">CPU</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">最后活跃</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-slate-600">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((user) => (
                      <tr key={user.username} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center">
                              <span className="text-sm font-semibold text-slate-700">
                                {user.username.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-medium text-slate-900">{user.username}</p>
                              {user.admin && (
                                <span className="inline-block mt-0.5 px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                                  管理员
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-xs text-slate-500 font-mono">
                          {user.containerName ?? '—'}
                        </td>
                        <td className="py-4 px-4">
                          <span className={`px-3 py-1 text-xs rounded-full font-medium ${user.status === 'running'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                            }`}>
                            {user.status === 'running' ? '运行中' : '已停止'}
                          </span>
                        </td>
                        <td className="py-4 px-4 text-sm text-slate-600">{user.node ?? '—'}</td>
                        <td className="py-4 px-4">
                          {user.status === 'running' && user.memLimitMiB > 0 ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-slate-200 rounded-full h-2 min-w-[80px]">
                                  <div
                                    className={`h-2 rounded-full ${getHealthColor((user.memUsageMiB / user.memLimitMiB) * 100)}`}
                                    style={{ width: `${Math.min((user.memUsageMiB / user.memLimitMiB) * 100, 100)}%` }}
                                  />
                                </div>
                                <span className="text-xs text-slate-500 whitespace-nowrap">
                                  {((user.memUsageMiB / user.memLimitMiB) * 100).toFixed(1)}%
                                </span>
                              </div>
                              <div className="text-xs text-slate-600 whitespace-nowrap">
                                {user.memLimitMiB >= 1024
                                  ? `${(user.memUsageMiB / 1024).toFixed(2)} / ${(user.memLimitMiB / 1024).toFixed(1)} GiB`
                                  : `${Math.round(user.memUsageMiB)} / ${Math.round(user.memLimitMiB)} MiB`}
                              </div>
                            </div>
                          ) : (
                            <span className="text-sm text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-4 px-4 text-sm text-slate-900">
                          {user.status === 'running' ? `${user.cpuPercent.toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-4 px-4 text-sm text-slate-600">
                          {user.lastActivity
                            ? new Date(user.lastActivity).toLocaleString('zh-CN', { hour12: false })
                            : '—'}
                        </td>
                        <td className="py-4 px-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {user.status === 'running' &&
                              user.containerName &&
                              swarmServiceNameFromContainerName(user.containerName) && (
                                <button
                                  type="button"
                                  onClick={() => openUserServiceLogSheet(user)}
                                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
                                >
                                  <FileText className="w-3 h-3" />
                                  日志
                                </button>
                              )}
                            {user.status === 'running' ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  setUserActionLoading(user.username);
                                  await fetch(buildApiUrl('/api/users/server'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'stop', username: user.username }),
                                  });
                                  setUserActionLoading(null);
                                  doFetchUserStats();
                                }}
                                disabled={userActionLoading === user.username}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors disabled:opacity-60"
                              >
                                <PowerOff className="w-3 h-3" />
                                {userActionLoading === user.username ? '停止中…' : '停止'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={async () => {
                                  setUserActionLoading(user.username);
                                  await fetch(buildApiUrl('/api/users/server'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: 'start', username: user.username }),
                                  });
                                  setUserActionLoading(null);
                                  doFetchUserStats();
                                }}
                                disabled={userActionLoading === user.username}
                                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors disabled:opacity-60"
                              >
                                <Power className="w-3 h-3" />
                                {userActionLoading === user.username ? '启动中…' : '启动'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 内存使用率警告 */}
        {visibleUsers.some((u) => u.memLimitMiB > 0 && u.memUsageMiB / u.memLimitMiB >= 0.9) && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-base font-semibold text-red-900 mb-2">内存使用率警告</h4>
                <p className="text-sm text-red-700">以下用户内存使用率已超过 90%，可能触发 OOM：</p>
                <ul className="mt-2 space-y-1 text-sm text-red-700">
                  {visibleUsers
                    .filter((u) => u.memLimitMiB > 0 && u.memUsageMiB / u.memLimitMiB >= 0.9)
                    .map((user) => (
                      <li key={user.username} className="flex items-center gap-2">
                        <span className="font-medium">{user.username}</span>
                        <span>
                          ({((user.memUsageMiB / user.memLimitMiB) * 100).toFixed(1)}% -{' '}
                          {user.memLimitMiB >= 1024
                            ? `${(user.memUsageMiB / 1024).toFixed(2)} / ${(user.memLimitMiB / 1024).toFixed(1)} GiB`
                            : `${Math.round(user.memUsageMiB)} / ${Math.round(user.memLimitMiB)} MiB`})
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* 闲置用户清理 */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-500" />
              <h3 className="text-lg font-semibold text-slate-900">闲置用户清理</h3>
            </div>
            <p className="text-sm text-slate-500 mt-1">停止超过指定天数未活跃用户的 Notebook Server，释放计算资源</p>
          </div>
          <div className="p-6 space-y-4">
            {/* 阈值选择 + 预览按钮 */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-slate-700">闲置超过：</span>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
                {CLEANUP_THRESHOLD_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => {
                      setCleanupThreshold(d);
                      setCleanupPreview(null);
                      setCleanupResults(null);
                      setCleanupConfirming(false);
                    }}
                    className={`px-4 py-2 transition-colors ${cleanupThreshold === d
                      ? 'bg-orange-500 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                  >
                    {d} 天
                  </button>
                ))}
              </div>
              <button
                onClick={handleCleanupPreview}
                disabled={cleanupLoading}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-700 text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${cleanupLoading && !cleanupConfirming ? 'animate-spin' : ''}`} />
                预览受影响用户
              </button>
            </div>

            {/* 预览 / 执行结果 */}
            {cleanupPreview && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">
                    {cleanupPreview.total === 0
                      ? `✓ 无用户超过 ${cleanupThreshold} 天未活跃`
                      : `共 ${cleanupPreview.total} 个用户超过 ${cleanupThreshold} 天未活跃`}
                  </span>
                  {cleanupPreview.total > 0 && !cleanupResults && (
                    cleanupConfirming ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-600 font-medium">
                          确认停止这 {cleanupPreview.total} 个用户的 Server？
                        </span>
                        <button
                          onClick={handleCleanupExecute}
                          disabled={cleanupLoading}
                          className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-60"
                        >
                          {cleanupLoading ? '执行中...' : '确认'}
                        </button>
                        <button
                          onClick={() => setCleanupConfirming(false)}
                          disabled={cleanupLoading}
                          className="px-3 py-1 text-xs bg-slate-200 text-slate-700 rounded hover:bg-slate-300"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setCleanupConfirming(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                      >
                        <PowerOff className="w-3.5 h-3.5" />
                        执行清理
                      </button>
                    )
                  )}
                  {cleanupResults && (
                    <span className="text-xs text-slate-500">
                      {cleanupResults.filter((r) => r.success).length}/{cleanupResults.length} 成功
                    </span>
                  )}
                </div>
                {cleanupPreview.total > 0 && (
                  <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                    {cleanupPreview.affected.map((u) => {
                      const result = cleanupResults?.find((r) => r.username === u.username);
                      return (
                        <div key={u.username} className="px-4 py-3 flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-900">{u.username}</span>
                              {u.admin && (
                                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">管理员</span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">
                              最后活跃：
                              {u.lastActivity
                                ? new Date(u.lastActivity).toLocaleString('zh-CN', { hour12: false })
                                : '从未'}
                              <span className="ml-1 text-orange-600 font-medium">（{u.daysIdle} 天前）</span>
                            </p>
                          </div>
                          {result ? (
                            <span className={`text-xs px-2 py-1 rounded ${result.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                              }`}>
                              {result.message}
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-1 bg-orange-100 text-orange-700 rounded">待停止</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

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

      <Sheet
        open={userLogSheetOpen}
        onOpenChange={(open) => {
          setUserLogSheetOpen(open);
          if (!open) {
            setUserLogTarget(null);
            setUserLogEndOfHistory(false);
            setUserLogOlderError(null);
            userLogInitialScrollDone.current = false;
          }
        }}
      >
        <SheetContent
          side="right"
          className="flex h-full w-full flex-col gap-0 border-slate-200 p-0 sm:max-w-[min(42rem,100vw)]"
        >
          <SheetHeader className="shrink-0 space-y-2 border-b border-slate-200 p-4 text-left">
            <SheetTitle className="text-slate-900">
              用户服务日志{userLogTarget ? ` · ${userLogTarget.username}` : ''}
            </SheetTitle>
            <SheetDescription asChild>
              <div className="text-xs text-slate-500">
                支持关键词搜索与级别筛选；滚动到顶部会自动加载更早日志。
              </div>
            </SheetDescription>
            <div className="relative pt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={userLogSearchInput}
                onChange={(e) => setUserLogSearchInput(e.target.value)}
                placeholder="搜索关键词（服务端全量检索）…"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-medium text-slate-500">级别</span>
              <Select
                value={userLogSheetLevel}
                onValueChange={(v) => setUserLogSheetLevel(v as LogLevel)}
              >
                <SelectTrigger className="h-9 w-40 rounded-lg border-slate-200 bg-white px-3 shadow-sm text-sm">
                  <SelectValue placeholder="选择级别" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                  <SelectItem value="all">所有日志</SelectItem>
                  <SelectItem value="INFO">INFO</SelectItem>
                  <SelectItem value="WARNING">WARNING</SelectItem>
                  <SelectItem value="ERROR">ERROR</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[11px] text-slate-400">与「日志查看」页规则一致，按行内 [I]/[W]/[E] 等筛选</span>
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 flex flex-col bg-slate-50">
            {userLogSearchDebounced ? (
              <div className="flex min-h-0 flex-1 flex-col p-3">
                {userLogSearchLoading && (
                  <p className="text-sm text-slate-500 py-4 text-center">搜索中…</p>
                )}
                {userLogSearchError && (
                  <p className="text-sm text-red-600 py-2 px-1">{userLogSearchError}</p>
                )}
                {!userLogSearchLoading && userLogSearchMatches && (
                  <>
                    {userLogSearchMeta && (
                      <p className="text-xs text-slate-500 mb-2 px-1">
                        命中 {userLogSearchMeta.matchCount} 行（扫描 {userLogSearchMeta.scanned} 行）
                        {userLogSearchMeta.truncated ? '；输出已截断，可能未搜全' : ''}
                      </p>
                    )}
                    <div className="max-h-[70vh] min-h-[200px] flex-1 overflow-auto rounded-lg border border-slate-200 bg-slate-900 p-3">
                      {userLogSearchMatches.length === 0 ? (
                        <p className="text-sm text-slate-400">无匹配行</p>
                      ) : (() => {
                        const filteredSearch =
                          userLogSheetLevel === 'all'
                            ? userLogSearchMatches
                            : userLogSearchMatches.filter(
                                (ln) => detectUserServiceLogLineLevel(ln) === userLogSheetLevel
                              );
                        if (filteredSearch.length === 0) {
                          return (
                            <p className="text-sm text-slate-400">
                              当前级别下无行（可改回「所有日志」）
                            </p>
                          );
                        }
                        return (
                          <div className="space-y-1 font-mono text-[11px] leading-relaxed break-all">
                            {filteredSearch.map((line, idx) => {
                              const lv = detectUserServiceLogLineLevel(line);
                              const levelClass =
                                lv === 'ERROR'
                                  ? 'text-red-400'
                                  : lv === 'WARNING'
                                    ? 'text-yellow-400'
                                    : 'text-blue-400';
                              return (
                                <p key={`${idx}-${line.slice(0, 40)}`} className={levelClass}>
                                  {highlightLogLine(line, userLogSearchDebounced)}
                                </p>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col p-3">
                {userLogBrowseLoading && (
                  <p className="text-sm text-slate-500 py-4 text-center">加载日志…</p>
                )}
                {userLogBrowseError && userLogBrowseLines.length === 0 && (
                  <p className="text-sm text-red-600 py-2 px-1">{userLogBrowseError}</p>
                )}
                {!userLogBrowseLoading && (
                  <>
                    {(userLogBrowseLoadingOlder || userLogHasMoreOlder || userLogOlderError || userLogEndOfHistory) && (
                      <div className="mb-2 flex flex-col items-center gap-1 text-xs text-slate-500">
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          {userLogBrowseLoadingOlder ? (
                            <span>正在加载更早…</span>
                          ) : userLogHasMoreOlder ? (
                            <span>滚到顶部加载更早</span>
                          ) : userLogEndOfHistory ? (
                            <span className="text-slate-400">已到最早日志</span>
                          ) : null}
                          {userLogOlderRequests >= USER_SERVICE_LOGS.browseMaxOlderRequests && (
                            <span className="text-amber-700">已达单次浏览加载上限</span>
                          )}
                        </div>
                        {userLogOlderError && (
                          <p className="text-center text-red-600 text-xs px-2">{userLogOlderError}</p>
                        )}
                      </div>
                    )}
                    <div
                      ref={userLogScrollRef}
                      onScroll={handleUserLogScroll}
                      className="max-h-[70vh] min-h-[240px] flex-1 overflow-auto rounded-lg border border-slate-200 bg-slate-900 p-3"
                    >
                      {userLogBrowseLines.length === 0 ? (
                        <div className="space-y-2 text-sm text-slate-500">
                          <p>暂无日志</p>
                          {userLogBrowseDiagnostics && (
                            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 font-mono break-all">
                              {userLogBrowseDiagnostics}
                            </p>
                          )}
                        </div>
                      ) : (() => {
                        const filteredBrowse =
                          userLogSheetLevel === 'all'
                            ? userLogBrowseLines
                            : userLogBrowseLines.filter(
                                (ln) => detectUserServiceLogLineLevel(ln) === userLogSheetLevel
                              );
                        if (filteredBrowse.length === 0) {
                          return (
                            <p className="text-sm text-slate-400">
                              当前级别下无行（可改回「所有日志」）
                            </p>
                          );
                        }
                        return (
                          <div className="space-y-1 font-mono text-[11px] leading-relaxed break-all">
                            {filteredBrowse.map((line, idx) => {
                              const lv = detectUserServiceLogLineLevel(line);
                              const levelClass =
                                lv === 'ERROR'
                                  ? 'text-red-400'
                                  : lv === 'WARNING'
                                    ? 'text-yellow-400'
                                    : 'text-blue-400';
                              return (
                                <p key={`${idx}-${line.slice(0, 48)}`} className={levelClass}>
                                  {line}
                                </p>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
    );
  };

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
                  <code className="text-sm text-slate-700 block">
                    {`mount -t nfs ${MANAGER_NODE.ip}:${NFS_CONFIG.exportPath} ${NFS_CONFIG.mountPath}`}
                  </code>
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

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await fetch(buildApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '登录失败');
      }
      setAuthUser({ username: data.username, isAdmin: Boolean(data.isAdmin) });
      setLoginPassword('');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await fetch(buildApiUrl('/api/auth/logout'), { method: 'POST' }).catch(() => {});
    setAuthUser(null);
    setLoginPassword('');
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-slate-600">认证检查中...</div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="w-full max-w-md bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
          <h1 className="text-xl font-semibold text-slate-900">JupyterHub Ops 登录</h1>
          <p className="text-sm text-slate-500">使用公司 LDAP 账号登录</p>
          <div className="space-y-2">
            <label className="text-sm text-slate-700">用户名</label>
            <input
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="请输入用户名"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-700">密码</label>
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="请输入密码"
            />
          </div>
          {loginError && <p className="text-sm text-red-600">{loginError}</p>}
          <button
            type="submit"
            disabled={loginLoading || !loginUsername.trim() || !loginPassword}
            className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 text-sm"
          >
            {loginLoading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    );
  }

  if (!authUser.isAdmin) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
          <h1 className="text-xl font-semibold text-slate-900">无权限访问</h1>
          <p className="text-sm text-slate-600">
            当前账号 <span className="font-medium">{authUser.username}</span> 不是 JupyterHub 管理员，无法访问运维平台。
          </p>
          <button
            onClick={handleLogout}
            className="w-full py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 text-sm"
          >
            退出登录
          </button>
        </div>
      </div>
    );
  }

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
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
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
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-600">
              {authUser.username}
              {authUser.isAdmin ? ' (管理员)' : ''}
            </div>
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300"
            >
              退出登录
            </button>
          </div>
        </div>
        {renderContent()}
      </div>
    </div>
  );
}
