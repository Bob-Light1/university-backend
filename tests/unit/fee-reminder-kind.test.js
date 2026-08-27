'use strict';

/**
 * The pre-due reminder cadence — pure rule (`modules/finance/fee-reminder-kind.js`)
 * and the schema paths the sweep queries.
 *
 * Design note: `docs/architecture/features/fee-receipts-and-reminders.md` §2, §6, §9①.
 *
 * The schema half is not decoration. Every filter of the sweep names a path
 * (`remindersSent.kind`, `dueDate`, `amountPaid`…), and a path that does not
 * exist raises nothing: the sweep would simply select no debt and report zero
 * reminders — a figure, not a failure. The real model is loaded here (no mock)
 * so a renamed path fails this suite instead of silencing the cron.
 */

const {
  REMINDER_KINDS,
  REMINDER_KIND_VALUES,
  REMINDER_LEAD_DAYS,
  daysUntilDue,
  dueReminderKind,
  preDueWindow,
} = require('../../modules/finance/fee-reminder-kind');

const { CRON_TIMEZONE } = require('../../shared/lib/register-jobs');
const StudentFee = require('../../modules/finance/models/studentFee.model');
const FeePayment = require('../../modules/finance/models/feePayment.model');

const NOW = new Date('2026-06-15T07:00:00.000Z'); // the hour the cron fires
/** A due date `days` whole days after NOW, at an hour that is NOT the sweep's. */
const dueIn = (days, hour = 23) =>
  new Date(Date.UTC(2026, 5, 15 + days, hour, 30, 0));

describe('REMINDER_KINDS', () => {
  test('trois types, et « overdue » n\'en est pas un (§9①)', () => {
    // The overdue cadence REPEATS and counts with $inc; the pre-due one fires
    // each kind at most once, which is what makes `remindersSent[]` claimable
    // idempotently. Declaring `overdue` in that array would invite a writer to
    // record it there and recreate the collision of §6.
    expect(REMINDER_KIND_VALUES).toEqual(['due_in_7d', 'due_in_3d', 'due_today']);
    expect(REMINDER_KIND_VALUES).not.toContain('overdue');
    expect(Object.isFrozen(REMINDER_KINDS)).toBe(true);
  });

  test('chaque type porte son délai, et les délais sont strictement décroissants', () => {
    const leads = REMINDER_KIND_VALUES.map((kind) => REMINDER_LEAD_DAYS[kind]);
    expect(leads).toEqual([7, 3, 0]);
    expect(leads.every((lead) => Number.isInteger(lead))).toBe(true);
  });
});

describe('daysUntilDue', () => {
  test('compte des jours UTC, pas des heures écoulées', () => {
    // Read at 07:00 for a debt due at 23:30 the same day: 16 h apart, 0 day.
    expect(daysUntilDue(dueIn(0), NOW)).toBe(0);
    // …and 16 h + 24 h apart is still exactly one day.
    expect(daysUntilDue(dueIn(1), NOW)).toBe(1);
    expect(daysUntilDue(dueIn(7, 0), NOW)).toBe(7);
  });

  test('une échéance passée est négative', () => {
    expect(daysUntilDue(dueIn(-2), NOW)).toBe(-2);
  });

  test('sans échéance, ou avec une date invalide → null (jamais NaN)', () => {
    expect(daysUntilDue(null, NOW)).toBeNull();
    expect(daysUntilDue(undefined, NOW)).toBeNull();
    expect(daysUntilDue('not-a-date', NOW)).toBeNull();
  });
});

describe('dueReminderKind', () => {
  test('le jour même de chaque palier tire le préavis de ce palier', () => {
    expect(dueReminderKind(dueIn(7), NOW)).toBe(REMINDER_KINDS.DUE_IN_7D);
    expect(dueReminderKind(dueIn(3), NOW)).toBe(REMINDER_KINDS.DUE_IN_3D);
    expect(dueReminderKind(dueIn(0), NOW)).toBe(REMINDER_KINDS.DUE_TODAY);
  });

  test('une exécution manquée ne perd pas la cadence : à J-5, le préavis J-7 part encore', () => {
    expect(dueReminderKind(dueIn(5), NOW)).toBe(REMINDER_KINDS.DUE_IN_7D);
    expect(dueReminderKind(dueIn(4), NOW)).toBe(REMINDER_KINDS.DUE_IN_7D);
  });

  test('mais jamais un préavis périmé : à J-2, c\'est J-3 qui gagne, pas J-7', () => {
    // Eligibility is `lead >= daysUntil` and the SMALLEST eligible lead wins —
    // otherwise a student would read « due in 7 days » two days before the date.
    expect(dueReminderKind(dueIn(2), NOW)).toBe(REMINDER_KINDS.DUE_IN_3D);
    expect(dueReminderKind(dueIn(1), NOW)).toBe(REMINDER_KINDS.DUE_IN_3D);
  });

  test('hors fenêtre : au-delà du plus long délai, aucun préavis', () => {
    expect(dueReminderKind(dueIn(8), NOW)).toBeNull();
    expect(dueReminderKind(dueIn(30), NOW)).toBeNull();
  });

  test('une dette échue rend null — elle appartient à la cadence d\'impayé', () => {
    expect(dueReminderKind(dueIn(-1), NOW)).toBeNull();
    expect(dueReminderKind(dueIn(-45), NOW)).toBeNull();
    expect(dueReminderKind(null, NOW)).toBeNull();
  });
});

