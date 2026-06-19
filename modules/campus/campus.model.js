const mongoose = require('mongoose');
const { SUPPORTED_LANGUAGES } = require('../../shared/i18n/languages');

/**
 * Campus Model
 * Represents a school campus in the multi-tenant system
 * Each campus is isolated and managed independently
 */
const campusSchema = new mongoose.Schema(
  {
    campus_name: {
      type: String,
      required: [true, 'Campus name is required'],
      trim: true,
      minlength: [3, 'Campus name must be at least 3 characters'],
      maxlength: [100, 'Campus name must not exceed 100 characters']
    },

    campus_number: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // Allows null values while maintaining uniqueness
      match: [/^[A-Z0-9-]+$/, 'Campus number must contain only uppercase letters, numbers, and hyphens']
    },

    manager_name: {
      type: String,
      required: [true, 'Manager name is required'],
      trim: true,
      minlength: [3, 'Manager name must be at least 3 characters'],
      maxlength: [100, 'Manager name must not exceed 100 characters']
    },

    manager_phone: {
      type: String,
      required: [true, 'Manager phone is required'],
      trim: true,
      match: [/^\+?[0-9\s()-]{6,20}$/, 'Invalid phone number format']
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      // Campus login is performed by email — it must be globally unique and
      // indexed, otherwise concurrent creations can register duplicates and
      // every login performs a full-collection scan.
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address'
      ]
    },

    campus_image: {
      type: String,
      default: null
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false // Never include password in queries by default
    },

    location: {
      address: {
        type: String,
        trim: true,
        default: ''
      },
      city: {
        type: String,
        trim: true,
        default: ''
      },
      country: {
        type: String,
        default: 'Cameroon',
        trim: true
      },
      coordinates: {
        lat: { 
          type: Number,
          min: [-90, 'Latitude must be between -90 and 90'],
          max: [90, 'Latitude must be between -90 and 90']
        },
        lng: { 
          type: Number,
          min: [-180, 'Longitude must be between -180 and 180'],
          max: [180, 'Longitude must be between -180 and 180']
        }
      }
    },

    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'archived'],
        message: '{VALUE} is not a valid status'
      },
      default: 'active'
    },

    // Metadata
    lastLogin: {
      type: Date,
      default: null
    },

    // Commission config for the partner module
    commissionConfig: {
      ruleType: {
        type:   String,
        enum:   ['FIXED', 'PERCENTAGE'],
        default: null,
      },
      fixedAmount: {
        type:    Number,
        default: null,
        min:     0,
      },
      percentage: {
        type:    Number,
        default: null,
        min:     0,
        max:     100,
      },
      defaultCurrency: {
        type:    String,
        default: 'XAF',
        trim:    true,
      },
      updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'Campus',
        default: null,
      },
      updatedAt: {
        type:    Date,
        default: null,
      },
    },

    // Public portal — stable URL slug, e.g. 'douala-principal'
    campusSlug: {
      type:      String,
      trim:      true,
      lowercase: true,
      unique:    true,
      sparse:    true,
      match:     [/^[a-z0-9-]+$/, 'campusSlug must contain only lowercase letters, numbers, and hyphens'],
      default:   null,
    },

    // Formations offered at this campus — used in pre-registration form dropdown
    programs: {
      type:    [String],
      default: [],
    },

    // Next cohort start date — displayed on portal
    nextBatchDate: {
      type:    Date,
      default: null,
    },

    // Public credibility counters — displayed on the portal home page (spec §4.6).
    // Administered from the ERP; null values let the portal hide the counter.
    portalStats: {
      studentsTrained: {
        type:    Number,
        default: null,
        min:     [0, 'studentsTrained cannot be negative'],
      },
      placementRate: {
        type:    Number,
        default: null,
        min:     [0, 'placementRate cannot be negative'],
        max:     [100, 'placementRate is a percentage (0-100)'],
      },
      partnerCompanies: {
        type:    Number,
        default: null,
        min:     [0, 'partnerCompanies cannot be negative'],
      },
    },

    // i18n defaults — Directors set these in Campus Settings
    defaultLanguage: {
      type: String,
      enum: SUPPORTED_LANGUAGES,
      default: 'en',
    },
    defaultTimezone: {
      type: String,
      default: 'UTC',
    },
    defaultGradeFormat: {
      type: String,
      enum: ['FRACTION', 'PERCENT', 'LETTER', 'GPA'],
      default: 'FRACTION',
    },

    // Features configuration (for premium features)
    features: {
      maxStudents: {
        type: Number,
        default: 1000,
        min: [1, 'Max students must be at least 1']
      },
      maxTeachers: {
        type: Number,
        default: 100,
        min: [1, 'Max teachers must be at least 1']
      },
      maxClasses: {
        type: Number,
        default: 50,
        min: [1, 'Max classes must be at least 1']
      },
      maxDocumentStorageMB: {
        type:    Number,
        default: 5120,      
        min:     [100, 'Storage quota must be at least 100 MB'],
        max:     [102400, 'Storage quota cannot exceed 100 GB'],
    },
    }
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// **INDEXES FOR PERFORMANCE**
campusSchema.index({ status: 1 });
campusSchema.index({ createdAt: -1 });
// campusSlug uniqueness is declared on the field (unique + sparse) — no duplicate index here.

// **VIRTUAL FIELDS**
// Virtual for full location string
campusSchema.virtual('fullLocation').get(function () {
  const parts = [
    this.location?.address,
    this.location?.city,
    this.location?.country
  ].filter(Boolean);
  
  return parts.join(', ') || 'Location not specified';
});

// **PRE-SAVE MIDDLEWARE**
// Ensure email and campus_number are lowercase
campusSchema.pre('save', function (next) {
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
  if (this.campus_number) {
    this.campus_number = this.campus_number.toUpperCase().trim();
  }
  next();
});

// **METHODS**
// Check if campus has reached capacity limits
campusSchema.methods.canAddStudent = async function () {
  const Student = mongoose.model('Student');
  const currentCount = await Student.countDocuments({ 
    schoolCampus: this._id,
    status: { $ne: 'archived' }
  });
  return currentCount < this.features.maxStudents;
};

campusSchema.methods.canAddTeacher = async function () {
  const Teacher = mongoose.model('Teacher');
  const currentCount = await Teacher.countDocuments({ 
    schoolCampus: this._id,
    status: { $ne: 'archived' }
  });
  return currentCount < this.features.maxTeachers;
};

campusSchema.methods.canAddClass = async function () {
  const Class = mongoose.model('Class');
  const currentCount = await Class.countDocuments({ 
    campus: this._id,
    status: { $ne: 'archived' }
  });
  return currentCount < this.features.maxClasses;
};
campusSchema.methods.canAddDocumentStorage = async function(additionalBytes) {
  const Document = mongoose.model('Document');
  const result = await Document.aggregate([
    { $match: { campusId: this._id, deletedAt: null, 'importedFile.sizeBytes': { $exists: true } } },
    { $group: { _id: null, total: { $sum: '$importedFile.sizeBytes' } } }
  ]);
  const usedBytes = result[0]?.total || 0;
  const maxBytes  = (this.features.maxDocumentStorageMB || 5120) * 1024 * 1024;
  
  return (usedBytes + additionalBytes) <= maxBytes;
};

// **STATICS**
// Find active campuses only
campusSchema.statics.findActive = function () {
  return this.find({ status: 'active' });
};

// IMPORTANT: Use 'Campus' (not 'SchoolCampus') for consistency across models
const Campus = mongoose.model('Campus', campusSchema);

module.exports = Campus;