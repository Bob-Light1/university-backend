'use strict';

/** @file prepare-admission.js @description Expand-only admission index preparation; historical enrollments are reported, never converted. */
const mongoose = require('mongoose');
const Lead = require('../modules/partner/models/partner.lead.model');
const Attachment = require('../modules/partner/models/admission.attachment.model');
const { Counter } = require('../shared/db/counter.model');
const { LEAD_STATUS } = require('../shared/constants/admission.constants');

/** Inspect by default; apply creates indexes/technical counter only and never rewrites business records. */
async function prepareAdmission({ apply = false } = {}) {
  const historicalEnrolledWithoutStudent = await Lead.countDocuments({ status: LEAD_STATUS.ENROLLED, student: null });
  if (apply) {
    await Attachment.createCollection();
    await Attachment.createIndexes();
    await Lead.createIndexes();
    await Counter.updateOne({ _id: 'student-creation' }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  }
  return { applied: apply, historicalEnrolledWithoutStudent, historicalRecordsChanged: 0 };
}

/** CLI uses the explicitly configured database; no connection occurs on import. */
async function main() {
  require('dotenv').config({ quiet: true });
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(JSON.stringify(await prepareAdmission({ apply: process.argv.includes('--apply') }), null, 2));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareAdmission };
