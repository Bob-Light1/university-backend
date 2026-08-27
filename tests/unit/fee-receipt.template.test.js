'use strict';

/**
 * The fee receipt's HTML (`modules/finance/fee-receipt.template.js`) — pure, so
 * it is tested without a browser and without a database.
 *
 * What matters here is what a student can hold up at the desk: the figures agree
 * with the ledger, the number is stable, the document is written in the reader's
 * language, and no field can close a tag.
 *
 * Design note: `docs/architecture/features/fee-receipts-and-reminders.md` §2, §9④, §9⑥.
 */

const { buildReceiptHtml, receiptNumberOf } = require('../../modules/finance/fee-receipt.template');
const catalog = require('../../shared/i18n/catalogs/finance');
const FeePayment = require('../../modules/finance/models/feePayment.model');

const ISSUED = new Date('2026-06-15T09:00:00.000Z');

/**
 * Matches a figure whatever group separator `Intl` chose (comma, plain space,
 * no-break or narrow no-break space): the assertion is on the AMOUNT, not on
 * the ICU version of the host.
 */
const amount = (...groups) => new RegExp(groups.join('[^0-9]?'));

const build = (over = {}) => buildReceiptHtml({
  payment: {
    _id: '507f1f77bcf86cd799439abc',
    amount: 50000, currency: 'XAF', method: 'Cash', reference: 'PAY-A-001',
    paidAt: new Date('2026-06-01T10:00:00.000Z'),
    ...over.payment,
  },
  fee: { label: 'Tuition', academicYear: '2025-2026', amountDue: 150000, amountPaid: 50000, currency: 'XAF', ...over.fee },
  student: { firstName: 'Ada', lastName: 'Lovelace', matricule: 'STU-A-001', ...over.student },
  branding: { campus_name: 'Campus A', location: { city: 'Douala', country: 'Cameroun' }, ...over.branding },
  locale: over.locale,
  issuedAt: over.issuedAt || ISSUED,
});

describe('receiptNumberOf', () => {
  test('la référence saisie EST le numéro de reçu — aucun compteur concurrent (§2)', () => {
    expect(receiptNumberOf({ _id: 'x', reference: 'PAY-A-001' })).toBe('PAY-A-001');
  });

  test('sans référence, un rendu court de l\'id immuable, stable dans le temps', () => {
    const payment = { _id: '507f1f77bcf86cd799439abc' };
    expect(receiptNumberOf(payment)).toBe('PAY-99439ABC');
    expect(receiptNumberOf(payment)).toBe(receiptNumberOf({ ...payment }));
  });
});

describe('buildReceiptHtml — le document', () => {
  test('est autonome : un seul fichier, aucune ressource distante', () => {
    const html = build();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    // A fetch at print time would make the render depend on the network — the
    // logo arrives already inlined as a data: URL from getCampusBranding().
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script/);
  });

  test('porte l\'identité de l\'encaissement et de l\'étudiant', () => {
    const html = build();
    expect(html).toContain('PAY-A-001');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('STU-A-001');
    expect(html).toContain('Campus A');
    expect(html).toContain('Douala, Cameroun');
  });

  test('les totaux viennent de la dette, jamais recalculés depuis le paiement', () => {
    // The ledger and the reminders already read `amountDue` / `amountPaid`; a
    // receipt that disagreed with the ledger is the document the student brings
    // back to the desk.
    const html = build({ fee: { amountDue: 150000, amountPaid: 50000 } });
    expect(html).toMatch(amount('150', '000')); // total due
    expect(html).toMatch(amount('100', '000')); // remaining balance
  });

  test('une dette soldée affiche « soldé », pas un zéro', () => {
    const html = build({ fee: { amountDue: 150000, amountPaid: 150000 }, locale: 'fr' });
    expect(html).toContain(catalog.settled.fr);
  });

  test('le mode de paiement est traduit depuis l\'enum du modèle', () => {
    const html = build({ payment: { method: 'Bank Transfer' }, locale: 'fr' });
    expect(html).toContain('Virement bancaire');
  });

  test('un mode absent du catalogue s\'imprime brut plutôt que vide', () => {
    // Deliberate (catalog header): a missing translation is a gap; a receipt
    // that refuses to render is a payment the student cannot prove.
    const html = build({ payment: { method: 'Crypto' } });
    expect(html).toContain('Crypto');
  });

  test('la référence n\'est pas imprimée deux fois quand elle EST le numéro', () => {
    const html = build();
    expect(html.match(/PAY-A-001/g)).toHaveLength(1);
  });

  test('les champs absents ne laissent ni « undefined » ni « null » sur le papier', () => {
    const html = buildReceiptHtml({
      payment: { _id: '507f1f77bcf86cd799439abc', amount: 1000, method: 'Cash' },
      fee: {},
      issuedAt: ISSUED,
    });
    expect(html).not.toMatch(/undefined|null|NaN/);
    expect(html).toContain('—'); // an absent date renders as an em dash
  });
});

