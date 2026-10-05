// The Archive's rules (cam-proxy's archive contract, docs/archive.md there):
// names, labels, retention and the list's sort order. One module for the
// cams server (validation, merging the proxies' lists) and the web app (the
// archive step, the Archive page), so the two never disagree with each other
// or with the proxy.

export const PREDEFINED_LABELS = ['Pet', 'Person', 'Vehicle', 'SD', '4K'] as const;
export const MAX_LABELS = 16;
export const LABEL_MAX_CHARS = 24;
export const NAME_MAX_CHARS = 120;
export const RETENTION_MAX_DAYS = 36500;
export const DEFAULT_RETENTION_DAYS = 365;
export const LABEL = /^[A-Za-z0-9]{1,24}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Format characters (\p{Cf}: a right-to-left override, zero-width ones, a
// BOM), which the proxy refuses too: invisible, and they can disguise a name.
const FORMAT = /\p{Cf}/u;

// A typed label's problem in the dialog's words, or null.
export function labelProblem(label: string): string | null {
  if (!label) return 'A label needs at least one letter or digit.';
  if (label.length > LABEL_MAX_CHARS) return `A label is at most ${LABEL_MAX_CHARS} characters.`;
  if (!LABEL.test(label)) return 'A label is one word: letters and digits only.';
  return null;
}

// The predefined spelling of a label (pet → Pet, 4k → 4K), else as typed.
export function labelSpelling(label: string): string {
  return PREDEFINED_LABELS.find((p) => p.toLowerCase() === label.toLowerCase()) ?? label;
}

// The proxy's label rules: case-insensitive, the first spelling wins, the
// predefined ones in their own spelling, at most 16.
export function normalizeLabels(list: unknown): { ok: true; labels: string[] } | { ok: false; error: string } {
  if (!Array.isArray(list)) return { ok: false, error: 'labels is a list' };
  const out: string[] = [];
  for (const l of list) {
    if (typeof l !== 'string') return { ok: false, error: 'a label is a string' };
    const p = labelProblem(l);
    if (p) return { ok: false, error: p };
    const s = labelSpelling(l);
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > MAX_LABELS) return { ok: false, error: `At most ${MAX_LABELS} labels.` };
  return { ok: true, labels: out };
}

export function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string') return 'The name is text.';
  const t = name.trim();
  if (!t) return 'The name can’t be empty.';
  if (t.length > NAME_MAX_CHARS) return `The name is at most ${NAME_MAX_CHARS} characters.`;
  if (CONTROL.test(t)) return 'The name can’t hold control characters.';
  if (FORMAT.test(t)) return 'The name can’t hold invisible formatting characters.';
  return null;
}

// Whole days 1 to 36500, or null (forever).
export function retentionProblem(days: unknown): string | null {
  if (days === null) return null;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > RETENTION_MAX_DAYS) return `Keep it 1 to ${RETENTION_MAX_DAYS} whole days, or forever.`;
  return null;
}

// The labels the archive step starts with (cams preselects, the proxy adds
// none): the clip's person, vehicle and pet kinds, and SD or 4K by its size.
export function preselectLabels(kinds: readonly string[], size: string): string[] {
  const out: string[] = [];
  for (const [kind, label] of [['person', 'Person'], ['vehicle', 'Vehicle'], ['pet', 'Pet']] as const) if (kinds.includes(kind)) out.push(label);
  if (size === 'sd') out.push('SD');
  if (size === '4k') out.push('4K');
  return out;
}

// --- Sorting (contract §3) -------------------------------------------------

export const SORT_KEYS = ['created', 'recorded', 'name', 'size', 'expires', 'cam', 'quality', 'duration', 'labels'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortOrder = 'asc' | 'desc';
export const QUALITIES = ['360p', 'sd', '720p', '1080p', '4k'] as const;
export type Quality = (typeof QUALITIES)[number];
// By resolution: 360p < sd (896×512) < 720p < 1080p < 4k.
const qualityRank = (q: string) => {
  const i = (QUALITIES as readonly string[]).indexOf(q);
  return i < 0 ? QUALITIES.length : i;
};

export interface Sortable {
  id: number;
  cam: string;
  name: string;
  labels: string[];
  createdAt: number;
  expiresAt: number | null;
  recordedFrom: number;
  durationS: number;
  quality: string;
  bytes: number;
  via?: string; // cams: which proxy (ids are per proxy)
}

const firstLabel = (x: Sortable) => (x.labels.length ? x.labels.map((l) => l.toLowerCase()).sort()[0] : null);
const cmp = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

// The proxy's order: the key, then recordedFrom descending, then id
// descending (and, merged across proxies, the proxy). `expires`: forever is
// the latest. `labels`: the alphabetically first label; none last either way.
export function compareItems(a: Sortable, b: Sortable, sort: SortKey = 'created', order: SortOrder = 'desc'): number {
  const dir = order === 'asc' ? 1 : -1;
  let c = 0;
  switch (sort) {
    case 'created': c = cmp(a.createdAt, b.createdAt); break;
    case 'recorded': c = cmp(a.recordedFrom, b.recordedFrom); break;
    case 'name': c = cmp(a.name.toLowerCase(), b.name.toLowerCase()); break;
    case 'size': c = cmp(a.bytes, b.bytes); break;
    case 'expires': c = cmp(a.expiresAt ?? Infinity, b.expiresAt ?? Infinity); break;
    case 'cam': c = cmp(a.cam, b.cam); break;
    case 'quality': c = cmp(qualityRank(a.quality), qualityRank(b.quality)); break;
    case 'duration': c = cmp(a.durationS, b.durationS); break;
    case 'labels': {
      const x = firstLabel(a), y = firstLabel(b);
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1; // none last, in both orders
      } else c = cmp(x, y);
      break;
    }
  }
  if (c) return c * dir;
  return cmp(b.recordedFrom, a.recordedFrom) || cmp(b.id, a.id) || cmp(a.via ?? '', b.via ?? '');
}

export function sortItems<T extends Sortable>(items: readonly T[], sort: SortKey, order: SortOrder): T[] {
  return [...items].sort((a, b) => compareItems(a, b, sort, order));
}
