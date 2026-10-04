import { describe, expect, it } from 'vitest';
import { budgetBlock, checkButton, checkedMinutes, checkSeconds, confirmsLine, errorText, eventPlace, findings, reusedLine, stepCheck, usageLine, withCheck, type DayCheck, type Usage, type UsageState } from './stillChecks';

const box = { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.9 };
const usage = (o: Partial<Usage> = {}): UsageState => ({
  kind: 'ok',
  usage: { enabled: true, paused: null, month: { calls: 14, limit: 1000 }, today: { calls: 2, cap: 30 }, checks: { today: 2, cap: 10 }, ...o },
});
const check = (stillTs: number, id: number | null = stillTs): DayCheck => ({ id, eventId: null, stillTs, summary: [], events: [], imageUrl: null });

describe('the check button', () => {
  const base = { ts: Date.parse('2026-10-04T14:03:22'), gap: false, checked: false, analysed: false, running: false, usage: usage() };

  it('is ready with a budget left', () => {
    expect(checkButton(base)).toEqual({ label: '✧ Check with Vision', disabled: false, reason: null });
  });

  it('says why not, from the analytics answer', () => {
    const reason = (u: UsageState) => checkButton({ ...base, usage: u }).reason;
    expect(reason(usage({ enabled: false }))).toBe('Vision is off for this camera');
    expect(reason(usage({ paused: { reason: 'bad_key', until: null } }))).toBe('Vision is paused (invalid key)');
    expect(reason(usage({ paused: { reason: 'quota', until: Date.parse('2026-10-04T15:00:00') } }))).toMatch(/^Vision is paused \(quota\) until 0?3:00|^Vision is paused \(quota\) until 15:00/);
    expect(reason(usage({ checks: { today: 0, cap: 0 } }))).toBe('Checks are off for this camera');
    expect(reason(usage({ month: { calls: 1000, limit: 1000 } }))).toBe('Monthly limit reached (1000)');
    expect(reason(usage({ today: { calls: 30, cap: 30 } }))).toBe("Today's Vision cap is reached (30)");
    expect(reason(usage({ today: { calls: 300, cap: 0 } }))).toBeNull(); // cap 0: no daily cap
    expect(reason(usage({ checks: { today: 10, cap: 10 } }))).toBe("Today's checks are used (10)");
    expect(reason({ kind: 'too_old' })).toBe('This camera gateway is too old for checks');
    expect(reason({ kind: 'unknown' })).toBeNull(); // ruling 4
    expect(checkButton({ ...base, gap: true })).toMatchObject({ disabled: true, reason: 'No still for this second' });
    expect(checkButton({ ...base, running: true })).toMatchObject({ label: 'Checking…', disabled: true });
  });

  it('reads “Checked” on a checked second, whatever the budget', () => {
    const b = checkButton({ ...base, checked: true, usage: usage({ enabled: false }) });
    expect(b.disabled).toBe(true);
    expect(b.label).toMatch(/^✧ Checked \d/);
    expect(checkButton({ ...base, analysed: true }).label).toBe('✦ Analysed with its event');
  });

  it('budgetBlock is null without an answer', () => {
    expect(budgetBlock({ kind: 'unknown' })).toBeNull();
  });
});

