// Still checks on the Timeline (cams #179, spec 2026-10-04-still-checks-ui-design):
// Vision on a second picked by hand. The button's state, the words, the marks
// and the steps between checks; the page does the requests.
import { apiFetch, getJson, HttpError, UnauthorizedError } from './api';
import { localClock } from './clock';
import { boxLabel, LABEL, type Category, type StillObject, type SummaryEntry } from './vision';

export interface LinkedEvent { id: number; kind: string; confirmed: boolean }
export interface DayCheck {
  id: number | null; // null: answered from an event's automatic analysis
  eventId: number | null;
  stillTs: number;
  summary: SummaryEntry[];
  events: LinkedEvent[];
  imageUrl: string | null;
  objects?: StillObject[];
}
export interface Usage {
  enabled: boolean;
  paused: { reason: string; until: number | null } | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  checks: { today: number; cap: number };
}
// What the page knows of the budget: the answer, an older proxy, or nothing
// (loading, or the read failed: the button stays usable, ruling 4).
export type UsageState = { kind: 'ok'; usage: Usage } | { kind: 'too_old' } | { kind: 'unknown' };

export interface CheckResult { reused: boolean; source?: 'check' | 'event'; check: DayCheck }

// Google's price beyond the free 1000 a month (cam-proxy docs/analytics.md:
// $2.25 per 1000), next to the words that use it.
export const FREE_PER_MONTH = 1000;
export const PRICE_PER_CHECK = '$0.0023';

const clock = (ts: number) => localClock(ts, false);

// Why the budget refuses a check now, or null.
export function budgetBlock(u: UsageState): string | null {
  if (u.kind === 'too_old') return 'This camera gateway is too old for checks';
  if (u.kind !== 'ok') return null;
  const x = u.usage;
  if (!x.enabled) return 'Vision is off for this camera';
  if (x.paused) return x.paused.reason === 'quota' ? `Vision is paused (quota)${x.paused.until ? ` until ${clock(x.paused.until)}` : ''}` : 'Vision is paused (invalid key)';
  if (x.checks.cap === 0) return 'Checks are off for this camera';
  if (x.month.limit > 0 && x.month.calls >= x.month.limit) return `Monthly limit reached (${x.month.limit})`;
  if (x.today.cap > 0 && x.today.calls >= x.today.cap) return `Today's Vision cap is reached (${x.today.cap})`;
  if (x.checks.today >= x.checks.cap) return `Today's checks are used (${x.checks.cap})`;
  return null;
}

// "14 of 1000 Vision calls this month · 2 of 10 manual checks done today" (every Vision call, automatic and checks, counts against the month), the price once past the free tier.
export function usageLine(u: UsageState): string {
  if (u.kind !== 'ok') return '';
  const x = u.usage;
  const price = x.month.calls >= FREE_PER_MONTH ? ` (about ${PRICE_PER_CHECK} a check beyond ${FREE_PER_MONTH} a month)` : '';
  return `${x.month.calls} of ${x.month.limit} Vision calls this month · ${x.checks.today} of ${x.checks.cap} manual checks done today${price}`;
}

export interface ButtonState { label: string; disabled: boolean; reason: string | null }
// The button under the large still. A checked second shows its result and
// reads "✧ Checked 14:03:22" (ruling 1); a second the automatic analysis saw
// is that analysis'.
export function checkButton(o: { ts: number; gap: boolean; checked: boolean; analysed: boolean; running: boolean; usage: UsageState }): ButtonState {
  if (o.checked) return { label: `✧ Checked ${localClock(o.ts)}`, disabled: true, reason: null };
  if (o.analysed) return { label: '✦ Analysed with its event', disabled: true, reason: null };
  if (o.running) return { label: 'Checking…', disabled: true, reason: 'Checking…' };
  const block = budgetBlock(o.usage) ?? (o.gap ? 'No still for this second' : null);
  return { label: '✧ Check with Vision', disabled: block !== null, reason: block };
}

// "Person 84%, Dog 61%": each subtype once, best first; or "nothing relevant".
export function findings(summary: SummaryEntry[]): string {
  const best = new Map<string, number>();
  for (const e of summary) if (e.score > (best.get(e.subtype) ?? -1)) best.set(e.subtype, e.score);
  return best.size ? [...best].sort((a, b) => b[1] - a[1]).map(([n, s]) => boxLabel(n, s)).join(', ') : 'nothing relevant';
}

const kindLabel = (k: string) => LABEL[k as Category] ?? k.charAt(0).toUpperCase() + k.slice(1);

// The result's event line: what it confirms, else the event it sits in.
export function confirmsLine(events: LinkedEvent[]): string {
  const yes = [...new Set(events.filter((e) => e.confirmed).map((e) => kindLabel(e.kind)))];
  return yes.length ? `Confirms the ${yes.join(' and ')} event${yes.length > 1 ? 's' : ''}` : '';
}
// The list's event column (ruling 5: the kind, not the time).
export function eventPlace(events: LinkedEvent[]): string {
  if (!events.length) return 'outside any event';
  const ai = events.filter((e) => e.kind !== 'motion');
  const kinds = [...new Set((ai.length ? ai : events).map((e) => kindLabel(e.kind)))];
  return `in a ${kinds.join(' and ')} event`;
}

export function reusedLine(r: { reused: boolean; source?: string } | null): string {
  if (!r?.reused) return '';
  return r.source === 'event' ? 'Analysed before with its event, no new call' : 'Checked before, no new call';
}

