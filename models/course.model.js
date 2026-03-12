'use strict';

/**
 * @file course.model.js
 * @description Mongoose model for the global course catalog.
 *
 *  ARCHITECTURAL NOTE:
 *  Courses are GLOBAL entities — no schoolCampus field.
 *  They form the shared pedagogical reference for the entire university.
 *  Campus-scoped entities (Subject, Schedule, etc.) MAY reference a Course
 *  via Subject.courseRef, but this link is informational and non-mandatory.
 *
 *  Versioning:
 *  When an APPROVED course requires pedagogical changes, a new version is
 *  cloned atomically (MongoDB session). The old document is flagged
 *  isLatestVersion: false and the new one starts at status DRAFT.
 */

const mongoose = require('mongoose');

// ─── ENUMS (exported for reuse in controllers and validation schemas) ──────────

const COURSE_CATEGORY = Object.freeze([
  'Core', 'Elective', 'Remedial', 'Advanced', 'Professional', 'General',
]);

const COURSE_DIFFICULTY = Object.freeze([
  'BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT',
]);

const COURSE_VISIBILITY = Object.freeze([
  'PUBLIC', 'INTERNAL', 'RESTRICTED',
]);

const APPROVAL_STATUS = Object.freeze({
  DRAFT:          'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED:       'APPROVED',
  REJECTED:       'REJECTED',
});

const PREREQUISITE_TYPE = Object.freeze(['REQUIRED', 'RECOMMENDED']);

const RESOURCE_TYPE = Object.freeze([
  'PDF', 'VIDEO', 'LINK', 'DOCUMENT', 'SPREADSHEET', 'OTHER',
]);

// Mirrors SESSION_TYPE from schedule_base.js
const SESSION_TYPE = Object.freeze([
  'LECTURE', 'TUTORIAL', 'PRACTICAL', 'EXAM', 'WORKSHOP',
]);

const PERIOD_TYPE = Object.freeze([
  'week', 'session', 'module', 'chapter',
]);

const LANGUAGE_CODES = Object.freeze([
  'fr', 'en', 'es', 'ar', 'pt', 'de', 'zh', 'other',
]);

// Allowed MIME types for locally-stored resources (URLs are exempt)
const ALLOWED_MIME_TYPES = Object.freeze([
  'application/pdf',
  'video/mp4',
  'video/webm',
  'image/jpeg',
  'image/png',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// ─── SUB-SCHEMAS ──────────────────────────────────────────────────────────────

/**
 * Append-only approval history entry.
 * Mirrors AuditEntrySchema from result.model.js — never modified, never deleted.
 */
const ApprovalHistorySchema = new mongoose.Schema(
  {
    status:  { type: String, enum: Object.values(APPROVAL_STATUS), required: true },
    note:    { type: String, trim: true, maxlength: 500 },
    actor:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    actedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

/**
 * Prerequisite reference — self-referential.
 * Circular dependency check is performed in pre('save').
 */
const PrerequisiteSchema = new mongoose.Schema(
  {
    course: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Course',
      required: true,
    },
    type: {
      type:    String,
      enum:    PREREQUISITE_TYPE,
      default: 'REQUIRED',
    },
  },
  { _id: true },
);

/**
 * Flexible syllabus unit — supports week, session, module, chapter granularity.
 * periodNumber must be unique within the course's syllabus array (validated in Yup).
 */
const SyllabusUnitSchema = new mongoose.Schema(
  {
    periodNumber:   { type: Number, required: true, min: 1, max: 60 },
    periodType:     { type: String, enum: PERIOD_TYPE, default: 'week' },
    title:          { type: String, required: true, trim: true, maxlength: 150 },
    content:        { type: String, trim: true, maxlength: 1000 },
    sessionType:    { type: String, enum: SESSION_TYPE, default: 'LECTURE' },
    estimatedHours: { type: Number, min: 0.5, max: 20 },
  },
  { _id: true },
);

/**
 * Learning resource attached to a course.
 * isPublic: false → filtered out for STUDENT role in the controller.
 */
const ResourceSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true, trim: true, maxlength: 200 },
    type:     { type: String, enum: RESOURCE_TYPE, required: true },
    url:      { type: String, required: true, trim: true, maxlength: 500 },
    mimeType: { type: String, trim: true, maxlength: 100 },
    fileSize: { type: Number, min: 0 },              // bytes — optional
    isPublic: { type: Boolean, default: true },
    addedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    addedAt:  { type: Date, default: Date.now },
  },
  { _id: true },
);

/**
 * Estimated workload breakdown — European standard (ECTS-compatible).
 * Virtual totalHours = lecture + practical + selfStudy.
 */
