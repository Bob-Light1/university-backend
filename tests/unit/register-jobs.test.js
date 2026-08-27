'use strict';

/**
 * shared/lib/register-jobs — enregistrement des jobs de fond (B9-① / B9-②).
 *
 * Le bloc remplacé dans server.js entourait quinze opérations indépendantes d'un
 * seul `try`. Les tests ci-dessous portent donc sur l'ISOLEMENT (un échec ne peut
 * pas atteindre le job suivant), sur la VÉRACITÉ du motif rapporté, et sur le fait
 * que l'horloge de déclenchement est écrite dans le code plutôt qu'héritée du
 * fuseau du conteneur.
 */

const { registerJobs, projectJobs, JOB_FAILURE, CRON_TIMEZONE } = require('../../shared/lib/register-jobs');

/** Doublure minimale de node-cron : enregistre, et reproduit le vrai validate(). */
function fakeCron() {
  const registered = [];
  return {
    registered,
    validate: (expr) => /^[\d*,/\-\s]+$/.test(expr) && expr.trim().split(/\s+/).length === 5,
    schedule: (expr, fn, opts) => { registered.push({ expr, fn, opts }); return { stop() {} }; },
  };
}

const silent = { error() {}, warn() {}, log() {} };

describe('registerJobs — isolement des échecs (B9-①)', () => {
  test('un loader qui lève n’empêche pas les autres jobs de s’enregistrer', () => {
    const cron = fakeCron();

    const { scheduled, failed } = registerJobs(cron, [
      { name: 'a', schedule: '0 2 * * 0', load: () => () => {} },
      { name: 'b', schedule: '0 6 * * *', load: () => { throw new Error("Cannot find module './nope'"); } },
      { name: 'c', schedule: '0 3 * * *', load: () => () => {} },
    ], { logger: silent });

    // Le bloc historique de server.js en aurait enregistré ZÉRO.
    expect(scheduled).toEqual(['a', 'c']);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ name: 'b', reason: JOB_FAILURE.LOAD_THREW });
  });

  test('le bloc historique à try unique n’en aurait enregistré AUCUN (baseline du bug)', () => {
    // Reproduction de la forme retirée de server.js : quinze opérations, un seul try.
    const cron = fakeCron();
    let warned = null;

    try {
      const a = (() => () => {})();
      const b = (() => { throw new Error("Cannot find module './nope'"); })();
      const c = (() => () => {})();
      cron.schedule('0 2 * * 0', a);
      cron.schedule('0 6 * * *', b);
      cron.schedule('0 3 * * *', c);
    } catch {
      warned = 'node-cron not available — cron jobs disabled.';
    }

    // Le require de `b` lève AVANT le premier cron.schedule : les trois jobs sautent.
    expect(cron.registered).toHaveLength(0);
    // …et le message accuse node-cron, qui s'est chargé sans problème.
    expect(warned).toMatch(/node-cron not available/);
  });

  test('le motif rapporté porte l’erreur réelle, jamais une cause devinée', () => {
    const cron = fakeCron();
    const logger = { ...silent, error: jest.fn() };

    const { failed } = registerJobs(cron, [
      { name: 'finance-overdue', schedule: '0 6 * * *', load: () => { throw new Error("Cannot find module './modules/nonexistent'"); } },
    ], { logger });

    expect(failed[0].error).toMatch(/nonexistent/);
    // La phrase que l'ancien handler imprimait sans l'avoir vérifiée.
    expect(failed[0].error).not.toMatch(/node-cron/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
  });

  test('un loader qui rend undefined est un échec nommé, pas une tâche planifiée', () => {
    const cron = fakeCron();

    const { scheduled, failed } = registerJobs(cron, [
      { name: 'finance-overdue', schedule: '0 6 * * *', load: () => undefined },
    ], { logger: silent });

    expect(scheduled).toEqual([]);
    expect(failed[0].reason).toBe(JOB_FAILURE.NOT_A_FUNCTION);
    expect(cron.registered).toHaveLength(0); // undefined ne doit jamais atteindre cron.schedule
  });

  test('une expression cron invalide est son propre motif d’échec', () => {
    const cron = fakeCron();

    const { failed } = registerJobs(cron, [
      { name: 'typo', schedule: '0 2 * *', load: () => () => {} }, // quatre champs, pas cinq
    ], { logger: silent });

    expect(failed[0].reason).toBe(JOB_FAILURE.BAD_SCHEDULE);
    expect(cron.registered).toHaveLength(0);
  });

  test('un scheduler qui refuse l’enregistrement est isolé lui aussi', () => {
    const cron = fakeCron();
    cron.schedule = jest.fn(() => { throw new Error('scheduler refused'); });

    const { scheduled, failed } = registerJobs(cron, [
      { name: 'x', schedule: '0 2 * * 0', load: () => () => {} },
    ], { logger: silent });

    expect(scheduled).toEqual([]);
    expect(failed[0].reason).toBe(JOB_FAILURE.SCHEDULE_THREW);
  });

  test('le manifeste laisse l’appelant décider du sens d’un enregistrement partiel', () => {
    const cron = fakeCron();

    const manifest = registerJobs(cron, [
      { name: 'print-queue-sweep', schedule: '*/2 * * * *', load: () => () => {} },
      { name: 'finance-overdue',   schedule: '0 6 * * *',   load: () => { throw new Error('boom'); } },
    ], { logger: silent });

    expect(manifest.scheduled).toEqual(['print-queue-sweep']);
    expect(manifest.failed.map((f) => f.name)).toEqual(['finance-overdue']);
  });
});

