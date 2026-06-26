'use strict';

/**
 * @file notification.service.js
 * @description Winner notification service for the monthly competition (spec §4.5 / Phase 3).
 *
 * Sends email (Resend) and/or SMS (Africa's Talking) to competition winners
 * when their contact details are available (via the linked PartnerLead).
 *
 * Both integrations are opt-in: the service silently skips any channel whose
 * env vars are absent, so the app stays functional without the credentials.
 *
 * Environment variables:
 *   RESEND_API_KEY       — Resend API key (email)
 *   RESEND_FROM_EMAIL    — sender address, e.g. "notifications@ecole.com"
 *   AT_API_KEY           — Africa's Talking API key (SMS)
 *   AT_USERNAME          — Africa's Talking username (use 'sandbox' for testing)
 *   AT_SENDER_ID         — Africa's Talking shortcode/sender ID (optional)
 */

const repo = require('./public-portal.repository');

// ── Lazy-load integrations (no crash when packages are absent) ────────────────

let Resend = null;
let AfricasTalking = null;

try {
  Resend = require('resend').Resend;
} catch {
  // resend package not installed — email notifications disabled
}

try {
  AfricasTalking = require('africastalking');
} catch {
  // africastalking package not installed — SMS notifications disabled
}

// ── Client factories (created once, reused across calls) ─────────────────────

