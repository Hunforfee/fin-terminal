import { marketRecord, type MarketStore } from './marketStore';
import { normalizeStockCode } from './datasource/codes';

/**
 * 待补齐缺口登记（gap ledger）。
 *
 * 网站自身的抓取（腾讯→新浪→东财→快照）仍失败或覆盖不足时，按证券登记一条
 * `market-fill-gaps:v1:<symbol>` 记录，把缺口分成两类：
 *   - mcp：存在导入写入器，WorkBuddy 可经 MCP 取数后写回（见 marketHkImportRecords / marketImportRecords）
 *   - manual：没有稳定的 MCP 字段映射（如 sina 指标页、公告日期、东财选股页），只能靠网站重试或人工
 * 设计性缺口（如「港股历史估值不生成分位」）不登记——那不是数据缺失。
 *
 * 该 kind 不在 retention 的清理名单内，TTL 只影响刷新时间；每次复核都会重写。
 */
export const FILL_GAP_KIND = 'market-fill-gaps';
export const fillGapKey = (symbol: string) => `market-fill-gaps:v1:${symbol}`;
const TTL = 30 * 864e5;

export interface FillGap {
  symbol: string;
  code: string;
  market: 'A' | 'HK';
  mode?: string;
  phase?: number;
  error?: string;
  /** MCP 可补齐的数据域（记录键或域标签） */
  mcp: string[];
  /** 仅能靠网站自身重试的数据域 */
  manual: string[];
  notes: string[];
  attempts: number;
  updatedAt: string;
}

export interface GapClassification {
  mcp: string[];
  manual: string[];
  notes: string[];
}

const clip = (s: string, max = 180) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** 单条缺失记录键 → 数据域。无写入器的键归入 manual（原键保留，便于排查）。 */
export function classifyMissingKey(key: string): { domain: string; mcp: boolean } {
  if (/^kline:v2:/.test(key)) return { domain: 'kline', mcp: true };
  const sinaPage = key.match(/^source-sina-page:v1:\d+:(profit|balance|cashflow):(\d{4})$/);
  if (sinaPage) return { domain: `finance:${sinaPage[1]}:${sinaPage[2]}`, mcp: true };
  if (key.startsWith('statements-v3:')) return { domain: 'financial-history', mcp: true };
  if (key.startsWith('shares-v3:')) return { domain: 'share-history', mcp: true };
  if (key.startsWith('dividend-plans-v2:')) return { domain: 'dividend-plans', mcp: true };
  if (key.startsWith('implemented-dividends-v4:')) return { domain: 'dividend-impl', mcp: true };
  const hkStmt = key.match(/^source-hk-statement:v1:[\d.]+HK:(profit|balance|cashflow):(\d{4}-\d{2}-\d{2})$/);
  if (hkStmt) return { domain: `hk-statements:${hkStmt[1]}:${hkStmt[2]}`, mcp: true };
  if (key.startsWith('hk-dividend-events-v4:')) return { domain: 'hk-dividend-events', mcp: true };
  return { domain: key, mcp: false };
}

/** coverage.gaps 文案 → 数据域。设计性缺口返回 null（不登记）。 */
export function classifyGapText(text: string): { domains: string[]; mcp: boolean; note?: string } | null {
  if (text.includes('港股历史估值')) return null; // 设计性：港股不生成历史分位
  if (text.includes('历史起点覆盖不足')) return { domains: ['kline'], mcp: true, note: 'K 线历史起点不足五年或缺少已核实上市日期，可经 MCP 回补不复权日线' };
  if (text.includes('部分交易日缺少已披露财报')) return { domains: ['statements-v3', 'shares-v3'], mcp: true, note: '部分交易日缺少财报/股本/复权数据，可经 MCP 全量导入财务史与股本史' };
  return { domains: [text], mcp: false };
}

