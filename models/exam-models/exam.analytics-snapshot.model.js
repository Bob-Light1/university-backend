'use strict';

const mongoose = require('mongoose');

const DistributionBucketSchema = new mongoose.Schema(
  {
    range: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const ItemAnalysisSchema = new mongoose.Schema(
  {
    questionId:         { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionBank', required: true },
    difficultyIndex:    { type: Number },
    discriminationIndex:{ type: Number },
    bloomLevel:         { type: String },
  },
  { _id: false }
);

const examAnalyticsSnapshotSchema = new mongoose.Schema(
  {
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'SchoolCampus',
      required: true,
      index:    true,
    },
    examSession: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'ExamSession',
      required: true,
    },

    count:       { type: Number, required: true },
    mean:        { type: Number, required: true },
    median:      { type: Number, required: true },
    stdDev:      { type: Number, required: true },
    min:         { type: Number, required: true },
    max:         { type: Number, required: true },
    passingRate: { type: Number, required: true },

    distribution:   [DistributionBucketSchema],
    itemAnalysis:   [ItemAnalysisSchema],

    dropoutRiskScore: { type: Number, required: true, default: 0 },
    atRiskCount:      { type: Number, required: true, default: 0 },
    absentCount:      { type: Number, required: true, default: 0 },

    computedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true }
);

examAnalyticsSnapshotSchema.index(
  { examSession: 1 },
  { unique: true }
);

const ExamAnalyticsSnapshot = mongoose.model(
  'ExamAnalyticsSnapshot',
  examAnalyticsSnapshotSchema
);
module.exports = ExamAnalyticsSnapshot;
