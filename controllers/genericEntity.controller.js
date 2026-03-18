const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { cleanupUploadedFile } = require('../middleware/upload/upload');
const { deleteFile } = require('../utils/fileUpload');
const {
  sendSuccess,
  sendError,
  sendPaginated,
  sendCreated,
  sendNotFound,
  sendConflict,
  handleDuplicateKeyError
} = require('../utils/responseHelpers');
const {
  isValidObjectId,
  isValidEmail,
  validatePasswordStrength,
  buildCampusFilter
} = require('../utils/validationHelpers');

const SALT_ROUNDS = 10;

class GenericEntityController {
  constructor(config) {
    this.Model          = config.Model;
    this.entityName     = config.entityName;
    this.entityNameLower = config.entityName.toLowerCase();
    this.folderName     = config.folderName;
    this.searchFields   = config.searchFields   || ['firstName', 'lastName', 'email'];
    this.populateFields = config.populateFields || [];
    this.customValidation = config.customValidation || null;
    this.beforeCreate   = config.beforeCreate   || null;
    this.afterCreate    = config.afterCreate    || null;
    this.beforeUpdate   = config.beforeUpdate   || null;
    this.afterUpdate    = config.afterUpdate    || null;
    this.statsFacets    = config.statsFacets    || null;
    this.statsFormatter = config.statsFormatter || null;
    this.buildExtraFilters = config.buildExtraFilters || null;
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  /**
   * Applies the population to a Mongoose query (without lean)
   * or populates an already loaded document.
   */
  async _populate(target) {
    for (const field of this.populateFields) {
      target = await target.populate(field);
    }
    return target;
  }

  /**
   * Resolves the campusId based on the user's role.
   * Returns { campusId } or { error } to handle failure.
   */
  _resolveCampusId(user, fields) {
    if (user.role === 'CAMPUS_MANAGER') {
      return { campusId: user.campusId };
    }
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR') {
      if (!fields.schoolCampus) {
        return { error: 'Campus ID is required' };
      }
      return { campusId: fields.schoolCampus };
    }
    return { forbidden: true };
  }

  // ─────────────────────────────────────────────
  // CREATE
  // ─────────────────────────────────────────────
  create = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    // Flag to know if the transaction is still active
    let transactionActive = true;

    const safeAbort = async () => {
      if (transactionActive) {
        transactionActive = false;
        await session.abortTransaction();
      }
    };

    try {
      const fields      = { ...req.body };
      const uploadedFile = req.file;

      // ── Parse JSON-serialised nested fields sent via multipart FormData ──
      // Multer flattens all text parts as plain strings. Fields that the
      // frontend serialises as JSON (e.g. emergencyContact) are deserialized
      // here so Mongoose receives the proper sub-document shape.
      const JSON_FIELDS = ['emergencyContact'];
      JSON_FIELDS.forEach((fieldName) => {
        if (typeof fields[fieldName] === 'string') {
          try {
            fields[fieldName] = JSON.parse(fields[fieldName]);
          } catch {
            // Leave as-is; Mongoose validation will reject malformed data.
          }
        }
      });

      // ── 1. Resolve the campus ──────────────────
      const campusResolution = this._resolveCampusId(req.user, fields);
      if (campusResolution.forbidden) {
        await safeAbort();
        return sendError(res, 403, 'Not authorized to create entities');
      }
      if (campusResolution.error) {
        await safeAbort();
        return sendError(res, 400, campusResolution.error);
      }
      const campusId = campusResolution.campusId;

      // ── 2. Extract authentication fields ───────
      const { email, username, password, ...rest } = fields;

      // ── 3. Validate required fields ─────────────
      if (!email || !username || !password) {
        await safeAbort();
        return sendError(res, 400, 'Email, username, and password are required');
      }

      if (!isValidEmail(email)) {
        await safeAbort();
        return sendError(res, 400, 'Invalid email format');
      }

      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        await safeAbort();
        return sendError(res, 400, 'Password does not meet requirements', {
          errors: passwordValidation.errors
        });
      }

