'use strict';

/**
 * @file exam_questionBank_controller.js
 * @description CRUD + import for the QuestionBank.
 *
 *  Routes (all prefixed /api/examination):
 *    GET    /question-bank          → listQuestions
 *    POST   /question-bank          → createQuestion  [TEACHER, ADMIN, DIRECTOR, CAMPUS_MANAGER]
 *    GET    /question-bank/:id      → getQuestion
 *    PATCH  /question-bank/:id      → updateQuestion
 *    DELETE /question-bank/:id      → deleteQuestion
 *    POST   /question-bank/import   → importQuestions [ADMIN, DIRECTOR, CAMPUS_MANAGER]
 *    GET    /question-bank/:id/stats → getQuestionStats
 */

const QuestionBank = require('../../models/exam-models/questionBank.model');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
  sendCreated,
  handleDuplicateKeyError,
} = require('../../utils/responseHelpers');
const { isValidObjectId } = require('../../utils/validationHelpers');
const {
  getCampusFilter,
  resolveCampusId,
  parsePagination,
} = require('./exam.helper');

// ─────────────────────────────────────────────────────────────────────────────

const listQuestions = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const { page, limit, skip } = parsePagination(req.query);
    const { subject, difficulty, bloomLevel, questionType, tag, search, isActive } = req.query;

    const match = { ...campusFilter, isDeleted: false };
    if (subject)      match.subject      = subject;
    if (difficulty)   match.difficulty   = difficulty;
    if (bloomLevel)   match.bloomLevel   = bloomLevel;
    if (questionType) match.questionType = questionType;
    if (tag)          match.tags         = { $in: [tag] };
    if (isActive !== undefined) match.isActive = isActive === 'true';
    if (search) match.questionText = { $regex: search, $options: 'i' };

    const [questions, total] = await Promise.all([
      QuestionBank.find(match)
        .select('-__v')
        .populate('subject', 'subject_name subject_code')
        .populate('createdBy', 'firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      QuestionBank.countDocuments(match),
    ]);

    return sendPaginated(res, 200, 'Questions retrieved successfully.', questions, {
      total, page, limit,
    });
  } catch (err) {
    console.error('❌ listQuestions:', err);
    return sendError(res, 500, 'Failed to retrieve questions.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const createQuestion = async (req, res) => {
  try {
    const campusId = resolveCampusId(req, req.body.schoolCampus);
    if (!campusId) return sendError(res, 400, 'schoolCampus is required.');

    const {
      subject, course, questionText, questionType, difficulty, bloomLevel,
      options, correctAnswer, points, tags, language, translations, instructions,
    } = req.body;

    if (!subject || !questionText || !questionType || !difficulty) {
      return sendError(res, 400, 'subject, questionText, questionType and difficulty are required.');
    }

    const question = await QuestionBank.create({
      schoolCampus: campusId,
      subject, course, questionText, questionType, difficulty, bloomLevel,
      options, correctAnswer, points, tags, language, translations, instructions,
      createdBy: req.user.id,
    });

    return sendCreated(res, 'Question created successfully.', question);
  } catch (err) {
    if (err.code === 11000) return handleDuplicateKeyError(res, err);
    console.error('❌ createQuestion:', err);
    return sendError(res, 500, 'Failed to create question.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const getQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid question ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const question = await QuestionBank.findOne({ _id: id, ...campusFilter, isDeleted: false })
      .populate('subject', 'subject_name subject_code')
      .populate('course', 'name')
      .populate('createdBy', 'firstName lastName');

    if (!question) return sendNotFound(res, 'Question');
    return sendSuccess(res, 200, 'Question retrieved.', question);
  } catch (err) {
    console.error('❌ getQuestion:', err);
    return sendError(res, 500, 'Failed to retrieve question.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid question ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const existing = await QuestionBank.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!existing) return sendNotFound(res, 'Question');

    const IMMUTABLE = ['_id', 'schoolCampus', 'createdBy', 'createdAt', 'usageCount'];
    const updates = { ...req.body, updatedBy: req.user.id };
    IMMUTABLE.forEach((f) => delete updates[f]);

    const updated = await QuestionBank.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    return sendSuccess(res, 200, 'Question updated.', updated);
  } catch (err) {
    console.error('❌ updateQuestion:', err);
    return sendError(res, 500, 'Failed to update question.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const deleteQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid question ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const question = await QuestionBank.findOne({ _id: id, ...campusFilter, isDeleted: false });
    if (!question) return sendNotFound(res, 'Question');

    await QuestionBank.findByIdAndUpdate(id, { isDeleted: true, updatedBy: req.user.id });
    return sendSuccess(res, 200, 'Question deleted.');
  } catch (err) {
    console.error('❌ deleteQuestion:', err);
    return sendError(res, 500, 'Failed to delete question.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const importQuestions = async (req, res) => {
  try {
    const campusId = resolveCampusId(req, req.body.schoolCampus);
    if (!campusId) return sendError(res, 400, 'schoolCampus is required.');

    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return sendError(res, 400, 'questions must be a non-empty array.');
    }
    if (questions.length > 500) {
      return sendError(res, 400, 'Maximum 500 questions per import batch.');
    }

    const docs = questions.map((q) => ({
      ...q,
      schoolCampus: campusId,
      createdBy: req.user.id,
    }));

    const inserted = await QuestionBank.insertMany(docs, { ordered: false });
    return sendCreated(res, `${inserted.length} question(s) imported.`, {
      imported: inserted.length,
    });
  } catch (err) {
    console.error('❌ importQuestions:', err);
    return sendError(res, 500, 'Import failed.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const getQuestionStats = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid question ID.');

    const campusFilter = getCampusFilter(req, res);
    if (!campusFilter) return;

    const question = await QuestionBank.findOne(
      { _id: id, ...campusFilter, isDeleted: false },
      'questionText usageCount lastUsedAt difficultyIndex discriminationIdx bloomLevel difficulty'
    );
    if (!question) return sendNotFound(res, 'Question');

    return sendSuccess(res, 200, 'Question stats retrieved.', {
      questionId:          question._id,
      questionText:        question.questionText,
      usageCount:          question.usageCount,
      lastUsedAt:          question.lastUsedAt,
      difficultyIndex:     question.difficultyIndex,
      discriminationIndex: question.discriminationIdx,
      bloomLevel:          question.bloomLevel,
      difficulty:          question.difficulty,
    });
  } catch (err) {
    console.error('❌ getQuestionStats:', err);
    return sendError(res, 500, 'Failed to retrieve question stats.');
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listQuestions,
  createQuestion,
  getQuestion,
  updateQuestion,
  deleteQuestion,
  importQuestions,
  getQuestionStats,
};
