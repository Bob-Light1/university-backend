'use strict';

/**
 * @file teacher.service.js — Cross-module API of the teacher domain.
 *
 * Exposed:
 *   - validateTeacherBelongsToCampus : multi-tenant isolation guard
 *     (class.controller, teacher.attendance.controller).
 *   - countTeachersOnCampus          : bulk campus guard (gaet).
 *   - countActiveTeachers            : dashboard stats (campus, staff.readonly).
 *   - listTeachersForStaff           : staff portal listing (staff.readonly).
 *   - listTeachersForCampusDashboard : campus dashboard listing (campus.controller).
 *   - getTeacherForPayslip           : payslip generation (document.template).
 *   - getTeacherCampusRef            : cross-campus validation (exam.session).
 *   - resolveTeacherForSchedule      : denormalized teacher{} shape for schedules
 *     (student.schedule.helpers).
 *   - syncTeacherScheduleMirror      : upsert of the TeacherSchedule mirror of a
 *     StudentSchedule session (student.schedule.helpers).
 *   - listTeacherSchedulesForStaff   : staff portal planning (staff.readonly).
 *   - detectTeacherConflicts         : double-booking detection
 *     (student.schedule.controller).
 *   - upsert/updateTeacherScheduleByReference : mirror of exam sessions
 *     (exam.schedule.helper).
 *
 * All persistence goes through teacher.repository (step 0, pre-Postgres);
 * the service keeps the cross-module API and the building of business filters.
 */

const mongoose = require('mongoose');
const teacherRepo = require('./teacher.repository');

/**
 * Check if a teacher belongs to a specific campus
 * @param {String} teacherId - Teacher ID
 * @param {String} campusId - Campus ID
 * @returns {Promise<Boolean>}
 */
const validateTeacherBelongsToCampus = async (teacherId, campusId) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(teacherId) ||
        !mongoose.Types.ObjectId.isValid(campusId)) {
      return false;
    }

    const teacher = await teacherRepo.getTeacherCampusRef(teacherId);

    if (!teacher) {
      return false;
    }

    return teacher.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating teacher campus:', error);
    return false;
  }
};

/**
 * Compte les teachers appartenant à un campus parmi une liste d'ids.
 * @param {string[]} teacherIds
 * @param {string} campusId
 * @returns {Promise<number>}
 */
const countTeachersOnCampus = (teacherIds, campusId) =>
  teacherRepo.countTeachersByIdsOnCampus(teacherIds, campusId);

/**
 * Compte les teachers non archivés d'un campus.
 * @param {string|ObjectId} campusId
 * @param {{createdSince?: Date}} [opts] - borne basse optionnelle sur createdAt
 * @returns {Promise<number>}
 */
const countActiveTeachers = (campusId, opts) =>
  teacherRepo.countActiveTeachers(campusId, opts);

/**
 * Compte les teachers non archivés rattachés à un département (garde
 * d'archivage côté department.controller).
 * @param {string|ObjectId} departmentId
 * @returns {Promise<number>}
 */
const countActiveInDepartment = (departmentId) =>
  teacherRepo.countActiveInDepartment(departmentId);

/**
 * Paginated listing of teachers for the staff portal (populated classes +
 * subjects, alphabetical sort). `search` must already be escaped by the caller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeachersForStaff = ({ campusId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) {
    filter.status = status;
  } else {
    filter.status = { $ne: 'archived' };
  }
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { username: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  return teacherRepo.paginateStaffTeachers(filter, { skip, limit: Number(limit) });
};

/**
 * Paginated listing of teachers for the campus dashboard (sorted by creation
 * date desc, without populate). `search` must already be escaped.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeachersForCampusDashboard = ({ campusId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) {
    filter.status = status;
  } else {
    filter.status = { $ne: 'archived' };
  }
  if (search) {
    filter.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName:  { $regex: search, $options: 'i' } },
      { email:     { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  return teacherRepo.paginateCampusDashboardTeachers(filter, { skip, limit: Number(limit) });
};

/**
 * Teacher complet (lean) d'un campus — utilisé pour la fiche de paie.
 * @param {string} teacherId
 * @param {string|ObjectId} campusId
 * @returns {Promise<Object|null>}
 */
const getTeacherForPayslip = (teacherId, campusId) =>
  teacherRepo.getTeacherForPayslip(teacherId, campusId);

/**
 * Référence campus d'un teacher (validation cross-campus).
 * @param {string} teacherId
 * @returns {Promise<{_id, schoolCampus}|null>}
 */
const getTeacherCampusRef = (teacherId) =>
  teacherRepo.getTeacherCampusRef(teacherId);

