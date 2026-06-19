require('dotenv').config();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const GenericEntityController = require('../../../shared/lib/generic-entity.controller');

// Escape user input before embedding in MongoDB $regex to prevent ReDoS / injection
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const campusRepo = require('../campus.repository');
const { getLoginPrefs } = require('../../settings').service;
const teacherService = require('../../teacher').service; // facade module teacher (§3)
const studentService = require('../../student').service; // facade module student (§3)
const classService = require('../../class').service; // facade module class (§3)
// Lazy require: subject.controller will consume the campus facade in C5 (campus ↔ subject cycle)
const listCampusSubjects = (...args) =>
  require('../../subject').service.listCampusSubjects(...args);
const financeService = require('../../finance').service; // facade module finance (§3)
const departmentService = require('../../department').service; // facade module department (§3)
const staffService  = require('../../staff').service; // facade module staff (§3)
const mentorService = require('../../mentor').service; // facade module mentor (§3)

const campusConfig = require('../campus.config');
const studentConfig = require('../../student').service.entityConfig; // facade module student (§3)
const crypto = require('crypto');

const { uploadImage } = require('../../../shared/utils/file-upload');
const { getFileUrl } = require('../../../shared/middleware/upload');

const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
  sendConflict
} = require('../../../shared/utils/response-helpers');
const {
  isValidObjectId,
  isValidEmail,
  validatePasswordStrength
} = require('../../../shared/utils/validation-helpers');

// ========================================
// INITIALIZE GENERIC CONTROLLERS
// ========================================
const campusEntityController = new GenericEntityController(campusConfig);
const studentEntityController = new GenericEntityController(studentConfig);

// Constants
const JWT_SECRET = process.env.JWT_SECRET;
// bcrypt cost factor — CLAUDE.md §8 mandates 12 for password hashing.
const SALT_ROUNDS = 12;

//reusable helper Function for Location
const parseLocation = (fields) => {

  // Helper to extract values
  const getField = (bracketPath, objectPath) => {
    return fields[bracketPath] ?? objectPath(fields);
  };

  const lat = getField(
    'location[coordinates][lat]',
    (f) => f.location?.coordinates?.lat
  );
  
  const lng = getField(
    'location[coordinates][lng]',
    (f) => f.location?.coordinates?.lng
  );

  // Coordinates validation
  const validateCoordinate = (value, min, max) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max 
      ? parsed 
      : null;
  };

  return {
    address: getField('location[address]', (f) => f.location?.address) || '',
    city: getField('location[city]', (f) => f.location?.city) || '',
    country: getField('location[country]', (f) => f.location?.country) || 'Cameroon',
    coordinates: {
      lat: validateCoordinate(lat, -90, 90), 
      lng: validateCoordinate(lng, -180, 180)
    }
  };
};

/**
 * Inherits generic CRUD + adds campus-specific methods
 */
class CampusController extends GenericEntityController {
  constructor(config) {
    super(config);
  }

