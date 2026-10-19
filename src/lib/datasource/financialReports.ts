import { cached } from './cache';
import { normalizeStockCode } from './codes';
import { reportWindowStart, selectFinancialReportLinks, shanghaiDate, type RawReportAnnouncement } from '../financialReportLinks';

const BASE = 'https://www.cninfo.com.cn';
async function post<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', Referer: `${BASE}/` },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(12000), cache: 'no-store',
  });
  if (!res.ok) throw Error('原文目录暂不可用');
  return res.json();
}

export function getFinancialReports(input: string, calendarYear = false) {
  const stock = normalizeStockCode(input);
  if (!stock) throw Error('股票代码无效');
  const today = shanghaiDate();
  return cached(`financial-report-links:v1:${stock.symbol}:${today}:${calendarYear}`, 3600e3, async () => {
    const hk = stock.market === 'HK';
    const matches = await post<{ code: string; orgId: string; category: string }[]>('/new/information/topSearch/query', { keyWord: stock.code, maxNum: '10' });
    if (!Array.isArray(matches)) throw Error('原文目录暂不可用');
    const org = matches.find(item => item.code === stock.code && item.category === (hk ? '港股' : 'A股'));
    if (!org?.orgId) return [];
    const query = async (searchkey: string) => {
      const rows: RawReportAnnouncement[] = [];
      for (let page = 1; page <= 5; page++) {
        const data = await post<{ announcements: RawReportAnnouncement[] | null; hasMore: boolean; totalAnnouncement: number }>('/new/hisAnnouncement/query', {
          pageNum: String(page), pageSize: '100', column: hk ? 'hke' : 'szse', tabName: 'fulltext',
          stock: `${stock.code},${org.orgId}`, seDate: `${reportWindowStart(today)}~${today}`,
          category: hk ? '' : 'category_ndbg_szsh;category_bndbg_szsh;category_yjdbg_szsh;category_sjdbg_szsh',
          searchkey, isHLtitle: 'false', sortName: 'time', sortType: 'desc',
        });
        if (!data || typeof data.totalAnnouncement !== 'number' || (data.announcements !== null && !Array.isArray(data.announcements))) throw Error('原文目录暂不可用');
        rows.push(...(data.announcements ?? []));
        if (!data.hasMore) return rows;
      }
      throw Error('原文目录未完整返回，请稍后重试');
    };
    const batches = await Promise.all((hk ? ['年报', '中期报告', '中报', '季度报告'] : ['']).map(query));
    return selectFinancialReportLinks(batches.flat(), stock.code, today, calendarYear);
  });
}
