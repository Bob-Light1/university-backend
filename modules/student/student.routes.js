'use strict';

/**
 * @file student.routes.js — Router composite du module student.
 *
 * Monté dans server.js via  app.use('/api', routes)  → URLs INCHANGÉES :
 *   /api/students/*           — CRUD, profil, dashboard
 *   /api/schedules/student/*  — student timetables
 *   /api/attendance/student/* — student attendance
 */

const express = require('express');
const router  = express.Router();

router.use('/students',           require('./student.crud.routes'));
router.use('/schedules/student',  require('./student.schedule.routes'));
router.use('/attendance/student', require('./student.attendance.routes'));

module.exports = router;
