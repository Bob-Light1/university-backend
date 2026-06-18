/**
 * @file finance.service.js
 * API publique du module finance (income / suivi paiement étudiant).
 * (Les autres domaines ne touchent JAMAIS directement ces models — §3 du guide.)
 * Toute la persistance passe par finance.repository (étape 0 pré-Postgres).
 */

const financeRepo  = require('./finance.repository');
const notification = require('../notification').service;

/**
 * Nombre de paiements (income) en attente pour un campus.
 * (Consommé par campus.controller pour les paymentAlerts du dashboard.)
 * @param {string|ObjectId} campusId
 * @returns {Promise<number>}
 */
function countPendingIncomes(campusId) {
  return financeRepo.countByCampusAndStatus(campusId, 'pending');
}

// ── Suivi paiement étudiant ───────────────────────────────────────────────────

/**
 * Notifie l'étudiant (in-app + email) d'un solde à régler. Fire-and-forget : un
 * échec d'envoi ne doit jamais bloquer l'opération comptable (même contrat que
 * les autres émetteurs). Contact (email) et langue résolus via les façades
 * student/settings — finance n'interroge jamais leurs models (façade §3).
 * @param {Object} fee  dette (lean, avec virtuel `balance`)
 */
async function notifyBalanceDue(fee) {
  const balance = fee.balance ?? Math.max(0, (fee.amountDue || 0) - (fee.amountPaid || 0));
  if (balance <= 0) return;
  try {
    // Contact + langue via les façades (finance ne touche pas le model Student ;
    // langue depuis UserPreferences, source unique).
    const [contact, locale] = await Promise.all([
      require('../student').service.getStudentContact(fee.student),
      require('../settings').service.getPreferredLanguage(fee.student),
    ]);
    await notification.notify({
      recipient: { id: fee.student, model: 'Student', campusId: fee.schoolCampus, email: contact?.email },
      channels: ['inapp', 'email'], // email inerte sans SMTP → skipped
      template: 'payment.reminder',
      locale,
      data: {
        amount: balance,
        currency: fee.currency,
        dueDate: fee.dueDate ? new Date(fee.dueDate).toISOString().slice(0, 10) : '—',
      },
    });
  } catch (err) {
    console.error('[notify] payment.reminder failed:', err.message);
  }
}

/**
 * Crée une dette pour un étudiant et l'informe du solde dû (in-app).
 * @param {Object} input { student, schoolCampus, label, academicYear?, amountDue, currency?, dueDate?, notes?, createdBy? }
 * @returns {Promise<Object>} la dette créée (lean + balance)
 */
async function createFee(input) {
  const doc = await financeRepo.createFee(input);
  const fee = doc.toObject({ virtuals: true });
  notifyBalanceDue(fee);
  return fee;
}

/**
 * Impute un acompte sur une dette : crée la ligne FeePayment, met à jour le
 * cumul `amountPaid` (le statut est recalculé au save), et renvoie l'état à jour.
 *
 * Garde-fous : montant > 0, devise alignée sur la dette, pas de surpaiement
 * au-delà du solde restant, dette non annulée.
 *
 * @param {Object} params { feeId, amount, method, reference?, paidAt?, notes?, recordedBy, scope? }
 * @returns {Promise<{ fee: Object, payment: Object }>}
 */
async function recordPayment({ feeId, amount, method, reference, paidAt, notes, recordedBy, scope = {} }) {
  const feeDoc = await financeRepo.getFeeDoc(feeId, scope);
  if (!feeDoc) throw Object.assign(new Error('Fee not found'), { code: 'NOT_FOUND' });
  if (feeDoc.status === 'cancelled') {
    throw Object.assign(new Error('Cannot pay a cancelled fee'), { code: 'INVALID' });
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('amount must be greater than 0'), { code: 'INVALID' });
  }

  const balance = Math.max(0, (feeDoc.amountDue || 0) - (feeDoc.amountPaid || 0));
  if (value > balance) {
    throw Object.assign(
      new Error(`amount ${value} exceeds remaining balance ${balance}`),
      { code: 'INVALID' },
    );
  }

  const payment = await financeRepo.createPayment({
    fee:          feeDoc._id,
    student:      feeDoc.student,
    schoolCampus: feeDoc.schoolCampus,
    amount:       value,
    currency:     feeDoc.currency,
    method,
    reference:    reference || undefined,
    paidAt:       paidAt || new Date(),
    notes,
    recordedBy,
  });

  feeDoc.amountPaid = (feeDoc.amountPaid || 0) + value; // pre-save recalcule le statut
  await feeDoc.save();

  return {
    fee: feeDoc.toObject({ virtuals: true }),
    payment: typeof payment.toObject === 'function' ? payment.toObject() : payment,
  };
}

/**
 * Relevé complet d'un étudiant : dettes + paiements + totaux.
 * @param {string|ObjectId} studentId
 * @param {Object} [scope] filtre additionnel (ex: { schoolCampus })
 * @returns {Promise<{ fees, payments, totals }>}
 */
async function getStudentLedger(studentId, scope = {}) {
  const [fees, payments] = await Promise.all([
    financeRepo.findFeesByStudent(studentId, scope),
    financeRepo.findPaymentsByStudent(studentId),
  ]);
  const totals = fees.reduce(
    (acc, f) => {
      acc.totalDue  += f.amountDue || 0;
      acc.totalPaid += f.amountPaid || 0;
      return acc;
    },
    { totalDue: 0, totalPaid: 0 },
  );
  totals.balance = Math.max(0, totals.totalDue - totals.totalPaid);
  return { fees, payments, totals };
}

/** Liste paginée des dettes (filtre déjà scopé campus par l'appelant). */
function listFees({ filter, skip, limit }) {
  return financeRepo.paginateFees({ filter, skip, limit });
}

/** Une dette avec ses paiements. @returns {Promise<{ fee, payments }|null>} */
async function getFeeWithPayments(feeId, scope = {}) {
  const fee = await financeRepo.findFeeById(feeId, scope);
  if (!fee) return null;
  const payments = await financeRepo.findPaymentsByFee(feeId);
  return { fee, payments };
}

/** Soft-delete d'une dette. @returns {Promise<Object|null>} */
function deleteFee(feeId, scope = {}) {
  return financeRepo.softDeleteFee(feeId, scope);
}

/** (Ré)envoie un rappel de solde pour une dette donnée. @returns {Promise<Object|null>} */
async function remindBalance(feeId, scope = {}) {
  const fee = await financeRepo.findFeeById(feeId, scope);
  if (!fee) return null;
  await notifyBalanceDue(fee);
  return fee;
}

/**
 * Cron : passe les dettes échues impayées en `overdue` et envoie un rappel.
 * Best-effort (n'interrompt pas le lot sur un échec d'envoi).
 * @returns {Promise<{ processed: number }>}
 */
async function runOverdueJob() {
  const due = await financeRepo.findOverdueFees(new Date(), 100);
  for (const fee of due) {
    const doc = await financeRepo.getFeeDoc(fee._id);
    if (!doc) continue;
    await doc.save(); // pre-save recalcule → overdue
    await notifyBalanceDue(doc.toObject({ virtuals: true }));
  }
  if (due.length) console.log(`💸 [finance] overdue sweep: ${due.length} fee(s) processed`);
  return { processed: due.length };
}

module.exports = {
  countPendingIncomes,
  createFee,
  recordPayment,
  getStudentLedger,
  listFees,
  getFeeWithPayments,
  deleteFee,
  remindBalance,
  runOverdueJob,
};
