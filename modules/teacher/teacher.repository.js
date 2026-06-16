'use strict';

/**
 * @file teacher.repository.js — couche d'accès aux données du module teacher.
 *
 * SEUL fichier autorisé à toucher les 3 models possédés :
 *   - Teacher            (teacher.model)
 *   - TeacherSchedule    (teacher.schedule.model)
 *   - TeacherAttendance  (teacher.attend.model)
 *
 * Controllers, service inter-modules et config (hors `Model:` du
 * GenericEntityController) passent exclusivement par lui. Lectures `.lean()`
 * (ou `.lean({ virtuals: true })` là où la sortie historique exposait des
 * virtuals) ; écritures à hook via load→mutate→save, sinon opérateurs
 * atomiques. Les pipelines d'agrégation vivent ici ; l'appelant fournit le
 * `$match` déjà casté en ObjectId. Les filtres d'isolation campus sont
 * construits par l'appelant et passés tels quels.
 *
 * Exceptions assumées (restent hors repo) :
 *   - GenericEntityController / GenericBulkController : opèrent sur le Model
 *     fourni par teacher.config.js / teacher.controller (`Model: Teacher`).
 *   - shared/services/profile.service : opère sur le Model passé par
 *     teacher.profile.controller.
 *   - Statiques/méthodes d'instance des models (getTeacherStats, toggleStatus,
 *     detectTeacherConflicts, getTeacherCalendar…) : logique métier de la
 *     couche model, invoquée ICI.
 */

const Teacher           = require('./models/teacher.model');
const TeacherSchedule   = require('./models/teacher.schedule.model');
const TeacherAttendance = require('./models/teacher.attend.model');

const SAFE_STAFF = '-password -__v -contractSnapshot';

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — lectures de référence (service inter-modules)
// ─────────────────────────────────────────────────────────────────────────────

/** Rattachement campus d'un teacher (validation multi-tenant / cross-campus). */
const getTeacherCampusRef = (teacherId) =>
  Teacher.findById(teacherId).select('schoolCampus').lean();

/** Compte les teachers d'un campus parmi une liste d'ids. */
const countTeachersByIdsOnCampus = (teacherIds, campusId) =>
  Teacher.countDocuments({ _id: { $in: teacherIds }, schoolCampus: campusId });

/** Compte les teachers non archivés d'un campus (borne createdAt optionnelle). */
const countActiveTeachers = (campusId, { createdSince } = {}) =>
  Teacher.countDocuments({
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
    ...(createdSince ? { createdAt: { $gte: createdSince } } : {}),
  });

/** Compte les teachers non archivés d'un département (garde d'archivage). */
const countActiveInDepartment = (departmentId) =>
  Teacher.countDocuments({ department: departmentId, status: { $ne: 'archived' } });

/** Teacher complet (lean) d'un campus — fiche de paie. */
const getTeacherForPayslip = (teacherId, campusId) =>
  Teacher.findOne({ _id: teacherId, schoolCampus: campusId }).lean();

/** Référence dénormalisable d'un teacher actif d'un campus (forme teacher{}). */
const findActiveTeacherRef = (teacherId, campusId) =>
  Teacher.findOne({
    _id:          teacherId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  })
    .select('_id firstName lastName email matricule')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — listings paginés (service inter-modules)
// ─────────────────────────────────────────────────────────────────────────────

/** Listing staff : classes + subjects peuplés, tri alphabétique, virtuals. */
const paginateStaffTeachers = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Teacher.find(filter)
      .select(SAFE_STAFF)
      .populate('classes',  'className')
      .populate('subjects', 'subject_name subject_code')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Teacher.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Listing dashboard campus : tri par date de création desc, sans populate. */
const paginateCampusDashboardTeachers = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Teacher.find(filter)
      .select('-password -salary')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Teacher.countDocuments(filter),
  ]);
  return { docs, total };
};

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — écritures & accès controller (auth / suppression)
// ─────────────────────────────────────────────────────────────────────────────

/** Doc teacher pour login (mot de passe + department/subjects/campus peuplés). */
const findTeacherForLogin = (query) =>
  Teacher.findOne(query)
    .select('+password')
    .populate('department',   'name')
    .populate('subjects',     'subject_name')
    .populate('schoolCampus', 'campus_name');

