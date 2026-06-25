'use strict';

/**
 * @file mentor.controller.js
 * @description Login + CAMPUS_MANAGER-facing CRUD for Mentor accounts.
 *
 *  POST   /api/mentors/login              → loginMentor          (public)
 *  POST   /api/mentors                    → createMentor         (CM)
 *  GET    /api/mentors                    → getAllMentors         (CM)
 *  GET    /api/mentors/:id                → getOneMentor         (CM | MENTOR own)
 *  PUT    /api/mentors/:id                → updateMentor         (CM)
 *  PATCH  /api/mentors/:id/status         → updateMentorStatus   (CM)
 *  PATCH  /api/mentors/:id/reset-password → resetMentorPassword  (CM)
 *  PATCH  /api/mentors/:id/restore        → restoreMentor        (CM)
 *  DELETE /api/mentors/:id                → archiveMentor        (CM)
 *  DELETE /api/mentors/:id/permanent      → deleteMentor         (ADMIN)
 *
 * Campus isolation: CAMPUS_MANAGER is always scoped to req.user.campusId.
 */

const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const mentorRepo = require('../mentor.repository');
const studentService = require('../../student').service; // student module facade (§3)
const profileSvc = require('../../../shared/services/profile.service');
const {
  sendSuccess,
  sendError,
  sendNotFound,
  sendPaginated,
} = require('../../../shared/utils/response-helpers');
const {
  isValidEmail,
  isValidObjectId,
  buildCampusFilter,
  escapeRegex,
} = require('../../../shared/utils/validation-helpers');
const { getLoginPrefs } = require('../../settings').service;

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;
const MGMT_ROLES  = ['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const buildTokenPayload = (mentor) => ({
  id:       mentor._id,
  campusId: mentor.schoolCampus?._id
              ? mentor.schoolCampus._id.toString()
              : mentor.schoolCampus.toString(),
  role:     'MENTOR',
  name:     `${mentor.firstName} ${mentor.lastName}`,
});

const buildUserResponse = (mentor) => ({
  id:               mentor._id,
  campusId:         mentor.schoolCampus,
  firstName:        mentor.firstName,
  lastName:         mentor.lastName,
  fullName:         mentor.fullName,
  email:            mentor.email,
  username:         mentor.username,
  phone:            mentor.phone,
  profileImage:     mentor.profileImage  ?? null,
  specialization:   mentor.specialization ?? null,
  notificationPrefs: mentor.notificationPrefs,
  status:           mentor.status,
  lastLogin:        mentor.lastLogin     ?? null,
  role:             'MENTOR',
});

