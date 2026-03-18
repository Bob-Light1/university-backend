const Teacher    = require('../models/teacher.model');
const Department = require('../models/department.model');
const Class      = require('../models/class.model');
const mongoose   = require('mongoose');

/**
 * TEACHER CONFIGURATION FOR GENERIC ENTITY CONTROLLER
 *
 * Class ↔ Teacher synchronisation rules
 * ──────────────────────────────────────
 * The Teacher model holds `classes[]` (classes the teacher teaches) and the
 * Class model holds `teachers[]` (teachers linked to a class) as well as
 * `classManager` (the one teacher in charge of a class).
 *
 * To keep both sides consistent we use the afterCreate / afterUpdate hooks:
 *  • On create : add the teacher to Class.teachers[] for every assigned class,
 *                and set Class.classManager if `classManagerOf` is provided.
 *  • On update : diff the old vs new class lists, add/remove the teacher from
 *                Class.teachers[] accordingly, and reconcile classManager.
 *
 * Campus isolation note
 * ──────────────────────
 * The teacher model's pre-validate middleware already rejects classes that
 * don't belong to the same campus. The hooks below add an extra guard at the
 * controller level for defence-in-depth.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Synchronise the Class.teachers[] array when a teacher's class list changes.
 *
 * @param {string}   teacherId    - Teacher ObjectId (string)
 * @param {string[]} addedIds     - Class ObjectIds to add the teacher to
 * @param {string[]} removedIds   - Class ObjectIds to remove the teacher from
 * @param {string}   campusId     - Campus ObjectId used as an extra safety filter
 */
const _syncTeacherInClasses = async (teacherId, addedIds, removedIds, campusId) => {
  const ops = [];

  // Add teacher to newly assigned classes — campus-scoped for safety
  if (addedIds.length > 0) {
    ops.push(
      Class.updateMany(
        { _id: { $in: addedIds }, schoolCampus: campusId },
        { $addToSet: { teachers: teacherId } }
      )
    );
  }

  // Remove teacher from unassigned classes — campus-scoped for safety
  if (removedIds.length > 0) {
    ops.push(
      Class.updateMany(
        { _id: { $in: removedIds }, schoolCampus: campusId },
        { $pull: { teachers: teacherId } }
      )
    );
  }

  await Promise.all(ops);
};

/**
 * Reconcile Class.classManager when the teacher's `classManagerOf` field changes.
 *
 * @param {string}      teacherId       - Teacher ObjectId (string)
 * @param {string|null} newManagerOfId  - Class ObjectId this teacher NOW manages (or null)
 * @param {string|null} oldManagerOfId  - Class ObjectId this teacher WAS managing (or null)
 * @param {string}      campusId        - Campus safety filter
 */
const _syncClassManager = async (teacherId, newManagerOfId, oldManagerOfId, campusId) => {
  const ops = [];

  // Remove teacher as classManager from the previously managed class
  if (oldManagerOfId && oldManagerOfId !== newManagerOfId) {
    ops.push(
      Class.updateOne(
        { _id: oldManagerOfId, classManager: teacherId, schoolCampus: campusId },
        { $set: { classManager: null } }
      )
    );
  }

  // Assign teacher as classManager of the newly designated class
  if (newManagerOfId) {
    ops.push(
      Class.updateOne(
        { _id: newManagerOfId, schoolCampus: campusId },
        { $set: { classManager: teacherId } }
      )
    );
  }

  await Promise.all(ops);
};

// ─── Teacher config ───────────────────────────────────────────────────────────