/** MAJ atomique de lastLogin (n'exécute pas les hooks de save). */
const touchLastLogin = (id) =>
  Teacher.updateOne({ _id: id }, { $set: { lastLogin: new Date() } });

/** Doc teacher avec mot de passe (changement de mot de passe). */
const findTeacherByIdWithPassword = (id) =>
  Teacher.findById(id).select('+password');

/** Doc teacher complet par id (suppression définitive : besoin de profileImage). */
const findTeacherDocById = (id) => Teacher.findById(id);

/** Persiste un doc teacher (déclenche pre('validate')/pre('save')). */
const saveTeacherDoc = (doc) => doc.save();

/** Suppression définitive d'un teacher. */
const deleteTeacherById = (id) => Teacher.findByIdAndDelete(id);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — accès config GenericEntityController (session-aware)
// ─────────────────────────────────────────────────────────────────────────────

/** Unicité matricule dans un campus (validation de création, en session). */
const findTeacherByMatriculeInCampus = (matricule, campusId, { session } = {}) =>
  Teacher.findOne({ matricule, schoolCampus: campusId })
    .select('_id')
    .session(session ?? null)
    .lean();

/** Unicité matricule hors d'un id (validation de mise à jour). */
const findTeacherByMatriculeExcluding = (matricule, campusId, excludeId) =>
  Teacher.findOne({ matricule, schoolCampus: campusId, _id: { $ne: excludeId } })
    .select('_id')
    .lean();

/** Compteur de teachers d'un campus (génération de matricule, en session). */
const countTeachersInCampus = (campusId, { session } = {}) =>
  Teacher.countDocuments({ schoolCampus: campusId }).session(session ?? null);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — dashboard self-service
// ─────────────────────────────────────────────────────────────────────────────

/** Profil d'en-tête du dashboard (subjects/classes/department/campus peuplés). */
const findTeacherDashboardProfile = (teacherId) =>
  Teacher.findById(teacherId)
    .populate('subjects',     'subject_name subject_code')
    .populate('classes',      'className level')
    .populate('department',   'name')
    .populate('schoolCampus', 'campus_name')
    .lean({ virtuals: true });

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/** Compteur de sessions TeacherSchedule (génération de référence de miroir). */
const countTeacherSchedules = () => TeacherSchedule.countDocuments();

/**
 * Upsert du miroir TeacherSchedule d'une session StudentSchedule (clé :
 * studentScheduleRef). `reference` n'est écrite qu'à la création ($setOnInsert).
 */
const upsertTeacherScheduleMirror = (studentScheduleRef, setPayload, reference) =>
  TeacherSchedule.findOneAndUpdate(
    { studentScheduleRef },
    { $set: setPayload, $setOnInsert: { reference } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

/** Upsert d'une entrée TeacherSchedule par référence (miroir examens). */
const upsertTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/** MAJ d'une entrée TeacherSchedule par référence. */
const updateTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate({ reference }, { $set: fields });

/** Détection de double réservation d'un teacher (statique du model). */
const detectTeacherConflicts = (params) =>
  TeacherSchedule.detectTeacherConflicts(params);

/** Planning paginé du portail staff (subject/classes/teacher peuplés). */
const paginateStaffTeacherSchedules = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    TeacherSchedule.find(filter)
      .select('-__v')
      .populate('subject', 'subject_name subject_code')
      .populate('classes', 'className')
      .populate('teacher', 'firstName lastName')
      .sort({ startTime: 1 })
      .skip(skip).limit(limit).lean(),
    TeacherSchedule.countDocuments(filter),
  ]);
  return { docs, total };
};

// — dashboard (sessions PUBLISHED de l'enseignant) —

/** Sessions publiées du jour (tri startTime). */
const listTeacherTodaySessions = (teacherId, { gte, lte }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    status:    'PUBLISHED',
    isDeleted: false,
    startTime: { $gte: gte, $lte: lte },
  }).sort({ startTime: 1 }).lean();

/** Sessions publiées à venir (fenêtre exclusive début, limit). */
const listTeacherUpcomingSessions = (teacherId, { gt, lte, limit }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    status:    'PUBLISHED',
    isDeleted: false,
    startTime: { $gt: gt, $lte: lte },
  }).sort({ startTime: 1 }).limit(limit).lean();

