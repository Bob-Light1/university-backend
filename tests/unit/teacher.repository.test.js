'use strict';

/**
 * Couche repository — module teacher (R3, cœur académique ; 3 models).
 * Models mockés (sans DB) : Teacher, TeacherSchedule, TeacherAttendance.
 *
 * jest.mock impose des chemins littéraux + une factory auto-suffisante (hoisting :
 * buildModelMock est une déclaration de fonction, donc hissée). Chaque model est
 * un constructeur doté de statiques jest.fn ; les queries sont chaînables
 * (select/sort/skip/limit/populate/session) et .lean/.exec résolvent __setLean.
 *
 * Accent mis sur les agrégats (non-régression des sorties workload/payroll) et
 * les formes de requête sensibles (sessions de transaction, upsert de miroir,
 * bornes temporelles des sessions, isolation campus du périmètre KPI).
 */

const buildModelMock = () => {
  let leanVal = null;
  const makeQuery = () => {
    const q = {};
    ['select', 'sort', 'skip', 'limit', 'populate', 'session'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.lean = jest.fn(() => Promise.resolve(leanVal));
    q.exec = jest.fn(() => Promise.resolve(leanVal));
    q.then = (resolve) => Promise.resolve(leanVal).then(resolve);
    return q;
  };
  function Model(data) { Object.assign(this, data); this._id = this._id || 'gen-id'; }
  Model.prototype.save = jest.fn(function save() { return Promise.resolve(this); });
  ['find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete', 'updateOne'].forEach((m) => {
    Model[m] = jest.fn(() => makeQuery());
  });
  Model.countDocuments = jest.fn(() => makeQuery());
  Model.aggregate = jest.fn(() => Promise.resolve([]));
  Model.create = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  // statiques métier (logique de la couche model invoquée par le repo)
  Model.detectTeacherConflicts = jest.fn(() => Promise.resolve({ hasConflict: false, conflicts: [] }));
  Model.getTeacherCalendar = jest.fn(() => Promise.resolve([{ _id: 'sess1' }]));
  Model.getWorkloadSummary = jest.fn(() => Promise.resolve({ scheduledHours: 10 }));
  Model.lockDailyAttendance = jest.fn(() => Promise.resolve({ modifiedCount: 7 }));
  Model.getTeacherStats = jest.fn(() => Promise.resolve({ attendanceRate: 88 }));
  Model.getCampusStats = jest.fn(() => Promise.resolve({ present: 12, total: 15 }));
  Model.__setLean = (v) => { leanVal = v; };
  return Model;
};

jest.mock('../../modules/teacher/models/teacher.model', () => buildModelMock());
jest.mock('../../modules/teacher/models/teacher.schedule.model', () => buildModelMock());
jest.mock('../../modules/teacher/models/teacher.attend.model', () => buildModelMock());

const Teacher           = require('../../modules/teacher/models/teacher.model');
const TeacherSchedule   = require('../../modules/teacher/models/teacher.schedule.model');
const TeacherAttendance = require('../../modules/teacher/models/teacher.attend.model');
const repo = require('../../modules/teacher/teacher.repository');

beforeEach(() => {
  jest.clearAllMocks();
  [Teacher, TeacherSchedule, TeacherAttendance].forEach((M) => M.__setLean(null));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('teacher', () => {
  test('findTeacherForLogin : findOne(query) + select(+password) + populate department/subjects/campus, SANS lean (doc)', () => {
    const q = Teacher.findOne();
    Teacher.findOne.mockClear();
    Teacher.findOne.mockReturnValueOnce(q);
    repo.findTeacherForLogin({ email: 'a@b.co' });
    expect(Teacher.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
    expect(q.populate).toHaveBeenCalledWith('department', 'name');
    expect(q.populate).toHaveBeenCalledWith('subjects', 'subject_name');
    expect(q.populate).toHaveBeenCalledWith('schoolCampus', 'campus_name');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('touchLastLogin : updateOne lastLogin (Date), atomique (pas de hooks save)', () => {
    repo.touchLastLogin('t1');
    const [filter, update] = Teacher.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 't1' });
    expect(update.$set.lastLogin).toBeInstanceOf(Date);
  });

  test('deleteTeacherById : findByIdAndDelete', () => {
    repo.deleteTeacherById('t1');
    expect(Teacher.findByIdAndDelete).toHaveBeenCalledWith('t1');
  });

  test('paginateStaffTeachers : find + count → { docs, total }, lean virtuals + classes/subjects peuplés + tri alpha', async () => {
    Teacher.__setLean([{ _id: 't1' }]);
    Teacher.countDocuments.mockReturnValueOnce(Promise.resolve(9));
    const q = Teacher.find();
    Teacher.find.mockClear();
    Teacher.find.mockReturnValueOnce(q);
    const out = await repo.paginateStaffTeachers({ schoolCampus: 'c1' }, { skip: 0, limit: 20 });
    expect(Teacher.find).toHaveBeenCalledWith({ schoolCampus: 'c1' });
    expect(q.populate).toHaveBeenCalledWith('classes', 'className');
    expect(q.populate).toHaveBeenCalledWith('subjects', 'subject_name subject_code');
    expect(q.sort).toHaveBeenCalledWith({ lastName: 1, firstName: 1 });
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
    expect(out).toEqual({ docs: [{ _id: 't1' }], total: 9 });
  });

  test('countActiveTeachers : exclut archived + borne createdSince optionnelle', () => {
    const since = new Date('2026-01-01');
    repo.countActiveTeachers('c1', { createdSince: since });
    expect(Teacher.countDocuments).toHaveBeenCalledWith({
      schoolCampus: 'c1',
      status:       { $ne: 'archived' },
      createdAt:    { $gte: since },
    });
    Teacher.countDocuments.mockClear();
    repo.countActiveTeachers('c1');
    expect(Teacher.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('findTeacherByMatriculeInCampus : filtre matricule/campus + session propagée + lean', () => {
    const q = Teacher.findOne();
    Teacher.findOne.mockClear();
    Teacher.findOne.mockReturnValueOnce(q);
    const session = { id: 'txn' };
    repo.findTeacherByMatriculeInCampus('TCH-1', 'c1', { session });
    expect(Teacher.findOne).toHaveBeenCalledWith({ matricule: 'TCH-1', schoolCampus: 'c1' });
    expect(q.select).toHaveBeenCalledWith('_id');
    expect(q.session).toHaveBeenCalledWith(session);
    expect(q.lean).toHaveBeenCalled();
  });

  test('findTeacherByMatriculeInCampus : sans session → session(null) (hors transaction)', () => {
    const q = Teacher.findOne();
    Teacher.findOne.mockClear();
    Teacher.findOne.mockReturnValueOnce(q);
    repo.findTeacherByMatriculeInCampus('TCH-1', 'c1');
    expect(q.session).toHaveBeenCalledWith(null);
  });

  test('countTeachersInCampus : countDocuments(campus) + session propagée', () => {
    const q = Teacher.countDocuments();
    Teacher.countDocuments.mockClear();
    Teacher.countDocuments.mockReturnValueOnce(q);
    repo.countTeachersInCampus('c1', { session: 's' });
    expect(Teacher.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1' });
    expect(q.session).toHaveBeenCalledWith('s');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('schedule', () => {
  test('upsertTeacherScheduleMirror : clé studentScheduleRef, reference seulement à la création ($setOnInsert)', async () => {
    await repo.upsertTeacherScheduleMirror('ssr1', { status: 'PUBLISHED' }, 'TS-REF-1');
    const [filter, update, opts] = TeacherSchedule.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ studentScheduleRef: 'ssr1' });
    expect(update.$set).toEqual({ status: 'PUBLISHED' });
    expect(update.$setOnInsert).toEqual({ reference: 'TS-REF-1' });
    expect(opts).toEqual({ upsert: true, new: true, setDefaultsOnInsert: true });
  });

  test('listTeacherTodaySessions : PUBLISHED/isDeleted + bornes gte/lte sur startTime + tri startTime asc', () => {
    const q = TeacherSchedule.find();
    TeacherSchedule.find.mockClear();
    TeacherSchedule.find.mockReturnValueOnce(q);
    const gte = new Date('2026-03-01T00:00:00Z');
    const lte = new Date('2026-03-01T23:59:59Z');
    repo.listTeacherTodaySessions('t1', { gte, lte });
    expect(TeacherSchedule.find).toHaveBeenCalledWith({
      'teacher.teacherId': 't1',
      status:    'PUBLISHED',
      isDeleted: false,
      startTime: { $gte: gte, $lte: lte },
    });
    expect(q.sort).toHaveBeenCalledWith({ startTime: 1 });
  });

  test('listTeacherPendingRollCalls : sessions passées non soumises (rollCall.submitted:false) + tri desc + limit', () => {
    const q = TeacherSchedule.find();
    TeacherSchedule.find.mockClear();
    TeacherSchedule.find.mockReturnValueOnce(q);
    const lt = new Date('2026-03-01');
    repo.listTeacherPendingRollCalls('t1', { lt, limit: 5 });
    const filter = TeacherSchedule.find.mock.calls[0][0];
    expect(filter['rollCall.submitted']).toBe(false);
    expect(filter.startTime).toEqual({ $lt: lt });
    expect(q.sort).toHaveBeenCalledWith({ startTime: -1 });
    expect(q.limit).toHaveBeenCalledWith(5);
  });

  test('detectTeacherConflicts : délègue à la statique du model', async () => {
    const args = { startTime: new Date(), endTime: new Date(), teacherId: 't1' };
    await repo.detectTeacherConflicts(args);
    expect(TeacherSchedule.detectTeacherConflicts).toHaveBeenCalledWith(args);
  });

  test('paginateTeacherSessions : find + count → { docs, total } (filtre composé amont passé tel quel)', async () => {
    TeacherSchedule.__setLean([{ _id: 'x1' }]);
    TeacherSchedule.countDocuments.mockReturnValueOnce(Promise.resolve(4));
    const out = await repo.paginateTeacherSessions({ isDeleted: false }, { skip: 0, limit: 50 });
    expect(TeacherSchedule.find).toHaveBeenCalledWith({ isDeleted: false });
    expect(out).toEqual({ docs: [{ _id: 'x1' }], total: 4 });
  });

  test('aggregateTeacherWorkload : $match teacherOid/PUBLISHED/année + group cond submitted (non-régression)', async () => {
    await repo.aggregateTeacherWorkload({ teacherOid: 'OID-T', academicYear: '2025-2026' });
    const pipeline = TeacherSchedule.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual({
      'teacher.teacherId': 'OID-T',
      status:              'PUBLISHED',
      isDeleted:           false,
      academicYear:        '2025-2026',
    });
    expect(pipeline[1].$group.totalSessions).toEqual({ $sum: 1 });
    expect(pipeline[1].$group.deliveredSessions).toEqual({ $sum: { $cond: ['$rollCall.submitted', 1, 0] } });
    expect(pipeline[1].$group.deliveredMinutes).toEqual({ $sum: { $cond: ['$rollCall.submitted', '$durationMinutes', 0] } });
  });

  test('aggregateAllTeachersWorkload : $match fourni + unwind + group + project deviation/completionRate + tri (non-régression)', async () => {
    const match = { 'workloadSnapshots.periodLabel': '2026-03', 'workloadSnapshots.periodType': 'MONTHLY', isDeleted: false };
    await repo.aggregateAllTeachersWorkload(match);
    const pipeline = TeacherSchedule.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1]).toEqual({ $unwind: '$workloadSnapshots' });
    expect(pipeline[2].$match['workloadSnapshots.periodLabel']).toBe('2026-03');
    expect(pipeline[3].$group._id).toBe('$teacher.teacherId');
    expect(pipeline[3].$group.contractHours).toEqual({ $max: '$workloadSnapshots.contractHours' });
    expect(pipeline[4].$project.deviation).toEqual({ $subtract: ['$deliveredHours', '$contractHours'] });
    expect(pipeline[4].$project.completionRate.$cond[0]).toEqual({ $gt: ['$contractHours', 0] });
    expect(pipeline[5]).toEqual({ $sort: { lastName: 1 } });
  });

  test('getTeacherCalendar / getWorkloadSummary : délèguent aux statiques', async () => {
    const start = new Date(); const end = new Date();
    await repo.getTeacherCalendar('t1', start, end, { foo: 1 });
    expect(TeacherSchedule.getTeacherCalendar).toHaveBeenCalledWith('t1', start, end, { foo: 1 });
    await repo.getWorkloadSummary('t1', '2026-03', 'MONTHLY');
    expect(TeacherSchedule.getWorkloadSummary).toHaveBeenCalledWith('t1', '2026-03', 'MONTHLY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attendance (agrégats — non-régression)', () => {
  test('aggregatePayrollReport : $match fourni + group paid/unpaid + lookup teachers + project heures + tri', async () => {
    const match = { schoolCampus: 'OID-C', attendanceDate: { $gte: new Date() } };
    await repo.aggregatePayrollReport(match);
    const pipeline = TeacherAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toBe('$teacher');
    expect(pipeline[1].$group.paidSessions).toEqual({ $sum: { $cond: ['$isPaid', 1, 0] } });
    expect(pipeline[1].$group.unpaidSessions).toEqual({ $sum: { $cond: [{ $not: '$isPaid' }, 1, 0] } });
    expect(pipeline[2].$lookup).toEqual({ from: 'teachers', localField: '_id', foreignField: '_id', as: 'teacherInfo' });
    expect(pipeline[4].$project.totalHours).toEqual({ $round: [{ $divide: ['$totalMinutes', 60] }, 2] });
    expect(pipeline[5]).toEqual({ $sort: { lastName: 1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attendance (controller)', () => {
  test('attendanceCampusOverview : 3 requêtes (page + 2 counts de périmètre) → { records, total, presentCount }', async () => {
    TeacherAttendance.__setLean([{ _id: 'r1' }]);
    TeacherAttendance.countDocuments
      .mockReturnValueOnce(Promise.resolve(30))
      .mockReturnValueOnce(Promise.resolve(18));
    const out = await repo.attendanceCampusOverview({ status: true }, { schoolCampus: 'c1' }, { skip: 0, limit: 50 });
    expect(TeacherAttendance.countDocuments).toHaveBeenNthCalledWith(1, { schoolCampus: 'c1' });
    expect(TeacherAttendance.countDocuments).toHaveBeenNthCalledWith(2, { schoolCampus: 'c1', status: true });
    expect(out).toEqual({ records: [{ _id: 'r1' }], total: 30, presentCount: 18 });
  });

  test('listSessionAttendanceRecords : populate teacher/replacement/class/schedule + tri date desc + lean', () => {
    const q = TeacherAttendance.find();
    TeacherAttendance.find.mockClear();
    TeacherAttendance.find.mockReturnValueOnce(q);
    repo.listSessionAttendanceRecords({ schedule: 'x1' });
    expect(TeacherAttendance.find).toHaveBeenCalledWith({ schedule: 'x1' });
    expect(q.populate).toHaveBeenCalledWith('replacementTeacher', 'firstName lastName email');
    expect(q.populate).toHaveBeenCalledWith('schedule', 'startTime endTime');
    expect(q.sort).toHaveBeenCalledWith({ attendanceDate: -1 });
    expect(q.lean).toHaveBeenCalled();
  });

  test('getTeacherAttendanceStats : délègue à la statique getTeacherStats', async () => {
    const out = await repo.getTeacherAttendanceStats('t1', '2025-2026', 'S2', 'all');
    expect(TeacherAttendance.getTeacherStats).toHaveBeenCalledWith('t1', '2025-2026', 'S2', 'all');
    expect(out).toEqual({ attendanceRate: 88 });
  });

  test('lockDailyTeacherAttendance : délègue à la statique lockDailyAttendance', async () => {
    const date = new Date('2026-03-01');
    const out = await repo.lockDailyTeacherAttendance(date, 'c1');
    expect(TeacherAttendance.lockDailyAttendance).toHaveBeenCalledWith(date, 'c1');
    expect(out).toEqual({ modifiedCount: 7 });
  });

  test('findRecordedScheduleIds : filtre teacher/schedule $in/bornes date + select(schedule) + lean', () => {
    const q = TeacherAttendance.find();
    TeacherAttendance.find.mockClear();
    TeacherAttendance.find.mockReturnValueOnce(q);
    const dayStart = new Date('2026-03-01T00:00:00Z');
    const dayEnd   = new Date('2026-03-01T23:59:59Z');
    repo.findRecordedScheduleIds({ teacher: 't1', scheduleIds: ['s1', 's2'], dayStart, dayEnd });
    expect(TeacherAttendance.find).toHaveBeenCalledWith({
      teacher:        't1',
      schedule:       { $in: ['s1', 's2'] },
      attendanceDate: { $gte: dayStart, $lte: dayEnd },
    });
    expect(q.select).toHaveBeenCalledWith('schedule');
    expect(q.lean).toHaveBeenCalled();
  });
});
