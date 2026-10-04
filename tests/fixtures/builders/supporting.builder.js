'use strict';

/**
 * @file supporting.builder.js
 * @description Deterministic GAET, inbox, preferences, print and transcript rows.
 * No workers or delivery channels run while building these synthetic records.
 */
const { oid, pad, stamps } = require('../ids');
const { model } = require('../models');
const { COUNTS, CAMPUS_KEYS, ACADEMIC_YEAR } = require('../seed.config');
const { WEEKDAY, SEMESTER, SESSION_TYPE } = require('../../../shared/utils/schedule.base');

/** Build the supporting collections after actors and academic structure exist. */
const build = (ctx) => {
  const groups = Object.fromEntries([
    'GaetConstraint', 'Notification', 'UserPreferences', 'PrintJob', 'FinalTranscript',
  ].map(name => [name, []]));
  const Gaet = model('GaetConstraint');

  for (const key of CAMPUS_KEYS) {
    const campusId = ctx.campusIds[key];
    const counts = COUNTS[key];
    const rows = (count, callback) => Array.from({ length: count }, (_, i) => callback(i, pad(i + 1)));
    groups.GaetConstraint.push(...rows(counts.gaetConstraints, (i, n) => ({
      _id: oid(`gaet:${key}:${n}`), schoolCampus: campusId,
      academicYear: ACADEMIC_YEAR, semester: [SEMESTER.S1, SEMESTER.S2][i],
      semesterStartDate: ctx.at(-90), status: Gaet.GAET_STATUS.DRAFT,
      timeSlots: [{ day: WEEKDAY.MO, startHour: 8, endHour: 10 }],
      teacherPreferences: [{
        _id: oid(`gaet-preference:${key}:${n}`), teacherId: ctx.teachers[key][0]._id,
        preferredDays: [WEEKDAY.MO], unavailableSlots: [],
      }],
      courseRequirements: [{
        _id: oid(`gaet-course:${key}:${n}`), classId: ctx.students[key][0].studentClass,
        subjectId: oid(`subject:${key}:001`), teacherId: ctx.teachers[key][0]._id,
        sessionType: SESSION_TYPE.LECTURE, hoursPerWeek: 2, sessionDuration: 120,
        studentCount: ctx.studentsByClass[String(ctx.students[key][0].studentClass)].length,
        roomType: Gaet.ROOM_TYPE.CLASSROOM,
      }],
      roomRegistry: [{
        _id: oid(`gaet-room:${key}:${n}`), name: `Fixture room ${key}${n}`,
        capacity: 30, type: Gaet.ROOM_TYPE.CLASSROOM,
      }],
      ...stamps(10),
    })));
    groups.Notification.push(...rows(counts.notifications, (i, n) => ({
      _id: oid(`notification:${key}:${n}`), schoolCampus: campusId,
      recipientId: ctx.students[key][i]._id, recipientModel: 'Student',
      channel: 'inapp', template: 'generic', locale: key === 'A' ? 'fr' : 'en',
      subject: `Fixture notice ${key}${n}`, body: 'Synthetic inbox content.',
      data: { subject: `Fixture notice ${key}${n}`, body: 'Synthetic inbox content.' },
      status: i === 0 ? 'sent' : 'read', sentAt: ctx.at(-2),
      readAt: i === 0 ? null : ctx.at(-1), ...stamps(2),
    })));
    groups.UserPreferences.push(...rows(counts.userPreferences, (i, n) => ({
      _id: oid(`preferences:${key}:${n}`), campusId,
      userId: ctx.students[key][i]._id, userModel: 'Student',
      preferredLanguage: key === 'A' ? 'fr' : 'en', timezone: 'Africa/Douala',
      ...stamps(20),
    })));
    groups.PrintJob.push(...rows(counts.printJobs, (i, n) => ({
      _id: oid(`print-job:${key}:${n}`), campusId, type: 'TRANSCRIPT', status: 'CANCELLED',
      requestedBy: campusId,
      targets: [{ id: String(ctx.students[key][i]._id), name: `Fixture student ${key}${n}` }],
      progress: { total: 1, done: 0, failed: 0 },
      completedAt: ctx.at(-1), ...stamps(2),
    })));
    groups.FinalTranscript.push(...rows(counts.finalTranscripts, (i, n) => ({
      _id: oid(`transcript:${key}:${n}`), schoolCampus: campusId,
      student: ctx.students[key][i]._id, class: ctx.students[key][i].studentClass,
      academicYear: ACADEMIC_YEAR, semester: SEMESTER.S1,
      generatedBy: String(campusId), generatedAt: ctx.at(-1), ...stamps(1),
    })));
  }
  return Object.entries(groups).map(([name, docs]) => ({ model: name, docs }));
};

module.exports = { build };
