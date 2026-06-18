'use strict';

/**
 * @file student.repository.js — couche d'accès aux données du module student.
 *
 * SEUL fichier autorisé à toucher les 3 models possédés :
 *   - Student            (student.model)
 *   - StudentSchedule    (student.schedule.model)
 *   - StudentAttendance  (student.attend.model)
 *
 * Controllers, service inter-modules et config (hors `Model:` du
 * GenericEntityController) passent exclusivement par lui. Lectures `.lean()`
 * (ou `.lean({ virtuals: true })` là où la sortie historique exposait des
 * virtuals comme `fullName`) ; écritures à hook via load→mutate→save, sinon
 * opérateurs atomiques. Les pipelines d'agrégation vivent ici ; l'appelant
 * fournit le `$match` déjà casté en ObjectId. Les filtres d'isolation campus
 * sont construits par l'appelant et passés tels quels.
 *
 * Exceptions assumées (restent hors repo) :
 *   - GenericEntityController / GenericBulkController : opèrent sur le Model
 *     fourni par student.config.js (`Model: Student`).
 *   - shared/services/profile.service : opère sur le Model passé par
 *     student.profile.controller.
 *   - Statiques/méthodes d'instance des models (getStudentStats, toggleStatus,
 *     detectConflicts…) : logique métier de la couche model, invoquée ICI.
 */

const mongoose          = require('mongoose');
const Student           = require('./models/student.model');
const StudentSchedule   = require('./models/student.schedule.model');
const StudentAttendance = require('./models/student.attend.model');

const SAFE = '-password -__v';
const toOid = (id) => new mongoose.Types.ObjectId(String(id));

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — lectures de référence (service inter-modules)
// ─────────────────────────────────────────────────────────────────────────────

/** Rattachement campus d'un student (validation multi-tenant). */
const findStudentCampusRef = (studentId) =>
  Student.findById(studentId).select('schoolCampus').lean();

/** Compteur paramétrable. L'appelant fournit le filtre déjà composé. */
const countStudents = (filter) => Student.countDocuments(filter);

/** Ids des inscrits (source de vérité : Student.studentClass). */
const listStudentIds = (filter) => Student.find(filter, { _id: 1 }).lean();

/** Référence de classe courante d'un student d'un campus. */
const getStudentClassRef = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('studentClass')
    .lean();

/** Rattachements campus d'une liste de students. */
const getStudentsCampusRefs = (studentIds) =>
  Student.find({ _id: { $in: studentIds } })
    .select('_id schoolCampus')
    .lean();

/** Student complet (lean) d'un campus — génération de documents typés. */
const getStudentForDocument = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId }).lean();

/** Profil minimal d'un student (en-tête de relevé de notes). */
const getStudentProfileRef = (studentId) =>
  Student.findById(studentId)
    .select('firstName lastName matricule email schoolCampus studentClass')
    .lean();

/**
 * Students candidats à l'éligibilité examens (documents Mongoose, champ
 * historique `currentClass`).
 */
const listStudentsForExamEligibility = ({ classIds, campusId }) =>
  Student.find({
    currentClass: { $in: classIds },
    schoolCampus: campusId || { $exists: true },
    status:       { $ne: 'archived' },
  }).select('_id currentClass');

/** Student d'un campus avec les champs d'impression (carte/certificat). */
const getStudentForPrint = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('firstName lastName matricule profileImage dateOfBirth gender studentClass cardNumber cardValidUntil')
    .lean();

/** Students non archivés d'une classe avec les champs cartes (impression lot). */
const listClassStudentsForCards = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule profileImage dateOfBirth gender cardNumber cardValidUntil')
    .lean();

/** Students non archivés d'une classe, triés, pour la liste imprimée. */
const listClassStudentsForList = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule dateOfBirth gender status')
    .sort({ lastName: 1, firstName: 1 })
    .lean();

/** Noms/matricules d'une liste de students d'un campus. */
const getStudentNamesByIds = (studentIds, campusId) =>
  Student.find({ _id: { $in: studentIds }, schoolCampus: campusId })
    .select('firstName lastName matricule')
    .lean();

/** Coordonnées de notification (email/téléphone) d'un lot d'étudiants. */
const getStudentContactsByIds = (studentIds) =>
  Student.find({ _id: { $in: studentIds } })
    .select('email phone')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — listings paginés (service inter-modules)
// ─────────────────────────────────────────────────────────────────────────────