const getCampusFilter = (req) => {
  try { return buildCampusFilter(req.user); }
  catch (err) { err.statusCode = 403; throw err; }
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/mentors/login
 * @access Public
 */
const loginMentor = async (req, res) => {
  try {
    const { email, username, password, campusId } = req.body;

    if ((!email && !username) || !password) {
      return sendError(res, 400, 'Email (or username) and password are required.');
    }
    if (!JWT_SECRET) {
      console.error('❌ JWT_SECRET is not defined');
      return sendError(res, 500, 'Server configuration error.');
    }

    const query = email
      ? { email: email.toLowerCase().trim() }
      : { username: username.toLowerCase().trim() };

    if (email && !isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format.');
    }

    const mentor = await mentorRepo.findByCredential(query);

    if (!mentor) return sendError(res, 401, 'Invalid credentials.');

    const isValid = await bcrypt.compare(password, mentor.password);
    if (!isValid) return sendError(res, 401, 'Invalid credentials.');

    if (campusId && mentor.schoolCampus.toString() !== campusId.toString()) {
      return sendError(res, 403, 'You are not registered on this campus.');
    }

    if (mentor.status !== 'active') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    const token = jwt.sign(buildTokenPayload(mentor), JWT_SECRET, {
      expiresIn: '7d',
      issuer:    'school-management-app',
    });

    mentorRepo.touchLastLogin(mentor._id).catch(() => {});

    const prefs = await getLoginPrefs(mentor._id, 'MENTOR', mentor.schoolCampus ?? null);

    return sendSuccess(res, 200, 'Login successful.', {
      token,
      user: { ...buildUserResponse(mentor), ...prefs },
    });

  } catch (err) {
    console.error('❌ loginMentor error:', err);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const createMentor = async (req, res) => {
  try {
    const body = { ...req.body };

    if (req.user.role === 'CAMPUS_MANAGER') {
      body.schoolCampus = req.user.campusId;
    } else if (!body.schoolCampus) {
      return sendError(res, 400, 'schoolCampus is required.');
    }

    delete body.lastLogin;
    delete body.role;
    delete body.status;

    // The account starts 'pending' with an unusable placeholder password.
    // The mentor sets their own password through the activation flow — no
    // default password is ever issued (see modules/account).
    body.status   = 'pending';
    body.password = crypto.randomBytes(24).toString('hex');

    const mentor = await mentorRepo.create(body);

    // Issue the activation token: sends account.activate (when an email exists)
    // and returns the link + offline code ONCE for the admin to relay.
    const activation = await require('../../account').service.issueActivationToken({
      userModel: 'Mentor',
      userId:    mentor._id,
      campusId:  mentor.schoolCampus,
      email:     mentor.email || null,
      name:      mentor.firstName,
      createdBy: req.user.id,
    });

    const doc = mentor.toObject({ virtuals: true });
    delete doc.password;

    return sendSuccess(res, 201, 'Mentor created. Share the activation link or code with the mentor.', { ...doc, activation });

  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return sendError(res, 409, `${field} already exists.`);
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ createMentor error:', err);
    return sendError(res, 500, 'Failed to create mentor.');
  }
};

// ── LIST ──────────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 * @query  page, limit, search, status
 */
const getAllMentors = async (req, res) => {
  try {
    const campusFilter = getCampusFilter(req);
    const { page = 1, limit = 20, search, status, includeArchived } = req.query;

    const skip  = (Number(page) - 1) * Number(limit);
    const { data: docs, total } = await mentorRepo.paginate({
      campusFilter,
      status,
      includeArchived: includeArchived === 'true',
      search,
      skip,
      limit: Number(limit),
    });

    return sendPaginated(res, 200, 'Mentors retrieved.', docs, { total, page: Number(page), limit: Number(limit) });

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getAllMentors error:', err);
    return sendError(res, 500, 'Failed to retrieve mentors.');
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER | MENTOR (own)
 */
const getOneMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = req.user.role === 'MENTOR'
      ? { _id: id, schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) }
      : { ...getCampusFilter(req), _id: id };

    const mentor = await mentorRepo.findOneScoped(campusFilter);

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor retrieved.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ getOneMentor error:', err);
    return sendError(res, 500, 'Failed to retrieve mentor.');
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

/**
 * @route  PUT /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const body = { ...req.body };
    // Strip immutable / sensitive fields
    delete body.password;
    delete body.schoolCampus;
    delete body.role;
    delete body.lastLogin;

    const campusFilter = { ...getCampusFilter(req), _id: id };

    const mentor = await mentorRepo.updateScoped(campusFilter, body);

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor updated.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return sendError(res, 409, `${field} already exists.`);
    }
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateMentor error:', err);
    return sendError(res, 500, 'Failed to update mentor.');
  }
};

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/status
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const updateMentorStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const allowed = ['active', 'inactive', 'suspended', 'archived'];
    if (!allowed.includes(status)) {
      return sendError(res, 400, `status must be one of: ${allowed.join(', ')}.`);
    }

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await mentorRepo.setStatusScoped(campusFilter, status);

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor status updated.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ updateMentorStatus error:', err);
    return sendError(res, 500, 'Failed to update mentor status.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/reset-password
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const resetMentorPassword = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await mentorRepo.findOneScopedLean(campusFilter);
    if (!mentor) return sendNotFound(res, 'Mentor');

    // Secure reset: re-issue an activation link/code so the mentor sets a new
    // password themselves — no default or plaintext password is ever generated.
    const activation = await require('../../account').service.issueActivationToken({
      userModel: 'Mentor',
      userId:    mentor._id,
      campusId:  mentor.schoolCampus,
      email:     mentor.email || null,
      name:      mentor.firstName,
      createdBy: req.user.id,
    });

    return sendSuccess(res, 200, 'A password-reset link has been issued. Share the link or code with the mentor.', activation);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ resetMentorPassword error:', err);
    return sendError(res, 500, 'Failed to reset mentor password.');
  }
};

// ── ARCHIVE (soft delete) ─────────────────────────────────────────────────────

/**
 * @route  DELETE /api/mentors/:id
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const archiveMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await mentorRepo.setStatusScoped(campusFilter, 'archived');

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor archived.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ archiveMentor error:', err);
    return sendError(res, 500, 'Failed to archive mentor.');
  }
};

// ── RESTORE ───────────────────────────────────────────────────────────────────

/**
 * @route  PATCH /api/mentors/:id/restore
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const restoreMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const campusFilter = { ...getCampusFilter(req), _id: id };
    const mentor = await mentorRepo.setStatusScoped(campusFilter, 'active');

    if (!mentor) return sendNotFound(res, 'Mentor');
    return sendSuccess(res, 200, 'Mentor restored.', mentor);

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ restoreMentor error:', err);
    return sendError(res, 500, 'Failed to restore mentor.');
  }
};

// ── PERMANENT DELETE ──────────────────────────────────────────────────────────

/**
 * @route  DELETE /api/mentors/:id/permanent
 * @access ADMIN only
 */
const deleteMentor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const mentor = await mentorRepo.deleteById(id);
    if (!mentor) return sendNotFound(res, 'Mentor');

    return sendSuccess(res, 200, 'Mentor permanently deleted.');

  } catch (err) {
    console.error('❌ deleteMentor error:', err);
    return sendError(res, 500, 'Failed to delete mentor.');
  }
};

// ── ASSIGN STUDENTS ───────────────────────────────────────────────────────────

/**
 * Attach or detach students from a mentor in bulk.
 *
 * Body:
 *   studentIds  {string[]}  Optional. Individual student IDs.
 *   classIds    {string[]}  Optional. All active students from these classes are resolved.
 *   mode        {string}    Required. 'add' | 'remove' | 'replace'
 *
 * At least one of studentIds or classIds must be non-empty.
 * All resolved students must belong to the same campus as the mentor.
 *
 * @route  PATCH /api/mentors/:id/assign-students
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const assignStudents = async (req, res) => {
  try {
    const { id } = req.params;
    const { studentIds = [], classIds = [], mode } = req.body;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid mentor ID format.');

    const VALID_MODES = ['add', 'remove', 'replace'];
    if (!VALID_MODES.includes(mode)) {
      return sendError(res, 400, `mode must be one of: ${VALID_MODES.join(', ')}.`);
    }

    if (!Array.isArray(studentIds) || !Array.isArray(classIds)) {
      return sendError(res, 400, 'studentIds and classIds must be arrays.');
    }
    if (studentIds.length === 0 && classIds.length === 0) {
      return sendError(res, 400, 'Provide at least one studentId or classId.');
    }
    if (studentIds.some((sid) => !isValidObjectId(sid))) {
      return sendError(res, 400, 'One or more studentIds have an invalid format.');
    }
    if (classIds.some((cid) => !isValidObjectId(cid))) {
      return sendError(res, 400, 'One or more classIds have an invalid format.');
    }

    const campusFilter = getCampusFilter(req);
    const mentor = await mentorRepo.findOneScopedLean({ ...campusFilter, _id: id });
    if (!mentor) return sendNotFound(res, 'Mentor');

    const campusOid = new mongoose.Types.ObjectId(mentor.schoolCampus);

    // Validate explicit studentIds belong to this campus
    let resolvedIds = [];

    if (studentIds.length > 0) {
      const sidOids = studentIds.map((s) => new mongoose.Types.ObjectId(s));
      const validCount = await studentService.countStudents({
        studentIds:      sidOids,
        campusId:        campusOid,
        excludeArchived: true,
      });
      if (validCount !== studentIds.length) {
        return sendError(res, 400, 'One or more students do not belong to this campus or are archived.');
      }
      resolvedIds = sidOids;
    }

    // Resolve classIds → student IDs (campus already scoped)
    if (classIds.length > 0) {
      const cidOids = classIds.map((c) => new mongoose.Types.ObjectId(c));
      const fromClasses = await studentService.listStudentIds({
        classIds:        cidOids,
        campusId:        campusOid,
        excludeArchived: true,
      });
      fromClasses.forEach((s) => resolvedIds.push(s._id));
    }

    // Deduplicate
    const seen = new Set();
    const uniqueIds = resolvedIds.filter((oid) => {
      const key = oid.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (uniqueIds.length === 0) {
      return sendError(res, 400, 'No eligible students found for the provided IDs / classes.');
    }

    // Apply mode
    let updateOp;
    if (mode === 'add') {
      updateOp = { $addToSet: { students: { $each: uniqueIds } } };
    } else if (mode === 'remove') {
      updateOp = { $pullAll: { students: uniqueIds } };
    } else {
      // replace
      updateOp = { $set: { students: uniqueIds } };
    }

    const updated = await mentorRepo.applyStudentAssignment(mentor._id, updateOp);

    // Keep the Student.mentor back-reference and the single-mentor invariant in
    // sync with Mentor.students[]. Best-effort: the primary write already
    // succeeded, so we log inconsistencies rather than failing the request.
    try {
      if (mode === 'add' || mode === 'replace') {
        // A student belongs to a single mentor: detach from any other mentor first.
        await mentorRepo.detachStudentsFromOtherMentors(uniqueIds, mentor._id, campusOid);
        await studentService.assignMentor({ studentIds: uniqueIds, mentorId: mentor._id, campusId: campusOid });

        if (mode === 'replace') {
          // Clear the back-reference for students dropped from the previous set.
          const keep    = new Set(uniqueIds.map(String));
          const removed = (mentor.students ?? []).filter((sid) => !keep.has(String(sid)));
          if (removed.length) {
            await studentService.unassignMentor({ studentIds: removed, mentorId: mentor._id, campusId: campusOid });
          }
        }
      } else {
        // remove
        await studentService.unassignMentor({ studentIds: uniqueIds, mentorId: mentor._id, campusId: campusOid });
      }
    } catch (syncErr) {
      console.error('⚠️ assignStudents back-reference sync failed:', syncErr.message);
    }

    const verb = mode === 'add' ? 'added to' : mode === 'remove' ? 'removed from' : 'set for';
    return sendSuccess(res, 200, `Students ${verb} mentor.`, {
      mentor:  updated,
      summary: { affected: uniqueIds.length, total: updated.students.length },
    });

  } catch (err) {
    if (err.statusCode === 403) return sendError(res, 403, err.message);
    console.error('❌ assignStudents error:', err);
    return sendError(res, 500, 'Failed to assign students.');
  }
};

// ── CLOUDINARY UPLOAD SIGNATURE (CM) ─────────────────────────────────────────

/**
 * @route  GET /api/mentors/upload-signature
 * @access ADMIN | DIRECTOR | CAMPUS_MANAGER
 */
const getUploadSignature = (_req, res) => profileSvc.getUploadSignature(res);

module.exports = {
  loginMentor,
  createMentor,
  getAllMentors,
  getOneMentor,
  updateMentor,
  updateMentorStatus,
  resetMentorPassword,
  archiveMentor,
  restoreMentor,
  deleteMentor,
  getUploadSignature,
  assignStudents,
};
