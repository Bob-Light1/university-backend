#!/usr/bin/env node
/**
 * seed-course-previews.js
 *
 * Insère des aperçus de cours publiés (bilingues) pour tous les campus (ou un précis).
 *
 * Usage :
 *   node scripts/seed-course-previews.js                       → tous les campus
 *   node scripts/seed-course-previews.js --slug=campus-douala  → un seul campus
 *   node scripts/seed-course-previews.js --dry-run             → aperçu sans insertion
 *   node scripts/seed-course-previews.js --clear               → supprime et réinsère
 */

'use strict';

require('dotenv').config();
const mongoose      = require('mongoose');
const Campus        = require('../models/campus.model');
const CoursePreview = require('../models/partner-models/course.preview.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const SLUG_ARG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1];

const PREVIEWS = [
  {
    program: 'Développement Web', order: 1, videoUrl: null,
    title: { fr: 'Votre première page web en 10 minutes', en: 'Your first web page in 10 minutes' },
    content: {
      fr: "Le HTML structure le contenu, le CSS l'habille. Dans cette leçon d'introduction, vous écrivez votre première page : un titre, un paragraphe et un lien. Pas besoin d'outil compliqué — un simple éditeur de texte et un navigateur suffisent pour commencer.",
      en: "HTML structures content, CSS styles it. In this intro lesson you write your first page: a heading, a paragraph and a link. No complex tooling needed — a plain text editor and a browser are enough to start.",
    },
  },
  {
    program: 'Comptabilité', order: 2, videoUrl: null,
    title: { fr: 'Comprendre le bilan en une page', en: 'Understand the balance sheet in one page' },
    content: {
      fr: "Le bilan est une photographie du patrimoine de l'entreprise à un instant donné. À gauche, l'actif (ce que l'entreprise possède) ; à droite, le passif (ce qu'elle doit). Les deux côtés s'équilibrent toujours — c'est le principe de la partie double.",
      en: "The balance sheet is a snapshot of a company's assets at a point in time. On the left, assets (what the company owns); on the right, liabilities (what it owes). Both sides always balance — that's double-entry accounting.",
    },
  },
  {
    program: 'Marketing Digital', order: 3, videoUrl: null,
    title: { fr: 'WhatsApp Business : votre premier canal de vente', en: 'WhatsApp Business: your first sales channel' },
    content: {
      fr: "En Afrique, WhatsApp est souvent le premier point de contact client. Un catalogue produit, des réponses rapides et un statut bien utilisé suffisent à transformer des conversations en ventes. Cette leçon montre comment structurer votre compte professionnel.",
      en: "In Africa, WhatsApp is often the first customer touchpoint. A product catalog, quick replies and a well-used status are enough to turn conversations into sales. This lesson shows how to structure your business account.",
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
  console.log(`📝 ${PREVIEWS.length} aperçus dans la banque\n`);

  for (const campus of campuses) {
    const existing = await CoursePreview.countDocuments({ schoolCampus: campus._id });

    if (existing > 0 && !CLEAR) {
      console.log(`⏭  "${campus.campus_name}" — ${existing} aperçu(s) déjà en base. (--clear pour réinitialiser)`);
      continue;
    }
    if (CLEAR && existing > 0 && !DRY_RUN) {
      await CoursePreview.deleteMany({ schoolCampus: campus._id });
      console.log(`🗑  "${campus.campus_name}" — ${existing} aperçu(s) supprimé(s)`);
    }

    const docs = PREVIEWS.map(p => ({ ...p, schoolCampus: campus._id, isPublished: true }));

    if (!DRY_RUN) {
      await CoursePreview.insertMany(docs, { ordered: false });
      console.log(`✅ "${campus.campus_name}" — ${docs.length} aperçus insérés`);
    } else {
      console.log(`🔍 (dry-run) "${campus.campus_name}" — ${docs.length} aperçus à insérer`);
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
