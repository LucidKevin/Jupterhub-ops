/**
 * POST /api/servicemanage/action
 *
 * 执行 JupyterHub 服务的启动 / 停止 / 重启操作。
 * 请求体：{ action: 'start' | 'stop' | 'restart' }
 *
 * 对应脚本：
 *   start   → /opt/jupyterhub/start.sh
 *   stop    → /opt/jupyterhub/stop.sh
 *   restart → /opt/jupyterhub/restart.sh
 *
 * 返回示例（成功）：{ success: true,  output: "..." }
 * 返回示例（失败）：{ success: false, output: "...", error: "..." }
 *
 * 注意：
 *   - 脚本在 /opt/jupyterhub 目录下执行（脚本依赖该目录存在 docker-compose.yml）
 *   - 超时 60 秒
 *   - 使用 exec callback 直接获取退出码，避免脚本内 grep 等命令返回非零时
 *     丢失已产生的 stdout 内容
 */
import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import {
  SERVICE_MANAGE_EXEC_TIMEOUT_MS,
  SERVICE_MANAGE_SCRIPTS,
  SERVICE_MANAGE_WORKDIR,
} from '@/config/service';

export async function POST(req: NextRequest) {
  const { action } = await req.json();

  const script = SERVICE_MANAGE_SCRIPTS[action as keyof typeof SERVICE_MANAGE_SCRIPTS];
  if (!script) {
    return NextResponse.json({ success: false, error: `未知操作: ${action}` }, { status: 400 });
  }

  const { code, stdout, stderr } = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    exec(
      `bash ${script}`,
      { timeout: SERVICE_MANAGE_EXEC_TIMEOUT_MS, cwd: SERVICE_MANAGE_WORKDIR },
      (error, stdout, stderr) => {
        // 无论成功失败，都保留 stdout/stderr，退出码由 error.code 判断
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });

  const success = code === 0;
  return NextResponse.json({ success, output: stdout || stderr, error: success ? undefined : stderr });
}

