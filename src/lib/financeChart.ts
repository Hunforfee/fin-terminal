interface ReportAxis {
  periods?: readonly string[];
  periodLabels: readonly string[];
}

/** Align comparisons by report date, never by their position in separate API responses. */
export function alignFinancialComparison(
  primary: ReportAxis,
  comparison: ReportAxis & { values: readonly (number | null)[] },
): (number | null)[] {
  const hasDates = Boolean(
    primary.periods?.length || comparison.periods?.length,
  );
  const primaryKeys = hasDates ? primary.periods : primary.periodLabels;
  const comparisonKeys = hasDates
    ? comparison.periods
    : comparison.periodLabels;
  if (
    !primaryKeys ||
    !comparisonKeys ||
    primaryKeys.length !== primary.periodLabels.length ||
    comparisonKeys.length !== comparison.periodLabels.length
  ) {
    return primary.periodLabels.map(() => null);
  }

  const byPeriod = new Map<string, number | null>();
  comparisonKeys.forEach((period, index) => {
    if (!period) return;
    const value = comparison.values[index];
    byPeriod.set(
      period,
      typeof value === 'number' && Number.isFinite(value) ? value : null,
    );
  });
  return primaryKeys.map((period) => byPeriod.get(period) ?? null);
}
