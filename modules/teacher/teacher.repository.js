'use strict';

/**
 * @file teacher.repository.js — data access layer for the teacher module.
 *
 * ONLY file allowed to touch the 3 owned models:
 *   - Teacher            (teacher.model)
 *   - TeacherSchedule    (teacher.schedule.model)
 *   - TeacherAttendance  (teacher.attend.model)
 *
 * Controllers, the cross-module service and config (apart from the
 * GenericEntityController's `Model:`) go through it exclusively. Reads use
 * `.lean()` (or `.lean({ virtuals: true })` where the historical output
 * exposed virtuals); hooked writes via load→mutate→save, otherwise atomic
 * operators. Aggregation pipelines live here; the caller provides the
 * `$match` already cast to ObjectId. Campus isolation filters are built by
 * the caller and passed through as-is.
 *
 * Accepted exceptions (stay outside the repo):
 *   - GenericEntityController / GenericBulkController: operate on the Model
 *     provided by teacher.config.js / teacher.controller (`Model: Teacher`).
 *   - shared/services/profile.service: operates on the Model passed by
 *     teacher.profile.controller.
 *   - Model statics/instance methods (getTeacherStats, toggleStatus,
 *     detectTeacherConflicts, getTeacherCalendar…): business logic of the
 *     model layer, invoked HERE.
 */

const Teacher           = require('./models/teacher.model');
const TeacherSchedule   = require('./models/teacher.schedule.model');
const TeacherAttendance = require('./models/teacher.attend.model');

const SAFE_STAFF = '-password -__v -contractSnapshot';

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — reference reads (cross-module service)
// ─────────────────────────────────────────────────────────────────────────────

/** Campus attachment of a teacher (multi-tenant / cross-campus validation). */
const getTeacherCampusRef = (teacherId) =>
  Teacher.findById(teacherId).select('schoolCampus').lean();

/** Counts the teachers of a campus among a list of ids. */
const countTeachersByIdsOnCampus = (teacherIds, campusId) =>
  Teacher.countDocuments({ _id: { $in: teacherIds }, schoolCampus: campusId });

/** Counts the non-archived teachers of a campus (optional createdAt bound). */
const countActiveTeachers = (campusId, { createdSince } = {}) =>
  Teacher.countDocuments({
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
    ...(createdSince ? { createdAt: { $gte: createdSince } } : {}),
  });

/** Counts the non-archived teachers of a department (archival guard). */
const countActiveInDepartment = (departmentId) =>
  Teacher.countDocuments({ department: departmentId, status: { $ne: 'archived' } });

/** Full teacher (lean) of a campus — payslip. */
const getTeacherForPayslip = (teacherId, campusId) =>
  Teacher.findOne({ _id: teacherId, schoolCampus: campusId }).lean();

/** Denormalizable reference of an active teacher of a campus (teacher{} shape). */
const findActiveTeacherRef = (teacherId, campusId) =>
  Teacher.findOne({
    _id:          teacherId,
    schoolCampus: campusId,
    status:       { $ne: 'archived' },
  })
    .select('_id firstName lastName email matricule')
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — paginated listings (cross-module service)
// ─────────────────────────────────────────────────────────────────────────────

/** Staff listing: classes + subjects populated, alphabetical sort, virtuals. */
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

/** Campus dashboard listing: sort by creation date desc, no populate. */
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
// TEACHER — writes & controller access (auth / deletion)
// ─────────────────────────────────────────────────────────────────────────────

/** Teacher doc for login (password + department/subjects/campus populated). */
const findTeacherForLogin = (query) =>
  Teacher.findOne(query)
    .select('+password')
    .populate('department',   'name')
    .populate('subjects',     'subject_name')
    .populate('schoolCampus', 'campus_name');

/** Atomic update of lastLogin (does not run save hooks). */
const touchLastLogin = (id) =>
  Teacher.updateOne({ _id: id }, { $set: { lastLogin: new Date() } });

/** Teacher doc with password (password change). */
const findTeacherByIdWithPassword = (id) =>
  Teacher.findById(id).select('+password');

/** Full teacher doc by id (permanent deletion: needs profileImage). */
const findTeacherDocById = (id) => Teacher.findById(id);

/** Persists a teacher doc (triggers pre('validate')/pre('save')). */
const saveTeacherDoc = (doc) => doc.save();

/** Permanent deletion of a teacher. */
const deleteTeacherById = (id) => Teacher.findByIdAndDelete(id);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — GenericEntityController config access (session-aware)
// ─────────────────────────────────────────────────────────────────────────────

