'use strict';
/** @file session.service.js
 * @description Short access tokens, rotating refresh credentials and account lockout.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const repo = require('./session.repository');
const C = require('./session.constants');
const { isValidObjectId } = require('../../shared/utils/validation-helpers');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const id = (value) => value ? String(value._id ?? value) : null;
const campus = (model, account) => model === 'Campus' ? id(account._id) : id(account.schoolCampus);
const invalid = () => Object.assign(new Error('Session expired or revoked. Please sign in again.'), {
  statusCode: 401, code: C.ERRORS.INVALID,
});
const fingerprint = (account) => digest(JSON.stringify({
  password: account.password, status: account.status, role: account.role,
  campus: id(account.schoolCampus), classId: id(account.studentClass),
  departmentId: id(account.department), subRole: account.subRole ?? null,
  partnerCode: account.partnerCode, partnerType: account.partnerType,
}));
const active = (model, account) => account && (model === 'Partner'
  ? !['archived', 'suspended'].includes(account.status) : account.status === 'active');
const cookieOptions = () => ({
  httpOnly: true, secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: C.COOKIE_PATH,
});
const credential = () => crypto.randomBytes(32).toString('hex');
const setCookie = (res, session, secret) => res.cookie(C.COOKIE, `${session._id}.${secret}`, {
  ...cookieOptions(), expires: new Date(session.expiresAt),
});
const sign = (session) => jwt.sign({ ...session.claims, sid: String(session._id) }, process.env.JWT_SECRET, {
  algorithm: 'HS256', issuer: C.ISSUER, expiresIn: C.ACCESS_SECONDS,
});

/** Compare credentials with an account-wide lock across all login aliases. */
async function verifyPassword(userModel, account, password) {
  if (typeof password !== 'string') return false;
  const now = new Date();
  const lock = await repo.lock(userModel, account._id, now);
  if (lock?.failures >= C.MAX_FAILURES) return false;
  if (!await bcrypt.compare(password, account.password)) {
    await repo.recordFailure(userModel, account._id, campus(userModel, account), now);
    return false;
  }
  // A concurrent failure may have crossed the threshold during bcrypt.
  if ((await repo.lock(userModel, account._id, new Date()))?.failures >= C.MAX_FAILURES) return false;
  await repo.clearFailures(userModel, account._id);
  return true;
}

/** Issue a session using server-built claims; no request-body scope is accepted. */
async function issue(res, claims, passwordHash) {
  const userModel = C.ROLE_MODELS[claims.role];
  if (!userModel) throw invalid();
  const account = await repo.findAccount(userModel, claims.id);
  if (!active(userModel, account) || account.password !== passwordHash) throw invalid();
  if (id(claims.campusId) !== campus(userModel, account)) throw invalid();
  if (userModel === 'Admin' && account.role !== claims.role) throw invalid();
  // Populate mutable authorization claims from the same snapshot as the fingerprint.
  claims = { ...claims };
  if (userModel === 'Staff') claims.permissions = account.subRole?.isActive ? account.subRole.permissions ?? [] : [];
  if (userModel === 'Student') claims.classId = id(account.studentClass);
  if (userModel === 'Teacher') claims.departmentId = id(account.department);
  if (userModel === 'Partner') {
    claims.partnerCode = account.partnerCode;
    claims.partnerType = account.partnerType;
  }
  const secret = credential();
  const session = await repo.create({
    userModel, userId: account._id, schoolCampus: campus(userModel, account),
    claims: JSON.parse(JSON.stringify(claims)), fingerprint: fingerprint(account),
    refreshHash: digest(secret), expiresAt: new Date(Date.now() + C.SESSION_MS),
  });
  const token = sign(session);
  res.set('Cache-Control', 'no-store');
  setCookie(res, session, secret);
  return token;
}

/** Reject revoked, expired, removed or changed accounts, regardless of JWT expiry. */
async function checkSession(session) {
  if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) throw invalid();
  const account = await repo.findAccount(session.userModel, session.userId);
  if (!active(session.userModel, account) || fingerprint(account) !== session.fingerprint) {
    await repo.revoke({ _id: session._id }, new Date());
    throw invalid();
  }
  return session;
}

/** Verify an access token, including its live server session. */
async function authenticateToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: C.ISSUER });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw Object.assign(invalid(), { code: C.ERRORS.EXPIRED });
    }
    if (['JsonWebTokenError', 'NotBeforeError'].includes(error.name)) throw invalid();
    throw error;
  }
  if (!isValidObjectId(claims.sid) || !isValidObjectId(claims.id) || !C.ROLE_MODELS[claims.role]) throw invalid();
  const session = await checkSession(await repo.find(claims.sid));
  if (id(session.userId) !== claims.id || session.claims.role !== claims.role
      || id(session.schoolCampus) !== id(claims.campusId)) throw invalid();
  // Authorization claims come from the session rather than caller-controlled fields.
  return { ...session.claims, sid: String(session._id), iat: claims.iat, exp: claims.exp };
}

/** Validate the cookie and expected identity; the custom header prevents form CSRF. */
function readRefresh(req) {
  if (req.get(C.HEADER) !== C.HEADER_VALUE) throw invalid();
  const raw = req.cookies?.[C.COOKIE];
  const parts = typeof raw === 'string' ? raw.split('.') : [];
  if (parts.length !== 2 || !isValidObjectId(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])
      || req.body?.sessionId !== parts[0]) throw invalid();
  return { sessionId: parts[0], hash: digest(parts[1]) };
}

/** Atomically rotate refresh credentials; replay revokes the entire session family. */
async function refresh(req, res) {
  const { sessionId, hash } = readRefresh(req);
  const session = await checkSession(await repo.find(sessionId));
  if (session.refreshHash !== hash) {
    if (session.usedRefreshHashes?.includes(hash)) await repo.revoke({ _id: sessionId }, new Date());
    throw invalid();
  }
  if (session.usedRefreshHashes?.length >= C.MAX_ROTATIONS) {
    await repo.revoke({ _id: sessionId }, new Date());
    throw invalid();
  }
  const secret = credential();
  const rotated = await repo.rotate(sessionId, hash, digest(secret), new Date());
  if (!rotated) {
    await repo.revoke({ _id: sessionId }, new Date());
    throw invalid();
  }
  setCookie(res, rotated, secret);
  return { token: sign(rotated) };
}

/** Logout also accepts an expired access token by authenticating the refresh cookie. */
async function logout(req, res) {
  const { sessionId, hash } = readRefresh(req);
  const session = await repo.find(sessionId);
  if (session && session.refreshHash !== hash) throw invalid();
  if (session) await repo.revoke({ _id: sessionId }, new Date());
  clearCookie(res);
}

/** Revoke all devices of the authenticated account, never an id supplied by the caller. */
async function logoutAll(user, res) {
  await repo.revoke({ userId: user.id, userModel: C.ROLE_MODELS[user.role] }, new Date());
  clearCookie(res);
}

/** Revoke exactly the bearer-authenticated session when its cookie is unavailable. */
async function revokeCurrent(req, res) {
  await repo.revoke({ _id: req.user.sid }, new Date());
  if (req.cookies?.[C.COOKIE]?.startsWith(`${req.user.sid}.`)) clearCookie(res);
}

/** Remove a refresh cookie with exactly the scope used when issuing it. */
function clearCookie(res) { res.clearCookie(C.COOKIE, cookieOptions()); }

module.exports = { verifyPassword, issue, authenticateToken, refresh, logout, logoutAll, revokeCurrent, clearCookie };
