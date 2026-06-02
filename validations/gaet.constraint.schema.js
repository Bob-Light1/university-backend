'use strict';

/**
 * @file gaet.constraint.schema.js
 * @description Pure-JS validation middleware for GAET constraint and generate endpoints.
 *
 *  Usage in router:
 *    router.post('/constraints',  validateConstraintBody, createOrUpdateConstraints);
 *    router.post('/generate',     validateGenerateBody,   generateSchedule);
 *
 *  On failure → 400 { success: false, message: 'Validation failed.', errors: [{field, message}] }
 *  On success → calls next()
 */

const mongoose = require('mongoose');

const { WEEKDAY, SEMESTER, SESSION_TYPE } = require('../utils/schedule.base');
const { ROOM_TYPE } = require('../models/gaet-constraint.model');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const ACADEMIC_YEAR_RE = /^\d{4}-\d{4}$/;
const isObjectId       = (v) => mongoose.Types.ObjectId.isValid(v);
const VALID_WEEKDAYS   = Object.values(WEEKDAY);
const VALID_SEMESTERS  = Object.values(SEMESTER);
const VALID_SESSION    = Object.values(SESSION_TYPE);
const VALID_ROOM_TYPES = Object.values(ROOM_TYPE);

const fail = (errors, field, message) => errors.push({ field, message });

// ── SLOT VALIDATOR (shared by timeSlots and unavailableSlots) ─────────────────

const validateSlot = (slot, prefix, errors) => {
  if (typeof slot !== 'object' || Array.isArray(slot) || slot === null) {
    fail(errors, prefix, `${prefix} must be an object.`);
    return;
  }

  if (!VALID_WEEKDAYS.includes(slot.day)) {
    fail(errors, `${prefix}.day`, `day must be one of: ${VALID_WEEKDAYS.join(', ')}.`);
  }

  const sh = Number(slot.startHour);
  if (!Number.isInteger(sh) || sh < 0 || sh > 23) {
    fail(errors, `${prefix}.startHour`, 'startHour must be an integer between 0 and 23.');
  }

  const eh = Number(slot.endHour);
  if (!Number.isInteger(eh) || eh < 1 || eh > 24) {
    fail(errors, `${prefix}.endHour`, 'endHour must be an integer between 1 and 24.');
  }

  if (Number.isInteger(sh) && Number.isInteger(eh) && eh <= sh) {
    fail(errors, `${prefix}.endHour`, 'endHour must be greater than startHour.');
  }
};

// ── SUB-ARRAY VALIDATORS ──────────────────────────────────────────────────────

const validateTimeSlots = (slots, errors) => {
  if (!Array.isArray(slots)) {
    fail(errors, 'timeSlots', 'timeSlots must be an array.');
    return;
  }
  slots.forEach((slot, i) => {
    validateSlot(slot, `timeSlots[${i}]`, errors);
    if (slot.isBreak !== undefined && typeof slot.isBreak !== 'boolean') {
      fail(errors, `timeSlots[${i}].isBreak`, 'isBreak must be a boolean.');
    }
  });
};

const validateCourseRequirements = (reqs, errors) => {
  if (!Array.isArray(reqs)) {
    fail(errors, 'courseRequirements', 'courseRequirements must be an array.');
    return;
  }
  if (reqs.length === 0) {
    fail(errors, 'courseRequirements', 'courseRequirements must not be empty.');
    return;
  }

  reqs.forEach((r, i) => {
    const p = `courseRequirements[${i}]`;

    if (!r.classId || !isObjectId(r.classId)) {
      fail(errors, `${p}.classId`, 'classId is required and must be a valid ObjectId.');
    }
    if (!r.subjectId || !isObjectId(r.subjectId)) {
      fail(errors, `${p}.subjectId`, 'subjectId is required and must be a valid ObjectId.');
    }
    if (!r.teacherId || !isObjectId(r.teacherId)) {
      fail(errors, `${p}.teacherId`, 'teacherId is required and must be a valid ObjectId.');
    }

    if (r.sessionType !== undefined && !VALID_SESSION.includes(r.sessionType)) {
      fail(errors, `${p}.sessionType`, `sessionType must be one of: ${VALID_SESSION.join(', ')}.`);
    }

    const hpw = Number(r.hoursPerWeek);
    if (!r.hoursPerWeek || !Number.isFinite(hpw) || hpw < 1) {
      fail(errors, `${p}.hoursPerWeek`, 'hoursPerWeek is required and must be >= 1.');
    }

    if (r.sessionDuration !== undefined) {
      const sd = Number(r.sessionDuration);
      if (!Number.isFinite(sd) || sd < 30) {
        fail(errors, `${p}.sessionDuration`, 'sessionDuration must be >= 30 minutes.');
      }
    }

    const sc = Number(r.studentCount);
    if (!r.studentCount || !Number.isFinite(sc) || sc < 1) {
      fail(errors, `${p}.studentCount`, 'studentCount is required and must be >= 1.');
    }

    if (r.roomType !== undefined && !VALID_ROOM_TYPES.includes(r.roomType)) {
      fail(errors, `${p}.roomType`, `roomType must be one of: ${VALID_ROOM_TYPES.join(', ')}.`);
    }

    if (r.requiresLab !== undefined && typeof r.requiresLab !== 'boolean') {
      fail(errors, `${p}.requiresLab`, 'requiresLab must be a boolean.');
    }

    if (r.preferMorning !== undefined && typeof r.preferMorning !== 'boolean') {
      fail(errors, `${p}.preferMorning`, 'preferMorning must be a boolean.');
    }
  });
};

