'use strict';

/**
 * @file admin.repository.js — couche de persistance du domaine admin.
 *
 * SEUL fichier du module autorisé à interroger le model Admin directement.
 * Étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * NB : les endpoints de profil (updateMyProfile / uploadProfileImage /
 * updateMyNotifications) passent le model Admin au service partagé
 * shared/services/profile.service — couche partagée opérant sur un Model, hors
 * périmètre du repository par module (même cas que GenericEntityController).
 */

const Admin = require('./admin.model');
const { escapeRegex } = require('../../shared/utils/validation-helpers');

/** Compte de comptes admin (garde de bootstrap). */
const count = () => Admin.countDocuments();

/** Recherche par email, AVEC le hash de mot de passe (login). */
const findByEmailWithPassword = (email) =>
  Admin.findOne({ email }).select('+password').lean();

/** Search by email (uniqueness check). */
const findByEmail = (email) => Admin.findOne({ email }).lean();

/** Updates lastLogin (fire-and-forget — returns the promise). */
const touchLastLogin = (id) =>
  Admin.updateOne({ _id: id }, { $set: { lastLogin: new Date() } });

/** Creates an admin account. @returns {Promise<Document>} (for toObject on the controller side) */
const create = (data) => Admin.create(data);

/** Profil par id (sans mot de passe). */
const findByIdLean = (id) => Admin.findById(id).lean();

/** Profil par id, AVEC le hash (changement de mot de passe). */
const findByIdWithPassword = (id) => Admin.findById(id).select('+password').lean();

/** Updates the password (already hashed). */
const updatePassword = (id, hashedPassword) =>
  Admin.findByIdAndUpdate(id, { password: hashedPassword });

/**
 * Liste paginée (sans mot de passe), createdBy peuplé, tri récent.
 * @returns {Promise<{data: Object[], total: number}>}
 */
const paginate = async ({ role, status, search, skip, limit }) => {
  const filter = {};
  if (role)   filter.role   = role;
  if (status) filter.status = status;
  if (search) {
    const re = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ admin_name: re }, { email: re }];
  }

  const [data, total] = await Promise.all([
    Admin.find(filter)
      .select('-password')
      .populate('createdBy', 'admin_name email')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit).lean(),
    Admin.countDocuments(filter),
  ]);
  return { data, total };
};

/**
 * Applique un changement de statut + entrée d'historique (load→push→save).
 * @returns {Promise<Document|null>}
 */
const applyStatusChange = async (id, { status, changedBy, note }) => {
  const admin = await Admin.findById(id).select('-password');
  if (!admin) return null;
  admin.status = status;
  admin.statusHistory.push({ status, changedBy, changedAt: new Date(), note: note?.trim() || null });
  await admin.save();
  return admin;
};

module.exports = {
  count,
  findByEmailWithPassword,
  findByEmail,
  touchLastLogin,
  create,
  findByIdLean,
  findByIdWithPassword,
  updatePassword,
  paginate,
  applyStatusChange,
};