/** Listing staff : classe peuplée, tri alphabétique, virtuals. */
const paginateStudentsForStaff = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .select(SAFE)
      .populate('studentClass', 'className')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Student.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Listing mentor : classe + campus peuplés, tri alphabétique, virtuals. */
const paginateStudentsForMentor = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .select(SAFE)
      .populate('studentClass', 'className')
      .populate('schoolCampus', 'campus_name')
      .sort({ lastName: 1, firstName: 1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    Student.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Listing dashboard campus : tri par date de création desc. */
const paginateStudentsForCampusDashboard = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    Student.find(filter)
      .populate('studentClass', 'className')
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Student.countDocuments(filter),
  ]);
  return { docs, total };
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — écritures & accès controller (auth / suppression)
// ─────────────────────────────────────────────────────────────────────────────

/** Doc student pour login (mot de passe + campus peuplé). */
const findStudentForLogin = (query) =>
  Student.findOne(query)
    .select('+password')
    .populate('schoolCampus', 'campus_name');

/** MAJ atomique de lastLogin (n'exécute pas les hooks de save). */
const touchLastLogin = (id) =>
  Student.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();

/** Doc student avec mot de passe (changement de mot de passe). */
const findStudentByIdWithPassword = (id) =>
  Student.findById(id).select('+password');

/** Doc student complet par id (suppression définitive : besoin de profileImage). */
const findStudentDocById = (id) => Student.findById(id);

/** Persiste un doc student (déclenche pre('validate')/pre('save')). */
const saveStudentDoc = (doc) => doc.save();

/**
 * Suppression définitive — `findByIdAndDelete` pour déclencher le hook
 * post('findOneAndDelete') (cascade de retrait des parents).
 */
const deleteStudentById = (id) => Student.findByIdAndDelete(id);

/** Students actifs d'une classe/campus pour l'init de feuille d'appel (ids). */
const findActiveStudentsForAttendance = (classId, campusId) =>
  Student.find({
    studentClass: toOid(classId),
    schoolCampus: toOid(campusId),
    status:       'active',
  }).select('_id').lean();

/** Profil d'en-tête du dashboard self-service (classe/campus/mentor peuplés). */
const findStudentDashboardProfile = (studentId) =>
  Student.findById(studentId)
    .populate('studentClass', 'className level')
    .populate('schoolCampus', 'campus_name')
    .populate('mentor',       'firstName lastName email')
    .lean({ virtuals: true });

/** classId courant d'un student (résolution calendrier, campus-isolée). */
const resolveStudentClass = async (userId, campusId) => {
  const student = await Student.findOne({
    _id:          userId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  }).select('studentClass').lean();
  return student?.studentClass?.toString() ?? null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — accès config GenericEntityController (session-aware)
// ─────────────────────────────────────────────────────────────────────────────

/** Unicité matricule dans un campus (validation de création, en session). */
const findStudentByMatriculeInCampus = (matricule, campusId, { session } = {}) =>
  Student.findOne({ matricule, schoolCampus: campusId })
    .select('_id')
    .session(session ?? null)
    .lean();

/** Unicité matricule hors d'un id (validation de mise à jour). */
const findStudentByMatriculeExcluding = (matricule, campusId, excludeId) =>
  Student.findOne({ matricule, schoolCampus: campusId, _id: { $ne: excludeId } })
    .select('_id')
    .lean();

/** Compteur de students d'un campus (génération de matricule, en session). */
const countStudentsInCampus = (campusId, { session } = {}) =>
  Student.countDocuments({ schoolCampus: campusId }).session(session ?? null);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/** Crée une session StudentSchedule. */
const createScheduleSession = (payload) => StudentSchedule.create(payload);

/**
 * Sessions d'une classe d'un campus, requête bornée (service inter-modules).
 * Signature/params identiques à l'historique listSessionsForClass.
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

/** MAJ du résumé d'appel d'une session (sync depuis TeacherSchedule). */
const updateAttendanceSummary = (studentScheduleId, summaryFields) =>
  StudentSchedule.findByIdAndUpdate(studentScheduleId, summaryFields).exec();

/** Roster (classes peuplées + effectif attendu) d'une session. */
const getSessionRoster = (studentScheduleId) =>
  StudentSchedule.findById(studentScheduleId)
    .select('classes expectedAttendees')
    .populate('classes.classId', 'className students')
    .lean();

/** Upsert d'une entrée StudentSchedule par référence (miroir examens). */
const upsertStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/** MAJ d'une entrée StudentSchedule par référence. */
const updateStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate({ reference }, { $set: fields });

// — accès controller (calendrier / admin) —

/**
 * Sessions publiées d'une classe sur une fenêtre [start, end] (calendrier
 * étudiant + export ICS). `sessionType`/`select` optionnels.
 */
const listPublishedSessionsInWindow = ({ classId, campusId, start, end, sessionType, select }) => {
  const filter = {
    'classes.classId': classId,
    schoolCampus:      campusId,
    startTime:         { $gte: start },
    endTime:           { $lte: end },
    status:            'PUBLISHED',
    isDeleted:         false,
  };
  if (sessionType) filter.sessionType = sessionType;

  let q = StudentSchedule.find(filter).sort({ startTime: 1 });
  if (select) q = q.select(select);
  return q.lean();
};

/**
 * Sessions publiées d'une classe bornées sur `startTime` (dashboard : créneaux
 * du jour / à venir). Bornes optionnelles gte/gt/lte ; `limit` optionnel.
 */
const listClassPublishedSessionsByStart = ({ classId, campusId, gte, gt, lte, limit }) => {
  const filter = {
    'classes.classId': classId,
    schoolCampus:      campusId,
    status:            'PUBLISHED',
    isDeleted:         false,
    startTime:         {},
  };
  if (gte) filter.startTime.$gte = gte;
  if (gt)  filter.startTime.$gt  = gt;
  if (lte) filter.startTime.$lte = lte;

  let q = StudentSchedule.find(filter).sort({ startTime: 1 });
  if (limit) q = q.limit(limit);
  return q.lean();
};

/** Détail d'une session publiée (accès étudiant). */
const findPublishedSessionById = (id) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false, status: 'PUBLISHED' })
    .select('-__v')
    .lean();

