import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createApp } from '../server/app';

// /llms.txt (llmstxt.org): where an LLM finds the camera system's APIs and
// their documentation. Served from web/public like the favicon, public in
// every sign-in mode, never the SPA.
const PUBLIC_DIR = resolve(__dirname, '../web/public');
const FILE = readFileSync(resolve(PUBLIC_DIR, 'llms.txt'), 'utf8');
const CAM_PROXY_OPENAPI = 'https://raw.githubusercontent.com/klaushofrichter/cam-proxy/main/openapi.yaml';

const GOOGLE = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'ALLOWED_EMAILS'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.WEB_DIST = PUBLIC_DIR;
  for (const n of [...GOOGLE, 'CAMS_LOGIN_TOKEN']) saved[n] = process.env[n];
});
afterAll(() => {
  delete process.env.WEB_DIST;
});
afterEach(() => {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

async function getLlms() {
  const res = await request(createApp()).get('/llms.txt');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(res.text.split('\n')[0]).toBe('# cams');
  expect(res.text).toContain(CAM_PROXY_OPENAPI);
  return res;
}

describe('GET /llms.txt', () => {
  it('is served signed out as plain text (Google mode)', async () => {
    await getLlms();
  });

  it('is served signed out in token mode', async () => {
    for (const n of GOOGLE) delete process.env[n];
    process.env.CAMS_LOGIN_TOKEN = 'llms-test-token-0123456789abcdef';
    await getLlms();
  });

  it('does not answer other cased names', async () => {
    for (const path of ['/LLMS.txt', '/llms.TXT', '/Llms.txt']) {
      const res = await request(createApp()).get(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe('llms.txt content', () => {
  it('follows the llms.txt layout: title, summary, sections, Optional last', () => {
    const lines = FILE.split('\n');
    expect(lines[0]).toBe('# cams');
    expect(lines.find((l) => l.trim() !== '' && l !== '# cams')).toMatch(/^> /);
    const sections = lines.filter((l) => l.startsWith('## '));
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.at(-1)).toBe('## Optional');
  });

  it('links only to the public repos and skylar.technology over https', () => {
    const links = [...FILE.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    const allowed = [
      /^https:\/\/github\.com\/klaushofrichter\/[\w.-]+(\/|$)/,
      /^https:\/\/raw\.githubusercontent\.com\/klaushofrichter\/[\w.-]+\//,
      /^https:\/\/([\w-]+\.)*skylar\.technology(\/|$)/,
    ];
    for (const link of links) expect(allowed.some((re) => re.test(link)), link).toBe(true);
    // Bare URLs in the text follow the same rule.
    for (const url of FILE.match(/https?:\/\/[^\s)<>`]+/g) ?? []) {
      expect(allowed.some((re) => re.test(url)), url).toBe(true);
    }
  });

  it('carries no addresses, emails or tokens', () => {
    expect(FILE).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(FILE).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(FILE).not.toMatch(/\b(cao|cad)_[A-Za-z0-9]{8,}/);
  });
});

describe('llms.txt and MCP', () => {
  it('names the MCP endpoint and links its README section', () => {
    expect(FILE).toContain('https://cams.skylar.technology/mcp');
    expect(FILE).toContain('https://github.com/klaushofrichter/cams/blob/main/README.md#mcp-server');
  });
});
