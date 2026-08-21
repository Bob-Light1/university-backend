'use strict';

/**
 * @file competition.closing.cron.js
 * @description Monthly closing of the quiz competition (spec §4.5 / §10 Phase 2).
 *
 *  Triggered on the 1st of the month: for each CompetitionPrize still active whose period
 *  has elapsed (period < current period), computes the final ranking from the
 *  QuizSession of that period/campus, populates winners[] and sets isActive:false.
 *
 *  Winners are frozen (displayName + score) at the moment of closing. The email/SMS
 *  notification (Africa's Talking + Resend/SendGrid) is a Phase 3 prerequisite — not triggered
 *  here, notifiedAt stays null until wired up.
 *
 *  ENTITLEMENT: the closing is hygiene and always runs; the winner notifications
 *  are emission and are withheld when the campus's public portal is not active
 *  (CAMPUS_ENTITLEMENT_DESIGN.md §9.1). The ranking is still frozen, so nothing
 *  is lost — only the outbound message is.
 *
 *  Schedule: 1st of the month at 00:05 UTC, registered by
 *  `shared/lib/register-jobs.js`. The timezone is not incidental here: this job
 *  derives the current period in UTC (see `currentPeriod` below), so a schedule
 *  firing on the container's local time would run while UTC is still the previous
 *  month and `period < currentPeriod()` would exclude the month that just ended.
 *
 *  Manual trigger (tests / catch-up):
 *    const { closeCompetition } = require('./crons/competition.closing.cron');
 *    await closeCompetition(competitionId);
 */

const repo = require('./public-portal.repository');
const { notifyWinners } = require('./notification.service');

// Number of winners kept per competition (top N — covers 1st, 2nd-3rd, top 10 of the spec)
const TOP_N = 10;

/**
 * Current period in 'YYYY-MM' format (UTC).
 * @returns {string}
 */
function currentPeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Closes a competition: computes winners from QuizSession and freezes the result.
 *
 * @param {import('mongoose').Types.ObjectId|string} competitionId
 * @returns {Promise<{ winners: number }>}
 */
const closeCompetition = async (competitionId) => {
  const competition = await repo.findCompetitionByIdForWrite(competitionId);
  if (!competition) {
    console.warn(`[CompetitionClosing] Competition ${competitionId} not found.`);
    return { winners: 0 };
  }
  if (!competition.isActive) {
    return { winners: 0 };
  }

  // Best sessions of the period for this campus — one session per token (already unique)
  const topSessions = await repo.findTopQuizSessions(
    { schoolCampus: competition.schoolCampus, period: competition.period },
    TOP_N,
  );

  competition.winners = topSessions.map((s, idx) => ({
    rank:        idx + 1,
    quizSession: s._id,
    lead:        s.lead || null,
    displayName: s.displayName || null,
    score:       s.score || 0,
    notifiedAt:  null, // Phase 3
  }));
  competition.isActive = false;

  await repo.saveCompetitionDoc(competition);

  // The closing itself is HYGIENE and always runs: a competition left active
  // past its period never settles, and its ranking would drift with sessions
  // played after the fact. The winner mails and SMS are EMISSION — outbound
  // messages in the name of the public portal — and are withheld when the
  // module is not active on this campus (design doc §9.1).
  const mayEmit = await require('../../shared/lib/entitlement').jobs
    .isEmissionAllowed(competition.schoolCampus, 'public-portal');

  const brandName = process.env.BRAND_NAME || process.env.NEXT_PUBLIC_BRAND_NAME || 'AcadERP';
  const { notified } = mayEmit
    ? await notifyWinners(competition, brandName)
    : { notified: 0 };

  console.log(
    `[CompetitionClosing] Closed competition ${competition.period} (campus ${competition.schoolCampus}) — ${competition.winners.length} winner(s), ${notified} notified`
    + (mayEmit ? '' : ' (portal not active — winners frozen, no notification sent)')
    + '.'
  );
  return { winners: competition.winners.length, notified };
};

/**
 * Cron job: closes all active competitions whose period has elapsed.
 *
 * @returns {Promise<{ closed: number, totalWinners: number }>}
 */
const runCompetitionClosingJob = async () => {
  const period = currentPeriod();

  // Active AND of a period strictly earlier than the current period
  const due = await repo.findActiveCompetitionsBeforePeriod(period);

  let totalWinners = 0;
  for (const c of due) {
    try {
      const { winners } = await closeCompetition(c._id);
      totalWinners += winners;
    } catch (err) {
      console.error(`[CompetitionClosing] Error closing competition ${c._id}:`, err.message);
    }
  }

  console.log(`[CompetitionClosing] Done. Closed: ${due.length}, Winners: ${totalWinners}.`);
  return { closed: due.length, totalWinners };
};

module.exports = { runCompetitionClosingJob, closeCompetition, currentPeriod };
