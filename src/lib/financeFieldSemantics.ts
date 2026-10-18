/** Statement totals and per-share/ratio rows do not share the same source units. */
export type StatementFieldUnit =
  | 'wan'
  | 'yuan'
  | 'pct'
  | 'ratio'
  | '港仙/股'
  | '美分/股'
  | '分/股'
  | '股'
  | '万股';

export function statementFieldUnit(label: string): StatementFieldUnit {
  if (/[%％]|百分比/.test(label)) return 'pct';
  if (/每股|[/／]\s*股/.test(label)) {
    // Preserve explicitly disclosed cents rather than labelling them as yuan.
    if (/港仙/.test(label)) return '港仙/股';
    if (/美分/.test(label)) return '美分/股';
    if (/(?:人民币)?分(?:[/／]股|[)）])/.test(label)) return '分/股';
    return 'yuan';
  }
  if (/万股/.test(label)) return '万股';
  if (/股数|股份数|[（(]\s*股\s*[)）]/.test(label)) return '股';
  if (/[（(]\s*倍\s*[)）]/.test(label)) return 'ratio';
  return 'wan';
}

/** HK statement totals arrive in currency units; per-share and ratio rows do not. */
export function hkStatementValue(
  value: number | null,
  label: string,
): number | null {
  if (value === null) return null;
  return statementFieldUnit(label) === 'wan' ? value / 1e4 : value;
}

export function financialUnitText(
  unit: string,
  label: string,
  raw = false,
): string {
  if (unit === 'wan') return raw ? '万元' : '亿';
  if (unit === 'pct') return '%';
  if (unit === 'ratio') return '倍';
  if (unit === 'yuan') return /每股|[/／]\s*股/.test(label) ? '元/股' : '元';
  return unit;
}

export function formatFinancialValue(
  value: number | null,
  unit: string,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (unit === 'pct') return `${value.toFixed(2)}%`;
  if (unit === 'yuan') return value.toFixed(2);
  return (unit === 'wan' ? value / 1e4 : value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Only additive statement flows can be derived by subtracting YTD amounts. */
export function showSingleQuarterChange(
  key: string,
  unit: string,
  granularity: 'annual' | 'semi' | 'quarter',
): boolean {
  // Per-share flows can use different share counts across periods; do not subtract.
  return granularity === 'quarter' && /^(pl|cf)_/.test(key) && unit === 'wan';
}
