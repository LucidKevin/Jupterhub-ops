/**
 * API 鉴权守卫：
 * - requireUser: 仅要求已登录
 * - requireAdmin: 要求管理员权限
 */
import { getSessionFromCookies, unauthorized, forbidden, type SessionPayload } from '@/lib/auth';
import { NextResponse } from 'next/server';

/** 从 Cookie 读取会话，未登录返回 401。 */
export function requireUser():
  | { session: SessionPayload; error: null }
  | { session: null; error: NextResponse } {
  const session = getSessionFromCookies();
  if (!session) return { session: null, error: unauthorized('请先登录') };
  return { session, error: null };
}

/** 基于 requireUser 二次校验管理员标记，非管理员返回 403。 */
export function requireAdmin():
  | { session: SessionPayload; error: null }
  | { session: null; error: NextResponse } {
  const auth = requireUser();
  if (auth.error) return { session: null, error: auth.error };
  if (!auth.session.isAdmin) return { session: null, error: forbidden('需要管理员权限') };
  return auth;
}

