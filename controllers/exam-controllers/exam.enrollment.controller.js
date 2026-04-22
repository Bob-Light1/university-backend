'use strict';

/**
 * @file exam.enrollment.controller.js
 * @description Eligibility computation, hall tickets, QR check-in, and
 *              enrollment overrides for SEMS.
 *
 *  Routes (all prefixed /api/examination):
 *    POST   /enrollments/compute          → computeEligibility   [MANAGER]  body: { sessionId }
 *    GET    /sessions/:id/hall-tickets    → generateHallTickets  [MANAGER]
 *    GET    /enrollments                  → listEnrollments       query: sessionId (required)
 *    GET    /enrollments/:id              → getEnrollment
 *    PATCH  /enrollments/:id              → updateEnrollment      [MANAGER]
 *    DELETE /enrollments/:id              → deleteEnrollment      [MANAGER]
 *    GET    /enrollments/:id/hall-ticket  → getHallTicket
 *    POST   /enrollments/check-in         → checkIn
 */

const { v4: uuidv4 } = require('uuid');

const ExamSession        = require('../../models/exam-models/examSession.model');
const ExamEnrollment     = require('../../models/exam-models/examEnrollment.model');
const Student            = require('../../models/student-models/student.model');
const StudentAttendance  = require('../../models/student-models/studentAttend.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../utils/responseHelpers');
const { isValidObjectId } = require('../../utils/validationHelpers');
const {
  getCampusFilter,
  isManagerRole,
  parsePagination,
} = require('./exam.helper');

// ─── Eligibility computation ──────────────────────────────────────────────────

const computeEligibility = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { sessionId } = req.body;
    if (!sessionId || !isValidObjectId(sessionId)) {
      return sendError(res, 400, 'Valid sessionId is required in request body.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');
    if (!['SCHEDULED', 'DRAFT'].includes(session.status)) {
      return sendError(res, 400, 'Eligibility can only be computed for DRAFT or SCHEDULED sessions.');
    }

    const classIds = session.classes.map((c) => c.toString());
    const students = await Student.find({
      currentClass: { $in: classIds },
      schoolCampus: campusFilter.schoolCampus || { $exists: true },
      status:       { $ne: 'archived' },
    }).select('_id currentClass');

    const minAttendance = session.eligibilityRules?.minAttendance ?? 0;
    const created = [];
    const updated = [];

    for (const student of students) {
      let isEligible      = true;
      let eligibilityNotes = '';

      if (minAttendance > 0) {
        const stats = StudentAttendance.getStudentStats
          ? await StudentAttendance.getStudentStats(student._id, session.academicYear, session.semester, 'year')
          : { attendanceRate: 100 };

        const rate = stats?.attendanceRate ?? 100;
        if (rate < minAttendance) {
          isEligible       = false;
          eligibilityNotes = `Attendance ${rate.toFixed(1)}% is below the required ${minAttendance}%.`;
        }
      }

      const existing = await ExamEnrollment.findOne({
        examSession: sessionId,
        student:     student._id,
        isDeleted:   false,
      });

      if (existing) {
        existing.isEligible       = isEligible;
        existing.eligibilityNotes = eligibilityNotes;
        existing.updatedBy        = req.user.id;
        await existing.save();
        updated.push(existing._id);
      } else {
        const enrollment = await ExamEnrollment.create({
          schoolCampus:    campusFilter.schoolCampus || session.schoolCampus,
          examSession:     sessionId,
          student:         student._id,
          isEligible,
          eligibilityNotes,
          hallTicketToken: uuidv4(),
          createdBy:       req.user.id,
        });
        created.push(enrollment._id);
      }
    }

    return sendSuccess(res, 200, 'Eligibility computed.', {
      total:   students.length,
      created: created.length,
      updated: updated.length,
    });
  } catch (err) {
    console.error('❌ computeEligibility:', err);
    return sendError(res, 500, 'Failed to compute eligibility.');
  }
};

// ─── List enrollments ─────────────────────────────────────────────────────────

