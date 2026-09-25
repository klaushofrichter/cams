import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(healthRouter);
  return app;
}
