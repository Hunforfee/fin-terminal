/** Exact report-period matching; a missing original must never become a guessed URL. */
export type OriginalReportKind = 'q1' | 'semi' | 'q3' | 'annual';
export interface FinancialReportLink {
  period: string;
  kind: OriginalReportKind;
  title: string;
  publishedAt: string;
  url: string;
  revised: boolean;
  source: '巨潮资讯';
}
export interface RawReportAnnouncement {
  secCode?: string;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
}

export function shanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function reportWindowStart(today: string): string {
  const year = Number(today.slice(0, 4)) - 2;
  const month = Number(today.slice(5, 7));
  const day = Math.min(Number(today.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const simplified = (s: string) => s.replace(/報/g, '报').replace(/業/g, '业').replace(/績/g, '绩').replace(/審/g, '审').replace(/訂/g, '订').replace(/後/g, '后').replace(/個/g, '个');

/** HK fiscal periods are only inferred for a confirmed December year-end. */
export function parseOriginalReportTitle(raw: string, hk = false, calendarYear = false): { period: string; kind: OriginalReportKind; revised: boolean } | null {
  const title = simplified(raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ''))
    .replace(/二[〇零][〇零一二三四五六七八九]{2}/g, year => [...year].map(char => String('〇一二三四五六七八九'.indexOf(char === '零' ? '〇' : char))).join(''));
  if (/摘要|英文|英语|English|业绩|预告|快报|董事|决议|取消|撤销|提示|关于|审核|审阅|审计|意见|说明|公告|子公司|附属|转发|\/|／/i.test(title)) return null;
  const revised = /修订|更正|更新/.test(title);
  const clean = title.replace(/[（(](?:\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?)?(?:修订|更正|更新)(?:后|版|稿|本|全文)*[）)]$/, '');
  const domestic = clean.match(/(20\d{2})年?(年度|半年度|中期|第?一季度|第?三季度)报告(?:全文)?$/);
  if (domestic && !hk) {
    const [, year, rawLabel] = domestic;
    // Group issuers also disclose subsidiaries' reports under the parent's code.
    // e.g. 中国平安：平安银行股份有限公司2025年第三季度报告.
    const prefix = clean.slice(0, domestic.index);
    if (/[:：].+/.test(prefix)) return null;
    const label = rawLabel === '中期' ? '半年度' : rawLabel === '一季度' ? '第一季度' : rawLabel === '三季度' ? '第三季度' : rawLabel;
    const [end, kind] = ({ 年度: ['12-31', 'annual'], 半年度: ['06-30', 'semi'], 第一季度: ['03-31', 'q1'], 第三季度: ['09-30', 'q3'] } as const)[label as '年度' | '半年度' | '第一季度' | '第三季度'];
    return { period: `${year}-${end}`, kind, revised };
  }
  if (!hk) return null;
  // An explicitly dated fiscal report is safe even for non-calendar companies.
  const dated = clean.match(/截至(20\d{2})年(\d{1,2})月(\d{1,2})日止.*?(中期报告|年度报告|年报)$/);
  if (dated) {
    const period = `${dated[1]}-${dated[2].padStart(2, '0')}-${dated[3].padStart(2, '0')}`;
    return validDate(period) ? { period, kind: dated[4] === '中期报告' ? 'semi' : 'annual', revised } : null;
  }
  if (!calendarYear) return null;
  const match = clean.match(/(20\d{2})年?(年度报告|年报|中报|中期报告|半年度报告|第?一季度报告|第?三季度报告)$/)
    ?? clean.match(/(年度报告|年报|中报|中期报告|半年度报告|第?一季度报告|第?三季度报告)(20\d{2})年?$/)?.map((v, i, a) => i === 1 ? a[2] : i === 2 ? a[1] : v);
  if (!match) return null;
  const kind: OriginalReportKind = /中期|中报|半年度/.test(match[2]) ? 'semi' : /一季度/.test(match[2]) ? 'q1' : /三季度/.test(match[2]) ? 'q3' : 'annual';
  return { period: `${match[1]}-${{ annual: '12-31', semi: '06-30', q1: '03-31', q3: '09-30' }[kind]}`, kind, revised };
}

export function selectFinancialReportLinks(rows: RawReportAnnouncement[], code: string, today: string, calendarYear = false): FinancialReportLink[] {
  const hk = code.length === 5;
  const start = reportWindowStart(today);
  const chosen = new Map<string, FinancialReportLink & { time: number }>();
  for (const row of rows) {
    if (row.secCode !== code || typeof row.announcementTitle !== 'string' || typeof row.announcementTime !== 'number' || !Number.isFinite(row.announcementTime) || Math.abs(row.announcementTime) > 8.64e15) continue;
    const report = parseOriginalReportTitle(row.announcementTitle, hk, calendarYear);
    const publishedAt = shanghaiDate(new Date(row.announcementTime));
    if (!report || report.period < start || report.period > today || publishedAt > today || publishedAt < report.period) continue;
    // Only original attachments on the disclosure platform; never accept arbitrary hosts.
    if (typeof row.adjunctUrl !== 'string' || !/^finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(row.adjunctUrl)) continue;
    const key = `${report.period}:${report.kind}`;
    const prev = chosen.get(key);
    if (prev && (prev.time > row.announcementTime || (prev.time === row.announcementTime && (prev.revised || !report.revised)))) continue;
    chosen.set(key, { ...report, title: row.announcementTitle.replace(/<[^>]*>/g, '').trim(), publishedAt, url: `https://static.cninfo.com.cn/${row.adjunctUrl}`, source: '巨潮资讯', time: row.announcementTime });
  }
  return [...chosen.values()].sort((a, b) => b.period.localeCompare(a.period)).map(({ time: _time, ...item }) => item);
}
