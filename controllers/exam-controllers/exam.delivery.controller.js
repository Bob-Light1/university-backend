'use strict';

/**
 * @file exam_delivery_controller.js
 * @description Online exam delivery — start attempt, serve questions,
 *              save answers, submit, and log anti-cheat events.
 *
 *  Routes (all prefixed /api/examination):
 *    POST   /sessions/:id/start-attempt         → startAttempt    [STUDENT]
 *    GET    /submissions/:id/questions           → getQuestions    [STUDENT]
 *    PATCH  /submissions/:id/answer              → saveAnswer      [STUDENT]
 *    POST   /submissions/:id/submit              → submitExam      [STUDENT]
 *    POST   /submissions/:id/anti-cheat-event    → logAntiCheat    [STUDENT]
 */

const ExamSession    = require('../../models/exam-models/examSession.model');
const ExamEnrollment = require('../../models/exam-models/examEnrollment.model');
const ExamSubmission = require('../../models/exam-models/examSubmission.model');
const QuestionBank   = require('../../models/exam-models/questionBank.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendCreated,
} = require('../../utils/responseHelpers');
const { isValidObjectId } = require('../../utils/validationHelpers');

// ── Deterministic shuffle (seeded by studentId + sessionId) ──────────────────

const seededShuffle = (arr, seed) => {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const hashSeed = (str) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};

// ─── Start attempt ────────────────────────────────────────────────────────────

const startAttempt = async (req, res) => {
  try {
    const { id } = req.params; // sessionId
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid session ID.');

    const studentId = req.user.id;

    const session = await ExamSession.findOne({ _id: id, isDeleted: false });
    if (!session) return sendNotFound(res, 'Exam session');

    if (!['SCHEDULED', 'ONGOING'].includes(session.status)) {
      return sendError(res, 400, 'This exam is not currently active.');
    }
    if (session.mode === 'PHYSICAL') {
      return sendError(res, 400, 'Physical exams do not use online submission.');
    }

    const enrollment = await ExamEnrollment.findOne({
      examSession: id,
      student:     studentId,
      isDeleted:   false,
    });
    if (!enrollment) return sendError(res, 403, 'You are not enrolled in this exam.');
    if (!enrollment.isEligible) {
      return sendError(res, 403, `You are not eligible: ${enrollment.eligibilityNotes || ''}`);
    }

    // Idempotent — return existing attempt if already started
    const existing = await ExamSubmission.findOne({
      examSession: id,
      student:     studentId,
      isDeleted:   false,
    });
    if (existing) {
      if (existing.status === 'SUBMITTED') {
        return sendError(res, 409, 'You have already submitted this exam.');
      }
      return sendSuccess(res, 200, 'Exam attempt already in progress.', {
        submissionId: existing._id,
        startedAt:    existing.startedAt,
        endTime:      session.endTime,
        duration:     session.duration,
      });
    }

    const submission = await ExamSubmission.create({
      schoolCampus: session.schoolCampus,
      examSession:  id,
      student:      studentId,
      answers:      [],
      startedAt:    new Date(),
      status:       'IN_PROGRESS',
      ipAddress:    req.ip,
      userAgent:    req.get('user-agent'),
    });

    // Mark exam ONGOING if not already
    if (session.status === 'SCHEDULED') {
      await ExamSession.findByIdAndUpdate(id, { status: 'ONGOING' });
    }

    return sendCreated(res, 'Exam attempt started.', {
      submissionId: submission._id,
      startedAt:    submission.startedAt,
      endTime:      session.endTime,
      duration:     session.duration,
    });
  } catch (err) {
    console.error('❌ startAttempt:', err);
    return sendError(res, 500, 'Failed to start exam attempt.');
  }
};

// ─── Get shuffled questions ───────────────────────────────────────────────────

