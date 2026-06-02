'use strict';

/**
 * @file gaet.engine.worker.js
 * @description CPU-bound timetable generation engine — runs in a worker_thread.
 *
 *  Receives:  workerData = { constraintId: string }
 *  Emits:     parentPort.postMessage({ status, sessions, report })
 *
 *  Algorithm — three phases:
 *    1. Sort course requirements by constraint density (most constrained first).
 *    2. Backtrack: for each session to place, try every (timeSlot × room) pair
 *       and verify all hard constraints. Tracks best partial on limit.
 *    3. Score soft constraints on the final assignment.
 *
 *  Guards:
 *    MAX_ITERATIONS = 50 000 iterations before falling back to best partial.
 *    MAX_DURATION_MS = 8 000 ms wall-clock timeout (same fallback).
 */

const { workerData, parentPort } = require('worker_threads');
const mongoose = require('mongoose');

const { timeRangesOverlap } = require('../utils/schedule.base');
const GaetConstraintModel  = require('../models/gaet-constraint.model');
const { ROOM_TYPE }        = GaetConstraintModel;

const MAX_ITERATIONS  = 50_000;
const MAX_DURATION_MS = 8_000;

// ─────────────────────────────────────────────
// PHASE 1 — CONSTRAINT DENSITY SORT
// ─────────────────────────────────────────────

/**
 * Sorts course requirements descending by constraint density so the
 * backtracker tackles the hardest placements first.
 *
 * Density heuristic:
 *   +3 per unavailable slot on the assigned teacher
 *   +10 if requiresLab (fewest rooms available)
 *   +hoursPerWeek (more hours → more sessions to spread)
 *   +2 per additional session needed beyond the first
 */
function sortByConstraintDensity(courseRequirements, constraint) {
  const prefMap = new Map(
    (constraint.teacherPreferences || []).map(p => [p.teacherId.toString(), p])
  );

  return [...courseRequirements].sort((a, b) => {
    const densityOf = (cr) => {
      let d = 0;
      const pref = prefMap.get(cr.teacherId.toString());
      if (pref) d += pref.unavailableSlots.length * 3;
      if (cr.requiresLab) d += 10;
      d += cr.hoursPerWeek;
      d += Math.ceil((cr.hoursPerWeek * 60) / cr.sessionDuration) * 2;
      return d;
    };
    return densityOf(b) - densityOf(a);
  });
}

// ─────────────────────────────────────────────
// PHASE 2 — HARD CONSTRAINT CHECK
// ─────────────────────────────────────────────

/**
 * Returns true when a candidate placement satisfies all hard constraints:
 *  1. Room capacity >= studentCount
 *  2. Room type: if requiresLab the room must be LAB
 *  3. Room not in its own unavailableSlots at that day/time
 *  4. Teacher not in their unavailableSlots at that day/time
 *  5. No teacher double-booking in already-placed sessions
 *  6. No room double-booking in already-placed sessions
 *  7. No class double-booking in already-placed sessions
 *
 * @param {{ crId, teacherId, classId, slot, roomName, room, cr }} candidate
 * @param {Array} assignment - Already-placed sessions (plain objects)
 * @param {Map} prefMap - teacherId string → TeacherPreference
 */
function isHardConstraintSatisfied(candidate, assignment, prefMap) {
  const { cr, teacherId, classId, slot, room } = candidate;
  const { day, startHour, endHour } = slot;

  if (room.capacity < cr.studentCount) return false;

  // requiresLab takes precedence; otherwise enforce explicit non-CLASSROOM room type.
  // CLASSROOM is the default — any room is acceptable for it (maximum scheduling flexibility).
  // LAB / AMPHITHEATER requirements are strict: only a matching room qualifies.
  const requiredRoomType = cr.requiresLab ? ROOM_TYPE.LAB : cr.roomType;
  if (requiredRoomType && requiredRoomType !== ROOM_TYPE.CLASSROOM && room.type !== requiredRoomType) return false;

  for (const us of (room.unavailableSlots || [])) {
    if (us.day === day && timeRangesOverlap(startHour, endHour, us.startHour, us.endHour)) return false;
  }

  const pref = prefMap.get(teacherId);
  if (pref) {
    for (const us of pref.unavailableSlots) {
      if (us.day === day && timeRangesOverlap(startHour, endHour, us.startHour, us.endHour)) return false;
    }
  }

  for (const placed of assignment) {
    if (placed.slot.day !== day) continue;
    if (!timeRangesOverlap(startHour, endHour, placed.slot.startHour, placed.slot.endHour)) continue;
    if (placed.teacherId === teacherId) return false;
    if (placed.roomName  === candidate.roomName) return false;
    if (placed.classId   === classId) return false;
  }

  return true;
}

