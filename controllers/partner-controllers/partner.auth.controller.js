'use strict';

/**
 * @file partner_auth_controller.js
 * @description Auth endpoints for the PARTNER role.
 *
 * Routes:
 *  POST  /api/partners/auth/register        → register        (MGR/DIR/ADMIN)
 *  POST  /api/partners/auth/login           → login           (PUBLIC)
 *  POST  /api/partners/auth/forgot-password → forgotPassword  (PUBLIC)
 *  POST  /api/partners/auth/reset-password/:token → resetPassword (PUBLIC)
 *  GET   /api/partners/me                   → getMe           (PARTNER)
 *  PUT   /api/partners/me/profile           → updateMyProfile (PARTNER)
 *  PUT   /api/partners/me/password          → changeMyPassword (PARTNER)
 *  POST  /api/partners/me/profile-image     → uploadProfileImage (PARTNER)
 *
 * Invariants :
 * • campusId toujours depuis JWT — jamais depuis URL params.
 * • QR code : généré côté serveur, stocké dans uploads/{campusId}/partners/qr/.
 * • Password : bcrypt 12 rounds via pre-save hook (register) ou manuel (changeMyPassword).
 * • JWT payload : { id, role:'PARTNER', campusId, partnerCode, partnerType }
 */

const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs').promises;
const mongoose = require('mongoose');

const Partner    = require('../../models/partner-models/partner.model');
const {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
} = require('../../utils/response-helpers');
const { isValidObjectId, validatePasswordStrength } = require('../../utils/validation-helpers');
const { getLoginPrefs } = require('../../utils/login-prefs.util');

const SALT_ROUNDS = 12;
const JWT_SECRET  = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const UPLOAD_BASE = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

// ── HELPERS ───────────────────────────────────────────────────────────────────

const buildTokenPayload = (partner) => ({
  id:          partner._id.toString(),
  role:        'PARTNER',
  campusId:    partner.schoolCampus?.toString?.() ?? partner.schoolCampus,
  partnerCode: partner.partnerCode,
  partnerType: partner.partnerType,
});

const buildPartnerResponse = (partner) => {
  const obj = partner.toObject ? partner.toObject({ virtuals: true }) : { ...partner };
  delete obj.password;
  delete obj.__v;
  // Le champ `role` du modèle vaut null par défaut ; on force 'PARTNER' pour que
  // le front-end (ProtectedRoute) résolve correctement les autorisations.
  obj.role = 'PARTNER';
  return obj;
};

/**
 * Génère le QR PNG pour le referralLink d'un partenaire.
 * Stocké sous uploads/{campusId}/partners/qr/qr_{partnerCode}.png
 * Retourne le nom du fichier.
 */
