'use strict';

/**
 * @file staff.routes.js — router composite du module staff
 * Compose les deux sous-routers du domaine sous un router unique, monté par
 * server.js sur '/api'. Les URLs finales sont STRICTEMENT identiques à avant :
 *   /api/staff/...        (membres du staff)
 *   /api/staff-roles/...  (rôles & permissions)
 */

const express = require('express');
const router  = express.Router();

router.use('/staff',       require('./staff.member.routes'));
router.use('/staff-roles', require('./staff.role.routes'));

module.exports = router;