// ─────────────────────────────────────────────
// PHASE 2 — BACKTRACK
// ─────────────────────────────────────────────

/**
 * Recursive backtracking solver.
 *
 * @param {Array}  allToPlace  - Flat list of { cr } objects (expanded from requirements)
 * @param {number} index       - Current position in allToPlace
 * @param {Array}  assignment  - Mutable array of placed sessions (modified in place)
 * @param {Object} constraint  - Lean GaetConstraint document
 * @param {Map}    prefMap     - teacherId string → TeacherPreference
 * @param {Object} state       - { iterations, startTime, bestAssignment }
 * @returns {boolean} true when all sessions are placed
 * @throws {Error} when MAX_ITERATIONS or MAX_DURATION_MS is exceeded
 */
function backtrack(allToPlace, index, assignment, constraint, prefMap, state) {
  if (index === allToPlace.length) return true; // All sessions placed — checked BEFORE guards

  if (state.iterations >= MAX_ITERATIONS)              throw new Error('MAX_ITERATIONS_REACHED');
  if (Date.now() - state.startTime >= MAX_DURATION_MS) throw new Error('MAX_DURATION_REACHED');

  state.iterations++;

  if (assignment.length > state.bestAssignment.length) {
    state.bestAssignment = assignment.map(a => ({ ...a }));
  }

  const { cr } = allToPlace[index];
  const sessionDurationHours = cr.sessionDuration / 60;

  for (const slot of constraint.timeSlots) {
    if (slot.isBreak) continue;

    const endHour = slot.startHour + sessionDurationHours;
    if (endHour > slot.endHour) continue;

    for (const room of constraint.roomRegistry) {
      const candidate = {
        crId:      cr._id.toString(),
        teacherId: cr.teacherId.toString(),
        classId:   cr.classId.toString(),
        preferMorning: cr.preferMorning,
        slot:      { day: slot.day, startHour: slot.startHour, endHour },
        roomName:  room.name,
        room,
        cr,
      };

      if (isHardConstraintSatisfied(candidate, assignment, prefMap)) {
        assignment.push(candidate);

        if (backtrack(allToPlace, index + 1, assignment, constraint, prefMap, state)) return true;

        assignment.pop();
      }
    }
  }

  return false;
}

// ─────────────────────────────────────────────
// PHASE 3 — SOFT CONSTRAINT SCORE
// ─────────────────────────────────────────────

/**
 * Scores the assignment against soft constraints. Returns 0–100.
 *
 * Soft constraints weighted equally:
 *   +1 per session placed on teacher's preferred day
 *   +1 per session where preferMorning=true and startHour < 12
 */
function scoreAssignment(assignment, constraint) {
  if (assignment.length === 0) return 0;

  const prefMap = new Map(
    (constraint.teacherPreferences || []).map(p => [p.teacherId.toString(), p])
  );

  let soft = 0;
  const maxSoft = assignment.length * 2;

  for (const placed of assignment) {
    const pref = prefMap.get(placed.teacherId);
    if (pref && pref.preferredDays.includes(placed.slot.day)) soft += 1;
    if (placed.preferMorning && placed.slot.startHour < 12)   soft += 1;
  }

  return Math.round((soft / maxSoft) * 100);
}

// ─────────────────────────────────────────────
// QUALITY REPORT
// ─────────────────────────────────────────────

