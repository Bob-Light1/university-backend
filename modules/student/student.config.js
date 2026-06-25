const Student = require('./models/student.model'); // intentional exception: Model from the GenericEntityController
const studentRepo = require('./student.repository');
const { getClassCampusRefForValidation } = require('../class').service; // class module facade (§3)
// campus.service via LAZY require (campus is a hub that requires student → cycle)
const campusService = () => require('../campus').service;
const mongoose = require('mongoose');

/**
 * STUDENT CONFIGURATION FOR GENERIC ENTITY CONTROLLER
 */
const studentConfig = {
  Model: Student,
  entityName: 'Student',
  folderName: 'students',

  // Account-activation onboarding: no default password; the student sets their
  // own via the activation link/code (see modules/account).
  activation: { userModel: 'Student' },

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
    // Class filter — frontend sends `studentClass`; classId kept as legacy alias.
    if (query.studentClass) filters.studentClass = query.studentClass;
    else if (query.classId) filters.studentClass = query.classId;
    // Gender filter
    if (query.gender && ['male', 'female'].includes(query.gender)) {
      filters.gender = query.gender;
    }
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

      const selectedClass = await getClassCampusRefForValidation(fields.studentClass, { session });
  
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
        const existingStudent = await studentRepo.findStudentByMatriculeInCampus(
          fields.matricule, campusId, { session }
        );

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
          const studentCount = await studentRepo.countStudentsInCampus(campusId, { session });

          const campus = await campusService().getCampusNumber(campusId, { session });
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
   * Before update hook - Validate updates
   */
  beforeUpdate: async (student, updates) => {
    try {
      // Prevent modification of critical fields
      const protectedFields = ['_id', 'createdAt', 'updatedAt', '__v', 'password', 'schoolCampus'];
      protectedFields.forEach(field => delete updates[field]);

      // Validate matricule uniqueness if being changed
      if (updates.matricule && updates.matricule !== student.matricule) {
        const existingStudent = await studentRepo.findStudentByMatriculeExcluding(
          updates.matricule, student.schoolCampus, student._id
        );

        if (existingStudent) {
          return {
            success: false,
            error: `Matricule "${updates.matricule}" is already in use`
          };
        }
      }

      // Validate class change belongs to this campus (closes the update blind spot:
      // the campus is immutable here, but studentClass can change — findByIdAndUpdate
      // triggers no document hook, so the rule must be checked HERE).
      if (updates.studentClass &&
          updates.studentClass.toString() !== (student.studentClass?.toString() ?? '')) {
        if (!mongoose.Types.ObjectId.isValid(updates.studentClass)) {
          return { success: false, error: 'Invalid class ID format (ObjectId expected)' };
        }
        const selectedClass = await getClassCampusRefForValidation(updates.studentClass);
        if (!selectedClass) {
          return { success: false, error: 'Selected class does not exist' };
        }
        if (selectedClass.schoolCampus.toString() !== student.schoolCampus.toString()) {
          return { success: false, error: 'The selected class does not belong to this campus' };
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
