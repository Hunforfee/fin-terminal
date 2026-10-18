/** Always evaluate A-share trading hours in Shanghai, independent of the host timezone. */
export function isShanghaiTradingTime(date = new Date()): boolean {
  const local = new Date(date.getTime() + 8 * 3600_000);
  const day = local.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return (minute >= 555 && minute <= 690) || (minute >= 780 && minute <= 905);
}

/** HK cash equities include the closing auction until 16:10, in UTC+8. */
export function isHongKongTradingTime(date = new Date()): boolean {
  const local = new Date(date.getTime() + 8 * 3600_000);
  const day = local.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return (minute >= 570 && minute <= 720) || (minute >= 780 && minute <= 970);
}