/** Appels en retard : sessions publiées passées non soumises (limit). */
const listTeacherPendingRollCalls = (teacherId, { lt, limit }) =>
  TeacherSchedule.find({
    'teacher.teacherId':  teacherId,
    status:               'PUBLISHED',
    isDeleted:            false,
    startTime:            { $lt: lt },
    'rollCall.submitted': false,
  }).sort({ startTime: -1 }).limit(limit).lean();

/**
 * Charge horaire de l'année (agrégat dashboard). `teacherOid` déjà casté par
 * l'appelant.
 */
const aggregateTeacherWorkload = ({ teacherOid, academicYear }) =>
  TeacherSchedule.aggregate([
    {
      $match: {
        'teacher.teacherId': teacherOid,
        status:              'PUBLISHED',
        isDeleted:           false,
        academicYear,
      },
    },
    {
      $group: {
        _id:               null,
        totalSessions:     { $sum: 1 },
        deliveredSessions: { $sum: { $cond: ['$rollCall.submitted', 1, 0] } },
        scheduledMinutes:  { $sum: '$durationMinutes' },
        deliveredMinutes:  { $sum: { $cond: ['$rollCall.submitted', '$durationMinutes', 0] } },
      },
    },
  ]);

// — calendrier / workload (statiques du model) —

/** Calendrier de l'enseignant sur une fenêtre (statique du model). */
const getTeacherCalendar = (teacherId, start, end, opts) =>
  TeacherSchedule.getTeacherCalendar(teacherId, start, end, opts);

/** Résumé de charge horaire (statique du model). */
const getWorkloadSummary = (teacherId, periodLabel, periodType) =>
  TeacherSchedule.getWorkloadSummary(teacherId, periodLabel, periodType);

// — lectures / écritures de sessions (controller) —

/** Détail d'une session non supprimée (lecture, accès enseignant/admin). */
const findScheduleSessionLean = (id) =>
  TeacherSchedule.findOne({ _id: id, isDeleted: false }).lean();

/** Doc session non supprimée pour écriture (roll-call / report). */
const findScheduleSessionForWrite = (id) =>
  TeacherSchedule.findOne({ _id: id, isDeleted: false });

/** Doc session portant une demande de report donnée (review). */
const findScheduleByPostponementRequest = (requestId) =>
  TeacherSchedule.findOne({ 'postponementRequests._id': requestId, isDeleted: false });

/** Persiste un doc session (déclenche pre('save') : référence, durée…). */
const saveScheduleDoc = (doc) => doc.save();

/** Sessions d'un campus portant une demande de report d'un statut donné. */
const listSchedulesWithPostponements = (campusFilter, status) =>
  TeacherSchedule.find({
    ...campusFilter,
    'postponementRequests.status': status,
    isDeleted: false,
  })
    .select('reference teacher subject startTime endTime postponementRequests')
    .lean();

/** Doc profil de disponibilité de l'enseignant (écriture). */
const findAvailabilityProfileForWrite = (teacherId) =>
  TeacherSchedule.findOne({
    'teacher.teacherId': teacherId,
    studentScheduleRef:  null,
    sessionType:         { $exists: false },
    isDeleted:           false,
  });

/** Créneaux de disponibilité de l'enseignant (lecture projetée). */
const findAvailabilityProfile = (teacherId) =>
  TeacherSchedule.findOne(
    {
      'teacher.teacherId': teacherId,
      studentScheduleRef:  null,
      isDeleted:           false,
    },
    { availabilitySlots: 1 }
  ).lean();

/** Construit un nouveau doc TeacherSchedule (profil de disponibilité). */
const newTeacherScheduleDoc = (payload) => new TeacherSchedule(payload);

/** Overview paginé des sessions d'un enseignant (admin). Filtre composé amont. */
const paginateTeacherSessions = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    TeacherSchedule.find(filter)
      .sort({ startTime: 1 })
      .skip(skip).limit(limit).lean(),
    TeacherSchedule.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Rapport de charge horaire de tous les enseignants (agrégat, paie). */
