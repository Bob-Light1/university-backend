'use strict';

/**
 * @file scheduleHelpers.js
 * @description Shared utilities for schedule controllers.
 *
 * Why this file exists:
 *   Both studentSchedule.controller and teacherSchedule.controller need to:
 *     1. Resolve classIds[]  → classes[]  (fetch className + level from Class model)
 *     2. Resolve subjectId   → subject{}  (fetch subject_name, subject_code from Subject model)
 *     3. Resolve teacherId   → teacher{}  (fetch firstName, lastName, email from Teacher model)
 *
 *   Without this helper, these DB lookups were either duplicated or skipped entirely,
 *   leaving denormalised fields empty and breaking the schedule model's required shape.
 *
 * Campus-isolation contract:
 *   Every resolver enforces that the resolved document belongs to the given campusId.
 *   Any mismatch returns null, which the caller must treat as a 400/403 error.
 */

const mongoose = require('mongoose');

// Lazy-loaded to avoid circular dependency issues at module load time
const getClass   = () => require('../models/class.model');
const getSubject = () => require('../models/subject.model');
const getTeacher = () => require('../models/teacher-models/teacher.model');

// ─────────────────────────────────────────────────────────────────────────────
// CLASSES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves an array of classId strings into the denormalised `classes[]` shape
 * expected by StudentSchedule / TeacherSchedule models.
 *
 * Campus isolation: every class must belong to campusId.
 *
 * @param {string[]} classIds   - Array of ObjectId strings from the request body
 * @param {string}   campusId   - Campus to enforce
 * @returns {Promise<{
 *   classes: Array<{classId: ObjectId, className: string, level: ObjectId}>,
 *   invalid: string[]          - IDs that were not found or belong to another campus
 * }>}
 */
const resolveClasses = async (classIds, campusId) => {
  if (!classIds || classIds.length === 0) return { classes: [], invalid: [] };

  const Class = getClass();

  const docs = await Class.find({
    _id:          { $in: classIds },
    schoolCampus: campusId,          // campus-isolation guard
    status:       { $ne: 'archived' },
  })
    .select('_id className level')
    .lean();

  // Detect IDs that were submitted but not found (or belong to another campus)
  const foundIds  = new Set(docs.map((d) => d._id.toString()));
  const invalid   = classIds.filter((id) => !foundIds.has(id));

  const classes = docs.map((d) => ({
    classId:   d._id,
    className: d.className,
    level:     d.level ?? null,
  }));

  return { classes, invalid };
};

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a subjectId string into the denormalised `subject{}` shape.
 *
 * Campus isolation: subject must belong to campusId.
 *
 * @param {string} subjectId
 * @param {string} campusId
 * @returns {Promise<{
 *   subjectId:    ObjectId,
 *   subject_name: string,
 *   subject_code: string,
 *   coefficient:  number|null,
 *   department:   ObjectId|null
 * } | null>}  null if not found or campus mismatch
 */
const resolveSubject = async (subjectId, campusId) => {
  if (!subjectId) return null;

  const Subject = getSubject();

  const doc = await Subject.findOne({
    _id:          subjectId,
    schoolCampus: campusId,   // campus-isolation guard
    isActive:     true,
  })
    .select('_id subject_name subject_code coefficient department')
    .lean();

  if (!doc) return null;

  return {
    subjectId:    doc._id,
    subject_name: doc.subject_name,
    subject_code: doc.subject_code,
    coefficient:  doc.coefficient  ?? null,
    department:   doc.department   ?? null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a teacherId string into the denormalised `teacher{}` shape.
 *
 * Campus isolation: teacher must belong to campusId.
 *
 * @param {string} teacherId
 * @param {string} campusId
 * @returns {Promise<{
 *   teacherId: ObjectId,
 *   firstName: string,
 *   lastName:  string,
 *   email:     string,
 *   matricule: string|null
 * } | null>}  null if not found or campus mismatch
 */
const resolveTeacher = async (teacherId, campusId) => {
  if (!teacherId) return null;

  const Teacher = getTeacher();

  const doc = await Teacher.findOne({
    _id:          teacherId,
    schoolCampus: campusId,   // campus-isolation guard
    isArchived:   { $ne: true },
  })
    .select('_id firstName lastName email matricule')
    .lean();

  if (!doc) return null;

  return {
    teacherId: doc._id,
    firstName: doc.firstName,
    lastName:  doc.lastName,
    email:     doc.email     ?? '',
    matricule: doc.matricule ?? null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED RESOLVER (used by createSession / updateSession)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves all three participants at once in parallel.
 * Returns a structured result with errors array for the caller to handle.
 *
 * @param {{
 *   subjectId: string,
 *   teacherId: string,
 *   classIds:  string[]
 * }} ids
 * @param {string} campusId
 * @returns {Promise<{
 *   subject:  object|null,
 *   teacher:  object|null,
 *   classes:  object[],
 *   errors:   string[]    - Human-readable errors to send back as 400
 * }>}
 */
const resolveSessionParticipants = async ({ subjectId, teacherId, classIds }, campusId) => {
  const errors = [];

  const [subject, teacher, { classes, invalid }] = await Promise.all([
    resolveSubject(subjectId, campusId),
    resolveTeacher(teacherId, campusId),
    resolveClasses(classIds, campusId),
  ]);

  if (!subject) {
    errors.push(
      `Subject "${subjectId}" not found, inactive, or does not belong to this campus.`
    );
  }
  if (!teacher) {
    errors.push(
      `Teacher "${teacherId}" not found or does not belong to this campus.`
    );
  }
  if (invalid.length > 0) {
    errors.push(
      `The following class IDs are invalid or do not belong to this campus: ${invalid.join(', ')}.`
    );
  }
  if (classIds.length > 0 && classes.length === 0) {
    errors.push('No valid classes found for the provided classIds.');
  }

  return { subject, teacher, classes, errors };
};

module.exports = {
  resolveClasses,
  resolveSubject,
  resolveTeacher,
  resolveSessionParticipants,
};