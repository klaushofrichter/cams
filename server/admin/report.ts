// The status report (contract cams-v1, POST /cams/v1/report): what cams
// applied, what it holds, the shadow differences (names only), its tokens
// and its problems — clamped to the contract's limits. At most one per 60 s
// unless urgent; an answer saying "changed" asks for a pull.
import type { ConfigStatus } from '../configSource';
import { logger } from '../logger';
import type { HeldChange } from './apply';
import type { AdminClient, CamsReport } from './client';

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function buildReport(s: ConfigStatus, o: { held: HeldChange[]; shadow: { accountId: string; items: string[] } | null; tokens: { managed: number; pending: number; legacy: number }; version: string }): CamsReport {
  const entry = (h: HeldChange) => ({ accountId: h.accountId, camsId: h.camsId, fields: h.fields });
  return {
    v: 1,
    mode: s.mode,
    version: cut(o.version || 'dev', 64),
    appliedRevision: s.appliedRevision,
    cacheVerifiedAt: s.cacheVerifiedAt,
    lastPullAt: s.lastPullAt,
    held: o.held.filter((h) => !h.keptOld).slice(0, 200).map(entry),
    keptOld: o.held.filter((h) => h.keptOld).slice(0, 200).map(entry),
    shadow: s.mode === 'shadow' && o.shadow ? { accountId: o.shadow.accountId, differences: o.shadow.items.length, items: o.shadow.items.slice(0, 20).map((i) => cut(i, 200)) } : null,
    tokens: o.tokens,
    problems: s.problems.slice(0, 50).map((p) => ({ code: cut(p.code, 64), ...(p.accountId && { accountId: p.accountId }), detail: cut(p.detail ?? '', 200) })),
  };
}

export class Reporter {
  private lastAt = -Infinity;
  constructor(
    private readonly client: AdminClient,
    private readonly now: () => number = Date.now,
    private readonly onChanged: () => void = () => undefined,
  ) {}

  async send(r: CamsReport, urgent = false): Promise<void> {
    if (!urgent && this.now() - this.lastAt < 60_000) return;
    this.lastAt = this.now();
    try {
      const a = await this.client.report(r);
      if (a.changed) this.onChanged();
    } catch (err) {
      logger.debug({ message: (err as Error).message }, 'report_not_sent');
    }
  }
}