const aggregateAllTeachersWorkload = (matchStage) =>
  TeacherSchedule.aggregate([
    { $match: matchStage },
    { $unwind: '$workloadSnapshots' },
    {
      $match: {
        'workloadSnapshots.periodLabel': matchStage['workloadSnapshots.periodLabel'],
        'workloadSnapshots.periodType':  matchStage['workloadSnapshots.periodType'],
      },
    },
    {
      $group: {
        _id:            '$teacher.teacherId',
        firstName:      { $first: '$teacher.firstName' },
        lastName:       { $first: '$teacher.lastName' },
        email:          { $first: '$teacher.email' },
        matricule:      { $first: '$teacher.matricule' },
        scheduledHours: { $sum: '$workloadSnapshots.scheduledHours' },
        deliveredHours: { $sum: '$workloadSnapshots.deliveredHours' },
        cancelledHours: { $sum: '$workloadSnapshots.cancelledHours' },
        contractHours:  { $max: '$workloadSnapshots.contractHours' },
      },
    },
    {
      $project: {
        firstName:      1,
        lastName:       1,
        email:          1,
        matricule:      1,
        scheduledHours: 1,
        deliveredHours: 1,
        cancelledHours: 1,
        contractHours:  1,
        deviation:      { $subtract: ['$deliveredHours', '$contractHours'] },
        completionRate: {
          $cond: [
            { $gt: ['$contractHours', 0] },
            {
              $round: [
                { $multiply: [{ $divide: ['$deliveredHours', '$contractHours'] }, 100] },
                1,
              ],
            },
            null,
          ],
        },
      },
    },
    { $sort: { lastName: 1 } },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER ATTENDANCE — écritures & lectures (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Doc record de présence existant pour une session/date (init : écriture). */
const findTeacherAttendanceForWrite = (filter) => TeacherAttendance.findOne(filter);

/** Crée un record de présence enseignant. */
const createTeacherAttendance = (payload) => TeacherAttendance.create(payload);

/** Persiste un doc record (déclenche les hooks de save). */
const saveAttendanceDoc = (doc) => doc.save();

/** Records de présence d'une session (teacher/replacement/class/schedule peuplés). */
const listSessionAttendanceRecords = (filter) =>
  TeacherAttendance.find(filter)
    .populate('teacher',            'firstName lastName email profileImage employmentType')
    .populate('replacementTeacher', 'firstName lastName email')
    .populate('class',              'className')
    .populate('schedule',           'startTime endTime')
    .sort({ attendanceDate: -1 })
    .lean();

/** Doc record de présence scopé (toggle / justification / replacement / paid). */
const findAttendanceRecordScoped = (filter) => TeacherAttendance.findOne(filter);

/** Verrouillage quotidien des présences (statique du model). */
const lockDailyTeacherAttendance = (targetDate, campusId) =>
  TeacherAttendance.lockDailyAttendance(targetDate, campusId);

/** Records de présence de l'enseignant connecté (schedule/class peuplés). */
const listMyAttendanceRecords = (filter) =>
  TeacherAttendance.find(filter)
    .populate('schedule', 'startTime endTime')
    .populate('class',    'className')
    .sort({ attendanceDate: -1 })
    .lean();

/** Stats de présence d'un enseignant (statique du model). */
const getTeacherAttendanceStats = (teacherId, academicYear, semester, period) =>
  TeacherAttendance.getTeacherStats(teacherId, academicYear, semester, period);

/** Stats de présence d'un campus (statique du model). */
const getCampusAttendanceStats = (campusId, date, period) =>
  TeacherAttendance.getCampusStats(campusId, date, period);

/** Rapport de paie (agrégat). L'appelant fournit le $match. */
const aggregatePayrollReport = (matchStage) =>
  TeacherAttendance.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:            '$teacher',
        totalSessions:  { $sum: 1 },
        totalMinutes:   { $sum: '$sessionDuration' },
        paidSessions:   { $sum: { $cond: ['$isPaid', 1, 0] } },
        unpaidSessions: { $sum: { $cond: [{ $not: '$isPaid' }, 1, 0] } },
      },
    },
    {
      $lookup: {
        from: 'teachers', localField: '_id', foreignField: '_id', as: 'teacherInfo',
      },
    },
    { $unwind: '$teacherInfo' },
    {
      $project: {
        teacherId:      '$_id',
        firstName:      '$teacherInfo.firstName',
        lastName:       '$teacherInfo.lastName',
        email:          '$teacherInfo.email',
        employmentType: '$teacherInfo.employmentType',
        totalSessions:  1,
        totalHours:     { $round: [{ $divide: ['$totalMinutes', 60] }, 2] },
        paidSessions:   1,
        unpaidSessions: 1,
      },
    },
    { $sort: { lastName: 1 } },
  ]);

