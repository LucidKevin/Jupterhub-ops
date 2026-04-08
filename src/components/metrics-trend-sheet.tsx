'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

const APP_BASE = '/ops';

type RangeKey = '1h' | '3h' | '6h' | '1d' | '3d';
type StatKey = 'avg' | 'max';

const RANGE_ORDER: RangeKey[] = ['1h', '3h', '6h', '1d', '3d'];

const RANGE_SEC: Record<RangeKey, number> = {
  '1h': 3600,
  '3h': 3 * 3600,
  '6h': 6 * 3600,
  '1d': 24 * 3600,
  '3d': 3 * 86400,
};

const RANGE_LABEL: Record<RangeKey, string> = {
  '1h': '1 小时',
  '3h': '3 小时',
  '6h': '6 小时',
  '1d': '1 天',
  '3d': '3 天',
};

const STAT_LABEL: Record<StatKey, string> = {
  avg: '平均值',
  max: '峰值',
};

function formatTime(ts: number) {
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface NodePoint {
  ts: number;
  cpu_pct: number;
  cpu_max: number | null;
  mem_pct: number | null;
  mem_max: number | null;
  disk_pct: number | null;
  disk_max: number | null;
}

interface UserPoint {
  ts: number;
  cpu_pct: number;
  cpu_max: number | null;
  mem_usage_mib: number;
  mem_usage_max_mib: number | null;
  mem_limit_mib: number | null;
}

export function MetricsTrendSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'node' | 'user';
  nodeIp?: string;
  username?: string;
}) {
  const { open, onOpenChange, mode, nodeIp, username } = props;
  const [range, setRange] = useState<RangeKey>('1d');
  const [stat, setStat] = useState<StatKey>('avg');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodePoints, setNodePoints] = useState<NodePoint[]>([]);
  const [userPoints, setUserPoints] = useState<UserPoint[]>([]);

  useEffect(() => {
    if (!open) return;
    const now = Math.floor(Date.now() / 1000);
    const from = now - RANGE_SEC[range];
    const params = new URLSearchParams({ from: String(from), to: String(now) });
    let url: string;
    if (mode === 'node' && nodeIp) {
      params.set('ip', nodeIp);
      url = `${APP_BASE}/api/metrics/history/node?${params}`;
    } else if (mode === 'user' && username) {
      params.set('username', username);
      url = `${APP_BASE}/api/metrics/history/user?${params}`;
    } else {
      return;
    }

    setLoading(true);
    setError(null);
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error || '加载失败');
        if (mode === 'node') setNodePoints(Array.isArray(data.points) ? data.points : []);
        else setUserPoints(Array.isArray(data.points) ? data.points : []);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '加载失败');
        setNodePoints([]);
        setUserPoints([]);
      })
      .finally(() => setLoading(false));
  }, [open, mode, nodeIp, username, range]);

  const nodeChartData = useMemo(
    () =>
      nodePoints.map((p) => ({
        t: formatTime(p.ts),
        ts: p.ts,
        'CPU(avg)': p.cpu_pct,
        'CPU(max)': p.cpu_max ?? p.cpu_pct,
        '内存(avg)': p.mem_pct ?? 0,
        '内存(max)': p.mem_max ?? (p.mem_pct ?? 0),
        '磁盘(avg)': p.disk_pct ?? 0,
        '磁盘(max)': p.disk_max ?? (p.disk_pct ?? 0),
      })),
    [nodePoints]
  );

  const userChartData = useMemo(
    () =>
      userPoints.map((p) => ({
        t: formatTime(p.ts),
        ts: p.ts,
        'CPU(avg)': p.cpu_pct,
        'CPU(max)': p.cpu_max ?? p.cpu_pct,
        '内存(avg) GB': Math.round((p.mem_usage_mib / 1024) * 10) / 10,
        '内存(max) GB': Math.round((((p.mem_usage_max_mib ?? p.mem_usage_mib) / 1024) * 10)) / 10,
      })),
    [userPoints]
  );

  const rangeButtons = (
    <div className="flex flex-wrap gap-2">
      {RANGE_ORDER.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setRange(k)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
            range === k
              ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300'
          )}
        >
          {RANGE_LABEL[k]}
        </button>
      ))}
    </div>
  );

  const statButtons = (
    <div className="flex flex-wrap gap-2">
      {(['avg', 'max'] as StatKey[]).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setStat(k)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
            stat === k
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300'
          )}
        >
          {STAT_LABEL[k]}
        </button>
      ))}
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'w-full sm:max-w-2xl overflow-y-auto border-l border-slate-200 bg-slate-50',
          'flex flex-col gap-4 p-6 pt-12'
        )}
      >
        <SheetHeader className="space-y-3 p-0 text-left">
          <SheetTitle className="text-lg font-semibold text-slate-900 pr-8">
            资源趋势
            {mode === 'node' && nodeIp ? ` · ${nodeIp}` : null}
            {mode === 'user' && username ? ` · ${username}` : null}
          </SheetTitle>
          <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm">
            <p className="text-xs text-slate-600 leading-relaxed">
              数据来源：本地 SQLite（cron 调用 <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px]">scripts/collect-metrics.sh</code>{' '}
              写入）。每个数据点为约 45s 内多次采样的均值。
            </p>
          </div>
        </SheetHeader>

        <Card className="gap-0 border-slate-200 bg-white py-0 shadow-sm">
          <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
            <CardTitle className="text-sm font-medium text-slate-800">时间范围</CardTitle>
            <CardDescription className="text-xs">选择要查看的历史区间</CardDescription>
          </CardHeader>
          <CardContent className="px-4 py-3">{rangeButtons}</CardContent>
        </Card>

        <Card className="gap-0 border-slate-200 bg-white py-0 shadow-sm">
          <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
            <CardTitle className="text-sm font-medium text-slate-800">统计口径</CardTitle>
            <CardDescription className="text-xs">点击切换为单线展示：平均值 / 峰值</CardDescription>
          </CardHeader>
          <CardContent className="px-4 py-3">{statButtons}</CardContent>
        </Card>

        {loading ? (
          <Card className="border-slate-200 border-dashed bg-white py-8 shadow-sm">
            <CardContent className="px-4 py-0 text-center text-sm text-slate-500">加载中…</CardContent>
          </Card>
        ) : error ? (
          <Card className="border-red-200 bg-red-50/50 py-4 shadow-sm">
            <CardContent className="px-4 py-0 text-sm text-red-700">{error}</CardContent>
          </Card>
        ) : mode === 'node' ? (
          nodeChartData.length === 0 ? (
            <Card className="border-slate-200 border-dashed bg-white py-8 shadow-sm">
              <CardContent className="px-4 py-0 text-center text-sm text-slate-500">
                暂无数据（请确认已配置 cron 且 METRICS_SQLITE_PATH 与采集一致）
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
                <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                  <CardTitle className="text-sm font-medium text-slate-800">CPU</CardTitle>
                  <CardDescription className="text-xs">节点 CPU 使用率（当前：{STAT_LABEL[stat]}）</CardDescription>
                </CardHeader>
                <CardContent className="px-3 pb-4 pt-4">
                  <div className="h-56 w-full rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={nodeChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200" />
                        <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                        <YAxis tick={{ fontSize: 10 }} width={44} domain={[0, 100]} />
                        <Tooltip formatter={(v) => (typeof v === 'number' ? v.toFixed(1) : v)} />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey={`CPU(${stat})`}
                          name={`CPU ${STAT_LABEL[stat]}`}
                          stroke={stat === 'avg' ? '#2563eb' : stat === 'max' ? '#dc2626' : '#7c3aed'}
                          dot={false}
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
                <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                  <CardTitle className="text-sm font-medium text-slate-800">内存</CardTitle>
                  <CardDescription className="text-xs">节点内存使用率（当前：{STAT_LABEL[stat]}）</CardDescription>
                </CardHeader>
                <CardContent className="px-3 pb-4 pt-4">
                  <div className="h-56 w-full rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={nodeChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200" />
                        <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                        <YAxis tick={{ fontSize: 10 }} width={44} domain={[0, 100]} />
                        <Tooltip formatter={(v) => (typeof v === 'number' ? v.toFixed(1) : v)} />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey={`内存(${stat})`}
                          name={`内存 ${STAT_LABEL[stat]}`}
                          stroke={stat === 'avg' ? '#16a34a' : stat === 'max' ? '#dc2626' : '#7c3aed'}
                          dot={false}
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
                <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                  <CardTitle className="text-sm font-medium text-slate-800">磁盘</CardTitle>
                  <CardDescription className="text-xs">根分区磁盘使用率（当前：{STAT_LABEL[stat]}）</CardDescription>
                </CardHeader>
                <CardContent className="px-3 pb-4 pt-4">
                  <div className="h-56 w-full rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={nodeChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200" />
                        <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                        <YAxis tick={{ fontSize: 10 }} width={44} domain={[0, 100]} />
                        <Tooltip formatter={(v) => (typeof v === 'number' ? v.toFixed(1) : v)} />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey={`磁盘(${stat})`}
                          name={`磁盘 ${STAT_LABEL[stat]}`}
                          stroke={stat === 'avg' ? '#ca8a04' : stat === 'max' ? '#dc2626' : '#7c3aed'}
                          dot={false}
                          strokeWidth={2}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          )
        ) : userChartData.length === 0 ? (
          <Card className="border-slate-200 border-dashed bg-white py-8 shadow-sm">
            <CardContent className="px-4 py-0 text-center text-sm text-slate-500">
              暂无该用户运行期内的采样数据
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
              <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                <CardTitle className="text-sm font-medium text-slate-800">CPU 使用率</CardTitle>
                <CardDescription className="text-xs">
                  与 docker stats 口径一致，多核时可能超过 100%（当前：{STAT_LABEL[stat]}）
                </CardDescription>
              </CardHeader>
              <CardContent className="px-3 pb-4 pt-4">
                <div className="h-56 w-full rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={userChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200" />
                      <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis tick={{ fontSize: 10 }} width={44} domain={['auto', 'auto']} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey={`CPU(${stat})`}
                        name={`CPU ${STAT_LABEL[stat]}`}
                        stroke={stat === 'avg' ? '#2563eb' : stat === 'max' ? '#dc2626' : '#7c3aed'}
                        dot={false}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
            <Card className="gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm">
              <CardHeader className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                <CardTitle className="text-sm font-medium text-slate-800">内存使用（GB）</CardTitle>
                <CardDescription className="text-xs">容器占用（当前：{STAT_LABEL[stat]}，1024 MiB = 1 GB）</CardDescription>
              </CardHeader>
              <CardContent className="px-3 pb-4 pt-4">
                <div className="h-56 w-full rounded-lg border border-slate-100 bg-slate-50/40 p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={userChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200" />
                      <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis tick={{ fontSize: 10 }} width={44} domain={[0, 'auto']} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey={`内存(${stat}) GB`}
                        name={`内存 ${STAT_LABEL[stat]} GB`}
                        stroke={stat === 'avg' ? '#16a34a' : stat === 'max' ? '#dc2626' : '#7c3aed'}
                        dot={false}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
