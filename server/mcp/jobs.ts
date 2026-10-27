// Clips made for MCP tokens (spec 2026-10-27-mcp-server-design §3, §11.4):
// at most one queued or running job per account, 10 per account an hour.
// cam-proxy stops a job nobody polls for 30 s, so cams polls it itself every
// MCP_JOB_POLL_MS (10 s) until it ends, at most 10 minutes. A result lives 15
// minutes at the proxy; its link never outlives that.
import { logger } from '../logger';
import { callApi, type InternalBase } from './internal';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface McpJob {
  job: string;
  accountId: string;
  tokenId: string;
  camera: string;
  base: InternalBase;
  state: JobState;
  progress: number;
  durationS: number | null;
  error: string | null;
  startedAt: number;
  doneAt: number | null;
  timer: NodeJS.Timeout | null;
}

const RESULT_MS = 15 * 60_000;
const MAX_RUN_MS = 10 * 60_000;
const KEEP_MS = 20 * 60_000;
const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
const STATES: JobState[] = ['queued', 'running', 'done', 'failed', 'cancelled'];
const intEnv = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : def;
};
export const pollMs = () => intEnv('MCP_JOB_POLL_MS', 10_000);
export const waitMs = () => intEnv('MCP_JOB_WAIT_MS', 25_000);

const jobs = new Map<string, McpJob>();
// Accounts whose clip is being asked for right now (between the check and the
// proxy's answer): parallel calls must not both get through.
const reserved = new Set<string>();
const terminal = (s: JobState) => s === 'done' || s === 'failed' || s === 'cancelled';

function prune(now = Date.now()): void {
  for (const [k, j] of jobs) if (terminal(j.state) && now - (j.doneAt ?? j.startedAt) > KEEP_MS) jobs.delete(k);
}

// The account's job still queued or running, if any.
export function activeJob(accountId: string): McpJob | undefined {
  prune();
  if (reserved.has(accountId)) return { accountId, state: 'queued' } as McpJob;
  return [...jobs.values()].find((j) => j.accountId === accountId && !terminal(j.state));
}

// Takes the account's one slot synchronously; false when it is taken. The
// caller releases it once the job is tracked, or the request failed.
export function reserve(accountId: string): boolean {
  if (activeJob(accountId)) return false;
  reserved.add(accountId);
  return true;
}
export function release(accountId: string): void {
  reserved.delete(accountId);
}

export function jobOf(tokenId: string, job: string): McpJob | undefined {
  const j = JOB_ID.test(job) ? jobs.get(job) : undefined;
  return j && j.tokenId === tokenId ? j : undefined;
}

// The proxy's word on the job (through /api as the token); a failed ask leaves it as it was.
export async function refresh(j: McpJob): Promise<McpJob> {
  if (terminal(j.state)) return j;
  try {
    const r = await callApi(j.base, j.tokenId, `/api/cameras/${encodeURIComponent(j.camera)}/compositions/${j.job}`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) {
      j.state = 'failed';
      j.error = 'The clip is no longer kept.';
    } else if (r.status === 401 || r.status === 403) {
      // The token was revoked, or its person left the account: the job is theirs no more.
      await r.body?.cancel();
      j.state = 'failed';
      j.error = 'The token that started the clip no longer works.';
    } else if (r.ok) {
      const b = (await r.json()) as { state?: unknown; progress?: unknown; durationS?: unknown; error?: unknown };
      if (typeof b.state === 'string' && (STATES as string[]).includes(b.state)) j.state = b.state as JobState;
      if (typeof b.progress === 'number' && b.progress >= 0 && b.progress <= 1) j.progress = b.progress;
      if (Number.isFinite(b.durationS)) j.durationS = b.durationS as number;
      if (j.state === 'failed') j.error = typeof b.error === 'string' ? b.error.slice(0, 160) : 'The clip could not be made.';
    } else await r.body?.cancel();
  } catch {
    /* asked again on the next round */
  }
  if (terminal(j.state)) {
    j.doneAt ??= Date.now();
    if (j.timer) clearInterval(j.timer);
    j.timer = null;
  } else if (Date.now() - j.startedAt > MAX_RUN_MS) {
    j.state = 'failed';
    j.error = 'The clip took too long.';
    j.doneAt = Date.now();
    if (j.timer) clearInterval(j.timer);
    j.timer = null;
  }
  return j;
}

export function track(j: Omit<McpJob, 'timer' | 'doneAt' | 'startedAt' | 'error'> & { error?: string | null }): McpJob {
  const job: McpJob = { ...j, error: j.error ?? null, startedAt: Date.now(), doneAt: terminal(j.state) ? Date.now() : null, timer: null };
  jobs.set(job.job, job);
  if (!terminal(job.state)) {
    job.timer = setInterval(() => void refresh(job).catch((e: unknown) => logger.warn({ message: (e as Error).message }, 'mcp_job_poll_failed')), pollMs());
    job.timer.unref();
  }
  return job;
}

// Asks until the job ends or `ms` pass.
export async function settle(j: McpJob, ms = waitMs()): Promise<McpJob> {
  const until = Date.now() + ms;
  while (!terminal(j.state) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, until - Date.now()))));
    await refresh(j);
  }
  return j;
}

export const resultExpiry = (j: McpJob): number | null => (j.state === 'done' && j.doneAt !== null ? j.doneAt + RESULT_MS : null);

export function resetMcpJobs(): void {
  for (const j of jobs.values()) if (j.timer) clearInterval(j.timer);
  jobs.clear();
  reserved.clear();
}
