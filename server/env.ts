// A whole-number setting from the environment, within [min, max]; unset,
// empty or anything else gives the default.
export function intEnv(name: string, def: number, { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
}
