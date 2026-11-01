'use strict';
/** @file whatsapp.repository.js @description Atomic UTC-month cost accounting. */
const Usage = require('./models/whatsapp-usage.model');
/** Reserve conservatively before a possible provider submission; never refund ambiguity. */
async function reserve(schoolCampus, month, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return false;
  const indexes = await Usage.collection.indexes();
  if (!indexes.some(index => index.unique === true
    && !index.partialFilterExpression && !index.sparse && index.expireAfterSeconds === undefined
    && Object.keys(index.key).length === 2 && index.key.schoolCampus === 1 && index.key.month === 1)) {
    throw new Error('WhatsApp usage requires its installed unique campus/month index');
  }
  try {
    await Usage.updateOne({ schoolCampus, month }, { $setOnInsert: { used: 0 } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const result = await Usage.updateOne({ schoolCampus, month, used: { $lt: limit } }, { $inc: { used: 1 } });
  return result.modifiedCount === 1;
}
/** Read one campus bucket; absent means no submissions. */
const usage = (schoolCampus, month) => Usage.findOne({ schoolCampus, month }).lean();
module.exports = { reserve, usage };