describe('buildReceiptHtml — la langue du lecteur (§9⑥)', () => {
  test('rend les libellés dans la langue demandée', () => {
    const html = build({ locale: 'fr' });
    expect(html).toContain(catalog.receiptTitle.fr);
    expect(html).toContain(catalog.receiptNumber.fr);
    expect(html).toContain('lang="fr"');
  });

  test('replie sur l\'anglais pour une locale inconnue, sans clé brute', () => {
    const html = build({ locale: 'xx' });
    expect(html).toContain(catalog.receiptTitle.en);
    expect(html).not.toContain('receiptTitle');
  });

  test('l\'arabe bascule le document en rtl, mise en page comprise', () => {
    const html = build({ locale: 'ar' });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(catalog.receiptTitle.ar);
    // The accent rule moves to the other edge — a left border on an RTL sheet
    // would sit against the text instead of framing it.
    expect(html).toContain('border-right:3px solid');
  });

  test('la date est écrite avec la table de locales partagée avec les bulletins', () => {
    expect(build({ locale: 'fr' })).toContain('1 juin 2026');
    // `en` maps to en-GB in the shared table — the receipt does not get to pick
    // its own date format any more than a transcript does.
    expect(build({ locale: 'en' })).toContain('1 June 2026');
  });

  test('la devise de la dette décide du format, jamais un suffixe en dur', () => {
    expect(build({ payment: { currency: 'EUR', amount: 1234.5 }, locale: 'fr' })).toMatch(amount('1', '234,50'));
    // XAF has no minor unit — a hard-coded ".00" would be wrong here.
    expect(build({ locale: 'fr' })).not.toMatch(amount('50', '000,00'));
  });

  test('une devise que le runtime refuse ne fait pas échouer le reçu', () => {
    const html = build({ payment: { currency: 'XYZ123' } });
    expect(html).toContain('50');
  });
});

describe('buildReceiptHtml — échappement', () => {
  test('un nom d\'étudiant ne peut pas fermer une balise', () => {
    const html = build({ student: { firstName: '<script>alert(1)</script>', lastName: 'X' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('une référence ne peut pas s\'échapper d\'un attribut', () => {
    const html = build({ payment: { reference: '" onload="x' } });
    expect(html).not.toContain('" onload="x');
    expect(html).toContain('&quot;');
  });

  test('le nom du campus est échappé lui aussi — il vient de la base', () => {
    const html = build({ branding: { campus_name: 'A & <b>B</b>' } });
    expect(html).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
  });
});

describe('couverture du catalogue finance', () => {
  // Same guard as the notifications catalog: a leaf short of one language
  // prints an English label on a French student's receipt.
  const leaves = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (key === 'methods') {
      for (const [method, dict] of Object.entries(value)) leaves.push([`methods.${method}`, dict]);
    } else {
      leaves.push([key, value]);
    }
  }

  test('le catalogue contient des entrées', () => {
    expect(leaves.length).toBeGreaterThan(0);
  });

  test.each(leaves)('%s couvre les 10 langues sans texte vide', (_id, dict) => {
    for (const lang of require('../../shared/i18n').SUPPORTED_LANGUAGES) {
      expect(typeof dict[lang]).toBe('string');
      expect(dict[lang].trim().length).toBeGreaterThan(0);
    }
  });

  test('chaque mode de paiement du modèle a son libellé (source de vérité : l\'enum)', () => {
    const methods = FeePayment.schema.path('method').enumValues;
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(catalog.methods[method]).toBeDefined();
  });
});
