import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Writable } from 'stream';
import { createHttpLogger, levelFor } from '../server/logger';

describe('levelFor', () => {
  it('keeps probe traffic at debug', () => {
    expect(levelFor(200, '/health')).toBe('debug');
    expect(levelFor(200, '/health?x=1')).toBe('debug');
  });
  it('maps statuses to levels', () => {
    expect(levelFor(200, '/api/me')).toBe('info');
    expect(levelFor(401, '/api/me')).toBe('warn');
    expect(levelFor(403, '/auth/google/callback')).toBe('warn');
    expect(levelFor(429, '/api/me')).toBe('warn');
    expect(levelFor(503, '/api/me')).toBe('error');
  });
});

describe('httpLogger', () => {
  it('emits one flat line without cookies, query strings or client IPs', async () => {
    const prevLogLevel = process.env.LOG_LEVEL;
    try {
      // Opt into info-level logging for this test so the injected sink receives output
      process.env.LOG_LEVEL = 'info';

      const lines: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      });
      const app = express();
      app.use(createHttpLogger(sink));
      app.get('/api/thing', (_req, res) => {
        res.cookie('session', 'secret-session-value');
        res.json({ ok: true });
      });
      await request(app).get('/api/thing?token=abc').set('Cookie', 'session=secret-cookie-value');
      const joined = lines.join('\n');
      expect(joined).not.toContain('secret-cookie-value');
      expect(joined).not.toContain('secret-session-value');
      expect(joined).not.toContain('token=abc');
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({ kind: 'api_request', method: 'GET', path: '/api/thing', status: 200 });
      expect(entry).not.toHaveProperty('ip');
    } finally {
      process.env.LOG_LEVEL = prevLogLevel;
    }
  });

  it('logs the full originalUrl for a route mounted under a sub-router', async () => {
    const prevLogLevel = process.env.LOG_LEVEL;
    try {
      process.env.LOG_LEVEL = 'info';

      const lines: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      });
      const app = express();
      app.use(createHttpLogger(sink));
      const sub = express.Router();
      sub.get('/thing', (_req, res) => res.json({ ok: true }));
      app.use('/api', sub);
      await request(app).get('/api/thing');
      const entry = JSON.parse(lines[0]);
      expect(entry.path).toBe('/api/thing');
    } finally {
      process.env.LOG_LEVEL = prevLogLevel;
    }
  });
});