/** Matricule uniqueness within a campus (creation validation, in session). */
const findTeacherByMatriculeInCampus = (matricule, campusId, { session } = {}) =>
  Teacher.findOne({ matricule, schoolCampus: campusId })
    .select('_id')
    .session(session ?? null)
    .lean();

/** Matricule uniqueness excluding an id (update validation). */
const findTeacherByMatriculeExcluding = (matricule, campusId, excludeId) =>
  Teacher.findOne({ matricule, schoolCampus: campusId, _id: { $ne: excludeId } })
    .select('_id')
    .lean();

/** Teacher count of a campus (matricule generation, in session). */
const countTeachersInCampus = (campusId, { session } = {}) =>
  Teacher.countDocuments({ schoolCampus: campusId }).session(session ?? null);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER — dashboard self-service
// ─────────────────────────────────────────────────────────────────────────────

/** Dashboard header profile (subjects/classes/department/campus populated). */
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

/** Count of TeacherSchedule sessions (mirror reference generation). */
const countTeacherSchedules = () => TeacherSchedule.countDocuments();

/**
 * Upsert of the TeacherSchedule mirror of a StudentSchedule session (key:
 * studentScheduleRef). `reference` is only written on creation ($setOnInsert).
 */
const upsertTeacherScheduleMirror = (studentScheduleRef, setPayload, reference) =>
  TeacherSchedule.findOneAndUpdate(
    { studentScheduleRef },
    { $set: setPayload, $setOnInsert: { reference } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

/** Upsert of a TeacherSchedule entry by reference (exams mirror). */
const upsertTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate(
    { reference },
    { $set: fields },
    { upsert: true, new: true }
  );

/** Update of a TeacherSchedule entry by reference. */
const updateTeacherScheduleByReference = (reference, fields) =>
  TeacherSchedule.findOneAndUpdate({ reference }, { $set: fields });

/** Double-booking detection for a teacher (model static). */
const detectTeacherConflicts = (params) =>
  TeacherSchedule.detectTeacherConflicts(params);

/** Paginated staff portal schedule (subject/classes/teacher populated). */
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

// — dashboard (the teacher's PUBLISHED sessions) —

/** Published sessions of the day (sorted by startTime). */
const listTeacherTodaySessions = (teacherId, { gte, lte }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    status:    'PUBLISHED',
    isDeleted: false,
    startTime: { $gte: gte, $lte: lte },
  }).sort({ startTime: 1 }).lean();

/** Upcoming published sessions (start-exclusive window, limit). */
const listTeacherUpcomingSessions = (teacherId, { gt, lte, limit }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    status:    'PUBLISHED',
    isDeleted: false,
    startTime: { $gt: gt, $lte: lte },
  }).sort({ startTime: 1 }).limit(limit).lean();

/** Overdue roll-calls: past published sessions not submitted (limit). */
const listTeacherPendingRollCalls = (teacherId, { lt, limit }) =>
  TeacherSchedule.find({
    'teacher.teacherId':  teacherId,
    status:               'PUBLISHED',
    isDeleted:            false,
    startTime:            { $lt: lt },
    'rollCall.submitted': false,
  }).sort({ startTime: -1 }).limit(limit).lean();

/**
 * Yearly workload (dashboard aggregate). `teacherOid` already cast by the
 * caller.
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

// — calendar / workload (model statics) —

/** Teacher's calendar over a window (model static). */
const getTeacherCalendar = (teacherId, start, end, opts) =>
  TeacherSchedule.getTeacherCalendar(teacherId, start, end, opts);

/** Workload summary (model static). */
const getWorkloadSummary = (teacherId, periodLabel, periodType) =>
  TeacherSchedule.getWorkloadSummary(teacherId, periodLabel, periodType);

// — session reads / writes (controller) —

/** Detail of a non-deleted session (read, teacher/admin access). */
const findScheduleSessionLean = (id) =>
  TeacherSchedule.findOne({ _id: id, isDeleted: false }).lean();

/** Non-deleted session doc for writing (roll-call / postponement). */
const findScheduleSessionForWrite = (id) =>
  TeacherSchedule.findOne({ _id: id, isDeleted: false });

/** Session doc carrying a given postponement request (review). */
const findScheduleByPostponementRequest = (requestId) =>
  TeacherSchedule.findOne({ 'postponementRequests._id': requestId, isDeleted: false });

