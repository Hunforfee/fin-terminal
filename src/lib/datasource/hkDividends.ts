import { fetchJson, UpstreamError } from './http';

export type HkDividendAsOf = string | Date;
export type HkDividendKind =
  'interim' | 'final' | 'q1' | 'q2' | 'q3' | 'q4' | 'special' | 'unknown';

export interface HkDividendRecord {
  exDate: string;
  /** 数据源公告/更新日期；未知时为空，不以除息日伪造公告批次。 */
  noticeDate: string;
  /** 港元/股，税前；无法取得已披露港元折算额时为空。 */
  dps: number | null;
  period: string;
  special: boolean;
  fiscalYear?: string;
  kind?: HkDividendKind;
  eventId?: string;
}

export interface HkFiscalYearDividend {
  basis: 'completed-fiscal-year';
  complete: boolean;
  /** 兼容旧字段名，实际为完整财年合计，不是滚动 TTM 或未来预期。 */
  ttmDps: number | null;
  fiscalYear: string | null;
  /** 参与计算的现金分红事件数，普通息和特别息分别计数。 */
  batches: number;
  ordinaryDps: number | null;
  specialDps: number | null;
  /** 无法可靠归属财年的特别现金息保留在元数据中，不猜测归属。 */
  unassignedSpecialDps: number | null;
  unassignedSpecialBatches: number;
}

export interface HkRollingDividend {
  basis: 'rolling-ttm';
  ttmDps: number | null;
  ordinaryDps: number | null;
  specialDps: number | null;
  batches: number;
  /** 左开右闭，按除息日取 (from, to]。 */
  from: string;
  to: string;
}

type Row = Record<string, unknown>;
type Response = {
  success: boolean;
  result?: { pages: number; data: Row[] } | null;
};
const HK_HEADERS = { Referer: 'https://emweb.securities.eastmoney.com/' };

function dateOnly(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : '';
}

function asOfDate(asOf?: HkDividendAsOf): string {
  if (typeof asOf === 'string') {
    const date = dateOnly(asOf);
    if (!date) throw new Error('港股分红统计日期无效');
    return date;
  }
  const instant = asOf ?? new Date();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime()))
    throw new Error('港股分红统计日期无效');
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function periodInfo(period: string): {
  fiscalYear?: string;
  kind: HkDividendKind;
} {
  const text = period.normalize('NFKC').replace(/\s+/g, '');
  const fiscalYear = text.match(/(?:^|\D)((?:19|20)\d{2})(?=\D|$)/)?.[1];
  if (/特别|特殊|special/i.test(text)) return { fiscalYear, kind: 'special' };
  const quarter =
    text.match(/第?([一二三四1-4])季(?:度)?/i)?.[1] ??
    text.match(/Q([1-4])/i)?.[1];
  if (quarter) {
    const number =
      ({ 一: '1', 二: '2', 三: '3', 四: '4' } as Record<string, string>)[
        quarter
      ] ?? quarter;
    return { fiscalYear, kind: `q${number}` as HkDividendKind };
  }
  if (/中期|中报|半年|H1/i.test(text)) return { fiscalYear, kind: 'interim' };
  if (/末期|年终|全年|年度|年报|H2/i.test(text))
    return { fiscalYear, kind: 'final' };
  return { fiscalYear, kind: 'unknown' };
}

function isInKind(text: string): boolean {
  return /实物|實物|每\s*\d+(?:\.\d+)?\s*股\s*分派\s*\d*(?:\.\d+)?\s*股|分派.*(?:普通股|预托股份|預託股份|预留股份)|in[ -]?specie/i.test(
    text,
  );
}

/** 仅解析现金港元/股；优先已披露折算额，不猜汇率，不计实物等值。 */
export function parseHkDps(explain: string): number | null {
  const text = String(explain ?? '')
    .normalize('NFKC')
    .replace(/,/g, '');
  if (isInKind(text)) return null;
  const perShares = Number(text.match(/每\s*(\d+(?:\.\d+)?)\s*股/)?.[1] ?? 1);
  if (!Number.isFinite(perShares) || perShares <= 0) return null;
  const amount = '(\\d+(?:\\.\\d+)?)';
  const currency = '(?:港币|港幣|港元|HKD|HK\\$)';
  const converted = text.match(
    new RegExp(`相当于(每股(?:派)?)?\\s*${currency}\\s*${amount}`, 'i'),
  );
  const currencyFirst = text.match(new RegExp(`${currency}\\s*${amount}`, 'i'));
  const currencyLast = text.match(
    new RegExp(
      `每(?:股|\\s*\\d+(?:\\.\\d+)?\\s*股)派?\\s*${amount}\\s*${currency}`,
      'i',
    ),
  );
  const value = converted
    ? Number(converted[2])
    : Number(currencyFirst?.[1] ?? currencyLast?.[1]);
  const divisor = converted?.[1] ? 1 : perShares;
  return Number.isFinite(value) && value >= 0 ? value / divisor : null;
}

