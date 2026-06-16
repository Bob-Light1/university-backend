'use strict';

/**
 * Couche repository — module student (R3, cœur académique ; 3 models).
 * Models mockés (sans DB) : Student, StudentSchedule, StudentAttendance.
 *
 * jest.mock impose des chemins littéraux + une factory auto-suffisante (hoisting :
 * buildModelMock est une déclaration de fonction, donc hissée). Chaque model est
 * un constructeur doté de statiques jest.fn ; les queries sont chaînables
 * (select/sort/skip/limit/populate/session) et .lean/.exec résolvent __setLean.
 *
 * Accent mis sur les agrégats (non-régression des sorties teacher/student/result)
 * et les formes de requête sensibles (sessions de transaction, hooks de cascade,
 * bulkWrite d'init de feuille d'appel).
 */

const buildModelMock = () => {
  let leanVal = null;
  let deleteVal = { _id: 'd' };
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
  ['find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete'].forEach((m) => {
    Model[m] = jest.fn(() => makeQuery());
  });
  Model.findOneAndDelete = jest.fn(() => Promise.resolve(deleteVal));
  Model.countDocuments = jest.fn(() => makeQuery());
  Model.aggregate = jest.fn(() => Promise.resolve([]));
  Model.create = jest.fn((d) => Promise.resolve({ _id: 'created', ...d }));
  Model.bulkWrite = jest.fn(() => Promise.resolve({ upsertedCount: 3, matchedCount: 1 }));
  Model.updateMany = jest.fn(() => Promise.resolve({ modifiedCount: 5 }));
  Model.getStudentStats = jest.fn(() => Promise.resolve({ attendanceRate: 42 }));
  Model.getClassStats = jest.fn(() => Promise.resolve({ rate: 80 }));
  Model.lockDailyAttendance = jest.fn(() => Promise.resolve({ modifiedCount: 9 }));
  Model.detectConflicts = jest.fn(() => Promise.resolve({ hasConflict: false, conflicts: [] }));
  Model.__setLean = (v) => { leanVal = v; };
  Model.__setDelete = (v) => { deleteVal = v; };
  return Model;
};

jest.mock('../../modules/student/models/student.model', () => buildModelMock());
jest.mock('../../modules/student/models/student.schedule.model', () => buildModelMock());
jest.mock('../../modules/student/models/student.attend.model', () => buildModelMock());

const Student           = require('../../modules/student/models/student.model');
const StudentSchedule   = require('../../modules/student/models/student.schedule.model');
const StudentAttendance = require('../../modules/student/models/student.attend.model');
const repo = require('../../modules/student/student.repository');

