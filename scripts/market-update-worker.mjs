// Run as a supervised service, independently of browser sessions and web requests.
const origin = process.env.MARKET_UPDATE_ORIGIN;
const token = process.env.MARKET_UPDATE_WORKER_TOKEN;
if (!origin || !token || token.length < 32) throw Error('Set MARKET_UPDATE_ORIGIN and MARKET_UPDATE_WORKER_TOKEN');
const target = new URL('/api/market-updates/worker', origin);
if (target.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(target.hostname)) throw Error('Remote worker requires HTTPS');
let stop = false;
process.on('SIGINT', () => { stop = true; }); process.on('SIGTERM', () => { stop = true; });
while (!stop) {
  let delay = 15000;
  try {
    const r = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(240e3), redirect: 'error' });
    if (r.status === 401 || r.status === 403) throw Error('Worker credentials rejected');
    const j = await r.json();
    if (!r.ok || !j.ok) throw Error('Worker service unavailable');
    if (j.data.processed) { console.log(JSON.stringify({ symbol: j.data.symbol, ok: j.data.ok })); delay = 3000; }
  } catch (e) { console.error(e instanceof Error ? e.message : 'Worker request failed'); delay = 60000; }
  if (!stop) await new Promise(resolve => setTimeout(resolve, delay));
}
