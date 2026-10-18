const attempts = new Map<string, { count: number; resetAt: number }>();
/** Instance-local guard; the SMS provider must also enforce distributed limits. */
export function allowAttempt(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (attempts.size > 10000)
    for (const [entry, value] of attempts)
      if (value.resetAt <= now) attempts.delete(entry);
  const previous = attempts.get(key);
  if (!previous || previous.resetAt <= now) {
    if (attempts.size >= 12000) return false;
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (previous.count >= limit) return false;
  previous.count++;
  return true;
}
