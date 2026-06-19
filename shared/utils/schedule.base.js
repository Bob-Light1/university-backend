'use strict';

/**
 * @file schedule.base.js
 * @description Shared schema definitions, enums, and sub-schemas reused
 *              across studentSchedule and teacherSchedule models.
 *
 *  Aligned with the foruni backend:
 *  ─────────────────────────────────────────────────────────────────────────
 *  • Semester     : 'S1' | 'S2' | 'Annual' (String)
 *  • Participants : Class (ref: 'Class') — no Group concept
 *  • Campus       : schoolCampus (ref: 'Campus') — standard foruni isolation
 *
 *  Architecture decisions (v2):
 *  ─────────────────────────────────────────────────────────────────────────
 *  [A] SESSION_TYPE no longer contains ONLINE.
 *      The modality (on-site / remote) is carried by the `isVirtual` boolean
 *      in the parent schema. This allows an EXAM to be online or in a room
 *      without ambiguity over the pedagogical type.
 *
 *  [B] PostponementRequestSchema.reviewedBy uses a dynamic refPath
 *      (reviewedByModel: 'Teacher' | 'User') because postponements are
 *      approved by ADMIN / CAMPUS_MANAGER, not necessarily by a Teacher.
 *
 *  [C] Start/end times are stored both as ISO Date (for overlap queries on
 *      concrete occurrences) AND as a "minutes since midnight" integer
 *      (startMinutes / endMinutes) for timezone-independent recurrence
 *      calculations.
 *
 *  [Premium A] `color` field (hex string) for frontend color-coding.
 *  [Premium C] `transitionMinutes` field in RoomSchema for the room
 *              changeover time between two sessions.
 *
 *  Capacity note (Premium B): the StudentCount ≤ RoomCapacity validation is
 *  intentionally delegated to the controller (createSession / updateSession)
 *  so it can return a precise HTTP error message and query the Class's
 *  student count in real time.
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────

const SCHEDULE_STATUS = Object.freeze({
  DRAFT:     'DRAFT',
  PUBLISHED: 'PUBLISHED',
  CANCELLED: 'CANCELLED',
  POSTPONED: 'POSTPONED',
});

/**
 * [A] Pedagogical type of the session — ONLINE removed.
 *     The on-site/remote modality is carried by `isVirtual` (Boolean) in the
 *     parent schema, which lets the two axes be orthogonalized:
 *       • pedagogical type : LECTURE, TD, TP, EXAM, WORKSHOP
 *       • modality         : isVirtual true / false
 */
const SESSION_TYPE = Object.freeze({
  LECTURE:   'LECTURE',    // CM – Cours Magistral (lecture)
  TUTORIAL:  'TUTORIAL',   // TD – Travaux Dirigés (tutorial)
  PRACTICAL: 'PRACTICAL',  // TP – Travaux Pratiques (practical)
  EXAM:      'EXAM',
  WORKSHOP:  'WORKSHOP',
});

const RECURRENCE_FREQUENCY = Object.freeze({
  NONE:    'NONE',
  DAILY:   'DAILY',
  WEEKLY:  'WEEKLY',
  MONTHLY: 'MONTHLY',
});

const WEEKDAY = Object.freeze({
  MO: 'MO', TU: 'TU', WE: 'WE',
  TH: 'TH', FR: 'FR', SA: 'SA', SU: 'SU',
});

/**
 * Semester values aligned with studentAttendance.model.js
 */
const SEMESTER = Object.freeze({
  S1:     'S1',
  S2:     'S2',
  ANNUAL: 'Annual',
});

/**
 * [Premium A] Suggested color palette per session type.
 * The frontend can override with any hex value.
 * These constants serve as defaults / UX reference.
 */
const SESSION_COLOR_DEFAULTS = Object.freeze({
  LECTURE:   '#3B82F6', // blue
  TUTORIAL:  '#10B981', // green
  PRACTICAL: '#F59E0B', // orange
  EXAM:      '#EF4444', // red
  WORKSHOP:  '#8B5CF6', // purple
});