const EstimatedWorkloadSchema = new mongoose.Schema(
  {
    lecture:   { type: Number, default: 0, min: 0 },
    practical: { type: Number, default: 0, min: 0 },
    selfStudy: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────

const CourseSchema = new mongoose.Schema(
  {
    // ── Identification ──────────────────────────────────────────────────────
    courseCode: {
      type:      String,
      required:  [true, 'Course code is required'],
      unique:    true,
      uppercase: true,
      trim:      true,
      match:     [/^[A-Z0-9\-]{2,30}$/, 'Course code must be uppercase alphanumeric with dashes (e.g. CS-101)'],
      index:     true,
    },
    slug: {
      type:   String,
      unique: true,
      lowercase: true,
      trim:   true,
      index:  true,
    },
    title: {
      type:      String,
      required:  [true, 'Course title is required'],
      trim:      true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [150, 'Title must not exceed 150 characters'],
    },
    version: {
      type:    Number,
      default: 1,
      min:     1,
    },
    parentCourseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Course',
      default: null,
    },
    isLatestVersion: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    // ── Pedagogical classification ───────────────────────────────────────────
    category: {
      type:     String,
      enum:     { values: COURSE_CATEGORY, message: '{VALUE} is not a valid category' },
      required: [true, 'Category is required'],
    },
    level: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Level',
      required: [true, 'Level is required'],
      index:    true,
    },
    discipline: {
      type:      String,
      trim:      true,
      maxlength: 100,
    },
    tags: {
      type:     [String],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 15 && arr.every((t) => t.length <= 30),
        message:  'Maximum 15 tags, each up to 30 characters',
      },
      index: true,
    },
    languages: {
      type:     [{ type: String, enum: LANGUAGE_CODES }],
      default:  ['fr'],
      validate: {
        validator: (arr) => arr.length >= 1,
        message:  'At least one language is required',
      },
    },
    difficultyLevel: {
      type:    String,
      enum:    COURSE_DIFFICULTY,
      default: 'INTERMEDIATE',
    },

    // ── Pedagogical content ──────────────────────────────────────────────────
    description: {
      type:      String,
      trim:      true,
      maxlength: 2000,
    },
    objectives: {
      type:     [{ type: String, maxlength: 300 }],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 10,
        message:  'Maximum 10 objectives allowed',
      },
    },
    prerequisites: {
      type:     [PrerequisiteSchema],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 10,
        message:  'Maximum 10 prerequisites allowed',
      },
    },
    syllabus: {
      type:     [SyllabusUnitSchema],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 60,
        message:  'Maximum 60 syllabus units allowed',
      },
    },
    durationWeeks: {
      type: Number,
      min:  0,
      max:  104,
    },
    estimatedWorkload: {
      type:    EstimatedWorkloadSchema,
      default: () => ({ lecture: 0, practical: 0, selfStudy: 0 }),
    },
    creditHours: {
      type: Number,
      min:  0,
      max:  30,
    },
    coverImage: {
      type:      String,
      trim:      true,
      maxlength: 500,
    },

    // ── Learning resources ───────────────────────────────────────────────────
    resources: {
      type:     [ResourceSchema],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 50,
        message:  'Maximum 50 resources per course',
      },
    },

    // ── Governance & workflow ────────────────────────────────────────────────
    approvalStatus: {
      type:    String,
      enum:    Object.values(APPROVAL_STATUS),
      default: APPROVAL_STATUS.DRAFT,
      index:   true,
    },
    approvalHistory: {
      type:    [ApprovalHistorySchema],
      default: [],
    },
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Teacher',
      required: [true, 'createdBy is required'],
    },
    visibility: {
      type:    String,
      enum:    COURSE_VISIBILITY,
      default: 'INTERNAL',
    },

    // ── Lifecycle ────────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },
    isDeleted: {
      type:    Boolean,
      default: false,
      index:   true,
    },
    deletedAt: { type: Date },
    deletedBy: { type: String },   // req.user.id
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  },
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

CourseSchema.index({ isActive: 1, isDeleted: 1, isLatestVersion: 1 });
CourseSchema.index({ approvalStatus: 1, isLatestVersion: 1 });
CourseSchema.index({ level: 1, category: 1, approvalStatus: 1 });
CourseSchema.index({ 'prerequisites.course': 1 });
CourseSchema.index(
  { title: 'text', description: 'text', discipline: 'text' },
  { name: 'course_text_search' },
);

/**
 * Unique composite index — prevents concurrent createNewVersion calls from
 * producing duplicate versions for the same courseCode.
 * The unique constraint causes the second write to throw E11000, which is
 * caught and converted to a 409 by handleDuplicateKeyError in the controller.
 */
CourseSchema.index(
  { courseCode: 1, version: 1 },
  { unique: true, name: 'courseCode_version_unique' },
);

// ─── VIRTUALS ─────────────────────────────────────────────────────────────────

