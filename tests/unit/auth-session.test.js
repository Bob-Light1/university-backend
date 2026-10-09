'use strict';
/** @file auth-session.test.js
 * @description Authentication policy regressions with persistence isolated.
 */
jest.mock('../../modules/account/session.repository', () => ({
  findAccount: jest.fn(), recordFailure: jest.fn(), create: jest.fn(), find: jest.fn(),
  rotate: jest.fn(), revoke: jest.fn(), lock: jest.fn(), clearFailures: jest.fn(),
}));
jest.mock('bcrypt', () => ({ compare: jest.fn() }));
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const service = require('../../modules/account/session.service');
const repo = require('../../modules/account/session.repository');
const C = require('../../modules/account/session.constants');
const { authenticate, optionalAuth } = require('../../shared/middleware/auth');
const sid = '0123456789abcdef01234567';
const uid = '1123456789abcdef01234567';
const campus = '2123456789abcdef01234567';
let account, res, session;
const request = (cookie, sessionId = sid) => ({
  get: () => C.HEADER_VALUE, cookies: { [C.COOKIE]: cookie }, body: { sessionId },
});
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function issue(role = 'STUDENT') {
  const token = await service.issue(res, { id: uid, role, campusId: campus }, account.password);
  repo.find.mockResolvedValue(session);
  return token;
}
beforeEach(() => {
  jest.resetAllMocks();
  account = { _id: uid, status: 'active', password: 'a-password-hash', schoolCampus: campus };
  res = { cookie: jest.fn(), clearCookie: jest.fn(), set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  repo.findAccount.mockResolvedValue(account);
  repo.create.mockImplementation(async (data) => { session = { ...data, _id: sid }; return session; });
  bcrypt.compare.mockResolvedValue(true);
});

test('issues short access tokens and stores only a refresh digest in a scoped session', async () => {
  // Pin the agreed policy independently; importing both sides would hide a changed policy.
  expect(C).toMatchObject({ ACCESS_SECONDS: 900, SESSION_MS: 604800000,
    LOCK_MS: 900000, MAX_FAILURES: 5, MAX_ROTATIONS: 1000 });
  const token = await issue();
  const claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: C.ISSUER });
  expect(claims.exp - claims.iat).toBe(C.ACCESS_SECONDS);
  expect(claims).toMatchObject({ sid, id: uid, role: 'STUDENT', campusId: campus });
  const [name, cookie, options] = res.cookie.mock.calls[0];
  expect(name).toBe(C.COOKIE);
  expect(options).toMatchObject({ httpOnly: true, path: C.COOKIE_PATH, sameSite: 'lax' });
  expect(session.refreshHash).toBe(hash(cookie.split('.')[1]));
  expect(JSON.stringify(session)).not.toContain(cookie.split('.')[1]);
  expect(new Date(session.expiresAt).getTime() - Date.now()).toBeGreaterThan(604795000);
  expect(new Date(session.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(604800000);
  expect(await service.authenticateToken(token)).toMatchObject({ id: uid, campusId: campus });
});

test('production cookie requires HTTPS and allows the configured cross-site SPA', async () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await issue();
    expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: true, sameSite: 'none', httpOnly: true });
  } finally { process.env.NODE_ENV = old; }
});

test.each(['ADMIN', 'DIRECTOR'])('global %s sessions do not invent a campus', async (role) => {
  account = { _id: uid, status: 'active', password: 'hash', role };
  repo.findAccount.mockResolvedValue(account);
  await service.issue(res, { id: uid, role }, account.password);
  expect(session.schoolCampus).toBeNull();
});

test('account lock rejects a valid password before bcrypt and does not extend its deadline', async () => {
  repo.lock.mockResolvedValue({ failures: C.MAX_FAILURES });
  expect(await service.verifyPassword('Student', account, 'candidate')).toBe(false);
  expect(bcrypt.compare).not.toHaveBeenCalled();
  expect(repo.recordFailure).not.toHaveBeenCalled();
});