/**
 * Resolves a teacherId string into the denormalised `teacher{}` shape
 * expected by StudentSchedule / TeacherSchedule models.
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
const resolveTeacherForSchedule = async (teacherId, campusId) => {
  if (!teacherId) return null;

  const doc = await teacherRepo.findActiveTeacherRef(teacherId, campusId);

  if (!doc) return null;

  return {
    teacherId: doc._id,
    firstName: doc.firstName,
    lastName:  doc.lastName,
    email:     doc.email     ?? '',
    matricule: doc.matricule ?? null,
  };
};

/**
 * Upserts the TeacherSchedule mirror document for a given StudentSchedule.
 *
 * Both collections share the same real-world session but serve different audiences.
 * This function must be called after every StudentSchedule create/update so both
 * views stay consistent.
 *
 * Non-fatal: errors are logged but never rethrown — the StudentSchedule write
 * already succeeded.
 *
 * @param {Object} ss      - Lean or Mongoose StudentSchedule document (.toObject())
 * @param {string} actorId - req.user.id of the person triggering the change
 */
const syncTeacherScheduleMirror = async (ss, actorId) => {
  try {
    const $setPayload = {
      studentScheduleRef: ss._id,
      schoolCampus:       ss.schoolCampus,
      status:             ss.status,
      academicYear:       ss.academicYear,
      semester:           ss.semester,
      sessionType:        ss.sessionType,
      startTime:          ss.startTime,
      endTime:            ss.endTime,
      durationMinutes:    ss.durationMinutes,
      isVirtual:          ss.isVirtual,
      room:               ss.room,
      virtualMeeting:     ss.virtualMeeting,
      subject:            ss.subject,
      teacher:            ss.teacher,
      classes:            ss.classes,
      recurrence:         ss.recurrence,
      isDeleted:          ss.isDeleted,
      deletedAt:          ss.deletedAt,
      publishedAt:        ss.publishedAt,
      publishedBy:        ss.publishedBy,
      lastModifiedBy:     actorId,
    };

    // CRITICAL: findOneAndUpdate with upsert does NOT trigger pre('save') hooks.
    // Generate reference manually in $setOnInsert so it is written once at creation
    // and never overwritten on subsequent updates (avoids E11000 on null unique index).
    const count = await teacherRepo.countTeacherSchedules();
    const reference = `TS-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;

    await teacherRepo.upsertTeacherScheduleMirror(ss._id, $setPayload, reference);
  } catch (err) {
    console.error('[syncTeacherSchedule] failed to sync TeacherSchedule:', err.message, err.code);
  }
};

/**
 * Paginated planning for the staff portal (populated subject/classes/teacher).
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeacherSchedulesForStaff = ({ campusId, status, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) {
    filter.status = status;
  } else {
    filter.status = { $in: ['PUBLISHED', 'DRAFT'] };
  }
  if (from || to) {
    filter.startTime = {};
    if (from) filter.startTime.$gte = new Date(from);
    if (to)   filter.startTime.$lte = new Date(to);
  }

  const skip = (Number(page) - 1) * Number(limit);
  return teacherRepo.paginateStaffTeacherSchedules(filter, { skip, limit: Number(limit) });
};

/**
 * Double-booking detection for a teacher (model static).
 * @param {{teacherId, startTime, endTime, excludeId?}} params
 * @returns {Promise<{hasConflict: boolean, conflicts: Array}>}
 */
const detectTeacherConflicts = (params) =>
  teacherRepo.detectTeacherConflicts(params);

/**
 * Upsert of a TeacherSchedule entry by reference (mirror of exam sessions
 * — EXAM-TS-* references).
 */
const upsertTeacherScheduleByReference = (reference, fields) =>
  teacherRepo.upsertTeacherScheduleByReference(reference, fields);

/**
 * Update of a TeacherSchedule entry by reference (status/times
 * of a cancelled/postponed exam session).
 */
const updateTeacherScheduleByReference = (reference, fields) =>
  teacherRepo.updateTeacherScheduleByReference(reference, fields);

module.exports = {
  validateTeacherBelongsToCampus,
  countTeachersOnCampus,
  countActiveTeachers,
  countActiveInDepartment,
  listTeachersForStaff,
  listTeachersForCampusDashboard,
  getTeacherForPayslip,
  getTeacherCampusRef,
  resolveTeacherForSchedule,
  syncTeacherScheduleMirror,
  listTeacherSchedulesForStaff,
  detectTeacherConflicts,
  upsertTeacherScheduleByReference,
  updateTeacherScheduleByReference,
};
