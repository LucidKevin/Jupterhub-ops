/**
 * GET /api/dashboard/service/config
 *
 * 读取服务器上的两个 JupyterHub 配置文件并返回内容：
 *   - /opt/jupyterhub/docker-compose.yml   Docker Compose 编排配置
 *   - /opt/jupyterhub/config/jupyterhub_config.py  JupyterHub Python 配置
 *
 * 若文件不可读，对应字段返回 null 并附带错误信息。
 */
import { NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { SERVICE_CONFIG_FILES } from '@/config/service';
import { requireAdmin } from '@/lib/guard';

export async function GET() {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  const [compose, hubConfig] = await Promise.all([
    readFile(SERVICE_CONFIG_FILES.compose, 'utf-8').catch(() => null),
    readFile(SERVICE_CONFIG_FILES.hubConfig, 'utf-8').catch(() => null),
  ]);

  return NextResponse.json({ compose, hubConfig });
}

export async function PUT(req: Request) {
  const auth = requireAdmin();
  if (auth.error) return auth.error;
  try {
    const body = (await req.json()) as { hubConfig?: string };
    if (typeof body.hubConfig !== 'string') {
      return NextResponse.json({ success: false, error: 'hubConfig 必须为字符串' }, { status: 400 });
    }
    // 统一为 LF，避免 Linux 下出现 ^M（CRLF）显示
    const normalized = body.hubConfig.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    await writeFile(SERVICE_CONFIG_FILES.hubConfig, normalized, 'utf-8');
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : '写入失败' },
      { status: 500 }
    );
  }
}
