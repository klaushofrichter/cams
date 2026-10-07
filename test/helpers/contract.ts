import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';

// The vendored cams-v1 schemas (contract/cams-v1), strict (closed objects,
// for tests) and lenient (what a receiver accepts), each compiled once.
const ROOT = join(__dirname, '../../contract/cams-v1');
const cache: Partial<Record<'strict' | 'lenient', Ajv2020>> = {};
function load(mode: 'strict' | 'lenient'): Ajv2020 {
  const have = cache[mode];
  if (have) return have;
  const dir = mode === 'strict' ? join(ROOT, 'strict') : ROOT;
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  for (const f of readdirSync(dir)) if (f.endsWith('.schema.json')) ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')), f.replace(/\.schema\.json$/, ''));
  cache[mode] = ajv;
  return ajv;
}

export function camsValidator(name: string, mode: 'strict' | 'lenient' = 'strict'): (m: unknown) => boolean {
  const a = load(mode);
  return (m) => a.validate(name, m) as boolean;
}
export function camsErrors(mode: 'strict' | 'lenient' = 'strict'): string {
  return JSON.stringify(load(mode).errors ?? null);
}
export const CONTRACT_DIR = ROOT;
export interface Fixture { name: string; schema: string; message: Record<string, unknown> }
export function camsFixtures(): Fixture[] {
  const dir = join(ROOT, 'fixtures');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
