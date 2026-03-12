const mongoose = require("mongoose");

/**
 * Subject Schema
 * Represents an academic subject taught in a campus.
 * Each subject is unique per campus (via subject_code).
 *
 * MODIFICATION v2:
 *  Added optional `courseRef` field linking this campus subject to the
 *  global course catalog (Course model). The link is informational only —
 *  a Subject can exist without a Course reference, and a Course can exist
 *  without being referenced by any Subject.
 *
 *  Validation rules for courseRef (enforced in the controller):
 *  • The referenced Course must be APPROVED and isLatestVersion: true.
 *  • The Course.level must match the Class level of this Subject's class.
 */
const subjectSchema = new mongoose.Schema(
  {
    // Campus reference
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campus",
      required: [true, 'Campus is required'],
      index: true,
    },

    // Teachers teaching a subject
    teachers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
    }],

    // Department to which the subject belongs
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
    },

    // Subject name (e.g., "Mathematics", "Physics")
    subject_name: {
      type: String,
      required: [true, 'Subject name is required'],
      trim: true,
      minlength: [2, 'Subject name must be at least 2 characters'],
      maxlength: [100, 'Subject name must not exceed 100 characters']
    },

    // Unique subject code per campus (e.g., "MATH101", "PHY201")
    subject_code: {
      type: String,
      required: [true, 'Subject code is required'],
      uppercase: true,
      trim: true,
      minlength: [2, 'Subject code must be at least 2 characters'],
      maxlength: [20, 'Subject code must not exceed 20 characters']
    },

    // Short description of the subject
    description: {
      type: String,
      maxlength: [500, 'Description must not exceed 500 characters'],
      trim: true
    },

    // Subject coefficient for grade calculations
    coefficient: {
      type: Number,
      default: 1,
      min: [0, 'Coefficient cannot be negative'],
      max: [10, 'Coefficient cannot exceed 10']
    },

    // Subject status (active / archived)
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // Optional color for UI display (hex format)
    color: {
      type: String,
      default: '#1976d2',
      validate: {
        validator: function(v) {
          // Validate hex color format
          return !v || /^#[0-9A-Fa-f]{6}$/.test(v);
        },
        message: 'Color must be in hex format (e.g., #FF5733)'
      }
    },

    // Subject category (optional grouping)
    category: {
      type: String,
      enum: {
        values: [
          'Science',
          'Mathematics',
          'Languages',
          'Social Studies',
          'Arts',
          'Physical Education',
          'Technology',
          'Other'
        ],
        message: '{VALUE} is not a valid category'
      },
      default: 'Other'
    },

    // ── v2: Global course catalog reference ─────────────────────────────────
    // Optional link to the global Course entity.
    // Informational only — no cascade effects.
    // Validated in course.resources.controller → linkSubjectCourse:
    //   • Course must be APPROVED and isLatestVersion: true
    //   • Course.level must match the Class level of this Subject
    courseRef: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Course',
      default: null,
      index:   true,
    },
  },
  {
    timestamps: true, // createdAt & updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ========================================
// INDEXES FOR PERFORMANCE
// ========================================

/**
 * Ensure subject code is unique per campus.
 * A campus cannot have two subjects with the same code.
 */
subjectSchema.index(
  { schoolCampus: 1, subject_code: 1 },
  { unique: true }
);

/**
 * For filtering active subjects by campus
 */
subjectSchema.index({ schoolCampus: 1, isActive: 1 });

/**
 * For searching by name
 */
subjectSchema.index({ subject_name: 'text' });

// ========================================
// PRE-SAVE MIDDLEWARE
// ========================================

// Normalize subject_code to uppercase
subjectSchema.pre('save', function() {
  if (this.subject_code) {
    this.subject_code = this.subject_code.toUpperCase().trim();
  }
  if (this.subject_name) {
    this.subject_name = this.subject_name.trim();
  }
});

// ========================================
// VIRTUAL FIELDS
// ========================================

// Virtual for display name with code
subjectSchema.virtual('displayName').get(function() {
  return `${this.subject_name} (${this.subject_code})`;
});

// ========================================
// INSTANCE METHODS
// ========================================

/**
 * Archive the subject (soft delete)
 */
subjectSchema.methods.archive = async function() {
  this.isActive = false;
  await this.save();
  return this;
};

/**
 * Restore archived subject
 */
subjectSchema.methods.restore = async function() {
  this.isActive = true;
  await this.save();
  return this;
};

// ========================================
// STATIC METHODS
// ========================================

/**
 * Find active subjects in a campus
 */
subjectSchema.statics.findActiveByCampus = function(campusId) {
  return this.find({ 
    schoolCampus: campusId, 
    isActive: true 
  }).sort({ subject_name: 1 });
};

/**
 * Find subjects by category
 */
subjectSchema.statics.findByCategory = function(category, campusId) {
  const filter = { category, isActive: true };
  if (campusId) {
    filter.schoolCampus = campusId;
  }
  return this.find(filter).sort({ subject_name: 1 });
};

/**
 * Count subjects per campus
 */
subjectSchema.statics.countByCampus = function(campusId) {
  return this.countDocuments({ 
    schoolCampus: campusId, 
    isActive: true 
  });
};

/**
 * Search subjects by name or code
 */
subjectSchema.statics.search = function(query, campusId) {
  const filter = {
    $or: [
      { subject_name: { $regex: query, $options: 'i' } },
      { subject_code: { $regex: query, $options: 'i' } }
    ],
    isActive: true
  };
  
  if (campusId) {
    filter.schoolCampus = campusId;
  }
  
  return this.find(filter).sort({ subject_name: 1 });
};

const Subject = mongoose.model("Subject", subjectSchema);

module.exports = Subject;