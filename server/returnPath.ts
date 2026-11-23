// Only same-site /app paths: "/app", "/app/...", "/app?...". Anything that a
// browser could read as another origin ("//x", "/\x", absolute URLs) or that
// merely starts with the letters ("/apps") is refused. Pure, no imports:
// the web app uses it too (web/src/lib/api.ts), so it never sends one the
// server drops.
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\/app(?:[/?#]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\')) return null;
  // Browsers drop tabs and newlines from URLs, which could rebuild a "//".
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) return null;
  // No "." or ".." segments, raw or percent-encoded: /app/../x would leave /app.
  const path = value.split(/[?#]/)[0];
  if (path.split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg))) return null;
  return value;
}