/** phase 3—9 每年对应一个抓取阶段；失败域按年份精确化。 */
function yearForPhase(phase: number, now = Date.now()): number {
  return new Date(now + 8 * 3600e3).getUTCFullYear() - (phase - 3);
}

export function classifyPhaseFailure(phase: number, market: 'A' | 'HK', now = Date.now()): GapClassification {
  const mcp: string[] = [], manual: string[] = [], notes: string[] = [];
  if (phase === 0 || phase === 1) mcp.push('kline');
  else if (phase === 2) {
    if (market === 'HK') { mcp.push('hk-dividend-events'); manual.push('hk-main-currency-v4'); }
    else { mcp.push('dividend-plans', 'dividend-impl', 'share-history'); manual.push('screen-company-input:v1', 'watchlist-financial-inputs:v1'); }
  } else if (phase >= 3 && phase <= 9) {
    const year = yearForPhase(phase, now);
    if (market === 'HK') { mcp.push('hk-statements'); manual.push('source-hk-indicators:v1'); }
    else {
      mcp.push(`finance:profit:${year}`, `finance:balance:${year}`, `finance:cashflow:${year}`);
      manual.push(`source-sina-indicators:v1:${year}`);
    }
  } else if (phase === 10) mcp.push('financial-history');
  else if (phase === 11) manual.push('disclosures-v3');
  else if (phase === 13) manual.push('公司资料/研报/公告等可选内容');
  else manual.push(`阶段 ${phase}`);
  return { mcp, manual, notes };
}

/** coverage 记录 → 分类。status=ready 或仅剩设计性缺口时返回 null（无需登记）。 */
export function classifyCoverage(coverage: { status?: string; missingInputs?: unknown; gaps?: unknown } | null | undefined): GapClassification | null {
  if (!coverage || coverage.status !== 'partial') return null;
  const mcp: string[] = [], manual: string[] = [], notes: string[] = [];
  for (const key of Array.isArray(coverage.missingInputs) ? coverage.missingInputs.map(String) : []) {
    const { domain, mcp: fillable } = classifyMissingKey(key);
    (fillable ? mcp : manual).push(domain);
  }
  for (const text of Array.isArray(coverage.gaps) ? coverage.gaps.map(String) : []) {
    const classified = classifyGapText(text);
    if (!classified) continue;
    (classified.mcp ? mcp : manual).push(...classified.domains);
    if (classified.note) notes.push(classified.note);
  }
  if (!mcp.length && !manual.length) return null;
  return { mcp: [...new Set(mcp)], manual: [...new Set(manual)], notes: [...new Set(notes)] };
}

const dedupe = (values?: string[]) => [...new Set((values ?? []).filter(Boolean))];

/** 读取/登记/清除。逐 symbol 一条记录，原子写，无单记录争抢。 */
export async function readFillGap(store: MarketStore, symbol: string): Promise<FillGap | null> {
  const row = await store.read<FillGap>(fillGapKey(symbol));
  return row?.payload ?? null;
}

export async function recordFillGap(store: MarketStore, symbol: string, entry: Omit<FillGap, 'symbol' | 'code' | 'market' | 'attempts' | 'updatedAt'> & { attempts?: number }, now = Date.now()): Promise<FillGap | null> {
  const n = normalizeStockCode(symbol);
  if (!n || n.kind !== 'stock') return null;
  const row = await store.read<FillGap>(fillGapKey(n.symbol)), prior = row?.payload ?? null;
  const gap: FillGap = {
    symbol: n.symbol, code: n.code, market: n.market === 'HK' ? 'HK' : 'A',
    mode: entry.mode, phase: entry.phase, error: entry.error ? clip(entry.error) : undefined,
    mcp: dedupe(entry.mcp), manual: dedupe(entry.manual), notes: dedupe(entry.notes),
    attempts: (prior?.attempts ?? 0) + 1, updatedAt: new Date(now).toISOString(),
  };
  const record = marketRecord(fillGapKey(n.symbol), FILL_GAP_KIND, 'internal', gap, TTL, now);
  if (!await store.write(record, row?.digest ?? null)) {
    // 版本冲突：重读一次最新 digest 再写
    const fresh = await store.read(fillGapKey(n.symbol));
    if (!await store.write(record, fresh?.digest ?? null)) throw Error('缺口登记版本冲突，请重试');
  }
  return gap;
}

