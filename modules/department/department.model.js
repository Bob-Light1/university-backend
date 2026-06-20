const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Department name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters']
    },

    code: {
      type: String,
      required: [true, 'Department code is required'],
      uppercase: true,
      trim: true,
      minlength: [2, 'Code must be at least 2 characters'],
      maxlength: [10, 'Code must not exceed 10 characters']
    },

    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters']
    },

    // Chief of department
    headOfDepartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      default: null
    },

    // Campus isolation
    schoolCampus: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campus',
      required: [true, 'Campus is required'],
      index: true
    },

    // Status
    status: {
      type: String,
      enum: ['active', 'inactive', 'archived'],
      default: 'active'
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// **INDEXES**
departmentSchema.index({ schoolCampus: 1, name: 1 }, { unique: true }); // Nom unique par campus
departmentSchema.index({ schoolCampus: 1, code: 1 }, { unique: true }); // Code unique par campus

// **VIRTUALS**
departmentSchema.virtual('teachers', {
  ref: 'Teacher',
  localField: '_id',
  foreignField: 'department'
});

departmentSchema.virtual('teacherCount', {
  ref: 'Teacher',
  localField: '_id',
  foreignField: 'department',
  count: true
});

// NOTE: deletion is always a soft delete (status -> 'archived'); the archive
// controller blocks archiving while active teachers remain assigned (via the
// teacher facade). No document `remove` hook is used: Mongoose 8 dropped
// `Document.prototype.remove()`, so such a hook would never fire.

const Department = mongoose.model('Department', departmentSchema);

module.exports = Department;