function kindSlot(kind: HkDividendKind): string {
  return kind === 'interim' || kind === 'q2'
    ? 'h1'
    : kind === 'final' || kind === 'q4'
      ? 'closing'
      : kind;
}

function recordKey(record: HkDividendRecord): string {
  if (record.eventId) return record.eventId;
  const info = periodInfo(record.period);
  const kind = record.special ? 'special' : (record.kind ?? info.kind);
  const fiscalYear = record.fiscalYear ?? info.fiscalYear;
  return JSON.stringify([
    fiscalYear ?? record.period,
    kindSlot(kind),
    record.exDate,
    ...(kind === 'special' || kind === 'unknown'
      ? [record.noticeDate, record.dps]
      : []),
  ]);
}

/** 重复披露按事件身份合并；普通息和同日同额特别息是不同事件。 */
function uniqueRecords(
  records: HkDividendRecord[],
  asOf: string,
): HkDividendRecord[] {
  const unique = new Map<string, HkDividendRecord>();
  for (const record of records) {
    const exDate = dateOnly(record.exDate);
    const noticeDate = dateOnly(record.noticeDate);
    if (!exDate || exDate > asOf || (noticeDate && noticeDate > asOf)) continue;
    const info = periodInfo(record.period);
    const next = {
      ...record,
      exDate,
      noticeDate,
      fiscalYear: record.fiscalYear ?? info.fiscalYear,
      kind: record.special ? ('special' as const) : (record.kind ?? info.kind),
    };
    const key = recordKey(next);
    const previous = unique.get(key);
    if (!previous || next.noticeDate > previous.noticeDate)
      unique.set(key, next);
  }
  const result = [...unique.values()];
  for (const record of result) {
    if (!record.special || record.fiscalYear || !record.noticeDate) continue;
    const matchingYears = new Set(
      result
        .filter(
          (other) =>
            !other.special &&
            other.fiscalYear &&
            other.exDate === record.exDate &&
            other.noticeDate === record.noticeDate,
        )
        .map((other) => other.fiscalYear!),
    );
    if (matchingYears.size === 1) record.fiscalYear = [...matchingYears][0];
  }
  return result.sort(
    (a, b) =>
      b.exDate.localeCompare(a.exDate) ||
      b.noticeDate.localeCompare(a.noticeDate),
  );
}

export function parseHkDividends(
  rows: Row[],
  asOf?: HkDividendAsOf,
): HkDividendRecord[] {
  const cutoff = asOfDate(asOf);
  const candidates = new Map<
    string,
    { record: HkDividendRecord; implemented: boolean }
  >();
  for (const row of rows) {
    const exDate = dateOnly(row.EX_DIVIDEND_DATE);
    const noticeDate = dateOnly(row.NOTICE_DATE);
    if (!exDate || exDate > cutoff || (noticeDate && noticeDate > cutoff))
      continue;
    const explain = String(row.PLAN_EXPLAIN ?? '').normalize('NFKC');
    if (isInKind(explain)) continue;
    const period = String(row.ASSIGN_PERIOD ?? '');
    const info = periodInfo(period);
    const special = info.kind === 'special';
    const sourceId =
      row.DIVIDEND_ID ?? row.ASSIGN_ID ?? row.EVENT_ID ?? row.PLAN_ID ?? row.ID;
    const record: HkDividendRecord = {
      exDate,
      noticeDate,
      dps: parseHkDps(explain),
      period,
      special,
      ...info,
    };
    const security = String(row.SECURITY_CODE ?? row.SECUCODE ?? '');
    record.eventId = JSON.stringify([
      security,
      ...(sourceId != null
        ? ['id', String(sourceId), kindSlot(info.kind)]
        : ['event', recordKey(record)]),
    ]);
    const progress = String(row.ASSIGN_PROGRESS ?? '');
    const implemented =
      !/取消|终止|不实施|未实施|尚未|待实施|预披露|预案|不分配/.test(
        progress,
      ) &&
      /实施分配|已实施|已除息|已派付|已派发|完成分配|完成派息/.test(progress);
    const previous = candidates.get(record.eventId);
    if (!previous || noticeDate > previous.record.noticeDate)
      candidates.set(record.eventId, { record, implemented });
  }
  return uniqueRecords(
    [...candidates.values()]
      .filter((candidate) => candidate.implemented)
      .map((candidate) => candidate.record),
    cutoff,
  );
}

function sumDps(records: HkDividendRecord[]): number | null {
  if (
    records.some(
      (record) =>
        record.dps === null || !Number.isFinite(record.dps) || record.dps < 0,
    )
  )
    return null;
  return Number(
    records.reduce((sum, record) => sum + record.dps!, 0).toFixed(10),
  );
}

