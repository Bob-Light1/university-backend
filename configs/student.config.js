const Student = require('../models/student-models/student.model');
const Class = require('../models/class.model');
const mongoose = require('mongoose');

/**
 * STUDENT CONFIGURATION FOR GENERIC ENTITY CONTROLLER
 */
const studentConfig = {
  Model: Student,
  entityName: 'Student',
  folderName: 'students',

  searchFields: [
    'firstName',
    'lastName',
    'email',
    'matricule',
    'phone'
  ],

  populateFields: [
    { path: 'studentClass', select: 'className level' },
    { path: 'schoolCampus', select: 'campus_name location' },
    { path: 'mentor', select: 'firstName lastName email' }
  ],

  buildExtraFilters: (query) => {
    const filters = {};
    if (query.classId) filters.studentClass = query.classId;
    return filters;
  },

  /**
   * Custom validation before creation
   */
  customValidation: async (fields, campusId, session) => {
   
    try {
    
      if (!fields.studentClass) {
        return { 
          valid: false, 
          error: 'Student class is required' 
        };
      }
  
      if (!mongoose.Types.ObjectId.isValid(fields.studentClass)) {
        return { 
          valid: false, 
          error: 'Invalid class ID format( ObjectId format expected)' 
        };
      }

      const selectedClass = await Class.findById(fields.studentClass)
        .select('schoolCampus className')
        .session(session)
        .lean();
  
      if (!selectedClass) {
        return { 
          valid: false, 
          error: 'Selected class does not exist' 
        };
      }
  
      if (selectedClass.schoolCampus.toString() !== campusId.toString()) {
        return {
          valid: false,
          error: `The selected class "${selectedClass.className || 'unknown'}" does not belong to this campus`
        };
      }

       // Validate matricule uniqueness within campus
       if (fields.matricule) {
        const existingStudent = await Student.findOne({
          matricule: fields.matricule,
          schoolCampus: campusId
        })
        .select('_id')
        .session(session)
        .lean();

        if (existingStudent) {
          return {
            valid: false,
            error: `Matricule "${fields.matricule}" is already in use in this campus`
          };
        }
      }
  
      return { valid: true };

    } catch (error) {
      console.error('Custom validation error:', error);

      return { 
        valid: false, 
        error: 'Error validating class-campus relation' 
      };
    }
  },

  /**
   * Custom statistics facets for students
   */
  statsFacets: () => ({
    genderDistribution: [
      { $group: { _id: "$gender", count: { $sum: 1 } } }
    ],

    classDistribution: [
      { $group: { _id: "$studentClass", count: { $sum: 1 } } }
    ]
  }),

  /**
   * Format custom stats result
   */
  statsFormatter: (result) => ({
    genderStats: (result.genderDistribution || []).reduce(
      (acc, curr) => {
        const key = curr._id || "unknown";
        acc[key] = curr.count;
        return acc;
      },
      {}
    ),

    classStats: result.classDistribution || []
  }),


    /**
   * Before create hook - Student-specific pre-processing
   */
    beforeCreate: async (fields, campusId, session) => {
      try {
        // Auto-generate matricule if not provided
        if (!fields.matricule) {
          const studentCount = await Student.countDocuments({
            schoolCampus: campusId
          }).session(session);
  
          const Campus= mongoose.model('Campus');
          const campus = await Campus.findById(campusId).select('campus_number').session(session);
          const campusPrefix = campus?.campus_number || 'CAM';
          
          fields.matricule = `${campusPrefix}-STD-${String(studentCount + 1).padStart(4, '0')}`;
        }
  
        return { success: true };
      } catch (error) {
        console.error('Student beforeCreate error:', error);
        return { 
          success: false, 
          error: 'Failed to prepare student data' 
        };
      }
    },
  
   /**
   * After create hook - Post-creation actions
   */
   afterCreate: async (student) => {
    // Could trigger additional actions:
    // - Send welcome email
    // - Create student portal account
    // - Notify department head
    // - Add to default student groups
  },

  /**
   * Before update hook - Validate updates
   */
  beforeUpdate: async (student, updates) => {
    try {
      // Prevent modification of critical fields
      const protectedFields = ['_id', 'createdAt', 'updatedAt', '__v', 'password', 'schoolCampus'];
      protectedFields.forEach(field => delete updates[field]);

      // Validate matricule uniqueness if being changed
      if (updates.matricule && updates.matricule !== student.matricule) {
        const existingStudent = await Student.findOne({
          matricule: updates.matricule,
          schoolCampus: student.schoolCampus,
          _id: { $ne: student._id }
        }).select('_id').lean();

        if (existingStudent) {
          return {
            success: false,
            error: `Matricule "${updates.matricule}" is already in use`
          };
        }
      }

      return { success: true };

    } catch (error) {
      console.error('Student beforeUpdate error:', error);
      return { 
        success: false, 
        error: 'Validation failed during update' 
      };
    }
  },

    /**
   * After update hook - Post-update actions
   */
    afterUpdate: async (student) => {
      console.log(`Student updated: ${student.firstName} ${student.lastName} (${student.matricule})`);
      
      // Could trigger:
      // - Notify admin of critical field changes
      // - Update student portal permissions
    },
};

module.exports = studentConfig;
