'use strict';
/** @file prepare-whatsapp.js @description Expand-only WhatsApp index preparation and exact template submission export. */
const mongoose = require('mongoose');
const Usage = require('../modules/notification/models/whatsapp-usage.model');
const Notification = require('../modules/notification/models/notification.model');
const { submissionCatalog } = require('../modules/notification/whatsapp.templates');
/** Inspect by default; only explicitly applied preparation creates collections/indexes. */
async function prepareWhatsapp({ apply = false } = {}) {
  const report = [];
  for (const Model of [Usage, Notification]) {
    report.push({ model: Model.modelName, indexes: Model.schema.indexes().length });
    if (apply) { await Model.createCollection(); await Model.createIndexes(); }
  }
  return { applied: apply, collections: report };
}
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    if (process.argv.includes('--catalog')) return console.log(JSON.stringify(submissionCatalog(), null, 2));
    const apply = process.argv.includes('--apply');
    if (apply) {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
      await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    }
    console.log(JSON.stringify(await prepareWhatsapp({ apply })));
  })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
}
module.exports = { prepareWhatsapp };
