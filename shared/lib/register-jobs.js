'use strict';

/**
 * @file register-jobs.js
 * @description Registration of the platform's background jobs, one isolated
 *              failure at a time.
 *
 * `server.js` used to wrap all seven `require`s and all seven `cron.schedule`
 * calls in a single `try { … } catch {}`. Fifteen independent operations under one
 * guard means a typo in any one of seven service files leaves **zero** jobs
 * registered — and the handler then printed a cause it had never verified
 * ("node-cron not available") while `catch {}` discarded the only object that
 * identified the real file. The server started, looked healthy, and ran nothing.
 *
 * Three rules follow from that, and this helper exists to enforce them:
 *   1. one guard per registration, so a failure cannot reach the next job;
 *   2. never assert a cause that has not been checked — log the real error;
 *   3. verify what the loader returned before handing it to the scheduler.
 */

/**
 * The clock every job fires on.
 *
 * Without it, node-cron matches the expression against the container's local time
 * while the jobs themselves compute in UTC — `competition.closing.cron.js`
 * derives the current period from `getUTCFullYear()`/`getUTCMonth()`. On any host
 * west of Greenwich the `5 0 1 * *` registration fires while UTC is still the
 * previous month, so `period < currentPeriod()` excludes the month that just
 * ended and every monthly competition closes a month late. The host's TZ is set
 * nowhere in this repository, so the firing clock has to be stated in code rather
 * than inherited from wherever the container happens to run.
 */
const CRON_TIMEZONE = 'UTC';

/** Failure kinds, so a caller reacts per kind rather than by parsing strings. */
const JOB_FAILURE = Object.freeze({
  LOAD_THREW:     'LOAD_THREW',      // the module threw while being required
  NOT_A_FUNCTION: 'NOT_A_FUNCTION',  // the facade no longer exports what we asked for
  BAD_SCHEDULE:   'BAD_SCHEDULE',    // invalid cron expression
  SCHEDULE_THREW: 'SCHEDULE_THREW',  // the scheduler refused the registration
});

/**
 * Registers a set of background jobs, isolating each one's failure.
 *
 * `load` is a FUNCTION returning the job function, never the job function itself.
 * That inversion is the point: `{ fn: require('./x').service.run }` has already
 * thrown before this helper runs, whereas `{ load: () => … }` defers the require
 * INTO our try. A guard only covers what happens inside it.
 *
 * @param {object} cron                     node-cron, or any `{ schedule, validate }`
 * @param {Array<{name: string, schedule: string, load: () => Function}>} jobs
 * @param {object} [options]
 * @param {string} [options.timezone]       firing clock, applied to every registration
 * @param {object} [options.logger=console]
 * @returns {{ scheduled: string[], failed: Array<{name: string, reason: string, error: string}> }}
 *
 * Deliberately NOT decided here: whether a partial registration is acceptable. A
 * missing print sweep may be survivable; a missing finance job on the 1st of the
 * month may not be. That is a policy question about a deployment, so the manifest
 * is returned and `server.js` decides.
 */
const registerJobs = (cron, jobs, options = {}) => {
  const { timezone, logger = console } = options;
  const scheduled = [];
  const failed    = [];

  const fail = (name, reason, error) => {
    failed.push({ name, reason, error: error.message });
    // Always the actual error. Never a guessed cause.
    logger.error(`⚠️  [cron] job "${name}" not registered (${reason}): ${error.message}`);
  };

  for (const { name, schedule, load } of jobs) {
    let fn;
    try {
      fn = load();
    } catch (err) {
      fail(name, JOB_FAILURE.LOAD_THREW, err);
      continue;
    }

    // A facade that stops exporting `runOverdueJob` returns undefined WITHOUT
    // throwing. Handing that to cron.schedule registers a task that throws on
    // every fire, nightly, into node-cron's own logger. Catching it here turns an
    // invisible nightly failure into one loud line at boot.
    if (typeof fn !== 'function') {
      fail(name, JOB_FAILURE.NOT_A_FUNCTION, new Error(`loader returned ${typeof fn}, expected function`));
      continue;
    }

    // cron.validate returns a boolean and does not throw — check it explicitly so
    // the manifest carries a distinguishable reason.
    if (typeof cron.validate === 'function' && !cron.validate(schedule)) {
      fail(name, JOB_FAILURE.BAD_SCHEDULE, new Error(`invalid cron expression "${schedule}"`));
      continue;
    }

    try {
      cron.schedule(schedule, fn, { name, ...(timezone ? { timezone } : {}) });
      scheduled.push(name);
    } catch (err) {
      fail(name, JOB_FAILURE.SCHEDULE_THREW, err);
    }
  }

  return { scheduled, failed };
};

/**
 * The platform's eight jobs (CLAUDE.md §11). Every require is deferred into a
 * loader so that a broken module is one failed job, not eight.
 */
const projectJobs = () => [
  { name: 'document-retention',  schedule: '0 2 * * 0',    load: () => require('../../modules/document').service.runRetentionJob },
  { name: 'exam-anticheat',      schedule: '0 3 * * *',    load: () => require('../../modules/exam').service.runAntiCheatJob },
  { name: 'announcement-expiry', schedule: '0 1 * * *',    load: () => require('../../modules/announcement').service.runExpiryJob },
  { name: 'competition-closing', schedule: '5 0 1 * *',    load: () => require('../../modules/public-portal').service.runCompetitionClosingJob },
  { name: 'notification-retry',  schedule: '*/10 * * * *', load: () => require('../../modules/notification').service.runRetryJob },
  { name: 'finance-overdue',     schedule: '0 6 * * *',    load: () => require('../../modules/finance').service.runOverdueJob },
  // 07:00, after the 06:00 overdue sweep: the past-due transition of the day is
  // then already applied, so a debt that fell due overnight is dunned by that
  // job rather than greeted here with a "due today" notice.
  { name: 'finance-due-soon',    schedule: '0 7 * * *',    load: () => require('../../modules/finance').service.runDueSoonJob },
  { name: 'print-queue-sweep',   schedule: '*/2 * * * *',  load: () => require('../../modules/academic-print').service.runPrintQueueJob },
];

module.exports = { registerJobs, projectJobs, JOB_FAILURE, CRON_TIMEZONE };
