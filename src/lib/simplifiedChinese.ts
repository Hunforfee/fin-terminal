import { Converter } from 'opencc-js';
const convert = Converter({ from: 'hk', to: 'cn' });
/** Preserve links, codes and numbers; convert visible Chinese text recursively. */
export function simplifiedChinese<T>(value: T): T {
  if (typeof value === 'string') return (/^https?:\/\//i.test(value) ? value : convert(value)) as T;
  if (Array.isArray(value)) return value.map(item=>simplifiedChinese(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,simplifiedChinese(item)])) as T;
  return value;
}
