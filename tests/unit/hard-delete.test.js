'use strict';

/**
 * shared/lib/hard-delete — the harmonized permanent-deletion system (CLAUDE.md §5.2).
 *
 * Like tests/unit/soft-delete.test.js, this suite runs against the REAL models and the REAL
 * registry on purpose. It does not test the helpers in isolation — it PINS the guarantees a
 * permanent deletion is supposed to give:
 *
 *   - every declared relation resolves to a model and to a field that actually exists,
 *     so a cascade can never silently match nothing (or, worse, match everything);
 *   - the four confirmation controls each fail closed;
 *   - a ticket cannot be replayed for another actor, another entity, or a database state
 *     that changed after the operator reviewed the impact report.
 *
 * A registry entry that drifts from its schema fails here rather than in production.
 */

const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  REGISTRY,
  getEntry,
  listEntries,
  resolveRelationModel,
} = require('../../shared/lib/hard-delete/hard-delete.registry');

const {
  digestImpact,
  issueTicket,
  verifyTicket,
  verifyConfirmationPhrase,
  verifyReason,
  resolveActorModel,
} = require('../../shared/lib/hard-delete/hard-delete.guard');

const {
  RELATION_MODE,
  DELETION_OUTCOME,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  IMPACT_COUNT_LIMIT,
  MAX_CASCADE_DOCUMENTS,
  AUDIT_FIELD_LIMITS,
  buildConfirmationPhrase,
  truncateForAudit,
  DANGER_ZONE_ROLES,
} = require('../../shared/lib/hard-delete/hard-delete.constants');

const { cascadeVolumeOf } = require('../../shared/lib/hard-delete/hard-delete.service');

const { isSoftDeletable } = require('../../shared/utils/soft-delete');
const DeletionAudit = require('../../shared/lib/hard-delete/deletion-audit.model');

const oid = () => new mongoose.Types.ObjectId();

/**
 * Flattens a relation filter into the schema paths it actually constrains, descending into the
 * logical operators a RETAIN relation uses to cover several provenance fields at once.
 *
 * @param {Object} filter
 * @returns {string[]}
 */
const filterPaths = (filter) =>
  Object.entries(filter).flatMap(([key, value]) =>
    key.startsWith('$')
      ? (Array.isArray(value) ? value.flatMap(filterPaths) : [])
      : [key],
  );

// ── Registry integrity ────────────────────────────────────────────────────────

describe('hard-delete registry — every entry matches the real schemas', () => {
  const entries = Object.entries(REGISTRY);

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  describe.each(entries)('%s', (key, entry) => {
    it('resolves to a real Mongoose model', () => {
      expect(entry.model().modelName).toEqual(expect.any(String));
    });

    it('declares at least one role, all of which can reach the danger-zone router', () => {
      expect(entry.roles.length).toBeGreaterThan(0);
      entry.roles.forEach((role) => expect(DANGER_ZONE_ROLES).toContain(role));
    });

    it('exposes callable identifier and display accessors', () => {
      expect(typeof entry.identifier).toBe('function');
      expect(typeof entry.display).toBe('function');
      expect(() => entry.identifier({ _id: 'x' })).not.toThrow();
      expect(() => entry.display({ _id: 'x' })).not.toThrow();
    });

    it('only requires archive-first on a model that can actually be soft-deleted', () => {
      // Requiring it on a model with no deletion marker would make the entity permanently
      // undeletable — the check could never pass. `staff-role` is the deliberate exception
      // and declares `false`.
      if (entry.requireArchivedFirst) {
        expect(isSoftDeletable(entry.model())).toBe(true);
      }
    });

    it('points every relation at an existing model and an existing schema path', () => {
      const id = oid();

      entry.relations.forEach((relation) => {
        const RelatedModel = resolveRelationModel(relation);
        expect(RelatedModel.modelName).toEqual(expect.any(String));

        filterPaths(relation.filter(id)).forEach((path) => {
          // A filter on a non-existent path silently matches nothing: a cascade that deletes
          // zero rows, or a blocker that never blocks. Both look like success.
          const known = RelatedModel.schema.path(path) || RelatedModel.schema.path(path.split('.')[0]);
          expect(known).toBeDefined();
        });
      });
    });

    it('declares no CASCADE or DETACH when the removal is delegated to a custom executor', () => {
      // `runTransactionalDelete()` is skipped wholesale for a customExecutor entry, so such a
      // relation would be counted in the impact report and then never applied — a promise the
      // system does not keep. BLOCK and RETAIN still hold: both are evaluated before the branch.
      if (!entry.customExecutor) return;

      entry.relations.forEach((relation) => {
        expect([RELATION_MODE.BLOCK, RELATION_MODE.RETAIN]).toContain(relation.mode);
      });
    });

    it('gives every DETACH relation an update touching a real path', () => {
      const id = oid();

      entry.relations
        .filter((relation) => relation.mode === RELATION_MODE.DETACH)
        .forEach((relation) => {
          expect(typeof relation.update).toBe('function');

          const update = relation.update(id);
          const RelatedModel = resolveRelationModel(relation);
          const operators = Object.keys(update);

          expect(operators.length).toBeGreaterThan(0);
          operators.forEach((op) => {
            expect(op.startsWith('$')).toBe(true);
            Object.keys(update[op]).forEach((path) => {
              expect(RelatedModel.schema.path(path)).toBeDefined();
            });
          });
        });
    });

    it('uses only the three declared relation modes', () => {
      const modes = Object.values(RELATION_MODE);
      entry.relations.forEach((relation) => expect(modes).toContain(relation.mode));
    });
  });
});

