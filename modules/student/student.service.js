'use strict';

/**
 * @file student.service.js — API inter-modules du domaine student.
 *
 * Exposé (par modèle possédé) :
 *
 *  Student :
 *   - entityConfig : config GenericEntityController (campus.controller).
 *   - validateStudentBelongsToCampus : garde multi-tenant (result.crud,
 *     student.attendance.controller).
 *   - countStudents : compteur paramétrable (staff.readonly, mentor ×2,
 *     campus ×3, teacher.dashboard).
 *   - listStudentIds : ids des inscrits par classe (mentor.controller, result.crud).
 *   - listStudentsForStaff / ForMentor / ForCampusDashboard : listings paginés.
 *   - getStudentClassRef : classe courante d'un enfant (parent.portal).
 *   - getStudentsCampusRefs : validation de rattachement (parent.crud).
 *   - getStudentForDocument : génération de documents typés (document.template).
 *   - getStudentProfileRef : en-tête de relevé (result.analytics).
 *   - listStudentsForExamEligibility : éligibilité examens (exam.enrollment).
 *   - getStudentForPrint / listClassStudentsForCards / listClassStudentsForList /
 *     getStudentNamesByIds : impressions académiques (academic-print).
 *
 *  StudentSchedule :
 *   - resolveSessionParticipants / syncTeacherSchedule : création de sessions
 *     (gaet ; délègue subject/class/teacher aux façades propriétaires).
 *   - createScheduleSession : génération GAET.
 *   - listSessionsForClass : requête bornée (parent.portal ×3, academic-print ×2).
 *   - updateAttendanceSummary / getSessionRoster : appel/roster (teacher.schedule).
 *   - upsert/updateStudentScheduleByReference : miroir examens (exam.schedule.helper).
 *
 *  StudentAttendance :
 *   - summarizeStudentAttendance : résumé par enfant (parent.portal ×2).
 *   - summarizeAttendanceTotals : totaux campus/mentor (staff.readonly, mentor.readonly).
 *   - getAvgAbsenceRateForCampus : taux d'absence moyen (campus.controller).
 *   - listStudentAttendanceForParent / listAttendanceForStaff / ForMentor :
 *     listings paginés.
 *   - getStudentAttendanceStats : statique getStudentStats (exam.enrollment).
 */

const mongoose = require('mongoose');
const Student = require('./models/student.model');
const StudentSchedule = require('./models/student.schedule.model');
const StudentAttendance = require('./models/student.attend.model');

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

    const student = await Student.findById(studentId);

    if (!student) {
      return false;
    }

    return student.schoolCampus.toString() === campusId.toString();
  } catch (error) {
    console.error('Error validating student campus:', error);
    return false;
  }
};

/**
 * Compteur de students paramétrable.
 * @param {{
 *   campusId?:        string|ObjectId,
 *   studentIds?:      Array,           - restreint à ces _id
 *   studentClassIds?: Array,           - restreint à ces classes (studentClass)
 *   status?:          string,          - valeur exacte (ex. 'active')
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
  return Student.countDocuments(filter);
};

/**
 * Ids des students inscrits dans une ou plusieurs classes (source de vérité :
 * Student.studentClass, pas Class.students[]).
 * @param {{classIds: Array, campusId: string|ObjectId, excludeArchived?: boolean}} params
 * @returns {Promise<Array<{_id}>>}
 */
const listStudentIds = ({ classIds, campusId, excludeArchived = false }) => {
  const filter = {
    studentClass: { $in: classIds },
    schoolCampus: campusId,
  };
  if (excludeArchived) filter.status = { $ne: 'archived' };
  return Student.find(filter, { _id: 1 }).lean();
};