      // ── 4. Hook beforeCreate ─────────────────────────
      // The hook may mutate `fields` directly (e.g. auto-generate matricule).
      // After it runs, re-sync `rest` so any field written into `fields` is
      // picked up when building `entityData` below.
      if (this.beforeCreate) {
        const hookResult = await this.beforeCreate(fields, campusId, session);
        if (!hookResult.success) {
          await safeAbort();
          return sendError(res, 400, hookResult.error);
        }
        // Merge explicit return data (legacy path kept for compatibility)
        if (hookResult.data) {
          Object.assign(rest, hookResult.data);
        }
      }

      // Re-destructure so mutations made directly on `fields` by the hook
      // (e.g. fields.matricule auto-generated) are reflected in `rest`.
      // email / username / password are already captured above — skip them.
      {
        const { email: _e, username: _u, password: _p, ...refreshedRest } = fields;
        Object.assign(rest, refreshedRest);
      }

      // ── 5. Uniqueness of email / username ─────────────
      const [existingEmail, existingUser] = await Promise.all([
        this.Model.findOne({ email: email.toLowerCase() }).session(session),
        this.Model.findOne({ username: username.toLowerCase() }).session(session),
      ]);

      if (existingEmail) {
        await safeAbort();
        return sendConflict(res, 'This email is already registered');
      }
      if (existingUser) {
        await safeAbort();
        return sendConflict(res, 'This username is already taken');
      }

      // ── 6. Custom validation ─────────────────
      if (this.customValidation) {
        const customValidationResult = await this.customValidation(fields, campusId, session);
        if (!customValidationResult.valid) {
          await safeAbort();
          return sendError(res, 400, customValidationResult.error);
        }
      }

      // ── 7. Hash the password ──────────────────────
      const salt           = await bcrypt.genSalt(SALT_ROUNDS);
      const hashedPassword = await bcrypt.hash(password, salt);

      const profileImage = uploadedFile ? uploadedFile.path : null;

      // ── 8. Create the document ──────────────────────
      const entityData = {
        ...rest,
        email:        email.toLowerCase(),
        username:     username.toLowerCase(),
        password:     hashedPassword,
        schoolCampus: campusId,
        profileImage,
      };

      const entity      = new this.Model(entityData);
      const savedEntity = await entity.save({ session });

      // ── 9. Commit the transaction ──────────────────
      transactionActive = false;
      await session.commitTransaction();

      // ── 10. Hook afterCreate (outside the transaction, non-blocking) ──
      // `fields` is forwarded so hooks (e.g. teacher) can access extra payload
      // values such as `classManagerOf` that are not stored on the document.
      if (this.afterCreate) {
        this.afterCreate(savedEntity, fields).catch(err =>
          console.error('Non-critical error in afterCreate:', err)
        );
      }

      // ── 11. Populate & response ───────────────────────
      let populatedEntity = await this.Model.findById(savedEntity._id).select('-password');
      populatedEntity     = await this._populate(populatedEntity);

