import type { MarketRecord } from './marketStore';

export interface HkStatementRow { date: string; itemCode: string; itemName: string; amount: number | null }

/** Legacy MCP imports never declared their scope and must be rechecked as partial. */
export function completeHkStatement(record: Pick<MarketRecord, 'source' | 'payload'> | null | undefined, date: string): boolean {
  if (!record || typeof record.source !== 'string' || !(record.source.startsWith('hkf10:statement:') || record.source.startsWith('import:hk-statement:complete:'))) return false;
  const rows = record.payload as HkStatementRow[];
  return Array.isArray(rows) && rows.length > 0 &&
    rows.every(r => r && r.date === date && typeof r.itemCode === 'string' && r.itemCode.length &&
      (r.amount === null || typeof r.amount === 'number' && Number.isFinite(r.amount))) &&
    new Set(rows.map(r => r.itemCode)).size === rows.length &&
    rows.some(r => typeof r.amount === 'number' && Number.isFinite(r.amount));
}

/** Known imported facts survive a thinner reply; conflicting currency/amount observations must be reconciled.
 *  options.overwrite 仅用于管理员全量快照修正历史口径缺陷：冲突金额以上传快照为准，经 onOverwrite 回调留痕。 */
export function mergeHkStatementRows(prior: HkStatementRow[], incoming: HkStatementRow[], date: string,
    options: { overwrite?: boolean; onOverwrite?: (row: HkStatementRow & { prevAmount: number }) => void } = {}): HkStatementRow[] {
  const union = new Map(prior.filter(r => r.date === date).map(r => [r.itemCode, r]));
  for (const row of incoming) {
    const prev = union.get(row.itemCode);
    if (prev?.amount != null && row.amount != null &&
      Math.abs(prev.amount - row.amount) > Math.max(1e-6, Math.abs(prev.amount) * 1e-9)) {
      if (!options.overwrite) throw Error(`港股报表金额冲突: ${date} ${row.itemCode}（${prev.amount} → ${row.amount}），保留原记录`);
      options.onOverwrite?.({ ...row, prevAmount: prev.amount });
    }
    union.set(row.itemCode, { ...prev, ...row, date, amount: row.amount ?? prev?.amount ?? null });
  }
  return [...union.values()].sort((a,b) => a.itemCode.localeCompare(b.itemCode));
}
