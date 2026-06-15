'use strict';

/**
 * @file gaet.repository.js — couche de persistance du domaine GAET.
 *
 * SEUL fichier du module autorisé à interroger le model GaetConstraint
 * (controller + service + worker). Étape 0 de la préparation Postgres — voir
 * POSTGRES_MIGRATION_ASSESSMENT.md §7.
 *
 * Le model n'a aucun hook pre/post (seulement des virtuals) : les transitions de
 * statut atomiques (findOneAndUpdate) sont donc fidèles. Le filtre campus
 * (isolation multi-tenant, {schoolCampus}|{}) est construit par le controller et
 * passé en paramètre.
 */

const GaetConstraint = require('./gaet-constraint.model');
const { GAET_STATUS } = GaetConstraint;

// ── Lectures ─────────────────────────────────────────────────────────────────

/** Contraintes d'un campus (sans les sessions générées — vues liste). */
const listForCampus = (query) =>
  GaetConstraint.find(query).select('-generatedSessions').lean();

/** Vue "statut" (polling). */
const findStatusView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status qualityReport generatedAt generatingStartedAt generationVersion academicYear semester schoolCampus')
    .lean();

/** Vue "preview" (sessions générées). */
const findPreviewView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status generatedSessions qualityReport academicYear semester schoolCampus')
    .lean();

/** Vue "conflits". */
const findConflictsView = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter })
    .select('status generatedSessions courseRequirements qualityReport')
    .lean();

/** Contrainte par campus + année + semestre (contrôle d'existence). */
const findByYearSemester = (campusFilter, academicYear, semester) =>
  GaetConstraint.findOne({ ...campusFilter, academicYear, semester }).lean();

/** Contrainte par id dans la portée campus (fallback). */
const findInCampus = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter }).lean();

/** Contrainte pour publication (lecture seule, virtual isPublishable inclus). */
const findForPublish = (id, campusFilter) =>
  GaetConstraint.findOne({ _id: id, ...campusFilter }).lean({ virtuals: true });

/** Lecture par id (worker de génération). */
const findByIdLean = (id) => GaetConstraint.findById(id).lean();

// ── Écritures (transitions atomiques — pas de hook) ────────────────────────────

/** Upsert des contraintes pour (campus, année, semestre). @returns {Promise<Document>} */
const upsert = (campusFilter, academicYear, semester, $set) =>
  GaetConstraint.findOneAndUpdate(
    { ...campusFilter, academicYear, semester },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

/**
 * Réserve atomiquement la contrainte pour génération (passe en GENERATING si
 * elle n'est ni GENERATING ni PUBLISHED). Renvoie le doc AVANT mise à jour
 * (new:false) — ou null si aucun match.
 */
const claimForGeneration = (campusFilter, academicYear, semester) =>
  GaetConstraint.findOneAndUpdate(
    {
      ...campusFilter, academicYear, semester,
      status: { $nin: [GAET_STATUS.GENERATING, GAET_STATUS.PUBLISHED] },
    },
    { $set: { status: GAET_STATUS.GENERATING, generatingStartedAt: new Date() } },
    { new: false },
  );

/** Restaure le statut + efface generatingStartedAt (échec pré-vol). */
const restoreStatus = (id, originalStatus) =>
  GaetConstraint.findByIdAndUpdate(id, { $set: { status: originalStatus, generatingStartedAt: null } });

/** Persiste le résultat du worker de génération. */
const applyWorkerResult = (id, { status, sessions, report, generatedBy, generationVersion }) =>
  GaetConstraint.findByIdAndUpdate(id, {
    $set: {
      status,
      generatedSessions:   sessions || [],
      qualityReport:       report   || null,
      generatedAt:         new Date(),
      generatedBy,
      generatingStartedAt: null,
      generationVersion,
    },
  });

/** Marque une génération comme échouée. */
const markFailed = (id) =>
  GaetConstraint.findByIdAndUpdate(id, { $set: { status: GAET_STATUS.FAILED, generatingStartedAt: null } });

/** Marque la contrainte comme publiée. */
const markPublished = (id, publishedBy) =>
  GaetConstraint.findByIdAndUpdate(id, {
    $set: { status: GAET_STATUS.PUBLISHED, publishedAt: new Date(), publishedBy },
  });

/**
 * Annule atomiquement un emploi du temps généré (non publié). Renvoie le doc
 * mis à jour (new:true), ou null si l'état ne le permet pas.
 */
const cancel = (id, campusFilter) =>
  GaetConstraint.findOneAndUpdate(
    {
      _id: id, ...campusFilter,
      status: { $in: [GAET_STATUS.GENERATED, GAET_STATUS.PARTIALLY_GENERATED, GAET_STATUS.FAILED] },
    },
    {
      $set: {
        status:              GAET_STATUS.CANCELLED,
        generatedSessions:   [],
        qualityReport:       null,
        generatedAt:         null,
        generatedBy:         null,
        generatingStartedAt: null,
      },
    },
    { new: true },
  );

/**
 * Récupère les jobs zombies (GENERATING dépassé) → FAILED.
 * @param {number} thresholdMs - ancienneté minimale de generatingStartedAt
 * @returns {Promise<number>} nombre de jobs récupérés
 */
const recoverZombies = async (thresholdMs) => {
  const cutoff = new Date(Date.now() - thresholdMs);
  const result = await GaetConstraint.updateMany(
    { status: GAET_STATUS.GENERATING, generatingStartedAt: { $lt: cutoff } },
    { $set: { status: GAET_STATUS.FAILED, generatingStartedAt: null } },
  );
  return result.modifiedCount;
};

module.exports = {
  listForCampus,
  findStatusView,
  findPreviewView,
  findConflictsView,
  findByYearSemester,
  findInCampus,
  findForPublish,
  findByIdLean,
  upsert,
  claimForGeneration,
  restoreStatus,
  applyWorkerResult,
  markFailed,
  markPublished,
  cancel,
  recoverZombies,
};
