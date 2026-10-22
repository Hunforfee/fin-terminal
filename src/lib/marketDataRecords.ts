import { allowedPublicMarketKey } from './marketDataResources';
import type { MarketStore } from './marketStore';

export class MarketRecordQueryError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function readPublicMarketRecords(store: Pick<MarketStore, 'read' | 'scanPrefix' | 'readVersions'>, params: URLSearchParams) {
  const key = params.get('key'), keys = params.get('keys'), prefix = params.get('prefix');
  if ([key, keys, prefix].filter(value => value !== null).length !== 1)
    throw new MarketRecordQueryError('请指定 key、keys 或 prefix 中的一项', 400);
  const limit = Number(params.get('limit') ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MarketRecordQueryError('limit 须为 1—200 的整数', 400);
  if (key !== null) {
    if (!allowedPublicMarketKey(key)) throw new MarketRecordQueryError('此记录不属于可共享股票数据', 403);
    if (params.get('versions') === '1') {
      if (!store.readVersions) throw new MarketRecordQueryError('数据源不支持历史版本查询', 501);
      return { key, records: await store.readVersions(key, Math.min(limit, 4)), versions: true };
    }
    const record = await store.read(key);
    if (!record) throw new MarketRecordQueryError('所需股票数据尚未入库', 404);
    return { record };
  }
  if (keys !== null) {
    const list = keys.split(',').map(value => value.trim());
    if (!list.length || list.length > 20) throw new MarketRecordQueryError('每次可读取 1—20 个记录键', 400);
    if (list.some(value => !allowedPublicMarketKey(value))) throw new MarketRecordQueryError('含不可共享的记录键', 403);
    const records = [];
    for (const value of list) { const record = await store.read(value); records.push({ key: value, found: !!record, ...(record ? { record } : {}) }); }
    return { records };
  }
  if (!prefix || !allowedPublicMarketKey(prefix, true)) throw new MarketRecordQueryError('不可共享的数据类型', 403);
  const after = params.get('after') ?? '', payload = params.get('payload') !== '0';
  if (after && (!allowedPublicMarketKey(after) || !after.startsWith(prefix))) throw new MarketRecordQueryError('分页游标无效', 400);
  if (payload && limit > 20) throw new MarketRecordQueryError('带完整内容的查询每页最多 20 条；元信息查询可设 payload=0', 400);
  if (!store.scanPrefix) throw new MarketRecordQueryError('数据源不支持分页查询', 501);
  const page = await store.scanPrefix(prefix, limit + 1, after), more = page.length > limit;
  const records = [];
  for (const row of page.slice(0, limit)) records.push(payload ? await store.read(row.key) ?? row : row);
  return { prefix, records, count: records.length, nextCursor: more ? page[limit - 1].key : null };
}
