import { getMarketStore, marketDigest, marketRecord, type MarketStore } from './marketStore';
import { cachedMarketInput, validateDatedRows } from './marketInputs';
import { databaseOnly } from './marketReadPolicy';
import { withMarketRefresh } from './marketRefresh';
import { reportCutoff, financialEarliestYear, HISTORY_YEARS } from './marketHistoryPlan';
import { retainMarketPayload } from './marketRetention';
import { fetchStatementHistory, statementPointsFromPages, type FinStatementPoint } from './datasource/sinaFinStatements';
import type { StatementSourcePage } from './datasource/eastmoneyStatements';
import type { ShareChange } from './datasource/sinaFinance';

/** Derived financial history must follow changes to saved source pages, even
 * during database-only coverage checks. Never fetch a source from this rebuild. */
export async function getFinancialHistoryInput(code: string, span: number): Promise<FinStatementPoint[]> {
  const store = getMarketStore();
  if (!store) return fetchStatementHistory(code, span);
  // Keep the existing network-enabled cold-start/refresh behavior. Read-only
  // requests and the worker's reconstruction below use saved source pages only.
  if (!databaseOnly()) await cachedMarketInput(`statements-v3:${code}:${span}`, 'financial-history',
    'public-statements:CNY:yuan:current-revisions', 1800e3, () => fetchStatementHistory(code, span),
    rows => validateDatedRows(rows as unknown as Record<string, unknown>[], 'date', ['npParent', 'equityParent']));
  return rebuildFinancialHistoryInput(code, span, store);
}

export async function rebuildFinancialHistoryInput(code: string, span: number,
  store: MarketStore | null = getMarketStore(), now = Date.now()): Promise<FinStatementPoint[]> {
  if (!/^\d{6}$/.test(code) || !Number.isInteger(span) || span < 2 || span > HISTORY_YEARS + 2) throw Error('财务史范围无效');
  if (!store) return fetchStatementHistory(code, span);
  const key = `statements-v3:${code}:${span}`;
  return withMarketRefresh(store, key, async () => {
    const pageKeys: string[] = [];
    for (let year = new Date(now + 8 * 3600e3).getUTCFullYear(); year >= financialEarliestYear(now); year--)
      for (const id of ['profit', 'balance']) pageKeys.push(`source-sina-page:v1:${code}:${id}:${year}`);
    const sharesKey = `shares-v3:${code}`;
    const historyKeys = [...new Set([key, `statements-v3:${code}:11`, `statements-v3:${code}:12`, `statements-v3:${code}:13`, `statements-v3:${code}:${HISTORY_YEARS+1}`, `statements-v3:${code}:${HISTORY_YEARS+2}`])];
    const keys = [...pageKeys, sharesKey, ...historyKeys];
    const records = store.readInputs ? await store.readInputs(keys) : (await Promise.all(keys.map(k => store.read(k)))).filter(r => r !== null);
    const saved = new Map(records.map(r => [r.key, r]));
    const old = saved.get(key);
    const basis = marketDigest([reportCutoff(now), ...[...pageKeys, sharesKey].map(k => [k, saved.get(k)?.digest ?? null])]);
    const source = `derived-public-statements:v2:CNY:yuan:${basis}`;
    if (old?.source === source) {
      const rows = retainMarketPayload('financial-history', old.payload as FinStatementPoint[], now);
      validateDatedRows(rows as unknown as Record<string, unknown>[], 'date', ['npParent', 'equityParent']);
      if (Date.parse(old.refreshAfter) <= now && !await store.write(marketRecord(key, 'financial-history', source, rows, 1800e3, now), old.digest))
        throw Error('财务史重建写入冲突，请重试');
      return rows;
    }
    // Preserve imported amounts and dates that a thinner source page cannot supply.
    const merged = new Map<string, { point: FinStatementPoint; at: string }>();
    for (const record of historyKeys.map(k => saved.get(k)).filter(r => r !== undefined)
      .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt))) {
      for (const p of record.payload as FinStatementPoint[]) {
        if (p.date < reportCutoff(now)) continue;
        const prior = merged.get(p.date)?.point;
        const point = { date: p.date, npParent: null, npTotal: null, equityParent: null,
          equityTotal: null, sharesYi: null, ...prior } as FinStatementPoint;
        for (const [field, value] of Object.entries(p)) if (value != null) (point as unknown as Record<string, unknown>)[field] = value;
        merged.set(p.date, { point, at: record.acquiredAt });
      }
    }
    const shares = saved.get(sharesKey)?.payload as ShareChange[] | undefined ?? [];
    for (let i = 0; i < pageKeys.length; i += 2) {
      const pl = saved.get(pageKeys[i]), bs = saved.get(pageKeys[i + 1]);
      for (const record of [pl, bs]) if (record && !['万元', 'wan', '人民币万元'].includes((record.payload as StatementSourcePage).unit))
        throw Error('已保存财报金额单位不匹配');
      for (const p of statementPointsFromPages(pl?.payload as StatementSourcePage ?? null, bs?.payload as StatementSourcePage ?? null, shares)) {
        const prev = merged.get(p.date), point = { ...(prev?.point ?? p) };
        for (const field of ['npParent', 'npTotal', 'equityParent', 'equityTotal', 'equityCommon', 'sharesYi'] as const) {
          const dependency = field.startsWith('np') ? 'profit' : field === 'sharesYi' ? 'shares' : 'balance';
          const input = dependency === 'profit' ? pl : dependency === 'shares' ? saved.get(sharesKey) : bs;
          const acquired = field.startsWith('np') ? pl?.acquiredAt : field === 'sharesYi' ? saved.get(sharesKey)?.acquiredAt : bs?.acquiredAt;
          const changed = prev?.point.inputDigests?.[dependency] !== undefined && prev.point.inputDigests[dependency] !== input?.digest;
          if (p[field] != null && (point[field] == null || !prev || changed || acquired && acquired > prev.at)) point[field] = p[field];
        }
        point.inputDigests = { ...point.inputDigests,
          ...(pl && (pl.payload as StatementSourcePage).dates.includes(p.date) ? { profit: pl.digest } : {}),
          ...(bs && (bs.payload as StatementSourcePage).dates.includes(p.date) ? { balance: bs.digest } : {}),
          ...(saved.get(sharesKey) ? { shares: saved.get(sharesKey)!.digest } : {}) };
        point.sources = [...new Set([...(point.sources ?? []), ...(p.sources ?? [])])];
        merged.set(p.date, { point, at: prev?.at ?? pl?.acquiredAt ?? bs!.acquiredAt });
      }
    }
    const rows = retainMarketPayload('financial-history', [...merged.values()].map(r => r.point).sort((a, b) => a.date.localeCompare(b.date)), now);
    validateDatedRows(rows as unknown as Record<string, unknown>[], 'date', ['npParent', 'equityParent']);
    if (!await store.write(marketRecord(key, 'financial-history', source, rows, 1800e3, now), old?.digest ?? null))
      throw Error('财务史重建写入冲突，请重试');
    return rows;
  });
}
