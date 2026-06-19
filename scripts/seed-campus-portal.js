#!/usr/bin/env node
/**
 * seed-campus-portal.js
 *
 * Populates the portal fields on existing Campus documents:
 *   - campusSlug  (derived from campus_name if absent)
 *   - programs    (list of programs)
 *   - nextBatchDate
 *
 * Usage:
 *   node scripts/seed-campus-portal.js              → applies the changes
 *   node scripts/seed-campus-portal.js --dry-run    → prints without modifying
 *   node scripts/seed-campus-portal.js --list       → lists all existing campuses
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Campus   = require('../modules/campus/campus.model');

const DRY_RUN  = process.argv.includes('--dry-run');
const LIST_ONLY = process.argv.includes('--list');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — Edit this array according to your actual campuses
// Each object must have:
//   match     : portion of campus_name (case-insensitive) to identify the campus
//   slug      : unique URL identifier, lowercase, hyphens only
//   programs  : programs shown in the pre-registration form
//   nextBatch : date of the next cohort (null if not yet defined)
// ─────────────────────────────────────────────────────────────────────────────
const CAMPUS_CONFIG = [
  {
    match:     'fouda',
    slug:      'campus-fouda',
    programs:  [
      'Développement Web & Mobile',
      'Comptabilité & Gestion',
      'Marketing Digital',
      'Administration des Systèmes',
    ],
    nextBatch: '2026-09-01',
    stats:     { studentsTrained: 2400, placementRate: 85, partnerCompanies: 120 },
  },
  {
    match:     'douala',
    slug:      'campus-douala',
    programs:  [
      'Développement Web & Mobile',
      'Comptabilité & Gestion',
      'Marketing Digital',
    ],
    nextBatch: '2026-09-15',
    stats:     { studentsTrained: 1800, placementRate: 82, partnerCompanies: 90 },
  },
  {
    match:     'bafoussam',
    slug:      'campus-bafoussam',
    programs:  [
      'Développement Web & Mobile',
      'Comptabilité & Gestion',
    ],
    nextBatch: null,
    stats:     { studentsTrained: 950, placementRate: 78, partnerCompanies: 45 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Generates a slug from campus_name if no config matches
// ─────────────────────────────────────────────────────────────────────────────
function autoSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strips accents
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}

function findConfig(campusName) {
  return CAMPUS_CONFIG.find(c =>
    campusName.toLowerCase().includes(c.match.toLowerCase())
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('\n✅ Connecté à MongoDB\n');

  const campuses = await Campus.find({}).lean();
  console.log(`📋 ${campuses.length} campus trouvé(s) dans la base\n`);

  if (LIST_ONLY) {
    campuses.forEach((c, i) => {
      console.log(`  ${i + 1}. "${c.campus_name}"`);
      console.log(`     _id       : ${c._id}`);
      console.log(`     campusSlug: ${c.campusSlug || '(vide)'}`);
      console.log(`     programs  : ${c.programs?.length ? c.programs.join(', ') : '(vide)'}`);
      console.log(`     nextBatch : ${c.nextBatchDate || '(vide)'}`);
      console.log('');
    });
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const campus of campuses) {
    const config = findConfig(campus.campus_name);
    const slug   = config?.slug ?? campus.campusSlug ?? autoSlug(campus.campus_name);

    const alreadyComplete =
      campus.campusSlug &&
      campus.programs?.length > 0 &&
      campus.portalStats?.studentsTrained != null;

    if (alreadyComplete) {
      console.log(`⏭  "${campus.campus_name}" — déjà configuré (slug: ${campus.campusSlug})`);
      skipped++;
      continue;
    }

    const patch = {};

    if (!campus.campusSlug) {
      patch.campusSlug = slug;
    }

    if (!campus.programs?.length && config?.programs) {
      patch.programs = config.programs;
    }

    if (!campus.nextBatchDate && config?.nextBatch) {
      patch.nextBatchDate = new Date(config.nextBatch);
    }

    if (config?.stats && campus.portalStats?.studentsTrained == null) {
      patch.portalStats = config.stats;
    }

    console.log(`🔧  "${campus.campus_name}"`);
    console.log(`    campusSlug  → ${patch.campusSlug  || campus.campusSlug}`);
    console.log(`    programs    → ${(patch.programs || campus.programs)?.join(', ') || '(inchangé)'}`);
    console.log(`    nextBatch   → ${patch.nextBatchDate || campus.nextBatchDate || '(inchangé)'}`);
    console.log(`    stats       → ${JSON.stringify(patch.portalStats || campus.portalStats || '(inchangé)')}`);

    if (!DRY_RUN && Object.keys(patch).length > 0) {
      await Campus.updateOne({ _id: campus._id }, { $set: patch });
      console.log(`    ✅ Mis à jour`);
    } else if (DRY_RUN) {
      console.log(`    🔍 (dry-run — aucune modification)`);
    }

    console.log('');
    updated++;
  }

  console.log('─'.repeat(50));
  console.log(`Résultat : ${updated} mis à jour, ${skipped} déjà configuré(s)`);
  if (DRY_RUN) console.log('(Mode dry-run — aucune écriture en base)');

  await mongoose.disconnect();
  console.log('\n✅ Déconnecté.\n');
}

run().catch(err => {
  console.error('❌ Erreur :', err.message);
  mongoose.disconnect();
  process.exit(1);
});
