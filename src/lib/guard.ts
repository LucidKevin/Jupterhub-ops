import { getSessionFromCookies, unauthorized, forbidden, type SessionPayload } from '@/lib/auth';
import { NextResponse } from 'next/server';

export function requireUser():
  | { session: SessionPayload; error: null }
  | { session: null; error: NextResponse } {
  const session = getSessionFromCookies();
  if (!session) return { session: null, error: unauthorized('请先登录') };
  return { session, error: null };
}

export function requireAdmin():
  | { session: SessionPayload; error: null }
  | { session: null; error: NextResponse } {
  const auth = requireUser();
  if (auth.error) return { session: null, error: auth.error };
  if (!auth.session.isAdmin) return { session: null, error: forbidden('需要管理员权限') };
  return auth;
}