beforeEach(() => {
  jest.clearAllMocks();
  [Student, StudentSchedule, StudentAttendance].forEach((M) => {
    M.__setLean(null);
    M.__setDelete({ _id: 'd' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('student', () => {
  test('findStudentForLogin : findOne(query) + select(+password) + populate campus, SANS lean (doc)', () => {
    const q = Student.findOne();
    Student.findOne.mockClear();
    Student.findOne.mockReturnValueOnce(q);
    repo.findStudentForLogin({ email: 'a@b.co' });
    expect(Student.findOne).toHaveBeenCalledWith({ email: 'a@b.co' });
    expect(q.select).toHaveBeenCalledWith('+password');
    expect(q.populate).toHaveBeenCalledWith('schoolCampus', 'campus_name');
    expect(q.lean).not.toHaveBeenCalled();
  });

  test('touchLastLogin : findByIdAndUpdate lastLogin (Date) + exec, atomique', () => {
    const q = Student.findByIdAndUpdate();
    Student.findByIdAndUpdate.mockClear();
    Student.findByIdAndUpdate.mockReturnValueOnce(q);
    repo.touchLastLogin('s1');
    const [id, update] = Student.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('s1');
    expect(update.lastLogin).toBeInstanceOf(Date);
    expect(q.exec).toHaveBeenCalled();
  });

  test('deleteStudentById : findByIdAndDelete (déclenche le hook de cascade parent)', () => {
    repo.deleteStudentById('s1');
    expect(Student.findByIdAndDelete).toHaveBeenCalledWith('s1');
  });

  test('paginateStudentsForStaff : find + count → { docs, total }, lean virtuals + classe peuplée', async () => {
    Student.__setLean([{ _id: 's1' }]);
    Student.countDocuments.mockReturnValueOnce(Promise.resolve(12));
    const q = Student.find();
    Student.find.mockClear();
    Student.find.mockReturnValueOnce(q);
    const out = await repo.paginateStudentsForStaff({ schoolCampus: 'c1' }, { skip: 0, limit: 20 });
    expect(Student.find).toHaveBeenCalledWith({ schoolCampus: 'c1' });
    expect(q.populate).toHaveBeenCalledWith('studentClass', 'className');
    expect(q.lean).toHaveBeenCalledWith({ virtuals: true });
    expect(out).toEqual({ docs: [{ _id: 's1' }], total: 12 });
  });

  test('countStudents : transmet le filtre composé tel quel', () => {
    Student.countDocuments.mockReturnValueOnce(Promise.resolve(0));
    repo.countStudents({ schoolCampus: 'c1', status: { $ne: 'archived' } });
    expect(Student.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1', status: { $ne: 'archived' } });
  });

  test('findStudentByMatriculeInCampus : filtre matricule/campus + session propagée + lean', () => {
    const q = Student.findOne();
    Student.findOne.mockClear();
    Student.findOne.mockReturnValueOnce(q);
    const session = { id: 'txn' };
    repo.findStudentByMatriculeInCampus('STD-1', 'c1', { session });
    expect(Student.findOne).toHaveBeenCalledWith({ matricule: 'STD-1', schoolCampus: 'c1' });
    expect(q.select).toHaveBeenCalledWith('_id');
    expect(q.session).toHaveBeenCalledWith(session);
    expect(q.lean).toHaveBeenCalled();
  });

  test('countStudentsInCampus : countDocuments(campus) + session propagée', () => {
    const q = Student.countDocuments();
    Student.countDocuments.mockClear();
    Student.countDocuments.mockReturnValueOnce(q);
    repo.countStudentsInCampus('c1', { session: 's' });
    expect(Student.countDocuments).toHaveBeenCalledWith({ schoolCampus: 'c1' });
    expect(q.session).toHaveBeenCalledWith('s');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('schedule', () => {
  test('listPublishedSessionsInWindow : filtre classe/campus/PUBLISHED/isDeleted + bornes start/end + sessionType + select', () => {
    const q = StudentSchedule.find();
    StudentSchedule.find.mockClear();
    StudentSchedule.find.mockReturnValueOnce(q);
    const start = new Date('2026-01-01');
    const end   = new Date('2026-01-08');
    repo.listPublishedSessionsInWindow({ classId: 'k1', campusId: 'c1', start, end, sessionType: 'LECTURE', select: '-__v' });
    expect(StudentSchedule.find).toHaveBeenCalledWith({
      'classes.classId': 'k1',
      schoolCampus:      'c1',
      startTime:         { $gte: start },
      endTime:           { $lte: end },
      status:            'PUBLISHED',
      isDeleted:         false,
      sessionType:       'LECTURE',
    });
    expect(q.sort).toHaveBeenCalledWith({ startTime: 1 });
    expect(q.select).toHaveBeenCalledWith('-__v');
  });

  test('listClassPublishedSessionsByStart : bornes gte/gt/lte sur startTime + limit', () => {
    const q = StudentSchedule.find();
    StudentSchedule.find.mockClear();
    StudentSchedule.find.mockReturnValueOnce(q);
    const gt = new Date('2026-02-01');
    const lte = new Date('2026-02-08');
    repo.listClassPublishedSessionsByStart({ classId: 'k1', campusId: 'c1', gt, lte, limit: 8 });
    const filter = StudentSchedule.find.mock.calls[0][0];
    expect(filter.startTime).toEqual({ $gt: gt, $lte: lte });
    expect(filter.status).toBe('PUBLISHED');
    expect(filter.isDeleted).toBe(false);
    expect(q.limit).toHaveBeenCalledWith(8);
  });

  test('softDeleteScheduleSession : findOneAndUpdate scopé { isDeleted:false + campus } → isDeleted:true, new:true', async () => {
    await repo.softDeleteScheduleSession('x1', { schoolCampus: 'c1' }, 'actor1');
    const [filter, update, opts] = StudentSchedule.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'x1', isDeleted: false, schoolCampus: 'c1' });
    expect(update.isDeleted).toBe(true);
    expect(update.deletedBy).toBe('actor1');
    expect(update.deletedAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ new: true });
  });

  test('detectScheduleConflicts : délègue à la statique detectConflicts', async () => {
    const args = { startTime: new Date(), endTime: new Date(), classIds: ['k1'] };
    await repo.detectScheduleConflicts(args);
    expect(StudentSchedule.detectConflicts).toHaveBeenCalledWith(args);
  });

  test('paginateScheduleSessions : find + count → { docs, total }', async () => {
    StudentSchedule.__setLean([{ _id: 'x1' }]);
    StudentSchedule.countDocuments.mockReturnValueOnce(Promise.resolve(4));
    const out = await repo.paginateScheduleSessions({ isDeleted: false }, { skip: 0, limit: 50 });
    expect(out).toEqual({ docs: [{ _id: 'x1' }], total: 4 });
  });

  test('aggregateRoomOccupancy : $match fourni injecté + group/project de non-régression', async () => {
    const match = { isDeleted: false, 'room.code': { $exists: true } };
    await repo.aggregateRoomOccupancy(match);
    const pipeline = StudentSchedule.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: match });
    expect(pipeline[1].$group._id).toBe('$room.code');
    expect(pipeline[1].$group.totalMinutes).toEqual({ $sum: '$durationMinutes' });
    expect(pipeline[2].$project.roomCode).toBe('$_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attendance (agrégats — non-régression)', () => {
  test('summarizeStudentAttendance : $match caste student/campus en ObjectId + group present/absent', async () => {
    await repo.summarizeStudentAttendance({ studentId: '64b1c0000000000000000001', campusId: '64b1c0000000000000000002', academicYear: '2025-2026' });
    const pipeline = StudentAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.student.constructor.name).toBe('ObjectId');
    expect(pipeline[0].$match.schoolCampus.constructor.name).toBe('ObjectId');
    expect(pipeline[0].$match.academicYear).toBe('2025-2026');
    expect(pipeline[1].$group.presentCount).toEqual({ $sum: { $cond: [{ $eq: ['$status', true] }, 1, 0] } });
    expect(pipeline[1].$group.justifiedAbsences).toBeUndefined();
  });

  test('summarizeStudentAttendance : includeJustified ajoute justifiedAbsences', async () => {
    await repo.summarizeStudentAttendance({ studentId: '64b1c0000000000000000001', campusId: '64b1c0000000000000000002', includeJustified: true });
    const pipeline = StudentAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[1].$group.justifiedAbsences).toEqual({ $sum: { $cond: ['$isJustified', 1, 0] } });
  });

  test('aggregateStudentYearAttendance : $match student/campus/année (déjà castés) + group', async () => {
    const studentOid = 'OID-S'; const campusOid = 'OID-C';
    await repo.aggregateStudentYearAttendance({ studentOid, campusOid, academicYear: '2025-2026' });
    const pipeline = StudentAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { student: studentOid, schoolCampus: campusOid, academicYear: '2025-2026' } });
    expect(pipeline[1].$group.totalSessions).toEqual({ $sum: 1 });
  });

  test('summarizeAttendanceTotals : present comparé à la CHAÎNE "present" (sémantique historique) + classIds optionnel', async () => {
    await repo.summarizeAttendanceTotals({ campusId: 'c1', classIds: ['k1', 'k2'] });
    const pipeline = StudentAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual({ schoolCampus: 'c1', class: { $in: ['k1', 'k2'] } });
    expect(pipeline[1].$group.present).toEqual({ $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } });
  });

  test('getAvgAbsenceRateForCampus : double $group (par student puis moyenne du taux)', async () => {
    await repo.getAvgAbsenceRateForCampus('OID');
    const pipeline = StudentAttendance.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { schoolCampus: 'OID' } });
    expect(pipeline[1].$group._id).toBe('$student');
    expect(pipeline[2].$group.avgAbsenceRate.$avg).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('attendance (controller)', () => {
  test('initSessionAttendanceRecords : bulkWrite $setOnInsert/upsert + renvoie { upsertedCount, matchedCount }', async () => {
    const out = await repo.initSessionAttendanceRecords({
      students: [{ _id: 's1' }, { _id: 's2' }],
      scheduleId: '64b1c0000000000000000010',
      classId:    '64b1c0000000000000000011',
      campusId:   '64b1c0000000000000000012',
      subjectId:  '64b1c0000000000000000013',
      attendanceDate: new Date('2026-03-01'),
      academicYear: '2025-2026',
      semester: 'S2',
      recordedBy: 'teacher1',
    });
    const [ops, opts] = StudentAttendance.bulkWrite.mock.calls[0];
    expect(ops).toHaveLength(2);
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(ops[0].updateOne.update.$setOnInsert.status).toBe(false);
    expect(ops[0].updateOne.update.$setOnInsert.recordedBy).toBe('teacher1');
    expect(opts).toEqual({ ordered: false });
    expect(out).toEqual({ upsertedCount: 3, matchedCount: 1 });
  });

  test('lockSessionAttendance : updateMany $set isLocked + renvoie { modifiedCount }', async () => {
    const out = await repo.lockSessionAttendance({ schedule: 'x1' }, 'actor1');
    const [filter, update] = StudentAttendance.updateMany.mock.calls[0];
    expect(filter).toEqual({ schedule: 'x1' });
    expect(update.$set.isLocked).toBe(true);
    expect(update.$set.lastModifiedBy).toBe('actor1');
    expect(out).toEqual({ modifiedCount: 5 });
  });

  test('attendanceCampusOverview : 3 requêtes (page + 2 counts de périmètre) → { records, total, presentCount }', async () => {
    StudentAttendance.__setLean([{ _id: 'r1' }]);
    StudentAttendance.countDocuments
      .mockReturnValueOnce(Promise.resolve(30))
      .mockReturnValueOnce(Promise.resolve(20));
    const out = await repo.attendanceCampusOverview({ status: true }, { schoolCampus: 'c1' }, { skip: 0, limit: 50 });
    expect(StudentAttendance.countDocuments).toHaveBeenNthCalledWith(1, { schoolCampus: 'c1' });
    expect(StudentAttendance.countDocuments).toHaveBeenNthCalledWith(2, { schoolCampus: 'c1', status: true });
    expect(out).toEqual({ records: [{ _id: 'r1' }], total: 30, presentCount: 20 });
  });

  test('toggleAttendanceStatus / addAttendanceJustification : délèguent aux méthodes d\'instance du doc', () => {
    const record = { toggleStatus: jest.fn(() => Promise.resolve()), addJustification: jest.fn(() => Promise.resolve()) };
    repo.toggleAttendanceStatus(record, true, 'u1');
    expect(record.toggleStatus).toHaveBeenCalledWith(true, 'u1');
    repo.addAttendanceJustification(record, 'malade', 'u1', 'doc.pdf');
    expect(record.addJustification).toHaveBeenCalledWith('malade', 'u1', 'doc.pdf');
  });

  test('getStudentAttendanceStats : utilise la statique getStudentStats si présente', async () => {
    const out = await repo.getStudentAttendanceStats('s1', '2025-2026', 'S2', 'all');
    expect(StudentAttendance.getStudentStats).toHaveBeenCalledWith('s1', '2025-2026', 'S2', 'all');
    expect(out).toEqual({ attendanceRate: 42 });
  });

  test('getStudentAttendanceStats : repli { attendanceRate: 100 } si la statique est absente', async () => {
    const saved = StudentAttendance.getStudentStats;
    StudentAttendance.getStudentStats = undefined;
    const out = await repo.getStudentAttendanceStats('s1', '2025-2026', 'S2', 'all');
    expect(out).toEqual({ attendanceRate: 100 });
    StudentAttendance.getStudentStats = saved;
  });
});
