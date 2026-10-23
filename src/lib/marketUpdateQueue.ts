import { randomUUID } from 'node:crypto';
import { marketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';
import { collectionPhases, coverageKey } from './marketHistoryPlan';
import { appendRunLog } from './marketUpdateRunLog';

export const executionKey = (symbol:string, mode:UpdateMode='recent', targetDate?:string) => mode==='daily' ? `${symbol}@daily@${targetDate}` : mode==='financial' ? `${symbol}@financial` : symbol;
const KEY = 'market-update-queue:v1';
const COOLDOWN = 10 * 60e3;
const LEASE = 5 * 60e3;
type State = 'queued' | 'running' | 'done' | 'failed';
export type UpdateMode = 'recent' | 'ten-year' | 'daily' | 'financial' | 'five-year'; // five-year: stored legacy jobs only.
interface Item { symbol: string; state: State; attempts: number; nextAt: number; targetDate?:string; mode?:UpdateMode; initialize?:boolean; phase?:number; phaseErrors?:Record<string,string>; doneAt?: number; error?: string; lease?: string; leaseUntil?: number }
interface Job { itemKeys?: Record<string,string>; id: string; owner: string; symbols: string[]; skipped: string[]; createdAt: number; mode?:UpdateMode; finishedAt?: number; result?: { done: number; failed: number; errors: { symbol: string; message: string }[] } }
interface Queue { jobs: Job[]; items: Record<string, Item>; workerAt: number; pauseUntil: number }
export interface UpdateProgress { reason?:'paused'|'worker-offline'|'running'|'waiting'|'finished'; id: string; mode?:UpdateMode; phase?:number; total: number; done: number; skipped: number; failed: number; running: number; waiting: number; finished: boolean; workerOnline: boolean; pausedUntil: number; errors: { symbol: string; message: string }[] }
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
      const justFinished: Job[] = [];
      // Deployed daily tasks may still carry the old history/financial phase index.
      for(const item of Object.values(q.items))if(item.mode==='daily' && ['queued','running'].includes(item.state) && (item.initialize!==false || (item.phase??0)>0)){
        Object.assign(item,{initialize:false,phase:0,state:'queued',attempts:0,nextAt:now});
        delete item.phaseErrors;delete item.error;delete item.lease;delete item.leaseUntil;
      }
      // Restart unfinished legacy fills under the new plan; old leases cannot finish them.
      for (const item of Object.values(q.items)) if (item.mode === 'five-year' && ['queued','running'].includes(item.state)) {
        Object.assign(item, { mode:'ten-year', initialize:true, state:'queued', phase:0, attempts:0, nextAt:now });
        delete item.phaseErrors; delete item.error; delete item.lease; delete item.leaseUntil;
      }
      for (const job of q.jobs) if (job.mode === 'five-year' && !job.result) job.mode = 'ten-year';
      for (const job of q.jobs) if (!job.finishedAt && job.symbols.every(s => job.skipped.includes(s) || ['done', 'failed'].includes(q.items[job.itemKeys?.[s]??s]?.state))) {
        const p = this.progress(q, job, now); job.finishedAt = now; job.result = { done: p.done, failed: p.failed, errors: p.errors };
        justFinished.push(job);
      }
      q.jobs = q.jobs.filter(j => !j.finishedAt || now - j.finishedAt < 864e5);
      const used = new Set(q.jobs.filter(j => !j.result).flatMap(j => j.symbols.filter(s => !j.skipped.includes(s)).map(s=>j.itemKeys?.[s]??s)));
      for (const [symbol, item] of Object.entries(q.items)) if (!used.has(symbol) && item.state !== 'running' && (item.doneAt ?? item.nextAt) < now - COOLDOWN) delete q.items[symbol];
      const result = fn(q, now);
      // 完成检测置于 fn 之后：finish/cancel 可能刚把最后一个 item 置为终态，
      // 同一次 change 即汇总结果并落运行日志，无需等下一轮 claim。
      for (const job of q.jobs) if (!job.finishedAt && job.symbols.every(s => job.skipped.includes(s) || ['done', 'failed'].includes(q.items[job.itemKeys?.[s]??s]?.state))) {
        const p = this.progress(q, job, now); job.finishedAt = now; job.result = { done: p.done, failed: p.failed, errors: p.errors };
        justFinished.push(job);
      }
      if (await this.store.write(marketRecord(KEY, 'market-update-queue', 'internal', q, 864e5, now), row?.digest ?? null)) {
        // 任务完成即落运行日志（供网站查看原因与结果），不影响队列主流程。
        for (const job of justFinished) void this.recordRun(job, now).catch(() => null);
        return result;
      }
    }
    throw new UpdateQueueError('队列繁忙，请稍后再试', 503);
  }
  private progress(q: Queue, j: Job, now: number): UpdateProgress {
    if (j.result) return { reason:'finished', id: j.id, mode:j.mode, total: j.symbols.length, skipped: j.skipped.length, ...j.result, running: 0, waiting: 0, finished: true, workerOnline: now - q.workerAt < 90e3, pausedUntil: q.pauseUntil };
    const active = j.symbols.filter(s => !j.skipped.includes(s)).map(s => q.items[j.itemKeys?.[s]??s]);
    const count = (state: State) => active.filter(i => i?.state === state).length;
    const current = active.find(i=>i?.state==='running');
    const reason=q.pauseUntil>now?'paused':now-q.workerAt>=90e3?'worker-offline':current?'running':'waiting';
    const phase = current ? collectionPhases(current.mode ?? 'recent', current.initialize ?? false)[current.phase ?? 0] : undefined;
    return { id: j.id, mode:j.mode,phase,reason, total: j.symbols.length, done: count('done'), skipped: j.skipped.length, failed: count('failed'), running: count('running'), waiting: count('queued'),
      finished: active.every(i => i && ['done', 'failed'].includes(i.state)), workerOnline: now - q.workerAt < 90e3,
      pausedUntil: q.pauseUntil, errors: active.filter(i => i?.state === 'failed').map(i => ({ symbol: i.symbol, message: i.error ?? '更新失败' })) };
  }
  async submit(owner: string, codes: unknown, retry = false, mode:UpdateMode='recent', targetDate?:string): Promise<UpdateProgress> {
    if (mode === 'five-year') mode = 'ten-year';
    if(mode==='daily') {
      targetDate ??= new Date(this.clock()+8*3600e3).toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || !Number.isFinite(Date.parse(targetDate)) || new Date(targetDate+'T00:00:00Z').toISOString().slice(0,10)!==targetDate || targetDate>new Date(this.clock()+8*3600e3).toISOString().slice(0,10))throw new UpdateQueueError('目标交易日期无效',400);
    }
    const symbols = updateSymbols(codes);
    const initialization=new Map(await Promise.all(symbols.map(async symbol=>[symbol,mode!=='daily' && mode!=='financial' && (mode==='ten-year' ||
      (await this.store.read<{status:string}>(coverageKey(symbol)))?.payload.status!=='ready')] as const)));
    return this.change((q, now) => {
      const previous = q.jobs.filter(j => j.owner === owner).at(-1);
      if (previous && previous.mode===mode && !this.progress(q, previous, now).finished) {
        if(mode==='ten-year' && previous.mode!=='ten-year')throw new UpdateQueueError('当前任务进行中，请停止或完成后再补齐十年数据',409);
        if(mode==='ten-year' && symbols.some(symbol=>!previous.symbols.includes(symbol)))throw new UpdateQueueError('已有其他范围的补齐任务进行中，请停止或完成后再提交',409);
        return this.progress(q, previous, now);
      }
      if (previous && previous.mode===mode && now - previous.createdAt < 60e3) throw new UpdateQueueError('刚刚已提交，请稍后再试', 429);
      if (retry && (!previous || symbols.some(s => !this.progress(q, previous, now).errors.some(e => e.symbol === s)))) throw new UpdateQueueError('只能重试当前任务失败的公司', 400);
      // Retain recent results without allowing finished jobs to block new users.
      while (q.jobs.length >= 50) {
        const oldest = q.jobs.findIndex(j => !!j.result);
        if (oldest < 0) break;
        q.jobs.splice(oldest, 1);
      }
      if (q.jobs.length >= 50 || Object.keys(q.items).length + symbols.filter(s => !q.items[executionKey(s,mode,targetDate)]).length > 2000) throw new UpdateQueueError('全站更新队列已满，请稍后再试', 429);
      const skipped: string[] = [];
      for (const symbol of symbols) {
        const item = q.items[executionKey(symbol,mode,targetDate)];
        if (item?.state === 'done' && now - (item.doneAt ?? 0) < COOLDOWN && (mode==='daily' || mode==='recent' && item.mode!=='daily' || item.mode==='ten-year')) { skipped.push(symbol); continue; }
        if (item && ['queued', 'running'].includes(item.state)) {
          if(mode==='ten-year' && item.mode!=='ten-year')throw new UpdateQueueError('该股票正在更新，请完成后再补齐十年数据',409);
          continue;
        }
        if (item?.state === 'failed' && now - (item.doneAt ?? 0) < 60e3) throw new UpdateQueueError('失败后请稍候再重试', 429);
        const resume=retry && item?.mode===mode;
        const phase=resume?Math.min(item.phase??0,...Object.keys(item.phaseErrors??{}).map(Number)):0;
        q.items[executionKey(symbol,mode,targetDate)] = { symbol, targetDate, state: 'queued', attempts: 0, nextAt: now, mode,initialize:resume?item.initialize:initialization.get(symbol),phase,...(resume?{phaseErrors:item.phaseErrors}:{}) };
      }
      const job: Job = { id: randomUUID(), owner, symbols, skipped, createdAt: now,mode,itemKeys:Object.fromEntries(symbols.map(s=>[s,executionKey(s,mode,targetDate)])) };
      q.jobs.push(job); return this.progress(q, job, now);
    });
  }
  /** Persist a finished run to the rolling run-log. Best-effort. */
  private async recordRun(job: Job, now: number): Promise<void> {
    if (!job.result) return;
    const errors = (job.result.errors ?? []).slice(0, 500).map(e => ({ symbol: e.symbol, message: e.message }));
    await appendRunLog(this.store, {
      id: job.id, owner: job.owner, mode: job.mode ?? 'recent',
      startedAt: job.createdAt, finishedAt: now,
      total: job.symbols.length, done: job.result.done, failed: job.result.failed, errors,
    });
  }
  /** Aggregate live progress of the scheduled (system-owned) close/recovery runs. */
  async systemCloseProgress(): Promise<{ active: boolean; date?: string; mode?: UpdateMode; total: number; done: number; failed: number; running: number; waiting: number; finished: boolean; pausedUntil: number; workerOnline: boolean } | null> {
    const row = await this.store.read<Queue>(KEY); const q = row?.payload; if (!q) return null;
    const now = this.clock();
    let total = 0, done = 0, failed = 0, running = 0, waiting = 0; let date: string | undefined; let mode: UpdateMode | undefined; let active = false;
    for (const job of q.jobs) {
      if (!job.owner.startsWith('system:close')) continue;
      const p = this.progress(q, job, this.clock());
      const tag = job.owner.slice('system:close:'.length).split(':')[0];
      if (tag) date = tag;
      if (job.mode) mode = job.mode;
      total += p.total; done += p.done; failed += p.failed; running += p.running; waiting += p.waiting;
      if (!p.finished) active = true;
    }
    if (total === 0) return null;
    return { active, date, mode, total, done, failed, running, waiting, finished: !active,
      pausedUntil: q.pauseUntil, workerOnline: now - q.workerAt < 90e3 };
  }
  async status(owner: string): Promise<UpdateProgress | null> {
    const row = await this.store.read<Queue>(KEY); const q = row?.payload;
    const job = q?.jobs.filter(j => j.owner === owner).at(-1);
    return q && job ? this.progress(q, job, this.clock()) : null;
  }
  /** 全局 worker 暂停截止时间（0 = 未暂停）。 */
  async workerPausedUntil(): Promise<number> {
    const row = await this.store.read<Queue>(KEY);
    return row?.payload?.pauseUntil ?? 0;
  }
  /** 管理员主动暂停/恢复后台队列消费：暂停期间 claim() 不派发新任务，在飞阶段照常收尾。 */
  async setWorkerPaused(paused: boolean, durationMs = 24 * 3600e3): Promise<number> {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 7 * 24 * 3600e3) throw new UpdateQueueError('暂停时长无效（最长 7 天）', 400);
    return this.change((q, now) => {
      q.pauseUntil = paused ? now + durationMs : 0;
      return q.pauseUntil;
    });
  }
  async claim(): Promise<{ symbol: string; lease: string; mode:UpdateMode;targetDate?:string;phase:number;initialize?:boolean;phaseErrors?:Record<string,string> } | null> {
    return this.change((q, now) => {
      q.workerAt = now;
      if (q.pauseUntil > now) return null;
      const running = Object.values(q.items).find(i => i.state === 'running' && (i.leaseUntil ?? 0) > now);
      if (running) return null; // One company across ALL server instances.
      const expired = Object.values(q.items).find(i => i.state === 'running');
      if (expired) { expired.state = expired.attempts >= 3 ? 'failed' : 'queued'; expired.error = '后台执行中断'; expired.nextAt = now + 60e3; if (expired.state === 'failed') expired.doneAt = now; }
      const item = Object.values(q.items).filter(i => i.state === 'queued' && i.nextAt <= now).sort((a,b)=>Number(b.mode==='daily')-Number(a.mode==='daily') || Number(b.mode==='financial')-Number(a.mode==='financial') || a.nextAt-b.nextAt)[0];
      if (!item) return null;
      item.state = 'running'; item.attempts++; item.lease = randomUUID(); item.leaseUntil = now + LEASE;
      return { symbol: item.symbol, lease: item.lease,mode:item.mode??'recent',targetDate:item.targetDate,phase:item.phase??0,initialize:item.initialize,phaseErrors:item.phaseErrors };
    });
  }
  async renew(symbol: string, lease: string): Promise<boolean> {
    return this.change((q, now) => {
      q.workerAt = now; const i = Object.values(q.items).find(i=>i.symbol===symbol && i.lease===lease);
      if (!i || i.state !== 'running' || i.lease !== lease || (i.leaseUntil ?? 0) <= now) return false;
      i.leaseUntil = now + LEASE; return true;
    });
  }
  async finish(symbol: string, lease: string, error?: string, limited = false, nextPhase?:number): Promise<boolean> {
    return this.change((q, now) => {
      const i = Object.values(q.items).find(i=>i.symbol===symbol && i.lease===lease);
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
        ['queued', 'running'].includes(q.items[job.itemKeys?.[symbol]??symbol]?.state));
      job.finishedAt = now;
      job.result = { done: before.done, failed: before.failed + cancelled.length,
        errors: [...before.errors, ...cancelled.map(symbol => ({ symbol, message: '已手动停止' }))] };
      for (const symbol of cancelled) {
        if (q.jobs.some(other => other.id !== job.id && !other.result &&
          other.symbols.includes(symbol) && (other.itemKeys?.[symbol]??symbol)===(job.itemKeys?.[symbol]??symbol) && !other.skipped.includes(symbol))) continue;
        const i = q.items[job.itemKeys?.[symbol]??symbol];
        if (i && ['queued', 'running'].includes(i.state)) {
          i.state = 'failed'; i.error = '已手动停止'; i.doneAt = now; i.lease = undefined; i.leaseUntil = 0;
        }
      }
      return this.progress(q, job, now);
    });
  }
}
