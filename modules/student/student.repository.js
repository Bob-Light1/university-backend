'use strict';

/**
 * @file student.repository.js — data access layer for the student module.
 *
 * The ONLY file allowed to touch the 3 owned models:
 *   - Student            (student.model)
 *   - StudentSchedule    (student.schedule.model)
 *   - StudentAttendance  (student.attend.model)
 *
 * Controllers, the cross-module service and config (except the `Model:` of the
 * GenericEntityController) go exclusively through it. Reads use `.lean()`
 * (or `.lean({ virtuals: true })` where the historical output exposed
 * virtuals like `fullName`); hooked writes go through load→mutate→save,
 * otherwise atomic operators. Aggregation pipelines live here; the caller
 * provides the `$match` already cast to ObjectId. Campus isolation filters
 * are built by the caller and passed as-is.
 *
 * Accepted exceptions (stay outside the repo):
 *   - GenericEntityController / GenericBulkController: operate on the Model
 *     provided by student.config.js (`Model: Student`).
 *   - shared/services/profile.service: operates on the Model passed by
 *     student.profile.controller.
 *   - Model statics/instance methods (getStudentStats, toggleStatus,
 *     detectConflicts…): business logic of the model layer, invoked HERE.
 */

const mongoose          = require('mongoose');
const Student           = require('./models/student.model');
const StudentSchedule   = require('./models/student.schedule.model');
const StudentAttendance = require('./models/student.attend.model');

const SAFE = '-password -__v';
const toOid = (id) => new mongoose.Types.ObjectId(String(id));

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — reference reads (cross-module service)
// ─────────────────────────────────────────────────────────────────────────────

/** Campus attachment of a student (multi-tenant validation). */
const findStudentCampusRef = (studentId) =>
  Student.findById(studentId).select('schoolCampus').lean();

/** Configurable counter. The caller provides the already-composed filter. */
const countStudents = (filter) => Student.countDocuments(filter);

/** Ids of the enrolled students (source of truth: Student.studentClass). */
const listStudentIds = (filter) => Student.find(filter, { _id: 1 }).lean();

/**
 * Sets the mentor back-reference on a set of campus-scoped students.
 * @returns {Promise<{ modifiedCount: number }>}
 */
const setMentorForStudents = (studentIds, mentorId, campusId) =>
  Student.updateMany(
    { _id: { $in: studentIds }, schoolCampus: campusId },
    { $set: { mentor: mentorId } }
  );

/**
 * Clears the mentor back-reference, but only for students currently pointing
 * to this mentor (avoids clobbering a concurrent re-assignment).
 * @returns {Promise<{ modifiedCount: number }>}
 */
const clearMentorForStudents = (studentIds, mentorId, campusId) =>
  Student.updateMany(
    { _id: { $in: studentIds }, schoolCampus: campusId, mentor: mentorId },
    { $set: { mentor: null } }
  );

/** Current class reference of a student of a campus. */
const getStudentClassRef = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('studentClass')
    .lean();

/** Campus attachments of a list of students. */
const getStudentsCampusRefs = (studentIds) =>
  Student.find({ _id: { $in: studentIds } })
    .select('_id schoolCampus')
    .lean();

/** Full student (lean) of a campus — typed document generation. */
const getStudentForDocument = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId }).lean();

/** Minimal profile of a student (transcript header). */
const getStudentProfileRef = (studentId) =>
  Student.findById(studentId)
    .select('firstName lastName matricule email schoolCampus studentClass')
    .lean();

/**
 * Students that are candidates for exam eligibility (Mongoose documents,
 * historical `currentClass` field).
 */
const listStudentsForExamEligibility = ({ classIds, campusId }) =>
  Student.find({
    currentClass: { $in: classIds },
    schoolCampus: campusId || { $exists: true },
    status:       { $ne: 'archived' },
  }).select('_id currentClass');

/** Student of a campus with the print fields (card/certificate). */
const getStudentForPrint = (studentId, campusId) =>
  Student.findOne({ _id: studentId, schoolCampus: campusId })
    .select('firstName lastName matricule profileImage dateOfBirth gender studentClass cardNumber cardValidUntil')
    .lean();

/** Non-archived students of a class with the card fields (batch printing). */
const listClassStudentsForCards = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule profileImage dateOfBirth gender cardNumber cardValidUntil')
    .lean();