/**
 * Overview de présence d'un campus (paginé + KPIs sur le périmètre complet).
 * `filter` = affichage ; `summaryFilter` = périmètre sans statut.
 */
const attendanceCampusOverview = async (filter, summaryFilter, { skip, limit }) => {
  const [records, total, presentCount] = await Promise.all([
    TeacherAttendance.find(filter)
      .populate('teacher',            'firstName lastName email employmentType')
      .populate('replacementTeacher', 'firstName lastName')
      .populate('schedule',           'startTime endTime')
      .populate('class',              'className')
      .sort({ attendanceDate: -1, sessionStartTime: 1 })
      .skip(skip).limit(limit).lean(),
    TeacherAttendance.countDocuments(summaryFilter),
    TeacherAttendance.countDocuments({ ...summaryFilter, status: true }),
  ]);
  return { records, total, presentCount };
};

/** Sessions d'un enseignant sur une journée (pending : sessions non pointées). */
const listTeacherSessionsForPending = ({ teacherId, dayStart, dayEnd, campusFilter }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    startTime: { $gte: dayStart, $lte: dayEnd },
    isDeleted: false,
    ...campusFilter,
  }).lean();

/** Ids des sessions déjà pointées (pending). */
const findRecordedScheduleIds = ({ teacher, scheduleIds, dayStart, dayEnd }) =>
  TeacherAttendance.find({
    teacher,
    schedule:       { $in: scheduleIds },
    attendanceDate: { $gte: dayStart, $lte: dayEnd },
  }).select('schedule').lean();

module.exports = {
  // Teacher — refs & lectures
  getTeacherCampusRef,
  countTeachersByIdsOnCampus,
  countActiveTeachers,
  countActiveInDepartment,
  getTeacherForPayslip,
  findActiveTeacherRef,
  // Teacher — listings paginés
  paginateStaffTeachers,
  paginateCampusDashboardTeachers,
  // Teacher — écritures & controller
  findTeacherForLogin,
  touchLastLogin,
  findTeacherByIdWithPassword,
  findTeacherDocById,
  saveTeacherDoc,
  deleteTeacherById,
  // Teacher — config (session-aware)
  findTeacherByMatriculeInCampus,
  findTeacherByMatriculeExcluding,
  countTeachersInCampus,
  // Teacher — dashboard
  findTeacherDashboardProfile,
  // TeacherSchedule
  countTeacherSchedules,
  upsertTeacherScheduleMirror,
  upsertTeacherScheduleByReference,
  updateTeacherScheduleByReference,
  detectTeacherConflicts,
  paginateStaffTeacherSchedules,
  listTeacherTodaySessions,
  listTeacherUpcomingSessions,
  listTeacherPendingRollCalls,
  aggregateTeacherWorkload,
  getTeacherCalendar,
  getWorkloadSummary,
  findScheduleSessionLean,
  findScheduleSessionForWrite,
  findScheduleByPostponementRequest,
  saveScheduleDoc,
  listSchedulesWithPostponements,
  findAvailabilityProfileForWrite,
  findAvailabilityProfile,
  newTeacherScheduleDoc,
  paginateTeacherSessions,
  aggregateAllTeachersWorkload,
  // TeacherAttendance
  findTeacherAttendanceForWrite,
  createTeacherAttendance,
  saveAttendanceDoc,
  listSessionAttendanceRecords,
  findAttendanceRecordScoped,
  lockDailyTeacherAttendance,
  listMyAttendanceRecords,
  getTeacherAttendanceStats,
  getCampusAttendanceStats,
  aggregatePayrollReport,
  attendanceCampusOverview,
  listTeacherSessionsForPending,
  findRecordedScheduleIds,
};
