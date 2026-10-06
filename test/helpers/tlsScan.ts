// The source scan behind test/noUnverifiedTls.test.ts: TLS without chain
// validation exists in server/tls/leafPin.ts only. Lines are filtered and
// tested, never rewritten.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const LEAF_PIN = 'server/tls/leafPin.ts';

// Who may use which of leafPin.ts's exports (and import the module at all).
const ALLOWED: Record<string, string[]> = {
  'server/tls/siteCa.ts': ['CA_FETCH_CONNECT'],
  'server/reolink/http.ts': ['LEGACY_UNVERIFIED_CAMERA', 'pinnedConnection'],
  'server/reolink/client.ts': ['connectPinned', 'connectVerified'],
};
const EXPORTS = ['CA_FETCH_CONNECT', 'LEGACY_UNVERIFIED_CAMERA', 'pinnedConnection', 'connectPinned', 'connectVerified'];

function lineProblem(rel: string, line: string): string | null {
  // Every mention reads exactly `rejectUnauthorized: true`, then (after spaces) , } or the line's end.
  for (let at = line.indexOf('rejectUn'); at !== -1; at = line.indexOf('rejectUn', at + 1)) {
    if (!/^rejectUnauthorized: true\s*(,|}|$)/.test(line.slice(at))) return 'rejectUnauthorized other than `: true`';
  }
  if (/['"`][A-Za-z]*Unauthorized['"`]/.test(line)) return 'a quoted (part of) rejectUnauthorized';
  if (/\[[^\]]*['"`]\s*\+[^\]]*\]\s*:/.test(line)) return 'a computed key built from strings';
  if (line.includes('checkServerIdentity')) return 'checkServerIdentity';
  if (line.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return 'NODE_TLS_REJECT_UNAUTHORIZED';
  if (/\btls\.connect\b|\btlsConnect\b|(\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"`](node:)?tls['"`]/.test(line)) return 'tls.connect / the tls module';
  if (/leafPin['"`]/.test(line) && !ALLOWED[rel]) return 'imports leafPin';
  for (const name of EXPORTS) if (new RegExp(`\\b${name}\\b`).test(line) && !ALLOWED[rel]?.includes(name)) return `uses ${name}`;
  return null;
}

// `rel`: the path from the repo root.
export function tlsViolations(rel: string, text: string): string[] {
  if (rel === LEAF_PIN) return [];
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return; // comment lines
    const why = lineProblem(rel, line);
    if (why) out.push(`${rel}:${i + 1}: ${why}`);
  });
  return out;
}

const ROOT = join(__dirname, '..', '..');
export function sourceFiles(dir = ['server', 'scripts']): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name: string) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
      return /\.(ts|js|mjs|cjs)$/.test(name) ? [relative(ROOT, p)] : [];
    });
  return dir.flatMap((d) => walk(join(ROOT, d)));
}

export const readSource = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
