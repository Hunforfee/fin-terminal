/** Shanghai calendar cutoff, clamping month-end rather than overflowing dates. */
export function calendarRangeStart(months: number, now = new Date()): string {
  const local = new Date(now.getTime() + 8 * 3600e3);
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(local.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

/** Volume inputs are cumulative; bars must show interval rather than running volume. */
export function intervalVolumes(points: readonly { volume: number }[]): (number | null)[] {
  return points.map((p, i) => {
    const previous = i ? points[i - 1].volume : 0;
    const value = p.volume - previous;
    return Number.isFinite(value) && value >= 0 ? value : null;
  });
}
