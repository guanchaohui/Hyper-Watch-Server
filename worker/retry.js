export function retryAfterMs(value, fallback, now = Date.now()) {
  if (!value) return fallback;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : fallback;
}
