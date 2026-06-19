#!/usr/bin/env node
/**
 * seed-faq.js
 *
 * Inserts published FAQ entries (bilingual) for all campuses (or a specific one).
 *
 * Usage:
 *   node scripts/seed-faq.js                       → all campuses
 *   node scripts/seed-faq.js --slug=campus-douala  → a single campus
 *   node scripts/seed-faq.js --dry-run             → preview without inserting
 *   node scripts/seed-faq.js --clear               → deletes and re-inserts
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Campus   = require('../modules/campus/campus.model');
const FaqEntry = require('../modules/public-portal/models/faq.entry.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const SLUG_ARG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1];

const FAQ = [
  {
    category: 'inscription', order: 1,
    question: {
      fr: "Comment se déroule la pré-inscription ?",
      en: "How does pre-registration work?",
    },
    answer: {
      fr: "Remplissez le formulaire en ligne avec vos coordonnées et la formation qui vous intéresse. Notre équipe vous recontacte sous 48h pour finaliser votre dossier.",
      en: "Fill out the online form with your contact details and the program you're interested in. Our team will reach out within 48 hours to finalize your file.",
    },
  },
  {
    category: 'tarifs', order: 2,
    question: {
      fr: "Le paiement peut-il se faire en plusieurs fois ?",
      en: "Can I pay in installments?",
    },
    answer: {
      fr: "Oui. Les frais de formation peuvent être réglés en plusieurs tranches. Les modalités exactes sont précisées lors de l'entretien d'inscription.",
      en: "Yes. Tuition can be paid in several installments. The exact terms are confirmed during the enrollment interview.",
    },
  },
  {
    category: 'formations', order: 3,
    question: {
      fr: "Faut-il un diplôme pour s'inscrire ?",
      en: "Do I need a diploma to enroll?",
    },
    answer: {
      fr: "La plupart de nos formations sont accessibles sans diplôme préalable. La motivation et un test de positionnement suffisent pour démarrer.",
      en: "Most of our programs are open without a prior diploma. Motivation and a placement test are enough to get started.",
    },
  },
  {
    category: 'formations', order: 4,
    question: {
      fr: "Les cours sont-ils en présentiel ou à distance ?",
      en: "Are classes in person or online?",
    },
    answer: {
      fr: "Nos formations sont principalement en présentiel sur le campus, avec des ressources en ligne accessibles à tout moment.",
      en: "Our programs are mainly held in person on campus, with online resources available at any time.",
    },
  },
  {
    category: 'inscription', order: 5,
    question: {
      fr: "Quand commence la prochaine session ?",
      en: "When does the next session start?",
    },
    answer: {
      fr: "Une nouvelle cohorte ouvre chaque trimestre. Inscrivez-vous à l'alerte de session pour être notifié dès l'ouverture.",
      en: "A new cohort opens every quarter. Subscribe to session alerts to be notified as soon as it opens.",
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
  console.log(`📝 ${FAQ.length} entrées FAQ dans la banque\n`);

  for (const campus of campuses) {
    const existing = await FaqEntry.countDocuments({ schoolCampus: campus._id });

    if (existing > 0 && !CLEAR) {
      console.log(`⏭  "${campus.campus_name}" — ${existing} entrée(s) déjà en base. (--clear pour réinitialiser)`);
      continue;
    }
    if (CLEAR && existing > 0 && !DRY_RUN) {
      await FaqEntry.deleteMany({ schoolCampus: campus._id });
      console.log(`🗑  "${campus.campus_name}" — ${existing} entrée(s) supprimée(s)`);
    }

    const docs = FAQ.map(f => ({ ...f, schoolCampus: campus._id, isPublished: true }));

    if (!DRY_RUN) {
      await FaqEntry.insertMany(docs, { ordered: false });
      console.log(`✅ "${campus.campus_name}" — ${docs.length} entrées FAQ insérées`);
    } else {
      console.log(`🔍 (dry-run) "${campus.campus_name}" — ${docs.length} entrées à insérer`);
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