// ── Reference coverage ────────────────────────────────────────────────────────

describe('hard-delete registry — no reference is left undeclared', () => {
  /**
   * The check that matters most, and the one a hand-written registry cannot pass by luck:
   * every `ref` in every schema pointing at a deletable entity must be declared by one of its
   * relations. An undeclared reference is a dangling id after the deletion — a populate that
   * returns null, a required field pointing at nothing, a whole tenant's rows orphaned when a
   * campus goes.
   *
   * Loading the model files from disk (rather than trusting `mongoose.modelNames()`) is
   * deliberate: the registry requires its models lazily, so a model nobody imported would
   * otherwise be invisible here — and invisible is exactly how it would reach production.
   */
  const ROOT = path.resolve(__dirname, '../..');

  const modelFiles = (dir, acc = []) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) modelFiles(full, acc);
      else if (/\.model\.js$/.test(item.name)) acc.push(full);
    }
    return acc;
  };

  /** `Model.path` → the entity model it references, for every loaded schema. */
  const allRefs = () => {
    for (const file of modelFiles(path.join(ROOT, 'modules'))) require(file);
    for (const file of modelFiles(path.join(ROOT, 'shared'))) require(file);

    const refs = [];
    for (const name of mongoose.modelNames()) {
      mongoose.model(name).schema.eachPath((p, type) => {
        let ref = type.options?.ref;
        if (type.instance === 'Array' && type.caster) ref = type.caster.options?.ref ?? ref;
        if (typeof ref === 'string') refs.push({ from: name, path: p, to: ref });
      });
    }
    return refs;
  };

  const refs = allRefs();

  describe.each(Object.entries(REGISTRY))('%s', (key, entry) => {
    it('declares a relation for every schema path referencing it', () => {
      const targetModel = entry.model().modelName;
      const id = oid();

      const declared = new Set([
        ...entry.relations.flatMap((r) => filterPaths(r.filter(id)).map((p) => `${r.model}.${p}`)),
        // A customExecutor entry removes some references in the module's own transaction; the
        // entry has to name them, so "handled elsewhere" stays distinguishable from "forgotten".
        ...(entry.handledByExecutor ?? []),
      ]);

      const undeclared = refs
        .filter((r) => r.to === targetModel)
        // A self-reference is the entity's own campus/parent pointer, resolved by the
        // deletion itself (`campus` is scoped by `_id`, `course` declares parentCourseId).
        .filter((r) => r.from !== targetModel || declared.has(`${r.from}.${r.path}`))
        .map((r) => `${r.from}.${r.path}`)
        .filter((ref) => !declared.has(ref));

      expect(undeclared).toEqual([]);
    });
  });
});

