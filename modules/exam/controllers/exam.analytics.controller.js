'use strict';

/**
 * @file exam_analytics_controller.js
 * @description Read-only analytics endpoints for SEMS.
 *
 *  Routes (all prefixed /api/examination):
 *    GET  /analytics/campus-overview           → campusOverview
 *    GET  /analytics/sessions/:id/snapshot     → getSnapshot
 *    GET  /analytics/sessions/:id/item-analysis → itemAnalysis
 *    GET  /analytics/early-warning             → earlyWarning
 *    GET  /analytics/export                    → exportReport  [MANAGER]
 */

const repo = require('../exam.repository');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId } = require('../../../shared/utils/validation-helpers');
const {
  getCampusFilter,
  isManagerRole,
  castForAggregation,
  parsePagination,
} = require('./exam.helper');
const examConfig = require('../exam.config');

// ─── Campus overview ──────────────────────────────────────────────────────────

const campusOverview = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const aggFilter = castForAggregation(campusFilter);
    const { academicYear, semester, examPeriod } = req.query;

    // Published-grading match for the campus. When period filters are supplied,
    // restrict to the sessions matching them (gradings don't carry these fields).
    const gradingMatch = { ...aggFilter, status: 'PUBLISHED', isDeleted: false };
    if (academicYear || semester || examPeriod) {
      const sessionFilter = { ...campusFilter, isDeleted: false };
      if (academicYear) sessionFilter.academicYear = academicYear;
      if (semester)     sessionFilter.semester     = semester;
      if (examPeriod)   sessionFilter.examPeriod    = examPeriod;
      const sessionIds = await repo.distinctSessionIds(sessionFilter);
      gradingMatch.examSession = { $in: sessionIds };
    }

    // Aggregate published gradings for this campus
    const gradingStats = await repo.aggregateCampusGradingStats(gradingMatch);

    const [totalSessions, ongoingSessions, snapshotCount] = await Promise.all([
      repo.countExamSessions({ ...campusFilter, isDeleted: false }),
      repo.countExamSessions({ ...campusFilter, status: 'ONGOING', isDeleted: false }),
      repo.countAnalyticsSnapshots({ ...campusFilter }),
    ]);

    const stats = gradingStats[0] || {};
    const passingRate = stats.totalGraded
      ? Math.round((stats.passCount / stats.totalGraded) * 100 * 10) / 10
      : 0;

    return sendSuccess(res, 200, 'Campus overview retrieved.', {
      totalSessions,
      ongoingSessions,
      snapshotsComputed:  snapshotCount,
      totalGraded:        stats.totalGraded   || 0,
      avgNormalizedScore: stats.avgScore      ? Math.round(stats.avgScore * 10) / 10 : 0,
      passingRate,
      atRiskCount:        stats.atRiskCount   || 0,
    });
  } catch (err) {
    console.error('❌ campusOverview:', err);
    return sendError(res, 500, 'Failed to retrieve campus overview.');
  }
};

// ─── Full snapshot for one session ───────────────────────────────────────────

const getSnapshot = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await repo.findSessionByFilter({ _id: id, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const snapshot = await repo.findSnapshotBySessionPopulated(id);

    if (!snapshot) {
      return sendError(
        res,
        404,
        'Analytics snapshot not yet available. It is computed asynchronously after grade publication.'
      );
    }

    return sendSuccess(res, 200, 'Analytics snapshot retrieved.', snapshot);
  } catch (err) {
    console.error('❌ getSnapshot:', err);
    return sendError(res, 500, 'Failed to retrieve snapshot.');
  }
};

// ─── Item analysis ────────────────────────────────────────────────────────────

