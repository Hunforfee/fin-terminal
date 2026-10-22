import { marketRecord, type MarketStore } from './marketStore';

const KEY = 'market-update-run-log:v1';
const MAX_RUNS = 60; // 约两个月（每日一场），周日场一并留存
export interface RunLogError { symbol: string; message: string }
export interface RunLog {
  id: string;
  owner: string;
  mode: string;
  startedAt: number;
  finishedAt: number;
  total: number;
  done: number;
  failed: number;
  errors: RunLogError[];
}

/** Append a completed run to the rolling log. Best-effort: never throws to callers. */
export async function appendRunLog(store: MarketStore, run: RunLog): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await store.read<{ runs: RunLog[] }>(KEY);
    const runs = row?.payload?.runs ?? [];
    const next = [run, ...runs].slice(0, MAX_RUNS);
    if (await store.write(marketRecord(KEY, 'market-update-run-log', 'internal', { runs: next }, 864e5 * 2, Date.now()), row?.digest ?? null)) return;
  }
}

export async function getRunLog(store: MarketStore): Promise<RunLog[]> {
  return (await store.read<{ runs: RunLog[] }>(KEY))?.payload?.runs ?? [];
}
