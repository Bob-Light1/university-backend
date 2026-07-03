'use strict';

/**
 * @file ai.s2s.js
 * @description Service-to-service (S2S) JWT emission and verification (§4.2).
 *
 * Contract with ai-service (authoritative on both sides — see
 * ai-service/app/core/security.py, verified in M1):
 *  - Algorithm HS256, shared secret AI_SERVICE_SECRET.
 *  - Node → ai-service : iss "erp-backend", aud "ai-service".
 *  - ai-service → Node : iss "ai-service", aud "erp-backend".
 *  - TTL ≤ 300 s (longer tokens are rejected by the receiver).
 *  - Claims: sub (userId), campusId, role, scope, plan, llmProfile.
 *
 * The campus/user/role context ALWAYS comes from the verified token — never
 * from the request body (§4.1 rule 1). Scoped roles without a campusId are
 * rejected on verification, mirroring the Python side.
 */

const jwt = require('jsonwebtoken');
const config = require('../../shared/configs/general.config');

const ISSUER_SELF = 'erp-backend';
const ISSUER_SERVICE = 'ai-service';
const AUDIENCE_SERVICE = 'ai-service';
const AUDIENCE_SELF = 'erp-backend';

/** Hard S2S contract: tokens live at most 5 minutes (§4.2). */
const S2S_TTL_SECONDS = 300;

const GLOBAL_ROLES = ['ADMIN', 'DIRECTOR'];

/**
 * Signs a short-lived S2S token for an outgoing call to ai-service.
 * The { plan, llmProfile } pair comes from the campus entitlement (§11.3) and
 * is therefore unforgeable by the frontend.
 *
 * @param {Object} ctx
 * @param {string} ctx.userId       - Authenticated user id (JWT `sub`).
 * @param {string|null} ctx.campusId - Campus scope ('' for global roles).
 * @param {string} ctx.role         - ERP role (ADMIN, STUDENT, …).
 * @param {string[]} [ctx.scope]    - Optional capability scope.
 * @param {string} [ctx.plan]       - Entitlement plan (free|standard|premium).
 * @param {string} [ctx.llmProfile] - LLM provider profile name (ADR-5).
 * @returns {string} Signed JWT.
 */
const signServiceToken = ({ userId, campusId, role, scope = [], plan = 'free', llmProfile = 'free' }) => {
  if (!config.ai.serviceSecret) {
    throw new Error('AI_SERVICE_SECRET is not configured');
  }
  return jwt.sign(
    {
      sub: String(userId),
      campusId: campusId ? String(campusId) : '',
      role,
      scope,
      plan,
      llmProfile,
    },
    config.ai.serviceSecret,
    {
      algorithm: 'HS256',
      issuer: ISSUER_SELF,
      audience: AUDIENCE_SERVICE,
      expiresIn: S2S_TTL_SECONDS,
    }
  );
};

/**
 * Verifies an incoming ai-service-signed S2S token (calls to /internal/ai/*).
 * Enforces issuer/audience, the ≤ 300 s TTL, and a campusId for scoped roles
 * (same rules as ai-service/app/core/security.py).
 *
 * @param {string} token - Raw JWT from the Authorization header.
 * @returns {{ userId: string, campusId: string, role: string, scope: string[] }}
 * @throws {Error} When the token is missing claims, forged, expired or over-TTL.
 */
const verifyServiceToken = (token) => {
  if (!config.ai.serviceSecret) {
    throw new Error('AI_SERVICE_SECRET is not configured');
  }
  const claims = jwt.verify(token, config.ai.serviceSecret, {
    algorithms: ['HS256'],
    issuer: ISSUER_SERVICE,
    audience: AUDIENCE_SELF,
  });

  const ttl = Number(claims.exp) - Number(claims.iat);
  if (!Number.isFinite(ttl) || ttl > S2S_TTL_SECONDS) {
    throw new Error(`S2S token TTL ${ttl}s exceeds the ${S2S_TTL_SECONDS}s max`);
  }

  const userId = String(claims.sub || '').trim();
  const role = String(claims.role || '').trim();
  const campusId = String(claims.campusId || '').trim();
  if (!userId || !role) {
    throw new Error('S2S token is missing sub/role claims');
  }
  if (!campusId && !GLOBAL_ROLES.includes(role)) {
    throw new Error(`S2S token for scoped role ${role} is missing campusId`);
  }

  const scope = Array.isArray(claims.scope) ? claims.scope : [];
  return { userId, campusId, role, scope };
};

module.exports = {
  signServiceToken,
  verifyServiceToken,
  S2S_TTL_SECONDS,
  GLOBAL_ROLES,
};
