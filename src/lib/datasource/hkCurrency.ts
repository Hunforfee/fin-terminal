type Row = Record<string, unknown>;

const finite = (value: unknown): number | null => {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const positive = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
};

export interface HkPerShareValues {
  financialCurrency: 'CNY';
  quoteCurrency: string;
  referencePrice: number | null;
  referencePeTTM: number | null;
  referencePb: number | null;
  hkdPerCny: number | null;
  bpsCny: number | null;
  epsTTMCny: number | null;
  bpsHkd: number | null;
}

/**
 * Calibrate one current F10 snapshot, never a historical price series.
 * CURRENCY is the trading counter, while monetary main indicators are CNY.
 * (market cap / issued ordinary shares) / PB_TTM recovers the HKD book value.
 * BOCHK 2026H1: HK$360,366m / 10,572,780,266 shares matches this exactly.
 * PE_TTM retains the provider's own TTM basis; EPS_TTM can use a different
 * earnings/share-count basis and must not be treated as an independent FX quote.
 */
export function hkPerShareValues(row: Row): HkPerShareValues {
  const quoteCurrency =
    typeof row.CURRENCY === 'string' ? row.CURRENCY.toUpperCase() : '';
  const bpsCny = finite(row.BPS),
    epsTTMCny = finite(row.EPS_TTM);
  const shares = positive(row.ISSUED_COMMON_SHARES),
    cap = positive(row.TOTAL_MARKET_CAP);
  const referencePrice =
    quoteCurrency === 'HKD' &&
    Number(row.IS_CNY_CODE ?? 0) === 0 &&
    shares !== null &&
    cap !== null
      ? positive(cap / shares)
      : null;
  const referencePb = positive(row.PB_TTM),
    referencePeTTM = positive(row.PE_TTM);
  // An invalid latest book value must not be rescued by another period's PB.
  const bpsHkd =
    referencePrice !== null &&
    referencePb !== null &&
    bpsCny !== null &&
    bpsCny > 0
      ? referencePrice / referencePb
      : null;
  const implied = bpsHkd !== null && bpsCny !== null ? bpsHkd / bpsCny : null;
  const hkdPerCny =
    implied !== null && Number.isFinite(implied) && implied > 0
      ? implied
      : null;
  return {
    financialCurrency: 'CNY',
    quoteCurrency,
    referencePrice,
    referencePeTTM,
    referencePb,
    hkdPerCny,
    bpsCny,
    epsTTMCny,
    bpsHkd: bpsHkd !== null && Number.isFinite(bpsHkd) ? bpsHkd : null,
  };
}