/** Persists a session doc (triggers pre('save'): reference, duration…). */
const saveScheduleDoc = (doc) => doc.save();

/** Sessions of a campus carrying a postponement request of a given status. */
const listSchedulesWithPostponements = (campusFilter, status) =>
  TeacherSchedule.find({
    ...campusFilter,
    'postponementRequests.status': status,
    isDeleted: false,
  })
    .select('reference teacher subject startTime endTime postponementRequests')
    .lean();

/** Teacher's availability profile doc (write). */
const findAvailabilityProfileForWrite = (teacherId) =>
  TeacherSchedule.findOne({
    'teacher.teacherId': teacherId,
    studentScheduleRef:  null,
    sessionType:         { $exists: false },
    isDeleted:           false,
  });

/** Teacher's availability slots (projected read). */
const findAvailabilityProfile = (teacherId) =>
  TeacherSchedule.findOne(
    {
      'teacher.teacherId': teacherId,
      studentScheduleRef:  null,
      isDeleted:           false,
    },
    { availabilitySlots: 1 }
  ).lean();

/** Builds a new TeacherSchedule doc (availability profile). */
const newTeacherScheduleDoc = (payload) => new TeacherSchedule(payload);

/** Paginated overview of a teacher's sessions (admin). Filter composed upstream. */
const paginateTeacherSessions = async (filter, { skip, limit }) => {
  const [docs, total] = await Promise.all([
    TeacherSchedule.find(filter)
      .sort({ startTime: 1 })
      .skip(skip).limit(limit).lean(),
    TeacherSchedule.countDocuments(filter),
  ]);
  return { docs, total };
};

/** Workload report for all teachers (aggregate, payroll). */
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
// TEACHER ATTENDANCE — writes & reads (controller)
// ─────────────────────────────────────────────────────────────────────────────

/** Existing attendance record doc for a session/date (init: write). */
const findTeacherAttendanceForWrite = (filter) => TeacherAttendance.findOne(filter);

/** Creates a teacher attendance record. */
const createTeacherAttendance = (payload) => TeacherAttendance.create(payload);

/** Persists a record doc (triggers save hooks). */
const saveAttendanceDoc = (doc) => doc.save();

/** Attendance records of a session (teacher/replacement/class/schedule populated). */
const listSessionAttendanceRecords = (filter) =>
  TeacherAttendance.find(filter)
    .populate('teacher',            'firstName lastName email profileImage employmentType')
    .populate('replacementTeacher', 'firstName lastName email')
    .populate('class',              'className')
    .populate('schedule',           'startTime endTime')
    .sort({ attendanceDate: -1 })
    .lean();

/** Scoped attendance record doc (toggle / justification / replacement / paid). */
const findAttendanceRecordScoped = (filter) => TeacherAttendance.findOne(filter);

/** Daily attendance lock (model static). */
const lockDailyTeacherAttendance = (targetDate, campusId) =>
  TeacherAttendance.lockDailyAttendance(targetDate, campusId);

/** Attendance records of the logged-in teacher (schedule/class populated). */
const listMyAttendanceRecords = (filter) =>
  TeacherAttendance.find(filter)
    .populate('schedule', 'startTime endTime')
    .populate('class',    'className')
    .sort({ attendanceDate: -1 })
    .lean();

/** Attendance stats of a teacher (model static). */
const getTeacherAttendanceStats = (teacherId, academicYear, semester, period) =>
  TeacherAttendance.getTeacherStats(teacherId, academicYear, semester, period);

/** Attendance stats of a campus (model static). */
const getCampusAttendanceStats = (campusId, date, period) =>
  TeacherAttendance.getCampusStats(campusId, date, period);

/** Payroll report (aggregate). The caller provides the $match. */
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
 * Attendance overview of a campus (paginated + KPIs over the full scope).
 * `filter` = display; `summaryFilter` = scope without status.
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

/** A teacher's sessions over a day (pending: unrecorded sessions). */
const listTeacherSessionsForPending = ({ teacherId, dayStart, dayEnd, campusFilter }) =>
  TeacherSchedule.find({
    'teacher.teacherId': teacherId,
    startTime: { $gte: dayStart, $lte: dayEnd },
    isDeleted: false,
    ...campusFilter,
  }).lean();

/** Ids of sessions already recorded (pending). */
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
  // Teacher — paginated listings
  paginateStaffTeachers,
  paginateCampusDashboardTeachers,
  // Teacher — writes & controller
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
