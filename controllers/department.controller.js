const mongoose = require('mongoose');
const Department = require('../models/department.model');
const departmentConfig = require('../configs/department.config');
const GenericEntityController = require('./generic-entity.controller');

const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  sendConflict,
  sendPaginated,
} = require('../utils/response-helpers');
const { isValidObjectId, buildCampusFilter, escapeRegex } = require('../utils/validation-helpers');

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
      Department.findOne({ schoolCampus: campusId, name: name.trim() }).lean(),
      Department.findOne({ schoolCampus: campusId, code: code.toUpperCase().trim() }).lean(),
    ]);

    if (nameExists) return sendConflict(res, `Department "${name}" already exists in this campus`);
    if (codeExists) return sendConflict(res, `Code "${code.toUpperCase()}" is already used in this campus`);

    if (headOfDepartment && !isValidObjectId(headOfDepartment)) {
      return sendError(res, 400, 'Invalid head of department ID');
    }

    const department = new Department({
      name: name.trim(),
      code: code.toUpperCase().trim(),
      description: description?.trim(),
      headOfDepartment: headOfDepartment || null,
      schoolCampus: campusId,
      status: 'active',
    });

    const saved = await department.save();

    const populated = await Department.findById(saved._id)
      .populate('schoolCampus', 'campus_name')
      .populate('headOfDepartment', 'firstName lastName email')
      .lean();

    return sendCreated(res, 'Department created successfully', populated);
  } catch (err) {
    console.error('❌ createDepartment:', err);
    if (err.code === 11000) return sendConflict(res, 'Department name or code already exists');
    return sendError(res, 500, 'Failed to create department');
  }
};

// ============================================================
// GET ALL DEPARTMENTS
// ============================================================
const getAllDepartments = async (req, res) => {
  try {
    const { search, status, includeArchived, page = 1, limit = 100 } = req.query;

    const filter = buildCampusFilter(req.user, req.query.campusId);

    if (includeArchived !== 'true') {
      filter.status = { $ne: 'archived' };
    }
    if (status) filter.status = status;

    if (search) {
      filter.$or = [
        { name:        { $regex: escapeRegex(search), $options: 'i' } },
        { code:        { $regex: escapeRegex(search), $options: 'i' } },
        { description: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [departments, total] = await Promise.all([
      Department.find(filter)
        .populate('schoolCampus', 'campus_name')
        .populate('headOfDepartment', 'firstName lastName email')
        .sort({ name: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Department.countDocuments(filter),
    ]);

    return sendPaginated(res, 200, 'Departments retrieved successfully', departments, {
      total, page, limit,
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

    const department = await Department.findById(id)
      .populate('schoolCampus', 'campus_name location')
      .populate('headOfDepartment', 'firstName lastName email matricule')
      .lean();

    if (!department) return sendNotFound(res, 'Department');

    // Campus isolation for CAMPUS_MANAGER
    if (req.user.role === 'CAMPUS_MANAGER') {
      if (department.schoolCampus._id.toString() !== req.user.campusId.toString()) {
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

    const department = await Department.findById(id);
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
      const exists = await Department.findOne({
        schoolCampus: department.schoolCampus,
        name: name.trim(),
        _id: { $ne: id },
      }).lean();
      if (exists) return sendConflict(res, `Department "${name}" already exists`);
      updates.name = name.trim();
    }

    // Code uniqueness
    if (code && code.toUpperCase().trim() !== department.code) {
      const exists = await Department.findOne({
        schoolCampus: department.schoolCampus,
        code: code.toUpperCase().trim(),
        _id: { $ne: id },
      }).lean();
      if (exists) return sendConflict(res, `Code "${code.toUpperCase()}" is already used`);
      updates.code = code.toUpperCase().trim();
    }

    if (description !== undefined) updates.description = description?.trim();
    if (headOfDepartment !== undefined) {
      if (headOfDepartment && !isValidObjectId(headOfDepartment)) {
        return sendError(res, 400, 'Invalid head of department ID');
      }
      updates.headOfDepartment = headOfDepartment || null;
    }
    if (status) updates.status = status;

    const updated = await Department.findByIdAndUpdate(id, updates, {
      new: true, runValidators: true,
    })
      .populate('schoolCampus', 'campus_name')
      .populate('headOfDepartment', 'firstName lastName email')
      .lean();

    return sendSuccess(res, 200, 'Department updated successfully', updated);
  } catch (err) {
    console.error('❌ updateDepartment:', err);
    if (err.code === 11000) return sendConflict(res, 'Department name or code already exists');
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

    const department = await Department.findById(id);
    if (!department) return sendNotFound(res, 'Department');

    if (req.user.role === 'CAMPUS_MANAGER') {
      if (department.schoolCampus.toString() !== req.user.campusId.toString()) {
        return sendError(res, 403, 'Can only archive departments from your campus');
      }
    }

    // Warn if teachers are still assigned
    const Teacher = mongoose.model('Teacher');
    const teacherCount = await Teacher.countDocuments({ department: id, status: { $ne: 'archived' } });
    if (teacherCount > 0) {
      return sendError(
        res, 409,
        `Cannot archive: ${teacherCount} active teacher(s) are still assigned to this department`
      );
    }

    department.status = 'archived';
    await department.save();

    return sendSuccess(res, 200, 'Department archived successfully');
  } catch (err) {
    console.error('❌ archiveDepartment:', err);
    return sendError(res, 500, 'Failed to archive department');
  }
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
  // Stats delegated to generic controller
  getDepartmentStats: genericController.getStats,
};