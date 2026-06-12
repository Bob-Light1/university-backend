'use strict';

/**
 * @file public-portal.routes.js — Router composite du module public-portal.
 *
 * Monté dans server.js via  app.use('/api', routes)  → URLs INCHANGÉES :
 *   /api/public/*        — portail public (X-Portal-Key, pas de JWT)
 *   /api/portal-admin/*  — back-office du portail (JWT, ADMIN/DIRECTOR/CAMPUS_MANAGER)
 *
 * Chaque sous-router porte ses propres middlewares (publicPortalMiddleware /
 * authenticate) — aucun middleware global n'est appliqué entre les deux.
 */

const express = require('express');
const router  = express.Router();

router.use('/public',       require('./public.routes'));
router.use('/portal-admin', require('./portal-admin.routes'));

module.exports = router;
