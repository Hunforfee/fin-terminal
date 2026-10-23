import { collectHistoryPhase, coverageKey } from './marketHistoryCollection';
import { applyGapClassification, classifyCoverage, readFillGap } from './marketFillGaps';
import { normalizeStockCode } from './datasource/codes';
import type { MarketStore } from './marketStore';

export interface GapResolveItem {
  symbol: string;
  status: 'cleared' | 'remaining' | 'error';
  cleared: boolean;
  remaining?: { mcp: string[]; manual: string[] };
  error?: string;
}

/** 单个 symbol 复核超时：phase 12 以库内复核为主，30s 足够，超时按未解决处理。 */
const PER_SYMBOL_TIMEOUT = 30e3;

/**
 * 逐 symbol 重跑覆盖复核（phase 12）：通过 → 清除缺口登记；仍 partial → 更新缺口内容。
 * 管理员导入路由与维护端 API 共用；复核路径自带只读预算，不受页面只读模式影响。
 */
export async function resolveMarketGaps(store: MarketStore, symbols: string[]): Promise<GapResolveItem[]> {
  const results: GapResolveItem[] = [];
  for (const raw of symbols) {
    const n = normalizeStockCode(raw);
    if (!n || n.kind !== 'stock') {
      results.push({ symbol: raw, status: 'error', cleared: false, error: '证券代码无效' });
      continue;
    }
    const symbol = n.symbol;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(Error('复核超时')), PER_SYMBOL_TIMEOUT);
      let phaseError: Error | null = null;
      try {
        await collectHistoryPhase(symbol, 12, abort.signal);
      } catch (e) {
        phaseError = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
      }
      // phase 12 覆盖不足时抛「已保存可用数据；…」（记录已落库），属预期结果；其余错误（超时等）按失败处理。
      if (phaseError && !phaseError.message.startsWith('已保存可用数据')) throw phaseError;
      const coverage = (await store.read<Record<string, unknown>>(coverageKey(symbol)))?.payload ?? null;
      if (!coverage || !['ready', 'partial'].includes(String(coverage.status))) throw Error('覆盖复核结果缺失或无效');
      const classified = classifyCoverage(coverage as { status?: string; missingInputs?: unknown; gaps?: unknown } | null);
      const gap = await applyGapClassification(store, symbol, classified, { mode: 'ten-year' });
      if (gap) results.push({ symbol, status: 'remaining', cleared: false, remaining: { mcp: gap.mcp, manual: gap.manual } });
      else results.push({ symbol, status: 'cleared', cleared: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : '复核失败';
      const gap = await readFillGap(store, symbol).catch(() => null);
      results.push({ symbol, status: 'error', cleared: false, error: message, ...(gap ? { remaining: { mcp: gap.mcp, manual: gap.manual } } : {}) });
    }
  }
  return results;
}
