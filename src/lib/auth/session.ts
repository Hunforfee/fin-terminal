import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'fin_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export interface AccountUser {
  id: string;
  phone: string;
}
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.replace(/[\s-]/g, '').replace(/^(?:\+86|0086)/, '');
  return /^1[3-9]\d{9}$/.test(value) ? value : null;
}
export const maskPhone = (phone: string) =>
  phone.slice(0, 3) + '****' + phone.slice(-4);
export const sessionSecret = () => {
  const secret = process.env.AUTH_SESSION_SECRET;
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
};
export function createSession(
  user: AccountUser,
  secret: string,
  now = Date.now(),
): string {
  if (Buffer.byteLength(secret) < 32) throw new Error('会话密钥未配置');
  if (
    !user.id ||
    user.id.length > 200 ||
    !/^1[3-9]\d\*{4}\d{4}$/.test(user.phone)
  )
    throw new Error('无效用户');
  const payload = Buffer.from(
    JSON.stringify({ v: 1, user, expires: now + SESSION_SECONDS * 1000 }),
  ).toString('base64url');
  return (
    payload +
    '.' +
    createHmac('sha256', secret).update(payload).digest('base64url')
  );
}
export function readSession(
  token: string | undefined,
  secret: string | null = sessionSecret(),
  now = Date.now(),
): AccountUser | null {
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    !token ||
    token.length > 2048
  )
    return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], 'base64url');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return null;
    const payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    );
    if (
      payload.v !== 1 ||
      typeof payload.expires !== 'number' ||
      payload.expires <= now ||
      typeof payload.user?.id !== 'string' ||
      !payload.user.id ||
      payload.user.id.length > 200 ||
      !/^1[3-9]\d\*{4}\d{4}$/.test(payload.user.phone)
    )
      return null;
    return { id: payload.user.id, phone: payload.user.phone };
  } catch {
    return null;
  }
}

/** Browser mutations must be same-origin and use a custom header; no CORS is enabled. */
export function sameOriginMutation(
  request: Request,
  configuredOrigin = process.env.APP_ORIGIN,
): boolean {
  if (
    request.headers.get('x-fin-csrf') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const target = new URL(configuredOrigin || request.url);
    // Next can construct an internal URL using its bind address. The browser's
    // Host header identifies the requested origin; APP_ORIGIN pins proxies.
    if (!configuredOrigin && request.headers.get('host'))
      target.host = request.headers.get('host')!;
    return new URL(origin).origin === target.origin;
  } catch {
    return false;
  }
}
