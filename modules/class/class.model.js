const mongoose = require('mongoose');

/**
 * Class Schema
 * Represents an academic class within a campus
 * Each class belongs to one campus and one level
 */
const classSchema = new mongoose.Schema(
  {
    // Campus reference 
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus',
      required: [true, 'Campus is required'],
      index: true
    },

    // Academic level reference
    level: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Level',
      required: [true, 'Level is required'],
      index: true
    },

    // Class name (e.g., "Form 1A", "Grade 10 Science")
    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
      minlength: [2, 'Class name must be at least 2 characters'],
      maxlength: [50, 'Class name must not exceed 50 characters']
    },

    // Class manager (teacher in charge)
    classManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      default: null
    },

    // Students enrolled in this class
    students: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student'
      }
    ],

    // Teachers teaching in this class
    teachers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher'
      }
    ],
    
    // Class status
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'archived'],
        message: '{VALUE} is not a valid status'
      },
      default: 'active',
      index: true
    },

    // Maximum student capacity
    maxStudents: {
      type: Number,
      default: 50,
      min: [1, 'Maximum students must be at least 1'],
      max: [200, 'Maximum students cannot exceed 200']
    },

    // Academic year (optional)
    academicYear: {
      type: String,
      trim: true
    },

    // Room/Location information (optional)
    room: {
      type: String,
      trim: true
    }
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// ========================================
// INDEXES FOR PERFORMANCE
// ========================================

// Prevent duplicate classes in the same campus, level, and name
classSchema.index(
  { schoolCampus: 1, level: 1, className: 1 },
  { unique: true }
);

// For queries filtering by campus and status
classSchema.index({ schoolCampus: 1, status: 1 });

// Each teacher can be classManager of at most one class (sparse = nulls excluded)
classSchema.index({ classManager: 1 }, { unique: true, sparse: true });

// ========================================
// VIRTUAL FIELDS
// ========================================

// Virtual for current student count
classSchema.virtual('currentStudentCount').get(function() {
  return this.students ? this.students.length : 0;
});

// Virtual for available capacity
classSchema.virtual('availableCapacity').get(function() {
  const current = this.students ? this.students.length : 0;
  return this.maxStudents - current;
});

// Virtual to check if class is full
classSchema.virtual('isFull').get(function() {
  const current = this.students ? this.students.length : 0;
  return current >= this.maxStudents;
});

// ========================================
// PRE-SAVE MIDDLEWARE
// ========================================

// Normalize className
classSchema.pre('save', function() {
  if (this.className) {
    this.className = this.className.trim();
  }
});

// ========================================
// PRE-VALIDATE MIDDLEWARE
// ========================================

// Validate class manager belongs to same campus
classSchema.pre('validate', async function(next) {
  if (this.isNew || this.isModified('classManager') || this.isModified('schoolCampus')) {
    if (this.classManager && this.schoolCampus) {
      try {
        const Teacher = mongoose.model('Teacher');
        const teacher = await Teacher.findById(this.classManager);
        
        if (teacher && teacher.schoolCampus.toString() !== this.schoolCampus.toString()) {
          return next(new Error('Class manager must belong to the same campus as the class'));
        }
      } catch (error) {
        return next(error);
      }
    }
  }
});

// ========================================
// INSTANCE METHODS
// ========================================

/**
 * Check if class can accept more students
 */
classSchema.methods.canAddStudent = function() {
  const current = this.students ? this.students.length : 0;
  return current < this.maxStudents && this.status === 'active';
};

/**
 * Add a student to the class
 */
classSchema.methods.addStudent = async function(studentId) {
  if (!this.canAddStudent()) {
    throw new Error('Class is full or not active');
  }
  
  if (!this.students.includes(studentId)) {
    this.students.push(studentId);
    await this.save();
  }
  
  return this;
};

/**
 * Remove a student from the class
 */
classSchema.methods.removeStudent = async function(studentId) {
  this.students = this.students.filter(
    id => id.toString() !== studentId.toString()
  );
  await this.save();
  return this;
};

// ========================================
// STATIC METHODS
// ========================================

/**
 * Find active classes in a campus
 */
classSchema.statics.findActiveByCampus = function(campusId) {
  return this.find({ 
    schoolCampus: campusId, 
    status: 'active' 
  }).populate('level', 'name');
};

/**
 * Find classes by level
 */
classSchema.statics.findByLevel = function(levelId) {
  return this.find({ 
    level: levelId, 
    status: { $ne: 'archived' } 
  });
};

/**
 * Count classes per campus
 */
classSchema.statics.countByCampus = function(campusId) {
  return this.countDocuments({ 
    schoolCampus: campusId, 
    status: { $ne: 'archived' } 
  });
};

/**
 * Find classes by teacher (class manager)
 */
classSchema.statics.findByTeacher = function(teacherId) {
  return this.find({ 
    classManager: teacherId,
    status: { $ne: 'archived' }
  }).populate('level', 'name');
};

const Class = mongoose.model('Class', classSchema);

module.exports = Class;