// ─────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────

/**
 * RRule-compatible recurrence pattern.
 *
 * [C] byDay + interval/count/until remain unchanged (RRule semantics).
 *     The start/end times of the base occurrence are stored in the parent
 *     schema via startMinutes / endMinutes (see note [C] above).
 */
const RecurrenceSchema = new mongoose.Schema(
  {
    frequency: {
      type:    String,
      enum:    Object.values(RECURRENCE_FREQUENCY),
      default: RECURRENCE_FREQUENCY.NONE,
    },
    /** ['MO', 'WE'] – meaningful for WEEKLY only */
    byDay: [{ type: String, enum: Object.values(WEEKDAY) }],
    /** Number of repetitions (mutually exclusive with until) */
    count:    { type: Number, min: 1, max: 52 },
    /** End date (UTC, mutually exclusive with count) */
    until:    { type: Date },
    /** Interval between occurrences (default 1) */
    interval: { type: Number, default: 1, min: 1 },
    /**
     * Occurrence dates cancelled or replaced by an exception.
     * The frontend expands the RRule and subtracts these dates.
     */
    exceptionDates: [{ type: Date }],
  },
  { _id: false }
);

/**
 * Classroom with equipment metadata.
 * Note: in foruni, rooms are not yet a dedicated model.
 *
 * [Premium C] transitionMinutes: buffer time before the next session in this
 *             room (e.g. 10 min to move the students). Used by the conflict
 *             detector to apply a realistic buffer between two sessions in
 *             the same room.
 */
const RoomSchema = new mongoose.Schema(
  {
    code:      { type: String, required: true },   // e.g. "C-204"
    building:  { type: String },
    capacity:  { type: Number },                   // validated in the controller: StudentCount ≤ capacity
    equipment: [{ type: String }],                 // ['PROJECTOR', 'AC', 'LAB']
    /** Denormalized copy of Campus.campus_name for fast queries */
    campusName:        { type: String },
    /** [Premium C] Minimum duration (in minutes) between two sessions in this room */
    transitionMinutes: { type: Number, default: 10, min: 0 },
  },
  { _id: false }
);

/**
 * Virtual meeting metadata (Zoom / Teams / Meet).
 * Used only if isVirtual === true on the parent document.
 */
const VirtualMeetingSchema = new mongoose.Schema({
  platform:   { type: String, enum: ['ZOOM', 'TEAMS', 'MEET', 'OTHER'] },
  meetingUrl: { type: String },  // ← aligned with frontend + Yup + controller
  meetingId:  { type: String },
  passcode:   { type: String },
}, { _id: false });

/**
 * Reference to a course document (teaching material).
 */
