const mongoose = require('mongoose');

/**
 * Student Model
 * Represents a student enrolled in a campus
 * Campus isolation is enforced through middleware and controllers
 */
const studentSchema = new mongoose.Schema(
  {
    // **PERSONAL INFORMATION**
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: [2, 'First name must be at least 2 characters'],
      maxlength: [50, 'First name must not exceed 50 characters']
    },

    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      minlength: [2, 'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must not exceed 50 characters']
    },

    dateOfBirth: {
      type: Date,
      default: null,
      required: [true, 'Date of birth is required'],
      validate: {
        validator: function (value) {
          // Birth date cannot be in the future
          if (!value) return true;
          return value < new Date();
        },
        message: 'Date of birth cannot be in the future'
      }
    },

    gender: {
      type: String,
      enum: {
        values: ['male', 'female'],
        message: '{VALUE} is not a valid gender'
      },
      required: [true, 'Gender is required']
    },

    // **CONTACT INFORMATION**
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address'
      ]
    },

    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
      match: [
        /^\+?[0-9\s()-]{6,20}$/,
        'Please enter a valid phone number'
      ]
    },

    // **AUTHENTICATION**
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      lowercase: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must not exceed 30 characters'],
      match: [
        /^[a-z0-9_.-]+$/,
        'Username can only contain lowercase letters, numbers, dots, hyphens and underscores'
      ]
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false // Don't include password in queries by default
    },

    passwordResetToken: {
      type: String,
      select: false
    },
    passwordResetExpires: {
      type: Date,
      select: false
    },

    // **PROFILE**
    profileImage: {
      type: String,
      default: null
    },

    // **ACADEMIC ASSIGNMENT**
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus',
      required: [true, 'Campus is required'],
    },

    studentClass: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      required: [true, 'Class is required'],
    },

    mentor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      default: null
    },

    // **ADDITIONAL ACADEMIC INFO**
    matricule: {
      type: String,
      unique: true,
      sparse: true, // Allows null but enforces uniqueness when present
      uppercase: true,
      trim: true
    },

    // **STATUS**
    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'suspended', 'archived'],
        message: '{VALUE} is not a valid status'
      },
      default: 'active',
      index: true
    },

    // **METADATA**
    enrollmentDate: {
      type: Date,
      default: Date.now
    },

    lastLogin: {
      type: Date,
      default: null
    },

    // **EMERGENCY CONTACT**
    emergencyContact: {
      name: { type: String, trim: true },
      phone: { 
        type: String, 
        trim: true,
        match: [/^\+?[0-9\s()-]{6,20}$/, 'Invalid emergency contact phone']
      },
      relationship: { type: String, trim: true }
    }
  },

  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// **COMPOUND INDEXES FOR PERFORMANCE**
// These indexes optimize common queries
studentSchema.index({ schoolCampus: 1, status: 1 }); // Filter by campus and status
studentSchema.index({ schoolCampus: 1, studentClass: 1 }); // Filter by campus and class
studentSchema.index({ firstName: 1, lastName: 1 }); // Search by name
studentSchema.index({ createdAt: -1 }); // Sort by creation date

// **VIRTUAL FIELDS**
// Virtual for full name
studentSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for age (if dateOfBirth exists)
studentSchema.virtual('age').get(function () {
  if (!this.dateOfBirth) return null;
  
  const today = new Date();
  const birthDate = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  return age;
});

// **PRE-SAVE MIDDLEWARE**
// Ensure email and username are lowercase
studentSchema.pre('save', function () {
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
  if (this.username) {
    this.username = this.username.toLowerCase().trim();
  }
  if (this.matricule) {
    this.matricule = this.matricule.toUpperCase().trim();
  }
});

// **PRE-VALIDATE MIDDLEWARE**
// Ensure student's class belongs to the same campus
studentSchema.pre('validate', async function () {
  if (this.isNew || this.isModified('studentClass') || this.isModified('schoolCampus')) {
    if (this.studentClass && this.schoolCampus) {
      try {
        const Class = mongoose.model('Class');
        const studentClassDoc = await Class.findById(this.studentClass)
          .select('schoolCampus')
          .lean();
        
        if (studentClassDoc) {
          if(studentClassDoc.schoolCampus.toString() !== this.schoolCampus.toString()){
            this.invalidate(
              'studentClass',
              'The selected class does not belong to this campus.',
              this.studentClass
            );
          }
        }else {
          this.invalidate(
            'studentClass',
            'Selected class does not exist.',
            this.studentClass
          );
        }
      } catch (error) {
        this.invalidate(
          'studentClass',
          'Error during class verification',
          this.studentClass
        );
      }
    }
  }
});

// **METHODS**
// Check if student can login (active status)
studentSchema.methods.canLogin = function () {
  return this.status === 'active';
};

// Get student's campus info
studentSchema.methods.getCampusInfo = async function () {
  await this.populate('schoolCampus', 'campus_name location').execPopulate();
  return this.schoolCampus;
};

// **STATICS**
// Find active students in a campus
studentSchema.statics.findActiveByCampus = function (campusId) {
  return this.find({ schoolCampus: campusId, status: 'active' });
};

// Find students by class
studentSchema.statics.findByClass = function (classId) {
  return this.find({ 
    studentClass: classId, 
    status: { $ne: 'archived' } 
  });
};

// Count students per campus
studentSchema.statics.countByCampus = function (campusId) {
  return this.countDocuments({ 
    schoolCampus: campusId, 
    status: { $ne: 'archived' } 
  });
};

// ── POST-DELETE ORPHAN CLEANUP ────────────────────────────────────────────────

/**
 * When a student is hard-deleted, remove them from every parent's children[].
 * Fire-and-forget — never blocks the delete operation.
 */
studentSchema.post('findOneAndDelete', function (doc) {
  if (!doc) return;
  const Parent = require('./parent.model');
  Parent.updateMany(
    { children: doc._id },
    { $pull: { children: doc._id } }
  ).exec().catch((err) => {
    console.warn('[Student post-delete] Failed to clean up parent children:', err.message);
  });
});

const Student = mongoose.model('Student', studentSchema);

module.exports = Student;