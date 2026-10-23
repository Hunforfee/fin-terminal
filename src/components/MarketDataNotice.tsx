import type { MarketReadStatus } from '@/lib/marketReadStatus';
export interface MarketReadResult {
  dataStatus?: MarketReadStatus;
  errors?: {code:string;error:string}[];
}
/** Acquisition dates stay visible when a source failed; never relabel old data as newly fetched. */
export default function MarketDataNotice({value}:{value?:MarketReadResult|null}) {
  const snapshots=value?.dataStatus?.snapshots??[], unsaved=value?.dataStatus?.persistenceFailed??[], errors=value?.errors??[];
  if(!snapshots.length && !unsaved.length && !errors.length)return null;
  const date=(s:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(s));
  return <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
    {!!snapshots.length && <><p>部分数据未能安全更新，当前包含已保存的数据，日期不代表本次查询时间。</p>
      <details><summary className="cursor-pointer">查看保存时间与来源（北京时间）</summary><ul>{snapshots.map(s=><li key={s.key}>{s.key.match(/(?:sh|sz|bj|hk)?\d{5,6}/)?.[0]??'数据'} · {s.source.split(':')[0]} · 保存于 {date(s.acquiredAt)}{s.reason.includes('冲突')?' · 新旧数值冲突，已保留原值':''}</li>)}</ul></details></>}
    {!!unsaved.length && <p>已取得有效数据，但有 {unsaved.length} 项未确认入库成功。</p>}
    {!!errors.length && <p>{errors.length} 家公司暂未取得可用财报，其余公司正常显示：{errors.map(e=>e.code).join('、')}。</p>}
  </div>;
}