const CourseMaterialSchema = new mongoose.Schema(
  {
    title:      { type: String, required: true },
    url:        { type: String, required: true },
    mimeType:   { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Session postponement / cancellation workflow.
 *
 * [B] reviewedBy uses a dynamic refPath:
 *     • reviewedByModel can be 'Teacher' or 'User' depending on who approved.
 *     • This covers the ADMIN and CAMPUS_MANAGER roles ('users' collection
 *       in foruni) as well as coordinating teachers if needed.
 *     • requestedBy stays ref: 'Teacher' because only a teacher submits
 *       a postponement request.
 */
const PostponementRequestSchema = new mongoose.Schema(
  {
    requestedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
    requestedAt:   { type: Date, default: Date.now },
    reason:        { type: String, required: true },
    proposedStart: { type: Date },
    proposedEnd:   { type: Date },
    status: {
      type:    String,
      enum:    ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
    /**
     * [B] Discriminant for the refPath: 'User' = ADMIN / CAMPUS_MANAGER,
     *     'Teacher' = authorized coordinating teacher.
     *     Defaults to 'User' because it is the most common case.
     */
    reviewedByModel: {
      type:    String,
      enum:    ['Teacher', 'User'],
      default: 'User',
    },
    reviewedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      refPath: 'postponementRequests.reviewedByModel',
    },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
  },
  { _id: true, timestamps: true }
);

// ─────────────────────────────────────────────
// REFERENCE: FIELDS TO ADD IN THE PARENT SCHEMAS
// ─────────────────────────────────────────────

/**
 * These fields must be present in every parent schema
 * (StudentSchedule, TeacherSchedule) that extends schedule.base.
 *
 * [A]  isVirtual : Boolean, default false
 *          → true  = online session (VirtualMeetingSchema required)
 *          → false = on-site session (RoomSchema required)
 *
 * [C]  startMinutes : Number (0–1439)   e.g. 480  for 08:00
 *      endMinutes   : Number (0–1439)   e.g. 600  for 10:00
 *          → recurrence calculations without TZ dependency
 *          → startTime / endTime (ISO Date) remain for overlap queries
 *            on concrete occurrences
 *
 * [Premium A]  color : String (hex, e.g. '#EF4444')
 *          → recommended default value: SESSION_COLOR_DEFAULTS[sessionType]
 *
 * Integration example:
 * ──────────────────────
 *   sessionType  : { type: String, enum: Object.values(SESSION_TYPE), required: true },
 *   isVirtual    : { type: Boolean, default: false },
 *   startTime    : { type: Date, required: true },
 *   endTime      : { type: Date, required: true },
 *   startMinutes : { type: Number, min: 0, max: 1439 },
 *   endMinutes   : { type: Number, min: 0, max: 1439 },
 *   color        : { type: String, match: /^#[0-9A-Fa-f]{6}$/ },
 *   room         : RoomSchema,            // if isVirtual === false
 *   virtualMeeting: VirtualMeetingSchema, // if isVirtual === true
 */

// ─────────────────────────────────────────────
// CONFLICT DETECTION UTILITIES
// ─────────────────────────────────────────────

/**
 * Checks whether [startA, endA[ overlaps [startB, endB[.
 * Works with Date objects or integers (minutes since midnight).
 *
 * @param {Date|number} startA
 * @param {Date|number} endA
 * @param {Date|number} startB
 * @param {Date|number} endB
 * @returns {boolean}
 */
const timeRangesOverlap = (startA, endA, startB, endB) =>
  startA < endB && endA > startB;

/**
 * [Premium C] Checks whether two sessions in the SAME room fail to respect
 * the minimum transition time defined by RoomSchema.transitionMinutes.
 *
 * @param {Date|number} endA          - End of session A
 * @param {Date|number} startB        - Start of session B (the later one)
 * @param {number}      transitionMin - the room's transitionMinutes (default 10)
 * @returns {boolean} true = conflict (not enough time between the two)
 */
const hasRoomTransitionConflict = (endA, startB, transitionMin = 10) => {
  const toMs = (v) => (v instanceof Date ? v.getTime() : v * 60000);
  return (toMs(startB) - toMs(endA)) < transitionMin * 60000;
};

/**
 * [C] Converts an "HH:mm" time into minutes since midnight.
 * @param {string} hhmm  e.g. "08:30"
 * @returns {number}     e.g. 510
 */
const hhmmToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * [C] Converts a "minutes since midnight" integer into an "HH:mm" string.
 * @param {number} minutes  e.g. 510
 * @returns {string}        e.g. "08:30"
 */
const minutesToHhmm = (minutes) => {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  // Enums
  SCHEDULE_STATUS,
  SESSION_TYPE,
  SESSION_COLOR_DEFAULTS,
  RECURRENCE_FREQUENCY,
  WEEKDAY,
  SEMESTER,

  // Sub-schemas
  RecurrenceSchema,
  RoomSchema,
  VirtualMeetingSchema,
  CourseMaterialSchema,
  PostponementRequestSchema,

  // Utilities
  timeRangesOverlap,
  hasRoomTransitionConflict,
  hhmmToMinutes,
  minutesToHhmm,
};