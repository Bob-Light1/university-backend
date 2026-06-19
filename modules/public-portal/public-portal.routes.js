'use strict';

/**
 * @file public-portal.routes.js — Composite router of the public-portal module.
 *
 * Mounted in server.js via  app.use('/api', routes)  → URLs UNCHANGED:
 *   /api/public/*        — public portal (X-Portal-Key, no JWT)
 *   /api/portal-admin/*  — portal back-office (JWT, ADMIN/DIRECTOR/CAMPUS_MANAGER)
 *
 * Each sub-router carries its own middlewares (publicPortalMiddleware /
 * authenticate) — no global middleware is applied between the two.
 */

const express = require('express');
const router  = express.Router();

router.use('/public',       require('./public.routes'));
router.use('/portal-admin', require('./portal-admin.routes'));

module.exports = router;
