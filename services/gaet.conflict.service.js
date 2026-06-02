'use strict';

/**
 * @file gaet.conflict.service.js
 * @description Stateless conflict-detection service for generated GAET timetables.
 *
 *  Analyses the `generatedSessions` array of a GaetConstraint document for:
 *    - TEACHER_DOUBLE_BOOKING : same teacher placed in two overlapping slots on the same day
 *    - ROOM_DOUBLE_BOOKING    : same room used in two overlapping slots on the same day
 *    - CLASS_DOUBLE_BOOKING   : same class scheduled in two overlapping slots on the same day
 *
 *  The backtracking engine prevents these by design, but this service provides an
 *  independent second-pass check before publication and powers the GET /conflicts route.
 */

const { timeRangesOverlap } = require('../utils/schedule.base');

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

/**
 * @typedef {Object} ConflictEntry
 * @property {'TEACHER_DOUBLE_BOOKING'|'ROOM_DOUBLE_BOOKING'|'CLASS_DOUBLE_BOOKING'} type
 * @property {string} day
 * @property {number} startHour
 * @property {string} [teacherId]  - for TEACHER conflicts
 * @property {string} [roomName]   - for ROOM conflicts
 * @property {string} [classId]    - for CLASS conflicts
 * @property {string} sessionA     - _id of first conflicting session
 * @property {string} sessionB     - _id of second conflicting session
 */

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const toStr = (v) => (v ? v.toString() : null);

// ─────────────────────────────────────────────
// DETECT CONFLICTS
// ─────────────────────────────────────────────

/**
 * Detects scheduling conflicts in an array of generated sessions.
 *
 * O(n²) over sessions — acceptable for the typical classroom timetable scale
 * (≤ 200 sessions per campus/semester).
 *
 * @param {Array} generatedSessions   - GaetConstraint.generatedSessions (lean or Mongoose docs)
 * @param {Array} courseRequirements  - GaetConstraint.courseRequirements  (lean or Mongoose docs)
 * @returns {ConflictEntry[]}
 */
const detectConflicts = (generatedSessions, courseRequirements) => {
  const crMap = new Map(
    courseRequirements.map(cr => [toStr(cr._id), cr])
  );

  const enriched = generatedSessions.map(s => ({
    id:        toStr(s._id),
    day:       s.slot.day,
    startHour: s.slot.startHour,
    endHour:   s.slot.endHour,
    roomName:  s.roomName,
    cr:        crMap.get(toStr(s.courseRequirementRef)) || null,
  }));

  const conflicts = [];

  for (let i = 0; i < enriched.length; i++) {
    const a = enriched[i];
    if (!a.cr) continue;

    for (let j = i + 1; j < enriched.length; j++) {
      const b = enriched[j];
      if (!b.cr) continue;
      if (a.day !== b.day) continue;
      if (!timeRangesOverlap(a.startHour, a.endHour, b.startHour, b.endHour)) continue;

      const teacherA = toStr(a.cr.teacherId);
      const teacherB = toStr(b.cr.teacherId);
      const classA   = toStr(a.cr.classId);
      const classB   = toStr(b.cr.classId);

      if (teacherA && teacherA === teacherB) {
        conflicts.push({
          type:      'TEACHER_DOUBLE_BOOKING',
          day:       a.day,
          startHour: a.startHour,
          teacherId: teacherA,
          sessionA:  a.id,
          sessionB:  b.id,
        });
      }

      if (a.roomName && a.roomName === b.roomName) {
        conflicts.push({
          type:      'ROOM_DOUBLE_BOOKING',
          day:       a.day,
          startHour: a.startHour,
          roomName:  a.roomName,
          sessionA:  a.id,
          sessionB:  b.id,
        });
      }

      if (classA && classA === classB) {
        conflicts.push({
          type:      'CLASS_DOUBLE_BOOKING',
          day:       a.day,
          startHour: a.startHour,
          classId:   classA,
          sessionA:  a.id,
          sessionB:  b.id,
        });
      }
    }
  }

  return conflicts;
};

// ─────────────────────────────────────────────
// SUMMARY HELPERS
// ─────────────────────────────────────────────

/**
 * Returns true when the generated timetable has no detected conflicts.
 * Convenience wrapper for the publish endpoint's pre-flight check.
 *
 * @param {Array} generatedSessions
 * @param {Array} courseRequirements
 * @returns {boolean}
 */
const hasNoConflicts = (generatedSessions, courseRequirements) =>
  detectConflicts(generatedSessions, courseRequirements).length === 0;

module.exports = { detectConflicts, hasNoConflicts };