const generatePartnerQR = async (referralLink, campusId, partnerCode) => {
  const qrDir = path.join(UPLOAD_BASE, campusId.toString(), 'partners', 'qr');
  await fs.mkdir(qrDir, { recursive: true });

  const fileName = `qr_${partnerCode.toLowerCase()}.png`;
  const filePath = path.join(qrDir, fileName);

  const buffer = await QRCode.toBuffer(referralLink, {
    type:                 'png',
    width:                300,
    errorCorrectionLevel: 'M',
    margin:               2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  await fs.writeFile(filePath, buffer);
  return fileName;
};

const isGlobalRole = (role) => role === 'ADMIN' || role === 'DIRECTOR';

// ── REGISTER ──────────────────────────────────────────────────────────────────

/**
 * Crée un nouveau compte partenaire et génère partnerCode + QR.
 * Appelé par CAMPUS_MANAGER / ADMIN / DIRECTOR.
 *
 * @route  POST /api/partners/auth/register
 * @access CAMPUS_MANAGER, ADMIN, DIRECTOR
 */
const register = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const {
      firstName, lastName, email, phone, gender,
      password, organization, bio,
      partnerType, institutionType, commercialType, channelType,
      tier, contacts, convention, commissionConfig, socialLinks,
      subjectId, country,
      // ADMIN/DIRECTOR peuvent cibler un campus précis
      schoolCampus: bodyCampusId,
    } = req.body;

    // Validation champs obligatoires
    if (!firstName?.trim()) return sendError(res, 400, 'firstName is required.');
    if (!lastName?.trim())  return sendError(res, 400, 'lastName is required.');
    if (!email?.trim())     return sendError(res, 400, 'email is required.');
    if (!password)          return sendError(res, 400, 'password is required.');
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid)     return sendError(res, 400, pwCheck.errors[0]);
    if (!partnerType)       return sendError(res, 400, 'partnerType is required.');

    // Résolution du campus
    let campusId;
    if (isGlobalRole(req.user.role)) {
      if (!bodyCampusId) return sendError(res, 400, 'schoolCampus is required for ADMIN/DIRECTOR.');
      if (!isValidObjectId(bodyCampusId)) return sendError(res, 400, 'Invalid schoolCampus.');
      campusId = new mongoose.Types.ObjectId(bodyCampusId);
    } else {
      if (!req.user.campusId) return sendError(res, 403, 'Campus information not found in your account.');
      campusId = new mongoose.Types.ObjectId(req.user.campusId);
    }

    // Unicité email
    const existing = await Partner.findOne({ email: email.toLowerCase().trim() }).lean();
    if (existing) return sendError(res, 409, 'A partner with this email already exists.');

    // Génération partnerCode
    const year = new Date().getFullYear();
    const partnerCode = await Partner.generatePartnerCode(
      lastName.trim(),
      firstName.trim(),
      country || 'CMR',
      year
    );

    // referralLink + QR
    const referralLink    = `${FRONTEND_URL}/register?ref=${partnerCode}`;
    const qrCodeFileName  = await generatePartnerQR(referralLink, campusId, partnerCode);

    // Création du partenaire (le pre-save hook hash le password)
    const partner = new Partner({
      schoolCampus:     campusId,
      firstName:        firstName.trim(),
      lastName:         lastName.trim(),
      email:            email.toLowerCase().trim(),
      phone:            phone || null,
      gender:           gender || null,
      password,
      organization:     organization || null,
      bio:              bio || null,
      partnerType,
      institutionType:  institutionType || null,
      commercialType:   commercialType  || null,
      channelType:      channelType     || null,
      tier:             tier            || 'bronze',
      contacts:         contacts        || [],
      convention:       convention      || null,
      commissionConfig: commissionConfig || null,
      socialLinks:      socialLinks     || null,
      partnerCode,
      referralLink,
      qrCodeFileName,
      createdBy:        req.user.id,
      status:           'active',
    });

    await partner.save();

    const safePartner = buildPartnerResponse(partner);
    return sendCreated(res, 'Partner account created successfully.', safePartner);

  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'field';
      return sendError(res, 409, `${field} already exists.`);
    }
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ register partner error:', error);
    return sendError(res, 500, 'Failed to create partner account.');
  }
};

// ── LOGIN ─────────────────────────────────────────────────────────────────────

/**
 * Connexion partenaire — retourne un JWT.
 *
 * @route  POST /api/partners/auth/login
 * @access PUBLIC
 */
const login = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { email, password } = req.body;

    if (!email || !password) return sendError(res, 400, 'Email and password are required.');

    const partner = await Partner.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!partner) return sendError(res, 401, 'Invalid credentials.');

    const isMatch = await partner.comparePassword(password);
    if (!isMatch) return sendError(res, 401, 'Invalid credentials.');

    if (partner.status === 'archived' || partner.status === 'suspended') {
      return sendError(res, 403, 'Your account is not active. Please contact support.');
    }

    const token = jwt.sign(
      buildTokenPayload(partner),
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'school-management-app' }
    );

    // Fire-and-forget: lastLoginAt + lastActivityAt
    Partner.findByIdAndUpdate(partner._id, {
      lastLoginAt:    new Date(),
      lastActivityAt: new Date(),
    }).exec().catch(() => {});

    const safePartner = buildPartnerResponse(partner);
    const prefs = await getLoginPrefs(partner._id, 'PARTNER', partner.schoolCampus ?? null);
    return sendSuccess(res, 200, 'Login successful.', { token, user: { ...safePartner, ...prefs } });

  } catch (error) {
    console.error('❌ login partner error:', error);
    return sendError(res, 500, 'Internal server error during login.');
  }
};

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────

