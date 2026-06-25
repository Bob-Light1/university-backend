'use strict';

/**
 * @file student.service.js — inter-module API of the student domain.
 *
 * Orchestration layer: composes the business filters/parameters then delegates
 * all persistence to student.repository (the only one touching the models).
 *
 * Exposed (per owned model):
 *
 *  Student:
 *   - entityConfig: GenericEntityController config (campus.controller).
 *   - validateStudentBelongsToCampus: multi-tenant guard (result.crud,
 *     student.attendance.controller).
 *   - countStudents: configurable counter (staff.readonly, mentor ×2,
 *     campus ×3, teacher.dashboard).
 *   - listStudentIds: ids of enrolled students per class (mentor.controller, result.crud).
 *   - listStudentsForStaff / ForMentor / ForCampusDashboard: paginated listings.
 *   - getStudentClassRef: a child's current class (parent.portal).
 *   - getStudentsCampusRefs: attachment validation (parent.crud).
 *   - getStudentForDocument: typed document generation (document.template).
 *   - getStudentProfileRef: transcript header (result.analytics).
 *   - listStudentsForExamEligibility: exam eligibility (exam.enrollment).
 *   - getStudentForPrint / listClassStudentsForCards / listClassStudentsForList /
 *     getStudentNamesByIds: academic prints (academic-print).
 *
 *  StudentSchedule:
 *   - resolveSessionParticipants / syncTeacherSchedule: session creation
 *     (gaet; delegates subject/class/teacher to the owner facades).
 *   - createScheduleSession: GAET generation.
 *   - listSessionsForClass: bounded query (parent.portal ×3, academic-print ×2).
 *   - updateAttendanceSummary / getSessionRoster: roll-call/roster (teacher.schedule).
 *   - upsert/updateStudentScheduleByReference: exam mirror (exam.schedule.helper).
 *
 *  StudentAttendance:
 *   - summarizeStudentAttendance: per-child summary (parent.portal ×2).
 *   - summarizeAttendanceTotals: campus/mentor totals (staff.readonly, mentor.readonly).
 *   - getAvgAbsenceRateForCampus: average absence rate (campus.controller).
 *   - listStudentAttendanceForParent / listAttendanceForStaff / ForMentor:
 *     paginated listings.
 *   - getStudentAttendanceStats: getStudentStats static (exam.enrollment).
 */

const mongoose = require('mongoose');
const studentRepo = require('./student.repository');

const entityConfig = require('./student.config');
const {
  resolveSessionParticipants,
  syncTeacherSchedule,
} = require('./student.schedule.helpers');

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a student belongs to a specific campus
 * @param {String} studentId - Student ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateStudentBelongsToCampus = async (studentId, campusId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(studentId) ||
        !mongoose.Types.ObjectId.isValid(campusId)) {
      return false;
    }

    const student = await studentRepo.findStudentCampusRef(studentId);
    if (!student) return false;

    return student.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating student campus:', error);
    return false;
  }
};

/**
 * Configurable student counter.
 * @param {{
 *   campusId?:        string|ObjectId,
 *   studentIds?:      Array,           - restricted to these _id
 *   studentClassIds?: Array,           - restricted to these classes (studentClass)
 *   status?:          string,          - exact value (e.g. 'active')
 *   excludeArchived?: boolean,         - status ≠ 'archived'
 *   createdSince?:    Date,
 * }} params
 * @returns {Promise<number>}
 */
const countStudents = ({ campusId, studentIds, studentClassIds, status, excludeArchived, createdSince } = {}) => {
  const filter = {};
  if (campusId)        filter.schoolCampus = campusId;
  if (studentIds)      filter._id          = { $in: studentIds };
  if (studentClassIds) filter.studentClass = { $in: studentClassIds };
  if (status)          filter.status       = status;
  else if (excludeArchived) filter.status  = { $ne: 'archived' };
  if (createdSince)    filter.createdAt    = { $gte: createdSince };
  return studentRepo.countStudents(filter);
};

/**
 * Ids of students enrolled in one or more classes (source of truth:
 * Student.studentClass, not Class.students[]).
 * @param {{classIds: Array, campusId: string|ObjectId, excludeArchived?: boolean}} params
 * @returns {Promise<Array<{_id}>>}
 */
const listStudentIds = ({ classIds, campusId, excludeArchived = false }) => {
  const filter = {
    studentClass: { $in: classIds },
    schoolCampus: campusId,
  };
  if (excludeArchived) filter.status = { $ne: 'archived' };
  return studentRepo.listStudentIds(filter);
};

/**
 * Sets the mentor back-reference on a set of campus-scoped students.
 * Used by mentor.controller to keep Student.mentor in sync with Mentor.students[].
 * @param {{studentIds: Array, mentorId: string|ObjectId, campusId: string|ObjectId}} params
 * @returns {Promise<{ modifiedCount: number }>}
 */
const assignMentor = ({ studentIds, mentorId, campusId }) =>
  studentRepo.setMentorForStudents(studentIds, mentorId, campusId);

