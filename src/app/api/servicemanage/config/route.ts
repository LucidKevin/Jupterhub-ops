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
import { readFile } from 'fs/promises';
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
