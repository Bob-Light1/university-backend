const config = {
  upload: {
    maxProfileSize: parseInt(process.env.MAX_PROFILE_IMAGE_SIZE) || 2 * 1024 * 1024,
    maxDocumentSize: parseInt(process.env.MAX_DOCUMENT_SIZE) || 10 * 1024 * 1024,
    paths: {
      students: process.env.STUDENT_IMAGE_PATH,
      teachers: process.env.TEACHER_IMAGE_PATH,
      campuses: process.env.CAMPUS_IMAGE_PATH,
    }
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN
  },
  email: {
    service: process.env.EMAIL_SERVICE,
    apiKey: process.env.SENDGRID_API_KEY,
    from: process.env.EMAIL_FROM,
    fromName: process.env.EMAIL_FROM_NAME
  },
  // ── Socle notifications ─────────────────────────────────────────────────────
  // Chaque canal est INERTE tant que sa config est absente : le module ne fait
  // aucun appel externe (dev / CI / tests passent sans SMTP ni WhatsApp).
  notification: {
    // Transport SMTP (canal email). Réutilise EMAIL_FROM / EMAIL_FROM_NAME ci-dessus.
    smtp: {
      host:     process.env.SMTP_HOST,
      port:     parseInt(process.env.SMTP_PORT, 10) || 587,
      secure:   process.env.SMTP_SECURE === 'true',
      user:     process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
    },
    // WhatsApp Cloud API (Meta) — appelé en HTTPS natif (fetch), aucun SDK requis.
    whatsapp: {
      token:         process.env.WHATSAPP_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_ID,
      apiVersion:    process.env.WHATSAPP_API_VERSION || 'v21.0',
    },
    // Tentatives de livraison avant abandon (canaux externes uniquement).
    maxAttempts: parseInt(process.env.NOTIFICATION_MAX_ATTEMPTS, 10) || 3,
  },
};

module.exports = config;