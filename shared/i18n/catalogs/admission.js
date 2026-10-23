'use strict';

/** @file admission.js @description Localized private-dossier and admission outcome messages. */
const subject = {
  en: 'Your admission dossier', fr: 'Votre dossier d’admission', es: 'Su expediente de admisión',
  ar: 'ملف قبولك', 'zh-CN': '您的入学申请档案', de: 'Ihre Bewerbungsunterlagen',
  pt: 'O seu processo de admissão', it: 'La sua domanda di ammissione', ru: 'Ваше заявление о поступлении', ja: '入学申請書類について',
};
module.exports = {
  'admission.access': { email: { subject, body: {
    en: 'Hello {name}, complete your dossier with this private link: {link}. It expires in 72 hours. Do not share it.',
    fr: 'Bonjour {name}, complétez votre dossier avec ce lien privé : {link}. Il expire dans 72 heures. Ne le partagez pas.',
    es: 'Hola {name}, complete su expediente con este enlace privado: {link}. Caduca en 72 horas. No lo comparta.',
    ar: 'مرحبًا {name}، أكمل ملفك عبر هذا الرابط الخاص: {link}. تنتهي صلاحيته بعد 72 ساعة. لا تشاركه.',
    'zh-CN': '{name}，您好。请通过此私人链接完善申请档案：{link}。链接将在72小时后失效，请勿分享。',
    de: 'Hallo {name}, vervollständigen Sie Ihre Unterlagen über diesen privaten Link: {link}. Er ist 72 Stunden gültig. Teilen Sie ihn nicht.',
    pt: 'Olá {name}, complete o seu processo através desta ligação privada: {link}. Expira em 72 horas. Não a partilhe.',
    it: 'Gentile {name}, completi la domanda con questo collegamento privato: {link}. Scade tra 72 ore. Non lo condivida.',
    ru: 'Здравствуйте, {name}! Заполните заявление по личной ссылке: {link}. Она действует 72 часа. Не передавайте её другим.',
    ja: '{name} 様、専用リンクから申請書類を提出してください：{link}。有効期限は72時間です。他の人と共有しないでください。',
  } } },
  'admission.admitted': { email: { subject, body: {
    en: 'Hello {name}, your admission has been approved. Contact your campus to finalize enrollment.',
    fr: 'Bonjour {name}, votre admission est approuvée. Contactez votre campus pour finaliser votre inscription.',
    es: 'Hola {name}, su admisión ha sido aprobada. Contacte con su campus para finalizar la matrícula.',
    ar: 'مرحبًا {name}، تمت الموافقة على قبولك. تواصل مع الحرم الجامعي لإتمام التسجيل.',
    'zh-CN': '{name}，您好。您的入学申请已获批准。请联系校区完成注册。',
    de: 'Hallo {name}, Ihre Zulassung wurde genehmigt. Kontaktieren Sie Ihren Campus, um die Einschreibung abzuschließen.',
    pt: 'Olá {name}, a sua admissão foi aprovada. Contacte o campus para concluir a inscrição.',
    it: 'Gentile {name}, la sua ammissione è stata approvata. Contatti il campus per completare l’iscrizione.',
    ru: 'Здравствуйте, {name}! Ваше поступление одобрено. Свяжитесь с кампусом для завершения зачисления.',
    ja: '{name} 様、入学が承認されました。登録の完了についてキャンパスにお問い合わせください。',
  } } },
  'admission.enrolled': { email: { subject, body: {
    en: 'Hello {name}, your enrollment is confirmed. A separate activation message lets you choose your password. Contact your campus if it does not arrive.',
    fr: 'Bonjour {name}, votre inscription est confirmée. Un message d’activation séparé vous permet de choisir votre mot de passe. Contactez votre campus si vous ne le recevez pas.',
    es: 'Hola {name}, su matrícula está confirmada. Otro mensaje de activación le permitirá elegir su contraseña. Contacte con el campus si no lo recibe.',
    ar: 'مرحبًا {name}، تم تأكيد تسجيلك. تتيح لك رسالة تفعيل منفصلة اختيار كلمة المرور. تواصل مع الحرم الجامعي إذا لم تصلك.',
    'zh-CN': '{name}，您好。您的注册已确认。您将通过另一封账户激活邮件设置密码。如未收到，请联系校区。',
    de: 'Hallo {name}, Ihre Einschreibung ist bestätigt. Eine separate Aktivierungsnachricht ermöglicht die Wahl Ihres Passworts. Kontaktieren Sie den Campus, falls sie nicht ankommt.',
    pt: 'Olá {name}, a sua inscrição está confirmada. Uma mensagem de ativação separada permite escolher a palavra-passe. Contacte o campus se não a receber.',
    it: 'Gentile {name}, l’iscrizione è confermata. Un messaggio di attivazione separato permette di scegliere la password. Contatti il campus se non lo riceve.',
    ru: 'Здравствуйте, {name}! Ваше зачисление подтверждено. Отдельное письмо активации позволит выбрать пароль. Если оно не пришло, свяжитесь с кампусом.',
    ja: '{name} 様、登録が確定しました。別途届くアカウント有効化メールでパスワードを設定できます。届かない場合はキャンパスへお問い合わせください。',
  } } },
};
