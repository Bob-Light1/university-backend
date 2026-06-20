const departmentRepo = require('../department.repository');
const departmentConfig = require('../department.config');
const GenericEntityController = require('../../../shared/lib/generic-entity.controller');
// Lazy require: teacher.config consumes the department facade (department ↔ teacher cycle).
const countTeachersInDepartment = (...args) =>
  require('../../teacher').service.countActiveInDepartment(...args);
// Lazy require (same cycle): validate a head-of-department belongs to the campus.
const validateTeacherBelongsToCampus = (...args) =>
  require('../../teacher').service.validateTeacherBelongsToCampus(...args);

const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendConflict,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const { isValidObjectId, buildCampusFilter } = require('../../../shared/utils/validation-helpers');

// ── Generic controller (used only for getAll, getOne, getStats) ──
const genericController = new GenericEntityController(departmentConfig);

// ============================================================
// HELPERS
// ============================================================

/**
 * Resolve the campusId from the request depending on the user role.
 * Returns { campusId } or { error } to send back.
 */
const resolveCampusId = (req, bodyField = 'schoolCampus') => {
  const { role, campusId: userCampusId } = req.user;

  if (role === 'CAMPUS_MANAGER') return { campusId: userCampusId };

  if (['ADMIN', 'DIRECTOR'].includes(role)) {
    const id = req.body[bodyField] || req.query.campusId;
    if (!id) return { error: 'Campus ID is required' };
    if (!isValidObjectId(id)) return { error: 'Invalid campus ID' };
    return { campusId: id };
  }

  return { error: 'Not authorized' };
};

// ============================================================
// CREATE DEPARTMENT
// ============================================================
const createDepartment = async (req, res) => {
  try {
    const { name, code, description, headOfDepartment } = req.body;

    if (!name || !code) {
      return sendError(res, 400, 'Name and code are required');
    }

    const { campusId, error } = resolveCampusId(req);
    if (error) return sendError(res, 400, error);

    // Uniqueness checks within campus
    const [nameExists, codeExists] = await Promise.all([
      departmentRepo.findByNameInCampus(campusId, name.trim()),
      departmentRepo.findByCodeInCampus(campusId, code.toUpperCase().trim()),
    ]);

    if (nameExists) return sendConflict(res, `Department "${name}" already exists in this campus`);
    if (codeExists) return sendConflict(res, `Code "${code.toUpperCase()}" is already used in this campus`);

    if (headOfDepartment) {
      if (!isValidObjectId(headOfDepartment)) {
        return sendError(res, 400, 'Invalid head of department ID');
      }
      // Campus integrity: the head must belong to the same campus.
      const belongs = await validateTeacherBelongsToCampus(headOfDepartment, campusId);
      if (!belongs) {
        return sendError(res, 400, 'Head of department must be a teacher of this campus');
      }
    }

    const saved = await departmentRepo.create({
      name: name.trim(),
      code: code.toUpperCase().trim(),
      description: description?.trim(),
      headOfDepartment: headOfDepartment || null,
      schoolCampus: campusId,
      status: 'active',
    });

    const populated = await departmentRepo.findByIdForResponse(saved._id);

    return sendCreated(res, 'Department created successfully', populated);
  } catch (err) {
    console.error('❌ createDepartment:', err);
    if (err.code === 11000) return sendConflict(res, 'Department name or code already exists');
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => e.message);
      return sendError(res, 400, 'Validation failed', { errors });
    }
    return sendError(res, 500, 'Failed to create department');
  }
};

// ============================================================
// GET ALL DEPARTMENTS
// ============================================================
const getAllDepartments = async (req, res) => {
  try {
    const { search, status, includeArchived, page = 1, limit = 100 } = req.query;

    // Cap the page size to avoid full-collection scans under load.
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    let baseFilter;
    try {
      baseFilter = buildCampusFilter(req.user, req.query.campusId);
    } catch {
      // buildCampusFilter throws when a non-global role has no campus in its JWT.
      return sendError(res, 403, 'Campus scope required');
    }

    const { data: departments, total } = await departmentRepo.paginate({
      baseFilter,
      includeArchived: includeArchived === 'true',
      status,
      search,
      skip,
      limit: safeLimit,
    });

    return sendPaginated(res, 200, 'Departments retrieved successfully', departments, {
      total, page: safePage, limit: safeLimit,
    });
  } catch (err) {
    console.error('❌ getAllDepartments:', err);
    return sendError(res, 500, 'Failed to retrieve departments');
  }
};

