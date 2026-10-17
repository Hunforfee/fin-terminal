/** 涨跌色：A 股红涨绿跌 */
export function toneClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'c-flat';
  if (v > 0) return 'c-up';
  if (v < 0) return 'c-down';
  return 'c-flat';
}

/** 带符号的数字 */
export function signed(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

/** 百分比 */
export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return `${v.toFixed(digits)}%`;
}

/** 带符号百分比 */
export function signedPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** 金额（亿元 → 可读） */
export function yi(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)} 万亿`;
  return `${v.toFixed(2)} 亿`;
}

/** 价格 */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  return v.toFixed(2);
}

/** 成交量（手 → 万手/亿手） */
export function volume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿手`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万手`;
  return `${v.toFixed(0)} 手`;
}

/** 时间格式化 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 估值分位文案 */
export function percentileLabel(p: number | null | undefined): { text: string; cls: string } {
  if (p === null || p === undefined || !Number.isFinite(p)) return { text: '--', cls: 'c-flat' };
  if (p < 20) return { text: `${p.toFixed(1)}%（低估）`, cls: 'c-down' };
  if (p < 50) return { text: `${p.toFixed(1)}%（偏低）`, cls: 'c-down' };
  if (p < 80) return { text: `${p.toFixed(1)}%（偏高）`, cls: 'c-up' };
  return { text: `${p.toFixed(1)}%（高估）`, cls: 'c-up' };
}
