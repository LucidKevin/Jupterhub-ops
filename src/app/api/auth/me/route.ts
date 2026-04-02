import { NextResponse } from 'next/server';
import { getSessionFromCookies, unauthorized } from '@/lib/auth';

export async function GET() {
  const session = getSessionFromCookies();
  if (!session) return unauthorized('未登录');
  return NextResponse.json({
    username: session.username,
    isAdmin: session.isAdmin,
  });
}

