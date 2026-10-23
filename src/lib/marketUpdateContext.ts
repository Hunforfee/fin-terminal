import { AsyncLocalStorage } from 'node:async_hooks';
import { getMarketStore } from './marketStore';
import { acquireSourceSlot } from './sourceCoordination';
import { installSourceCoordinator, installBudgetResolver, type UpstreamBudget } from './upstreamBudget';
const runtime = globalThis as typeof globalThis & { finUpdateStorage?: AsyncLocalStorage<UpstreamBudget> };
const storage = runtime.finUpdateStorage ??= new AsyncLocalStorage<UpstreamBudget>();
installBudgetResolver(() => storage.getStore());
export const withUpstreamBudget = <T>(budget: UpstreamBudget, fn: () => Promise<T>): Promise<T> => storage.run(budget, fn);

installSourceCoordinator(async(url,signal)=>{
 const store=getMarketStore();
 return store ? acquireSourceSlot(store,url,signal) : undefined;
});