/** Résumé d'appel d'une session (par id, non supprimée). */
const findSessionAttendanceInfo = (id) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false })
    .select('reference subject startTime endTime attendance')
    .lean();

/** Détection de conflits (statique du model : classe/salle). */
const detectScheduleConflicts = (args) => StudentSchedule.detectConflicts(args);

/** Doc session pour écriture, scopé campus + non supprimée (update/publish/cancel). */
const findScheduleSessionForWrite = (id, campusFilter) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false, ...campusFilter });

/** Persiste un doc session (déclenche pre('save')). */
const saveScheduleDoc = (doc) => doc.save();

/** Soft-delete d'une session, scopée campus. */
const softDeleteScheduleSession = (id, campusFilter, actorId) =>
  StudentSchedule.findOneAndUpdate(
    { _id: id, isDeleted: false, ...campusFilter },
    { isDeleted: true, deletedAt: new Date(), deletedBy: actorId, lastModifiedBy: actorId },
    { new: true }
  );

/** Overview paginé des sessions (admin). Filtre composé par l'appelant. */
const paginateScheduleSessions = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    StudentSchedule.find(filter)
      .sort({ startTime: 1 })
      .skip(skip).limit(limit)
      .select('-__v').lean(),
    StudentSchedule.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Rapport d'occupation des salles (agrégat). L'appelant fournit le $match. */
