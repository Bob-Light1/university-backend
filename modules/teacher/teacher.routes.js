'use strict';

/**
 * @file teacher.routes.js — Router composite du module teacher.
 *
 * Monté dans server.js via  app.use('/api', routes)  → URLs INCHANGÉES :
 *   /api/teachers/*           — CRUD, profil, dashboard
 *   /api/schedules/teacher/*  — emplois du temps enseignants
 *   /api/attendance/teacher/* — présences enseignants
 */

const express = require('express');
const router  = express.Router();

router.use('/teachers',           require('./teacher.crud.routes'));
router.use('/schedules/teacher',  require('./teacher.schedule.routes'));
router.use('/attendance/teacher', require('./teacher.attendance.routes'));

module.exports = router;
