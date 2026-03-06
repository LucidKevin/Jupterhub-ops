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

const CONFIG_FILES = {
  compose: '/opt/jupyterhub/docker-compose.yml',
  hubConfig: '/opt/jupyterhub/config/jupyterhub_config.py',
};

export async function GET() {
  const [compose, hubConfig] = await Promise.all([
    readFile(CONFIG_FILES.compose, 'utf-8').catch(() => null),
    readFile(CONFIG_FILES.hubConfig, 'utf-8').catch(() => null),
  ]);

  return NextResponse.json({ compose, hubConfig });
}