      // FIX typo: populatedEntity.toObject() (the dot was missing)
      return sendCreated(res, `${this.entityName} created successfully`, populatedEntity.toObject());

    } catch (error) {
      await safeAbort();

      if (req.file) await cleanupUploadedFile(req.file).catch(console.error);

      console.error(`❌ Error creating ${this.entityNameLower}:`, error);

      if (error.code === 11000) return handleDuplicateKeyError(res, error);

      if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(e => e.message);
        return sendError(res, 400, 'Validation failed', { errors: messages });
      }

      return sendError(res, 500, `Failed to create ${this.entityNameLower}`);
    } finally {
      session.endSession();
    }
  };

  // ─────────────────────────────────────────────
  // GET ALL
  // ─────────────────────────────────────────────
  getAll = async (req, res) => {
    try {
      const {
        campusId,
        status,
        search,
        includeArchived,
        page  = 1,
        limit = 50,
      } = req.query;

      // Max limit to avoid full-collection scans
      const safeLimit = Math.min(Number(limit), 200);
      const skip      = (Number(page) - 1) * safeLimit;

      const filter = buildCampusFilter(req.user, campusId);

      if (this.buildExtraFilters) {
        Object.assign(filter, this.buildExtraFilters(req.query));
      }

      // Conflict between includeArchived / status resolved
      if (status) {
        filter.status = status;
      } else if (includeArchived !== 'true') {
        filter.status = { $ne: 'archived' };
      }

      if (search && this.searchFields.length > 0) {
        filter.$or = this.searchFields.map(field => ({
          [field]: { $regex: search, $options: 'i' },
        }));
      }

      // The documents are populated and then converted with toObject()
      let query = this.Model.find(filter)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit);

      if (this.populateFields.length > 0) {
        this.populateFields.forEach(field => query.populate(field));
      }

      const [entities, total] = await Promise.all([
        query.exec(),
        this.Model.countDocuments(filter).exec(),
      ]);

      // Conversion to POJO after population
      const plainEntities = entities.map(e => e.toObject());

      return sendPaginated(
        res,
        200,
        `${this.entityName}s retrieved successfully`,
        plainEntities,
        { total, page: Number(page), limit: safeLimit }
      );

    } catch (error) {
      console.error(`❌ Error fetching ${this.entityNameLower}s:`, error);
      return sendError(res, 500, `Failed to retrieve ${this.entityNameLower}s`);
    }
  };

  // ─────────────────────────────────────────────
  // GET ONE
  // ─────────────────────────────────────────────
  getOne = async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, `Invalid ${this.entityNameLower} ID format`);
      }

      // Check req.user FIRST
      if (!req.user) {
        return sendError(res, 401, 'Authentication required');
      }

      let entity = await this.Model.findById(id).select('-password');

      if (!entity) {
        return sendNotFound(res, this.entityName);
      }

      entity = await this._populate(entity);
      entity = entity.toObject();

      const isOwner = req.user.id?.toString() === id.toString();
      const isStaff = ['ADMIN', 'CAMPUS_MANAGER', 'TEACHER', 'DIRECTOR'].includes(req.user.role);

      if (!isOwner && !isStaff) {
        return sendError(res, 403, 'Not authorized to view this profile');
      }

      // Campus check for non-admins
      if (isStaff && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
        const entityCampusId = entity.schoolCampus?._id?.toString() || entity.schoolCampus?.toString();
        if (entityCampusId !== req.user.campusId?.toString()) {
          return sendError(res, 403, `This ${this.entityNameLower} does not belong to your campus`);
        }
      }

      return sendSuccess(res, 200, `${this.entityName} retrieved successfully`, entity);

    } catch (error) {
      console.error(`❌ Error fetching ${this.entityNameLower}:`, error);
      return sendError(res, 500, `Failed to retrieve ${this.entityNameLower}`);
    }
  };

  // ─────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────
  update = async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, `Invalid ${this.entityNameLower} ID format`);
      }

      const fields       = { ...req.body };
      const uploadedFile = req.file;

      // ── Parse JSON-serialised nested fields sent via multipart FormData ──
      const JSON_FIELDS = ['emergencyContact'];
      JSON_FIELDS.forEach((fieldName) => {
        if (typeof fields[fieldName] === 'string') {
          try {
            fields[fieldName] = JSON.parse(fields[fieldName]);
          } catch {
            // Malformed JSON — leave as-is; Mongoose will reject it.
          }
        }
      });

      const updates      = { ...fields };

      // These fields should never be updated via this route
      delete updates.password;
      delete updates.schoolCampus;

      const entity = await this.Model.findById(id);
      if (!entity) {
        return sendNotFound(res, this.entityName);
      }

      // Authorization
      if (req.user.role === 'CAMPUS_MANAGER') {
        if (entity.schoolCampus.toString() !== req.user.campusId) {
          return sendError(res, 403, `Can only update ${this.entityNameLower}s from your campus`);
        }
      } else if (!['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
        return sendError(res, 403, `Not authorized to update ${this.entityNameLower}s`);
      }

      // Email uniqueness
      if (updates.email && updates.email.toLowerCase() !== entity.email) {
        if (!isValidEmail(updates.email)) {
          return sendError(res, 400, 'Invalid email format');
        }
        const emailExists = await this.Model.findOne({
          email: updates.email.toLowerCase(),
          _id:   { $ne: id },
        });
        if (emailExists) {
          return sendConflict(res, 'This email is already in use');
        }
      }

      // Hook beforeUpdate
      if (this.beforeUpdate) {
        const hookResult = await this.beforeUpdate(entity, updates);
        if (!hookResult.success) {
          return sendError(res, 400, hookResult.error);
        }
      }

      // Profile image management
      if (uploadedFile) {
        if (entity.profileImage) {
          // static import
          await deleteFile(this.folderName, entity.profileImage).catch(console.error);
        }
        updates.profileImage = uploadedFile.path;
      }

      // Normalization
      if (updates.email)    updates.email    = updates.email.toLowerCase();
      if (updates.username) updates.username = updates.username.toLowerCase();

      // Snapshot the entity state BEFORE the update so afterUpdate can diff class lists
      const previousData = entity.toObject();

      let updatedEntity = await this.Model.findByIdAndUpdate(
        id,
        updates,
        { new: true, runValidators: true }
      ).select('-password');

      updatedEntity = await this._populate(updatedEntity);
      updatedEntity = updatedEntity.toObject();

      if (this.afterUpdate) {
        // `fields` and `previousData` are forwarded so hooks can diff old vs new state
        this.afterUpdate(updatedEntity, fields, previousData).catch(err =>
          console.error('Non-critical error in afterUpdate:', err)
        );
      }

      return sendSuccess(res, 200, `${this.entityName} updated successfully`, updatedEntity);

    } catch (error) {
      // guard on req.file before cleanup
      if (req.file) await cleanupUploadedFile(req.file).catch(console.error);

      console.error(`❌ Error updating ${this.entityNameLower}:`, error);

      if (error.code === 11000) return handleDuplicateKeyError(res, error);

      return sendError(res, 500, `Failed to update ${this.entityNameLower}`);
    }
  };

  // ─────────────────────────────────────────────
  // ARCHIVE (Soft Delete)
  // ─────────────────────────────────────────────
  archive = async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return sendError(res, 400, `Invalid ${this.entityNameLower} ID format`);
      }

      const entity = await this.Model.findById(id);
      if (!entity) {
        return sendNotFound(res, this.entityName);
      }

      if (req.user.role === 'CAMPUS_MANAGER') {
        if (entity.schoolCampus.toString() !== req.user.campusId) {
          return sendError(res, 403, `Can only archive ${this.entityNameLower}s from your campus`);
        }
      }

      entity.status = 'archived';
      await entity.save();

      return sendSuccess(res, 200, `${this.entityName} archived successfully`);

    } catch (error) {
      console.error(`❌ Error archiving ${this.entityNameLower}:`, error);
      return sendError(res, 500, `Failed to archive ${this.entityNameLower}`);
    }
  };

  // ─────────────────────────────────────────────
  // GET STATS
  // ─────────────────────────────────────────────
  getStats = async (req, res) => {
    try {
      const { campusId } = req.params;

      if (!isValidObjectId(campusId)) {
        return sendError(res, 400, 'Invalid campus ID');
      }

      const startOfMonth = new Date();
      startOfMonth.setHours(0, 0, 0, 0);
      startOfMonth.setDate(1);

      const baseFacets = {
        total: [{ $count: 'count' }],
        newThisMonth: [
          { $match: { createdAt: { $gte: startOfMonth } } },
          { $count: 'count' },
        ],
      };

      const customFacets = this.statsFacets ? this.statsFacets(startOfMonth) : {};
      const facets        = { ...baseFacets, ...customFacets };

      const statsArray = await this.Model.aggregate([
        {
          $match: {
            schoolCampus: new mongoose.Types.ObjectId(campusId),
            status:       'active',
          },
        },
        { $facet: facets },
      ]);

      const result    = statsArray[0];
      const baseStats = {
        totalEntities:         result.total?.[0]?.count        || 0,
        newEntitiesThisMonth:  result.newThisMonth?.[0]?.count || 0,
      };

      const customStats = this.statsFormatter ? this.statsFormatter(result) : {};

      return sendSuccess(res, 200, 'Statistics retrieved', { ...baseStats, ...customStats });

    } catch (error) {
      console.error('Stats Error:', error);
      return sendError(res, 500, 'Failed to retrieve statistics');
    }
  };
}

module.exports = GenericEntityController;