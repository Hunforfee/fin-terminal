/** Per-process, per-host circuit. It shares failures, never financial values. */
type State={until:number;status:number;failures:number};
export class SourceCooldown {
  private hosts=new Map<string,State>();
  constructor(private clock=Date.now,private capacity=128){}
  private put(host:string,state:State){
    this.hosts.delete(host);this.hosts.set(host,state);
    while(this.hosts.size>this.capacity)this.hosts.delete(this.hosts.keys().next().value!);
  }
  active(url:string):State|null{
    const host=new URL(url).hostname,state=this.hosts.get(host);
    if(!state || state.until<=this.clock())return null;
    return {...state};
  }
  observe(url:string,status:number,retryAfter:string|null=null){
    const defaults:Record<number,number>={403:60e3,429:300e3,501:60e3,503:30e3};
    if(!defaults[status])return;
    const now=this.clock(),numeric=retryAfter?.trim()?Number(retryAfter):NaN;
    const requested=Number.isFinite(numeric)?numeric*1000:retryAfter?Date.parse(retryAfter)-now:NaN;
    const duration=Number.isFinite(requested) && requested>0?Math.min(1800e3,Math.max(1000,requested)):defaults[status];
    const host=new URL(url).hostname,prior=this.hosts.get(host);
    this.put(host,{until:Math.max(prior?.until??0,now+duration),status,failures:0});
  }
  failed(url:string){
    const host=new URL(url).hostname,prior=this.hosts.get(host);
    if(prior && prior.until>this.clock())return;
    const failures=(prior?.failures??0)+1;
    this.put(host,{until:failures>=2?this.clock()+30e3:0,status:0,failures});
  }
  succeeded(url:string){
    const host=new URL(url).hostname,prior=this.hosts.get(host);
    // A request started before another request hit a limiter cannot close it.
    if(!prior || prior.until<=this.clock())this.hosts.delete(host);
  }
  clear(){this.hosts.clear();}
}
// Next routes may load separate copies of a shared chunk. Keep one circuit in
// the process runtime as well as sharing it between individual update budgets.
const runtime=globalThis as typeof globalThis & {finMarketSourceCooldown?:SourceCooldown};
export const marketSourceCooldown=runtime.finMarketSourceCooldown??=new SourceCooldown();
