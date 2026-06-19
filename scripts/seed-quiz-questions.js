#!/usr/bin/env node
/**
 * seed-quiz-questions.js
 *
 * Inserts quiz questions for all campuses (or a specific campus).
 * The questions are published (isPublished: true) and ready for the portal.
 *
 * Usage:
 *   node scripts/seed-quiz-questions.js                          → all campuses
 *   node scripts/seed-quiz-questions.js --slug=campus-bafoussam  → a single campus
 *   node scripts/seed-quiz-questions.js --dry-run               → preview without inserting
 *   node scripts/seed-quiz-questions.js --clear                 → delete and reinsert
 */

'use strict';

require('dotenv').config();
const mongoose    = require('mongoose');
const Campus      = require('../modules/campus/campus.model');
const QuizQuestion = require('../modules/public-portal/models/quiz.question.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const CLEAR    = process.argv.includes('--clear');
const SLUG_ARG = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1];

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION BANK (fr)
// Structure: { category, text, options: [A,B,C,D], correctIndex (0-3), difficulty, lang }
// ─────────────────────────────────────────────────────────────────────────────
const QUESTIONS = [

  // ── WEB DEVELOPMENT ────────────────────────────────────────────────────
  {
    category: 'web', difficulty: 'easy', lang: 'fr',
    text: 'Que signifie l\'acronyme HTML ?',
    options: ['HyperText Markup Language', 'HighText Machine Language', 'HyperText and links Markup Language', 'None of the above'],
    correctIndex: 0,
  },
  {
    category: 'web', difficulty: 'easy', lang: 'fr',
    text: 'Quelle balise HTML est utilisée pour créer un lien hypertexte ?',
    options: ['<link>', '<a>', '<href>', '<url>'],
    correctIndex: 1,
  },
  {
    category: 'web', difficulty: 'easy', lang: 'fr',
    text: 'Quel langage est principalement utilisé pour styliser une page web ?',
    options: ['HTML', 'Python', 'CSS', 'Java'],
    correctIndex: 2,
  },
  {
    category: 'web', difficulty: 'medium', lang: 'fr',
    text: 'Quelle méthode HTTP est utilisée pour envoyer des données de formulaire de manière sécurisée ?',
    options: ['GET', 'POST', 'PUT', 'HEAD'],
    correctIndex: 1,
  },
  {
    category: 'web', difficulty: 'medium', lang: 'fr',
    text: 'Que retourne `typeof null` en JavaScript ?',
    options: ['"null"', '"undefined"', '"object"', '"boolean"'],
    correctIndex: 2,
  },
  {
    category: 'web', difficulty: 'medium', lang: 'fr',
    text: 'Qu\'est-ce qu\'une API REST ?',
    options: [
      'Un style d\'architecture pour systèmes distribués basé sur HTTP',
      'Un langage de programmation pour le web',
      'Un framework JavaScript',
      'Un protocole de sécurité réseau',
    ],
    correctIndex: 0,
  },
  {
    category: 'web', difficulty: 'medium', lang: 'fr',
    text: 'Laquelle de ces structures n\'est PAS un framework JavaScript front-end ?',
    options: ['React', 'Vue', 'Angular', 'Django'],
    correctIndex: 3,
  },
  {
    category: 'web', difficulty: 'hard', lang: 'fr',
    text: 'Quelle est la complexité temporelle d\'une recherche dans un tableau de hash bien conçu ?',
    options: ['O(n)', 'O(log n)', 'O(1)', 'O(n²)'],
    correctIndex: 2,
  },
  {
    category: 'web', difficulty: 'hard', lang: 'fr',
    text: 'Que signifie CORS dans le contexte du développement web ?',
    options: [
      'Cross-Origin Resource Sharing',
      'Client-Origin Request System',
      'Cross-Object Rendering Standard',
      'Content Ownership Rights System',
    ],
    correctIndex: 0,
  },
  {
    category: 'web', difficulty: 'hard', lang: 'fr',
    text: 'En SQL, quelle clause est utilisée pour filtrer les groupes résultant d\'un GROUP BY ?',
    options: ['WHERE', 'FILTER', 'HAVING', 'LIMIT'],
    correctIndex: 2,
  },

  // ── ACCOUNTING ─────────────────────────────────────────────────────────
  {
    category: 'accounting', difficulty: 'easy', lang: 'fr',
    text: 'Que représente le bilan comptable ?',
    options: [
      'Les résultats de l\'entreprise sur l\'année',
      'La situation du patrimoine de l\'entreprise à une date donnée',
      'La liste des clients de l\'entreprise',
      'Le plan de financement prévisionnel',
    ],
    correctIndex: 1,
  },
  {
    category: 'accounting', difficulty: 'easy', lang: 'fr',
    text: 'Qu\'est-ce que la TVA ?',
    options: [
      'Taxe sur la Valeur Ajoutée',
      'Taxe sur les Ventes Annuelles',
      'Taux de Variation des Actifs',
      'Transfert de Valeur aux Actionnaires',
    ],
    correctIndex: 0,
  },
  {
    category: 'accounting', difficulty: 'easy', lang: 'fr',
    text: 'La comptabilité en partie double signifie que :',
    options: [
      'On enregistre chaque opération deux fois dans le même compte',
      'Tout débit a un crédit correspondant d\'un montant égal',
      'On tient deux livres comptables simultanément',
      'Les comptes sont vérifiés deux fois par an',
    ],
    correctIndex: 1,
  },
  {
    category: 'accounting', difficulty: 'medium', lang: 'fr',
    text: 'Quel est le résultat net si le chiffre d\'affaires est 500 000 FCFA et les charges totales 380 000 FCFA ?',
    options: ['880 000 FCFA', '120 000 FCFA', '380 000 FCFA', '500 000 FCFA'],
    correctIndex: 1,
  },
  {
    category: 'accounting', difficulty: 'medium', lang: 'fr',
    text: 'Parmi ces éléments, lequel appartient au passif du bilan ?',
    options: ['Stocks', 'Créances clients', 'Emprunts bancaires', 'Immobilisations'],
    correctIndex: 2,
  },
  {
    category: 'accounting', difficulty: 'medium', lang: 'fr',
    text: 'Qu\'est-ce qu\'un amortissement comptable ?',
    options: [
      'Le remboursement progressif d\'un emprunt',
      'La dépréciation constatée d\'un bien immobilisé sur sa durée de vie',
      'Une réduction accordée à un client fidèle',
      'Un excédent de trésorerie placé',
    ],
    correctIndex: 1,
  },
  {
    category: 'accounting', difficulty: 'hard', lang: 'fr',
    text: 'Le seuil de rentabilité (point mort) est atteint quand :',
    options: [
      'Le chiffre d\'affaires couvre les charges variables uniquement',
      'Le résultat net est positif',
      'La marge sur coût variable couvre exactement les charges fixes',
      'Les dettes sont inférieures aux capitaux propres',
    ],
    correctIndex: 2,
  },
  {
    category: 'accounting', difficulty: 'hard', lang: 'fr',
    text: 'Qu\'est-ce que le fonds de roulement net global (FRNG) ?',
    options: [
      'Ressources stables − Emplois stables',
      'Actif circulant − Passif circulant',
      'Chiffre d\'affaires − Charges variables',
      'Capitaux propres − Dettes financières',
    ],
    correctIndex: 0,
  },
  {
    category: 'accounting', difficulty: 'hard', lang: 'fr',
    text: 'Parmi ces ratios, lequel mesure la liquidité immédiate de l\'entreprise ?',
    options: [
      'Résultat net / Chiffre d\'affaires',
      'Disponibilités / Dettes à court terme',
      'Capitaux propres / Total bilan',
      'EBE / Chiffre d\'affaires',
    ],
    correctIndex: 1,
  },
  {
    category: 'accounting', difficulty: 'easy', lang: 'fr',
    text: 'Un journal comptable sert à :',
    options: [
      'Classer les comptes par nature',
      'Enregistrer les opérations dans l\'ordre chronologique',
      'Calculer le résultat de l\'exercice',
      'Récapituler les soldes des comptes',
    ],
    correctIndex: 1,
  },

  // ── DIGITAL MARKETING ────────────────────────────────────────────────────
  {
    category: 'marketing', difficulty: 'easy', lang: 'fr',
    text: 'Que signifie SEO ?',
    options: [
      'Social Engagement Optimization',
      'Search Engine Optimization',
      'Sales and Email Operations',
      'Subscriber Engagement Online',
    ],
    correctIndex: 1,
  },
  {
    category: 'marketing', difficulty: 'easy', lang: 'fr',
    text: 'Quel réseau social est principalement utilisé pour le marketing B2B ?',
    options: ['TikTok', 'Snapchat', 'LinkedIn', 'Pinterest'],
    correctIndex: 2,
  },
  {
    category: 'marketing', difficulty: 'easy', lang: 'fr',
    text: 'Qu\'est-ce qu\'un KPI en marketing ?',
    options: [
      'Un outil de création de contenu',
      'Un indicateur clé de performance',
      'Un type de publicité payante',
      'Un logiciel de gestion de campagne',
    ],
    correctIndex: 1,
  },
  {
    category: 'marketing', difficulty: 'medium', lang: 'fr',
    text: 'Le taux de conversion d\'une boutique en ligne est de 3 %. Si 2 000 personnes visitent le site, combien d\'achats sont réalisés ?',
    options: ['20', '200', '60', '600'],
    correctIndex: 2,
  },
  {
    category: 'marketing', difficulty: 'medium', lang: 'fr',
    text: 'Qu\'est-ce qu\'un tunnel de conversion (funnel) ?',
    options: [
      'Un système de filtrage des emails indésirables',
      'Le parcours qu\'un prospect suit jusqu\'à l\'achat',
      'Un outil d\'analyse des concurrents',
      'Une technique de référencement payant',
    ],
    correctIndex: 1,
  },
  {
    category: 'marketing', difficulty: 'medium', lang: 'fr',
    text: 'Que mesure le CTR (Click-Through Rate) ?',
    options: [
      'Le nombre total d\'impressions d\'une publicité',
      'Le coût moyen par clic sur une annonce',
      'Le pourcentage de personnes qui cliquent après avoir vu une annonce',
      'Le taux de rebond d\'un site web',
    ],
    correctIndex: 2,
  },
  {
    category: 'marketing', difficulty: 'hard', lang: 'fr',
    text: 'Quelle stratégie consiste à cibler des utilisateurs qui ont déjà visité votre site ?',
    options: ['Inbound marketing', 'Retargeting', 'Growth hacking', 'Content seeding'],
    correctIndex: 1,
  },
  {
    category: 'marketing', difficulty: 'hard', lang: 'fr',
    text: 'Dans le modèle AARRR (Pirate Metrics), que représente le deuxième "R" ?',
    options: ['Rétention', 'Revenus', 'Référencement', 'Réputation'],
    correctIndex: 1,
  },
  {
    category: 'marketing', difficulty: 'hard', lang: 'fr',
    text: 'Quelle est la différence principale entre le SEO et le SEA ?',
    options: [
      'Le SEO est gratuit et organique ; le SEA est payant (liens sponsorisés)',
      'Le SEO cible les réseaux sociaux ; le SEA cible les moteurs de recherche',
      'Le SEO est immédiat ; le SEA est long terme',
      'Le SEO utilise des vidéos ; le SEA utilise des textes',
    ],
    correctIndex: 0,
  },
  {
    category: 'marketing', difficulty: 'easy', lang: 'fr',
    text: 'Quel outil Google permet de mesurer le trafic d\'un site web ?',
    options: ['Google Ads', 'Google Analytics', 'Google Search Console', 'Google Tag Manager'],
    correctIndex: 1,
  },

  // ── GENERAL KNOWLEDGE ─────────────────────────────────────────────────────
  {
    category: 'general', difficulty: 'easy', lang: 'fr',
    text: 'Quelle est la capitale du Cameroun ?',
    options: ['Douala', 'Yaoundé', 'Bafoussam', 'Limbé'],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'easy', lang: 'fr',
    text: 'Combien y a-t-il de régions au Cameroun ?',
    options: ['8', '10', '12', '15'],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'easy', lang: 'fr',
    text: 'Quelle est la monnaie utilisée au Cameroun ?',
    options: ['Euro', 'Dollar américain', 'Franc CFA (FCFA)', 'Naira'],
    correctIndex: 2,
  },
  {
    category: 'general', difficulty: 'medium', lang: 'fr',
    text: 'Qu\'est-ce que l\'intelligence artificielle (IA) ?',
    options: [
      'Un logiciel qui remplace tous les humains',
      'La simulation de l\'intelligence humaine par des machines',
      'Un réseau social basé sur des robots',
      'Un système de sécurité informatique',
    ],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'medium', lang: 'fr',
    text: 'Qu\'est-ce que l\'entrepreneuriat ?',
    options: [
      'L\'art de travailler pour une grande entreprise',
      'La création et gestion d\'une activité économique propre en prenant des risques',
      'Le fait d\'investir en bourse',
      'Un diplôme en gestion d\'entreprise',
    ],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'medium', lang: 'fr',
    text: 'Parmi ces compétences, laquelle est considérée comme une "soft skill" ?',
    options: ['Maîtrise d\'Excel', 'Communication et travail en équipe', 'Programmation Python', 'Gestion de bases de données'],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'hard', lang: 'fr',
    text: 'Que signifie l\'acronyme OHADA ?',
    options: [
      'Organisation pour l\'Harmonisation en Afrique du Droit des Affaires',
      'Office d\'Harmonisation des Accords de Développement en Afrique',
      'Organisation des Hommes d\'Affaires et Directeurs d\'Afrique',
      'Office Humanitaire d\'Aide au Développement Africain',
    ],
    correctIndex: 0,
  },
  {
    category: 'general', difficulty: 'hard', lang: 'fr',
    text: 'Quelle organisation internationale regroupe les pays d\'Afrique centrale pour la coopération économique ?',
    options: ['CEDEAO', 'CEMAC', 'SADC', 'COMESA'],
    correctIndex: 1,
  },
  {
    category: 'general', difficulty: 'hard', lang: 'fr',
    text: 'Dans le cadre du télétravail, qu\'est-ce qu\'un VPN ?',
    options: [
      'Un réseau privé virtuel qui sécurise la connexion internet',
      'Un logiciel de visioconférence',
      'Un protocole d\'envoi d\'emails chiffrés',
      'Un outil de gestion de projet en ligne',
    ],
    correctIndex: 0,
  },
  {
    category: 'general', difficulty: 'easy', lang: 'fr',
    text: 'Combien de langues officielles le Cameroun possède-t-il ?',
    options: ['1', '2', '3', '4'],
    correctIndex: 1,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\n✅ Connecté à MongoDB\n');

  const query = SLUG_ARG
    ? { campusSlug: SLUG_ARG, status: 'active' }
    : { status: 'active' };

  const campuses = await Campus.find(query).select('_id campus_name campusSlug').lean();

  if (!campuses.length) {
    console.log('❌ Aucun campus actif trouvé' + (SLUG_ARG ? ` avec le slug "${SLUG_ARG}"` : '') + '.');
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 ${campuses.length} campus ciblé(s) : ${campuses.map(c => c.campus_name).join(', ')}\n`);
  console.log(`📝 ${QUESTIONS.length} questions dans la banque\n`);

  for (const campus of campuses) {
    const existing = await QuizQuestion.countDocuments({ schoolCampus: campus._id });

    if (existing > 0 && !CLEAR) {
      console.log(`⏭  "${campus.campus_name}" — ${existing} question(s) déjà en base. (--clear pour réinitialiser)`);
      continue;
    }

    if (CLEAR && existing > 0) {
      if (!DRY_RUN) {
        await QuizQuestion.deleteMany({ schoolCampus: campus._id });
        console.log(`🗑  "${campus.campus_name}" — ${existing} question(s) supprimée(s)`);
      } else {
        console.log(`🗑  (dry-run) "${campus.campus_name}" — ${existing} à supprimer`);
      }
    }

    const docs = QUESTIONS.map(q => ({
      ...q,
      schoolCampus: campus._id,
      isPublished:  true,
    }));

    if (!DRY_RUN) {
      await QuizQuestion.insertMany(docs, { ordered: false });
      console.log(`✅ "${campus.campus_name}" — ${docs.length} questions insérées`);
    } else {
      console.log(`🔍 (dry-run) "${campus.campus_name}" — ${docs.length} questions à insérer`);
      const byCategory = {};
      docs.forEach(d => { byCategory[d.category] = (byCategory[d.category] || 0) + 1; });
      Object.entries(byCategory).forEach(([cat, n]) => console.log(`    ${cat}: ${n}`));
    }
    console.log('');
  }

  console.log('─'.repeat(50));
  if (DRY_RUN) console.log('(Mode dry-run — aucune écriture en base)');

  await mongoose.disconnect();
  console.log('✅ Déconnecté.\n');
}

run().catch(err => {
  console.error('❌ Erreur :', err.message);
  mongoose.disconnect();
  process.exit(1);
});
