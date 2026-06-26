'use strict';

/**
 * @file partner.model.js
 * @description Partner model — institutional and commercial affiliate partners.
 *
 * Campus isolation invariant: schoolCampus toujours obligatoire.
 * partnerCode: slug globally unique, auto-généré server-side sur création.
 * password: bcrypt 12 rounds, select:false.
 * Counters dénormalisés (totalLeads, etc.) : SUPPRIMÉS — calculés à la volée.
 */

const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const SALT_ROUNDS = 12;

// ── SUB-SCHEMAS ───────────────────────────────────────────────────────────────

const ContactSchema = new mongoose.Schema(
  {
    name:  { type: String, trim: true, default: null },
    role:  { type: String, trim: true, default: null },
    email: { type: String, trim: true, lowercase: true, default: null },
    phone: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const ConventionSchema = new mongoose.Schema(
  {
    startDate: { type: Date, default: null },
    endDate:   { type: Date, default: null },
    // Commercial terms of the partnership agreement (set via the manager form).
    commissionType: {
      type:    String,
      enum:    { values: ['FIXED', 'PERCENTAGE'], message: '{VALUE} is not a valid commission type' },
      default: null,
    },
    commissionValue: { type: Number, min: 0, default: null },
    currency:  { type: String, trim: true, uppercase: true, default: 'XAF' },
    status:    {
      type:    String,
      enum:    ['draft', 'active', 'expired', 'terminated'],
      default: 'draft',
    },
    notes:       { type: String, trim: true, default: null },
    documentUrl: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const CommissionConfigSchema = new mongoose.Schema(
  {
    ruleType:    { type: String, enum: ['FIXED', 'PERCENTAGE'], default: null },
    fixedAmount: { type: Number, min: 0, default: null },
    percentage:  { type: Number, min: 0, max: 100, default: null },
    currency:    { type: String, trim: true, uppercase: true, default: 'XAF' },
    validFrom:   { type: Date, default: null },
    validTo:     { type: Date, default: null },
  },
  { _id: false }
);

const SocialLinksSchema = new mongoose.Schema(
  {
    website:   { type: String, trim: true, default: null },
    linkedin:  { type: String, trim: true, default: null },
    instagram: { type: String, trim: true, default: null },
    facebook:  { type: String, trim: true, default: null },
    tiktok:    { type: String, trim: true, default: null },
    whatsapp:  { type: String, trim: true, default: null },
  },
  { _id: false }
);

// ── MAIN SCHEMA ───────────────────────────────────────────────────────────────

const partnerSchema = new mongoose.Schema(
  {
    // ── CAMPUS ISOLATION ──────────────────────────────────────────────────
    schoolCampus: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Campus',
      required: [true, 'Campus is required'],
      index:    true,
    },

    // ── IDENTITY ──────────────────────────────────────────────────────────
    firstName: {
      type:      String,
      required:  [true, 'First name is required'],
      trim:      true,
      minlength: [2,  'First name must be at least 2 characters'],
      maxlength: [50, 'First name must not exceed 50 characters'],
    },

    lastName: {
      type:      String,
      required:  [true, 'Last name is required'],
      trim:      true,
      minlength: [2,  'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must not exceed 50 characters'],
    },

    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address',
      ],
    },

    phone: {
      type:  String,
      trim:  true,
      default: null,
    },

    gender: {
      type: String,
      enum: { values: ['male', 'female', 'other'], message: '{VALUE} is not a valid gender' },
      default: null,
    },

    organization: {
      type:      String,
      trim:      true,
      maxlength: [200, 'Organization name must not exceed 200 characters'],
      default:   null,
    },

    bio: {
      type:      String,
      trim:      true,
      maxlength: [500, 'Bio must not exceed 500 characters'],
      default:   null,
    },

    profileImage: {
      type:    String,
      default: null,
    },

    // ── AUTHENTICATION ────────────────────────────────────────────────────
    password: {
      type:      String,
      required:  [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:    false,
    },

    // ── TYPAGE ───────────────────────────────────────────────────────────
    partnerType: {
      type:     String,
      enum:     {
        values:  ['institutional', 'commercial'],
        message: '{VALUE} is not a valid partner type',
      },
      required: [true, 'Partner type is required'],
      index:    true,
    },

    institutionType: {
      type:    String,
      enum:    {
        values:  ['company', 'ngo', 'university', 'public', 'foundation'],
        message: '{VALUE} is not a valid institution type',
      },
      default: null,
    },

    commercialType: {
      type:    String,
      enum:    {
        values:  ['influencer', 'church_leader', 'student_leader', 'teacher', 'parent', 'other'],
        message: '{VALUE} is not a valid commercial type',
      },
      default: null,
    },

    channelType: {
      type:    String,
      enum:    {
        values:  ['online', 'offline', 'hybrid'],
        message: '{VALUE} is not a valid channel type',
      },
      default: null,
    },

    tier: {
      type:    String,
      enum:    {
        values:  ['bronze', 'silver', 'gold', 'platinum'],
        message: '{VALUE} is not a valid tier',
      },
      default: 'bronze',
      index:   true,
    },

    // ── STATUT ───────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    {
        values:  ['active', 'inactive', 'suspended', 'archived'],
        message: '{VALUE} is not a valid status',
      },
      default: 'active',
      index:   true,
    },

    // ── AFFILIATE REFERENCING ─────────────────────────────────────────────
    partnerCode: {
      type:      String,
      trim:      true,
      uppercase: true,
      maxlength: [16, 'Partner code must not exceed 16 characters'],
      default:   null,
      // index declared below via partnerSchema.index({ partnerCode: 1 }, { unique: true, sparse: true })
    },

    referralLink: {
      type:    String,
      default: null,
    },

    qrCodeFileName: {
      type:    String,
      default: null,
    },

    // ── ADDITIONAL CONTACTS (institutional) ───────────────────────────────
    contacts: {
      type:     [ContactSchema],
      default:  [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length <= 10,
        message:   'A partner cannot have more than 10 contacts.',
      },
    },

    // ── CONVENTION (institutional) ────────────────────────────────────────
    convention: {
      type:    ConventionSchema,
      default: null,
    },

    // ── COMMISSION (override par-partner) ────────────────────────────────
    commissionConfig: {
      type:    CommissionConfigSchema,
      default: null,
    },

    // ── SOCIAL NETWORKS ───────────────────────────────────────────────────
    socialLinks: {
      type:    SocialLinksSchema,
      default: null,
    },

    // ── METADATA ──────────────────────────────────────────────────────────
    lastLoginAt:    { type: Date, default: null },
    lastActivityAt: { type: Date, default: null },

    createdBy: {
      type:    String,
      default: null,
    },
  },

  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── COMPOUND INDEXES ──────────────────────────────────────────────────────────

partnerSchema.index({ partnerCode: 1 }, { unique: true, sparse: true });
partnerSchema.index({ schoolCampus: 1, status: 1 });
partnerSchema.index({ schoolCampus: 1, partnerType: 1 });
partnerSchema.index({ schoolCampus: 1, tier: 1 });
partnerSchema.index({ schoolCampus: 1, firstName: 1, lastName: 1 });

// ── VIRTUEL ───────────────────────────────────────────────────────────────────

partnerSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ── PRE-SAVE ──────────────────────────────────────────────────────────────────

partnerSchema.pre('save', async function (next) {
  try {
    if (this.email) this.email = this.email.toLowerCase().trim();

    if (this.isModified('password')) {
      const salt    = await bcrypt.genSalt(SALT_ROUNDS);
      this.password = await bcrypt.hash(this.password, salt);
    }

    next();
  } catch (err) {
    next(err);
  }
});

// ── INSTANCE METHODS ──────────────────────────────────────────────────────────

partnerSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

partnerSchema.methods.canLogin = function () {
  return this.status === 'active';
};

// ── STATIC METHODS ────────────────────────────────────────────────────────────

/**
 * Génère un partnerCode unique selon le format {PREFIX}-{CC}-{YY}.
 * PREFIX = 4 premiers chars slug-safe du lastName (padded avec firstName si court).
 * Vérifie l'unicité en DB ; ajoute un suffixe -01/-02… en cas de collision.
 * Max 16 chars. Stocké en majuscules, NFD-normalisé.
 */
partnerSchema.statics.generatePartnerCode = async function (lastName, firstName, country, year) {
  const cc  = (country || 'CMR').toUpperCase().slice(0, 3);
  const yy  = String(year || new Date().getFullYear()).slice(-2);

  const slugify = (str) =>
    str
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z]/g, '')
      .toUpperCase();

  let prefix = slugify(lastName);
  if (prefix.length < 4) {
    prefix = (prefix + slugify(firstName)).slice(0, 4);
  } else {
    prefix = prefix.slice(0, 4);
  }

  const base = `${prefix}-${cc}-${yy}`;

  const exists = await this.findOne({ partnerCode: base }).lean();
  if (!exists) return base;

  for (let i = 1; i <= 99; i++) {
    const candidate = `${base}-${String(i).padStart(2, '0')}`;
    if (candidate.length > 16) break;
    const taken = await this.findOne({ partnerCode: candidate }).lean();
    if (!taken) return candidate;
  }

  throw new Error('Unable to generate a unique partnerCode — too many collisions.');
};

// ── MODEL ─────────────────────────────────────────────────────────────────────

const Partner = mongoose.model('Partner', partnerSchema);
module.exports = Partner;
