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
  }
};

module.exports = config;