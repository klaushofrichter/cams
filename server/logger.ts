import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';
import pinoHttp from 'pino-http';

// JSON to stdout only; the kubelet owns rotation. LOG_LEVEL lets tests silence
// output. IMPORTANT: the cluster's collector drops debug lines, so debug stays
// in the cluster while info and above ship to Grafana Cloud. Anything
// detailed (payloads, headers) may only ever be logged at debug.
function makeLogger(destination?: pino.DestinationStream): pino.Logger {
  const actualDestination = destination || pino.destination(1);
  // If LOG_LEVEL is 'silent' (a test-only marker), use 'info' for custom
  // destinations (like in tests) so test streams still see output.
  let logLevel: string | number = process.env.LOG_LEVEL || 'info';
  if (logLevel === 'silent') {
    logLevel = destination ? 'info' : 'trace';
  }
  return pino(
    { level: logLevel, base: undefined, timestamp: pino.stdTimeFunctions.epochTime },
    actualDestination
  );
}

export const logger = makeLogger();

// Exact list, not a prefix, so a later route under /health does not inherit
// silence it was never meant to have.
const PROBE_PATHS = new Set(['/health']);

export function levelFor(status: number, url: string): 'debug' | 'info' | 'warn' | 'error' {
  if (PROBE_PATHS.has(url.split('?')[0])) return 'debug';
  if (status >= 500) return 'error';
  if (status === 401 || status === 403 || status === 429) return 'warn';
  return 'info';
}

function flatten(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
  val: Record<string, unknown>
): Record<string, unknown> {
  // No client address: PII going to a third party, and on a single-user
  // service it is always the same person.
  return {
    ...val,
    kind: 'api_request',
    reqId: req.id as string,
    method: req.method,
    path: (req.url || '').split('?')[0],
    status: res.statusCode,
  };
}

export function createHttpLogger(destination?: pino.DestinationStream) {
  return pinoHttp({
    logger: destination ? makeLogger(destination) : logger,
    genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string) || randomUUID(),
    // Backstop: the serializers below already drop req/res entirely.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      remove: true,
    },
    customLogLevel: (req: IncomingMessage, res: ServerResponse, err?: Error) =>
      err ? 'error' : levelFor(res.statusCode, req.url || ''),
    customSuccessMessage: () => 'api_request',
    customErrorMessage: () => 'api_request',
    customAttributeKeys: { responseTime: 'durationMs' },
    // customProps is deliberately not used: pino-http evaluates it twice and
    // emits duplicate keys with a stale status (see steps-service).
    customSuccessObject: (req, res, val) => flatten(req, res, val),
    customErrorObject: (req, res, _err, val) => flatten(req, res, val),
    serializers: { req: () => undefined, res: () => undefined },
  });
}

export const httpLogger = createHttpLogger();