/**
 * Clears the mentor back-reference for students currently linked to this mentor.
 * @param {{studentIds: Array, mentorId: string|ObjectId, campusId: string|ObjectId}} params
 * @returns {Promise<{ modifiedCount: number }>}
 */
const unassignMentor = ({ studentIds, mentorId, campusId }) =>
  studentRepo.clearMentorForStudents(studentIds, mentorId, campusId);

/**
 * Paginated listing of students for the staff portal (populated class,
 * alphabetical sort). `search` must already be escaped by the caller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForStaff = ({ campusId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForStaff(filter, { skip, limit: Number(limit) });
};

/**
 * Paginated listing of students assigned to a mentor. `search` must already be
 * escaped by the caller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForMentor = ({ studentIds, status, classId, search, page = 1, limit = 20 }) => {
  const filter = { _id: { $in: studentIds } };
  if (status)  filter.status = status;
  if (classId) filter.studentClass = classId;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForMentor(filter, { skip, limit: Number(limit) });
};

/**
 * Paginated listing of students for the campus dashboard (sorted by creation
 * date desc). `search` must already be escaped by the caller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForCampusDashboard = ({ campusId, classId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (classId) filter.studentClass = classId;
  if (status)  filter.status = status;
  if (search) {
    filter.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName:  { $regex: search, $options: 'i' } },
      { matricule: { $regex: search, $options: 'i' } },
      { email:     { $regex: search, $options: 'i' } },
    ];
  }
  const skip = (Number(page) - 1) * Number(limit);
  return studentRepo.paginateStudentsForCampusDashboard(filter, { skip, limit: Number(limit) });
};

/**
 * Current class reference of a student in a campus (parent portal).
 * @returns {Promise<{studentClass}|null>}
 */
const getStudentClassRef = (studentId, campusId) =>
  studentRepo.getStudentClassRef(studentId, campusId);

/**
 * Campus attachments of a list of students (parent ↔ children validation).
 * @returns {Promise<Array<{_id, schoolCampus}>>}
 */
const getStudentsCampusRefs = (studentIds) =>
  studentRepo.getStudentsCampusRefs(studentIds);

/**
 * Full student (lean) of a campus — typed document generation.
 * @returns {Promise<Object|null>}
 */
const getStudentForDocument = (studentId, campusId) =>
  studentRepo.getStudentForDocument(studentId, campusId);

/**
 * Minimal student profile (transcript header).
 * @returns {Promise<Object|null>}
 */
const getStudentProfileRef = (studentId) =>
  studentRepo.getStudentProfileRef(studentId);

/**
 * Students candidate for an exam session's eligibility.
 * NB: filters on `currentClass` (legacy field for exam eligibility),
 * not `studentClass` — behavior preserved as-is.
 * @param {{classIds: Array<string>, campusId?: string|ObjectId}} params
 * @returns {Promise<Array>} Mongoose documents (_id, currentClass)
 */
const listStudentsForExamEligibility = ({ classIds, campusId }) =>
  studentRepo.listStudentsForExamEligibility({ classIds, campusId });

/**
 * Student of a campus with the fields needed for prints (card,
 * enrollment certificate…).
 * @returns {Promise<Object|null>}
 */
const getStudentForPrint = (studentId, campusId) =>
  studentRepo.getStudentForPrint(studentId, campusId);

/**
 * Non-archived students of a class with the card fields (batch printing).
 * @returns {Promise<Array>}
 */
const listClassStudentsForCards = (classId, campusId) =>
  studentRepo.listClassStudentsForCards(classId, campusId);

/**
 * Non-archived students of a class, sorted, for the printed class list.
 * @returns {Promise<Array>}
 */
const listClassStudentsForList = (classId, campusId) =>
  studentRepo.listClassStudentsForList(classId, campusId);

/**
 * Names/matricules of a list of students of a campus (batch print targets).
 * @returns {Promise<Array<{_id, firstName, lastName, matricule}>>}
 */
const getStudentNamesByIds = (studentIds, campusId) =>
  studentRepo.getStudentNamesByIds(studentIds, campusId);

/**
 * Notification contact details of a batch of students (email/phone).
 * Consumed by notification emitters (result/exam) to enable the
 * email channel without them touching the Student model.
 * @returns {Promise<Array<{_id, email, phone}>>}
 */
const getStudentContacts = (studentIds) =>
  studentRepo.getStudentContactsByIds(studentIds);

/**
 * Contact details of a single student (convenience for unit emitters).
 * @returns {Promise<{_id, email, phone}|null>}
 */