describe('hard-delete registry — protected records stay protected', () => {
  /**
   * These are the policy decisions the system exists to enforce. If someone downgrades one of
   * them from BLOCK to CASCADE, a single confirmed click would destroy an academic or
   * financial record — so the intent is pinned here, not just documented.
   */
  const blockedBy = (key, model) =>
    REGISTRY[key].relations.some((r) => r.model === model && r.mode === RELATION_MODE.BLOCK);

  it('refuses to hard-delete a student who has results, transcripts or payments', () => {
    expect(blockedBy('student', 'Result')).toBe(true);
    expect(blockedBy('student', 'FinalTranscript')).toBe(true);
    expect(blockedBy('student', 'FeePayment')).toBe(true);
    expect(blockedBy('student', 'ExamGrading')).toBe(true);
  });

  it('refuses to hard-delete a teacher who graded results or exams', () => {
    expect(blockedBy('teacher', 'Result')).toBe(true);
    expect(blockedBy('teacher', 'ExamGrading')).toBe(true);
  });

  it('refuses to hard-delete a class that still holds students or results', () => {
    expect(blockedBy('class', 'Student')).toBe(true);
    expect(blockedBy('class', 'Result')).toBe(true);
  });

  it('refuses to hard-delete a staff role still assigned to a staff member', () => {
    expect(blockedBy('staff-role', 'Staff')).toBe(true);
  });

  it('never cascades nor detaches a Result, a FinalTranscript or a FeePayment from anywhere', () => {
    // The two destructive modes are what this pins. RETAIN is allowed and is the opposite of a
    // downgrade: it leaves the record fully intact, only its provenance pointer goes stale.
    Object.values(REGISTRY).forEach((entry) => {
      entry.relations
        .filter((r) => ['Result', 'FinalTranscript', 'FeePayment'].includes(r.model))
        .forEach((r) => {
          expect(r.mode).not.toBe(RELATION_MODE.CASCADE);
          expect(r.mode).not.toBe(RELATION_MODE.DETACH);
        });
    });
  });

  it('blocks on the relations that make a record belong to the entity', () => {
    // The provenance exception must stay an exception: ownership stays BLOCK.
    expect(blockedBy('student', 'Result')).toBe(true);
    expect(blockedBy('teacher', 'Result')).toBe(true);
    expect(blockedBy('class', 'Result')).toBe(true);
    expect(blockedBy('subject', 'Result')).toBe(true);
    expect(blockedBy('campus', 'Result')).toBe(true);
  });

  it('detaches the mentor from its students rather than deleting them', () => {
    const relation = REGISTRY.mentor.relations.find((r) => r.model === 'Student');
    expect(relation.mode).toBe(RELATION_MODE.DETACH);
    expect(relation.update(oid())).toEqual({ $unset: { mentor: '' } });
  });

  it('pulls a deleted student out of class rosters and parent children lists', () => {
    const id = oid();
    const rosters = REGISTRY.student.relations.find((r) => r.model === 'Class');
    const parents = REGISTRY.student.relations.find((r) => r.model === 'Parent');

    expect(rosters.update(id)).toEqual({ $pull: { students: id } });
    expect(parents.update(id)).toEqual({ $pull: { children: id } });
  });
});

