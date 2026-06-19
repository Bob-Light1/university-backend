#!/usr/bin/env node
/**
 * seed-testimonials.js
 *
 * Inserts published testimonials for all campuses (or a specific campus).
 * Populates the portal in the absence of an admin UI (Phase 2 — React admin deferred).
 *
 * Usage:
 *   node scripts/seed-testimonials.js                          → all campuses
 *   node scripts/seed-testimonials.js --slug=campus-douala     → a single campus
 *   node scripts/seed-testimonials.js --dry-run                → preview without inserting
 *   node scripts/seed-testimonials.js --clear                  → deletes and re-inserts
 */

'use strict';

require('dotenv').config();
const mongoose    = require('mongoose');
const Campus      = require('../modules/campus/campus.model');
const Testimonial = require('../modules/public-portal/models/testimonial.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const SLUG_ARG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1];

// Testimonials bank (bilingual fr/en quote)
const TESTIMONIALS = [
  {
    firstName: 'Awa', city: 'Douala', graduationYear: 2024, program: 'Développement Web',
    employer: 'Orange Cameroun', order: 1,
    quote: {
      fr: "Trois mois après la formation, j'ai décroché mon premier contrat de développeuse. La pratique au quotidien a tout changé.",
      en: "Three months after the program, I landed my first developer contract. The daily hands-on practice changed everything.",
    },
  },
  {
    firstName: 'Boris', city: 'Yaoundé', graduationYear: 2023, program: 'Comptabilité',
    employer: 'Cabinet Ndongo & Associés', order: 2,
    quote: {
      fr: "Je tiens aujourd'hui la comptabilité de trois PME de mon quartier. La formation était concrète et adaptée au terrain.",
      en: "I now handle the accounting of three small businesses in my neighborhood. The training was concrete and field-ready.",
    },
  },
  {
    firstName: 'Mariam', city: 'Bafoussam', graduationYear: 2024, program: 'Marketing Digital',
    employer: null, order: 3,
    quote: {
      fr: "J'ai lancé ma propre agence de community management. Les clients viennent surtout par WhatsApp et Instagram.",
      en: "I started my own community management agency. Most clients come through WhatsApp and Instagram.",
    },
  },
  {
    firstName: 'Eric', city: 'Douala', graduationYear: 2022, program: 'Développement Web',
    employer: 'Freelance', order: 4,
    quote: {
      fr: "Le réseau d'anciens m'a aidé à trouver mes premières missions. On reste soudés même après la formation.",
      en: "The alumni network helped me find my first gigs. We stay connected long after graduation.",
    },
  },
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\n✅ Connecté à MongoDB\n');

  const query = SLUG_ARG ? { campusSlug: SLUG_ARG, status: 'active' } : { status: 'active' };
  const campuses = await Campus.find(query).select('_id campus_name campusSlug').lean();

  if (!campuses.length) {
    console.log('❌ Aucun campus actif trouvé' + (SLUG_ARG ? ` avec le slug "${SLUG_ARG}"` : '') + '.');
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 ${campuses.length} campus ciblé(s) : ${campuses.map(c => c.campus_name).join(', ')}`);
  console.log(`📝 ${TESTIMONIALS.length} témoignages dans la banque\n`);

  for (const campus of campuses) {
    const existing = await Testimonial.countDocuments({ schoolCampus: campus._id });

    if (existing > 0 && !CLEAR) {
      console.log(`⏭  "${campus.campus_name}" — ${existing} témoignage(s) déjà en base. (--clear pour réinitialiser)`);
      continue;
    }
    if (CLEAR && existing > 0 && !DRY_RUN) {
      await Testimonial.deleteMany({ schoolCampus: campus._id });
      console.log(`🗑  "${campus.campus_name}" — ${existing} témoignage(s) supprimé(s)`);
    }

    const docs = TESTIMONIALS.map(t => ({ ...t, schoolCampus: campus._id, isPublished: true }));

    if (!DRY_RUN) {
      await Testimonial.insertMany(docs, { ordered: false });
      console.log(`✅ "${campus.campus_name}" — ${docs.length} témoignages insérés`);
    } else {
      console.log(`🔍 (dry-run) "${campus.campus_name}" — ${docs.length} témoignages à insérer`);
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
