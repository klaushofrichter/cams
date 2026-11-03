// web/src/lib/outages.ts
import { localClock } from './clock';

// Why a thumbnail is blank (Klaus, 2026-11-03): cam-proxy's outages (GET
// /api/cameras/:id/outages, from its audit and stream logs: what its stills
// inventory explains gaps with). A blank stretch gets the reasons that
// overlap it; none known (an older proxy, a failed request, nothing recorded):
// the plain sentence.

export interface Outage { cause: string; from: number; to: number | null }

export const NO_STILL = 'No still picture available';

const WORDS: Record<string, string> = {
  offline: 'Camera was offline',
  reboot: 'Camera restarted',
  powercycle: 'Camera power cycled (PoE)',
  address: 'Camera address changed',
  stop: 'Proxy was stopped',
  crash: 'Proxy restarted after a crash',
  paused: 'Proxy storage was full',
};
const MAX_REASONS = 3;

const hm = (t: number) => localClock(t, false);
function when(o: Outage): string {
  if (o.to === null) return `since ${hm(o.from)}`;
  const a = hm(o.from), b = hm(o.to);
  return a === b ? a : `${a}–${b}`;
}

// The text for a blank stretch [a, b): the reasons overlapping it, oldest
// first, at most three ("Camera was offline (09:39–09:41); Camera address
// changed (09:41)"), else NO_STILL.
export function outageText(list: readonly Outage[], a: number, b: number): string {
  const parts: string[] = [];
  for (const o of list) {
    const words = WORDS[o.cause];
    if (!words || o.from >= b || (o.to !== null && o.to < a)) continue;
    const p = `${words} (${when(o)})`;
    if (!parts.includes(p)) parts.push(p);
  }
  if (!parts.length) return NO_STILL;
  return parts.slice(0, MAX_REASONS).join('; ');
}

// The runs of blank slots in a row of slots `step` apart: each blank slot's
// text, by its time. A run is explained as a whole (the camera is seen offline
// a check or two after the stills stop). `before`/`after` extend the first and
// last run past the row (the neighbouring minutes), when given.
export function blankTexts(
  slots: readonly { t: number; blank: boolean }[],
  step: number,
  list: readonly Outage[],
  edges: { before?: (t: number) => number; after?: (t: number) => number } = {},
): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < slots.length; ) {
    if (!slots[i].blank) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < slots.length && slots[j + 1].blank) j++;
    let a = slots[i].t;
    let b = slots[j].t + step;
    if (i === 0 && edges.before) a = edges.before(a);
    if (j === slots.length - 1 && edges.after) b = edges.after(b);
    const text = outageText(list, a, b);
    for (let k = i; k <= j; k++) out.set(slots[k].t, text);
    i = j + 1;
  }
  return out;
}

// Walks from `t` by `step` (back for a negative one) while `blank` holds, at
// most `max` steps: where the blank stretch ends.
export function walkBlank(t: number, step: number, blank: (t: number) => boolean, max = 7200): number {
  let x = t;
  for (let n = 0; n < max && blank(x + (step < 0 ? step : 0)); n++) x += step;
  return x;
}

// Outages per camera and 6-hour block, each asked for once (the block holding
// now again after a minute); a failed request counts as none and is asked
// again after a minute. `get` answers what is known at once; `onchange` runs
// when a block arrives.
const BLOCK = 6 * 3_600_000;
const FRESH_MS = 60_000;
export function createOutages(cam: string, fetch: <T>(url: string) => Promise<T>, onchange: () => void) {
  const blocks = new Map<number, { at: number; ok: boolean; list: Outage[] }>();
  const inflight = new Set<number>();
  const enc = encodeURIComponent(cam);
  let alive = true;
  function ensure(from: number, to: number) {
    const now = Date.now();
    for (let k = Math.floor(from / BLOCK) * BLOCK; k <= to; k += BLOCK) {
      const have = blocks.get(k);
      // A past block loaded once is final; the current one and a failed one are asked again after a minute.
      if (inflight.has(k) || (have && ((have.ok && k + BLOCK < have.at) || now - have.at < FRESH_MS))) continue;
      inflight.add(k);
      fetch<{ outages?: Outage[] }>(`/api/cameras/${enc}/outages?from=${k}&to=${k + BLOCK - 1}`)
        .then((r) => ({ ok: true, list: Array.isArray(r?.outages) ? r.outages : [] }))
        .catch(() => ({ ok: false, list: blocks.get(k)?.list ?? [] }))
        .then(({ ok, list }) => {
          if (!alive) return;
          blocks.set(k, { at: Date.now(), ok, list });
          onchange();
        })
        .finally(() => inflight.delete(k));
    }
  }
  // Every known outage overlapping [from, to], once each (one may be in several blocks).
  function get(from: number, to: number): Outage[] {
    const seen = new Set<string>();
    const out: Outage[] = [];
    for (const { list } of blocks.values())
      for (const o of list) {
        const key = `${o.cause}|${o.from}|${o.to}`;
        if (seen.has(key) || o.from > to || (o.to !== null && o.to < from)) continue;
        seen.add(key);
        out.push(o);
      }
    return out.sort((x, y) => x.from - y.from);
  }
  return { ensure, get, destroy: () => void (alive = false) };
}