// A refused or failed check in words.
export function errorText(status: number, body: { error?: string; reason?: string; until?: number | null; detail?: string } | null): string {
  const e = body?.error;
  const r = body?.reason;
  switch (e) {
    case 'analytics_off':
      return r === 'no_key' ? 'Vision has no key on this camera gateway' : r === 'checks_off' ? 'Checks are off for this camera' : 'Vision is off for this camera';
    case 'analytics_paused':
      return r === 'quota' ? `Vision is paused (Google's quota)${body?.until ? ` until ${clock(body.until)}` : ''}` : 'Vision is paused: the key was refused. It resumes after a settings change or a new key.';
    case 'limit':
      return r === 'month' ? 'The monthly Vision limit is reached' : r === 'day' ? "Today's Vision cap is reached" : "Today's checks are used";
    case 'busy':
      return 'Another check is running. Try again in a moment.';
    case 'rate_limited':
      return 'Too many checks at once. Wait a minute.';
    case 'no_still':
      return 'No still for this second';
    case 'too_old':
      return 'This camera gateway is too old for checks';
    case 'provider_failed':
      return r === 'timeout' ? 'Vision did not answer in time. Nothing was stored; try again.'
        : r === 'network' ? 'Vision could not be reached. Nothing was stored; try again.'
        : r === 'aborted' ? 'The check was cancelled (the camera gateway is stopping). Try again.'
        : r === 'bad_key' ? 'Vision refused the key; Vision is paused.'
        : r === 'quota' ? "Google's quota is used; Vision is paused for an hour."
        : `Vision failed${r ? ` (${r})` : ''}. Nothing was stored; try again.`;
    case 'invalid':
      return body?.detail?.includes('older than') ? 'Too old to check: stills are kept 7 days' : `Not a second to check${body?.detail ? ` (${body.detail})` : ''}`;
    case 'proxy_unavailable':
      return 'The camera gateway is not reachable right now.';
  }
  return status === 429 ? 'Too many checks at once. Wait a minute.' : `The check failed (HTTP ${status}).`;
}

// Per tile of the minute, the check in that second, or null.
export function checkSeconds(m: { minute: number; intervalS: number; present: boolean[] }, checks: DayCheck[]): (DayCheck | null)[] {
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    return checks.find((c) => c.stillTs >= from && c.stillTs < from + m.intervalS * 1000) ?? null;
  });
}

export const checkedMinutes = (checks: DayCheck[]): Set<number> => new Set(checks.map((c) => Math.floor(c.stillTs / 60_000) * 60_000));

// The previous or next check from a second (Shift+←/→, ◀ ✧ ▶), or null at the ends.
export function stepCheck(checks: DayCheck[], ts: number, dir: -1 | 1): DayCheck | null {
  const sorted = [...checks].sort((a, b) => a.stillTs - b.stillTs);
  if (dir > 0) return sorted.find((c) => c.stillTs > ts) ?? null;
  return sorted.filter((c) => c.stillTs < ts).at(-1) ?? null;
}

// The day's checks merged with one just made (by id; oldest first).
export function withCheck(checks: DayCheck[], c: DayCheck): DayCheck[] {
  if (c.id === null) return checks;
  return [...checks.filter((x) => x.id !== c.id), c].sort((a, b) => a.stillTs - b.stillTs);
}

// --- Requests -----------------------------------------------------------------

const isUsage = (u: unknown): u is Usage => {
  const x = u as Partial<Usage> | null;
  const n = (v: unknown) => typeof v === 'number';
  return !!x && typeof x.enabled === 'boolean' && n(x.month?.calls) && n(x.month?.limit) && n(x.today?.calls) && n(x.today?.cap) && n(x.checks?.today) && n(x.checks?.cap);
};

export async function loadUsage(base: string): Promise<UsageState> {
  try {
    const u = await getJson<unknown>(`${base}/analytics`);
    return isUsage(u) ? { kind: 'ok', usage: u } : { kind: 'unknown' };
  } catch (err) {
    return err instanceof HttpError && err.status === 404 && err.code === 'too_old' ? { kind: 'too_old' } : { kind: 'unknown' };
  }
}

export async function loadChecks(base: string, from: number, to: number): Promise<DayCheck[]> {
  const list = await getJson<unknown>(`${base}/still-checks?from=${from}&to=${to}`);
  return Array.isArray(list) ? (list as DayCheck[]).filter((c) => typeof c?.stillTs === 'number' && Array.isArray(c.summary) && Array.isArray(c.events)) : [];
}

export async function loadCheckObjects(base: string, c: DayCheck): Promise<StillObject[]> {
  if (c.objects) return c.objects;
  if (c.id !== null) return (await getJson<{ objects: StillObject[] }>(`${base}/still-checks/${c.id}`)).objects;
  return (await getJson<{ objects: StillObject[] }>(`${base}/analyses/${c.eventId}`)).objects;
}

export class CheckError extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

// Check a second: the result, or a CheckError with the words to show.
export async function requestCheck(base: string, at: number): Promise<CheckResult> {
  let res: Response;
  try {
    res = await apiFetch(`${base}/still-checks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ at }) });
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new CheckError('The camera gateway is not reachable right now.');
  }
  const body = (await res.json().catch(() => null)) as (CheckResult & { error?: string; reason?: string; until?: number | null; detail?: string }) | null;
  if (!res.ok || !body?.check) throw new CheckError(errorText(res.status, body));
  return { reused: body.reused === true, source: body.source, check: body.check };
}