const validateRoomRegistry = (rooms, errors) => {
  if (!Array.isArray(rooms)) {
    fail(errors, 'roomRegistry', 'roomRegistry must be an array.');
    return;
  }
  rooms.forEach((room, i) => {
    const p = `roomRegistry[${i}]`;

    if (!room.name || typeof room.name !== 'string' || !room.name.trim()) {
      fail(errors, `${p}.name`, 'name is required.');
    }

    const cap = Number(room.capacity);
    if (!room.capacity || !Number.isFinite(cap) || cap < 1) {
      fail(errors, `${p}.capacity`, 'capacity is required and must be >= 1.');
    }

    if (room.type !== undefined && !VALID_ROOM_TYPES.includes(room.type)) {
      fail(errors, `${p}.type`, `type must be one of: ${VALID_ROOM_TYPES.join(', ')}.`);
    }

    if (room.unavailableSlots !== undefined) {
      if (!Array.isArray(room.unavailableSlots)) {
        fail(errors, `${p}.unavailableSlots`, 'unavailableSlots must be an array.');
      } else {
        room.unavailableSlots.forEach((slot, j) => {
          validateSlot(slot, `${p}.unavailableSlots[${j}]`, errors);
        });
      }
    }
  });
};

const validateTeacherPreferences = (prefs, errors) => {
  if (!Array.isArray(prefs)) {
    fail(errors, 'teacherPreferences', 'teacherPreferences must be an array.');
    return;
  }
  prefs.forEach((pref, i) => {
    const p = `teacherPreferences[${i}]`;

    if (!pref.teacherId || !isObjectId(pref.teacherId)) {
      fail(errors, `${p}.teacherId`, 'teacherId is required and must be a valid ObjectId.');
    }

    if (pref.unavailableSlots !== undefined) {
      if (!Array.isArray(pref.unavailableSlots)) {
        fail(errors, `${p}.unavailableSlots`, 'unavailableSlots must be an array.');
      } else {
        pref.unavailableSlots.forEach((slot, j) => {
          validateSlot(slot, `${p}.unavailableSlots[${j}]`, errors);
        });
      }
    }

    if (pref.maxConsecutiveHours !== undefined) {
      const mch = Number(pref.maxConsecutiveHours);
      if (!Number.isFinite(mch) || mch < 1 || mch > 12) {
        fail(errors, `${p}.maxConsecutiveHours`, 'maxConsecutiveHours must be between 1 and 12.');
      }
    }

    if (pref.preferredDays !== undefined) {
      if (!Array.isArray(pref.preferredDays)) {
        fail(errors, `${p}.preferredDays`, 'preferredDays must be an array.');
      } else {
        pref.preferredDays.forEach((day, j) => {
          if (!VALID_WEEKDAYS.includes(day)) {
            fail(errors, `${p}.preferredDays[${j}]`, `Must be one of: ${VALID_WEEKDAYS.join(', ')}.`);
          }
        });
      }
    }
  });
};

// ── ACADEMIC CONTEXT VALIDATOR (shared by both middlewares) ───────────────────

const validateAcademicContext = (body, errors) => {
  if (!body.academicYear) {
    fail(errors, 'academicYear', 'academicYear is required (format: YYYY-YYYY).');
  } else if (!ACADEMIC_YEAR_RE.test(body.academicYear)) {
    fail(errors, 'academicYear', 'academicYear must match the format YYYY-YYYY (e.g. "2024-2025").');
  } else {
    const [start, end] = body.academicYear.split('-').map(Number);
    if (end !== start + 1) {
      fail(errors, 'academicYear', 'academicYear end year must be start year + 1 (e.g. "2024-2025").');
    }
  }

  if (!body.semester) {
    fail(errors, 'semester', `semester is required. Must be one of: ${VALID_SEMESTERS.join(', ')}.`);
  } else if (!VALID_SEMESTERS.includes(body.semester)) {
    fail(errors, 'semester', `semester must be one of: ${VALID_SEMESTERS.join(', ')}.`);
  }
};

// ── MIDDLEWARE EXPORTS ────────────────────────────────────────────────────────

/**
 * Validates the body of POST /api/gaet/constraints (create or update).
 * academicYear + semester are required; constraint arrays are optional on update.
 */
const validateConstraintBody = (req, res, next) => {
  const errors = [];
  const { body } = req;

  validateAcademicContext(body, errors);

  if (body.timeSlots !== undefined)          validateTimeSlots(body.timeSlots, errors);
  if (body.courseRequirements !== undefined)  validateCourseRequirements(body.courseRequirements, errors);
  if (body.roomRegistry !== undefined)        validateRoomRegistry(body.roomRegistry, errors);
  if (body.teacherPreferences !== undefined)  validateTeacherPreferences(body.teacherPreferences, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

/**
 * Validates the body of POST /api/gaet/generate.
 * Only academicYear + semester needed — the constraint doc is fetched from DB.
 */
const validateGenerateBody = (req, res, next) => {
  const errors = [];
  validateAcademicContext(req.body, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
};

module.exports = { validateConstraintBody, validateGenerateBody };
