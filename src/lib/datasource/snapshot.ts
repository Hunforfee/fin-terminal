/**
 * 兜底快照层。
 *
 * 目的：上游全部不可达（断网 / IP 被封 / 连接器下线）时，页面仍能给出
 * 有意义的数值而不是一片 "--"。快照由 `npm run seed` 用真实接口抓取生成，
 * 因此它是**真实数据的历史切片**，不是编造的假数据。
 *
 * 加载方式：运行时用 fs 读取，避免构建期强依赖文件存在。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candle, KLineSeries, Quote } from './types';

interface SnapshotFile {
  generatedAt: string;
  quotes: Quote[];
  klines: Record<string, { period: string; candles: Candle[] }>;
}

const SNAPSHOT_PATH = path.join(process.cwd(), 'src', 'data', 'snapshots', 'market.json');

let cache: SnapshotFile | null = null;
let loadFailed = false;

async function load(): Promise<SnapshotFile | null> {
  if (cache) return cache;
  if (loadFailed) return null;
  try {
    const text = await readFile(SNAPSHOT_PATH, 'utf-8');
    cache = JSON.parse(text) as SnapshotFile;
    return cache;
  } catch {
    loadFailed = true;
    return null;
  }
}

/** 标记快照数据为 stale，让 UI 能提示「非实时」 */
function markStale<T extends { stale: boolean; source: string }>(v: T): T {
  return { ...v, stale: true, source: `${v.source}-snapshot` };
}

export async function snapshotQuote(code: string): Promise<Quote | null> {
  const snap = await load();
  if (!snap) return null;
  const hit = snap.quotes.find((q) => q.code === code);
  return hit ? markStale(hit) : null;
}

export async function snapshotQuotes(codes: string[]): Promise<Quote[]> {
  const snap = await load();
  if (!snap) return [];
  const set = new Set(codes);
  return snap.quotes.filter((q) => set.has(q.code)).map(markStale);
}

export async function snapshotKLine(
  symbol: string,
  period: string,
): Promise<KLineSeries | null> {
  const snap = await load();
  if (!snap) return null;
  const key = `${symbol}:${period}`;
  const hit = snap.klines[key];
  if (!hit) return null;
  return markStale({
    symbol,
    code: symbol.slice(2),
    period: period as KLineSeries['period'],
    adjust: 'qfq' as KLineSeries['adjust'],
    candles: hit.candles,
    source: 'snapshot',
    stale: false,
  });
}

export async function snapshotInfo(): Promise<{ generatedAt: string | null; count: number }> {
  const snap = await load();
  if (!snap) return { generatedAt: null, count: 0 };
  return { generatedAt: snap.generatedAt, count: snap.quotes.length };
}