const aggregateRoomOccupancy = (matchStage) =>
  StudentSchedule.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:               '$room.code',
        capacity:          { $first: '$room.capacity' },
        totalSessions:     { $sum: 1 },
        confirmedSessions: { $sum: { $cond: [{ $eq: ['$status', 'PUBLISHED'] }, 1, 0] } },
        cancelledSessions: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
        totalMinutes:      { $sum: '$durationMinutes' },
      },
    },
    {
      $project: {
        roomCode:          '$_id',
        capacity:          1,
        totalSessions:     1,
        confirmedSessions: 1,
        cancelledSessions: 1,
        totalHours:        { $round: [{ $divide: ['$totalMinutes', 60] }, 1] },
        cancellationRate: {
          $cond: [
            { $gt: ['$totalSessions', 0] },
            { $round: [{ $multiply: [{ $divide: ['$cancelledSessions', '$totalSessions'] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { totalSessions: -1 } },
  ]);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE — agrégats & listings (service inter-modules)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Résumé de présence d'un student (totaux + cond). Le cast ObjectId de
 * student/campus est fait ici.
 */
const summarizeStudentAttendance = ({ studentId, campusId, academicYear, semester, status, includeJustified = false }) => {
  const match = { student: toOid(studentId), schoolCampus: toOid(campusId) };
  if (academicYear)         match.academicYear = academicYear;
  if (semester)             match.semester     = semester;
  if (status !== undefined) match.status       = status;

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
 * Résumé de présence d'un student sur une année (dashboard self-service).
 * student/campus déjà castés par l'appelant.
 */
const aggregateStudentYearAttendance = ({ studentOid, campusOid, academicYear }) =>
  StudentAttendance.aggregate([
    { $match: { student: studentOid, schoolCampus: campusOid, academicYear } },
    {
      $group: {
        _id:           null,
        totalSessions: { $sum: 1 },
        presentCount:  { $sum: { $cond: [{ $eq: ['$status', true]  }, 1, 0] } },
        absentCount:   { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
      },
    },
  ]);

/** Totaux présence d'un campus (ou des classes d'un mentor). */
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

/** Taux d'absence moyen par student d'un campus (dashboard). */
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
          $avg: { $multiply: [{ $divide: ['$absentCount', '$totalSessions'] }, 100] },
        },
      },
    },
  ]);

/** Relevé de présence paginé d'un enfant (portail parent). */
const listStudentAttendanceForParent = async ({ studentId, campusId, academicYear, semester, status, skip = 0, limit = 20 }) => {
  const filter = { student: studentId, schoolCampus: campusId };
  if (academicYear)         filter.academicYear = academicYear;
  if (semester)             filter.semester     = semester;
  if (status !== undefined) filter.status       = status;

  const [records, total] = await Promise.all([
    StudentAttendance.find(filter)
      .select('-__v')
      .populate('subject',    'subject_name')
      .populate('recordedBy', 'firstName lastName')
      .sort({ attendanceDate: -1 })
      .skip(skip).limit(limit).lean({ virtuals: true }),
    StudentAttendance.countDocuments(filter),
  ]);
  return { records, total };
};

/** Listing paginé de présence (staff / mentor). Filtre composé par l'appelant. */
const paginateAttendance = async (filter, { page = 1, limit = 20 }) => {
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
 * Statistiques de présence d'un student (statique getStudentStats du model ;
 * repli historique { attendanceRate: 100 } si la statique est absente).
 */
const getStudentAttendanceStats = (studentId, academicYear, semester, scope) =>
  StudentAttendance.getStudentStats
    ? StudentAttendance.getStudentStats(studentId, academicYear, semester, scope)
    : Promise.resolve({ attendanceRate: 100 });

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE — accès controller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Init/upsert de la feuille d'appel d'une session (bulkWrite $setOnInsert).
 * `students` = ids résolus en amont ; renvoie { upsertedCount, matchedCount }.
 */
const initSessionAttendanceRecords = async ({
  students, scheduleId, classId, campusId, subjectId,
  attendanceDate, academicYear, semester, sessionStartTime, sessionEndTime, recordedBy,
}) => {
  const schedule = toOid(scheduleId);
  const klass    = toOid(classId);
  const campus   = toOid(campusId);
  const subject  = subjectId ? toOid(subjectId) : undefined;

  const operations = students.map((s) => ({
    updateOne: {
      filter: { student: s._id, schedule, attendanceDate },
      update: {
        $setOnInsert: {
          student:          s._id,
          schedule,
          class:            klass,
          schoolCampus:     campus,
          subject,
          attendanceDate,
          academicYear,
          semester,
          sessionStartTime: sessionStartTime || null,
          sessionEndTime:   sessionEndTime   || null,
          recordedBy,
          status:           false,
        },
      },
      upsert: true,
    },
  }));

  const result = await StudentAttendance.bulkWrite(operations, { ordered: false });
  return { upsertedCount: result.upsertedCount, matchedCount: result.matchedCount };
};

/** Records de présence d'une session (filtre composé par l'appelant). */
const findSessionAttendanceRecords = (filter) =>
  StudentAttendance.find(filter)
    .populate('student', 'firstName lastName email profileImage matricule')
    .populate('class',   'className')
    .sort({ 'student.lastName': 1 })
    .lean();

/** Verrouille (submit) les records d'une session ; renvoie { modifiedCount }. */
const lockSessionAttendance = async (filter, actorId) => {
  const result = await StudentAttendance.updateMany(filter, {
    $set: {
      isLocked:       true,
      lockedAt:       new Date(),
      lockedByModel:  'Teacher',
      lastModifiedBy: actorId,
      lastModifiedAt: new Date(),
    },
  });
  return { modifiedCount: result.modifiedCount };
};

/** Doc record de présence scopé campus (toggle / justification). */
const findAttendanceRecordScoped = (attendanceId, campusFilter) =>
  StudentAttendance.findOne({ _id: toOid(attendanceId), ...campusFilter });

/** Bascule le statut d'un record (méthode d'instance). */
const toggleAttendanceStatus = (record, newStatus, userId) =>
  record.toggleStatus(newStatus, userId);

/** Ajoute une justification d'absence (méthode d'instance). */
const addAttendanceJustification = (record, justification, userId, document) =>
  record.addJustification(justification, userId, document);

/** Verrouillage quotidien (statique du model). */
const lockDailyAttendance = (targetDate, campusId) =>
  StudentAttendance.lockDailyAttendance(targetDate, campusId);

/** Records de présence d'un student (self-service), filtre composé par l'appelant. */
const findStudentAttendanceRecords = (filter) =>
  StudentAttendance.find(filter)
    .populate('schedule', 'startTime endTime')
    .populate('class',    'className')
    .sort({ attendanceDate: -1 })
    .lean();

/** Stats de présence d'un student (statique brute — self-service / analytics). */
const getStudentStats = (studentId, academicYear, semester, period) =>
  StudentAttendance.getStudentStats(studentId, academicYear, semester, period);

/** Stats de présence d'une classe (statique brute). */
const getClassStats = (classId, date, period) =>
  StudentAttendance.getClassStats(classId, date, period);

/**
 * Overview de présence d'un campus (paginé + KPIs sur le périmètre complet).
 * `filter` = affichage ; `summaryFilter` = périmètre sans statut.
 */
const attendanceCampusOverview = async (filter, summaryFilter, { skip, limit }) => {
  const [records, total, presentCount] = await Promise.all([
    StudentAttendance.find(filter)
      .populate('student',  'firstName lastName matricule')
      .populate('class',    'className')
      .populate('schedule', 'startTime endTime')
      .sort({ attendanceDate: -1 })
      .skip(skip).limit(limit).lean(),
    StudentAttendance.countDocuments(summaryFilter),
    StudentAttendance.countDocuments({ ...summaryFilter, status: true }),
  ]);
  return { records, total, presentCount };
};

module.exports = {
  // Student — refs & lectures
  findStudentCampusRef,
  countStudents,
  listStudentIds,
  getStudentClassRef,
  getStudentsCampusRefs,
  getStudentForDocument,
  getStudentProfileRef,
  listStudentsForExamEligibility,
  getStudentForPrint,
  listClassStudentsForCards,
  listClassStudentsForList,
  getStudentNamesByIds,
  getStudentContactsByIds,
  // Student — listings paginés
  paginateStudentsForStaff,
  paginateStudentsForMentor,
  paginateStudentsForCampusDashboard,
  // Student — écritures & controller
  findStudentForLogin,
  touchLastLogin,
  findStudentByIdWithPassword,
  findStudentDocById,
  saveStudentDoc,
  deleteStudentById,
  findActiveStudentsForAttendance,
  findStudentDashboardProfile,
  resolveStudentClass,
  // Student — config (session-aware)
  findStudentByMatriculeInCampus,
  findStudentByMatriculeExcluding,
  countStudentsInCampus,
  // StudentSchedule
  createScheduleSession,
  listSessionsForClass,
  updateAttendanceSummary,
  getSessionRoster,
  upsertStudentScheduleByReference,
  updateStudentScheduleByReference,
  listPublishedSessionsInWindow,
  listClassPublishedSessionsByStart,
  findPublishedSessionById,
  findSessionAttendanceInfo,
  detectScheduleConflicts,
  findScheduleSessionForWrite,
  saveScheduleDoc,
  softDeleteScheduleSession,
  paginateScheduleSessions,
  aggregateRoomOccupancy,
  // StudentAttendance — agrégats & listings
  summarizeStudentAttendance,
  aggregateStudentYearAttendance,
  summarizeAttendanceTotals,
  getAvgAbsenceRateForCampus,
  listStudentAttendanceForParent,
  paginateAttendance,
  getStudentAttendanceStats,
  // StudentAttendance — controller
  initSessionAttendanceRecords,
  findSessionAttendanceRecords,
  lockSessionAttendance,
  findAttendanceRecordScoped,
  toggleAttendanceStatus,
  addAttendanceJustification,
  lockDailyAttendance,
  findStudentAttendanceRecords,
  getStudentStats,
  getClassStats,
  attendanceCampusOverview,
};
