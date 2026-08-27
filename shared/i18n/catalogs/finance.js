'use strict';

/**
 * @file shared/i18n/catalogs/finance.js — finance document catalog.
 *
 * Labels printed on the fee receipt (`modules/finance/fee-receipt.template.js`).
 * Structure: key → dictionary { lang: text }, resolved by `pick` in
 * `shared/i18n/index.js` — same shape as `catalogs/academic-print.js`, so the
 * receipt reads like the transcript a student receives from the same campus.
 *
 * `methods` is keyed by the FeePayment.method enum values, which are the
 * backend's source of truth: adding a payment method to the model and not here
 * prints the raw enum value rather than failing, and that is deliberate — a
 * receipt that shows "Bank Transfer" to a French reader is a translation gap; a
 * receipt that refuses to render is a payment the student cannot prove.
 *
 * Languages: en, fr, es, ar, zh-CN, de, pt, it, ru, ja.
 */

module.exports = {
  receiptTitle: {
    en: 'Payment receipt', fr: 'Reçu de paiement', es: 'Recibo de pago',
    ar: 'إيصال دفع', 'zh-CN': '付款收据', de: 'Zahlungsbeleg',
    pt: 'Recibo de pagamento', it: 'Ricevuta di pagamento',
    ru: 'Квитанция об оплате', ja: '領収書',
  },
  receiptNumber: {
    en: 'Receipt no.', fr: 'N° de reçu', es: 'N.º de recibo',
    ar: 'رقم الإيصال', 'zh-CN': '收据编号', de: 'Belegnummer',
    pt: 'N.º do recibo', it: 'N. ricevuta', ru: '№ квитанции', ja: '領収書番号',
  },
  paidOn: {
    en: 'Paid on', fr: 'Payé le', es: 'Pagado el', ar: 'تاريخ الدفع',
    'zh-CN': '付款日期', de: 'Bezahlt am', pt: 'Pago em', it: 'Pagato il',
    ru: 'Дата оплаты', ja: 'お支払日',
  },
  student: {
    en: 'Student', fr: 'Étudiant', es: 'Estudiante', ar: 'الطالب',
    'zh-CN': '学生', de: 'Studierende(r)', pt: 'Estudante', it: 'Studente',
    ru: 'Студент', ja: '学生',
  },
  matricule: {
    en: 'Student ID', fr: 'Matricule', es: 'Matrícula', ar: 'رقم التسجيل',
    'zh-CN': '学号', de: 'Matrikelnummer', pt: 'Matrícula', it: 'Matricola',
    ru: 'Номер студента', ja: '学籍番号',
  },
  feeLabel: {
    en: 'Fee', fr: 'Frais', es: 'Concepto', ar: 'الرسوم', 'zh-CN': '费用项目',
    de: 'Gebühr', pt: 'Taxa', it: 'Contributo', ru: 'Платёж', ja: '費目',
  },
  academicYear: {
    en: 'Academic year', fr: 'Année académique', es: 'Año académico',
    ar: 'السنة الدراسية', 'zh-CN': '学年', de: 'Studienjahr',
    pt: 'Ano letivo', it: 'Anno accademico', ru: 'Учебный год', ja: '学年度',
  },
  method: {
    en: 'Payment method', fr: 'Mode de paiement', es: 'Método de pago',
    ar: 'طريقة الدفع', 'zh-CN': '付款方式', de: 'Zahlungsart',
    pt: 'Forma de pagamento', it: 'Metodo di pagamento',
    ru: 'Способ оплаты', ja: 'お支払方法',
  },
  amountPaid: {
    en: 'Amount received', fr: 'Montant encaissé', es: 'Importe recibido',
    ar: 'المبلغ المستلم', 'zh-CN': '收款金额', de: 'Erhaltener Betrag',
    pt: 'Valor recebido', it: 'Importo ricevuto', ru: 'Полученная сумма',
    ja: '受領金額',
  },
  totalDue: {
    en: 'Total due', fr: 'Total dû', es: 'Total adeudado', ar: 'إجمالي المستحق',
    'zh-CN': '应付总额', de: 'Gesamtbetrag', pt: 'Total devido',
    it: 'Totale dovuto', ru: 'Итого к оплате', ja: '請求総額',
  },
  totalPaid: {
    en: 'Total paid', fr: 'Total réglé', es: 'Total pagado', ar: 'إجمالي المدفوع',
    'zh-CN': '已付总额', de: 'Bezahlt gesamt', pt: 'Total pago',
    it: 'Totale pagato', ru: 'Итого оплачено', ja: '入金済合計',
  },
  balance: {
    en: 'Remaining balance', fr: 'Solde restant dû', es: 'Saldo pendiente',
    ar: 'الرصيد المتبقي', 'zh-CN': '剩余欠款', de: 'Restbetrag',
    pt: 'Saldo em dívida', it: 'Saldo residuo', ru: 'Остаток к оплате',
    ja: '残高',
  },
  settled: {
    en: 'Settled in full', fr: 'Soldé', es: 'Totalmente pagado',
    ar: 'مسدد بالكامل', 'zh-CN': '已结清', de: 'Vollständig beglichen',
    pt: 'Totalmente liquidado', it: 'Saldato', ru: 'Полностью оплачено',
    ja: '完納',
  },
  recordedBy: {
    en: 'Recorded by', fr: 'Encaissé par', es: 'Registrado por',
    ar: 'سُجل بواسطة', 'zh-CN': '经办人', de: 'Erfasst von',
    pt: 'Registado por', it: 'Registrato da', ru: 'Принял', ja: '受付担当',
  },
  reference: {
    en: 'Reference', fr: 'Référence', es: 'Referencia', ar: 'المرجع',
    'zh-CN': '交易参考号', de: 'Referenz', pt: 'Referência',
    it: 'Riferimento', ru: 'Референс', ja: '取引番号',
  },
  issuedOn: {
    en: 'Issued on', fr: 'Édité le', es: 'Emitido el', ar: 'صدر في',
    'zh-CN': '开具日期', de: 'Ausgestellt am', pt: 'Emitido em',
    it: 'Emesso il', ru: 'Выдано', ja: '発行日',
  },
  computerGenerated: {
    en: 'Computer-generated receipt — valid without signature.',
    fr: 'Reçu généré automatiquement — valable sans signature.',
    es: 'Recibo generado automáticamente: válido sin firma.',
    ar: 'إيصال صادر آليًا — صالح بدون توقيع.',
    'zh-CN': '本收据由系统生成，无需签字即有效。',
    de: 'Maschinell erstellter Beleg — ohne Unterschrift gültig.',
    pt: 'Recibo gerado automaticamente — válido sem assinatura.',
    it: 'Ricevuta generata automaticamente — valida senza firma.',
    ru: 'Квитанция сформирована автоматически — действительна без подписи.',
    ja: 'このシステム発行の領収書は、署名がなくても有効です。',
  },

  // Keyed by the FeePayment.method enum (backend source of truth).
  methods: {
    Cash: {
      en: 'Cash', fr: 'Espèces', es: 'Efectivo', ar: 'نقدًا', 'zh-CN': '现金',
      de: 'Bargeld', pt: 'Numerário', it: 'Contanti', ru: 'Наличные', ja: '現金',
    },
    'Mobile Money': {
      en: 'Mobile Money', fr: 'Mobile Money', es: 'Mobile Money',
      ar: 'محفظة إلكترونية', 'zh-CN': '移动支付', de: 'Mobile Money',
      pt: 'Mobile Money', it: 'Mobile Money', ru: 'Мобильный платёж',
      ja: 'モバイルマネー',
    },
    'Bank Transfer': {
      en: 'Bank transfer', fr: 'Virement bancaire', es: 'Transferencia bancaria',
      ar: 'تحويل بنكي', 'zh-CN': '银行转账', de: 'Banküberweisung',
      pt: 'Transferência bancária', it: 'Bonifico bancario',
      ru: 'Банковский перевод', ja: '銀行振込',
    },
    Cheque: {
      en: 'Cheque', fr: 'Chèque', es: 'Cheque', ar: 'شيك', 'zh-CN': '支票',
      de: 'Scheck', pt: 'Cheque', it: 'Assegno', ru: 'Чек', ja: '小切手',
    },
  },
};