/** Non-archived students of a class, sorted, for the printed list. */
const listClassStudentsForList = (classId, campusId) =>
  Student.find({ studentClass: classId, schoolCampus: campusId, status: { $ne: 'archived' } })
    .select('firstName lastName matricule dateOfBirth gender status')
    .sort({ lastName: 1, firstName: 1 })
    .lean();

/** Names/matricules of a list of students of a campus. */
const getStudentNamesByIds = (studentIds, campusId) =>
  Student.find({ _id: { $in: studentIds }, schoolCampus: campusId })
    .select('firstName lastName matricule')
    .lean();

/** Notification contact details (email/phone) of a batch of students. */
const getStudentContactsByIds = (studentIds) =>
  Student.find({ _id: { $in: studentIds } })
    .select('email phone')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — paginated listings (cross-module service)
// ─────────────────────────────────────────────────────────────────────────────

/** Staff listing: populated class, alphabetical sort, virtuals. */
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

/** Mentor listing: populated class + campus, alphabetical sort, virtuals. */
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

/** Campus dashboard listing: sorted by creation date desc. */
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
// STUDENT — writes & controller access (auth / deletion)
// ─────────────────────────────────────────────────────────────────────────────

/** Student doc for login (password + populated campus). */
const findStudentForLogin = (query) =>
  Student.findOne(query)
    .select('+password')
    .populate('schoolCampus', 'campus_name');

/** Atomic update of lastLogin (does not run the save hooks). */
const touchLastLogin = (id) =>
  Student.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();

/** Student doc with password (password change). */
const findStudentByIdWithPassword = (id) =>
  Student.findById(id).select('+password');

/** Full student doc by id (permanent deletion: needs profileImage). */
const findStudentDocById = (id) => Student.findById(id);

/** Persists a student doc (triggers pre('validate')/pre('save')). */
const saveStudentDoc = (doc) => doc.save();

/**
 * Permanent deletion — `findByIdAndDelete` to trigger the
 * post('findOneAndDelete') hook (cascade removal from parents).
 */
const deleteStudentById = (id) => Student.findByIdAndDelete(id);

/** Active students of a class/campus for attendance sheet init (ids). */
const findActiveStudentsForAttendance = (classId, campusId) =>
  Student.find({
    studentClass: toOid(classId),
    schoolCampus: toOid(campusId),
    status:       'active',
  }).select('_id').lean();

/** Header profile of the self-service dashboard (populated class/campus/mentor). */
const findStudentDashboardProfile = (studentId) =>
  Student.findById(studentId)
    .populate('studentClass', 'className level')
    .populate('schoolCampus', 'campus_name')
    .populate('mentor',       'firstName lastName email')
    .lean({ virtuals: true });

/** Current classId of a student (calendar resolution, campus-isolated). */
const resolveStudentClass = async (userId, campusId) => {
  const student = await Student.findOne({
    _id:          userId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  }).select('studentClass').lean();
  return student?.studentClass?.toString() ?? null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT — GenericEntityController config access (session-aware)
// ─────────────────────────────────────────────────────────────────────────────

/** Matricule uniqueness within a campus (creation validation, in session). */
const findStudentByMatriculeInCampus = (matricule, campusId, { session } = {}) =>
  Student.findOne({ matricule, schoolCampus: campusId })
    .select('_id')
    .session(session ?? null)
    .lean();

/** Matricule uniqueness excluding an id (update validation). */
const findStudentByMatriculeExcluding = (matricule, campusId, excludeId) =>
  Student.findOne({ matricule, schoolCampus: campusId, _id: { $ne: excludeId } })
    .select('_id')
    .lean();

/** Student counter of a campus (matricule generation, in session). */
const countStudentsInCampus = (campusId, { session } = {}) =>
  Student.countDocuments({ schoolCampus: campusId }).session(session ?? null);

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a StudentSchedule session. */
const createScheduleSession = (payload) => StudentSchedule.create(payload);

/**
 * Sessions of a class in a campus, bounded query (inter-module service).
 * Signature/params identical to the legacy listSessionsForClass.
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

/** Update of a session's roll-call summary (sync from TeacherSchedule). */
const updateAttendanceSummary = (studentScheduleId, summaryFields) =>
  StudentSchedule.findByIdAndUpdate(studentScheduleId, summaryFields).exec();

/** Roster (populated classes + expected headcount) of a session. */
const getSessionRoster = (studentScheduleId) =>
  StudentSchedule.findById(studentScheduleId)
    .select('classes expectedAttendees')
    .populate('classes.classId', 'className students')
    .lean();

/** Upsert of a StudentSchedule entry by reference (exam mirror). */
const upsertStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/** Update of a StudentSchedule entry by reference. */
const updateStudentScheduleByReference = (reference, fields) =>
  StudentSchedule.findOneAndUpdate({ reference }, { $set: fields });

// — controller access (calendar / admin) —

/**
 * Published sessions of a class over a [start, end] window (student
 * calendar + ICS export). `sessionType`/`select` optional.
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
 * Published sessions of a class bounded on `startTime` (dashboard: today's /
 * upcoming slots). Optional gte/gt/lte bounds; `limit` optional.
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

/** Detail of a published session (student access). */
const findPublishedSessionById = (id) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false, status: 'PUBLISHED' })
    .select('-__v')
    .lean();

