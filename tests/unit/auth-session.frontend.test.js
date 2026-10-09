'use strict';
/** @file auth-session.frontend.test.js
 * @description Execute the sibling SPA transports with isolated browser/HTTP adapters.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../../modules/account/session.constants');
const frontend = path.resolve(__dirname, '../../../frontend/src/api');
const present = fs.existsSync(path.join(frontend, 'sessionClient.js'));
const token = (sid, exp = Date.now() / 1000 + 900) => `header.${Buffer.from(JSON.stringify({ sid, exp })).toString('base64url')}.signature`;

/** Load plain ESM source into an isolated browser context; only imports are adapters. */
function load(file, scope, exports) {
  const source = fs.readFileSync(path.join(frontend, file), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport default api;/, '').replace(/\bexport /g, '');
  return vm.runInNewContext(`${source}\n;({ ${exports.join(', ')} });`, scope, { filename: file });
}

(present ? describe : describe.skip)('SPA session transport', () => {
  let storage, scope, client, lifecycle, handler, redirects, requests;
  beforeEach(() => {
    storage = new Map(); redirects = []; requests = [];
    client = { post: jest.fn() };
    const api = jest.fn();
    Object.assign(api, { defaults: { headers: { common: {} } }, interceptors: {
      request: { use: fn => requests.push(fn) }, response: { use: (_ok, fn) => { handler = fn; } },
    } });
    let created = 0;
    scope = { axios: { create: jest.fn(() => created++ ? api : client) }, API_BASE_URL: '/api',
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      navigator: {}, window: { dispatchEvent: jest.fn(), addEventListener: jest.fn(), location: { assign: value => redirects.push(value) } },
      Event: class { constructor(type) { this.type = type; } }, atob: value => Buffer.from(value, 'base64').toString(),
      GATE_ERROR_CODES: [], emitFeatureRefusal: jest.fn(),
    };
    lifecycle = load('sessionClient.js', scope, ['AUTH_ERRORS', 'tokenClaims', 'getAccessToken', 'clearSession', 'endSession', 'startSession']);
    Object.assign(scope, lifecycle);
    load('axiosInstance.js', scope, ['api']);
  });

  test('cookie transport and error mirror follow the backend contract', () => {
    expect({ ...lifecycle.AUTH_ERRORS }).toEqual(C.ERRORS);
    expect(scope.axios.create.mock.calls[0][0]).toMatchObject({ withCredentials: true,
      headers: { [C.HEADER]: C.HEADER_VALUE } });
  });
  test('parallel expired requests share one rotation and store the renewed token', async () => {
    storage.set('token', token('old', 0));
    const renewed = token('old');
    client.post.mockResolvedValue({ data: { data: { token: renewed } } });
    expect(await Promise.all([lifecycle.getAccessToken(), lifecycle.getAccessToken()])).toEqual([renewed, renewed]);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(storage.get('token')).toBe(renewed);
  });
  test('a late refresh failure preserves a newer login', async () => {
    storage.set('token', token('old', 0));
    let fail;
    client.post.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = lifecycle.getAccessToken();
    storage.set('token', token('new'));
    fail(new Error('Old session revoked'));
    await expect(pending).rejects.toThrow('Old session revoked');
    expect(lifecycle.tokenClaims(storage.get('token')).sid).toBe('new');
  });
  test('logout waits for cookie revocation and falls back to its own bearer session', async () => {
    const current = token('own'); storage.set('token', current); storage.set('user', 'cached');
    client.post.mockRejectedValueOnce(new Error('Cookie belongs to another session')).mockResolvedValueOnce({});
    await lifecycle.endSession();
    expect(client.post).toHaveBeenNthCalledWith(2, '/account/session/revoke', {}, { headers: { Authorization: `Bearer ${current}` } });
    expect(storage.size).toBe(0);
  });
  test('failed revocation retains identity instead of claiming logout succeeded', async () => {
    storage.set('token', token('own')); client.post.mockRejectedValue(new Error('Offline'));
    await expect(lifecycle.endSession()).rejects.toThrow('Offline');
    expect(storage.has('token')).toBe(true);
  });
  test.each([C.ERRORS.INVALID, C.ERRORS.EXPIRED])('late %s response cannot clear or retry under a newer identity', async code => {
    const old = token('old'); storage.set('token', old);
    // Another tab can replace storage while an intercepted request awaits its token.
    scope.getAccessToken = async () => { storage.set('token', token('new')); return old; };
    const config = await requests[0]({ headers: {} });
    storage.set('token', token('new'));
    const error = { config, response: { status: 401, data: { errors: { code } } } };
    await expect(handler(error)).rejects.toBe(error);
    expect(lifecycle.tokenClaims(storage.get('token')).sid).toBe('new');
    expect(redirects).toHaveLength(0);
    expect(client.post).not.toHaveBeenCalled();
  });
  test('a current invalid session clears cached identity and redirects', async () => {
    storage.set('token', token('own'));
    const config = await requests[0]({ headers: {} });
    const error = { config, response: { status: 401, data: { errors: { code: C.ERRORS.INVALID } } } };
    await expect(handler(error)).rejects.toBe(error);
    expect(storage.size).toBe(0);
    expect(redirects).toEqual(['/login?session_expired=true']);
  });
});
