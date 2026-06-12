#!/usr/bin/env node
/**
 * seed-competition-prizes.js
 *
 * Crée la compétition mensuelle (barème de prix) pour la période courante 'YYYY-MM',
 * pour tous les campus (ou un précis). closingDate = dernier jour du mois à 23:59 UTC.
 *
 * Usage :
 *   node scripts/seed-competition-prizes.js                       → tous les campus
 *   node scripts/seed-competition-prizes.js --slug=campus-douala  → un seul campus
 *   node scripts/seed-competition-prizes.js --dry-run             → aperçu sans insertion
 *   node scripts/seed-competition-prizes.js --clear               → supprime la période courante et réinsère
 */

'use strict';

require('dotenv').config();
const mongoose         = require('mongoose');
const Campus           = require('../models/campus.model');
const CompetitionPrize = require('../modules/public-portal/models/competition.prize.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const SLUG_ARG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1];

// Période courante 'YYYY-MM' + clôture en fin de mois (UTC)
const now = new Date();
const PERIOD = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const CLOSING_DATE = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));

// Barème (spec §4.5) — description bilingue
const PRIZES = [
  {
    rank: 1, value: '-20% + certificat',
    description: { fr: 'Réduction de 20% sur les frais + certificat numérique', en: '20% tuition discount + digital certificate' },
  },
  {
    rank: 2, value: '-10% + certificat',
    description: { fr: 'Réduction de 10% sur les frais + certificat numérique', en: '10% tuition discount + digital certificate' },
  },
  {
    rank: 3, value: '-10% + certificat',
    description: { fr: 'Réduction de 10% sur les frais + certificat numérique', en: '10% tuition discount + digital certificate' },
  },
  {
    rank: 10, value: 'Badge numérique',
    description: { fr: 'Badge numérique partageable (Top 10)', en: 'Shareable digital badge (Top 10)' },
  },
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\n✅ Connecté à MongoDB\n');
  console.log(`🏆 Période : ${PERIOD} — clôture ${CLOSING_DATE.toISOString()}\n`);

  const query = SLUG_ARG ? { campusSlug: SLUG_ARG, status: 'active' } : { status: 'active' };
  const campuses = await Campus.find(query).select('_id campus_name campusSlug').lean();

  if (!campuses.length) {
    console.log('❌ Aucun campus actif trouvé' + (SLUG_ARG ? ` avec le slug "${SLUG_ARG}"` : '') + '.');
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 ${campuses.length} campus ciblé(s) : ${campuses.map(c => c.campus_name).join(', ')}\n`);

  for (const campus of campuses) {
    const existing = await CompetitionPrize.findOne({ schoolCampus: campus._id, period: PERIOD }).select('_id').lean();

    if (existing && !CLEAR) {
      console.log(`⏭  "${campus.campus_name}" — compétition ${PERIOD} déjà en base. (--clear pour réinitialiser)`);
      continue;
    }
    if (existing && CLEAR && !DRY_RUN) {
      await CompetitionPrize.deleteOne({ _id: existing._id });
      console.log(`🗑  "${campus.campus_name}" — compétition ${PERIOD} supprimée`);
    }

    const doc = {
      schoolCampus: campus._id,
      period:       PERIOD,
      prizes:       PRIZES,
      isActive:     true,
      closingDate:  CLOSING_DATE,
      winners:      [],
    };

    if (!DRY_RUN) {
      await CompetitionPrize.create(doc);
      console.log(`✅ "${campus.campus_name}" — compétition ${PERIOD} créée (${PRIZES.length} prix)`);
    } else {
      console.log(`🔍 (dry-run) "${campus.campus_name}" — compétition ${PERIOD} à créer (${PRIZES.length} prix)`);
    }
  }

  console.log('\n' + '─'.repeat(50));
  if (DRY_RUN) console.log('(Mode dry-run — aucune écriture en base)');
  await mongoose.disconnect();
  console.log('✅ Déconnecté.\n');
}

run().catch(err => {
  console.error('❌ Erreur :', err.message);
  mongoose.disconnect();
  process.exit(1);
});
