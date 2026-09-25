import express, { Express, NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { STATUS_CODES } from 'http';
import { httpLogger, logger } from './logger';
import { TRUST_PROXY } from './trustProxy';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { apiRouter } from './routes/api';
import { pagesRouter, webDir } from './routes/pages';

interface HttpError extends Error {
  status?: unknown;
  statusCode?: unknown;
}

function statusOf(err: HttpError): number {
  const candidate = err.status ?? err.statusCode;
  const status = typeof candidate === 'number' ? candidate : Number(candidate);
  if (!Number.isInteger(status) || status < 400 || status > 599) return 500;
  return status;
}

// Final handler: Express's own default would print err.stack (with absolute
// paths) to stderr, breaking the "logs are JSON on stdout only" rule. This
// logs a minimal, safe summary instead and never the stack, headers, cookies
// or body.
function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = statusOf(err);
  const path = (req.originalUrl || req.url).split('?')[0];
  const logFields = { name: err.name, message: err.message, status, path };
  if (status >= 500) {
    logger.error(logFields, 'unhandled_error');
  } else {
    logger.warn(logFields, 'unhandled_error');
  }
  const statusText = STATUS_CODES[status] ?? STATUS_CODES[500]!;
  if (path.startsWith('/api')) {
    res.status(status).json({ error: statusText.toLowerCase() });
  } else {
    res.status(status).type('text/plain').send(statusText);
  }
}

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  // First, so rejected requests (401/403/429) are logged too.
  app.use(httpLogger);
  app.use(express.json());
  app.use(cookieParser());
  app.use(healthRouter);
  app.use(authRouter);
  app.use(apiRouter);
  app.use(pagesRouter(webDir()));
  app.use(errorHandler);
  return app;
}
