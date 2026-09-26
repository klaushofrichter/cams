// Baked in by the Docker build (ARG APP_VERSION); "dev" when running locally.
// Read per call rather than at module load, so tests can observe changes.
export function appVersion(): string {
  return process.env.APP_VERSION || 'dev';
}

// Stamped by the Docker build (ARG BUILD_DATE, set by the workflows).
export function buildDate(): string | null {
  const raw = process.env.BUILD_DATE;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