  /**
   * Generate a signed Cloudinary upload signature.
   * The browser uses this to upload the campus image directly to Cloudinary,
   * bypassing the backend entirely and eliminating any server-side upload hang.
   *
   * @route  GET /api/campus/upload-signature
   * @access ADMIN, DIRECTOR
   */
  getUploadSignature = (req, res) => {
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = 'backend/campuses';

    // Cloudinary signature: SHA-1( sorted_params + api_secret )
    const signature = crypto
      .createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`)
      .digest('hex');

    return sendSuccess(res, 200, 'Upload signature generated', {
      signature,
      timestamp,
      folder,
      cloudName : process.env.CLOUDINARY_CLOUD_NAME,
      apiKey    : process.env.CLOUDINARY_API_KEY,
    });
  };

  /**
   * Create a new campus.
   * The campus image has already been uploaded directly to Cloudinary by the
   * browser — this endpoint only receives the resulting secure URL.
   *
   * @route  POST /api/campus/create
   * @access ADMIN, DIRECTOR
   */
  create = async (req, res) => {
    const {
      email,
      password,
      campus_name,
      manager_name,
      campus_number,
      manager_phone,
      campus_image,     // Cloudinary secure_url sent by the browser
    } = req.body;

    // ── 1. Validate campus_image URL ──────────────────────────────────────────
    if (!campus_image || typeof campus_image !== 'string') {
      return sendError(res, 400, 'Campus image URL is required. Please upload an image first.');
    }

    try {
      if (!email || !password || !campus_name || !manager_name || !manager_phone) {
        return sendError(res, 400, 'All required fields must be provided', {
          required: ['email', 'password', 'campus_name', 'manager_name', 'manager_phone']
        });
      }

      if (!isValidEmail(email)) {
        return sendError(res, 400, 'Invalid email format');
      }

      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        return sendError(res, 400, 'Password does not meet requirements', {
          errors: passwordValidation.errors
        });
      }

      const existingCampus = await campusRepo.findByEmail(email.toLowerCase());

      if (existingCampus) {
        return sendConflict(res, 'A campus with this email is already registered');
      }

      const location = parseLocation(req.body);

      const salt = await bcrypt.genSalt(SALT_ROUNDS);
      const hashedPassword = await bcrypt.hash(password, salt);

      const campusData = {
        campus_name:   campus_name.trim(),
        campus_number: campus_number?.trim(),
        email:         email.toLowerCase().trim(),
        manager_name:  manager_name.trim(),
        manager_phone: manager_phone?.trim(),
        location,
        password:      hashedPassword,
        campus_image,
      };

      const savedCampus = await campusRepo.create(campusData);

      if (this.afterCreate) {
        await this.afterCreate(savedCampus);
      }

      const response = savedCampus.toObject();
      delete response.password;

      const { sendCreated } = require('../../../shared/utils/response-helpers');
      return sendCreated(res, 'Campus registered successfully', response);

    } catch (error) {
      console.error('❌ Campus creation error:', error);

      const { handleDuplicateKeyError } = require('../../../shared/utils/response-helpers');
      if (error.code === 11000) return handleDuplicateKeyError(res, error);

      if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(err => err.message);
        return sendError(res, 400, 'Validation failed', { errors: messages });
      }

      return sendError(res, 500, 'Failed to register campus. Please try again');
    }
  };

  /**
   * Campus Login
   * @route   POST /api/campus/login
   * @access  Public
   */
  login = async (req, res) => {
    try {
      if (!req.body || !req.body.email || !req.body.password) {
        return sendError(res, 400, 'Email and password are required');
      }

      const { email, password } = req.body;

      if (!JWT_SECRET) {
        console.error('❌ JWT_SECRET is not defined');
        return sendError(res, 500, 'Server configuration error');
      }

      if (!isValidEmail(email)) {
        return sendError(res, 400, 'Invalid email format');
      }

      // Find campus with password
      const campus = await campusRepo.findByEmailWithPassword(email.toLowerCase().trim());

      if (!campus) {
        return sendError(res, 401, 'Invalid email or password');
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, campus.password);

      if (!isPasswordValid) {
        return sendError(res, 401, 'Invalid email or password');
      }

      // Check status
      if (campus.status !== 'active') {
        return sendError(res, 403, 'This campus account is inactive. Please contact support.');
      }

      // Generate token
      const token = jwt.sign(
        {
          id: campus._id,
          campusId: campus._id,
          manager_name: campus.manager_name,
          campus_name: campus.campus_name,
          image_url: campus.campus_image || campus.profileImage,
          role: 'CAMPUS_MANAGER'
        },
        JWT_SECRET,
        {
          expiresIn: '7d',
          issuer: 'school-management-app'
        }
      );

      // Update last login
      campusRepo.touchLastLogin(campus._id)
        .catch(err => console.error('Failed to update lastLogin:', err));

      const prefs = await getLoginPrefs(campus._id, 'CAMPUS_MANAGER', campus._id);

      return sendSuccess(res, 200, 'Login successful', {
        token,
        user: {
          id: campus._id,
          campusId: campus._id,
          manager_name: campus.manager_name,
          campus_name: campus.campus_name,
          email: campus.email,
          image_url: campus.campus_image || campus.profileImage,
          role: 'CAMPUS_MANAGER',
          ...prefs,
        }
      });

    } catch (error) {
      console.error('❌ Campus login error:', error);
      return sendError(res, 500, 'Internal server error during login');
    }
  };

/**
 * Get existing campuses
 * @route   GET /api/campus/all
 * @access  Public
 */

  getAll = async (req, res) => {
    try {
      const {
        page,
        limit,
        search = '',
        status,
        city
      } = req.query;

      // Sanitise & clamp pagination — this endpoint is reachable publicly
      // (optionalAuth), so an unbounded limit would let anyone dump the whole
      // collection in a single request.
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const safePage  = Math.max(Number(page) || 1, 1);
      const skip      = (safePage - 1) * safeLimit;

      // Only authenticated ADMIN / DIRECTOR receive the full record (manager
      // email/phone, commission config, quotas…). Everyone else (public portal,
      // other roles) gets a PII-free public projection.
      const isPrivileged = req.user && ['ADMIN', 'DIRECTOR'].includes(req.user.role);

      const { data: campuses, total } = await campusRepo.paginate({
        status,
        city,
        search,
        skip,
        limit: safeLimit,
        publicView: !isPrivileged,
      });

      return sendPaginated(
        res,
        200,
        'All campuses fetched successfully',
        campuses,
        { total, page: safePage, limit: safeLimit }
      );

    } catch (error) {
      console.error('❌ Error fetching campuses:', error);
      return sendError(res, 500, 'Internal server error while fetching campuses');
    }
  };

  /**
   * Get One single campus
   * @route   GET /api/campus/:id
   * @access  Private
   */

  getOne = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid campus ID format');
    }

    const campus = await campusRepo.findByIdSafe(id);

    if (!campus) {
      return sendNotFound(res, 'Campus');
    }

    // Authorization : CAMPUS_MANAGER cqn only see is Owne campus! 
    if (req.user.role === 'CAMPUS_MANAGER' && 
        req.user.campusId.toString() !== id.toString()) {
      return sendError(res, 403, 'You can only access your own campus');
    }

    return sendSuccess(res, 200, 'Campus retrieved successfully', campus);

  } catch (error) {
    console.error('❌ Error fetching campus:', error);
    return sendError(res, 500, 'Failed to retrieve campus');
  }
};

  /**
   * Update Campus Password
   * @route   PATCH /api/campus/:id/password
   * @access  Private
   */

  updatePassword = async (req, res) => {
    try {
      const { id } = req.params;
      const { currentPassword, newPassword } = req.body;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (!newPassword) {
        return sendError(res, 400, 'New password is required');
      }

      // Validate password strength
      const passwordValidation = validatePasswordStrength(newPassword);
      if (!passwordValidation.valid) {
        return sendError(res, 400, 'Password does not meet requirements', {
          errors: passwordValidation.errors
        });
      }

      // Authorization
      const isOwner = String(req.user.campusId) === String(id);
      const isAdmin = ['ADMIN', 'DIRECTOR'].includes(req.user.role);

      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'You are not authorized to change this password');
      }

      // Find campus
      const campus = await campusRepo.findByIdWithPassword(id);
      if (!campus) {
        return sendNotFound(res, 'Campus');
      }

      // Verify current password (skip for ADMIN)
      if (!isAdmin) {
        if (!currentPassword) {
          return sendError(res, 400, 'Current password is required');
        }

        const isMatch = await bcrypt.compare(currentPassword, campus.password);
        if (!isMatch) {
          return sendError(res, 401, 'Current password is incorrect');
        }
      }

      // Hash new password
      const salt = await bcrypt.genSalt(SALT_ROUNDS);
      const hashed = await bcrypt.hash(newPassword, salt);

      await campusRepo.updatePassword(id, hashed);

      return sendSuccess(res, 200, 'Password updated successfully');

    } catch (error) {
      console.error('❌ Password update error:', error);
      return sendError(res, 500, 'Failed to update password');
    }
  };

  /**
   * Get Campus Context with Statistics
   * @route   GET /api/campus/:campusId/context
   * @access  Private
   */

  getContext = async (req, res) => {
    try {
      const { campusId } = req.params;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      // Authorization
      if (req.user.role === 'CAMPUS_MANAGER' && (req.user.campusId).toString() !== (campusId).toString()) {
        return sendError(res, 403, 'You can only access your own campus context');
      }

      // Parallel queries
      const [campus, studentsCount, teachersCount, classesCount] = await Promise.all([
        campusRepo.findByIdSafe(campusId),
        studentService.countStudents({ campusId, excludeArchived: true }),
        teacherService.countActiveTeachers(campusId),
        classService.countClasses({ campusId, excludeArchived: true })
      ]);

      if (!campus) {
        return sendNotFound(res, 'Campus');
      }

      return sendSuccess(res, 200, 'Campus context fetched successfully', {
        campus,
        stats: {
          students: studentsCount,
          teachers: teachersCount,
          classes: classesCount
        }
      });
    } catch (error) {
      console.error('❌ getCampusContext error:', error);
      return sendError(res, 500, 'Failed to fetch campus context');
    }
  };

  /**
   * Get Campus Dashboard Statistics
   * @route   GET /api/campus/:campusId/dashboard
   * @access  Private
   */
  getDashboardStats = async (req, res) => {
    try {
      const { campusId } = req.params;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      // Authorization
      if (req.user.role === 'CAMPUS_MANAGER' && (req.user.campusId).toString() !== campusId.toString()) {
        return sendError(res, 403, 'You can only access your own campus dashboard');
      }

      const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

      const campusOid = new mongoose.Types.ObjectId(campusId);

      const [
        studentsTotal,
        teachersTotal,
        classesTotal,
        activeClasses,
        recentStudents,
        recentTeachers,
        attendanceStats,
        paymentAlerts,
        staffStats,
        mentorStats,
      ] = await Promise.all([
        studentService.countStudents({ campusId, excludeArchived: true }),
        teacherService.countActiveTeachers(campusId),
        classService.countClasses({ campusId, excludeArchived: true }),
        classService.countClasses({ campusId, status: 'active' }),
        studentService.countStudents({ campusId, excludeArchived: true, createdSince: firstDayOfMonth }),
        teacherService.countActiveTeachers(campusId, { createdSince: firstDayOfMonth }),
        // Campus-wide average absence rate from attendance records
        studentService.getAvgAbsenceRateForCampus(campusOid),
        // Pending income records as payment alerts
        financeService.countPendingIncomes(campusId),
        staffService.getCampusStats(campusId),
        mentorService.getCampusStats(campusId, campusOid),
      ]);

      const avgAbsenceRate      = attendanceStats[0]?.avgAbsenceRate ?? 0;

      return sendSuccess(res, 200, 'Dashboard statistics fetched successfully', {
        students: {
          total: studentsTotal,
          newThisMonth: recentStudents
        },
        teachers: {
          total: teachersTotal,
          newThisMonth: recentTeachers
        },
        classes: {
          total: classesTotal,
          active: activeClasses
        },
        staff: {
          total:       staffStats.total,
          active:      staffStats.active,
          withRole:    staffStats.withRole,
          withoutRole: staffStats.total - staffStats.withRole,
        },
        mentors: {
          total:            mentorStats.total,
          active:           mentorStats.active,
          studentsAssigned: mentorStats.studentsAssigned,
        },
        avgAbsenceRate: Math.round(avgAbsenceRate * 10) / 10,
        paymentAlerts,
      });

    } catch (error) {
      console.error('❌ Dashboard stats error:', error);
      return sendError(res, 500, 'Failed to load dashboard statistics');
    }
  };

  /**
   * Get Campus Students (with filters)
   * @route   GET /api/campus/:campusId/students
   * @access  Private
   */
  getStudents = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { page = 1, limit = 20, search = '', classId, status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      // Authorization
      if (req.user.role === 'CAMPUS_MANAGER' && String(req.user.campusId) !== String(campusId)) {
        return sendError(res, 403, 'You can only access students from your own campus');
      }

      const { docs: students, total } = await studentService.listStudentsForCampusDashboard({
        campusId,
        classId,
        status,
        search: search ? escapeRegex(search) : undefined,
        page,
        limit,
      });

      return sendPaginated(
        res,
        200,
        'Students fetched successfully',
        students,
        { total, page, limit }
      );

    } catch (error) {
      console.error('❌ getStudents error:', error);
      return sendError(res, 500, 'Failed to fetch students');
    }
  };

  /**
   * Get Campus Teachers
   * @route   GET /api/campus/:campusId/teachers
   * @access  Private
   */
  getTeachers = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { page = 1, limit = 20, search = '', status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      // Authorization
      if (req.user.role === 'CAMPUS_MANAGER' && String(req.user.campusId) !== String(campusId)) {
        return sendError(res, 403, 'You can only access teachers from your own campus');
      }

      const { docs: teachers, total } = await teacherService.listTeachersForCampusDashboard({
        campusId,
        status,
        search: search ? escapeRegex(search) : undefined,
        page,
        limit,
      });

      return sendPaginated(
        res,
        200,
        'Teachers fetched successfully',
        teachers,
        { total, page, limit }
      );

    } catch (error) {
      console.error('❌ getTeachers error:', error);
      return sendError(res, 500, 'Failed to fetch teachers');
    }
  };

  /**
   * Get Campus Parents
   * @route   GET /api/campus/:campusId/parents
   * @access  Private (ADMIN, DIRECTOR, CAMPUS_MANAGER)
   */
  getParents = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { page = 1, limit = 20, search = '', status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access parents from your own campus');
      }

      const Parent = mongoose.model('Parent');

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;
      else filter.status = { $ne: 'archived' };

      if (search) {
        filter.$or = [
          { firstName: { $regex: escapeRegex(search), $options: 'i' } },
          { lastName:  { $regex: escapeRegex(search), $options: 'i' } },
          { email:     { $regex: escapeRegex(search), $options: 'i' } },
          { phone:     { $regex: escapeRegex(search), $options: 'i' } },
          { matricule: { $regex: escapeRegex(search), $options: 'i' } },
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const [parents, total] = await Promise.all([
        Parent.find(filter)
          .populate('children', 'firstName lastName matricule')
          .select('-password')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        Parent.countDocuments(filter),
      ]);

      return sendPaginated(res, 200, 'Parents fetched successfully', parents, {
        total, page, limit,
      });
    } catch (error) {
      console.error('❌ getParents error:', error);
      return sendError(res, 500, 'Failed to fetch parents');
    }
  };

/**
   * Get Campus Mentors
   * @route   GET /api/campus/:campusId/mentors
   * @access  Private (ADMIN, DIRECTOR, CAMPUS_MANAGER)
   */
  getMentors = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { page = 1, limit = 20, search = '', status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access mentors from your own campus');
      }

      const { mentors, total } = await mentorService.listByCampus({
        campusId, page, limit, search, status, escapeRegex,
      });

      return sendPaginated(res, 200, 'Mentors fetched successfully', mentors, {
        total, page, limit,
      });
    } catch (error) {
      console.error('❌ getMentors error:', error);
      return sendError(res, 500, 'Failed to fetch mentors');
    }
  };

  /**
 * Get Campus Classes
 * @route  GET /api/campus/:campusId/classes
 * @access Private
 */
  getClasses = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access classes from your own campus');
      }

      const classes = await classService.listClassesForCampus({ campusId, status });

      return sendSuccess(res, 200, 'Classes fetched successfully', classes);

    } catch (error) {
      console.error('❌ getClasses error:', error);
      return sendError(res, 500, 'Failed to fetch classes');
    }
  };

  /**
   * Get Campus Subjects
   * @route  GET /api/campus/:campusId/subjects
   * @access Private
   */
  getSubjects = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { status } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access subjects from your own campus');
      }

      const subjects = await listCampusSubjects({ campusId, status });

      return sendSuccess(res, 200, 'Subjects fetched successfully', subjects);

    } catch (error) {
      console.error('❌ getSubjects error:', error);
      return sendError(res, 500, 'Failed to fetch subjects');
    }
  };

  /**
   * Get Campus Departments
   * @route   GET /api/campus/:campusId/departments
   * @access  Private (ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER)
   * @query   includeArchived — 'true' to include archived departments
   */
  getDepartments = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { search = '', status, includeArchived } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      // Authorization — every campus-scoped role (CAMPUS_MANAGER, TEACHER) may
      // only read departments of its own campus. ADMIN / DIRECTOR are global.
      if (
        ['CAMPUS_MANAGER', 'TEACHER'].includes(req.user.role) &&
        String(req.user.campusId) !== String(campusId)
      ) {
        return sendError(res, 403, 'You can only access departments from your own campus');
      }

      const departments = await departmentService.listDepartmentsForCampus({
        campusId,
        status,
        includeArchived: includeArchived === 'true',
        search,
      });

      return sendSuccess(res, 200, 'Departments fetched successfully', departments);
    } catch (error) {
      console.error('❌ getDepartments error:', error);
      return sendError(res, 500, 'Failed to fetch departments');
    }
  };
}

// ========================================
// INSTANTIATE CONTROLLERS
// ========================================
const campusController = new CampusController(campusConfig);

// ── PATCH /api/campus/:id/defaults ────────────────────────────────────────────
const { SUPPORTED_LANGUAGES: SUPPORTED_LANGUAGES_DEF } = require('../../../shared/i18n/languages');
const SUPPORTED_TIMEZONES_DEF  = require('../../settings').service.SUPPORTED_TIMEZONES; // facade settings (§3)
const SUPPORTED_GRADE_FMTS_DEF = ['FRACTION', 'PERCENT', 'LETTER', 'GPA'];

const updateCampusDefaults = async (req, res) => {
  try {
    const { id } = req.params;
    const { defaultLanguage, defaultTimezone, defaultGradeFormat } = req.body ?? {};

    // Campus managers can only update their own campus
    if (req.user.role === 'CAMPUS_MANAGER') {
      const ownId = req.user.campusId?.toString();
      if (!ownId || ownId !== id) {
        return sendError(res, 403, 'You can only update defaults for your own campus.');
      }
    }

    if (defaultLanguage  && !SUPPORTED_LANGUAGES_DEF.includes(defaultLanguage)) {
      return sendError(res, 400, `Unsupported language: ${defaultLanguage}`);
    }
    if (defaultTimezone  && !SUPPORTED_TIMEZONES_DEF.includes(defaultTimezone)) {
      return sendError(res, 400, `Unsupported timezone: ${defaultTimezone}`);
    }
    if (defaultGradeFormat && !SUPPORTED_GRADE_FMTS_DEF.includes(defaultGradeFormat)) {
      return sendError(res, 400, `Unsupported gradeFormat: ${defaultGradeFormat}`);
    }

    const update = {};
    if (defaultLanguage   !== undefined) update.defaultLanguage   = defaultLanguage;
    if (defaultTimezone   !== undefined) update.defaultTimezone   = defaultTimezone;
    if (defaultGradeFormat !== undefined) update.defaultGradeFormat = defaultGradeFormat;

    if (!Object.keys(update).length) {
      return sendError(res, 400, 'No valid fields to update.');
    }

    const campus = await campusRepo.updateDefaults(id, update);

    if (!campus) return sendNotFound(res, 'Campus');

    return sendSuccess(res, 200, 'Campus defaults updated.', {
      defaultLanguage:   campus.defaultLanguage,
      defaultTimezone:   campus.defaultTimezone,
      defaultGradeFormat: campus.defaultGradeFormat,
    });
  } catch (err) {
    console.error('❌ updateCampusDefaults error:', err);
    return sendError(res, 500, 'Failed to update campus defaults.');
  }
};

// ── GET /api/campus/:campusId/students/stats ──────────────────────────────────
// Ownership-guarded wrapper around the generic student stats handler. Without
// it a CAMPUS_MANAGER could read another campus's student statistics by passing
// an arbitrary :campusId (campus-isolation boundary — CLAUDE.md §2).
const getCampusStudentsStats = async (req, res) => {
  const { campusId } = req.params;

  if (!isValidObjectId(campusId)) {
    return sendError(res, 400, 'Invalid campus ID format');
  }

  if (
    req.user.role === 'CAMPUS_MANAGER' &&
    String(req.user.campusId) !== String(campusId)
  ) {
    return sendError(res, 403, 'You can only access statistics from your own campus');
  }

  return studentEntityController.getStats(req, res);
};

// ========================================
// EXPORT CONTROLLER METHODS
// ========================================
module.exports = {
  // Generic CRUD operations (inherited)
  getAllCampus: campusController.getAll,
  updateCampus: campusController.update,
  deleteCampus:   campusController.archive,
  restoreCampus:  campusController.restore,

  // Campus-specific operations
  getUploadSignature: campusController.getUploadSignature,
  createCampus: campusController.create,
  getOneCampus: campusController.getOne,
  loginCampus: campusController.login,
  updateCampusPassword: campusController.updatePassword,
  getCampusContext: campusController.getContext,
  getCampusDashboardStats: campusController.getDashboardStats,
  getCampusStudents: campusController.getStudents,
  getCampusTeachers: campusController.getTeachers,
  getCampusParents: campusController.getParents,
  getCampusMentors: campusController.getMentors,
  getCampusDepartments: campusController.getDepartments,
  getCampusClasses: campusController.getClasses,
  getCampusSubjects: campusController.getSubjects,
  updateCampusDefaults,

  // Statistics (ownership-guarded wrapper around the student controller)
  getCampusStudentsStats
};