test('failed passwords accumulate by model/account, independent of login alias', async () => {
  bcrypt.compare.mockResolvedValue(false);
  expect(await service.verifyPassword('Student', account, 'wrong')).toBe(false);
  expect(repo.recordFailure).toHaveBeenCalledWith('Student', uid, campus, expect.any(Date));
  expect(repo.clearFailures).not.toHaveBeenCalled();
});

test('successful password clears previous failures; concurrent threshold crossing refuses it', async () => {
  expect(await service.verifyPassword('Student', account, 'correct')).toBe(true);
  expect(repo.clearFailures).toHaveBeenCalledWith('Student', uid);
  repo.clearFailures.mockClear();
  repo.lock.mockResolvedValueOnce(null).mockResolvedValueOnce({ failures: C.MAX_FAILURES });
  expect(await service.verifyPassword('Student', account, 'correct')).toBe(false);
  expect(repo.clearFailures).not.toHaveBeenCalled();
});

test.each([
  ['revoked', () => { session.revokedAt = new Date(); }],
  ['expired', () => { session.expiresAt = new Date(0); }],
  ['password changed', () => { account.password = 'new-hash'; }],
  ['archived', () => { account.status = 'archived'; }],
  ['campus changed', () => { account.schoolCampus = '3123456789abcdef01234567'; }],
  ['role changed', () => { account.role = 'ADMIN'; }],
  ['account removed', () => { repo.findAccount.mockResolvedValue(null); }],
])('access is refused when %s', async (_label, mutate) => {
  const token = await issue(); mutate();
  await expect(service.authenticateToken(token)).rejects.toMatchObject({ code: C.ERRORS.INVALID });
});

test('staff permission changes invalidate existing access', async () => {
  account.subRole = { _id: uid, isActive: true, permissions: ['student.read'] };
  const token = await issue('STAFF');
  account.subRole.permissions.push('student.manage');
  await expect(service.authenticateToken(token)).rejects.toMatchObject({ statusCode: 401 });
});

test('legacy, reset-purpose, foreign issuer and wrong algorithm tokens never reach persistence', async () => {
  const tokens = [
    jwt.sign({ id: uid, role: 'ADMIN' }, process.env.JWT_SECRET, { issuer: C.ISSUER }),
    jwt.sign({ id: uid, purpose: 'pwd-reset' }, process.env.JWT_SECRET, { issuer: C.ISSUER }),
    jwt.sign({ id: uid, role: 'ADMIN', sid }, process.env.JWT_SECRET, { issuer: 'other' }),
    jwt.sign({ id: uid, role: 'ADMIN', sid }, process.env.JWT_SECRET, { issuer: C.ISSUER, algorithm: 'HS384' }),
  ];
  for (const token of tokens) await expect(service.authenticateToken(token)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.find).not.toHaveBeenCalled();
});

test('only expired JWTs carry the refreshable error code', async () => {
  const token = jwt.sign({ id: uid, role: 'STUDENT', sid }, process.env.JWT_SECRET,
    { issuer: C.ISSUER, expiresIn: -1 });
  await expect(service.authenticateToken(token)).rejects.toMatchObject({ code: C.ERRORS.EXPIRED });
  await expect(service.authenticateToken('bad')).rejects.toMatchObject({ code: C.ERRORS.INVALID });
});

test('rotation consumes the stored digest atomically and returns the standard token shape', async () => {
  await issue();
  const cookie = res.cookie.mock.calls[0][1];
  repo.rotate.mockImplementation(async (_id, _old, nextHash) => ({ ...session, refreshHash: nextHash }));
  const result = await service.refresh(request(cookie), res);
  expect(result.token).toEqual(expect.any(String));
  expect(repo.rotate).toHaveBeenCalledWith(sid, session.refreshHash, expect.any(String), expect.any(Date));
  expect(res.cookie.mock.calls[1][1]).not.toBe(cookie);
  expect(jwt.decode(result.token).sid).toBe(sid);
});

test('a replay or lost rotation race revokes the session family', async () => {
  await issue();
  repo.rotate.mockResolvedValue(null);
  await expect(service.refresh(request(res.cookie.mock.calls[0][1]), res)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.revoke).toHaveBeenCalledWith({ _id: sid }, expect.any(Date));
});

