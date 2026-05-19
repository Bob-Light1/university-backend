'use strict';

/**
 * @file partnerCommission.model.js
 * @description Commissions dues aux partenaires suite à la conversion d'un lead.
 *
 * Invariants :
 * • Un lead → au plus une commission (index unique sur lead).
 * • Auto-validation P3 uniquement. En P2, TOUTE commission requiert validation humaine.
 * • paymentChannel obligatoire au moment du paiement.
 * • ruleSnapshot : copie immuable de la règle au moment du calcul — ne pas modifier.
 * • fraudFlags : ['IP_BURST','SELF_REFERRAL','MANUAL_REVIEW'] — revus avant validation.
 */

const mongoose = require('mongoose');

// ── SUB-SCHEMA ────────────────────────────────────────────────────────────────

const RuleSnapshotSchema = new mongoose.Schema(
  {
    ruleType:    { type: String, enum: ['FIXED', 'PERCENTAGE'], required: true },
    fixedAmount: { type: Number, default: null },
    percentage:  { type: Number, default: null },
    currency:    { type: String, uppercase: true, default: 'XAF' },
    tier:        { type: String, default: null },
  },
  { _id: false }
);

// ── MAIN SCHEMA ───────────────────────────────────────────────────────────────

const partnerCommissionSchema = new mongoose.Schema(
  {
    // ── CAMPUS ISOLATION ──────────────────────────────────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── RÉFÉRENCES ────────────────────────────────────────────────────────
    partner: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Partner',
      required: [true, 'Partner is required'],
    },

    // Un lead → au plus une commission (enforced via unique index)
    lead: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'PartnerLead',
      required: [true, 'Lead is required'],
    },

    // ── MONTANT ───────────────────────────────────────────────────────────
    amount: {
      type:     Number,
      required: [true, 'Commission amount is required'],
      min:      [0, 'Amount must be positive'],
    },

    currency: {
      type:      String,
      required:  [true, 'Currency is required'],
      uppercase: true,
      trim:      true,
      default:   'XAF',
    },

    // Copie immuable de la règle au moment du calcul
    ruleSnapshot: {
      type:     RuleSnapshotSchema,
      required: [true, 'Rule snapshot is required'],
    },

    // ── STATUT ───────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    {
        values:  ['pending', 'validated', 'paid', 'disputed', 'cancelled'],
        message: '{VALUE} is not a valid commission status',
      },
      default: 'pending',
      index:   true,
    },

    // ── PAIEMENT ─────────────────────────────────────────────────────────
    paymentChannel: {
      type:    String,
      enum:    {
        values:  ['momo_mtn', 'momo_orange', 'bank_transfer', 'cash', 'other'],
        message: '{VALUE} is not a valid payment channel',
      },
      default: null,
    },

    paymentRef: {
      type:    String,
      trim:    true,
      default: null,
    },

    paidAt: {
      type:    Date,
      default: null,
    },

    // ── VALIDATION HUMAINE ────────────────────────────────────────────────
    // Auto-validation P3 uniquement — en P2 validation explicite obligatoire
    validatedBy: {
      type:    String,
      default: null,
    },

    validatedAt: {
      type:    Date,
      default: null,
    },

    // ── PAIEMENT (traçabilité) ────────────────────────────────────────────
    paidBy: {
      type:    String,
      default: null,
    },

    // ── ANNULATION ────────────────────────────────────────────────────────
    cancelledBy: {
      type:    String,
      default: null,
    },

    cancelledAt: {
      type:    Date,
      default: null,
    },

    cancellationReason: {
      type:    String,
      trim:    true,
      default: null,
    },

    // ── ANTI-FRAUDE ───────────────────────────────────────────────────────
    fraudFlags: {
      type:    [String],
      enum:    ['IP_BURST', 'SELF_REFERRAL', 'MANUAL_REVIEW'],
      default: [],
    },

    // ── NOTES ────────────────────────────────────────────────────────────
    notes: {
      type:    String,
      trim:    true,
      default: null,
    },
  },

  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── INDEXES ───────────────────────────────────────────────────────────────────

// Un lead → une seule commission maximum
partnerCommissionSchema.index({ lead: 1 }, { unique: true });

// Requêtes par partenaire et campus
partnerCommissionSchema.index({ partner: 1, status: 1 });
partnerCommissionSchema.index({ schoolCampus: 1, status: 1 });
partnerCommissionSchema.index({ status: 1, createdAt: -1 });

// ── MODEL ─────────────────────────────────────────────────────────────────────

const PartnerCommission = mongoose.model('PartnerCommission', partnerCommissionSchema);
module.exports = PartnerCommission;