function isCompleteYear(ordinary: HkDividendRecord[]): boolean {
  const kinds = new Set(ordinary.map((record) => record.kind));
  const closing = kinds.has('final') || kinds.has('q4');
  if (!closing || sumDps(ordinary) === null || kinds.has('unknown'))
    return false;
  // 季派公司必须具备四季；中期作为第二季，末期可作为第四季。
  if (kinds.has('q1') || kinds.has('q3') || kinds.has('q4')) {
    return (
      kinds.has('q1') &&
      (kinds.has('q2') || kinds.has('interim')) &&
      kinds.has('q3')
    );
  }
  return true; // 每年仅末期一次，或中期/第二季 + 末期。
}

/** 最近已实施的完整财年静态现金派息，不拼接两财年，也不外推未来。 */
export function sumFiscalYearDividend(
  records: HkDividendRecord[],
  asOf?: HkDividendAsOf,
): HkFiscalYearDividend {
  const eligible = uniqueRecords(records, asOfDate(asOf));
  const unassigned = eligible.filter(
    (record) => record.special && !record.fiscalYear,
  );
  const empty: HkFiscalYearDividend = {
    basis: 'completed-fiscal-year',
    complete: false,
    ttmDps: null,
    fiscalYear: null,
    batches: 0,
    ordinaryDps: null,
    specialDps: null,
    unassignedSpecialDps: unassigned.length ? sumDps(unassigned) : null,
    unassignedSpecialBatches: unassigned.length,
  };
  const byYear = new Map<string, HkDividendRecord[]>();
  for (const record of eligible) {
    if (!record.fiscalYear) continue;
    const group = byYear.get(record.fiscalYear) ?? [];
    group.push(record);
    byYear.set(record.fiscalYear, group);
  }
  const fiscalYear = [...byYear.keys()]
    .sort()
    .reverse()
    .find((year) =>
      byYear
        .get(year)!
        .some(
          (record) =>
            !record.special &&
            (record.kind === 'final' || record.kind === 'q4'),
        ),
    );
  if (!fiscalYear) return empty;
  const group = byYear.get(fiscalYear)!;
  const ordinary = group.filter((record) => !record.special);
  // 最新已闭合年度的数据不全时明确留空，不以旧年度的完整值代替。
  if (!isCompleteYear(ordinary) || sumDps(group) === null)
    return { ...empty, fiscalYear, batches: group.length };
  const special = group.filter((record) => record.special);
  return {
    ...empty,
    complete: true,
    fiscalYear,
    ttmDps: sumDps(group),
    ordinaryDps: sumDps(ordinary),
    specialDps: sumDps(special),
    batches: group.length,
  };
}

/** @deprecated 旧名称实际采用完整财年静态口径；请改用 sumFiscalYearDividend。 */
export const sumTtmDividend = sumFiscalYearDividend;

/** 另行提供真正滚动十二个月口径，以免与完整财年静态值混用。 */
export function sumRollingTtmDividend(
  records: HkDividendRecord[],
  asOf?: HkDividendAsOf,
): HkRollingDividend {
  const to = asOfDate(asOf);
  const [year, month, day] = to.split('-').map(Number);
  const previousYear = year - 1;
  const lastDay = new Date(Date.UTC(previousYear, month, 0)).getUTCDate();
  const from = `${previousYear}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  const eligible = uniqueRecords(records, to).filter(
    (record) => record.exDate > from,
  );
  return {
    basis: 'rolling-ttm',
    from,
    to,
    ttmDps: eligible.length ? sumDps(eligible) : null,
    ordinaryDps: eligible.length
      ? sumDps(eligible.filter((record) => !record.special))
      : null,
    specialDps: eligible.length
      ? sumDps(eligible.filter((record) => record.special))
      : null,
    batches: eligible.length,
  };
}

/** 最近两页覆盖高频季息和已完成财年；同一事件的分页重复只计一次。 */
export async function fetchHkDividends(
  code: string,
  asOf?: HkDividendAsOf,
): Promise<HkDividendRecord[]> {
  if (!/^\d{5}$/.test(code)) throw new Error('港股代码无效');
  const rows: Row[] = [];
  for (let page = 1; page <= 2; page++) {
    const url = new URL(
      'https://datacenter.eastmoney.com/securities/api/data/v1/get',
    );
    url.search = new URLSearchParams({
      reportName: 'RPT_HKF10_INFO_DIVIDEND',
      columns: 'ALL',
      filter: `(SECURITY_CODE="${code}")`,
      pageSize: '50',
      pageNumber: String(page),
      sortColumns: 'NOTICE_DATE',
      sortTypes: '-1',
    }).toString();
    const response = await fetchJson<Response>(url.toString(), {
      timeoutMs: 15000,
      headers: HK_HEADERS,
    });
    if (
      !response.success ||
      (response.result && !Array.isArray(response.result.data))
    )
      throw new UpstreamError('港股分红明细不可用', url.toString(), 'parse');
    const list = response.result?.data ?? [];
    if (list.length === 0) break;
    rows.push(...list);
    if (!response.result || response.result.pages <= page) break;
  }
  return parseHkDividends(rows, asOf);
}