describe('words', () => {
  it('shows the usage, and the price past the free tier', () => {
    expect(usageLine(usage())).toBe('14 of 1000 Vision calls this month · 2 of 10 checks today');
    expect(usageLine(usage({ month: { calls: 1200, limit: 2000 } }))).toBe('1200 of 2000 Vision calls this month · 2 of 10 checks today (about $0.0023 a check beyond 1000 a month)');
    expect(usageLine({ kind: 'unknown' })).toBe('');
  });

  it('lists findings best first, each subtype once', () => {
    const e = (subtype: string, score: number) => ({ category: 'pet' as const, subtype, score, box });
    expect(findings([e('dog', 0.61), { ...e('person', 0.84), category: 'person' }, e('dog', 0.5)])).toBe('Person 84%, Dog 61%');
    expect(findings([])).toBe('nothing relevant');
  });

  it('names confirmed events, and where a check sits', () => {
    expect(confirmsLine([{ id: 1, kind: 'person', confirmed: true }, { id: 2, kind: 'motion', confirmed: false }])).toBe('Confirms the Person event');
    expect(confirmsLine([{ id: 2, kind: 'motion', confirmed: false }])).toBe('');
    expect(eventPlace([])).toBe('outside any event');
    expect(eventPlace([{ id: 2, kind: 'motion', confirmed: false }])).toBe('in a Motion event');
    expect(eventPlace([{ id: 1, kind: 'person', confirmed: false }, { id: 2, kind: 'motion', confirmed: false }])).toBe('in a Person event');
  });

  it('says a reused answer cost nothing', () => {
    expect(reusedLine({ reused: true, source: 'check' })).toBe('Checked before, no new call');
    expect(reusedLine({ reused: true, source: 'event' })).toBe('Analysed before with its event, no new call');
    expect(reusedLine({ reused: false })).toBe('');
  });

  it('turns every refusal into words', () => {
    expect(errorText(429, { error: 'limit', reason: 'checks' })).toBe("Today's checks are used");
    expect(errorText(429, { error: 'limit', reason: 'month' })).toBe('The monthly Vision limit is reached');
    expect(errorText(429, { error: 'busy' })).toMatch(/Another check is running/);
    expect(errorText(502, { error: 'provider_failed', reason: 'timeout' })).toMatch(/did not answer in time/);
    expect(errorText(502, { error: 'provider_failed', reason: 'aborted' })).toMatch(/cancelled/);
    expect(errorText(502, { error: 'provider_failed', reason: 'http_500' })).toBe('Vision failed (http_500). Nothing was stored; try again.');
    expect(errorText(503, { error: 'analytics_paused', reason: 'bad_key', until: null })).toMatch(/key was refused/);
    expect(errorText(409, { error: 'analytics_off', reason: 'checks_off' })).toBe('Checks are off for this camera');
    expect(errorText(400, { error: 'invalid', detail: 'at is older than the stills kept (7 days)' })).toBe('Too old to check: stills are kept 7 days');
    expect(errorText(404, { error: 'too_old' })).toMatch(/too old for checks/);
    expect(errorText(502, { error: 'proxy_unavailable' })).toMatch(/not reachable/);
    expect(errorText(500, null)).toBe('The check failed (HTTP 500).');
  });
});

describe('marks and steps', () => {
  const minute = Date.parse('2026-10-04T14:03:00');
  const m = { minute, intervalS: 1, present: Array(60).fill(true) as boolean[] };

  it('marks the checked seconds and minutes', () => {
    const marks = checkSeconds(m, [check(minute + 22_000)]);
    expect(marks.findIndex((x) => x !== null)).toBe(22);
    expect([...checkedMinutes([check(minute + 22_000), check(minute + 59_000), check(minute + 61_000)])]).toEqual([minute, minute + 60_000]);
  });

  it('steps to the previous and next check, null at the ends', () => {
    const list = [check(3000), check(1000), check(2000)];
    expect(stepCheck(list, 2000, 1)?.stillTs).toBe(3000);
    expect(stepCheck(list, 2000, -1)?.stillTs).toBe(1000);
    expect(stepCheck(list, 1500, -1)?.stillTs).toBe(1000);
    expect(stepCheck(list, 3000, 1)).toBeNull();
    expect(stepCheck(list, 1000, -1)).toBeNull();
  });

  it('merges a new check into the day by id; a reused event answer is no check', () => {
    expect(withCheck([check(2000, 1)], check(1000, 2)).map((c) => c.id)).toEqual([2, 1]);
    expect(withCheck([check(2000, 1)], { ...check(2000, 1), summary: [] })).toHaveLength(1);
    expect(withCheck([], check(5000, null))).toEqual([]);
  });
});
