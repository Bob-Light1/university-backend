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

const Student      = require('../../modules/student/models/student.model');
const Teacher      = require('../../modules/teacher/models/teacher.model');
const { Result }   = require('../../modules/result/models/result.model'); // exported in an object
const Document     = require('../../modules/document/models/document.model');
const Notification = require('../../modules/notification/models/notification.model');

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
