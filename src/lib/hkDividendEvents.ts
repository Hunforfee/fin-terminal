import type { HkDividendKind, HkDividendRecord } from './datasource/hkDividends';

export function dividendPeriodInfo(period: string): { fiscalYear?: string; kind: HkDividendKind } {
  const text = period.normalize('NFKC').replace(/\s+/g, '');
  const fiscalYear = text.match(/(?:^|\D)((?:19|20)\d{2})(?=\D|$)/)?.[1];
  if (/特别|特殊|special/i.test(text)) return { fiscalYear, kind: 'special' };
  const quarter = text.match(/第?([一二三四1-4])季(?:度)?/i)?.[1] ?? text.match(/Q([1-4])/i)?.[1];
  if (quarter) {
    const number = ({一:'1',二:'2',三:'3',四:'4'} as Record<string,string>)[quarter] ?? quarter;
    return { fiscalYear, kind: `q${number}` as HkDividendKind };
  }
  if (/中期|中报|半年|H1/i.test(text)) return { fiscalYear, kind: 'interim' };
  if (/末期|年终|全年|年度|年报|H2/i.test(text)) return { fiscalYear, kind: 'final' };
  return { fiscalYear, kind: 'unknown' };
}

/** Source IDs are provenance, not cross-provider event identities. */
export function dividendIdentity(record: HkDividendRecord): string {
  const info = dividendPeriodInfo(record.period);
  const kind = record.special ? 'special' : record.kind ?? info.kind;
  const slot = kind === 'interim' || kind === 'q2' ? 'h1' : kind === 'final' || kind === 'q4' ? 'closing' : kind;
  return JSON.stringify([record.fiscalYear ?? info.fiscalYear ?? record.period, slot, record.exDate,
    ...(kind === 'special' || kind === 'unknown' ? [record.noticeDate, record.dps] : [])]);
}

/** Shared by imports, refreshes and valuation. Never merge ordinary and special cash. */
export function mergeHkDividendEvents(prior: HkDividendRecord[], incoming: HkDividendRecord[], rejectConflicts = false): HkDividendRecord[] {
  const values: HkDividendRecord[] = [];
  for (const row of [...prior, ...incoming]) {
    const info = dividendPeriodInfo(row.period);
    let next: HkDividendRecord = { ...row, noticeDate: row.noticeDate ?? '',
      fiscalYear: row.fiscalYear ?? info.fiscalYear,
      kind: row.special ? 'special' : row.kind ?? info.kind };
    let index = values.findIndex(p => dividendIdentity(p) === dividendIdentity(next) ||
      !!row.eventId && p.eventId === row.eventId);
    if (index < 0 && !next.special) {
      // Old imports may have only a report-date period and no kind. Match only
      // one compatible ordinary component; never guess between several payments.
      const candidates = values.flatMap((p,i) => !p.special && p.exDate === next.exDate &&
        (!!p.fiscalYear && p.fiscalYear === next.fiscalYear || p.period === next.period) &&
        ((p.kind === 'unknown') !== (next.kind === 'unknown')) ? [i] : []);
      if (candidates.length > 1) throw Error('港股分红事件身份冲突：请补充分红类型');
      if (candidates.length === 1) index = candidates[0];
    }
    if (index < 0 && next.special) {
      const candidates = values.flatMap((p,i) => p.special && p.exDate === next.exDate &&
        p.noticeDate === next.noticeDate && (p.period === next.period || !!p.fiscalYear && p.fiscalYear === next.fiscalYear) &&
        (p.dps == null || next.dps == null) ? [i] : []);
      if (candidates.length > 1) throw Error('港股分红事件身份冲突：请补充特别息事件编号');
      if (candidates.length === 1) index = candidates[0];
    }
    if (index < 0) { values.push(next); continue; }
    const old = values[index];
    if (old.special !== next.special || old.exDate !== next.exDate) throw Error('港股分红事件身份冲突');
    if (rejectConflicts && old.dps != null && next.dps != null && Math.abs(old.dps-next.dps)>0.0001)
      throw Error(`港股分红金额冲突: ${next.exDate}（${old.dps} → ${next.dps}），保留原记录`);
    // An older disclosure cannot replace a newer amount. A missing amount never erases it.
    if (next.noticeDate < old.noticeDate && old.dps != null) next = { ...next, dps: old.dps };
    values[index] = { ...old, ...next, dps: next.dps ?? old.dps,
      noticeDate: next.noticeDate > old.noticeDate ? next.noticeDate : old.noticeDate,
      fiscalYear: next.fiscalYear ?? old.fiscalYear,
      kind: next.kind === 'unknown' ? old.kind : next.kind,
      eventId: old.eventId ?? next.eventId };
  }
  return values.sort((a,b) => a.exDate.localeCompare(b.exDate) || a.noticeDate.localeCompare(b.noticeDate));
}