const getStudentContact = async (studentId) => {
  const [contact] = await studentRepo.getStudentContactsByIds([studentId]);
  return contact || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a StudentSchedule session (GAET generation).
 * @param {Object} payload - full document (campus, schedule times, denormalized subject/teacher/classes…)
 * @returns {Promise<Object>} created document
 */
const createScheduleSession = (payload) => studentRepo.createScheduleSession(payload);

/**
 * Sessions of a class in a campus, bounded query.
 * @param {Object} params - see student.repository.listSessionsForClass
 * @returns {Promise<Array>}
 */
const listSessionsForClass = (params) => studentRepo.listSessionsForClass(params);

/**
 * Updates the roll-call summary of a StudentSchedule session (sync from the
 * TeacherSchedule roll-call).
 */
const updateAttendanceSummary = (studentScheduleId, summaryFields) =>
  studentRepo.updateAttendanceSummary(studentScheduleId, summaryFields);

/**
 * Roster (classes + expected headcount) of a session, classes populated.
 * @returns {Promise<{classes, expectedAttendees}|null>}
 */
const getSessionRoster = (studentScheduleId) =>
  studentRepo.getSessionRoster(studentScheduleId);

/**
 * Upsert of a StudentSchedule entry by reference (mirror of exam
 * sessions — EXAM-SS-* references).
 */
const upsertStudentScheduleByReference = (reference, fields) =>
  studentRepo.upsertStudentScheduleByReference(reference, fields);

/**
 * Update of a StudentSchedule entry by reference (status/schedule times
 * of a cancelled/postponed exam session).
 */
const updateStudentScheduleByReference = (reference, fields) =>
  studentRepo.updateStudentScheduleByReference(reference, fields);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attendance summary of a student (totals + rate computed by the caller).
 * @param {Object} params - see student.repository.summarizeStudentAttendance
 * @returns {Promise<Array>} aggregation result ([0] or empty)
 */
const summarizeStudentAttendance = (params) =>
  studentRepo.summarizeStudentAttendance(params);

/**
 * Attendance totals of a campus (or of a mentor's classes).
 * NB: the `status === 'present'` (string) comparison is legacy and
 * preserved as-is.
 * @param {{campusId: ObjectId, classIds?: Array}} params
 * @returns {Promise<Array<{total, present}>>}
 */
const summarizeAttendanceTotals = (params) =>
  studentRepo.summarizeAttendanceTotals(params);

/**
 * Average absence rate per student of a campus (campus dashboard aggregate).
 * @param {ObjectId} campusOid
 * @returns {Promise<Array<{avgAbsenceRate}>>}
 */
const getAvgAbsenceRateForCampus = (campusOid) =>
  studentRepo.getAvgAbsenceRateForCampus(campusOid);

/**
 * Paginated attendance record of a child (parent portal).
 * @returns {Promise<{records: Array, total: number}>}
 */
const listStudentAttendanceForParent = (params) =>
  studentRepo.listStudentAttendanceForParent(params);

/**
 * Attendance listing for the staff portal. The text status is translated into
 * a status/isLate/isJustified combination (legacy staff semantics).
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listAttendanceForStaff = ({ campusId, status, classId, studentId, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) {
    if      (status === 'present')  { filter.status = true;  filter.isLate = false; }
    else if (status === 'late')     { filter.isLate = true; }
    else if (status === 'excused')  { filter.status = false; filter.isJustified = true; }
    else if (status === 'absent')   { filter.status = false; filter.isJustified = { $ne: true }; }
  }
  if (classId)   filter.class   = classId;
  if (studentId) filter.student = studentId;
  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }
  return studentRepo.paginateAttendance(filter, { page, limit });
};

/**
 * Attendance listing for the mentor portal (status passed through as-is —
 * legacy mentor semantics, different from staff and preserved).
 * Authorization (assigned class/student) stays in the controller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listAttendanceForMentor = ({ campusId, classId, classIds, studentId, status, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (classId)               filter.class   = classId;
  else if (classIds?.length) filter.class   = { $in: classIds };
  if (studentId)             filter.student = studentId;
  if (status)                filter.status  = status;
  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }
  return studentRepo.paginateAttendance(filter, { page, limit });
};

/**
 * Attendance statistics of a student (getStudentStats static of the model).
 * Returns { attendanceRate: 100 } if the static does not exist — behavior
 * preserved from exam eligibility.
 */
const getStudentAttendanceStats = (studentId, academicYear, semester, scope) =>
  studentRepo.getStudentAttendanceStats(studentId, academicYear, semester, scope);

module.exports = {
  // Student
  entityConfig,
  validateStudentBelongsToCampus,
  countStudents,
  listStudentIds,
  assignMentor,
  unassignMentor,
  listStudentsForStaff,
  listStudentsForMentor,
  listStudentsForCampusDashboard,
  getStudentClassRef,
  getStudentsCampusRefs,
  getStudentForDocument,
  getStudentProfileRef,
  listStudentsForExamEligibility,
  getStudentForPrint,
  listClassStudentsForCards,
  listClassStudentsForList,
  getStudentNamesByIds,
  getStudentContacts,
  getStudentContact,

  // StudentSchedule
  resolveSessionParticipants,
  syncTeacherSchedule,
  createScheduleSession,
  listSessionsForClass,
  updateAttendanceSummary,
  getSessionRoster,
  upsertStudentScheduleByReference,
  updateStudentScheduleByReference,

  // StudentAttendance
  summarizeStudentAttendance,
  summarizeAttendanceTotals,
  getAvgAbsenceRateForCampus,
  listStudentAttendanceForParent,
  listAttendanceForStaff,
  listAttendanceForMentor,
  getStudentAttendanceStats,
};