const getQuestions = async (req, res) => {
  try {
    const { id } = req.params; // submissionId
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid submission ID.');

    const studentId = req.user.id;

    const submission = await ExamSubmission.findOne({
      _id:     id,
      student: studentId,
      isDeleted: false,
    });
    if (!submission) return sendNotFound(res, 'Submission');

    const session = await ExamSession.findById(submission.examSession);
    if (!session) return sendNotFound(res, 'Exam session');

    // Enforce: answers not exposed before session COMPLETED
    if (!['IN_PROGRESS', 'SUBMITTED'].includes(submission.status) && session.status !== 'COMPLETED') {
      return sendError(res, 403, 'Questions are not accessible at this time.');
    }

    const questionRefs = session.questions || [];
    const questionIds  = questionRefs.map((q) => q.questionId);

    const rawQuestions = await QuestionBank.find({ _id: { $in: questionIds } })
      .select('questionText questionType options points difficulty bloomLevel language translations');

    // Build ordered map
    const qMap = Object.fromEntries(rawQuestions.map((q) => [q._id.toString(), q.toObject()]));

    let ordered = questionRefs.map((ref) => {
      const q    = qMap[ref.questionId.toString()];
      if (!q) return null;
      const pts  = ref.points ?? q.points;
      const base = { ...q, points: pts, refOrder: ref.order };

      // Strip correct answer for IN_PROGRESS
      if (submission.status === 'IN_PROGRESS') {
        delete base.correctAnswer;
        base.options = (base.options || []).map(({ text, explanation }) => ({ text, explanation }));
      }

      return base;
    }).filter(Boolean);

    // Apply deterministic shuffle
    if (session.shuffleQuestions) {
      const seed = hashSeed(`${studentId}${submission.examSession}`);
      ordered = seededShuffle(ordered, seed);
    }

    // Preferred language translation
    const lang = req.user.preferredLanguage || 'en';
    if (lang !== 'en') {
      ordered = ordered.map((q) => {
        const tr = (q.translations || []).find((t) => t.lang === lang);
        if (tr) {
          return {
            ...q,
            questionText: tr.questionText || q.questionText,
            options:      tr.options       || q.options,
            instructions: tr.instructions  || q.instructions,
          };
        }
        return q;
      });
    }

    return sendSuccess(res, 200, 'Questions retrieved.', {
      submissionId: submission._id,
      total:        ordered.length,
      questions:    ordered,
      savedAnswers: submission.answers,
      endTime:      session.endTime,
      duration:     session.duration,
      antiCheatConfig: session.antiCheatConfig,
    });
  } catch (err) {
    console.error('❌ getQuestions:', err);
    return sendError(res, 500, 'Failed to retrieve questions.');
  }
};

// ─── Save / update answer (idempotent) ───────────────────────────────────────

const saveAnswer = async (req, res) => {
  try {
    const { id } = req.params; // submissionId
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid submission ID.');

    const { questionId, selectedOption, openText, fileUrl } = req.body;
    if (!questionId || !isValidObjectId(questionId)) {
      return sendError(res, 400, 'Valid questionId is required.');
    }

    const submission = await ExamSubmission.findOne({
      _id:      id,
      student:  req.user.id,
      status:   'IN_PROGRESS',
      isDeleted: false,
    });
    if (!submission) return sendNotFound(res, 'Active submission');

    // Check server-side timer
    const session = await ExamSession.findById(submission.examSession, 'endTime');
    if (session && new Date() > new Date(session.endTime)) {
      // Auto-submit
      submission.status          = 'SUBMITTED';
      submission.autoSubmittedAt = new Date();
      await submission.save();
      return sendError(res, 410, 'Exam time has expired. Your answers have been auto-submitted.');
    }

    // Upsert answer
    const idx = submission.answers.findIndex(
      (a) => a.questionId.toString() === questionId
    );

    const answerDoc = { questionId, savedAt: new Date() };
    if (selectedOption !== undefined) answerDoc.selectedOption = selectedOption;
    if (openText      !== undefined) answerDoc.openText       = openText;
    if (fileUrl       !== undefined) answerDoc.fileUrl        = fileUrl;

    if (idx >= 0) {
      submission.answers[idx] = answerDoc;
    } else {
      submission.answers.push(answerDoc);
    }

    await submission.save();
    return sendSuccess(res, 200, 'Answer saved.', { questionId, savedAt: answerDoc.savedAt });
  } catch (err) {
    console.error('❌ saveAnswer:', err);
    return sendError(res, 500, 'Failed to save answer.');
  }
};

// ─── Final submission ─────────────────────────────────────────────────────────

