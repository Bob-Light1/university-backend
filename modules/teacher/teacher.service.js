'use strict';

/**
 * @file teacher.service.js — API inter-modules du domaine teacher.
 *
 * Exposé :
 *   - validateTeacherBelongsToCampus : garde d'isolation multi-tenant
 *     (class.controller, teacher.attendance.controller).
 *   - countTeachersOnCampus          : garde campus en masse (gaet).
 *   - countActiveTeachers            : stats dashboards (campus, staff.readonly).
 *   - listTeachersForStaff           : listing portail staff (staff.readonly).
 *   - listTeachersForCampusDashboard : listing dashboard campus (campus.controller).
 *   - getTeacherForPayslip           : génération de fiche de paie (document.template).
 *   - getTeacherCampusRef            : validation cross-campus (exam.session).
 *   - resolveTeacherForSchedule      : forme dénormalisée teacher{} des emplois
 *     du temps (student.schedule.helpers).
 *   - syncTeacherScheduleMirror      : upsert du miroir TeacherSchedule d'une
 *     session StudentSchedule (student.schedule.helpers).
 *   - listTeacherSchedulesForStaff   : planning du portail staff (staff.readonly).
 *   - detectTeacherConflicts         : détection de double réservation
 *     (student.schedule.controller).
 *   - upsert/updateTeacherScheduleByReference : miroir des sessions d'examen
 *     (exam.schedule.helper).
 */

const mongoose = require('mongoose');
const Teacher = require('./models/teacher.model');
const TeacherSchedule = require('./models/teacher.schedule.model');

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

    const teacher = await Teacher.findById(teacherId);

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
  Teacher.countDocuments({ _id: { $in: teacherIds }, schoolCampus: campusId });

/**
 * Compte les teachers non archivés d'un campus.
 * @param {string|ObjectId} campusId
 * @param {{createdSince?: Date}} [opts] - borne basse optionnelle sur createdAt
 * @returns {Promise<number>}
 */
const countActiveTeachers = (campusId, { createdSince } = {}) =>
  Teacher.countDocuments({
    schoolCampus: campusId,
    status: { $ne: 'archived' },
    ...(createdSince ? { createdAt: { $gte: createdSince } } : {}),
  });

/**
 * Compte les teachers non archivés rattachés à un département (garde
 * d'archivage côté department.controller).
 * @param {string|ObjectId} departmentId
 * @returns {Promise<number>}
 */
const countActiveInDepartment = (departmentId) =>
  Teacher.countDocuments({ department: departmentId, status: { $ne: 'archived' } });

/**
 * Listing paginé des teachers pour le portail staff (classes + subjects
 * peuplés, tri alphabétique). `search` doit déjà être échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeachersForStaff = async ({ campusId, status, search, page = 1, limit = 20 }) => {
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
  const [docs, total] = await Promise.all([
    Teacher.find(filter)
      .select('-password -__v -contractSnapshot')
      .populate('classes',  'className')
      .populate('subjects', 'subject_name subject_code')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip).limit(Number(limit)).lean({ virtuals: true }),
    Teacher.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Listing paginé des teachers pour le dashboard campus (tri par date de
 * création desc, sans populate). `search` doit déjà être échappé.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeachersForCampusDashboard = async ({ campusId, status, search, page = 1, limit = 20 }) => {
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
  const [docs, total] = await Promise.all([
    Teacher.find(filter)
      .select('-password -salary')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Teacher.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Teacher complet (lean) d'un campus — utilisé pour la fiche de paie.
 * @param {string} teacherId
 * @param {string|ObjectId} campusId
 * @returns {Promise<Object|null>}
 */
const getTeacherForPayslip = (teacherId, campusId) =>
  Teacher.findOne({ _id: teacherId, schoolCampus: campusId }).lean();

/**
 * Référence campus d'un teacher (validation cross-campus).
 * @param {string} teacherId
 * @returns {Promise<{_id, schoolCampus}|null>}
 */
const getTeacherCampusRef = (teacherId) =>
  Teacher.findById(teacherId).select('schoolCampus').lean();

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

  const doc = await Teacher.findOne({
    _id:          teacherId,
    schoolCampus: campusId,   // campus-isolation guard
    status:       { $ne: 'archived' },
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
    const count = await TeacherSchedule.countDocuments();
    const reference = `TS-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;

    await TeacherSchedule.findOneAndUpdate(
      { studentScheduleRef: ss._id },
      {
        $set:         $setPayload,
        $setOnInsert: { reference },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error('[syncTeacherSchedule] failed to sync TeacherSchedule:', err.message, err.code);
  }
};

/**
 * Planning paginé du portail staff (subject/classes/teacher peuplés).
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listTeacherSchedulesForStaff = async ({ campusId, status, from, to, page = 1, limit = 20 }) => {
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
  const [docs, total] = await Promise.all([
    TeacherSchedule.find(filter)
      .select('-__v')
      .populate('subject', 'subject_name subject_code')
      .populate('classes', 'className')
      .populate('teacher', 'firstName lastName')
      .sort({ startTime: 1 })
      .skip(skip).limit(Number(limit)).lean(),
    TeacherSchedule.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Détection de double réservation d'un teacher (statique du model).
 * @param {{teacherId, startTime, endTime, excludeId?}} params
 * @returns {Promise<{hasConflict: boolean, conflicts: Array}>}
 */
const detectTeacherConflicts = (params) =>
  TeacherSchedule.detectTeacherConflicts(params);

/**
 * Upsert d'une entrée TeacherSchedule par référence (miroir des sessions
 * d'examen — références EXAM-TS-*).
 */
const upsertTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/**
 * Mise à jour d'une entrée TeacherSchedule par référence (statut/horaires
 * d'une session d'examen annulée/reportée).
 */
const updateTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate({ reference }, { $set: fields });

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
