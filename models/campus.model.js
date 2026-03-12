const mongoose = require('mongoose');

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
campusSchema.index({ status: 1 }); // For filtering active campuses
campusSchema.index({ createdAt: -1 }); // For sorting by creation date

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