const listEnrollments = async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId || !isValidObjectId(sessionId)) {
      return sendError(res, 400, 'Valid sessionId query parameter is required.');
    }

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: sessionId, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const { page, limit, skip } = parsePagination(req.query);
    const match = { examSession: sessionId, isDeleted: false };
    if (req.query.isEligible !== undefined) match.isEligible = req.query.isEligible === 'true';
    if (req.query.attendance) match.attendance = req.query.attendance;

    const [enrollments, total] = await Promise.all([
      ExamEnrollment.find(match)
        .populate('student', 'firstName lastName matricule profileImage')
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ExamEnrollment.countDocuments(match),
    ]);

    return sendPaginated(res, 200, 'Enrollments retrieved.', enrollments, { total, page, limit });
  } catch (err) {
    console.error('❌ listEnrollments:', err);
    return sendError(res, 500, 'Failed to retrieve enrollments.');
  }
};

// ─── Get single enrollment ────────────────────────────────────────────────────

const getEnrollment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid enrollment ID.');

    const enrollment = await ExamEnrollment.findOne({ _id: id, isDeleted: false })
      .populate('student', 'firstName lastName matricule profileImage')
      .populate({
        path:     'examSession',
        populate: { path: 'subject', select: 'subject_name' },
      });

    if (!enrollment) return sendNotFound(res, 'Enrollment');

    // Students can only view their own enrollment
    if (
      req.user.role === 'STUDENT' &&
      enrollment.student._id.toString() !== req.user.id
    ) {
      return sendError(res, 403, 'You can only view your own enrollment.');
    }

    return sendSuccess(res, 200, 'Enrollment retrieved.', enrollment);
  } catch (err) {
    console.error('❌ getEnrollment:', err);
    return sendError(res, 500, 'Failed to retrieve enrollment.');
  }
};

// ─── Update enrollment (force-enroll / special needs / override) ──────────────

const updateEnrollment = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid enrollment ID.');

    const enrollment = await ExamEnrollment.findOne({ _id: id, isDeleted: false });
    if (!enrollment) return sendNotFound(res, 'Enrollment');

    const ALLOWED = ['isEligible', 'eligibilityNotes', 'seatNumber', 'specialNeeds', 'attendance'];
    const updates = {};
    ALLOWED.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    updates.updatedBy = req.user.id;

    const updated = await ExamEnrollment.findByIdAndUpdate(id, { $set: updates }, { new: true })
      .populate('student', 'firstName lastName matricule');

    return sendSuccess(res, 200, 'Enrollment updated.', updated);
  } catch (err) {
    console.error('❌ updateEnrollment:', err);
    return sendError(res, 500, 'Failed to update enrollment.');
  }
};

// ─── Delete enrollment (soft-delete) ─────────────────────────────────────────

const deleteEnrollment = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid enrollment ID.');

    const enrollment = await ExamEnrollment.findOne({ _id: id, isDeleted: false });
    if (!enrollment) return sendNotFound(res, 'Enrollment');

    // Cannot delete enrollment once exam is ONGOING or COMPLETED
    const session = await ExamSession.findById(enrollment.examSession, 'status');
    if (session && ['ONGOING', 'COMPLETED'].includes(session.status)) {
      return sendError(res, 400, 'Cannot delete enrollment for an ongoing or completed exam.');
    }

    await ExamEnrollment.findByIdAndUpdate(id, { isDeleted: true, updatedBy: req.user.id });
    return sendSuccess(res, 200, 'Enrollment deleted.');
  } catch (err) {
    console.error('❌ deleteEnrollment:', err);
    return sendError(res, 500, 'Failed to delete enrollment.');
  }
};

// ─── Hall ticket generation (bulk) ───────────────────────────────────────────

