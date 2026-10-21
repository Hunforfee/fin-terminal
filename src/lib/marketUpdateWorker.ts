import { getMarketStore } from './marketStore';
import { MarketUpdateQueue } from './marketUpdateQueue';
import { UpstreamBudget } from './upstreamBudget';
import { withUpstreamBudget } from './marketUpdateContext';
import { getKLine, getHkCurrentValuation } from './datasource';
import { normalizeStockCode } from './datasource/codes';
import { fetchValueScreenReports, getValueScreenMeta } from './datasource/valueScreen';
import { getValuationDividends, getValuationPlans } from './valuationInputs';
import { cachedMarketInput, validateDatedRows } from './marketInputs';
import { fetchShareHistory } from './datasource/sinaFinance';
import { getWatchlistFinancialInputs } from './watchlistFinancialInputs';
import { collectHistoryPhase, coverageKey } from './marketHistoryCollection';

/** One short-range stock per tick. Slow work never runs in the browser POST. */
export async function runMarketUpdateTick() {
  const store = getMarketStore(); if (!store) throw Error('市场数据库尚未配置');
  const queue = new MarketUpdateQueue(store);
  const task = await queue.claim(); if (!task) return { processed: false };
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(Error('单家公司更新超时')), 210e3);
  const heartbeat = setInterval(() => {
    void queue.renew(task.symbol, task.lease).then(ok => { if (!ok) abort.abort(Error('任务租约已失效')); }).catch(() => abort.abort(Error('无法续期任务')));
  }, 20e3);
  const budget = new UpstreamBudget(abort.signal);
  let error: string | undefined;
  let nextPhase:number|undefined;
  let initializing=task.mode==='five-year';
  try {
    const coverage=await store.read<{status:string}>(coverageKey(task.symbol));
    // New/partial stocks must initialize from website APIs even when added after
    // deployment or submitted by the daily "recent" scheduler. No broker seed.
    const initialize=initializing=task.initialize??(task.mode==='five-year' || coverage?.payload.status!=='ready');
    const phases=initialize ? [0,1,2,3,4,5,6,7,8,9,10,11,13,12] : [2,0,1,3,4,10,11,13,12];
    const phase=phases[task.phase];
    if(phase===undefined)throw Error('后台任务阶段无效');
    await withUpstreamBudget(budget, async () => {
      if(phase!==2){
        await collectHistoryPhase(task.symbol,phase,abort.signal);
      }else{
      const n = normalizeStockCode(task.symbol)!;
      const start = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const prices = await getKLine(n.symbol, 'day', 'none', 40, start, true);
      if (prices.stale || prices.complete === false || prices.storage?.backend !== 'persistent') throw Error('近期价格未确认完整入库');
      if (n.market === 'HK') {
        const value = await getHkCurrentValuation(n.symbol, prices.candles.at(-1)?.close ?? null);
        if (value.pb == null) throw Error('港股财务输入暂无法核验');
        for (const key of [`hk-main-currency-v4:${n.symbol}`, `hk-dividend-events-v4:${n.symbol}`]) {
          const row = await store.read(key);
          if (!row || Date.parse(row.refreshAfter) <= Date.now()) throw Error('港股财务或分红尚未确认入库');
        }
      } else {
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        const reports = await fetchValueScreenReports(getValueScreenMeta().periods, today, [n.code]);
        if (!reports.main.length) throw Error('最新财报记录暂缺');
        const financial = await store.read(`screen-company-input:v1:${n.code}:eastmoney:CNY`);
        if (!financial || Date.parse(financial.refreshAfter) <= Date.now()) throw Error('最新财报未确认入库');
        await getValuationPlans(n.code);
        const events = await getValuationDividends(n.code);
        const previousYear = new Date(); previousYear.setUTCFullYear(previousYear.getUTCFullYear() - 1);
        if (events.some(e => e.cashConflict && e.exDate >= previousYear.toISOString().slice(0, 10))) throw Error('近期分红来源存在冲突，未按成功处理');
        await cachedMarketInput(`shares-v3:${n.code}`, 'share-events', 'sina-shares:10000shares', 1800e3, () => fetchShareHistory(n.code), rows => {
          validateDatedRows(rows as unknown as Record<string, unknown>[], 'date', ['sharesWan']);
          if (rows.some(r => !(r.sharesWan > 0))) throw Error('股本数值无效');
        });
        for (const key of [`dividend-plans-v2:${n.code}`, `implemented-dividends-v4:${n.code}`, `shares-v3:${n.code}`]) {
          const row = await store.read(key);
          if (!row || Date.parse(row.refreshAfter) <= Date.now()) throw Error('分红记录尚未确认入库');
        }
      }
      await getWatchlistFinancialInputs(n.symbol);
      const displayed = await store.read(`watchlist-financial-inputs:v1:${n.symbol}`);
      if (!displayed || Date.parse(displayed.refreshAfter) <= Date.now()) throw Error('列表财务尚未确认入库');
      }
      if (budget.limited) throw Error('上游限流，更新已暂停');
      abort.signal.throwIfAborted();
    });
    if(task.phase<phases.length-1)nextPhase=task.phase+1;
  } catch (e) {
    error = e instanceof Error ? e.message : '更新失败';
    // A failing price mirror must not prevent independent financial inputs from
    // being saved. The final DB-only readiness gate still rejects missing facts.
    const last=initializing?13:8;
    if(task.phase<last && !abort.signal.aborted)nextPhase=task.phase+1;
  }
  finally { abort.abort(Error('本次任务已结束')); clearInterval(heartbeat); clearTimeout(deadline); }
  const accepted = await queue.finish(task.symbol, task.lease, error, budget.limited,nextPhase);
  return { processed: true, accepted, symbol: task.symbol, ok: !error };
}
