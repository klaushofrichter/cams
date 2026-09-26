import { describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'http';
import { statSync } from 'fs';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { createMockCamera } from './mock-camera/server';

const creds = { user: 'u', password: 'p' };
const login = (app: Parameters<typeof request>[0], password = 'p') =>
  request(app)
    .post('/cgi-bin/api.cgi?cmd=Login')
    .send([{ cmd: 'Login', action: 0, param: { User: { Version: '0', userName: 'u', password } } }]);

describe('mock camera', () => {
  it('issues a token for valid credentials and rejects bad ones', async () => {
    const { app } = createMockCamera(creds);
    const ok = await login(app);
    expect(ok.body[0].code).toBe(0);
    expect(ok.body[0].value.Token).toMatchObject({ leaseTime: 3600 });
    const bad = await login(app, 'wrong');
    expect(bad.body[0].code).not.toBe(0);
  });

  it('answers commands only with a valid token', async () => {
    const { app, state } = createMockCamera(creds);
    const token = (await login(app)).body[0].value.Token.name;
    const cmd = (t: string) =>
      request(app).post(`/cgi-bin/api.cgi?cmd=GetDevInfo&token=${t}`).send([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
    expect((await cmd(token)).body[0].value.DevInfo.model).toBe('RLC-1224A');
    expect((await cmd('nope')).body[0].error.rspCode).toBe(-6);
    state.revokeTokens();
    expect((await cmd(token)).body[0].error.rspCode).toBe(-6);
  });

  it('serves a JPEG snapshot with a valid token', async () => {
    const { app } = createMockCamera(creds);
    const token = (await login(app)).body[0].value.Token.name;
    const res = await request(app).get(`/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=x&token=${token}`);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('answers a snapshot with a bad token like real firmware: 200, text/html, rspCode -6 body', async () => {
    const { app } = createMockCamera(creds);
    const res = await request(app).get('/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=x&token=nope');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(JSON.parse(res.text)[0].error.rspCode).toBe(-6);
  });

  it('refuses all requests while "offline"', async () => {
    const { app, state } = createMockCamera(creds);
    state.offline = true;
    await expect(login(app)).rejects.toThrow();
  });

  it('reports activeStreams and logins via /__state, even while "offline"', async () => {
    const { app, state } = createMockCamera(creds);
    await login(app);
    expect((await request(app).get('/__state')).body).toEqual({ activeStreams: 0, streamsOpened: 0, logins: 1, downloads: 0, activeDownloads: 0, reboots: 0 });
    state.offline = true;
    const res = await request(app).get('/__state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeStreams: 0, streamsOpened: 0, logins: 1, downloads: 0, activeDownloads: 0, reboots: 0 });
  });

  it('streams /flv and stops counting once the client disconnects', async () => {
    const { app, state } = createMockCamera(creds);
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const token = (await login(app)).body[0].value.Token.name;

      // Like real firmware: no HTTP response for a bad token, just a reset.
      const bad = await new Promise<string>((resolve) => {
        http
          .get(`http://127.0.0.1:${port}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=nope`, (res) => {
            resolve(`HTTP ${res.statusCode}`);
            res.resume();
          })
          .on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      });
      expect(bad).toBe('ECONNRESET');

      const res = await new Promise<http.IncomingMessage>((resolve) => {
        http.get(`http://127.0.0.1:${port}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=${token}`, resolve);
      });
      const firstChunk = await new Promise<Buffer>((resolve) => res.once('data', resolve));
      expect(firstChunk.subarray(0, 3).toString()).toBe('FLV');
      expect(state.activeStreams).toBe(1);
      expect(state.streamsOpened).toBe(1);

      res.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(state.activeStreams).toBe(0);
      expect(state.streamsOpened).toBe(1);
    } finally {
      server.close();
    }
  });

  // A real camera sends frames as they happen. A 20 s burst followed by
  // silence left Chrome's software H.264 decoder (Linux CI) holding the last
  // few frames forever, so e2e playback never started there.
  it('paces /flv in real time, like a live camera', async () => {
    const { app } = createMockCamera(creds);
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const token = (await login(app)).body[0].value.Token.name;
      const total = statSync(join(__dirname, 'mock-camera/fixtures/live.flv')).size;
      const res = await new Promise<http.IncomingMessage>((resolve) => {
        http.get(`http://127.0.0.1:${port}/flv?port=1935&app=bcs&stream=channel0_sub.bcs&token=${token}`, resolve);
      });
      let received = 0;
      res.on('data', (chunk: Buffer) => (received += chunk.length));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      res.destroy();
      // About 1 s of a 20 s fixture: some data (headers plus the first
      // second), and far from all of it.
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(total * 0.25);
    } finally {
      server.close();
    }
  });
});

describe('mock camera recordings', () => {
  async function token(app: Parameters<typeof request>[0]) {
    return (await login(app)).body[0].value.Token.name as string;
  }
  const search = (app: Parameters<typeof request>[0], t: string, onlyStatus: 0 | 1, day: Date, stream = 'sub') =>
    request(app)
      .post(`/cgi-bin/api.cgi?cmd=Search&token=${t}`)
      .send([
        {
          cmd: 'Search',
          action: 0,
          param: {
            Search: {
              channel: 0,
              onlyStatus,
              streamType: stream,
              StartTime: { year: day.getFullYear(), mon: day.getMonth() + 1, day: onlyStatus ? 1 : day.getDate(), hour: 0, min: 0, sec: 0 },
              EndTime: { year: day.getFullYear(), mon: day.getMonth() + 1, day: day.getDate(), hour: 23, min: 59, sec: 59 },
            },
          },
        },
      ]);

  it('answers GetTime like the real camera (UTC-6 with DST)', async () => {
    const { app } = createMockCamera(creds);
    const t = await token(app);
    const res = await request(app).post(`/cgi-bin/api.cgi?cmd=GetTime&token=${t}`).send([{ cmd: 'GetTime', action: 0, param: {} }]);
    expect(res.body[0].value.Time.timeZone).toBe(21600);
    expect(res.body[0].value.Dst).toMatchObject({ enable: 1, offset: 1 });
  });

  it('lists clips for a day with real-format names on both streams', async () => {
    const { app } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] }] });
    const t = await token(app);
    const today = chicagoToday();
    const sub = await search(app, t, 0, today, 'sub');
    const main = await search(app, t, 0, today, 'main');
    const subName: string = sub.body[0].value.SearchResult.File[0].name;
    expect(subName).toMatch(/\/Mp4Record\/\d{4}-\d{2}-\d{2}\/RecS0A_(DST)?\d{8}_081510_081535_0_5514C000000000_[0-9A-F]+\.mp4$/);
    expect(main.body[0].value.SearchResult.File[0].name).toMatch(/RecM0A_/);
  });

  it('marks days that have clips in the month table', async () => {
    const { app } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['motion'] }] });
    const t = await token(app);
    const today = chicagoToday();
    const res = await search(app, t, 1, today);
    const table: string = res.body[0].value.SearchResult.Status[0].table;
    expect(table[today.getDate() - 1]).toBe('1');
  });

  it('downloads a clip with a valid token, and answers a bad token with 401 text/html like the firmware', async () => {
    const { app, state } = createMockCamera({ ...creds, clips: [{ daysAgo: 0, start: '081510', end: '081535', triggers: ['motion'] }] });
    const t = await token(app);
    const name = (await search(app, t, 0, chicagoToday())).body[0].value.SearchResult.File[0].name;
    const ok = await request(app).get(`/cgi-bin/api.cgi?cmd=Download&source=${name}&output=x.mp4&token=${t}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('video/mp4');
    expect(state.downloads).toBe(1);
    // Firmware: a percent-encoded source makes the camera drop the connection.
    await expect(request(app).get(`/cgi-bin/api.cgi?cmd=Download&source=${encodeURIComponent(name)}&output=x.mp4&token=${t}`)).rejects.toThrow();
    const bad = await request(app).get(`/cgi-bin/api.cgi?cmd=Download&source=${name}&output=x.mp4&token=nope`);
    expect(bad.status).toBe(401);
    expect(bad.headers['content-type']).toMatch(/^text\/html/);
    expect(bad.text).toBe('');
  });
});

describe('mock camera settings', () => {
  async function tok(app: Parameters<typeof request>[0]) {
    return (await login(app)).body[0].value.Token.name as string;
  }
  const cmd = (app: Parameters<typeof request>[0], t: string, name: string, param: object) =>
    request(app).post(`/cgi-bin/api.cgi?cmd=${name}&token=${t}`).send([{ cmd: name, action: 0, param }]);

  it('reads the real camera defaults and merges partial writes', async () => {
    const { app, state } = createMockCamera(creds);
    const t = await tok(app);
    expect((await cmd(app, t, 'GetMdAlarm', { channel: 0 })).body[0].value.MdAlarm.newSens.sensDef).toBe(10);
    expect((await cmd(app, t, 'SetOsd', { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Porch', pos: 'Lower Right' } } })).body[0].code).toBe(0);
    const osd = (await cmd(app, t, 'GetOsd', { channel: 0 })).body[0].value.Osd;
    expect(osd.osdChannel.name).toBe('Porch');
    expect(osd.osdTime).toEqual({ enable: 1, pos: 'Top Center' }); // untouched half kept
    const ai = (await cmd(app, t, 'GetAiAlarm', { channel: 0, ai_type: 'vehicle' })).body[0].value.AiAlarm;
    expect(ai.ai_type).toBe('vehicle');
    expect(state.setCalls).toEqual(['SetOsd']);
  });

  it('rejects out-of-range values like the firmware and keeps the old value', async () => {
    const { app } = createMockCamera(creds);
    const t = await tok(app);
    const bad = await cmd(app, t, 'SetMdAlarm', { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 99 } } });
    expect(bad.body[0]).toMatchObject({ code: 1, error: { rspCode: -56 } });
    expect((await cmd(app, t, 'GetMdAlarm', { channel: 0 })).body[0].value.MdAlarm.newSens.sensDef).toBe(10);
  });

  it('rejects an OSD name over 31 bytes or with control characters, like the firmware', async () => {
    const { app } = createMockCamera(creds);
    const t = await tok(app);
    const osd = (name: string) => cmd(app, t, 'SetOsd', { Osd: { channel: 0, osdChannel: { name } } });
    expect((await osd('門'.repeat(11))).body[0]).toMatchObject({ code: 1, error: { rspCode: -56 } });
    expect((await osd('\u200bDen')).body[0]).toMatchObject({ code: 1, error: { rspCode: -56 } });
    expect((await osd('x'.repeat(31))).body[0].code).toBe(0);
  });

  it('can fail or silently ignore chosen commands', async () => {
    const { app } = createMockCamera({ ...creds, settingsFailures: ['SetWhiteLed'], ignoreWrites: ['SetIrLights'] });
    const t = await tok(app);
    expect((await cmd(app, t, 'SetWhiteLed', { WhiteLed: { channel: 0, mode: 0, bright: 10 } })).body[0].code).toBe(1);
    const ignored = await cmd(app, t, 'SetIrLights', { IrLights: { channel: 0, state: 'Off' } });
    expect(ignored.body[0]).toMatchObject({ code: 0, value: { rspCode: 200 } });
    expect((await cmd(app, t, 'GetIrLights', { channel: 0 })).body[0].value.IrLights.state).toBe('Auto');
  });

  it('counts reboots and drops connections while rebooting', async () => {
    const { app, state } = createMockCamera(creds);
    const t = await tok(app);
    expect((await cmd(app, t, 'Reboot', {})).body[0].code).toBe(0);
    expect(state.reboots).toBe(1);
    await expect(cmd(app, t, 'GetDevInfo', {})).rejects.toThrow();
  });
});

// Calendar "today" in the mock camera's zone, as a local-date Date object.
function chicagoToday(): Date {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()).split('-').map(Number);
  return new Date(y, m - 1, d);
}
