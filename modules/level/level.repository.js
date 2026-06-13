'use strict';

/**
 * @file level.repository.js — couche de persistance du domaine level.
 *
 * SEUL fichier du module autorisé à toucher le model Mongoose `Level`.
 * Controllers et service appellent ce repository (jamais le model directement).
 * Objectif (étape 0 de la préparation Postgres — voir POSTGRES_MIGRATION_ASSESSMENT.md) :
 * isoler la persistance pour pouvoir, plus tard, réécrire l'intérieur (Postgres)
 * sans toucher la couche HTTP ni l'API inter-modules.
 *
 * Convention : les méthodes de LECTURE renvoient des objets simples (.lean()) ;
 * les ÉCRITURES font load→mutate→save pour préserver les setters/validations du
 * schéma (ex. `uppercase: true` sur name/code).
 */

const Level = require('./level.model');

/**
 * Recherche un niveau par (code, type) — utilisé pour le contrôle d'unicité.
 * @returns {Promise<Object|null>} objet simple ou null
 */
const findByCodeAndType = (code, type) =>
  Level.findOne({ code, type }).lean();

/**
 * Crée un niveau.
 * @param {Object} data - { name, code, type, order, description }
 * @returns {Promise<Object>} le document créé
 */
const create = (data) => Level.create(data);

/**
 * Liste les niveaux actifs, triés par `order` croissant, filtrés optionnellement
 * par type.
 * @param {{ type?: string }} [opts]
 * @returns {Promise<Object[]>}
 */
const listActive = ({ type } = {}) => {
  const filter = { status: 'active' };
  if (type) filter.type = type;
  return Level.find(filter).sort({ order: 1 }).lean();
};

/**
 * Récupère un niveau par id (lecture).
 * @returns {Promise<Object|null>}
 */
const findById = (id) => Level.findById(id).lean();

/**
 * Met à jour les champs fournis d'un niveau (load→assign→save : conserve setters
 * et validations, et propage l'erreur de doublon E11000 à l'appelant).
 * @param {string} id
 * @param {Object} fields - uniquement les champs à modifier
 * @returns {Promise<Object|null>} le document mis à jour, ou null si introuvable
 */
const updateById = async (id, fields) => {
  const level = await Level.findById(id);
  if (!level) return null;
  Object.assign(level, fields);
  await level.save();
  return level;
};

/**
 * Change le statut d'un niveau (active/archived) — archivage & restauration.
 * @returns {Promise<Object|null>} le document mis à jour, ou null si introuvable
 */
const setStatus = async (id, status) => {
  const level = await Level.findById(id);
  if (!level) return null;
  level.status = status;
  await level.save();
  return level;
};

module.exports = {
  findByCodeAndType,
  create,
  listActive,
  findById,
  updateById,
  setStatus,
};
