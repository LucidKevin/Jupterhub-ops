/**
 * GET /api/dashboard/running-containers
 *
 * 调用 JupyterHub REST API 获取所有用户信息，统计当前正在运行服务（容器）的用户数量。
 * API 地址与 Token 均从 src/config/cluster.ts 读取。
 *
 * 判断逻辑：
 *   用户对象的 `servers` 字段为非空对象 → 该用户有正在运行的容器。
 *
 * 返回示例：
 * {
 *   runningContainers: 1,   // servers 非空的用户数
 *   totalUsers: 5,          // 总用户数
 *   stoppedContainers: 4    // servers 为空的用户数
 * }
 *
 * 请求头：Authorization: token <JUPYTERHUB_CONFIG.token>
 */
import { NextResponse } from 'next/server';
import { JUPYTERHUB_CONFIG } from '@/config/cluster';

/** JupyterHub GET /hub/api/users 返回的用户对象（仅使用到的字段） */
interface JupyterUser {
  name: string;
  /** key 为 server 名称（默认服务器 key 为 ""），非空表示有运行中的容器 */
  servers: Record<string, unknown>;
  admin: boolean;
}

export async function GET() {
  try {
    const response = await fetch(JUPYTERHUB_CONFIG.apiUrl, {
      headers: {
        // JupyterHub API Token 鉴权
        Authorization: `token ${JUPYTERHUB_CONFIG.token}`,
      },
      // 禁用缓存，每次都拿最新数据
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`JupyterHub API error: ${response.status}`);
    }

    const users: JupyterUser[] = await response.json();

    // servers 对象非空 → 至少有一个容器正在运行
    const runningContainers = users.filter(
      (u) => u.servers && Object.keys(u.servers).length > 0
    ).length;
    const totalUsers = users.length;
    const stoppedContainers = totalUsers - runningContainers;

    return NextResponse.json({ runningContainers, totalUsers, stoppedContainers });
  } catch (error) {
    console.error('Failed to get running containers:', error);
    return NextResponse.json({ error: 'Failed to get running containers' }, { status: 500 });
  }
}
