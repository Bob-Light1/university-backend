'use strict';

/**
 * @file exam_certificate_controller.js
 * @description Digital certificate generation and public QR verification.
 *
 *  Routes (all prefixed /api/examination):
 *    POST  /certificates/generate/:gradingId  → generateCertificate  [MANAGER]
 *    GET   /certificates/:token/verify        → verifyCertificate    (public)
 */

const { v4: uuidv4 } = require('uuid');
const ExamGrading = require('../../models/exam-models/examGrading.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../utils/responseHelpers');
const { isValidObjectId } = require('../../utils/validationHelpers');
const { getCampusFilter, isManagerRole } = require('./exam.helper');

// In-memory token store is sufficient for MVP — persisted on ExamGrading via certificateToken.
// Production: store token as indexed field on ExamGrading.

// ─── Generate certificate ─────────────────────────────────────────────────────

const generateCertificate = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const { gradingId } = req.params;
    if (!isValidObjectId(gradingId)) return sendError(res, 400, 'Invalid grading ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const grading = await ExamGrading.findOne({ _id: gradingId, isDeleted: false })
      .populate('student',     'firstName lastName matricule schoolCampus')
      .populate('examSession', 'title subject academicYear semester examPeriod startTime maxScore');

    if (!grading) return sendNotFound(res, 'Grading');
    if (grading.status !== 'PUBLISHED') {
      return sendError(res, 400, 'Certificates can only be generated for PUBLISHED grades.');
    }

    // Campus scope check
    const gradingCampus = grading.schoolCampus?.toString();
    const filterCampus  = campusFilter.schoolCampus?.toString();
    if (filterCampus && gradingCampus !== filterCampus) {
      return sendError(res, 403, 'Access denied: grading belongs to a different campus.');
    }

    // Idempotent — reuse existing token
    if (grading.certificateToken) {
      return sendSuccess(res, 200, 'Certificate already generated.', {
        token:       grading.certificateToken,
        verifyUrl:   `/api/examination/certificates/${grading.certificateToken}/verify`,
        certificate: _buildCertificateData(grading),
      });
    }

    const token = uuidv4();
    grading.certificateToken = token;
    grading.updatedBy        = req.user.id;
    await grading.save();

    return sendSuccess(res, 201, 'Certificate generated.', {
      token,
      verifyUrl:   `/api/examination/certificates/${token}/verify`,
      certificate: _buildCertificateData(grading),
    });
  } catch (err) {
    console.error('❌ generateCertificate:', err);
    return sendError(res, 500, 'Failed to generate certificate.');
  }
};

// ─── Public verification ──────────────────────────────────────────────────────

const verifyCertificate = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return sendError(res, 400, 'Token is required.');

    const grading = await ExamGrading.findOne({ certificateToken: token })
      .populate('student',     'firstName lastName matricule')
      .populate('examSession', 'title subject academicYear semester examPeriod startTime');

    if (!grading) {
      return sendError(res, 404, 'Certificate not found or invalid token.');
    }

    return sendSuccess(res, 200, 'Certificate verified.', {
      valid:       true,
      certificate: _buildCertificateData(grading),
      verifiedAt:  new Date(),
    });
  } catch (err) {
    console.error('❌ verifyCertificate:', err);
    return sendError(res, 500, 'Verification failed.');
  }
};

// ─── Helper ───────────────────────────────────────────────────────────────────

const _buildCertificateData = (grading) => ({
  student: {
    name:      `${grading.student?.firstName} ${grading.student?.lastName}`,
    matricule: grading.student?.matricule,
  },
  exam: {
    title:        grading.examSession?.title,
    academicYear: grading.examSession?.academicYear,
    semester:     grading.examSession?.semester,
    examPeriod:   grading.examSession?.examPeriod,
    date:         grading.examSession?.startTime,
  },
  result: {
    finalScore:      grading.finalScore,
    normalizedScore: grading.normalizedScore,
    maxScore:        grading.maxScore,
    status:          grading.status,
    publishedAt:     grading.publishedAt,
  },
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  generateCertificate,
  verifyCertificate,
};
