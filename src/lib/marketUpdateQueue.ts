import { randomUUID } from 'node:crypto';
import { marketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { collectionPhases, coverageKey } from './marketHistoryPlan';

const KEY = 'market-update-queue:v1';
const COOLDOWN = 10 * 60e3;
const LEASE = 5 * 60e3;
type State = 'queued' | 'running' | 'done' | 'failed';
export type UpdateMode = 'recent' | 'ten-year' | 'daily' | 'five-year'; // five-year: stored legacy jobs only.
interface Item { symbol: string; state: State; attempts: number; nextAt: number; mode?:UpdateMode; initialize?:boolean; phase?:number; phaseErrors?:Record<string,string>; doneAt?: number; error?: string; lease?: string; leaseUntil?: number }
interface Job { id: string; owner: string; symbols: string[]; skipped: string[]; createdAt: number; mode?:UpdateMode; finishedAt?: number; result?: { done: number; failed: number; errors: { symbol: string; message: string }[] } }
interface Queue { jobs: Job[]; items: Record<string, Item>; workerAt: number; pauseUntil: number }
export interface UpdateProgress { id: string; mode?:UpdateMode; phase?:number; total: number; done: number; skipped: number; failed: number; running: number; waiting: number; finished: boolean; workerOnline: boolean; pausedUntil: number; errors: { symbol: string; message: string }[] }
export class UpdateQueueError extends Error { constructor(message: string, public status = 409) { super(message); } }
export function updateSymbols(codes: unknown): string[] {
  if (!Array.isArray(codes) || !codes.length || codes.length > 1000 || codes.some(c => typeof c !== 'string')) throw new UpdateQueueError('请选择 1—1000 家自选公司', 400);
  return [...new Set(codes.map(code => {
    const n = normalizeStockCode(code); if (!n) throw new UpdateQueueError('更新范围含无效股票代码', 400);
    return n.symbol;
  }))].sort();
}
export class MarketUpdateQueue {
  constructor(private store: MarketStore, private clock = Date.now) {}
  private async change<T>(fn: (q: Queue, now: number) => T): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const row = await this.store.read<Queue>(KEY);
      const q = row?.payload ?? { jobs: [], items: {}, workerAt: 0, pauseUntil: 0 };
      const now = this.clock();
      // Restart unfinished legacy fills under the new plan; old leases cannot finish them.
      for (const item of Object.values(q.items)) if (item.mode === 'five-year' && ['queued','running'].includes(item.state)) {
        Object.assign(item, { mode:'ten-year', initialize:true, state:'queued', phase:0, attempts:0, nextAt:now });
        delete item.phaseErrors; delete item.error; delete item.lease; delete item.leaseUntil;
      }
      for (const job of q.jobs) if (job.mode === 'five-year' && !job.result) job.mode = 'ten-year';
      for (const job of q.jobs) if (!job.finishedAt && job.symbols.every(s => job.skipped.includes(s) || ['done', 'failed'].includes(q.items[s]?.state))) {
        const p = this.progress(q, job, now); job.finishedAt = now; job.result = { done: p.done, failed: p.failed, errors: p.errors };
      }
      q.jobs = q.jobs.filter(j => !j.finishedAt || now - j.finishedAt < 864e5);
      const used = new Set(q.jobs.filter(j => !j.result).flatMap(j => j.symbols.filter(s => !j.skipped.includes(s))));
      for (const [symbol, item] of Object.entries(q.items)) if (!used.has(symbol) && item.state !== 'running' && (item.doneAt ?? item.nextAt) < now - COOLDOWN) delete q.items[symbol];
      const result = fn(q, now);
      if (await this.store.write(marketRecord(KEY, 'market-update-queue', 'internal', q, 864e5, now), row?.digest ?? null)) return result;
    }
    throw new UpdateQueueError('队列繁忙，请稍后再试', 503);
  }
  private progress(q: Queue, j: Job, now: number): UpdateProgress {
    if (j.result) return { id: j.id, mode:j.mode, total: j.symbols.length, skipped: j.skipped.length, ...j.result, running: 0, waiting: 0, finished: true, workerOnline: now - q.workerAt < 90e3, pausedUntil: q.pauseUntil };
    const active = j.symbols.filter(s => !j.skipped.includes(s)).map(s => q.items[s]);
    const count = (state: State) => active.filter(i => i?.state === state).length;
    const current = active.find(i=>i?.state==='running');
    const phase = current ? collectionPhases(current.mode ?? 'recent', current.initialize ?? false)[current.phase ?? 0] : undefined;
    return { id: j.id, mode:j.mode,phase, total: j.symbols.length, done: count('done'), skipped: j.skipped.length, failed: count('failed'), running: count('running'), waiting: count('queued'),
      finished: active.every(i => i && ['done', 'failed'].includes(i.state)), workerOnline: now - q.workerAt < 90e3,
      pausedUntil: q.pauseUntil, errors: active.filter(i => i?.state === 'failed').map(i => ({ symbol: i.symbol, message: i.error ?? '更新失败' })) };
  }
  async submit(owner: string, codes: unknown, retry = false, mode:UpdateMode='recent'): Promise<UpdateProgress> {
    if (mode === 'five-year') mode = 'ten-year';
    const symbols = updateSymbols(codes);
    const initialization=new Map(await Promise.all(symbols.map(async symbol=>[symbol,mode==='ten-year' ||
      (await this.store.read<{status:string}>(coverageKey(symbol)))?.payload.status!=='ready'] as const)));
    return this.change((q, now) => {
      const previous = q.jobs.filter(j => j.owner === owner).at(-1);
      if (previous && !this.progress(q, previous, now).finished) {
        if(mode==='ten-year' && previous.mode!=='ten-year')throw new UpdateQueueError('当前任务进行中，请停止或完成后再补齐十年数据',409);
        if(mode==='ten-year' && symbols.some(symbol=>!previous.symbols.includes(symbol)))throw new UpdateQueueError('已有其他范围的补齐任务进行中，请停止或完成后再提交',409);
        return this.progress(q, previous, now);
      }
      if (previous && now - previous.createdAt < 60e3) throw new UpdateQueueError('刚刚已提交，请稍后再试', 429);
      if (retry && (!previous || symbols.some(s => !this.progress(q, previous, now).errors.some(e => e.symbol === s)))) throw new UpdateQueueError('只能重试当前任务失败的公司', 400);
      // Retain recent results without allowing finished jobs to block new users.
      while (q.jobs.length >= 50) {
        const oldest = q.jobs.findIndex(j => !!j.result);
        if (oldest < 0) break;
        q.jobs.splice(oldest, 1);
      }
      if (q.jobs.length >= 50 || Object.keys(q.items).length + symbols.filter(s => !q.items[s]).length > 2000) throw new UpdateQueueError('全站更新队列已满，请稍后再试', 429);
      const skipped: string[] = [];
      for (const symbol of symbols) {
        const item = q.items[symbol];
        if (item?.state === 'done' && now - (item.doneAt ?? 0) < COOLDOWN && (mode==='daily' || mode==='recent' && item.mode!=='daily' || item.mode==='ten-year')) { skipped.push(symbol); continue; }
        if (item && ['queued', 'running'].includes(item.state)) {
          if(mode==='ten-year' && item.mode!=='ten-year')throw new UpdateQueueError('该股票正在更新，请完成后再补齐十年数据',409);
          continue;
        }
        if (item?.state === 'failed' && now - (item.doneAt ?? 0) < 60e3) throw new UpdateQueueError('失败后请稍候再重试', 429);
        const resume=retry && item?.mode===mode;
        const phase=resume?Math.min(item.phase??0,...Object.keys(item.phaseErrors??{}).map(Number)):0;
        q.items[symbol] = { symbol, state: 'queued', attempts: 0, nextAt: now, mode,initialize:resume?item.initialize:initialization.get(symbol),phase,...(resume?{phaseErrors:item.phaseErrors}:{}) };
      }
      const job: Job = { id: randomUUID(), owner, symbols, skipped, createdAt: now,mode };
      q.jobs.push(job); return this.progress(q, job, now);
    });
  }
  async status(owner: string): Promise<UpdateProgress | null> {
    const row = await this.store.read<Queue>(KEY); const q = row?.payload;
    const job = q?.jobs.filter(j => j.owner === owner).at(-1);
    return q && job ? this.progress(q, job, this.clock()) : null;
  }
  async claim(): Promise<{ symbol: string; lease: string; mode:UpdateMode;phase:number;initialize?:boolean;phaseErrors?:Record<string,string> } | null> {
    return this.change((q, now) => {
      q.workerAt = now;
      if (q.pauseUntil > now) return null;
      const running = Object.values(q.items).find(i => i.state === 'running' && (i.leaseUntil ?? 0) > now);
      if (running) return null; // One company across ALL server instances.
      const expired = Object.values(q.items).find(i => i.state === 'running');
      if (expired) { expired.state = expired.attempts >= 3 ? 'failed' : 'queued'; expired.error = '后台执行中断'; expired.nextAt = now + 60e3; if (expired.state === 'failed') expired.doneAt = now; }
      const item = Object.values(q.items).find(i => i.state === 'queued' && i.nextAt <= now);
      if (!item) return null;
      item.state = 'running'; item.attempts++; item.lease = randomUUID(); item.leaseUntil = now + LEASE;
      return { symbol: item.symbol, lease: item.lease,mode:item.mode??'recent',phase:item.phase??0,initialize:item.initialize,phaseErrors:item.phaseErrors };
    });
  }
  async renew(symbol: string, lease: string): Promise<boolean> {
    return this.change((q, now) => {
      q.workerAt = now; const i = q.items[symbol];
      if (!i || i.state !== 'running' || i.lease !== lease || (i.leaseUntil ?? 0) <= now) return false;
      i.leaseUntil = now + LEASE; return true;
    });
  }
  async finish(symbol: string, lease: string, error?: string, limited = false, nextPhase?:number): Promise<boolean> {
    return this.change((q, now) => {
      const i = q.items[symbol];
      if (!i || i.state !== 'running' || i.lease !== lease || (i.leaseUntil ?? 0) <= now) return false;
      q.workerAt = now; i.error = error?.slice(0, 180);
      if(!error && i.phaseErrors)delete i.phaseErrors[String(i.phase??0)];
      if(nextPhase!==undefined){
        if(error){i.phaseErrors??={};i.phaseErrors[String(i.phase??0)]=error.slice(0,180);}
        i.state='queued';i.phase=nextPhase;i.attempts=0;i.nextAt=now+1000;
      }
      else if (!error) {
        // 中途阶段失败（如当日抓取）不能在末段校验通过后被无声清成“更新完成”：
        // 末段只证明库内历史可用，不代表本次抓取成功。保留失败痕迹并如实标记。
        const pending = [...new Set(Object.values(i.phaseErrors ?? {}))];
        if (pending.length) { i.state = 'failed'; i.doneAt = now; i.error = pending.join('；').slice(0, 180); delete i.phaseErrors; }
        else { i.state = 'done'; i.doneAt = now; delete i.phaseErrors; }
      }
      else if (i.attempts < 3) { i.state = 'queued'; i.nextAt = now + Math.min(15 * 60e3, 60e3 * 3 ** (i.attempts - 1)); }
      else { i.state = 'failed'; i.doneAt = now; }
      if (limited) q.pauseUntil = Math.max(q.pauseUntil, now + 5 * 60e3);
      return true;
    });
  }
  /**
   * 只取消当前用户的订阅。其他活跃任务仍引用的执行项继续使用原租约。
   */
  async cancel(owner: string): Promise<UpdateProgress | null> {
    return this.change((q, now) => {
      const job = [...q.jobs].reverse().find(j => j.owner === owner && !j.result);
      if (!job) return null;
      const before = this.progress(q, job, now);
      const cancelled = job.symbols.filter(symbol => !job.skipped.includes(symbol) &&
        ['queued', 'running'].includes(q.items[symbol]?.state));
      job.finishedAt = now;
      job.result = { done: before.done, failed: before.failed + cancelled.length,
        errors: [...before.errors, ...cancelled.map(symbol => ({ symbol, message: '已手动停止' }))] };
      for (const symbol of cancelled) {
        if (q.jobs.some(other => other.id !== job.id && !other.result &&
          other.symbols.includes(symbol) && !other.skipped.includes(symbol))) continue;
        const i = q.items[symbol];
        if (i && ['queued', 'running'].includes(i.state)) {
          i.state = 'failed'; i.error = '已手动停止'; i.doneAt = now; i.lease = undefined; i.leaseUntil = 0;
        }
      }
      return this.progress(q, job, now);
    });
  }
}
