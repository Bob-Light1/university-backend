'use strict';

/**
 * @file competition.closing.cron.js
 * @description Clôture mensuelle de la compétition de quiz (spec §4.5 / §10 Phase 2).
 *
 *  Déclenché le 1er du mois : pour chaque CompetitionPrize encore active dont la période
 *  est révolue (period < période courante), calcule le classement final depuis les
 *  QuizSession de cette période/campus, peuple winners[] et passe isActive:false.
 *
 *  Les gagnants sont figés (displayName + score) au moment de la clôture. La notification
 *  email/SMS (Africa's Talking + Resend/SendGrid) est un prérequis Phase 3 — non déclenchée
 *  ici, notifiedAt reste null jusqu'à branchement.
 *
 *  Usage dans server.js (node-cron) :
 *    const { runCompetitionClosingJob } = require('./crons/competition.closing.cron');
 *    cron.schedule('5 0 1 * *', runCompetitionClosingJob); // 1er du mois à 00:05
 *
 *  Déclenchement manuel (tests / rattrapage) :
 *    const { closeCompetition } = require('./crons/competition.closing.cron');
 *    await closeCompetition(competitionId);
 */

const CompetitionPrize = require('../models/partner-models/competition.prize.model');
const QuizSession      = require('../models/partner-models/quiz.session.model');
const PartnerLead      = require('../models/partner-models/partner.lead.model');
const { notifyWinners } = require('../services/notification.service');

// Nombre de gagnants retenus par compétition (top N — couvre 1er, 2e-3e, top 10 de la spec)
const TOP_N = 10;

/**
 * Période courante au format 'YYYY-MM' (UTC).
 * @returns {string}
 */
function currentPeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Clôt une compétition : calcule les gagnants depuis les QuizSession et fige le résultat.
 *
 * @param {import('mongoose').Types.ObjectId|string} competitionId
 * @returns {Promise<{ winners: number }>}
 */
const closeCompetition = async (competitionId) => {
  const competition = await CompetitionPrize.findById(competitionId);
  if (!competition) {
    console.warn(`[CompetitionClosing] Competition ${competitionId} not found.`);
    return { winners: 0 };
  }
  if (!competition.isActive) {
    return { winners: 0 };
  }

  // Meilleures sessions de la période pour ce campus — une session par token (déjà unique)
  const topSessions = await QuizSession.find({
    schoolCampus: competition.schoolCampus,
    period:       competition.period,
    completedAt:  { $ne: null },
  })
    .sort({ score: -1, completedAt: 1 }) // meilleur score, puis le plus rapide à finir
    .limit(TOP_N)
    .select('_id lead displayName score')
    .lean();

  competition.winners = topSessions.map((s, idx) => ({
    rank:        idx + 1,
    quizSession: s._id,
    lead:        s.lead || null,
    displayName: s.displayName || null,
    score:       s.score || 0,
    notifiedAt:  null, // Phase 3
  }));
  competition.isActive = false;

  await competition.save();

  const brandName = process.env.BRAND_NAME || process.env.NEXT_PUBLIC_BRAND_NAME || 'AcadERP';
  const { notified } = await notifyWinners(competition, PartnerLead, brandName);

  console.log(
    `[CompetitionClosing] Closed competition ${competition.period} (campus ${competition.schoolCampus}) — ${competition.winners.length} winner(s), ${notified} notified.`
  );
  return { winners: competition.winners.length };
};

/**
 * Job cron : clôt toutes les compétitions actives dont la période est révolue.
 *
 * @returns {Promise<{ closed: number, totalWinners: number }>}
 */
const runCompetitionClosingJob = async () => {
  const period = currentPeriod();

  // Actives ET d'une période strictement antérieure à la période courante
  const due = await CompetitionPrize.find({
    isActive: true,
    period:   { $lt: period },
  })
    .select('_id')
    .lean();

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
