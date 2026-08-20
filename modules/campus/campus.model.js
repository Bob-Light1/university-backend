const mongoose = require('mongoose');
const { SUPPORTED_LANGUAGES } = require('../../shared/i18n/languages');
const { AI_PLANS, AI_PLAN_PRESETS } = require('../../shared/constants/ai.constants');
const {
  FEATURE_PLANS,
  FEATURE_STATES,
  FEATURE_KEYS,
} = require('../../shared/constants/features.constants');
const { notDeletedFilter } = require('../../shared/utils/soft-delete');

/**
 * One per-campus deviation from the plan preset (CAMPUS_ENTITLEMENT_DESIGN.md §3).
 *
 * An ARRAY rather than a Mongoose `Map` on purpose: Map keys forbid the dot,
 * and the feature namespace is `domain.action` (`finance.expenses`) the day a
 * finer granularity is needed. A Map would close that door on day one, and
 * re-opening it would cost a data migration. The cost of the array is nil —
 * ~30 entries at most, flattened once per request by `resolveEntitlement()`
 * and cached behind it.
 *
 * Only the DEVIATIONS live here; everything the plan already grants is derived.
 */
const entitlementOverrideSchema = new mongoose.Schema(
  {
    key: {
      type:     String,
      required: true,
      enum:     FEATURE_KEYS,
    },
    state: {
      type:     String,
      required: true,
      enum:     Object.values(FEATURE_STATES),
    },
    /** End of effect. `null` = permanent. Evaluated at READ time — never a cron (§4.2). */
    until: {
      type:    Date,
      default: null,
    },
    /** Shown to the manager and kept on the audit row — a disappeared button needs a why. */
    reason: {
      type:      String,
      trim:      true,
      maxlength: [300, 'Reason must not exceed 300 characters'],
      default:   '',
    },
    /** Which of the two layers posted it: the offer (ADMIN) or the usage (CAMPUS_MANAGER), §5. */
    setBy: {
      type:     String,
      required: true,
      enum:     ['admin', 'campus'],
    },
    setAt:   { type: Date, default: Date.now },
    setById: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

/**
 * The single entitlement object (design doc §2.2): everything this campus is
 * entitled to — tier, module deviations, quotas, AI specifics.
 *
 * NO DEFAULT, deliberately. An absent object means "campus predating the
 * system" and resolves to everything ENABLED (fail-open, §4.3). Giving it a
 * default would switch every campus to the `free` tier the moment this schema
 * ships, silently hiding paid modules on live tenants.
 *
 * `features` (quotas) and `aiEntitlement` below stay in place until the
 * migration is validated in production (§3.2) — removal is a later, separate,
 * reversible step.
 */
const entitlementSchema = new mongoose.Schema(
  {
    plan: {
      type: String,
      enum: Object.values(FEATURE_PLANS),
    },
    modules: {
      type:    [entitlementOverrideSchema],
      default: [],
    },
    quotas: {
      maxStudents:          { type: Number, min: [1, 'maxStudents must be at least 1'] },
      maxTeachers:          { type: Number, min: [1, 'maxTeachers must be at least 1'] },
      maxClasses:           { type: Number, min: [1, 'maxClasses must be at least 1'] },
      maxDocumentStorageMB: { type: Number, min: [100, 'Storage quota must be at least 100 MB'] },
      /** 0 = unlimited, same convention as aiEntitlement.monthlyTokenBudget. */
      aiMonthlyTokens:      { type: Number, min: [0, 'aiMonthlyTokens cannot be negative'] },
    },
    /**
     * What stays genuinely AI-specific once the module joins the grid (phase 2).
     * The tier lives in `plan` and the budget in `quotas.aiMonthlyTokens` — one
     * grid, one budget list; only these two have no equivalent elsewhere.
     *
     * `features` holds the DEVIATIONS from `AI_PLAN_PRESETS[plan].features`,
     * never the full set (§3): a campus whose AI matches its tier stores
     * nothing and follows the grid when the tier changes, instead of dragging a
     * frozen copy of the old one behind it. No defaults, for the same reason —
     * an absent flag means "whatever the plan grants", not `false`.
     */
    ai: {
      llmProfile: { type: String, trim: true, maxlength: 50 },
      features: {
        chat:      { type: Boolean },
        search:    { type: Boolean },
        analytics: { type: Boolean },
        advisors:  { type: Boolean },
      },
    },
  },
  { _id: false }
);

/**
 * Campus Model
 * Represents a school campus in the multi-tenant system
 * Each campus is isolated and managed independently
 */
const campusSchema = new mongoose.Schema(
  {
    campus_name: {
      type: String,
      required: [true, 'Campus name is required'],
      trim: true,
      minlength: [3, 'Campus name must be at least 3 characters'],
      maxlength: [100, 'Campus name must not exceed 100 characters']
    },

    campus_number: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // Allows null values while maintaining uniqueness
      match: [/^[A-Z0-9-]+$/, 'Campus number must contain only uppercase letters, numbers, and hyphens']
    },

    manager_name: {
      type: String,
      required: [true, 'Manager name is required'],
      trim: true,
      minlength: [3, 'Manager name must be at least 3 characters'],
      maxlength: [100, 'Manager name must not exceed 100 characters']
    },

    manager_phone: {
      type: String,
      required: [true, 'Manager phone is required'],
      trim: true,
      match: [/^\+?[0-9\s()-]{6,20}$/, 'Invalid phone number format']
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      // Campus login is performed by email — it must be globally unique and
      // indexed, otherwise concurrent creations can register duplicates and
      // every login performs a full-collection scan.
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        'Please enter a valid email address'
      ]
    },

    campus_image: {
      type: String,
      default: null
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false // Never include password in queries by default
    },

    location: {
      address: {
        type: String,
        trim: true,
        default: ''
      },
      city: {
        type: String,
        trim: true,
        default: ''
      },
      country: {
        type: String,
        default: 'Cameroon',
        trim: true
      },
      coordinates: {
        lat: { 
          type: Number,
          min: [-90, 'Latitude must be between -90 and 90'],
          max: [90, 'Latitude must be between -90 and 90']
        },
        lng: { 
          type: Number,
          min: [-180, 'Longitude must be between -180 and 180'],
          max: [180, 'Longitude must be between -180 and 180']
        }
      }
    },

    status: {
      type: String,
      enum: {
        values: ['active', 'inactive', 'archived'],
        message: '{VALUE} is not a valid status'
      },
      default: 'active'
    },

    // Metadata
    lastLogin: {
      type: Date,
      default: null
    },

    // Commission config for the partner module
    commissionConfig: {
      ruleType: {
        type:   String,
        enum:   ['FIXED', 'PERCENTAGE'],
        default: null,
      },
      fixedAmount: {
        type:    Number,
        default: null,
        min:     0,
      },
      percentage: {
        type:    Number,
        default: null,
        min:     0,
        max:     100,
      },
      defaultCurrency: {
        type:    String,
        default: 'XAF',
        trim:    true,
      },
      updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'Campus',
        default: null,
      },
      updatedAt: {
        type:    Date,
        default: null,
      },
    },

    // Public portal — stable URL slug, e.g. 'douala-principal'
    campusSlug: {
      type:      String,
      trim:      true,
      lowercase: true,
      unique:    true,
      sparse:    true,
      match:     [/^[a-z0-9-]+$/, 'campusSlug must contain only lowercase letters, numbers, and hyphens'],
      default:   null,
    },

    // Formations offered at this campus — used in pre-registration form dropdown
    programs: {
      type:    [String],
      default: [],
    },

    // Next cohort start date — displayed on portal
    nextBatchDate: {
      type:    Date,
      default: null,
    },

    // Public credibility counters — displayed on the portal home page (spec §4.6).
    // Administered from the ERP; null values let the portal hide the counter.
    portalStats: {
      studentsTrained: {
        type:    Number,
        default: null,
        min:     [0, 'studentsTrained cannot be negative'],
      },
      placementRate: {
        type:    Number,
        default: null,
        min:     [0, 'placementRate cannot be negative'],
        max:     [100, 'placementRate is a percentage (0-100)'],
      },
      partnerCompanies: {
        type:    Number,
        default: null,
        min:     [0, 'partnerCompanies cannot be negative'],
      },
    },

    // i18n defaults — Directors set these in Campus Settings
    defaultLanguage: {
      type: String,
      enum: SUPPORTED_LANGUAGES,
      default: 'en',
    },
    defaultTimezone: {
      type: String,
      default: 'UTC',
    },
    defaultGradeFormat: {
      type: String,
      enum: ['FRACTION', 'PERCENT', 'LETTER', 'GPA'],
      default: 'FRACTION',
    },

    // AI "Premium" entitlement — per-tenant activation of the Phase 3 AI module
    // (PHASE3_AI_DESIGN.md §11.3). Enforced by modules/ai middleware; the
    // { plan, llmProfile } pair travels in the S2S JWT, never in a request body.
    aiEntitlement: {
      enabled: {
        type:    Boolean,
        default: false,
      },
      plan: {
        type:    String,
        enum:    Object.values(AI_PLANS),
        default: AI_PLANS.FREE,
      },
      // Named LLM provider profile resolved by ai-service (ADR-5, §6.4bis).
      // Free-form on purpose: profiles are declared in ai-service env only.
      llmProfile: {
        type:    String,
        trim:    true,
        default: 'free',
      },
      // 0 = unlimited (ADMIN only, §11.3).
      monthlyTokenBudget: {
        type:    Number,
        default: AI_PLAN_PRESETS[AI_PLANS.FREE].monthlyTokenBudget,
        min:     [0, 'monthlyTokenBudget cannot be negative'],
      },
      features: {
        chat:      { type: Boolean, default: true },
        search:    { type: Boolean, default: true },
        analytics: { type: Boolean, default: false },
        advisors:  { type: Boolean, default: false },
      },
      activatedAt: {
        type:    Date,
        default: null,
      },
    },

    // Append-only audit trail of aiEntitlement mutations (CLAUDE.md §8).
    // Excluded from standard reads; the admin endpoint selects it explicitly.
    aiEntitlementAudit: {
      type: [
        new mongoose.Schema(
          {
            at:        { type: Date, default: Date.now },
            actorId:   { type: mongoose.Schema.Types.ObjectId, required: true },
            actorRole: { type: String, required: true },
            changes:   { type: Object, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
      select:  false,
    },

    // Unified per-campus entitlement (CAMPUS_ENTITLEMENT_DESIGN.md). Absent =
    // everything enabled; `scripts/migrate-entitlement.js` folds `features` and
    // `aiEntitlement` into it without changing what any campus can reach.
    entitlement: {
      type:    entitlementSchema,
      default: undefined,
    },

    // Append-only audit trail of entitlement mutations (CLAUDE.md §8), same
    // shape as aiEntitlementAudit with a widened scope. Hiding a module is the
    // kind of change a support ticket starts with ("the button disappeared"),
    // so who / when / why is not optional.
    entitlementAudit: {
      type: [
        new mongoose.Schema(
          {
            at:        { type: Date, default: Date.now },
            actorId:   { type: mongoose.Schema.Types.ObjectId, required: true },
            actorRole: { type: String, required: true },
            changes:   { type: Object, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
      select:  false,
    },

    // Features configuration (for premium features)
    features: {
      maxStudents: {
        type: Number,
        default: 1000,
        min: [1, 'Max students must be at least 1']
      },
      maxTeachers: {
        type: Number,
        default: 100,
        min: [1, 'Max teachers must be at least 1']
      },
      maxClasses: {
        type: Number,
        default: 50,
        min: [1, 'Max classes must be at least 1']
      },
      maxDocumentStorageMB: {
        type:    Number,
        default: 5120,      
        min:     [100, 'Storage quota must be at least 100 MB'],
        max:     [102400, 'Storage quota cannot exceed 100 GB'],
    },
    }
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// **INDEXES FOR PERFORMANCE**
campusSchema.index({ status: 1 });
campusSchema.index({ createdAt: -1 });
// campusSlug uniqueness is declared on the field (unique + sparse) — no duplicate index here.

// **VIRTUAL FIELDS**
// Virtual for full location string
campusSchema.virtual('fullLocation').get(function () {
  const parts = [
    this.location?.address,
    this.location?.city,
    this.location?.country
  ].filter(Boolean);
  
  return parts.join(', ') || 'Location not specified';
});

// **PRE-SAVE MIDDLEWARE**
// Ensure email and campus_number are lowercase
campusSchema.pre('save', function (next) {
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
  if (this.campus_number) {
    this.campus_number = this.campus_number.toUpperCase().trim();
  }
  next();
});

// **METHODS**
// Check if campus has reached capacity limits
campusSchema.methods.canAddStudent = async function () {
  const Student = mongoose.model('Student');
  const currentCount = await Student.countDocuments({
    schoolCampus: this._id,
    ...notDeletedFilter(Student),
  });
  return currentCount < this.features.maxStudents;
};

campusSchema.methods.canAddTeacher = async function () {
  const Teacher = mongoose.model('Teacher');
  const currentCount = await Teacher.countDocuments({
    schoolCampus: this._id,
    ...notDeletedFilter(Teacher),
  });
  return currentCount < this.features.maxTeachers;
};

campusSchema.methods.canAddClass = async function () {
  const Class = mongoose.model('Class');
  const currentCount = await Class.countDocuments({
    campus: this._id,
    ...notDeletedFilter(Class),
  });
  return currentCount < this.features.maxClasses;
};
campusSchema.methods.canAddDocumentStorage = async function(additionalBytes) {
  const Document = mongoose.model('Document');
  const result = await Document.aggregate([
    {
      $match: {
        campusId: this._id,
        ...notDeletedFilter(Document),
        'importedFile.sizeBytes': { $exists: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$importedFile.sizeBytes' } } }
  ]);
  const usedBytes = result[0]?.total || 0;
  const maxBytes  = (this.features.maxDocumentStorageMB || 5120) * 1024 * 1024;
  
  return (usedBytes + additionalBytes) <= maxBytes;
};

// **STATICS**
// Find active campuses only
campusSchema.statics.findActive = function () {
  return this.find({ status: 'active' });
};

// IMPORTANT: Use 'Campus' (not 'SchoolCampus') for consistency across models
const Campus = mongoose.model('Campus', campusSchema);

module.exports = Campus;