/**
 * Génère un token signé de réinitialisation de mot de passe (1h).
 * En P2 : lien retourné dans la réponse + dispatch WhatsApp (stub).
 * En P3 : WhatsApp réel via provider sélectionné.
 *
 * @route  POST /api/partners/auth/forgot-password
 * @access PUBLIC
 */
const forgotPassword = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { email } = req.body;
    if (!email?.trim()) return sendError(res, 400, 'email is required.');

    const partner = await Partner.findOne({ email: email.toLowerCase().trim() })
      .select('+password')
      .lean();

    // Toujours répondre 200 pour ne pas révéler si l'email existe
    if (!partner) {
      return sendSuccess(res, 200, 'If this email is registered, a reset link has been sent.');
    }

    // Le hash du password actuel sert de nonce — invalide le token dès le changement de mdp
    const resetToken = jwt.sign(
      { id: partner._id.toString(), purpose: 'pwd-reset', nonce: partner.password?.slice(-8) },
      JWT_SECRET,
      { expiresIn: '1h', issuer: 'school-management-app' }
    );

    const resetLink = `${FRONTEND_URL}/partner/reset-password?token=${resetToken}`;

    // TODO P2: Envoyer resetLink via WhatsApp Business API (provider à sélectionner)
    console.info(`[PARTNER RESET] Reset link for ${partner.email}: ${resetLink}`);

    return sendSuccess(res, 200, 'If this email is registered, a reset link has been sent.', {
      // Exposé uniquement en développement
      ...(process.env.NODE_ENV !== 'production' && { resetLink }),
    });

  } catch (error) {
    console.error('❌ forgotPassword partner error:', error);
    return sendError(res, 500, 'Failed to process password reset request.');
  }
};

// ── RESET PASSWORD ────────────────────────────────────────────────────────────

/**
 * Valide le token signé et met à jour le mot de passe.
 *
 * @route  POST /api/partners/auth/reset-password/:token
 * @access PUBLIC
 */
const resetPassword = async (req, res) => {
  try {
    if (!JWT_SECRET) return sendError(res, 500, 'Server configuration error.');

    const { token } = req.params;
    const { newPassword } = req.body;

    if (!token)       return sendError(res, 400, 'Reset token is required.');
    if (!newPassword) return sendError(res, 400, 'newPassword is required.');
    if (newPassword.length < 8) return sendError(res, 400, 'Password must be at least 8 characters.');

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { issuer: 'school-management-app' });
    } catch {
      return sendError(res, 400, 'Invalid or expired reset token.');
    }

    if (decoded.purpose !== 'pwd-reset') return sendError(res, 400, 'Invalid reset token.');

    const partner = await Partner.findById(decoded.id).select('+password');
    if (!partner) return sendError(res, 404, 'Partner not found.');

    // Vérifier que le nonce correspond — invalide si le mot de passe a déjà été changé
    if (partner.password?.slice(-8) !== decoded.nonce) {
      return sendError(res, 400, 'Reset token has already been used.');
    }

    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hashed = await bcrypt.hash(newPassword, salt);

    await Partner.findByIdAndUpdate(partner._id, { password: hashed });

    return sendSuccess(res, 200, 'Password reset successfully.');

  } catch (error) {
    console.error('❌ resetPassword partner error:', error);
    return sendError(res, 500, 'Failed to reset password.');
  }
};

// ── GET OWN PROFILE ───────────────────────────────────────────────────────────

/**
 * @route  GET /api/partners/me
 * @access PARTNER
 */