describe('hard-delete registry — RETAIN is declared, never implicit', () => {
  const retains = Object.entries(REGISTRY).flatMap(([key, entry]) =>
    entry.relations.filter((r) => r.mode === RELATION_MODE.RETAIN).map((r) => [key, r]),
  );

  it('is used at all — the alternative is the silent dangling reference', () => {
    expect(retains.length).toBeGreaterThan(0);
  });

  it('never carries an update: retaining is precisely NOT touching the document', () => {
    retains.forEach(([, relation]) => expect(relation.update).toBeUndefined());
  });

  it('keeps the two audit ledgers, which are schema-level undeletable', () => {
    // DocumentAudit refuses deleteMany() in a pre-hook: a CASCADE here would abort the whole
    // campus deletion transaction at run time, long after any test would have caught it.
    const campusRetains = REGISTRY.campus.relations
      .filter((r) => r.mode === RELATION_MODE.RETAIN)
      .map((r) => r.model);

    expect(campusRetains).toEqual(expect.arrayContaining(['DocumentAudit', 'DeletionAudit']));
  });

  it('stays confined to provenance and ledgers', () => {
    /**
     * RETAIN is the one mode that leaves a stale id behind, so the set of collections allowed
     * to use it is enumerated here rather than left to whoever edits the registry next. A new
     * entry has to be argued for in this list first.
     */
    const ALLOWED = [
      'StudentAttendance', 'TeacherAttendance',  // recordedBy / justifiedBy — required fields
      'StudentSchedule',   'TeacherSchedule',    // publishedBy / lastModifiedBy, department snapshot
      'Result',                                   // classManager — signatory of a published result
      'DocumentAudit',     'DeletionAudit',      // append-only ledgers
    ];

    retains.forEach(([, relation]) => expect(ALLOWED).toContain(relation.model));
  });
});

describe('hard-delete service — volume guards', () => {
  const line = (mode, count) => ({ model: 'X', label: 'x', mode, count });

  it('counts only what a cascade would actually remove', () => {
    expect(cascadeVolumeOf([
      line(RELATION_MODE.CASCADE, 10),
      line(RELATION_MODE.CASCADE, 5),
      line(RELATION_MODE.BLOCK, 1000),
      line(RELATION_MODE.DETACH, 40),
      line(RELATION_MODE.RETAIN, 900),
    ])).toBe(15);
  });

  it('stays under the limit a single MongoDB transaction can carry', () => {
    // The cap exists because the transaction aborts mid-flight past a few thousand documents.
    expect(MAX_CASCADE_DOCUMENTS).toBeGreaterThan(0);
    expect(MAX_CASCADE_DOCUMENTS).toBeLessThanOrEqual(IMPACT_COUNT_LIMIT);
  });

  it('cannot be under-reported by a capped count', () => {
    // Impact counts are capped at IMPACT_COUNT_LIMIT, so cascadeVolumeOf() returns a LOWER
    // bound of the real figure. That is only safe while the cap sits above the cascade limit:
    // were it below, a relation holding more rows than the transaction can carry would be
    // reported as a value under the threshold and the deletion would be let through to abort
    // mid-flight.
    expect(IMPACT_COUNT_LIMIT).toBeGreaterThan(MAX_CASCADE_DOCUMENTS);
  });
});

// ── Audit ledger: the write must never be what fails ──────────────────────────

