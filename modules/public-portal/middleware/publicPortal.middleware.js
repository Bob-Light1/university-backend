'use strict';

/**
 * @file publicPortal.middleware.js
 * @description Middleware dédié aux endpoints /api/public/*.
 *
 * Responsabilités :
 *  1. Vérifie le header X-Portal-Key (identifie le portail comme source connue)
 *  2. Hache l'IP en SHA-256 et l'attache à req.ipHash (jamais l'IP brute en DB)
 *
 * Ce middleware doit être monté AVANT les middlewares d'authentification JWT
 * puisque ces routes sont publiques (pas de JWT requis).
 *
 * Limitation connue : X-Portal-Key visible dans le JS navigateur.
 * Protection réelle = CORS restreint + rate limiting côté ERP.
 */

const crypto = require('crypto');
const { sendError } = require('../../../shared/utils/response-helpers');

const hashIp = (ip) => crypto.createHash('sha256').update(ip || '').digest('hex');

// Comparaison à temps constant — évite les attaques temporelles sur la clé.
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const publicPortalMiddleware = (req, res, next) => {
  const expectedKey = process.env.PORTAL_API_KEY;

  // Fail-closed : si la clé n'est pas configurée côté ERP, on refuse tout.
  if (!expectedKey) {
    return sendError(res, 503, 'Public portal is not configured.');
  }

  const portalKey = req.headers['x-portal-key'];

  if (!portalKey || !safeEqual(portalKey, expectedKey)) {
    return sendError(res, 401, 'Missing or invalid portal key.');
  }

  // Hache l'IP — les contrôleurs lisent req.ipHash, jamais req.ip directement
  const rawIp  = req.ip || req.connection?.remoteAddress || '';
  req.ipHash   = hashIp(rawIp);

  next();
};

module.exports = publicPortalMiddleware;