const getMe = async (req, res) => {
  try {
    const partner = await Partner.findOne({
      _id:          req.user.id,
      schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    }).select('-password -__v').lean({ virtuals: true });

    if (!partner) return sendNotFound(res, 'Partner');

    partner.role = 'PARTNER';
    return sendSuccess(res, 200, 'Profile retrieved.', partner);

  } catch (error) {
    console.error('❌ getMe partner error:', error);
    return sendError(res, 500, 'Failed to retrieve profile.');
  }
};

// ── UPDATE OWN PROFILE ────────────────────────────────────────────────────────

/**
 * Mise à jour des champs éditables par le partenaire lui-même.
 * Champs autorisés : bio, phone, socialLinks, contacts, organization.
 * Champs protégés (partnerCode, schoolCampus, etc.) : ignorés silencieusement.
 *
 * @route  PUT /api/partners/me/profile
 * @access PARTNER
 */
const updateMyProfile = async (req, res) => {
  try {
    const allowed = ['bio', 'phone', 'socialLinks', 'contacts', 'organization', 'gender'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, `No updatable fields provided. Allowed: ${allowed.join(', ')}.`);
    }

    const partner = await Partner.findOneAndUpdate(
      { _id: req.user.id, schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) },
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -__v').lean({ virtuals: true });

    if (!partner) return sendNotFound(res, 'Partner');

    return sendSuccess(res, 200, 'Profile updated.', partner);

  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      return sendError(res, 400, 'Validation failed.', errors);
    }
    console.error('❌ updateMyProfile partner error:', error);
    return sendError(res, 500, 'Failed to update profile.');
  }
};

// ── CHANGE OWN PASSWORD ───────────────────────────────────────────────────────

/**
 * @route  PUT /api/partners/me/password
 * @access PARTNER
 */
const changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'currentPassword and newPassword are required.');
    }
    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) {
      return sendError(res, 400, pwCheck.errors[0]);
    }
    if (currentPassword === newPassword) {
      return sendError(res, 400, 'New password must differ from the current password.');
    }

    const partner = await Partner.findOne({
      _id:          req.user.id,
      schoolCampus: new mongoose.Types.ObjectId(req.user.campusId),
    }).select('+password');

    if (!partner) return sendNotFound(res, 'Partner');

    const isMatch = await partner.comparePassword(currentPassword);
    if (!isMatch) return sendError(res, 401, 'Current password is incorrect.');

    // Hash manuellement pour contourner le pre-save hook (évite double-hash)
    const salt   = await bcrypt.genSalt(SALT_ROUNDS);
    const hashed = await bcrypt.hash(newPassword, salt);

    await Partner.findByIdAndUpdate(partner._id, { password: hashed });

    return sendSuccess(res, 200, 'Password updated successfully.');

  } catch (error) {
    console.error('❌ changeMyPassword partner error:', error);
    return sendError(res, 500, 'Failed to update password.');
  }
};

// ── UPLOAD PROFILE IMAGE ──────────────────────────────────────────────────────

/**
 * Stocke l'URL Cloudinary renvoyée après upload direct.
 * Body: { profileImageUrl: string }
 *
 * @route  POST /api/partners/me/profile-image
 * @access PARTNER
 */
const uploadProfileImage = async (req, res) => {
  try {
    const { profileImageUrl } = req.body;

    if (!profileImageUrl?.trim()) {
      return sendError(res, 400, 'profileImageUrl is required.');
    }

    const partner = await Partner.findOneAndUpdate(
      { _id: req.user.id, schoolCampus: new mongoose.Types.ObjectId(req.user.campusId) },
      { $set: { profileImage: profileImageUrl.trim() } },
      { new: true }
    ).select('_id firstName lastName profileImage').lean({ virtuals: true });

    if (!partner) return sendNotFound(res, 'Partner');

    return sendSuccess(res, 200, 'Profile image updated.', { profileImage: partner.profileImage });

  } catch (error) {
    console.error('❌ uploadProfileImage partner error:', error);
    return sendError(res, 500, 'Failed to update profile image.');
  }
};

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  updateMyProfile,
  changeMyPassword,
  uploadProfileImage,
};