describe('preDueWindow', () => {
  test('de minuit UTC aujourd\'hui (inclus) au lendemain du plus long délai (exclu)', () => {
    const { from, to } = preDueWindow(NOW);
    expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-23T00:00:00.000Z'); // J+8, exclusive
  });

  test('la fenêtre est dérivée de la table des délais, jamais redite', () => {
    // The window has to cover the longest lead time entirely: a debt eligible
    // for a notice and outside the query is a notice that never goes out.
    const { from, to } = preDueWindow(NOW);
    const maxLead = Math.max(...Object.values(REMINDER_LEAD_DAYS));
    const spanDays = Math.round((to - from) / 86400000);
    expect(spanDays).toBe(maxLead + 1);

    // Every kind the rule can return for a date inside the window, and no date
    // outside it that the rule would still answer for.
    for (let day = 0; day <= maxLead; day += 1) {
      const due = dueIn(day);
      expect(dueReminderKind(due, NOW)).not.toBeNull();
      expect(due >= from && due < to).toBe(true);
    }
    expect(dueReminderKind(dueIn(maxLead + 1), NOW)).toBeNull();
  });
});

describe('la cadence et l\'horloge du cron', () => {
  test('les jours sont comptés en UTC parce que les jobs tirent en UTC', () => {
    // `daysUntilDue` rounds on UTC midnights. Fire the sweep on a different
    // clock and the two boundaries drift: a debt due at 00:30 UTC would be read
    // as "due today" by the rule and as "due tomorrow" by the schedule — the
    // J-0 notice would go out the day AFTER the due date, for one time zone's
    // worth of debts and nobody else's.
    expect(CRON_TIMEZONE).toBe('UTC');
  });
});

// ── The paths the sweep and the receipt actually query ────────────────────────

describe('StudentFee — schéma réel', () => {
  test('remindersSent existe, avec ses deux sous-champs', () => {
    expect(StudentFee.schema.path('remindersSent')).toBeDefined();
    const sub = StudentFee.schema.path('remindersSent').schema;
    expect(sub.path('kind')).toBeDefined();
    expect(sub.path('sentAt')).toBeDefined();
  });

  test('l\'enum du schéma est celui du module de règle — une seule source', () => {
    const kindPath = StudentFee.schema.path('remindersSent').schema.path('kind');
    expect(kindPath.enumValues).toEqual(REMINDER_KIND_VALUES);
  });

  test('le validateur refuse deux entrées du même type (invariant de la réclamation)', () => {
    const doc = new StudentFee({
      student: '507f1f77bcf86cd799439011',
      schoolCampus: '507f1f77bcf86cd799439012',
      label: 'Tuition',
      amountDue: 100,
      remindersSent: [
        { kind: REMINDER_KINDS.DUE_IN_7D, sentAt: NOW },
        { kind: REMINDER_KINDS.DUE_IN_7D, sentAt: NOW },
      ],
    });
    const err = doc.validateSync();
    expect(err?.errors?.remindersSent).toBeDefined();
  });

  test('les deux marqueurs d\'impayé restent en place, intacts (§6)', () => {
    // The pre-due cadence is purely additive: removing either of these would
    // break the overdue claim, not this one.
    expect(StudentFee.schema.path('lastRemindedAt')).toBeDefined();
    expect(StudentFee.schema.path('reminderCount')).toBeDefined();
  });

  test('les chemins interrogés par le balayage existent tous', () => {
    for (const p of ['dueDate', 'status', 'amountDue', 'amountPaid', 'schoolCampus', 'isDeleted']) {
      expect(StudentFee.schema.path(p)).toBeDefined();
    }
  });
});

describe('FeePayment — schéma réel', () => {
  test('les chemins imprimés par le reçu existent tous', () => {
    for (const p of ['fee', 'student', 'schoolCampus', 'amount', 'currency', 'method', 'reference', 'paidAt']) {
      expect(FeePayment.schema.path(p)).toBeDefined();
    }
  });

  test('un encaissement ne porte aucun marqueur de suppression (§4 de la note)', () => {
    // Deliberate: a payment is not cancelled, it is reversed. The receipt is
    // therefore an artefact of an immutable line, with no lifecycle of its own.
    expect(FeePayment.schema.path('isDeleted')).toBeUndefined();
    expect(FeePayment.schema.path('deletedAt')).toBeUndefined();
  });
});
