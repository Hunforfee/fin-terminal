import { normalizeStockCode } from './datasource/codes';
export function financeStorageKey(base:string,code:string):string {
  return normalizeStockCode(code)?.market==='HK' ? `${base}.hk` : base;
}

/** 港股东财科目 key（如 pl_i004001002）；A 股科目 key 为中文名（如 pl_营业成本） */
const HK_STATEMENT_KEY = /^(bs|pl|cf)_i\d{4,}$/;
const CN_STATEMENT_KEY = /^(bs|pl|cf)_(?!i\d)/;

/** 清洗字段：报表科目 key 必须与当前市场匹配，指标/公式（fx_）不受影响 */
export function sanitizeFields(fields: string[], isHk: boolean): string[] {
  return fields.filter((k) => {
    if (/^(bs|pl|cf)_/.test(k)) return isHk ? HK_STATEMENT_KEY.test(k) : CN_STATEMENT_KEY.test(k);
    return true;
  });
}

interface ModuleLike {
  id: string;
  fields: string[];
  [k: string]: unknown;
}

/**
 * 一次性迁移：PR#6 之前模块配置存在全局键（A股/港股共用），
 * 港股页配置（含 hk 科目 key）会残留污染 A 股配置、且港股新键读不到旧数据。
 * 返回旧全局键里「含港股科目的模块」（字段已清洗为仅港股科目），供港股页搬迁；无则 null。
 */
export function takeLegacyHkModules(base: string): ModuleLike[] | null {
  try {
    const raw = localStorage.getItem(base);
    if (!raw) return null;
    const arr = JSON.parse(raw) as ModuleLike[];
    if (!Array.isArray(arr)) return null;
    const hk = arr
      .filter((m) => Array.isArray(m?.fields) && m.fields.some((k) => HK_STATEMENT_KEY.test(k)))
      .map((m) => ({ ...m, fields: m.fields.filter((k) => HK_STATEMENT_KEY.test(k) || !/^(bs|pl|cf)_/.test(k)) }));
    return hk.length > 0 ? hk : null;
  } catch {
    return null;
  }
}

/** 旧全局「合并报表自定义字段」里的港股字段（供港股页搬迁），无则 null */
export function takeLegacyHkMergeFields(base: string): string[] | null {
  try {
    const raw = localStorage.getItem(base);
    if (!raw) return null;
    const arr = JSON.parse(raw) as string[];
    if (!Array.isArray(arr)) return null;
    const hk = arr.filter((k) => HK_STATEMENT_KEY.test(k) || !/^(bs|pl|cf)_/.test(k));
    return hk.some((k) => HK_STATEMENT_KEY.test(k)) ? hk : null;
  } catch {
    return null;
  }
}