function buildQualityReport(assignment, allToPlace, constraint, durationMs) {
  const totalSessions  = allToPlace.length;
  const placedSessions = assignment.length;

  const placedCrIds = new Set(assignment.map(a => a.crId));

  const unplacedCrIds = new Set(
    allToPlace
      .filter(({ cr }) => !placedCrIds.has(cr._id.toString()))
      .map(({ cr }) => cr._id.toString())
  );

  const crMap = new Map(constraint.courseRequirements.map(cr => [cr._id.toString(), cr]));

  const unplacedCourses = [...unplacedCrIds].map(id => ({
    courseRequirementRef: crMap.get(id)._id,
    reason: 'No valid slot/room combination found within constraints or iteration limit.',
  }));

  const hardPct  = totalSessions > 0 ? Math.round((placedSessions / totalSessions) * 100) : 0;
  const softScore = scoreAssignment(assignment, constraint);

  const roomCount     = constraint.roomRegistry.length;
  const usedRooms     = new Set(assignment.map(a => a.roomName)).size;
  const roomUtilPct   = roomCount > 0 ? Math.round((usedRooms / roomCount) * 100) : 0;

  return {
    score:                    Math.round((hardPct + softScore) / 2 * 10),
    hardConstraintsSatisfied: hardPct,
    softConstraintsSatisfied: softScore,
    roomUtilizationPct:       roomUtilPct,
    unplacedCourses,
    generationDurationMs:     durationMs,
  };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS:         10_000,
      maxPoolSize:              1,
    });

    const GaetConstraint = require('../models/gaet-constraint.model');
    const constraint = await GaetConstraint.findById(workerData.constraintId).lean();

    if (!constraint) {
      parentPort.postMessage({ status: 'FAILED', error: `GaetConstraint ${workerData.constraintId} not found`, sessions: [], report: null });
      return;
    }

    if (!constraint.courseRequirements?.length) {
      parentPort.postMessage({ status: 'FAILED', error: 'No course requirements defined.', sessions: [], report: null });
      return;
    }
    if (!constraint.timeSlots?.length) {
      parentPort.postMessage({ status: 'FAILED', error: 'No time slots defined.', sessions: [], report: null });
      return;
    }
    if (!constraint.roomRegistry?.length) {
      parentPort.postMessage({ status: 'FAILED', error: 'No rooms defined in registry.', sessions: [], report: null });
      return;
    }

    // Phase 1
    const sorted = sortByConstraintDensity(constraint.courseRequirements, constraint);

    const allToPlace = [];
    for (const cr of sorted) {
      const sessionsNeeded = Math.max(1, Math.ceil((cr.hoursPerWeek * 60) / cr.sessionDuration));
      for (let s = 0; s < sessionsNeeded; s++) {
        allToPlace.push({ cr });
      }
    }

    const prefMap = new Map(
      (constraint.teacherPreferences || []).map(p => [p.teacherId.toString(), p])
    );

    // Phase 2
    const startTime = Date.now();
    const state     = { iterations: 0, startTime, bestAssignment: [] };
    const assignment = [];
    let fullSuccess  = false;

    try {
      fullSuccess = backtrack(allToPlace, 0, assignment, constraint, prefMap, state);
    } catch (_) {
      // Iteration or time limit — fall through to bestAssignment
    }

    const finalAssignment = fullSuccess ? assignment : state.bestAssignment;
    const durationMs = Date.now() - startTime;

    let status;
    if (fullSuccess)                   status = 'GENERATED';
    else if (finalAssignment.length)   status = 'PARTIALLY_GENERATED';
    else                               status = 'FAILED';

    const sessions = finalAssignment.map(a => ({
      courseRequirementRef: a.cr._id,
      slot:     a.slot,
      roomName: a.roomName,
    }));

    const report = buildQualityReport(finalAssignment, allToPlace, constraint, durationMs);

    parentPort.postMessage({ status, sessions, report });
  } catch (err) {
    parentPort.postMessage({ status: 'FAILED', error: err.message, sessions: [], report: null });
  } finally {
    try { await mongoose.disconnect(); } catch (_) {}
  }
}

run();