const teacherConfig = {
  Model:      Teacher,
  entityName: 'Teacher',
  folderName: 'teachers',

  searchFields: [
    'firstName',
    'lastName',
    'email',
    'phone',
    'matricule',
    'specialization',
  ],

  populateFields: [
    { path: 'department',   select: 'name description' },
    { path: 'schoolCampus', select: 'campus_name location' },
    { path: 'subjects',     select: 'subject_name subject_code' },
    {
      path:    'classes',
      select:  'className level classManager',
      populate: { path: 'level', select: 'name' },
    },
  ],

  // ─── Custom validation ─────────────────────────────────────────────────────

  /**
   * Validates department and matricule before creation or update.
   * Classes are validated by the Mongoose pre-validate hook on Teacher.
   */
  customValidation: async (fields, campusId, session) => {
    try {
      // Validate department if provided
      if (fields.department) {
        if (!mongoose.Types.ObjectId.isValid(fields.department)) {
          return { valid: false, error: 'Invalid department ID format (ObjectId expected)' };
        }

        const selectedDepartment = await Department.findById(fields.department)
          .select('schoolCampus name')
          .session(session)
          .lean();

        if (!selectedDepartment) {
          return { valid: false, error: 'Selected department does not exist' };
        }

        if (selectedDepartment.schoolCampus.toString() !== campusId.toString()) {
          return {
            valid: false,
            error: `The selected department "${selectedDepartment.name}" does not belong to this campus`,
          };
        }
      }

      // Validate matricule uniqueness within campus
      if (fields.matricule) {
        const existingTeacher = await Teacher.findOne({
          matricule:    fields.matricule,
          schoolCampus: campusId,
        })
          .select('_id')
          .session(session)
          .lean();

        if (existingTeacher) {
          return {
            valid: false,
            error: `Matricule "${fields.matricule}" is already in use in this campus`,
          };
        }
      }

      // Validate employment type — must match teacher.model.js enum exactly
      const validEmploymentTypes = ['full-time', 'part-time', 'contract', 'temporary'];
      if (fields.employmentType && !validEmploymentTypes.includes(fields.employmentType)) {
        return {
          valid: false,
          error: `Invalid employment type. Must be one of: ${validEmploymentTypes.join(', ')}`,
        };
      }

      // Validate classManagerOf is among the assigned classes (frontend also validates this)
      if (fields.classManagerOf) {
        const assignedClasses = Array.isArray(fields.classes) ? fields.classes : [];
        if (!assignedClasses.includes(fields.classManagerOf)) {
          return {
            valid: false,
            error: 'The class designated for classManager must be among the assigned classes',
          };
        }

        // Verify the class actually exists and belongs to this campus
        if (!mongoose.Types.ObjectId.isValid(fields.classManagerOf)) {
          return { valid: false, error: 'Invalid classManagerOf ID format' };
        }

        const managedClass = await Class.findOne({
          _id:          fields.classManagerOf,
          schoolCampus: campusId,
        })
          .select('_id')
          .lean();

        if (!managedClass) {
          return {
            valid: false,
            error: 'The designated class does not exist or does not belong to this campus',
          };
        }
      }

      return { valid: true };

    } catch (error) {
      console.error('Teacher custom validation error:', error);
      return { valid: false, error: 'Error validating teacher data' };
    }
  },

  // ─── beforeCreate ──────────────────────────────────────────────────────────

  /**
   * Auto-generate matricule if not provided.
   * `classManagerOf` is consumed here and stored temporarily on `fields` so
   * afterCreate can access it after the document is saved.
   */
  beforeCreate: async (fields, campusId, session) => {
    try {
      if (!fields.matricule) {
        const teacherCount = await Teacher.countDocuments({
          schoolCampus: campusId,
        }).session(session);

        const campus       = await mongoose.model('Campus').findById(campusId).select('campus_number');
        const campusPrefix = campus?.campus_number || 'CAM';

        fields.matricule = `${campusPrefix}-TCH-${String(teacherCount + 1).padStart(4, '0')}`;
      }

      return { success: true };
    } catch (error) {
      console.error('Teacher beforeCreate error:', error);
      return { success: false, error: 'Failed to prepare teacher data' };
    }
  },

  // ─── afterCreate ──────────────────────────────────────────────────────────

  /**
   * After the teacher document is committed, synchronise Class collections:
   *  1. Add teacher to Class.teachers[] for every assigned class.
   *  2. Set Class.classManager for the designated class (if any).
   *
   * These operations are intentionally non-transactional (run after commit) to
   * avoid holding the session open. A failure here is logged but does NOT
   * roll back the teacher creation — the admin can re-assign via the edit form.
   *
   * @param {Document} teacher - The saved Teacher mongoose document
   * @param {Object}   fields  - Original request fields (contains classManagerOf)
   */
  afterCreate: async (teacher, fields = {}) => {
    const teacherId  = teacher._id.toString();
    const campusId   = teacher.schoolCampus.toString();
    const classIds   = (teacher.classes || []).map((id) => id.toString());
    const managerOf  = fields.classManagerOf || null;

    try {
      // 1. Add teacher to Class.teachers[] for all assigned classes
      await _syncTeacherInClasses(teacherId, classIds, [], campusId);

      // 2. Set classManager on the designated class
      if (managerOf) {
        await _syncClassManager(teacherId, managerOf, null, campusId);
      }

      console.log(
        `✅ Teacher created: ${teacher.firstName} ${teacher.lastName} (${teacher.matricule})`,
        classIds.length > 0
          ? `| Assigned to ${classIds.length} class(es)` : '',
        managerOf ? `| classManager of ${managerOf}` : ''
      );
    } catch (error) {
      // Non-critical: log but don't crash
      console.error(`⚠️  afterCreate class sync failed for teacher ${teacherId}:`, error.message);
    }
  },

  // ─── beforeUpdate ──────────────────────────────────────────────────────────

  /**
   * Validate department change and matricule uniqueness before saving an update.
   */
  beforeUpdate: async (teacher, updates) => {
    try {
      // Immutable fields
      delete updates._id;
      delete updates.createdAt;
      delete updates.__v;
      delete updates.password; // Handled by a dedicated endpoint

      // Validate matricule uniqueness if being changed
      if (updates.matricule && updates.matricule !== teacher.matricule) {
        const existingTeacher = await Teacher.findOne({
          matricule:    updates.matricule,
          schoolCampus: teacher.schoolCampus,
          _id:          { $ne: teacher._id },
        }).select('_id');

        if (existingTeacher) {
          return { success: false, error: `Matricule "${updates.matricule}" is already in use` };
        }
      }

      // Validate department change
      if (updates.department && updates.department !== teacher.department?.toString()) {
        const newDepartment = await Department.findById(updates.department).select('schoolCampus name');

        if (!newDepartment) {
          return { success: false, error: 'New department does not exist' };
        }

        if (newDepartment.schoolCampus.toString() !== teacher.schoolCampus.toString()) {
          return {
            success: false,
            error: `Department "${newDepartment.name}" does not belong to the same campus`,
          };
        }
      }

      // Validate classManagerOf coherence if provided in updates
      if (updates.classManagerOf !== undefined) {
        const incomingClasses = updates.classes
          ? updates.classes.map((id) => id.toString())
          : (teacher.classes || []).map((id) => id.toString());

        if (updates.classManagerOf && !incomingClasses.includes(updates.classManagerOf.toString())) {
          return {
            success: false,
            error: 'The class designated for classManager must be among the assigned classes',
          };
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Teacher beforeUpdate error:', error);
      return { success: false, error: 'Validation failed during update' };
    }
  },

  // ─── afterUpdate ──────────────────────────────────────────────────────────

  /**
   * After a teacher update is committed, synchronise Class collections:
   *  1. Diff old vs new class lists → add/remove teacher in Class.teachers[].
   *  2. Reconcile Class.classManager (unset old, set new if changed).
   *
   * `updatedTeacher` comes from the controller (toObject()), so `fields` must
   * carry the raw `classManagerOf` value from the original request body.
   * The controller passes `fields` via a convention: afterUpdate(entity, fields).
   * If your GenericEntityController doesn't forward `fields`, see the note below.
   *
   * @param {Object} updatedTeacher - Plain teacher object after update
   * @param {Object} fields         - Raw update payload (contains classManagerOf)
   * @param {Object} previousData   - Snapshot of the teacher BEFORE the update
   */
  afterUpdate: async (updatedTeacher, fields = {}, previousData = {}) => {
    const teacherId  = updatedTeacher._id.toString();
    const campusId   = updatedTeacher.schoolCampus?._id?.toString()
      || updatedTeacher.schoolCampus?.toString();

    try {
      // ── 1. Sync Class.teachers[] ──────────────────────────────────────────

      const newClassIds = (updatedTeacher.classes || [])
        .map((c) => (c._id || c).toString());

      const oldClassIds = (previousData.classes || [])
        .map((c) => (c._id || c).toString());

      const addedClasses   = newClassIds.filter((id) => !oldClassIds.includes(id));
      const removedClasses = oldClassIds.filter((id) => !newClassIds.includes(id));

      if (addedClasses.length > 0 || removedClasses.length > 0) {
        await _syncTeacherInClasses(teacherId, addedClasses, removedClasses, campusId);
      }

      // ── 2. Sync Class.classManager ────────────────────────────────────────

      // Detect the previously managed class by querying the DB
      // (previousData may not always carry classManagerOf)
      const prevManagerClass = await Class.findOne({
        classManager: teacherId,
        schoolCampus: campusId,
      }).select('_id').lean();

      const oldManagerOfId = prevManagerClass?._id?.toString() || null;
      const newManagerOfId = fields.classManagerOf || null;

      if (oldManagerOfId !== newManagerOfId) {
        await _syncClassManager(teacherId, newManagerOfId, oldManagerOfId, campusId);
      }

      console.log(
        `✅ Teacher updated: ${updatedTeacher.firstName} ${updatedTeacher.lastName}`,
        addedClasses.length   > 0 ? `| +${addedClasses.length} class(es)`   : '',
        removedClasses.length > 0 ? `| -${removedClasses.length} class(es)` : '',
        newManagerOfId ? `| classManager of ${newManagerOfId}` : ''
      );
    } catch (error) {
      console.error(`⚠️  afterUpdate class sync failed for teacher ${teacherId}:`, error.message);
    }
  },

  // ─── Statistics ────────────────────────────────────────────────────────────

  /**
   * Custom statistics facets for teachers.
   * Provides detailed analytics for teacher management dashboards.
   */
  statsFacets: (startOfMonth) => ({
    byDepartment: [
      {
        $lookup: {
          from:         'departments',
          localField:   'department',
          foreignField: '_id',
          as:           'departmentInfo',
        },
      },
      { $unwind: { path: '$departmentInfo', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id:            '$department',
          departmentName: { $first: '$departmentInfo.name' },
          count:          { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ],

    byEmploymentType: [
      { $group: { _id: '$employmentType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ],

    byGender: [
      { $group: { _id: '$gender', count: { $sum: 1 } } },
    ],

    byQualification: [
      { $group: { _id: '$qualification', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ],

    recentlyHired: [
      { $match: { hireDate: { $gte: startOfMonth }, status: 'active' } },
      {
        $project: {
          firstName:      1,
          lastName:       1,
          matricule:      1,
          department:     1,
          employmentType: 1,
          hireDate:       1,
        },
      },
      { $sort: { hireDate: -1 } },
      { $limit: 10 },
    ],

    withoutDepartment: [
      { $match: { department: { $exists: false }, status: 'active' } },
      { $count: 'count' },
    ],

    experienceStats: [
      {
        $group: {
          _id:    null,
          avgExp: { $avg: '$experience' },
          minExp: { $min: '$experience' },
          maxExp: { $max: '$experience' },
        },
      },
    ],

    byRole: [
      { $unwind: '$roles' },
      { $group: { _id: '$roles', count: { $sum: 1 } } },
    ],

    multiSubjectTeachers: [
      { $match: { subjects: { $exists: true } } },
      { $project: { subjectCount: { $size: { $ifNull: ['$subjects', []] } } } },
      { $match: { subjectCount: { $gt: 1 } } },
      { $count: 'count' },
    ],

    classManagers: [
      { $match: { classes: { $exists: true, $ne: [] } } },
      { $count: 'count' },
    ],
  }),

  /**
   * Format statistics output for frontend consumption.
   */
  statsFormatter: (result) => ({
    byDepartment: (result.byDepartment || []).map((dept) => ({
      departmentId:   dept._id,
      departmentName: dept.departmentName || 'Unassigned',
      count:          dept.count,
    })),

    byEmploymentType: (result.byEmploymentType || []).reduce((acc, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {}),

    genderStats: (result.byGender || []).reduce((acc, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {}),

    byQualification: (result.byQualification || []).reduce((acc, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {}),

    recentlyHired: result.recentlyHired || [],

    withoutDepartment: result.withoutDepartment?.[0]?.count || 0,

    experience: {
      average: Math.round(result.experienceStats?.[0]?.avgExp || 0),
      min:     result.experienceStats?.[0]?.minExp || 0,
      max:     result.experienceStats?.[0]?.maxExp || 0,
    },

    rolesDistribution: (result.byRole || []).reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),

    multiSubjectTeachers: result.multiSubjectTeachers?.[0]?.count || 0,

    teachersWithClasses: result.classManagers?.[0]?.count || 0,
  }),
};

module.exports = teacherConfig;