/** Roll-call summary of a session (by id, not deleted). */
const findSessionAttendanceInfo = (id) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false })
    .select('reference subject startTime endTime attendance')
    .lean();

/** Conflict detection (model static: class/room). */
const detectScheduleConflicts = (args) => StudentSchedule.detectConflicts(args);

/** Session doc for writing, campus-scoped + not deleted (update/publish/cancel). */
const findScheduleSessionForWrite = (id, campusFilter) =>
  StudentSchedule.findOne({ _id: id, isDeleted: false, ...campusFilter });

/** Persists a session doc (triggers pre('save')). */
const saveScheduleDoc = (doc) => doc.save();

/** Soft-delete of a session, campus-scoped. */
const softDeleteScheduleSession = (id, campusFilter, actorId) =>
  StudentSchedule.findOneAndUpdate(
    { _id: id, isDeleted: false, ...campusFilter },
    { isDeleted: true, deletedAt: new Date(), deletedBy: actorId, lastModifiedBy: actorId },
    { new: true }
  );

/** Paginated overview of sessions (admin). Filter composed by the caller. */
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

/** Room occupancy report (aggregate). The caller provides the $match. */
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
// STUDENT ATTENDANCE — aggregates & listings (inter-module service)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attendance summary of a student (totals + cond). The ObjectId cast of
 * student/campus is done here.
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

/** Attendance totals of a campus (or of a mentor's classes). */
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

/** Average absence rate per student of a campus (dashboard). */
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

/** Paginated attendance record of a child (parent portal). */
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

/** Paginated attendance listing (staff / mentor). Filter composed by the caller. */
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
 * Attendance statistics of a student (getStudentStats static of the model;
 * legacy fallback { attendanceRate: 100 } if the static is absent).
 */
const getStudentAttendanceStats = (studentId, academicYear, semester, scope) =>
  StudentAttendance.getStudentStats
    ? StudentAttendance.getStudentStats(studentId, academicYear, semester, scope)
    : Promise.resolve({ attendanceRate: 100 });

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE — controller access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Init/upsert of a session's roll-call sheet (bulkWrite $setOnInsert).
 * `students` = ids resolved upstream; returns { upsertedCount, matchedCount }.
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

/** Attendance records of a session (filter composed by the caller). */
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

/** Campus-scoped attendance record (toggle / justification). */
const findAttendanceRecordScoped = (attendanceId, campusFilter) =>
  StudentAttendance.findOne({ _id: toOid(attendanceId), ...campusFilter });

/** Toggles the status of a record (instance method). */
const toggleAttendanceStatus = (record, newStatus, userId) =>
  record.toggleStatus(newStatus, userId);

/** Adds an absence justification (instance method). */
const addAttendanceJustification = (record, justification, userId, document) =>
  record.addJustification(justification, userId, document);

/** Verrouillage quotidien (statique du model). */
const lockDailyAttendance = (targetDate, campusId) =>
  StudentAttendance.lockDailyAttendance(targetDate, campusId);

/** Attendance records for a student (self-service); filter composed by the caller. */
const findStudentAttendanceRecords = (filter) =>
  StudentAttendance.find(filter)
    .populate('schedule', 'startTime endTime')
    .populate('class',    'className')
    .sort({ attendanceDate: -1 })
    .lean();

/** Attendance stats for a student (raw static — self-service / analytics). */
const getStudentStats = (studentId, academicYear, semester, period) =>
  StudentAttendance.getStudentStats(studentId, academicYear, semester, period);

/** Attendance stats for a class (raw static). */
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
  setMentorForStudents,
  clearMentorForStudents,
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
  // Student — paginated listings
  paginateStudentsForStaff,
  paginateStudentsForMentor,
  paginateStudentsForCampusDashboard,
  // Student — writes & controller
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
  // StudentAttendance — aggregates & listings
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
