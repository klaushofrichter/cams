// The jobs cams started on a proxy, by scope (a camera or a proxy key) and
// cams's own copy of the proxy's job id: only those are polled, fetched or
// cancelled, never by the id from the request (CodeQL js/request-forgery).
// An entry is kept `keepMs` from the last question about it; expired ones
// are swept when a new job is remembered.
export class JobRegistry<Extra extends object = object> {
  private readonly jobs = new Map<string, { id: string; at: number } & Extra>();
  constructor(private readonly keepMs: number) {}

  private static key = (scope: string, id: string) => `${scope}\u0000${id}`;

  remember(scope: string, id: string, extra: Extra): void {
    const now = Date.now();
    for (const [k, v] of this.jobs) if (now - v.at > this.keepMs) this.jobs.delete(k);
    this.jobs.set(JobRegistry.key(scope, id), { ...extra, id, at: now });
  }

  // The job, refreshed (asking keeps it, like a poll); undefined when unknown.
  lookup(scope: string, id: string): ({ id: string } & Extra) | undefined {
    const e = this.jobs.get(JobRegistry.key(scope, id));
    if (e) e.at = Date.now();
    return e;
  }

  delete(scope: string, id: string): void {
    this.jobs.delete(JobRegistry.key(scope, id));
  }
}
