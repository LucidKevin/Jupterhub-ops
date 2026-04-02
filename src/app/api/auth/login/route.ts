import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'ldapts';
import { LDAP_CONFIG } from '@/config/auth';
import { JUPYTERHUB_CONFIG } from '@/config/cluster';
import { createSessionToken, setSessionCookie } from '@/lib/auth';

async function verifyLdapCredentials(username: string, password: string): Promise<boolean> {
  const url = `ldap://${LDAP_CONFIG.serverAddress}:${LDAP_CONFIG.serverPort}`;
  const bindDns = LDAP_CONFIG.bindDnTemplates.map((tpl) => tpl.replace('{username}', username));

  for (const bindDn of bindDns) {
    const client = new Client({ url, timeout: 5000, connectTimeout: 5000 });
    try {
      await client.bind(bindDn, password);
      await client.unbind();
      return true;
    } catch {
      try {
        await client.unbind();
      } catch {
        // ignore unbind failures
      }
    }
  }
  return false;
}

async function getJupyterAdminFlag(username: string): Promise<boolean> {
  const usersApiBase = JUPYTERHUB_CONFIG.apiUrl.replace(/\/users$/, '');
  const res = await fetch(`${usersApiBase}/users/${encodeURIComponent(username)}`, {
    headers: { Authorization: `token ${JUPYTERHUB_CONFIG.token}` },
    cache: 'no-store',
  });
  if (!res.ok) return false;
  const user = (await res.json()) as { admin?: boolean };
  return Boolean(user.admin);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return NextResponse.json({ error: '用户名和密码不能为空' }, { status: 400 });
  }

  const ldapOk = await verifyLdapCredentials(username, password);
  if (!ldapOk) {
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }

  const isAdmin = await getJupyterAdminFlag(username);
  const token = createSessionToken(username, isAdmin);
  const res = NextResponse.json({ success: true, username, isAdmin });
  setSessionCookie(res, token);
  return res;
}

