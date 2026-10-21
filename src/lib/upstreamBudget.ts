/** Shared by server-side HTTP calls during a background update. No browser timers. */
export class UpstreamBudget {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  private calls = 0;
  private blockedHosts = new Set<string>();
  limited = false;
  constructor(readonly signal: AbortSignal, private interval = 1500, private maxCalls = 40) {}
  async enter(url?: string): Promise<() => void> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      this.signal.throwIfAborted();
      if (this.limited) throw Error('上游限流，更新已暂停');
      if (url && this.blockedHosts.has(new URL(url).hostname)) throw Error('该镜像暂不可用，本次不重复请求');
      if (++this.calls > this.maxCalls) throw Error('单家公司请求预算已用完');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.nextAt - Date.now())));
      this.signal.throwIfAborted();
      return () => { this.nextAt = Date.now() + this.interval; release(); };
    } catch (e) { release(); throw e; }
  }
  observe(status: number, url?: string) {
    if ([403, 429].includes(status)) this.limited = true;
    // A WAF challenge on one public mirror is not proof that all mirrors are
    // rate-limited. Stop retrying that host; preserve the existing fallback chain.
    else if ([501, 503].includes(status) && url) this.blockedHosts.add(new URL(url).hostname);
  }
}
// The server installs an async-context resolver. Shared HTTP code stays browser
// compatible because indicator metadata is also imported by client components.
const runtime = globalThis as typeof globalThis & { finUpdateBudgetResolver?: () => UpstreamBudget | undefined };
export const installBudgetResolver = (resolver: () => UpstreamBudget | undefined) => { runtime.finUpdateBudgetResolver = resolver; };
export const currentUpstreamBudget = () => runtime.finUpdateBudgetResolver?.();