describe('hard-delete audit — free text can never break the ledger write', () => {
  it('truncates past the cap and marks the cut', () => {
    expect(truncateForAudit('abc', 10)).toBe('abc');
    expect(truncateForAudit('a'.repeat(10), 10)).toHaveLength(10);

    const cut = truncateForAudit('a'.repeat(50), 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('turns null and undefined into a string rather than throwing', () => {
    expect(truncateForAudit(null, 10)).toBe('');
    expect(truncateForAudit(undefined, 10)).toBe('');
  });

  it('caps every free-text audit field at the value its schema declares', () => {
    // One number, two readers. A writer that overruns the schema does not degrade: on the
    // success path the audit row is created INSIDE the deletion transaction, so a rejected
    // write aborts the whole thing and the entity becomes permanently undeletable; on the
    // refusal path the row is simply lost, which is the one trace a security review needs.
    for (const [field, cap] of Object.entries(AUDIT_FIELD_LIMITS)) {
      const declared = DeletionAudit.schema.path(field)?.options?.maxlength;
      expect([field, declared]).toEqual([field, cap]);
    }
  });

  it('caps the blocker summary below what the widest entry can produce', () => {
    // `campus` declares thirty-odd BLOCK relations; "Blocked by: <label> (<n>), …" over all of
    // them runs past `failureReason` on its own. This is the case that motivated the cap, so
    // it is pinned against the real registry rather than a made-up string.
    const summary = REGISTRY.campus.relations
      .filter((r) => r.mode === RELATION_MODE.BLOCK)
      .map((r) => `${r.label} (1)`)
      .join(', ');

    expect(`Blocked by: ${summary}`.length).toBeGreaterThan(AUDIT_FIELD_LIMITS.failureReason);
    expect(truncateForAudit(`Blocked by: ${summary}`, AUDIT_FIELD_LIMITS.failureReason))
      .toHaveLength(AUDIT_FIELD_LIMITS.failureReason);
  });
});

describe('hard-delete registry — lookup helpers', () => {
  it('returns null for an unregistered entity rather than a permissive default', () => {
    expect(getEntry('nope')).toBeNull();
    expect(getEntry('__proto__')).toBeNull();
    expect(getEntry('constructor')).toBeNull();
  });

  it('lists only the entities a role may delete', () => {
    const forCampusManager = listEntries('CAMPUS_MANAGER').map((e) => e.key);
    expect(forCampusManager).toEqual(['staff-role']);

    const forAdmin = listEntries('ADMIN').map((e) => e.key);
    expect(forAdmin).toContain('student');
    expect(forAdmin.length).toBeGreaterThan(forCampusManager.length);
  });

  it('grants no danger-zone entity to a teacher, student or parent', () => {
    ['TEACHER', 'STUDENT', 'PARENT', 'MENTOR'].forEach((role) => {
      expect(listEntries(role)).toEqual([]);
    });
  });

  it('throws on a relation naming a model outside the accessor table', () => {
    expect(() => resolveRelationModel({ model: 'Nonexistent' })).toThrow(/unknown related model/);
  });
});

// ── Confirmation phrase ───────────────────────────────────────────────────────

describe('hard-delete guard — confirmation phrase', () => {
  it('accepts the exact phrase, case-insensitively and whitespace-normalised', () => {
    expect(verifyConfirmationPhrase('DELETE STU-001', 'STU-001').valid).toBe(true);
    expect(verifyConfirmationPhrase('delete stu-001', 'STU-001').valid).toBe(true);
    expect(verifyConfirmationPhrase('  DELETE   STU-001  ', 'STU-001').valid).toBe(true);
  });

  it('rejects the identifier alone — the verb is what makes it deliberate', () => {
    expect(verifyConfirmationPhrase('STU-001', 'STU-001').valid).toBe(false);
  });

  it('rejects the phrase of a neighbouring row', () => {
    expect(verifyConfirmationPhrase('DELETE STU-002', 'STU-001').valid).toBe(false);
  });

  it('rejects empty and nullish input', () => {
    expect(verifyConfirmationPhrase('', 'STU-001').valid).toBe(false);
    expect(verifyConfirmationPhrase(undefined, 'STU-001').valid).toBe(false);
    expect(verifyConfirmationPhrase(null, 'STU-001').valid).toBe(false);
  });

  it('returns the expected phrase so the UI never composes it itself', () => {
    expect(verifyConfirmationPhrase('x', 'stu-001').expected).toBe('DELETE STU-001');
    expect(buildConfirmationPhrase('stu-001')).toBe('DELETE STU-001');
  });
});

// ── Reason ────────────────────────────────────────────────────────────────────

describe('hard-delete guard — justification', () => {
  it('requires a substantive reason', () => {
    expect(verifyReason('').valid).toBe(false);
    expect(verifyReason('oops').valid).toBe(false);
    expect(verifyReason('x'.repeat(MIN_REASON_LENGTH - 1)).valid).toBe(false);
    expect(verifyReason(undefined).valid).toBe(false);
  });

  it('accepts and trims a valid reason', () => {
    const result = verifyReason('  duplicate test account created by mistake  ');
    expect(result.valid).toBe(true);
    expect(result.value).toBe('duplicate test account created by mistake');
  });

  it('rejects an oversized reason', () => {
    expect(verifyReason('x'.repeat(MAX_REASON_LENGTH + 1)).valid).toBe(false);
  });
});

// ── Ticket ────────────────────────────────────────────────────────────────────

describe('hard-delete guard — deletion ticket', () => {
  const actorId  = String(oid());
  const entityId = String(oid());
  const impact   = [
    { model: 'StudentAttendance', mode: 'cascade', count: 12 },
    { model: 'Class',             mode: 'detach',  count: 1 },
  ];

  const context = () => ({
    actorId,
    entityType:   'student',
    entityId,
    impactDigest: digestImpact(impact),
  });

  it('accepts a ticket issued for the same operation and impact', () => {
    const { ticket } = issueTicket(context());
    expect(verifyTicket(ticket, context()).valid).toBe(true);
  });

  it('produces a digest that ignores ordering but not content', () => {
    const reordered = [...impact].reverse();
    expect(digestImpact(reordered)).toBe(digestImpact(impact));

    const changed = [{ ...impact[0], count: 13 }, impact[1]];
    expect(digestImpact(changed)).not.toBe(digestImpact(impact));
  });

  it('separates two relations that share a model and a mode', () => {
    // Several entries declare more than one relation over the same model in the same mode —
    // `teacher` BLOCKs ExamGrading both as grader and as second grader, and DETACHes Class
    // twice. Keyed on model and mode alone those lines are interchangeable, so counts moving
    // between them leave the digest unchanged and a stale ticket still verifies. The label is
    // what tells them apart.
    const before = [
      { model: 'ExamGrading', label: 'Exam gradings they signed',         mode: 'block', count: 3 },
      { model: 'ExamGrading', label: 'Exam gradings they countersigned',  mode: 'block', count: 5 },
    ];
    const swapped = [
      { ...before[0], count: 5 },
      { ...before[1], count: 3 },
    ];

    expect(digestImpact(swapped)).not.toBe(digestImpact(before));
  });

  it('keeps every entry free of collisions on model + mode alone', () => {
    // The registry is allowed to declare duplicate (model, mode) pairs — that is the point of
    // the label. This pins that the entries which do so exist, so the guarantee above is
    // exercised by real data and not only by the synthetic case.
    const withDuplicates = Object.entries(REGISTRY).filter(([, entry]) => {
      const keys = entry.relations.map((r) => `${r.model}:${r.mode}`);
      return new Set(keys).size !== keys.length;
    });

    expect(withDuplicates.length).toBeGreaterThan(0);

    // …and that the label always disambiguates them.
    for (const [key, entry] of Object.entries(REGISTRY)) {
      const labelled = entry.relations.map((r) => `${r.model}:${r.label}:${r.mode}`);
      expect([key, new Set(labelled).size]).toEqual([key, labelled.length]);
    }
  });

  it('refuses a ticket once the impact changed between preview and execution', () => {
    const { ticket } = issueTicket(context());

    const drifted = verifyTicket(ticket, {
      ...context(),
      impactDigest: digestImpact([{ model: 'Result', mode: 'block', count: 1 }]),
    });

    expect(drifted.valid).toBe(false);
    expect(drifted.error).toMatch(/data changed/i);
  });

  it('refuses a ticket issued to another operator', () => {
    const { ticket } = issueTicket(context());
    const result = verifyTicket(ticket, { ...context(), actorId: String(oid()) });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/another user/i);
  });

  it('refuses a ticket issued for another entity or another entity type', () => {
    const { ticket } = issueTicket(context());

    expect(verifyTicket(ticket, { ...context(), entityId: String(oid()) }).valid).toBe(false);
    expect(verifyTicket(ticket, { ...context(), entityType: 'teacher' }).valid).toBe(false);
  });

  it('refuses a tampered payload — the signature is over the whole context', () => {
    const { ticket } = issueTicket(context());
    const [payload, signature] = [ticket.slice(0, ticket.lastIndexOf('.')), ticket.slice(ticket.lastIndexOf('.') + 1)];

    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const forged  = decoded.replace('student', 'teacher');
    const tampered = `${Buffer.from(forged).toString('base64url')}.${signature}`;

    expect(verifyTicket(tampered, { ...context(), entityType: 'teacher' }).valid).toBe(false);
  });

  it('refuses an expired ticket', () => {
    const { ticket } = issueTicket(context());

    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000; // past the 5-minute TTL
    try {
      const result = verifyTicket(ticket, context());
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/expired/i);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses missing and malformed tickets', () => {
    expect(verifyTicket(undefined, context()).valid).toBe(false);
    expect(verifyTicket('', context()).valid).toBe(false);
    expect(verifyTicket('not-a-ticket', context()).valid).toBe(false);
    expect(verifyTicket('aaaa.bbbb', context()).valid).toBe(false);
  });
});

// ── Actor credential resolution ───────────────────────────────────────────────

describe('hard-delete guard — actor credential store', () => {
  it('resolves ADMIN and DIRECTOR to the Admin collection', () => {
    expect(resolveActorModel('ADMIN').name).toBe('Admin');
    expect(resolveActorModel('DIRECTOR').name).toBe('Admin');
  });

  it('resolves CAMPUS_MANAGER to the Campus collection', () => {
    expect(resolveActorModel('CAMPUS_MANAGER').name).toBe('Campus');
  });

  it('fails closed for any other role rather than guessing a credential store', () => {
    ['TEACHER', 'STUDENT', 'PARENT', 'MENTOR', 'STAFF', '', undefined].forEach((role) => {
      expect(resolveActorModel(role)).toBeNull();
    });
  });
});

// ── Audit ledger ──────────────────────────────────────────────────────────────

describe('DeletionAudit — append-only ledger', () => {
  it.each(['deleteOne', 'deleteMany', 'findOneAndDelete'])(
    'refuses Model.%s() before it can reach the database',
    async (op) => {
      // The hooks throw at exec time, so this asserts real behaviour without a connection.
      await expect(DeletionAudit[op]({ _id: oid() })).rejects.toThrow(/immutable/i);
    },
  );

  it('refuses doc.deleteOne() too — document middleware is a separate hook', async () => {
    const doc = new DeletionAudit();
    await expect(doc.deleteOne()).rejects.toThrow(/immutable/i);
  });

  it('carries no soft-delete marker — an audit row is never "deleted"', () => {
    expect(isSoftDeletable(DeletionAudit)).toBe(false);
  });

  it('records refusals as first-class outcomes, not just successes', () => {
    const outcomes = DeletionAudit.schema.path('outcome').enumValues;
    expect(outcomes).toEqual(expect.arrayContaining([
      DELETION_OUTCOME.COMPLETED,
      DELETION_OUTCOME.BLOCKED,
      DELETION_OUTCOME.FAILED,
    ]));
  });

  it('requires the proof-of-intent fields on every entry', () => {
    ['reason', 'confirmationPhrase', 'impactDigest', 'performedBy', 'performedByRole', 'outcome']
      .forEach((path) => {
        expect(DeletionAudit.schema.path(path).isRequired).toBe(true);
      });
  });
});

// ── Rate limiting: the alias routes are not a way around the gate ─────────────

describe('hard-delete rate limit — every route reaching execute() is metered', () => {
  /**
   * The danger-zone router is not the only path to `service.execute()`. Seven compatibility
   * aliases reach it, clearing the same four controls — including the password re-entry. A
   * limiter mounted on the router alone is a limiter an attacker skips by changing URL, which
   * is exactly what these routes were before: unmetered attempts against an operator password.
   *
   * The map is derived from the controllers that actually call `execute()`, so a NEW alias
   * fails this suite until its route carries the limiter too.
   *
   * `deletionLimiter`        — routes that only ever perform a permanent deletion.
   * `hardDeleteFlagLimiter`  — routes that switch on `?hard=true`; metering the archive path
   *                            with the deletion budget would let ordinary archiving exhaust it.
   */
  const ROUTE_FILES = {
    'modules/student/student.crud.routes.js':  'deletionLimiter',
    'modules/teacher/teacher.crud.routes.js':  'deletionLimiter',
    'modules/staff/staff.member.routes.js':    'deletionLimiter',
    'modules/staff/staff.role.routes.js':      'deletionLimiter',
    'modules/mentor/mentor.routes.js':         'deletionLimiter',
    'modules/parent/parent.routes.js':         'hardDeleteFlagLimiter',
    'modules/document/document.routes.js':     'hardDeleteFlagLimiter',
  };

  const ROOT = path.join(__dirname, '..', '..');

  /** Controller files that reach the harmonized service directly. */
  const controllersCallingExecute = () => {
    const found = [];

    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) { walk(full); continue; }
        if (!item.name.endsWith('.js')) continue;

        const source = fs.readFileSync(full, 'utf8');
        if (/hardDelete\.service\.execute\s*\(/.test(source)) {
          found.push(path.relative(ROOT, full));
        }
      }
    };

    walk(path.join(ROOT, 'modules'));
    return found;
  };

  it.each(Object.entries(ROUTE_FILES))(
    '%s mounts %s on its permanent-deletion route',
    (file, limiter) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');

      expect(source).toContain("require('../../shared/lib/hard-delete')");

      // The limiter has to sit ON a delete route, not merely be imported.
      const deleteRoutes = source
        .split(/router\.delete\(/)
        .slice(1)
        .filter((chunk) => chunk.includes(limiter));

      expect(deleteRoutes.length).toBeGreaterThan(0);
    },
  );

  it('leaves no controller calling execute() from an unmetered module', () => {
    // Every module that reaches execute() must own at least one route file in the map above.
    const modulesWithExecute = new Set(
      controllersCallingExecute().map((file) => file.split(path.sep)[1]),
    );
    const meteredModules = new Set(
      Object.keys(ROUTE_FILES).map((file) => file.split('/')[1]),
    );

    const unmetered = [...modulesWithExecute].filter((mod) => !meteredModules.has(mod));
    expect(unmetered).toEqual([]);
  });

  it('gives the deletion budget its own store, not one shared with unrelated flows', () => {
    // Reusing strictLimiter would share a 3-per-hour budget with GAET generation, admin
    // creation and partner password resets: two timetable generations would lock the danger
    // zone, and vice versa.
    const { DELETION_RATE_LIMIT } = require('../../shared/lib/hard-delete/hard-delete.constants');

    expect(DELETION_RATE_LIMIT.STORE_PREFIX).toBe('hard-delete');
    expect(DELETION_RATE_LIMIT.MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(DELETION_RATE_LIMIT.WINDOW_MINUTES).toBeGreaterThan(0);
  });

  it('lets the archive path through untouched', () => {
    // `DELETE /api/parents/:id` and `DELETE /api/documents/:id` serve both operations. Metering
    // the archive form on the deletion budget would let ordinary archiving exhaust it — and
    // make the danger zone unavailable for the rest of the hour because someone archived
    // eleven rows.
    const { hardDeleteFlagLimiter } = require('../../shared/lib/hard-delete');

    for (const query of [{}, { hard: 'false' }, { hard: '1' }]) {
      const next = jest.fn();
      hardDeleteFlagLimiter({ query }, {}, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('routes ?hard=true through the limiter instead of waving it through', async () => {
    const { hardDeleteFlagLimiter } = require('../../shared/lib/hard-delete');

    // Enough of a req/res for express-rate-limit to run for real: the point is that the
    // permanent-deletion form is metered, not that it happens to be refused.
    const req = { query: { hard: 'true' }, ip: '203.0.113.7' };
    const res = { setHeader: jest.fn(), status: () => res, json: jest.fn() };
    const next = jest.fn();

    await hardDeleteFlagLimiter(req, res, next);

    // The limiter ran: it stamped its RateLimit headers before handing control on.
    expect(res.setHeader).toHaveBeenCalled();
    expect(req.rateLimit).toBeDefined();
  });
});
