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
 *  Usage in server.js (node-cron):
 *    const { runCompetitionClosingJob } = require('./crons/competition.closing.cron');
 *    cron.schedule('5 0 1 * *', runCompetitionClosingJob); // 1st of the month at 00:05
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

  const brandName = process.env.BRAND_NAME || process.env.NEXT_PUBLIC_BRAND_NAME || 'AcadERP';
  const { notified } = await notifyWinners(competition, brandName);

  console.log(
    `[CompetitionClosing] Closed competition ${competition.period} (campus ${competition.schoolCampus}) — ${competition.winners.length} winner(s), ${notified} notified.`
  );
  return { winners: competition.winners.length };
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
