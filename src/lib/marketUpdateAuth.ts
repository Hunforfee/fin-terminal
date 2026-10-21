import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { cloudPublicConfig } from './cloudPublic';
import { readSession, SESSION_COOKIE } from './auth/session';
import { readAccountData } from './auth/accountData';
import { readWatchlist, WATCHLIST_KEY, watchCodes } from './watchlist';
import { UpdateQueueError } from './marketUpdateQueue';

export function localUpdatePreview(request: NextRequest) {
  return process.env.MARKET_UPDATE_LOCAL_PREVIEW === '1' && ['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)
    && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.get('host') ?? '');
}
const verified = new Map<string, { id: string; until: number }>();
export async function updateIdentity(request: NextRequest, group?: string): Promise<{ owner: string; allowed?: string[] }> {
  if (localUpdatePreview(request)) return { owner: 'isolated-local-preview' };
  // The current site's signed cookie takes precedence over retired Cloud tokens.
  const user = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (user) {
    if (group === undefined) return { owner: `legacy:${user.id}` };
    const saved = await readAccountData(user.id);
    let state; try { state = readWatchlist(JSON.parse(saved.data[WATCHLIST_KEY] ?? 'null')); } catch {}
    if (!state || group !== 'all' && !state.groups.some(g => g.id === group)) throw new UpdateQueueError('自选分组尚未同步', 409);
    return { owner: `legacy:${user.id}`, allowed: watchCodes(state, group) };
  }
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (token) {
    if (token.length > 8192) throw new UpdateQueueError('登录凭证无效', 401);
    const digest = createHash('sha256').update(token).digest('hex');
    const headers = { Authorization: `Bearer ${token}`, 'x-wb-webapp-access-key': cloudPublicConfig.publishableKey, Origin: cloudPublicConfig.endpoint };
    let user = verified.get(digest);
    if (!user || user.until <= Date.now()) {
      const r = await fetch(`${cloudPublicConfig.endpoint}/.cloud/auth/v1/user/me`, { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!r.ok) throw new UpdateQueueError('请重新登录后更新', 401);
      const value = await r.json();
      const id = value.sub ?? value.uid;
      if (typeof id !== 'string' || !id || value.is_anonymous === true || value.scope === 'anonymous') throw new UpdateQueueError('请先登录', 401);
      user = { id, until: Date.now() + 30e3 };
      if (verified.size >= 256) verified.clear(); verified.set(digest, user);
    }
    if (group === undefined) return { owner: `cloud:${user.id}` };
    // Same token and RLS as the browser SDK; never use a privileged service key.
    const r = await fetch(`${cloudPublicConfig.endpoint}/.cloud/database/rest/fin_account_data?select=data&limit=2`, { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (!r.ok) throw new UpdateQueueError('请先完成自选云同步，再更新数据', 409);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length !== 1) throw new UpdateQueueError('未找到已同步自选，请先同步', 409);
    let state; try { state = readWatchlist(JSON.parse(rows[0]?.data?.[WATCHLIST_KEY] ?? 'null')); } catch {}
    if (!state || group !== 'all' && !state.groups.some(g => g.id === group)) throw new UpdateQueueError('自选分组尚未同步', 409);
    return { owner: `cloud:${user.id}`, allowed: watchCodes(state, group) };
  }
  throw new UpdateQueueError('请先登录后更新', 401);
}