const submitExam = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid submission ID.');

    const submission = await ExamSubmission.findOne({
      _id:      id,
      student:  req.user.id,
      isDeleted: false,
    });
    if (!submission) return sendNotFound(res, 'Submission');

    if (submission.status === 'SUBMITTED') {
      return sendError(res, 409, 'Exam already submitted.');
    }
    if (submission.status !== 'IN_PROGRESS') {
      return sendError(res, 400, 'Cannot submit an exam that is not in progress.');
    }

    submission.status      = 'SUBMITTED';
    submission.submittedAt = new Date();
    await submission.save();

    // MCQ auto-grading (if session has questions with correctAnswer)
    // Dispatched asynchronously — no blocking
    setImmediate(() => _autoGradeMCQ(submission).catch(console.error));

    return sendSuccess(res, 200, 'Exam submitted successfully.', {
      submissionId: submission._id,
      submittedAt:  submission.submittedAt,
      answersCount: submission.answers.length,
    });
  } catch (err) {
    console.error('❌ submitExam:', err);
    return sendError(res, 500, 'Failed to submit exam.');
  }
};

// ── MCQ auto-grading (async, non-blocking) ────────────────────────────────────

const _autoGradeMCQ = async (submission) => {
  try {
    const session = await ExamSession.findById(submission.examSession);
    if (!session) return;

    const questionIds = session.questions.map((q) => q.questionId);
    const questions   = await QuestionBank.find({
      _id:          { $in: questionIds },
      questionType: 'MCQ',
    }).select('_id options');

    const correctMap = {};
    for (const q of questions) {
      const idx = (q.options || []).findIndex((o) => o.isCorrect);
      if (idx >= 0) correctMap[q._id.toString()] = idx;
    }

    let score = 0;
    for (const answer of submission.answers) {
      const qRef = session.questions.find(
        (q) => q.questionId.toString() === answer.questionId.toString()
      );
      if (!qRef) continue;
      const correctIdx = correctMap[answer.questionId.toString()];
      if (correctIdx !== undefined && answer.selectedOption === correctIdx) {
        score += qRef.points ?? 1;
      }
    }

    const ExamGrading = require('../../models/exam-models/examGrading.model');
    const existing    = await ExamGrading.findOne({ submission: submission._id });
    if (!existing) {
      await ExamGrading.create({
        schoolCampus: session.schoolCampus,
        submission:   submission._id,
        examSession:  session._id,
        student:      submission.student,
        grader:       session.teacher,
        score,
        maxScore: session.maxScore,
        status:   'GRADED',
      });
      await ExamSubmission.findByIdAndUpdate(submission._id, { status: 'GRADED' });
    }
  } catch (err) {
    console.error('❌ _autoGradeMCQ:', err);
  }
};

// ─── Anti-cheat event log ─────────────────────────────────────────────────────

const logAntiCheat = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid submission ID.');

    const { type, detail } = req.body;
    if (!type) return sendError(res, 400, 'event type is required.');

    const submission = await ExamSubmission.findOne({
      _id:      id,
      student:  req.user.id,
      status:   'IN_PROGRESS',
      isDeleted: false,
    });
    if (!submission) return sendNotFound(res, 'Active submission');

    submission.antiCheatFlags.push({ type, detail, timestamp: new Date() });

    if (type === 'TAB_SWITCH') submission.tabSwitchCount += 1;

    await submission.save();

    return sendSuccess(res, 200, 'Anti-cheat event logged.', {
      tabSwitchCount: submission.tabSwitchCount,
      flagCount:      submission.antiCheatFlags.length,
    });
  } catch (err) {
    console.error('❌ logAntiCheat:', err);
    return sendError(res, 500, 'Failed to log anti-cheat event.');
  }
};

// ─── Get submission (student result view) ─────────────────────────────────────

const getSubmission = async (req, res) => {
  try {
    const { id } = req.params; // submissionId
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid submission ID.');

    const submission = await ExamSubmission.findOne({ _id: id, isDeleted: false });
    if (!submission) return sendNotFound(res, 'Submission');

    // Students can only see their own submission; staff sees any
    if (req.user.role === 'STUDENT' && submission.student.toString() !== req.user.id) {
      return sendError(res, 403, 'You can only view your own submission.');
    }

    const session = await ExamSession.findById(submission.examSession, 'title status maxScore subject startTime endTime');

    // For students: strip antiCheatFlags and only expose answers after SUBMITTED
    let data = submission.toObject();
    if (req.user.role === 'STUDENT') {
      delete data.antiCheatFlags;
      delete data.tabSwitchCount;
    }

    return sendSuccess(res, 200, 'Submission retrieved.', { ...data, session });
  } catch (err) {
    console.error('❌ getSubmission:', err);
    return sendError(res, 500, 'Failed to retrieve submission.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  startAttempt,
  getQuestions,
  saveAnswer,
  submitExam,
  logAntiCheat,
  getSubmission,
};