test.each(['header', 'cookie', 'identity'])('refresh refuses missing/mismatched %s before any database read', async (part) => {
  await issue();
  const req = request(res.cookie.mock.calls[0][1]);
  if (part === 'header') req.get = () => undefined;
  if (part === 'cookie') req.cookies = {};
  if (part === 'identity') req.body.sessionId = uid;
  await expect(service.refresh(req, res)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.find).not.toHaveBeenCalled();
});

test('logout clears the exact cookie path and revokes access immediately', async () => {
  const token = await issue();
  repo.revoke.mockImplementation(async () => { session.revokedAt = new Date(); });
  await service.logout(request(res.cookie.mock.calls[0][1]), res);
  expect(res.clearCookie).toHaveBeenCalledWith(C.COOKIE, expect.objectContaining({ path: C.COOKIE_PATH }));
  await expect(service.authenticateToken(token)).rejects.toMatchObject({ statusCode: 401 });
});

test('logout-all uses the authenticated model/id, with no campus or caller-supplied selector', async () => {
  await service.logoutAll({ id: uid, role: 'DIRECTOR' }, res);
  expect(repo.revoke).toHaveBeenCalledWith({ userId: uid, userModel: 'Admin' }, expect.any(Date));
});

test('authentication fails closed on persistence outage; optional auth grants no identity', async () => {
  const token = await issue();
  repo.find.mockRejectedValue(new Error('DB down'));
  const req = { header: () => `Bearer ${token}`, user: { role: 'ADMIN' } };
  const next = jest.fn();
  await authenticate(req, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(next).not.toHaveBeenCalled();
  await optionalAuth(req, res, next);
  expect(req.user).toBeUndefined();
  expect(next).toHaveBeenCalledTimes(1);
});

test('issuance cannot preserve an ADMIN role that changed after password verification', async () => {
  account = { _id: uid, password: 'hash', status: 'active', role: 'DIRECTOR' };
  repo.findAccount.mockResolvedValue(account);
  await expect(service.issue(res, { id: uid, role: 'ADMIN' }, 'hash')).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.create).not.toHaveBeenCalled();
});

test('issuance uses current staff permissions, not an earlier populated snapshot', async () => {
  account.subRole = { _id: uid, isActive: true, permissions: ['student.read'] };
  const token = await service.issue(res, { id: uid, role: 'STAFF', campusId: campus, permissions: ['student.manage'] }, account.password);
  expect(jwt.decode(token).permissions).toEqual(['student.read']);
});

test('inventing a refresh secret cannot revoke somebody else’s session', async () => {
  await issue();
  await expect(service.refresh(request(`${sid}.${'0'.repeat(64)}`), res)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.revoke).not.toHaveBeenCalled();
});

test('spent refresh credentials revoke the family, while history stays bounded', async () => {
  await issue();
  const spent = '1'.repeat(64);
  session.usedRefreshHashes = [hash(spent)];
  await expect(service.refresh(request(`${sid}.${spent}`), res)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.revoke).toHaveBeenCalledWith({ _id: sid }, expect.any(Date));
  repo.revoke.mockClear();
  session.usedRefreshHashes = Array(C.MAX_ROTATIONS).fill(hash(spent));
  await expect(service.refresh(request(res.cookie.mock.calls[0][1]), res)).rejects.toMatchObject({ statusCode: 401 });
  expect(repo.rotate).not.toHaveBeenCalled();
});

test('production password reset never writes a credential or account email to logs', async () => {
  const partnerRepo = require('../../modules/partner/partner.repository');
  const { forgotPassword } = require('../../modules/partner/controllers/partner.auth.controller');
  const read = jest.spyOn(partnerRepo, 'findPartnerByEmailWithPasswordLean')
    .mockResolvedValue({ _id: uid, email: 'partner@example.test', password: 'hash-for-reset' });
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await forgotPassword({ body: { email: 'partner@example.test' } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).not.toHaveProperty('resetLink');
    expect(info).not.toHaveBeenCalled();
  } finally { process.env.NODE_ENV = old; read.mockRestore(); info.mockRestore(); }
});