export async function clearFillGap(store: MarketStore, symbol: string): Promise<boolean> {
  const n = normalizeStockCode(symbol);
  if (!n) return false;
  const row = await store.read(fillGapKey(n.symbol));
  if (!row) return false;
  if (!store.remove) throw Error('缺口数据库不支持清除记录');
  if (!await store.remove(fillGapKey(n.symbol), row.digest)) {
    // A competing remover may already have cleared it. A surviving record is not success.
    if (await store.read(fillGapKey(n.symbol))) throw Error('缺口清除版本冲突，请重试');
  }
  return true;
}

/** 复核后落地：有可行动缺口则登记，否则清除。返回登记结果（null=已清除/无需登记）。 */
export async function applyGapClassification(store: MarketStore, symbol: string, classified: GapClassification | null, extra: { mode?: string; phase?: number; error?: string } = {}, now = Date.now()): Promise<FillGap | null> {
  if (!classified) { await clearFillGap(store, symbol); return null; }
  return recordFillGap(store, symbol, { ...extra, ...classified }, now);
}

/** 枚举全部缺口（元信息 + payload）。 */
export async function listFillGaps(store: MarketStore, limit = 200): Promise<FillGap[]> {
  if (!store.scanPrefix) return [];
  const metas = await store.scanPrefix('market-fill-gaps:v1:', Math.max(1, Math.min(500, limit)));
  const gaps: FillGap[] = [];
  for (const meta of metas) {
    const row = await store.read<FillGap>(meta.key);
    if (row?.payload?.symbol) gaps.push(row.payload);
  }
  return gaps.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * 后台更新失败后的登记逻辑：
 * - phase 12（末阶段）自己会写 coverage 并调用 applyGapClassification；若本次 tick 已跑过
 *   （coverage.checkedAt 不早于 tick 起点）则无需重复登记。
 * - 更早阶段失败时按 phase 分类，并合并历史上一次 coverage 的分类（若仍 partial）。
 */
export async function recordGapAfterFailure(store: MarketStore, symbol: string, options: { mode?: string; phase: number; error?: string; phaseErrors?: Record<string, string>; startedAt: number; now?: number }): Promise<FillGap | null> {
  const now = options.now ?? Date.now();
  const coverage = await store.read<{ status?: string; missingInputs?: unknown; gaps?: unknown; checkedAt?: string }>(`market-coverage:v1:${symbol}:5`);
  if (coverage?.payload?.checkedAt && coverage.payload.checkedAt >= new Date(options.startedAt).toISOString()) return null; // phase 12 已处理
  const n = normalizeStockCode(symbol);
  const market = n?.market === 'HK' ? 'HK' : 'A';
  const mcp: string[] = [], manual: string[] = [], notes: string[] = [];
  const phases = new Set<number>([options.phase, ...Object.keys(options.phaseErrors ?? {}).map(Number)]);
  for (const phase of phases) {
    if (!Number.isInteger(phase) || phase < 0) continue;
    const part = classifyPhaseFailure(phase, market, now);
    mcp.push(...part.mcp); manual.push(...part.manual); notes.push(...part.notes);
  }
  if (options.error) notes.push(`失败原因：${clip(options.error)}`);
  const stale = classifyCoverage(coverage?.payload ?? null);
  if (stale) { mcp.push(...stale.mcp); manual.push(...stale.manual); notes.push(...stale.notes); }
  if (!mcp.length && !manual.length) { await clearFillGap(store, symbol); return null; }
  return recordFillGap(store, symbol, { mode: options.mode, phase: options.phase, error: options.error, mcp, manual, notes }, now);
}