// ============================================================
// GET ONE DEPARTMENT
// ============================================================
const getOneDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid department ID');

    const department = await departmentRepo.findByIdDetailed(id);

    if (!department) return sendNotFound(res, 'Department');

    // Campus isolation for every non-global role (CAMPUS_MANAGER, TEACHER, …).
    if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
      const deptCampusId = department.schoolCampus?._id?.toString() || department.schoolCampus?.toString();
      if (deptCampusId !== req.user.campusId?.toString()) {
        return sendError(res, 403, 'This department does not belong to your campus');
      }
    }

    return sendSuccess(res, 200, 'Department retrieved successfully', department);
  } catch (err) {
    console.error('❌ getOneDepartment:', err);
    return sendError(res, 500, 'Failed to retrieve department');
  }
};

// ============================================================
// UPDATE DEPARTMENT
// ============================================================
const updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid department ID');

    const department = await departmentRepo.findByIdLean(id);
    if (!department) return sendNotFound(res, 'Department');

    // Campus isolation
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (department.schoolCampus.toString() !== req.user.campusId.toString()) {
        return sendError(res, 403, 'Can only update departments from your campus');
      }
    }

    const { name, code, description, headOfDepartment, status } = req.body;
    const updates = {};

    // Name uniqueness
    if (name && name.trim() !== department.name) {
      const exists = await departmentRepo.findByNameInCampusExcept(department.schoolCampus, name.trim(), id);
      if (exists) return sendConflict(res, `Department "${name}" already exists`);
      updates.name = name.trim();
    }

    // Code uniqueness
    if (code && code.toUpperCase().trim() !== department.code) {
      const exists = await departmentRepo.findByCodeInCampusExcept(department.schoolCampus, code.toUpperCase().trim(), id);
      if (exists) return sendConflict(res, `Code "${code.toUpperCase()}" is already used`);
      updates.code = code.toUpperCase().trim();
    }

    if (description !== undefined) updates.description = description?.trim();
    if (headOfDepartment !== undefined) {
      if (headOfDepartment) {
        if (!isValidObjectId(headOfDepartment)) {
          return sendError(res, 400, 'Invalid head of department ID');
        }
        // Campus integrity: the head must belong to this department's campus.
        const belongs = await validateTeacherBelongsToCampus(headOfDepartment, department.schoolCampus);
        if (!belongs) {
          return sendError(res, 400, 'Head of department must be a teacher of this campus');
        }
      }
      updates.headOfDepartment = headOfDepartment || null;
    }
    if (status) updates.status = status;

    const updated = await departmentRepo.updateById(id, updates);

    return sendSuccess(res, 200, 'Department updated successfully', updated);
  } catch (err) {
    console.error('❌ updateDepartment:', err);
    if (err.code === 11000) return sendConflict(res, 'Department name or code already exists');
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => e.message);
      return sendError(res, 400, 'Validation failed', { errors });
    }
    return sendError(res, 500, 'Failed to update department');
  }
};

// ============================================================
// ARCHIVE DEPARTMENT (soft delete)
// ============================================================
const archiveDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid department ID');

    const department = await departmentRepo.findByIdLean(id);
    if (!department) return sendNotFound(res, 'Department');

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (department.schoolCampus.toString() !== req.user.campusId.toString()) {
        return sendError(res, 403, 'Can only archive departments from your campus');
      }
    }

    // Warn if teachers are still assigned (via the teacher facade).
    const teacherCount = await countTeachersInDepartment(id);
    if (teacherCount > 0) {
      return sendError(
        res, 409,
        `Cannot archive: ${teacherCount} active teacher(s) are still assigned to this department`
      );
    }

    await departmentRepo.setStatus(id, 'archived');

    return sendSuccess(res, 200, 'Department archived successfully');
  } catch (err) {
    console.error('❌ archiveDepartment:', err);
    return sendError(res, 500, 'Failed to archive department');
  }
};

// ============================================================
// GET DEPARTMENT STATS (campus-scoped)
// ============================================================
/**
 * Wraps the generic stats handler to enforce campus isolation:
 * a CAMPUS_MANAGER may only request statistics for its own campus.
 */
const getDepartmentStats = async (req, res) => {
  if (req.user.role === 'CAMPUS_MANAGER') {
    if (req.params.campusId?.toString() !== req.user.campusId?.toString()) {
      return sendError(res, 403, 'You can only view statistics for your own campus');
    }
  }
  return genericController.getStats(req, res);
};

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  createDepartment,
  getAllDepartments,
  getOneDepartment,
  updateDepartment,
  archiveDepartment,
  restoreDepartment: genericController.restore,
  getDepartmentStats,
};