function getResendClient() {
  if (!Resend || !process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

function getAtSmsClient() {
  if (!AfricasTalking || !process.env.AT_API_KEY || !process.env.AT_USERNAME) return null;
  const at = AfricasTalking({
    apiKey:   process.env.AT_API_KEY,
    username: process.env.AT_USERNAME,
  });
  return at.SMS;
}

// ── Email notification ────────────────────────────────────────────────────────

/**
 * Sends a congratulatory email to a winner.
 *
 * @param {object} opts
 * @param {string} opts.toEmail
 * @param {string} opts.firstName
 * @param {string} opts.rank        e.g. '1st', '2nd', '3rd'
 * @param {string} opts.brandName
 * @param {string} opts.period      e.g. '2026-05'
 * @param {string} [opts.prizeDescription]
 * @returns {Promise<boolean>} true on success, false on skip/error
 */
async function sendWinnerEmail({ toEmail, firstName, rank, brandName, period, prizeDescription, lang = 'fr' }) {
  const client = getResendClient();
  if (!client) {
    console.log('[Notification] Email skipped — Resend not configured.');
    return false;
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || `notifications@${brandName?.toLowerCase().replace(/\s+/g, '')}.com`;

  const subject = lang === 'en'
    ? `🏆 Congratulations, ${firstName}! You won the ${period} quiz — ${brandName}`
    : `🏆 Félicitations, ${firstName} ! Vous avez gagné au quiz ${period} — ${brandName}`;

  const html = lang === 'en'
    ? `
    <h2>Congratulations, ${firstName}!</h2>
    <p>You finished <strong>${rank}</strong> in the monthly <strong>${brandName}</strong> quiz for ${period}.</p>
    ${prizeDescription ? `<p>Your reward: <strong>${prizeDescription}</strong></p>` : ''}
    <p>Our team will contact you shortly to hand over your prize.</p>
    <p>Keep it up!<br><em>The ${brandName} team</em></p>
  `
    : `
    <h2>Félicitations, ${firstName} !</h2>
    <p>Vous avez terminé <strong>${rank}</strong> au quiz mensuel de <strong>${brandName}</strong> pour la période ${period}.</p>
    ${prizeDescription ? `<p>Votre récompense : <strong>${prizeDescription}</strong></p>` : ''}
    <p>Notre équipe vous contactera prochainement pour vous remettre votre prix.</p>
    <p>Bonne continuation !<br><em>L'équipe ${brandName}</em></p>
  `;

  try {
    await client.emails.send({ from: fromEmail, to: toEmail, subject, html });
    return true;
  } catch (err) {
    console.error('[Notification] Email send error:', err?.message);
    return false;
  }
}

// ── SMS notification ──────────────────────────────────────────────────────────

/**
 * Sends a congratulatory SMS to a winner.
 *
 * @param {object} opts
 * @param {string} opts.toPhone     E.164 format, e.g. '+237612345678'
 * @param {string} opts.firstName
 * @param {string} opts.rank
 * @param {string} opts.brandName
 * @param {string} opts.period
 * @returns {Promise<boolean>} true on success, false on skip/error
 */
async function sendWinnerSms({ toPhone, firstName, rank, brandName, period, lang = 'fr' }) {
  const smsClient = getAtSmsClient();
  if (!smsClient) {
    console.log('[Notification] SMS skipped — Africa\'s Talking not configured.');
    return false;
  }

  const message = lang === 'en'
    ? `Congratulations ${firstName}! You are ${rank} in the ${brandName} quiz (${period}). Our team will contact you soon about your prize.`
    : `Félicitations ${firstName} ! Vous êtes ${rank} au quiz ${brandName} (${period}). Notre équipe vous contacte bientôt pour votre prix.`;

  const opts = {
    to:      [toPhone],
    message,
  };
  if (process.env.AT_SENDER_ID) opts.from = process.env.AT_SENDER_ID;

  try {
    await smsClient.send(opts);
    return true;
  } catch (err) {
    console.error('[Notification] SMS send error:', err?.message);
    return false;
  }
}

// ── Rank label helper ─────────────────────────────────────────────────────────

function rankLabel(rank, lang = 'fr') {
  if (lang === 'en') {
    const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
    return `${rank}${suffix}`;
  }
  return rank === 1 ? '1er' : `${rank}ème`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Notifies all un-notified winners of a competition.
 * Sets notifiedAt on each winner entry after a successful notification.
 *
 * @param {import('mongoose').Document} competition  CompetitionPrize document (not lean)
 * @param {string} [brandName]
 * @returns {Promise<{ notified: number, skipped: number }>}
 */
async function notifyWinners(competition, brandName = 'AcadERP') {
  // Winner contact details via the partner facade (the PartnerLead model
  // belongs to the partner module).
  const { getLeadContact } = require('../partner').service;
  const period = competition.period;

  // Notification language = the campus operating language (fr default). Leads
  // carry no locale, so the campus default is the best available signal for a
  // globally deployed institution.
  let lang = 'fr';
  try {
    const campus = await require('../campus').service
      .getActiveCampusById(competition.schoolCampus, 'defaultLanguage');
    if (campus?.defaultLanguage === 'en') lang = 'en';
  } catch {
    // Campus unresolved — fall back to French.
  }

  let notified = 0;
  let skipped  = 0;

  for (const winner of competition.winners) {
    if (winner.notifiedAt) {
      skipped++;
      continue;
    }

    const label = rankLabel(winner.rank, lang);
    let emailSent = false;
    let smsSent   = false;

    // Try to find the PartnerLead for contact details
    if (winner.lead) {
      const lead = await getLeadContact(winner.lead);

      if (lead) {
        const prizeItem = competition.prizes?.find((p) => p.rank === winner.rank);
        // Prefer the description in the notification language, fall back to the
        // other locale so a winner is never sent an empty reward line.
        const prizeDesc = prizeItem?.description?.[lang]
          ?? prizeItem?.description?.fr
          ?? prizeItem?.description?.en
          ?? null;

        if (lead.email) {
          emailSent = await sendWinnerEmail({
            toEmail:          lead.email,
            firstName:        lead.firstName,
            rank:             label,
            brandName,
            period,
            prizeDescription: prizeDesc,
            lang,
          });
        }

        if (lead.phone) {
          smsSent = await sendWinnerSms({
            toPhone:   lead.phone,
            firstName: lead.firstName,
            rank:      label,
            brandName,
            period,
            lang,
          });
        }
      }
    } else {
      // Anonymous winner (no linked lead) — can't notify
      skipped++;
      continue;
    }

    if (emailSent || smsSent) {
      winner.notifiedAt = new Date();
      notified++;
    } else {
      skipped++;
    }
  }

  if (notified > 0) {
    await repo.saveCompetitionDoc(competition);
  }

  return { notified, skipped };
}

module.exports = { notifyWinners, sendWinnerEmail, sendWinnerSms };
