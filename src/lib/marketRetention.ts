/** Rolling ten-calendar-year ceiling for PUBLIC market inputs, never personal data. */
export function marketCutoff(now = Date.now()): string {
  const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  const [year, month, date] = day.split('-').map(Number);
  const last = new Date(Date.UTC(year - 10, month, 0)).getUTCDate();
  return `${year - 10}-${String(month).padStart(2,'0')}-${String(Math.min(date,last)).padStart(2,'0')}`;
}
export const retainedDate = (date: unknown, now = Date.now()) => typeof date === 'string' && date.slice(0,10) >= marketCutoff(now);

export function retainMarketPayload<T>(kind: string, payload: T, now = Date.now()): T {
  const today=new Date(now+8*3600e3).toISOString().slice(0,10);
  const p = payload as any, keep = (date: unknown) => retainedDate(date, now) && (date as string).slice(0,10)<=today;
  if (!p) return payload;
  if(kind==='company-announcements' || kind==='company-reports')return p.filter((r:any)=>keep(r.date));
  if(kind==='financial-report-links')return p.filter((r:any)=>typeof r.announcementTime==='number' && Number.isFinite(r.announcementTime)
    && Math.abs(r.announcementTime)<=8.64e15 && keep(new Date(r.announcementTime+8*3600e3).toISOString().slice(0,10)));
  if (kind === 'kline') return { ...p, candles: p.candles.filter((r: any) => keep(r.date)),
    queries: (p.queries ?? []).filter((q: any) => q.at >= now - 7 * 864e5) };
  if (['disclosure-dates','source-debt-ratios','source-interest-expenses'].includes(kind)) {
    if (p instanceof Map) return new Map([...p].filter(([date]) => keep(date))) as T;
    if (Array.isArray(p.$marketMap)) return { ...p, $marketMap: p.$marketMap.filter(([date]: any[]) => keep(date)) };
  }
  const dateKeys: Record<string,string> = {
    'financial-history':'date', 'share-events':'date', 'implemented-dividends':'exDate',
    'announced-dividend-plans':'reportDate', 'hk-recent-dividend-events':'exDate',
    'source-hk-indicators':'date', 'source-hk-statement':'date', 'deducted-periods':'reportDate',
  };
  if (kind === 'share-events' && Array.isArray(p)) {
    const cutoff=marketCutoff(now), retained=p.filter((r: any)=>keep(r.date));
    // Carry a state at the boundary, not an invented share-change event.
    const prior=[...p].filter((r: any)=>typeof r.date==='string' && r.date<cutoff).sort((a: any,b: any)=>a.date.localeCompare(b.date)).at(-1);
    if(prior && !retained.some((r: any)=>r.date===cutoff))retained.unshift({...prior,date:cutoff,baseline:true});
    return retained as T;
  }
  if (Array.isArray(p) && dateKeys[kind]) return p.filter((r: any) => keep(r[dateKeys[kind]])) as T;
  if (kind === 'latest-company-financial-input') return { ...p,
    main: p.main.filter((r: any) => keep(r.REPORT_DATE)), income: p.income.filter((r: any) => keep(r.REPORT_DATE)),
    fetchedPeriods: Object.fromEntries(Object.entries(p.fetchedPeriods ?? {}).filter(([date]) => keep(date))) };
  if (kind === 'source-sina-page') {
    const indices = p.dates.flatMap((date: string,i: number) => keep(date) ? [i] : []);
    return { ...p, dates: indices.map((i: number) => p.dates[i]),
      rows: p.rows.map((r: any) => r.kind === 'group' ? r : { ...r, vals: indices.map((i: number) => r.vals[i] ?? null) }) };
  }
  if (kind === 'source-sina-indicators') {
    const indices = p.dates.flatMap((date: string,i: number) => keep(date) ? [i] : []);
    const rows = p.rows instanceof Map ? [...p.rows] : p.rows?.$marketMap ?? [];
    const entries = rows.map(([key,values]: [string,unknown[]]) => [key,indices.map((i: number) => values[i] ?? null)]);
    return { ...p, dates: indices.map((i: number) => p.dates[i]), rows: p.rows instanceof Map ? new Map(entries) : { $marketMap: entries } };
  }
  if (kind === 'watchlist-financial-inputs' && Array.isArray(p.periods)) {
    const indices = p.periods.flatMap((date: string,i: number) => keep(date) ? [i] : []);
    return { ...p, periods: indices.map((i: number) => p.periods[i]), periodLabels: indices.map((i: number) => p.periodLabels[i]),
      series: Object.fromEntries(Object.entries(p.series).map(([key,values]) => [key,indices.map((i: number) => (values as unknown[])[i])])) };
  }
  return payload;
}

export function disposableMarketRecord(row: {kind: string; acquiredAt: string}, now: number): boolean {
  // Expiration means "refresh required", not "historical facts can be destroyed".
  const age = now - Date.parse(row.acquiredAt);
  return ['latest-quote','latest-hk-financials','latest-company-financial-input','watchlist-financial-inputs'].includes(row.kind)
    && age > 30 * 864e5;
}