const generateHallTickets = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { id } = req.params; // sessionId
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await ExamSession.findOne({ _id: id, ...campusFilter, isDeleted: false })
      .populate('subject', 'subject_name')
      .populate('classes', 'name');
    if (!session) return sendNotFound(res, 'Exam session');

    const enrollments = await ExamEnrollment.find({
      examSession: id,
      isEligible:  true,
      isDeleted:   false,
    }).populate('student', 'firstName lastName matricule profileImage');

    const ticketData = [];
    for (const enr of enrollments) {
      if (!enr.hallTicketToken) {
        enr.hallTicketToken = uuidv4();
        await enr.save();
      }
      ticketData.push({
        enrollmentId:    enr._id,
        studentId:       enr.student._id,
        studentName:     `${enr.student.firstName} ${enr.student.lastName}`,
        matricule:       enr.student.matricule,
        hallTicketToken: enr.hallTicketToken,
        seatNumber:      enr.seatNumber,
        sessionTitle:    session.title,
        subject:         session.subject?.subject_name,
        startTime:       session.startTime,
        room:            session.room,
        specialNeeds:    enr.specialNeeds,
      });
    }

    return sendSuccess(res, 200, 'Hall tickets generated.', {
      sessionId: id,
      count:     ticketData.length,
      tickets:   ticketData,
    });
  } catch (err) {
    console.error('❌ generateHallTickets:', err);
    return sendError(res, 500, 'Failed to generate hall tickets.');
  }
};

// ─── Get single hall ticket ───────────────────────────────────────────────────

const getHallTicket = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid enrollment ID.');

    const enrollment = await ExamEnrollment.findOne({ _id: id, isDeleted: false })
      .populate('student', 'firstName lastName matricule profileImage')
      .populate({
        path:     'examSession',
        populate: { path: 'subject', select: 'subject_name' },
      });

    if (!enrollment) return sendNotFound(res, 'Enrollment');

    if (
      req.user.role === 'STUDENT' &&
      enrollment.student._id.toString() !== req.user.id
    ) {
      return sendError(res, 403, 'You can only access your own hall ticket.');
    }

    return sendSuccess(res, 200, 'Hall ticket retrieved.', {
      enrollmentId:    enrollment._id,
      student:         enrollment.student,
      hallTicketToken: enrollment.hallTicketToken,
      seatNumber:      enrollment.seatNumber,
      isEligible:      enrollment.isEligible,
      session:         enrollment.examSession,
      specialNeeds:    enrollment.specialNeeds,
    });
  } catch (err) {
    console.error('❌ getHallTicket:', err);
    return sendError(res, 500, 'Failed to retrieve hall ticket.');
  }
};

// ─── QR check-in ─────────────────────────────────────────────────────────────

const checkIn = async (req, res) => {
  try {
    const { token, sessionId } = req.body;
    if (!token || !sessionId) return sendError(res, 400, 'token and sessionId are required.');
    if (!isValidObjectId(sessionId)) return sendError(res, 400, 'Invalid sessionId.');

    const enrollment = await ExamEnrollment.findOne({
      examSession:     sessionId,
      hallTicketToken: token,
      isDeleted:       false,
    }).populate('student', 'firstName lastName matricule');

    if (!enrollment) {
      return sendError(res, 404, 'Invalid or already used hall ticket.');
    }
    if (!enrollment.isEligible) {
      return sendError(res, 403, `Student is not eligible: ${enrollment.eligibilityNotes || 'No reason specified.'}`);
    }
    if (enrollment.identityVerified) {
      return sendError(res, 409, 'This hall ticket has already been used for check-in.');
    }

    enrollment.consumeHallTicket();
    enrollment.checkedInBy = req.user.id;
    enrollment.attendance  = 'PRESENT';
    enrollment.updatedBy   = req.user.id;
    await enrollment.save();

    return sendSuccess(res, 200, 'Check-in successful.', {
      student:      enrollment.student,
      seatNumber:   enrollment.seatNumber,
      checkedInAt:  enrollment.checkedInAt,
      specialNeeds: enrollment.specialNeeds,
    });
  } catch (err) {
    console.error('❌ checkIn:', err);
    return sendError(res, 500, 'Check-in failed.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  computeEligibility,
  listEnrollments,
  getEnrollment,
  updateEnrollment,
  deleteEnrollment,
  generateHallTickets,
  getHallTicket,
  checkIn,
};