describe('registerJobs — horloge de déclenchement (B9-②)', () => {
  test('l’horloge de déclenchement est UTC, écrite dans le code', () => {
    // Le TZ de l'hôte n'est défini nulle part dans ce dépôt. Les jobs, eux,
    // calculent en UTC (competition.closing.cron : getUTCFullYear/getUTCMonth) :
    // laisser node-cron matcher sur l'heure locale du conteneur fait clôturer
    // chaque compétition mensuelle avec un mois de retard à l'ouest de Greenwich.
    expect(CRON_TIMEZONE).toBe('UTC');
  });

  test('AUCUN des huit jobs réels n’est enregistré sans fuseau', () => {
    const cron = fakeCron();

    registerJobs(cron, projectJobs(), { timezone: CRON_TIMEZONE, logger: silent });

    expect(cron.registered).toHaveLength(8);
    for (const r of cron.registered) expect(r.opts.timezone).toBe('UTC');
  });

  test('le fuseau est appliqué à CHAQUE enregistrement', () => {
    const cron = fakeCron();

    registerJobs(cron, [
      { name: 'competition-closing', schedule: '5 0 1 * *', load: () => () => {} },
      { name: 'exam-anticheat',      schedule: '0 3 * * *', load: () => () => {} },
    ], { timezone: 'UTC', logger: silent });

    expect(cron.registered).toHaveLength(2);
    for (const r of cron.registered) expect(r.opts.timezone).toBe('UTC');
  });

  test('chaque tâche est nommée, pour que node-cron ne journalise pas un job anonyme', () => {
    const cron = fakeCron();

    registerJobs(cron, [
      { name: 'document-retention', schedule: '0 2 * * 0', load: () => () => {} },
    ], { logger: silent });

    expect(cron.registered[0].opts.name).toBe('document-retention');
  });
});

describe('projectJobs — les huit jobs réels de la plateforme', () => {
  test('les huit se chargent depuis les façades et s’enregistrent', () => {
    const cron = fakeCron();

    const { scheduled, failed } = registerJobs(cron, projectJobs(), { timezone: 'UTC', logger: silent });

    expect(failed).toEqual([]);
    expect(scheduled).toHaveLength(8);
    expect(scheduled).toEqual(expect.arrayContaining([
      'document-retention', 'exam-anticheat', 'announcement-expiry',
      'competition-closing', 'notification-retry', 'finance-overdue',
      'finance-due-soon', 'print-queue-sweep',
    ]));
  });

  test('les huit horaires correspondent à ceux documentés dans CLAUDE.md §11', () => {
    const byName = Object.fromEntries(projectJobs().map((j) => [j.name, j.schedule]));

    expect(byName).toEqual({
      'document-retention':  '0 2 * * 0',
      'exam-anticheat':      '0 3 * * *',
      'announcement-expiry': '0 1 * * *',
      'competition-closing': '5 0 1 * *',
      'notification-retry':  '*/10 * * * *',
      'finance-overdue':     '0 6 * * *',
      // 07:00 : après la bascule des impayés de 06:00, jamais avant.
      'finance-due-soon':    '0 7 * * *',
      'print-queue-sweep':   '*/2 * * * *',
    });
  });
});
