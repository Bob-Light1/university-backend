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
  // ── Notification foundation ─────────────────────────────────────────────────
  // Each channel is INERT as long as its config is absent: the module makes
  // no external call (dev / CI / tests pass without SMTP or WhatsApp).
  notification: {
    // SMTP transport (email channel). Reuses EMAIL_FROM / EMAIL_FROM_NAME above.
    smtp: {
      host:     process.env.SMTP_HOST,
      port:     parseInt(process.env.SMTP_PORT, 10) || 587,
      secure:   process.env.SMTP_SECURE === 'true',
      user:     process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
    },
    // WhatsApp Cloud API (Meta) — called over native HTTPS (fetch), no SDK required.
    whatsapp: {
      token:         process.env.WHATSAPP_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_ID,
      apiVersion:    process.env.WHATSAPP_API_VERSION || 'v21.0',
    },
    // Delivery attempts before giving up (external channels only).
    maxAttempts: parseInt(process.env.NOTIFICATION_MAX_ATTEMPTS, 10) || 3,
  },
};

module.exports = config;