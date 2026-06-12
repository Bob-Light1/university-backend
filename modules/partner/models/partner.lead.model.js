'use strict';

/**
 * @file partnerLead.model.js
 * @description Leads générés par les partenaires affiliés via pré-inscription.
 *
 * Invariants :
 * • schoolCampus résolu depuis le partnerCode sur la pré-inscription publique.
 * • ipAddressHash : SHA-256 uniquement — jamais l'IP brute (RGPD + Loi 2010/012).
 * • honeypotTripped : discard silencieux côté contrôleur, jamais exposé en API.
 * • isConverted est ABSENT : la conversion se dérive de status === 'enrolled'.
 * • Index composé sur (email, schoolCampus) et (phone, schoolCampus) pour dédup.
 */

const mongoose = require('mongoose');

// ── SUB-SCHEMAS ───────────────────────────────────────────────────────────────

const StatusEventSchema = new mongoose.Schema(
  {
    status:    { type: String, required: true },
    changedBy: { type: String, default: null },
    changedAt: { type: Date,   default: () => new Date() },
    note:      { type: String, trim: true, default: null },
  },
  { _id: false }
);

const UtmParamsSchema = new mongoose.Schema(
  {
    utm_source:   { type: String, default: null },
    utm_medium:   { type: String, default: null },
    utm_campaign: { type: String, default: null },
  },
  { _id: false }
);

// ── MAIN SCHEMA ───────────────────────────────────────────────────────────────

const partnerLeadSchema = new mongoose.Schema(
  {
    // ── CAMPUS ISOLATION ──────────────────────────────────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── PARTENAIRE RÉFÉRENT ───────────────────────────────────────────────
    // null pour les visites directes (source === 'direct')
    partner: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Partner',
      default: null,
    },

    partnerCode: {
      type:      String,
      trim:      true,
      uppercase: true,
      default:   null,
    },

    // ── INFORMATIONS PROSPECT ─────────────────────────────────────────────
    firstName: {
      type:     String,
      required: [true, 'Prospect first name is required'],
      trim:     true,
    },

    lastName: {
      type:     String,
      required: [true, 'Prospect last name is required'],
      trim:     true,
    },

    email: {
      type:      String,
      required:  [true, 'Prospect email is required'],
      lowercase: true,
      trim:      true,
    },

    phone: {
      type:    String,
      trim:    true,
      default: null,
    },

    programInterest: {
      type:    String,
      trim:    true,
      default: null,
    },

    // Localisation déclarée par le prospect (spec §4.1 — Pays / Ville)
    city: {
      type:    String,
      trim:    true,
      default: null,
    },

    country: {
      type:    String,
      trim:    true,
      default: null,
    },

    // ── TRACKING SOURCE ───────────────────────────────────────────────────
    source: {
      type:     String,
      enum:     {
        values:  ['qr_code', 'referral_link', 'manual_code', 'direct'],
        message: '{VALUE} is not a valid source',
      },
      required: [true, 'Source is required'],
    },

    // ── PIPELINE STATUT ───────────────────────────────────────────────────
    // isConverted est ABSENT — dérivé de status === 'enrolled'
    status: {
      type:    String,
      enum:    {
        values: [
          'new',
          'contacted',
          'dossier_submitted',
          'admitted',
          'enrolled',
          'rejected',
          'abandoned',
        ],
        message: '{VALUE} is not a valid status',
      },
      default: 'new',
      index:   true,
    },

    statusHistory: {
      type:    [StatusEventSchema],
      default: [],
    },

    // ── UTM & TRACKING ────────────────────────────────────────────────────
    utmParams: {
      type:    UtmParamsSchema,
      default: null,
    },

    // SHA-256 hash uniquement — jamais l'IP brute. Retenu 90 jours (RGPD + Loi n°2010/012).
    ipAddressHash: {
      type:    String,
      default: null,
    },

    // Champ honeypot : true si le bot a rempli le champ caché. Traitement silencieux côté API.
    honeypotTripped: {
      type:    Boolean,
      default: false,
    },

    // ── FRAUD FLAGS ───────────────────────────────────────────────────────
    fraudFlags: {
      type:    [String],
      enum:    ['IP_BURST', 'SELF_REFERRAL', 'DUPLICATE_LEAD', 'MANUAL_REVIEW'],
      default: [],
    },

    // ── LIEN COMMISSION ───────────────────────────────────────────────────
    commissionId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'PartnerCommission',
      default: null,
    },

    // ── NOTES INTERNES (Campus Manager) ──────────────────────────────────
    notes: {
      type:    String,
      trim:    true,
      default: null,
    },

    lastContactedAt: {
      type:    Date,
      default: null,
    },

    // Phase 3 — opt-in alerte nouvelle session
    notifyNextBatch: {
      type:    Boolean,
      default: false,
    },
  },

  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── INDEXES ───────────────────────────────────────────────────────────────────

// Déduplication prospect par campus
partnerLeadSchema.index({ email: 1, schoolCampus: 1 });
partnerLeadSchema.index({ phone: 1, schoolCampus: 1 });

// Requêtes pipeline
partnerLeadSchema.index({ schoolCampus: 1, status: 1, partner: 1 });
partnerLeadSchema.index({ partner: 1, status: 1 });

// Détection IP_BURST
partnerLeadSchema.index({ ipAddressHash: 1, createdAt: 1 });

// ── VIRTUEL ───────────────────────────────────────────────────────────────────

partnerLeadSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ── MODEL ─────────────────────────────────────────────────────────────────────

const PartnerLead = mongoose.model('PartnerLead', partnerLeadSchema);
module.exports = PartnerLead;