/**
 * Listing paginé des students pour le portail staff (classe peuplée, tri
 * alphabétique). `search` doit déjà être échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForStaff = async ({ campusId, status, search, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .select('-password -__v')
      .populate('studentClass', 'className')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip).limit(Number(limit)).lean({ virtuals: true }),
    Student.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Listing paginé des students assignés à un mentor. `search` doit déjà être
 * échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForMentor = async ({ studentIds, status, classId, search, page = 1, limit = 20 }) => {
  const filter = { _id: { $in: studentIds } };
  if (status)  filter.status = status;
  if (classId) filter.studentClass = classId;
  if (search) {
    const rx = new RegExp(search, 'i');
    filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { matricule: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .select('-password -__v')
      .populate('studentClass', 'className')
      .populate('schoolCampus', 'campus_name')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip)
      .limit(Number(limit))
      .lean({ virtuals: true }),
    Student.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Listing paginé des students pour le dashboard campus (tri par date de
 * création desc). `search` doit déjà être échappé par l'appelant.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listStudentsForCampusDashboard = async ({ campusId, classId, status, search, page = 1, limit = 20 }) => {
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
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .populate('studentClass', 'className')
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    Student.countDocuments(filter),
  ]);

  return { docs, total };
};

/**
 * Référence de classe courante d'un student d'un campus (portail parent).
 * @returns {Promise<{studentClass}|null>}
 */
const getStudentClassRef = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('studentClass')
    .lean();

/**
 * Rattachements campus d'une liste de students (validation parent ↔ enfants).
 * @returns {Promise<Array<{_id, schoolCampus}>>}
 */
const getStudentsCampusRefs = (studentIds) =>
  Student.find({ _id: { $in: studentIds } })
    .select('_id schoolCampus')
    .lean();

/**
 * Student complet (lean) d'un campus — génération de documents typés.
 * @returns {Promise<Object|null>}
 */
const getStudentForDocument = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId }).lean();

/**
 * Profil minimal d'un student (en-tête de relevé de notes).
 * @returns {Promise<Object|null>}
 */
const getStudentProfileRef = (studentId) =>
  Student.findById(studentId)
    .select('firstName lastName matricule email schoolCampus studentClass')
    .lean();

/**
 * Students candidats à l'éligibilité d'une session d'examen.
 * NB : filtre sur `currentClass` (champ historique de l'éligibilité examens),
 * pas `studentClass` — comportement préservé tel quel.
 * @param {{classIds: Array<string>, campusId?: string|ObjectId}} params
 * @returns {Promise<Array>} documents Mongoose (_id, currentClass)
 */
const listStudentsForExamEligibility = ({ classIds, campusId }) =>
  Student.find({
    currentClass: { $in: classIds },
    schoolCampus: campusId || { $exists: true },
    status:       { $ne: 'archived' },
  }).select('_id currentClass');

/**
 * Student d'un campus avec les champs nécessaires aux impressions (carte,
 * certificat de scolarité…).
 * @returns {Promise<Object|null>}
 */
const getStudentForPrint = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('firstName lastName matricule profileImage dateOfBirth gender studentClass cardNumber cardValidUntil')
    .lean();

/**
 * Students non archivés d'une classe avec les champs cartes (impression en lot).
 * @returns {Promise<Array>}
 */
const listClassStudentsForCards = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule profileImage dateOfBirth gender cardNumber cardValidUntil')
    .lean();

/**
 * Students non archivés d'une classe, triés, pour la liste de classe imprimée.
 * @returns {Promise<Array>}
 */
const listClassStudentsForList = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule dateOfBirth gender status')
    .sort({ lastName: 1, firstName: 1 })
    .lean();

/**
 * Noms/matricules d'une liste de students d'un campus (cibles de lot d'impression).
 * @returns {Promise<Array<{_id, firstName, lastName, matricule}>>}
 */
const getStudentNamesByIds = (studentIds, campusId) =>
  Student.find({ _id: { $in: studentIds }, schoolCampus: campusId })
    .select('firstName lastName matricule')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée une session StudentSchedule (génération GAET).
 * @param {Object} payload - document complet (campus, horaires, subject/teacher/classes dénormalisés…)
 * @returns {Promise<Object>} document créé
 */
const createScheduleSession = (payload) => StudentSchedule.create(payload);

