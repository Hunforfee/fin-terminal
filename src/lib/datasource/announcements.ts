/**
 * 公司公告（东财 np-anotice）。仅覆盖 A 股；港股等上游返回空列表时安静降级。
 *
 * - 列表：/api/security/ann?stock_list=<code>
 * - 正文：/api/content/ann?art_code=<artCode>
 * - 重要公告：标题命中关键词（重大事项/回购/减持/立案…），供首页红字提醒
 */

import { cached } from './cache';
import { fetchJson } from './http';
import { cachedMarketInput } from '../marketInputs';

export interface CompanyAnnouncement {
  artCode: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  columns: string[];
  important: boolean;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 命中即视为重大事项，首页红字提醒 */
const IMPORTANT_RE =
  /(重大|重组|并购|收购|中标|签署.*合同|回购|增持|减持|解禁|质押|停牌|复牌|退市|立案|处罚|问询|监管函|警示|业绩.*(预增|预亏|预告|快报)|利润分配|分红|派息|激励|员工持股|关联交易|担保|诉讼|仲裁|破产|清算|变更.*控制人|实控人)/;

interface RawAnn {
  art_code?: string;
  title?: string;
  title_ch?: string;
  notice_date?: string;
  columns?: { column_name?: string }[];
}

export async function fetchAnnouncements(
  code: string,
  pageSize = 15,
): Promise<CompanyAnnouncement[]> {
  return cachedMarketInput(`company-announcements:v1:${code}:${pageSize}`,'company-announcements','eastmoney:announcements',1800e3,
    ()=>fetchAnnouncementList(code,pageSize),value=>{if(!Array.isArray(value))throw Error('公告目录无效');});
}
async function fetchAnnouncementList(code:string,pageSize:number):Promise<CompanyAnnouncement[]>{
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${pageSize}&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}`;
  const raw = await fetchJson<any>(url, {timeoutMs:8000});
  if(!Array.isArray(raw?.data?.list))throw Error('公告目录未有效返回');
  const list: RawAnn[] = Array.isArray(raw?.data?.list) ? raw.data.list : [];
  return list
    .filter((a) => a.art_code && (a.title_ch || a.title))
    .map((a) => {
      const title = (a.title_ch || a.title || '').trim();
      return {
        artCode: a.art_code!,
        title,
        date: (a.notice_date || '').slice(0, 10),
        columns: (a.columns ?? [])
          .map((c) => c.column_name || '')
          .filter(Boolean),
        important: IMPORTANT_RE.test(title),
      };
    });
}

/** 公告正文（用于时间线摘要），纯文本截断 */
export async function fetchAnnouncementContent(
  artCode: string,
  limit = 600,
): Promise<string> {
  const url = `https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${encodeURIComponent(artCode)}&client_source=web&page_index=1`;
  return cachedMarketInput(`announcement-content:v1:${artCode}:${limit}`,'announcement-content','eastmoney:announcements',7*864e5,async()=>{
  const raw = await fetchJson<any>(url, {timeoutMs:8000});
  const text: string =
    typeof raw?.data?.notice_content === 'string'
      ? raw.data.notice_content
      : '';
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
  },value=>{if(!value)throw Error('公告正文暂缺');});
}

/** 单家公司最近公告（缓存 30 分钟） */
export function getCompanyAnnouncements(code: string, pageSize = 15) {
  return cached(`announcements:${code}:${pageSize}`, 1800e3, () =>
    fetchAnnouncements(code, pageSize).catch(() => [] as CompanyAnnouncement[]),
  );
}
