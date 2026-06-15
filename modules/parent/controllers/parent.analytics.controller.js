
/**
 * @file parent_analytics_controller.js
 * @description Analytics & reporting endpoints for the Parent Management Module.
 *
 *  All endpoints require a manager-level or higher role (ADMIN / DIRECTOR /
 *  CAMPUS_MANAGER).  PARENT role cannot call these routes.
 *
 *  Routes handled:
 *  ─────────────────────────────────────────────────────────────────────────────
 *  GET /api/parents/stats                       → getParentStats       (global)
 *  GET /api/parents/stats/campus/:campusId      → getCampusParentStats (per-campus)
 *  GET /api/parents/by-student/:studentId       → getParentsByStudent
 */

const mongoose = require('mongoose');

const parentRepo = require('../parent.repository');
const {
  sendSuccess,
  sendError,
} = require('../../../shared/utils/response-helpers');
const { buildCampusFilter } = require('../../../shared/utils/validation-helpers');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Wraps buildCampusFilter and surfaces 403 for scope violations.
 * (Le cast schoolCampus → ObjectId pour les pipelines d'agrégation est fait
 *  dans parent.repository.)
 */
const getCampusFilter = (user, requestedCampusId) => {
  try {
    return buildCampusFilter(user, requestedCampusId);
  } catch (err) {
    err.statusCode = 403;
    throw err;
  }
};

// ── PLATFORM-WIDE PARENT STATS ────────────────────────────────────────────────

/**
 * @route  GET /api/parents/stats
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getParentStats = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req.user, req.query.campusId);

    const [statusBreakdown, relationshipBreakdown, recentCount, archivedCount] =
      await Promise.all([
        parentRepo.aggregateStatusBreakdown(campusFilter),
        parentRepo.aggregateRelationshipBreakdown(campusFilter),
        parentRepo.countRecent(campusFilter, new Date(Date.now() - 30 * DAY_MS)),
        parentRepo.countArchived(campusFilter),
      ]);

    const total  = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
    const status = Object.fromEntries(statusBreakdown.map((s) => [s._id, s.count]));
    const byRelationship = Object.fromEntries(
      relationshipBreakdown.map((r) => [r._id, r.count])
    );

    return sendSuccess(res, 200, 'Parent statistics retrieved successfully.', {
      total,
      archived:      archivedCount,
      recentLast30d: recentCount,
      byStatus:      status,
      byRelationship,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getParentStats error:', error);
    return sendError(res, 500, 'Failed to retrieve parent statistics.');
  }
};

// ── PER-CAMPUS PARENT STATS ───────────────────────────────────────────────────

/**
 * @route  GET /api/parents/stats/campus/:campusId
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getCampusParentStats = async (req, res) => {
  try {
    const { campusId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(campusId)) {
      return sendError(res, 400, 'Invalid campus ID.');
    }

    // Enforce isolation: CAMPUS_MANAGER may only query their own campus
    const campusFilter = getCampusFilter(req.user, campusId);

    const [
      statusBreakdown,
      relationshipBreakdown,
      genderBreakdown,
      childrenDistribution,
      monthlyRegistrations,
      recentCount,
    ] = await Promise.all([
      parentRepo.aggregateStatusBreakdown(campusFilter),
      parentRepo.aggregateRelationshipBreakdown(campusFilter),
      parentRepo.aggregateGenderBreakdown(campusFilter),
      parentRepo.aggregateChildrenDistribution(campusFilter),
      parentRepo.aggregateMonthlyRegistrations(campusFilter, new Date(Date.now() - 365 * DAY_MS)),
      parentRepo.countRecent(campusFilter, new Date(Date.now() - 30 * DAY_MS)),
    ]);

    const total  = statusBreakdown.reduce((sum, s) => sum + s.count, 0);

    return sendSuccess(res, 200, 'Campus parent statistics retrieved successfully.', {
      campusId,
      total,
      recentLast30d:  recentCount,
      byStatus:       Object.fromEntries(statusBreakdown.map((s) => [s._id, s.count])),
      byRelationship: Object.fromEntries(relationshipBreakdown.map((r) => [r._id, r.count])),
      byGender:       Object.fromEntries(genderBreakdown.map((g) => [g._id, g.count])),
      childrenDistribution: childrenDistribution.map((d) => ({
        childrenCount: d._id,
        parentCount:   d.count,
      })),
      monthlyRegistrations: monthlyRegistrations.map((m) => ({
        year:  m._id.year,
        month: m._id.month,
        count: m.count,
      })),
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getCampusParentStats error:', error);
    return sendError(res, 500, 'Failed to retrieve campus parent statistics.');
  }
};

// ── GET PARENTS BY STUDENT ────────────────────────────────────────────────────

/**
 * @route  GET /api/parents/by-student/:studentId
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getParentsByStudent = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(studentId)) {
      return sendError(res, 400, 'Invalid student ID.');
    }

    const campusFilter = getCampusFilter(req.user, req.query.campusId);

    const parents = await parentRepo.findByStudent(campusFilter, studentId);

    if (parents.length === 0) {
      return sendSuccess(res, 200, 'No parents found for this student.', {
        studentId,
        total:   0,
        parents: [],
      });
    }

    return sendSuccess(res, 200, 'Parents retrieved successfully.', {
      studentId,
      total:   parents.length,
      parents,
    });

  } catch (error) {
    if (error.statusCode) {
      return sendError(res, error.statusCode, error.message);
    }
    console.error('❌ getParentsByStudent error:', error);
    return sendError(res, 500, 'Failed to retrieve parents by student.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  getParentStats,
  getCampusParentStats,
  getParentsByStudent,
};