/**
 * Sessions d'une classe d'un campus, requête bornée.
 * @param {{
 *   classId:          string|ObjectId,
 *   campusId:         string|ObjectId,
 *   statuses?:        string[],            - défaut ['PUBLISHED']
 *   from?:            Date, to?: Date,     - bornes sur startTime ($gte / $lte)
 *   toExclusive?:     Date,                - borne haute exclusive ($lt) — impressions
 *   isDeletedFilter?: *,                   - défaut false ; academic-print passe {$ne:true}
 *   select?:          string,
 *   sort?:            Object|null,         - défaut { startTime: 1 } ; null = pas de tri
 *   limit?:           number,
 *   leanVirtuals?:    boolean,
 * }} params
 * @returns {Promise<Array>}
 */
const listSessionsForClass = ({
  classId,
  campusId,
  statuses = ['PUBLISHED'],
  from,
  to,
  toExclusive,
  isDeletedFilter = false,
  select,
  sort = { startTime: 1 },
  limit,
  leanVirtuals = false,
}) => {
  const filter = {
    'classes.classId': classId,
    schoolCampus:      campusId,
    status:            statuses.length === 1 ? statuses[0] : { $in: statuses },
    isDeleted:         isDeletedFilter,
  };
  if (from || to || toExclusive) {
    filter.startTime = {};
    if (from)        filter.startTime.$gte = from;
    if (to)          filter.startTime.$lte = to;
    if (toExclusive) filter.startTime.$lt  = toExclusive;
  }

  let q = StudentSchedule.find(filter);
  if (select) q = q.select(select);
  if (sort)   q = q.sort(sort);
  if (limit)  q = q.limit(limit);
  return leanVirtuals ? q.lean({ virtuals: true }) : q.lean();
};

/**
 * Met à jour le résumé d'appel d'une session StudentSchedule (sync depuis le
 * roll-call TeacherSchedule). Retourne la promesse — l'appelant peut la traiter
 * en fire-and-forget.
 */
const updateAttendanceSummary = (studentScheduleId, summaryFields) =>
  StudentSchedule.findByIdAndUpdate(studentScheduleId, summaryFields).exec();

/**
 * Roster (classes + effectif attendu) d'une session, classes peuplées.
 * @returns {Promise<{classes, expectedAttendees}|null>}
 */
const getSessionRoster = (studentScheduleId) =>
  StudentSchedule.findById(studentScheduleId)
    .select('classes expectedAttendees')
    .populate('classes.classId', 'className students')
    .lean();

/**
 * Upsert d'une entrée StudentSchedule par référence (miroir des sessions
 * d'examen — références EXAM-SS-*).
 */
const upsertStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/**
 * Mise à jour d'une entrée StudentSchedule par référence (statut/horaires
 * d'une session d'examen annulée/reportée).
 */
const updateStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate({ reference }, { $set: fields });

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résumé de présence d'un student (totaux + taux calculé par l'appelant).
 * @param {{
 *   studentId: string|ObjectId, campusId: string|ObjectId,
 *   academicYear?: string, semester?: string, status?: boolean,
 *   includeJustified?: boolean - ajoute justifiedAbsences au groupement
 * }} params
 * @returns {Promise<Array>} résultat d'agrégation ([0] ou vide)
 */
