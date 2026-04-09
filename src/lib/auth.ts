/**
 * 会话鉴权核心模块：
 * - 生成/校验签名 token
 * - 读写 Session Cookie
 * - 提供标准 401/403 响应
 */
import crypto from 'crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, AUTH_SESSION_TTL_SECONDS } from '@/config/auth';

/** 写入 token 的会话载荷结构。 */
export interface SessionPayload {
  username: string;
  isAdmin: boolean;
  exp: number;
}

/** 读取会话签名密钥（生产环境应配置 SESSION_SECRET）。 */
function getSessionSecret(): string {
  return process.env.SESSION_SECRET || 'jupyterhub-ops-dev-secret-change-me';
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/** payload(base64url) 签名，防止客户端篡改。 */
function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
}

/** 生成 `payload.signature` 形式的会话 token。 */
export function createSessionToken(username: string, isAdmin: boolean): string {
  const payload: SessionPayload = {
    username,
    isAdmin,
    exp: Math.floor(Date.now() / 1000) + AUTH_SESSION_TTL_SECONDS,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** 校验 token 格式、签名、过期时间并解析为 SessionPayload。 */
export function verifySessionToken(token?: string | null): SessionPayload | null {
  if (!token) return null;
  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;
  if (sign(payloadB64) !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as SessionPayload;
    if (!payload?.username || typeof payload.isAdmin !== 'boolean') return null;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从当前请求 Cookie 中提取并验证会话。 */
export function getSessionFromCookies(): SessionPayload | null {
  const token = cookies().get(AUTH_COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

/** 设置登录态 Cookie（HttpOnly）。 */
export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_SESSION_TTL_SECONDS,
  });
}

/** 清除登录态 Cookie。 */
export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

/** 统一 401 响应。 */
export function unauthorized(message = 'Unauthorized') {
  return NextResponse.json({ error: message }, { status: 401 });
}

/** 统一 403 响应。 */
export function forbidden(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 });
}

