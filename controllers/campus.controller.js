require('dotenv').config();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const GenericEntityController = require('./genericEntity.controller');

const Campus = require('../models/campus.model');
const Teacher = require('../models/teacher-models/teacher.model');
const Student = require('../models/student-models/student.model');
const Class = require('../models/class.model');
const Subject = require('../models/subject.model');
const Department = require('../models/department.model');
const StudentAttendance = require('../models/student-models/studentAttend.model');
const Income = require('../models/income.model');

const campusConfig = require('../configs/campus.config');
const studentConfig = require('../configs/student.config');
const crypto = require('crypto');

const { uploadImage } = require('../utils/fileUpload');
const { getFileUrl } = require('../middleware/upload/upload');

const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendNotFound,
  sendConflict
} = require('../utils/responseHelpers');
const {
  isValidObjectId,
  isValidEmail,
  validatePasswordStrength
} = require('../utils/validationHelpers');

// ========================================
// INITIALIZE GENERIC CONTROLLERS
// ========================================
const campusEntityController = new GenericEntityController(campusConfig);
const studentEntityController = new GenericEntityController(studentConfig);

// Constants
const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;

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

      const existingCampus = await Campus.findOne({ email: email.toLowerCase() });

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

      const campus = new Campus(campusData);
      const savedCampus = await campus.save();

      if (this.afterCreate) {
        await this.afterCreate(savedCampus);
      }

      const response = savedCampus.toObject();
      delete response.password;

      const { sendCreated } = require('../utils/responseHelpers');
      return sendCreated(res, 'Campus registered successfully', response);

    } catch (error) {
      console.error('❌ Campus creation error:', error);

      const { handleDuplicateKeyError } = require('../utils/responseHelpers');
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
      const campus = await Campus.findOne({
        email: email.toLowerCase().trim()
      }).select('+password');

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
      Campus.updateOne(
        { _id: campus._id },
        { $set: { lastLogin: new Date() } }
      ).catch(err => console.error('Failed to update lastLogin:', err));; 

      return sendSuccess(res, 200, 'Login successful', {
        token,
        user: {
          id: campus._id,
          campusId: campus._id,
          manager_name: campus.manager_name,
          campus_name: campus.campus_name,
          email: campus.email,
          image_url: campus.campus_image || campus.profileImage,
          role: 'CAMPUS_MANAGER'
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
        page = 1,
        limit = 50,
        search = '',
        status,
        city
      } = req.query;

      // Build filter
      const filter = {};

      if (status) {
        filter.status = status;
      }

      if (city) {
        filter['location.city'] = { $regex: city, $options: 'i' };
      }

      if (search) {
        filter.$or = [
          { campus_name: { $regex: search, $options: 'i' } },
          { manager_name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { campus_number: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const campuses = await Campus.find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean();

      const total = await Campus.countDocuments(filter);

      return sendPaginated(
        res,
        200,
        'All campuses fetched successfully',
        campuses,
        { total, page, limit }
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

    const campus = await Campus.findById(id).select('-password').lean();

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
      const isOwner = req.user.campusId === id;
      const isAdmin = ['ADMIN', 'DIRECTOR'].includes(req.user.role);

      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'You are not authorized to change this password');
      }

      // Find campus
      const campus = await Campus.findById(id).select('+password');
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
      campus.password = await bcrypt.hash(newPassword, salt);

      await campus.save();

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
        Campus.findById(campusId).select('-password').lean(),
        Student.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
        Teacher.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
        Class.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } })
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
      ] = await Promise.all([
        Student.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
        Teacher.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
        Class.countDocuments({ schoolCampus: campusId, status: { $ne: 'archived' } }),
        Class.countDocuments({ schoolCampus: campusId, status: 'active' }),
        Student.countDocuments({
          schoolCampus: campusId,
          createdAt: { $gte: firstDayOfMonth },
          status: { $ne: 'archived' }
        }),
        Teacher.countDocuments({
          schoolCampus: campusId,
          createdAt: { $gte: firstDayOfMonth },
          status: { $ne: 'archived' }
        }),
        // Campus-wide average absence rate from attendance records
        StudentAttendance.aggregate([
          { $match: { schoolCampus: campusOid } },
          {
            $group: {
              _id:           '$student',
              totalSessions: { $sum: 1 },
              absentCount:   { $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] } },
            },
          },
          {
            $group: {
              _id:            null,
              avgAbsenceRate: {
                $avg: {
                  $multiply: [{ $divide: ['$absentCount', '$totalSessions'] }, 100],
                },
              },
            },
          },
        ]),
        // Pending income records as payment alerts
        Income.countDocuments({ campus: campusId, status: 'pending' }),
      ]);

      const avgAbsenceRate = attendanceStats[0]?.avgAbsenceRate ?? 0;

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
      if (req.user.role === 'CAMPUS_MANAGER' && req.user.campusId !== campusId) {
        return sendError(res, 403, 'You can only access students from your own campus');
      }

      const filter = { schoolCampus: campusId };

      if (classId) filter.studentClass = classId;
      if (status) filter.status = status;

      if (search) {
        filter.$or = [
          { firstName: { $regex: search, $options: 'i' } },
          { lastName: { $regex: search, $options: 'i' } },
          { matricule: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const students = await Student.find(filter)
        .populate('studentClass', 'className')
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean();

      const total = await Student.countDocuments(filter);

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
      if (req.user.role === 'CAMPUS_MANAGER' && req.user.campusId !== campusId) {
        return sendError(res, 403, 'You can only access teachers from your own campus');
      }

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;

      if (search) {
        filter.$or = [
          { firstName: { $regex: search, $options: 'i' } },
          { lastName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const teachers = await Teacher.find(filter)
        .select('-password -salary')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean();

      const total = await Teacher.countDocuments(filter);

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
          { firstName: { $regex: search, $options: 'i' } },
          { lastName:  { $regex: search, $options: 'i' } },
          { email:     { $regex: search, $options: 'i' } },
          { phone:     { $regex: search, $options: 'i' } },
          { matricule: { $regex: search, $options: 'i' } },
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

      const Mentor = mongoose.model('Mentor');

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;
      else filter.status = { $ne: 'archived' };

      if (search) {
        filter.$or = [
          { firstName:      { $regex: search, $options: 'i' } },
          { lastName:       { $regex: search, $options: 'i' } },
          { email:          { $regex: search, $options: 'i' } },
          { phone:          { $regex: search, $options: 'i' } },
          { specialization: { $regex: search, $options: 'i' } },
          { matricule:      { $regex: search, $options: 'i' } },
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const [mentors, total] = await Promise.all([
        Mentor.find(filter)
          .populate('assignedStudents', 'firstName lastName matricule')
          .select('-password')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        Mentor.countDocuments(filter),
      ]);

      return sendPaginated(res, 200, 'Mentors fetched successfully', mentors, {
        total, page, limit,
      });
    } catch (error) {
      console.error('❌ getMentors error:', error);
      return sendError(res, 500, 'Failed to fetch mentors');
    }
  };

  /**
   * Get Campus Partners
   * @route   GET /api/campus/:campusId/partners
   * @access  Private (ADMIN, DIRECTOR, CAMPUS_MANAGER)
   * @query   type — optional filter on partner type (e.g. 'company', 'ngo'…)
   */
  getPartners = async (req, res) => {
    try {
      const { campusId } = req.params;
      const { page = 1, limit = 20, search = '', status, type } = req.query;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID format');
      }

      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access partners from your own campus');
      }

      const Partner = mongoose.model('Partner');

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;
      else filter.status = { $ne: 'archived' };
      if (type) filter.type = type;

      if (search) {
        filter.$or = [
          { name:         { $regex: search, $options: 'i' } },
          { email:        { $regex: search, $options: 'i' } },
          { phone:        { $regex: search, $options: 'i' } },
          { organization: { $regex: search, $options: 'i' } },
        ];
      }

      const skip = (Number(page) - 1) * Number(limit);

      const [partners, total] = await Promise.all([
        Partner.find(filter)
          .select('-password')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        Partner.countDocuments(filter),
      ]);

      return sendPaginated(res, 200, 'Partners fetched successfully', partners, {
        total, page, limit,
      });
    } catch (error) {
      console.error('❌ getPartners error:', error);
      return sendError(res, 500, 'Failed to fetch partners');
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

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;

      const classes = await Class.find(filter)
        .populate('level',        'name')
        .populate('classManager', 'firstName lastName email profileImage')
        .sort({ className: 1 })
        .lean();

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

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;

      const subjects = await Subject.find(filter)
        .populate('department', 'name') 
        .populate('teachers',   'firstName lastName')
        .sort({ name: 1 })
        .lean();

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

      // Authorization
      if (
        req.user.role === 'CAMPUS_MANAGER' &&
        req.user.campusId.toString() !== campusId.toString()
      ) {
        return sendError(res, 403, 'You can only access departments from your own campus');
      }

      const filter = { schoolCampus: campusId };
      if (status) filter.status = status;
      else if (includeArchived !== 'true') filter.status = { $ne: 'archived' };

      if (search) {
        filter.$or = [
          { name:        { $regex: search, $options: 'i' } },
          { code:        { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
        ];
      }

      const departments = await Department.find(filter)
        .populate('headOfDepartment', 'firstName lastName email')
        .sort({ name: 1 })
        .lean();

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

// ========================================
// EXPORT CONTROLLER METHODS
// ========================================
module.exports = {
  // Generic CRUD operations (inherited)
  getAllCampus: campusController.getAll,
  updateCampus: campusController.update,
  deleteCampus: campusController.archive,

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
  getCampusPartners: campusController.getPartners,
  getCampusMentors: campusController.getMentors,
  getCampusDepartments: campusController.getDepartments,
  getCampusClasses: campusController.getClasses,
  getCampusSubjects: campusController.getSubjects,

  // Statistics (using student controller)
  getCampusStudentsStats: studentEntityController.getStats
};