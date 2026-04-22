const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Teacher Model
 * Represents a teacher assigned to a campus
 * Campus isolation enforced through middleware and controllers
 */
const teacherSchema = new mongoose.Schema(
  {
    // **ACADEMIC ASSIGNMENT**
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus', // Fixed: Consistent naming
      required: [true, 'Campus is required'],
      index: true // Index for faster campus-based queries
    },

    subjects: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject'
    }],

    classes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class'
    }],

    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: [true, 'Department is required']
    },

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
        values: ['male', 'female', 'other'],
        message: '{VALUE} is not a valid gender'
      },
      required: [true, 'Gender is required']
    },

    // **CONTACT INFORMATION**
    email: {
      type: String,
      required: [true, 'Email is required'],
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
      unique: true,
      sparse: true, // Allows null but enforces uniqueness when present
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

    // **PROFESSIONAL INFORMATION**
    qualification: {
      type: String,
      required: [true, 'Qualification is required'],
      trim: true,
      maxlength: [100, 'Qualification must not exceed 100 characters']
    },

    specialization: {
      type: String,
      trim: true,
      maxlength: [100, 'Specialization must not exceed 100 characters']
    },

    experience: {
      type: Number,
      min: [0, 'Experience cannot be negative'],
      max: [50, 'Experience cannot exceed 50 years'],
      default: 0
    },

    // **PROFILE**
    profileImage: {
      type: String,
      default: null
    },

    // **ROLES AND PERMISSIONS**
    roles: {
      type: [String],
      default: ['TEACHER'],
      validate: {
        validator: function (roles) {
          const validRoles = ['TEACHER', 'MENTOR', 'DEPARTMENT_HEAD'];
          return roles.every(role => validRoles.includes(role));
        },
        message: 'Invalid role specified'
      }
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

    // **EMPLOYMENT INFORMATION**
    hireDate: {
      type: Date,
      default: Date.now
    },

    employmentType: {
      type: String,
      enum: {
        values: ['full-time', 'part-time', 'contract', 'temporary'],
        message: '{VALUE} is not a valid employment type'
      },
      default: 'full-time'
    },

    salary: {
      type: Number,
      min: [0, 'Salary cannot be negative'],
      select: false // Hidden by default for privacy
    },

    // **METADATA**
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
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// **COMPOUND INDEXES FOR PERFORMANCE**
teacherSchema.index(
  { schoolCampus: 1, email: 1 },
  { unique: true }
);
teacherSchema.index({ schoolCampus: 1, status: 1 }); // Filter by campus and status
teacherSchema.index({ firstName: 1, lastName: 1 }); // Search by name
teacherSchema.index({ employmentType: 1, status: 1 }); // Employment reports
teacherSchema.index({ createdAt: -1 }); // Sort by creation date

// **VIRTUAL FIELDS**
// Virtual for full name
teacherSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for age (if dateOfBirth exists)
teacherSchema.virtual('age').get(function () {
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

// Virtual for years of service
teacherSchema.virtual('yearsOfService').get(function () {
  if (!this.hireDate) return 0;
  
  const today = new Date();
  const hireDate = new Date(this.hireDate);
  let years = today.getFullYear() - hireDate.getFullYear();
  const monthDiff = today.getMonth() - hireDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < hireDate.getDate())) {
    years--;
  }
  
  return Math.max(0, years);
});

// **PRE-SAVE MIDDLEWARE**
// Ensure lowercase for email and username
teacherSchema.pre('save', function () {
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
// Ensure teacher's classes and subjects belong to the same campus
teacherSchema.pre('validate', async function () {
  if (this.isNew || this.isModified('classes') || this.isModified('schoolCampus')) {
    if (this.classes && this.classes.length > 0 && this.schoolCampus) {
      try {
        const Class = mongoose.model('Class');
        
        // Check all classes belong to the same campus
        const classDocs = await Class.find(
          { _id: { $in: this.classes } },
          'schoolCampus'
        ).lean();

        if (classDocs.length !== this.classes.length) {
          throw new Error('One or more assigned classes does not exist !');
        }
     
        const wrongCampus = classDocs.some(
          c => c.schoolCampus.toString() !== this.schoolCampus.toString()
        );

        if (wrongCampus) {
          throw new Error('All assigned classes must belong to the same campus as the teacher');
        }

        //Subjects verification
        if ((this.isModified('subjects') || this.isModified('schoolCampus')) && this.subjects?.length > 0) {
            const Subject = mongoose.model('Subject');
            const subjectDocs = await Subject.find(
              { _id: { $in: this.subjects } },
            ).lean();

            const wrongSubjectCampus = subjectDocs.some(
              s => s.schoolCampus && s.schoolCampus.toString() !== this.schoolCampus.toString()
            );

            if (wrongSubjectCampus) {
              throw new Error('All assigned subjects must belong to the same campus as the teacher.');
            }
        }
      } catch (error) {
        throw new Error(error.message);
      }
    }
  }
});

// **METHODS**
// Check if teacher can login (active status)
teacherSchema.methods.canLogin = function () {
  return this.status === 'active';
};

// Check if teacher has a specific role
teacherSchema.methods.hasRole = function (role) {
  return this.roles.includes(role);
};

// Get teacher's campus info
teacherSchema.methods.getCampusInfo = async function () {
  await this.populate('schoolCampus', 'campus_name location');
  return this.schoolCampus;
};

// **STATICS**
// Find active teachers in a campus
teacherSchema.statics.findActiveByCampus = function (campusId) {
  return this.find({ schoolCampus: campusId, status: 'active' });
};

// Find teachers by subject
teacherSchema.statics.findBySubject = function (subjectId) {
  return this.find({ 
    subjects: subjectId, 
    status: { $ne: 'archived' } 
  });
};

// Count teachers per campus
teacherSchema.statics.countByCampus = function (campusId) {
  return this.countDocuments({ 
    schoolCampus: campusId, 
    status: { $ne: 'archived' } 
  });
};

teacherSchema.methods.createPasswordResetToken = function() {
  const resetToken = crypto.randomBytes(32).toString('hex');
    this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.passwordResetExpires = Date.now() + 10 * 60 * 1000;

    return resetToken;
  };

const Teacher = mongoose.model('Teacher', teacherSchema);

module.exports = Teacher;