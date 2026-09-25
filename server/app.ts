import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { httpLogger } from './logger';
import { TRUST_PROXY } from './trustProxy';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  // First, so rejected requests (401/403/429) are logged too.
  app.use(httpLogger);
  app.use(express.json());
  app.use(cookieParser());
  app.use(healthRouter);
  app.use(authRouter);
  return app;
}
