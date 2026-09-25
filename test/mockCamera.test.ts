import { describe, expect, it } from 'vitest';
import request from 'supertest';
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

  it('refuses all requests while "offline"', async () => {
    const { app, state } = createMockCamera(creds);
    state.offline = true;
    const res = await login(app);
    expect(res.status).toBe(503);
  });
});
