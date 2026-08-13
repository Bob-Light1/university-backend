'use strict';

/**
 * shared/utils/soft-delete — the three soft-delete conventions (CLAUDE.md §5).
 *
 * These tests run against the REAL models on purpose. They are not testing the helper in
 * isolation — they PIN the conventions each family of models actually follows. If someone
 * changes a model's deletion marker, this file fails and tells them which queries they
 * have just silently broken.
 */

const {
  notDeletedFilter,
  deletedOnlyFilter,
  softDeletePatch,
  isSoftDeletable,
} = require('../../shared/utils/soft-delete');

const mongoose = require('mongoose');

const Student      = require('../../modules/student/models/student.model');
const Teacher      = require('../../modules/teacher/models/teacher.model');
const { Result }   = require('../../modules/result/models/result.model'); // exported in an object
const Document     = require('../../modules/document/models/document.model');
const Notification = require('../../modules/notification/models/notification.model');
const Announcement = require('../../modules/announcement/models/announcement.model');
const { Course }   = require('../../modules/course/course.model'); // exported in an object

describe('soft-delete — convention detection', () => {
  describe('actor / configuration models → status enum', () => {
    it('filters Student on status, not on isDeleted', () => {
      expect(notDeletedFilter(Student)).toEqual({ status: { $ne: 'archived' } });
    });

    it('filters Teacher the same way', () => {
      expect(notDeletedFilter(Teacher)).toEqual({ status: { $ne: 'archived' } });
    });

    it('Student has NO isDeleted field — the trap this helper exists to prevent', () => {
      // A hand-written `{ isDeleted: false }` here would match zero documents, silently.
      expect(Student.schema.path('isDeleted')).toBeUndefined();
    });
  });

  describe('record models → isDeleted boolean', () => {
    it('filters Result on isDeleted', () => {
      expect(notDeletedFilter(Result)).toEqual({ isDeleted: false });
    });

    it("does NOT mistake Result's uppercase ARCHIVED workflow status for a deletion", () => {
      // Result carries BOTH isDeleted AND a status enum containing 'ARCHIVED'. That status is a
      // publication state — an archived result is live. Precedence must pick isDeleted.
      expect(Result.schema.path('status').enumValues).toContain('ARCHIVED');
      expect(notDeletedFilter(Result)).not.toHaveProperty('status');
    });
  });

  describe('Document (GED) → deletedAt timestamp', () => {
    it('filters Document on deletedAt', () => {
      expect(notDeletedFilter(Document)).toEqual({ deletedAt: null });
    });

    it("does NOT mistake Document's workflow status for a deletion", () => {
      // Soft-deleted documents keep status PUBLISHED (document.service.js:42).
      expect(notDeletedFilter(Document)).not.toHaveProperty('status');
    });
  });

  describe('ambiguous schemas → declared, never guessed', () => {
    /**
     * Announcement and Course both carry a lowercase 'archived' status enum AND a `deletedAt`
     * field, and they mean the OPPOSITE things. Inferring from the schema gets one of them
     * wrong every time, so the answer is declared in STRATEGY_OVERRIDES and pinned here.
     */
    it("reads Announcement on deletedAt — 'archived' is its expiry state, not a deletion", () => {
      // The nightly expiry cron writes status:'archived' on live announcements
      // (announcement.repository.js), while deleteAnnouncement writes deletedAt.
      expect(Announcement.schema.path('status').enumValues).toContain('archived');
      expect(notDeletedFilter(Announcement)).toEqual({ deletedAt: null });
      expect(deletedOnlyFilter(Announcement)).toEqual({ deletedAt: { $ne: null } });
      expect(softDeletePatch(Announcement, { at: new Date(0) })).toEqual({ deletedAt: new Date(0) });
    });

    it('reads Course on status — archiveCourse writes both markers together', () => {
      expect(Course.schema.path('deletedAt')).toBeDefined();
      expect(notDeletedFilter(Course)).toEqual({ status: { $ne: 'archived' } });
    });

    it('throws on an undeclared model carrying both markers rather than picking one', () => {
      const schema = new mongoose.Schema({
        status:    { type: String, enum: ['active', 'archived'] },
        deletedAt: { type: Date, default: null },
      });
      const Ambiguous = mongoose.models.__SoftDeleteAmbiguous__
        || mongoose.model('__SoftDeleteAmbiguous__', schema);

      expect(() => notDeletedFilter(Ambiguous)).toThrow(/cannot be inferred/);
      expect(() => notDeletedFilter(Ambiguous)).toThrow(/STRATEGY_OVERRIDES/);
    });
  });

  describe('models with no deletion marker → throw, never {}', () => {
    it('throws for Notification rather than returning an empty filter', () => {
      // An empty filter would silently INCLUDE deleted documents. Fail closed.
      expect(() => notDeletedFilter(Notification)).toThrow(/no soft-delete convention/);
    });

    it('names the model and points at the convention doc', () => {
      expect(() => notDeletedFilter(Notification)).toThrow(/'Notification'/);
      expect(() => notDeletedFilter(Notification)).toThrow(/CLAUDE\.md §5/);
    });

    it('isSoftDeletable discriminates without throwing', () => {
      expect(isSoftDeletable(Student)).toBe(true);
      expect(isSoftDeletable(Result)).toBe(true);
      expect(isSoftDeletable(Document)).toBe(true);
      expect(isSoftDeletable(Notification)).toBe(false);
    });
  });
});

describe('soft-delete — complement and write side', () => {
  it('deletedOnlyFilter is the exact complement of notDeletedFilter', () => {
    expect(deletedOnlyFilter(Student)).toEqual({ status: 'archived' });
    expect(deletedOnlyFilter(Result)).toEqual({ isDeleted: true });
    expect(deletedOnlyFilter(Document)).toEqual({ deletedAt: { $ne: null } });
  });

  it('softDeletePatch marks a deletion the way each model reads it back', () => {
    const at = new Date('2026-07-13T10:00:00Z');

    expect(softDeletePatch(Student, { at })).toEqual({ status: 'archived' });
    expect(softDeletePatch(Document, { at })).toEqual({ deletedAt: at });

    // Record models carry both markers: the boolean is what queries read, the timestamp is
    // what the retention crons read. Both must be written.
    expect(softDeletePatch(Result, { at })).toEqual({ isDeleted: true, deletedAt: at });
  });

  it('a patch written by softDeletePatch is found by deletedOnlyFilter, per model', () => {
    // The round-trip property that makes the two helpers safe to mix.
    for (const Model of [Student, Result, Document]) {
      const patch = softDeletePatch(Model);
      const only  = deletedOnlyFilter(Model);
      const [field] = Object.keys(only);

      expect(patch).toHaveProperty(field);
    }
  });

  it('throws on the write side too, for a model with no marker', () => {
    expect(() => softDeletePatch(Notification)).toThrow(/no soft-delete convention/);
  });
});