/** Total estimated hours = lecture + practical + self-study */
CourseSchema.virtual('totalHours').get(function () {
  const w = this.estimatedWorkload || {};
  return (w.lecture || 0) + (w.practical || 0) + (w.selfStudy || 0);
});

/** Shortcut for the number of prerequisites */
CourseSchema.virtual('prerequisiteCount').get(function () {
  return (this.prerequisites || []).length;
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a string.
 * Replacement for the `slugify` npm package (not installed).
 * @param {string} text
 * @returns {string}
 */
function generateSlug(text) {
  return text
    .toString()
    .normalize('NFD')                          // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')           // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')             // remove non-alphanumeric
    .replace(/\s+/g, '-')                      // spaces → hyphens
    .replace(/-+/g, '-')                       // collapse multiple hyphens
    .replace(/^-+|-+$/g, '');                  // trim leading/trailing hyphens
}

// ─── PRE-VALIDATE HOOK ────────────────────────────────────────────────────────

/**
 * Normalize courseCode and auto-generate a unique slug from title.
 * Slug collision is resolved by appending an auto-incremented numeric suffix.
 */
CourseSchema.pre('validate', async function () {
  try {
    // Normalize course code
    if (this.courseCode) {
      this.courseCode = this.courseCode.toUpperCase().trim();
    }

    // Auto-generate slug only if title changed or slug is missing
    if (this.isModified('title') || !this.slug) {
      const baseSlug = generateSlug(this.title || '');
      let candidate = baseSlug;
      let suffix    = 1;

      // Resolve uniqueness — exclude current document on update
      while (true) {
        const conflict = await mongoose
          .model('Course')
          .findOne({ slug: candidate, _id: { $ne: this._id } })
          .lean();

        if (!conflict) break;
        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      this.slug = candidate;
    }
  } catch (err) {
    throw err ;
  }
});

// ─── PRE-SAVE HOOK ────────────────────────────────────────────────────────────

/**
 * 1. Anti-cycle BFS on prerequisites (max depth 5).
 * 2. MIME type whitelist validation for locally-stored resources.
 */
CourseSchema.pre('save', async function (next) {
  // ── 1. Circular prerequisite detection (BFS, max depth 5) ─────────────────
  if (this.isModified('prerequisites') && this.prerequisites.length > 0) {
    const currentId = this._id.toString();
    const directPrereqIds = this.prerequisites.map((p) => p.course.toString());

    const visited = new Set();
    const queue   = [...directPrereqIds];
    let   depth   = 0;

    while (queue.length > 0 && depth < 5) {
      depth += 1;
      const batch = queue.splice(0, queue.length); // drain current level

      for (const prereqId of batch) {
        if (prereqId === currentId) {
          throw new Error('Circular prerequisite detected');
        }
        if (visited.has(prereqId)) continue;
        visited.add(prereqId);

        // Load next level of prerequisites
        const prereqCourse = await mongoose
          .model('Course')
          .findById(prereqId)
          .select('prerequisites')
          .lean();

        if (prereqCourse?.prerequisites?.length) {
          queue.push(...prereqCourse.prerequisites.map((p) => p.course.toString()));
        }
      }
    }
  }

  // ── 2. MIME type whitelist for non-URL resources ──────────────────────────
  if (this.isModified('resources') && this.resources.length > 0) {
    for (const resource of this.resources) {
      // External URLs (http/https) are exempt from MIME validation
      const isExternalUrl =
        typeof resource.url === 'string' &&
        (resource.url.startsWith('http://') || resource.url.startsWith('https://'));

      if (!isExternalUrl && resource.mimeType) {
        if (!ALLOWED_MIME_TYPES.includes(resource.mimeType)) {
            throw new Error(
              `MIME type '${resource.mimeType}' is not allowed. Accepted: ${ALLOWED_MIME_TYPES.join(', ')}`,
            );
        }
      }
    }
  }
});

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/**
 * Find all courses in their latest version only.
 * @param {Object} [filter={}] - Additional MongoDB filter
 */
CourseSchema.statics.findLatest = function (filter = {}) {
  return this.find({ ...filter, isLatestVersion: true, isDeleted: false });
};

/**
 * Find the full version history chain for a given courseCode.
 * @param {string} courseCode
 */
CourseSchema.statics.findVersionHistory = function (courseCode) {
  return this.find({ courseCode, isDeleted: false }).sort({ version: -1 });
};

// ─── MODEL EXPORT ─────────────────────────────────────────────────────────────

const Course = mongoose.model('Course', CourseSchema);

module.exports = {
  Course,
  COURSE_CATEGORY,
  COURSE_DIFFICULTY,
  COURSE_VISIBILITY,
  APPROVAL_STATUS,
  PREREQUISITE_TYPE,
  RESOURCE_TYPE,
  SESSION_TYPE,
  PERIOD_TYPE,
  LANGUAGE_CODES,
  ALLOWED_MIME_TYPES,
};