const itemAnalysis = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const session = await repo.findSessionByFilter({ _id: id, ...campusFilter, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    const snapshot = await repo.findSnapshotBySession(id);
    if (!snapshot?.itemAnalysis?.length) {
      return sendError(res, 404, 'Item analysis not yet available.');
    }

    return sendSuccess(res, 200, 'Item analysis retrieved.', {
      sessionId:    id,
      itemAnalysis: snapshot.itemAnalysis,
      computedAt:   snapshot.computedAt,
    });
  } catch (err) {
    console.error('❌ itemAnalysis:', err);
    return sendError(res, 500, 'Failed to retrieve item analysis.');
  }
};

// ─── Early Warning System ─────────────────────────────────────────────────────

const earlyWarning = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const aggFilter = castForAggregation(campusFilter);
    const { academicYear } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const match = { ...aggFilter, status: 'PUBLISHED', isDeleted: false };
    if (academicYear) {
      const sessionIds = await repo.distinctSessionIds({ ...campusFilter, academicYear, isDeleted: false });
      match.examSession = { $in: sessionIds };
    }

    const atRiskThreshold = examConfig.ewsRiskThreshold;

    const atRisk = await repo.aggregateEarlyWarning(match, { skip, limit, threshold: atRiskThreshold });

    return sendSuccess(res, 200, 'Early warning list retrieved.', {
      threshold: atRiskThreshold,
      total:     atRisk.length,
      students:  atRisk,
    });
  } catch (err) {
    console.error('❌ earlyWarning:', err);
    return sendError(res, 500, 'Failed to retrieve early warning list.');
  }
};

// ─── Export report ────────────────────────────────────────────────────────────

const exportReport = async (req, res) => {
  try {
    if (!isManagerRole(req.user.role)) return sendError(res, 403, 'Managers only.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { academicYear, format = 'json' } = req.query;
    if (!academicYear) return sendError(res, 400, 'academicYear is required.');

    const sessions = await repo.findSessionsForExport({ ...campusFilter, academicYear, isDeleted: false });

    const sessionIds = sessions.map((s) => s._id);

    const [gradings, snapshots] = await Promise.all([
      repo.aggregateSessionGradingStats(sessionIds),
      repo.findSnapshotsBySessionIds(sessionIds),
    ]);

    const gradingMap   = Object.fromEntries(gradings.map((g)   => [g._id.toString(), g]));
    const snapshotMap  = Object.fromEntries(snapshots.map((s)  => [s.examSession.toString(), s]));

    const report = sessions.map((session) => {
      const sid    = session._id.toString();
      const grData = gradingMap[sid] || {};
      const snap   = snapshotMap[sid];
      return {
        sessionId:    sid,
        title:        session.title,
        subject:      session.subject?.subject_name,
        classes:      session.classes?.map((c) => c.name),
        academicYear: session.academicYear,
        semester:     session.semester,
        examPeriod:   session.examPeriod,
        startTime:    session.startTime,
        totalGraded:  grData.totalGraded || 0,
        avgScore:     grData.avgScore    ? Math.round(grData.avgScore * 10) / 10 : null,
        passingRate:  grData.totalGraded
          ? Math.round((grData.passCount / grData.totalGraded) * 100 * 10) / 10
          : null,
        snapshotAvailable: !!snap,
        stdDev:           snap?.stdDev,
        median:           snap?.median,
        atRiskCount:      snap?.atRiskCount,
      };
    });

    if (format === 'csv') {
      const fields = [
        'sessionId', 'title', 'subject', 'academicYear', 'semester', 'examPeriod',
        'startTime', 'totalGraded', 'avgScore', 'passingRate', 'stdDev', 'median', 'atRiskCount',
      ];
      const csv = [
        fields.join(','),
        ...report.map((r) => fields.map((f) => JSON.stringify(r[f] ?? '')).join(',')),
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sems_report_${academicYear}.csv"`);
      return res.send(csv);
    }

    return sendSuccess(res, 200, 'Report generated.', { academicYear, sessionCount: report.length, report });
  } catch (err) {
    console.error('❌ exportReport:', err);
    return sendError(res, 500, 'Failed to generate report.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  campusOverview,
  getSnapshot,
  itemAnalysis,
  earlyWarning,
  exportReport,
};
