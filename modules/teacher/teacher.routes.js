'use strict';

/**
 * @file teacher.routes.js — Composite router for the teacher module.
 *
 * Mounted in server.js via  app.use('/api', routes)  → URLs UNCHANGED:
 *   /api/teachers/*           — CRUD, profile, dashboard
 *   /api/schedules/teacher/*  — teacher schedules
 *   /api/attendance/teacher/* — teacher attendance
 */

const express = require('express');
const router  = express.Router();

router.use('/teachers',           require('./teacher.crud.routes'));
router.use('/schedules/teacher',  require('./teacher.schedule.routes'));
router.use('/attendance/teacher', require('./teacher.attendance.routes'));

module.exports = router;