const summarizeStudentAttendance = ({ studentId, campusId, academicYear, semester, status, includeJustified = false }) => {
  const match = {
    student:      new mongoose.Types.ObjectId(String(studentId)),
    schoolCampus: new mongoose.Types.ObjectId(String(campusId)),
  };
  if (academicYear)        match.academicYear = academicYear;
  if (semester)            match.semester     = semester;
  if (status !== undefined) match.status      = status;

  const group = {
    _id:           null,
    totalSessions: { $sum: 1 },
    presentCount:  { $sum: { $cond: [{ $eq: ['$status', true]  }, 1, 0] } },
    absentCount:   { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
  };
  if (includeJustified) {
    group.justifiedAbsences = { $sum: { $cond: ['$isJustified', 1, 0] } };
  }

  return StudentAttendance.aggregate([{ $match: match }, { $group: group }]);
};

/**
 * Totaux présence d'un campus (ou des classes d'un mentor).
 * NB : la comparaison `status === 'present'` (chaîne) est historique et
 * préservée telle quelle.
 * @param {{campusId: ObjectId, classIds?: Array}} params
 * @returns {Promise<Array<{total, present}>>}
 */
const summarizeAttendanceTotals = ({ campusId, classIds }) => {
  const match = { schoolCampus: campusId };
  if (classIds) match.class = { $in: classIds };
  return StudentAttendance.aggregate([
    { $match: match },
    {
      $group: {
        _id:     null,
        total:   { $sum: 1 },
        present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
      },
    },
  ]);
};

/**
 * Taux d'absence moyen par student d'un campus (agrégat dashboard campus).
 * @param {ObjectId} campusOid
 * @returns {Promise<Array<{avgAbsenceRate}>>}
 */
const getAvgAbsenceRateForCampus = (campusOid) =>
  StudentAttendance.aggregate([
    { $match: { schoolCampus: campusOid } },
    {
      $group: {
        _id:           '$student',
        totalSessions: { $sum: 1 },
        absentCount:   { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id:            null,
        avgAbsenceRate: {
          $avg: {
            $multiply: [{ $divide: ['$absentCount', '$totalSessions'] }, 100],
          },
        },
      },
    },
  ]);

/**
 * Relevé de présence paginé d'un enfant (portail parent).
 * @returns {Promise<{records: Array, total: number}>}
 */
const listStudentAttendanceForParent = async ({ studentId, campusId, academicYear, semester, status, skip = 0, limit = 20 }) => {
  const filter = {
    student:      studentId,
    schoolCampus: campusId,
  };
  if (academicYear)         filter.academicYear = academicYear;
  if (semester)             filter.semester     = semester;
  if (status !== undefined) filter.status       = status;

  const [records, total] = await Promise.all([
    StudentAttendance.find(filter)
      .select('-__v')
      .populate('subject',   'subject_name')
      .populate('recordedBy','firstName lastName')
      .sort({ attendanceDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    StudentAttendance.countDocuments(filter),
  ]);

  return { records, total };
};

/** Requête commune des listings de présence (staff / mentor). */
const findAttendancePage = async (filter, page, limit) => {
  const skip = (Number(page) - 1) * Number(limit);
  const [docs, total] = await Promise.all([
    StudentAttendance.find(filter)
      .select('-__v')
      .populate('student', 'firstName lastName matricule profileImage')
      .populate('class',   'className')
      .sort({ attendanceDate: -1 })
      .skip(skip).limit(Number(limit)).lean(),
    StudentAttendance.countDocuments(filter),
  ]);
  return { docs, total };
};

/**
 * Listing de présence du portail staff. Le statut texte est traduit en
 * combinaison status/isLate/isJustified (sémantique historique du staff).
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
  return findAttendancePage(filter, page, limit);
};

/**
 * Listing de présence du portail mentor (statut transmis tel quel —
 * sémantique historique du mentor, différente du staff et préservée).
 * L'autorisation (classe/student assignés) reste dans le controller.
 * @returns {Promise<{docs: Array, total: number}>}
 */
const listAttendanceForMentor = ({ campusId, classId, classIds, studentId, status, from, to, page = 1, limit = 20 }) => {
  const filter = { schoolCampus: campusId };
  if (classId)            filter.class   = classId;
  else if (classIds?.length) filter.class = { $in: classIds };
  if (studentId)          filter.student = studentId;
  if (status)             filter.status  = status;
  if (from || to) {
    filter.attendanceDate = {};
    if (from) filter.attendanceDate.$gte = new Date(from);
    if (to)   filter.attendanceDate.$lte = new Date(to);
  }
  return findAttendancePage(filter, page, limit);
};

/**
 * Statistiques de présence d'un student (statique getStudentStats du model).
 * Retourne { attendanceRate: 100 } si la statique n'existe pas — comportement
 * préservé de l'éligibilité examens.
 */
const getStudentAttendanceStats = (studentId, academicYear, semester, scope) =>
  StudentAttendance.getStudentStats
    ? StudentAttendance.getStudentStats(studentId, academicYear, semester, scope)
    : Promise.resolve({ attendanceRate: 100 });

module.exports = {
  // Student
  entityConfig,
  validateStudentBelongsToCampus,
  countStudents,
  listStudentIds,
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
