require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');
const { apiLimiter } = require('./middleware/rate-limiter/rate-limiter');
const localeMiddleware = require('./middleware/locale/locale.middleware');
const mongoSanitize = require('express-mongo-sanitize');
const { shutdownPool }         = require('./modules/document').service;
const { shutdownAcademicPool } = require('./services/academic-pdf.service');

const app = express();

// ========================================
// ENVIRONMENT VALIDATION
// ========================================
const requiredEnvVars = ['MONGODB_URI', 'JWT_SECRET'];
if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET');
}
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// ========================================
// HELMET FOR HTTP PROTECTION
// ========================================
const helmet = require('helmet');
// API consommée par un frontend sur un domaine séparé (Vercel) → on autorise le
// chargement cross-origin des ressources servies (QR codes, reçus, etc.), sinon le
// navigateur bloque avec ERR_BLOCKED_BY_RESPONSE.NotSameOrigin (défaut helmet = same-origin).
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ========================================
// CORS CONFIGURATION
// ========================================
const defaultOrigins = ['http://localhost:5173', 'http://localhost:3000', 'https://university-frontend-mu.vercel.app'];
const allowedOrigins = process.env.FRONTEND_URL
  ? [...new Set([...defaultOrigins, ...process.env.FRONTEND_URL.split(',').map(url => url.trim())])]
  : defaultOrigins;

// Portail public — domaine séparé autorisé en CORS
if (process.env.PORTAL_URL) {
  process.env.PORTAL_URL.split(',').map(u => u.trim()).forEach(u => {
    if (!allowedOrigins.includes(u)) allowedOrigins.push(u);
  });
}

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: true, // Allow credentials (cookies, authorization headers)
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Portal-Key'],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200, // For legacy browsers
  maxAge: 86400 // 24 hours - cache preflight requests
};

app.use(cors(corsOptions));

// ========================================
// MIDDLEWARE CONFIGURATION
// ========================================

// Trust proxy (important for rate limiting and getting real IP)
app.set('trust proxy', 1);

// Body parsers
app.use(express.json({ limit: '10mb' })); // Limit JSON body size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mongoSanitize());
app.use(cookieParser());
app.use(localeMiddleware);

// Security headers
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ========================================
// STATIC FILES SERVING
// ========================================

// Serve uploaded files (images, documents)
if (process.env.NODE_ENV !== 'production') {
  app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '1d', // Cache for 1 day
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      // Set CORS headers for images
      res.setHeader('Access-Control-Allow-Origin', '*');
       // Set cache control
      if (
        filePath.endsWith('.jpg') ||
        filePath.endsWith('.png') ||
        filePath.endsWith('.webp') ||
        filePath.endsWith('.jpeg')
      ) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
}

// ========================================
// DATABASE CONNECTION
// ========================================
// Register transverse schemas not required anywhere else (ref: "User" used by
// exam/income models via populate) — see MODULAR_MONOLITH_MIGRATION.md §5.
require('./shared/db/user.model');

mongoose
  .connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000, // Give Atlas up to 15 s to respond (cold start)
    socketTimeoutMS: 120000,         // Keep idle sockets alive for 2 min
    connectTimeoutMS: 20000,         // Initial TCP connection timeout
    heartbeatFrequencyMS: 10000,     // Ping Atlas every 10 s to keep connection alive
    minPoolSize: 1,                  // Always maintain at least 1 connection
    maxPoolSize: 5,                  // Cap connections (sufficient for Render free tier)
  })
  .then(async () => {
    const dbName = mongoose.connection.name;
    console.log('✅ MongoDB connected successfully');
    console.log(`📦 Database: ${dbName}`);
    if (dbName === 'test' && process.env.NODE_ENV === 'production') {
      console.error('❌ FATAL: Connected to the "test" database in production.');
      console.error('   Set a database name in MONGODB_URI: mongodb+srv://...cluster.net/<dbName>');
      process.exit(1);
    }

    // ── GAET zombie recovery ──────────────────────────────────────────────────
    // Any GaetConstraint that was left in GENERATING status when the server
    // crashed / restarted is a zombie job.  Recover them to FAILED so the
    // campus manager can re-trigger generation cleanly.
    try {
      const recovered = await require('./modules/gaet').service.recoverZombieJobs();
      if (recovered > 0) {
        console.warn(`⚠️  [GAET] Recovered ${recovered} zombie generation job(s) → FAILED.`);
      }
    } catch (gaetErr) {
      console.error('❌ [GAET] Zombie recovery failed:', gaetErr.message);
    }
  })
  .catch((error) => {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  });

// MongoDB connection event handlers
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('error', (error) => {
  console.error('❌ MongoDB error:', error.message);
});

// ========================================
// API RATE LIMITING
// ========================================
// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// ========================================
// UPTIMEROBOT PING ROUTE
// ========================================
app.get('/api/ping', (req, res) => {
  res.status(200).json({
    status: 'ok',
    ts: Date.now()
  });
});

// ========================================
// API HEALTH CHECK (includes real DB ping)
// ========================================
app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().command({ ping: 1 });
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    database: dbOk ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// ========================================
// HEALTH CHECK ROUTE
// ========================================
app.get('/health', (req, res) => {
  const healthCheck = {
    uptime: process.uptime(),
    message: 'OK',
    timestamp: Date.now(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  };
  
  try {
    res.status(200).json(healthCheck);
  } catch (error) {
    healthCheck.message = error.message;
    res.status(503).json(healthCheck);
  }
});

// ========================================
// PUBLIC PORTAL ROUTES (pas de JWT requis — monté avant les routes authentifiées)
// ========================================
const publicPortalRoutes = require('./modules/public-portal').routes; // /api/public + /api/portal-admin
app.use('/api', publicPortalRoutes);

// ========================================
// API ROUTES
// ========================================
const campusRouter = require('./routers/campus.router');
const classRouter = require('./routers/class.router');
const levelRouter = require('./routers/level.router');
const subjectRouter = require('./routers/subject.router');
const studentRouter = require('./routers/student.router');
const teacherRouter = require('./routers/teacher.router');
const adminRouter = require('./modules/admin').routes;
const resultRouter = require('./modules/result').routes;
const courseRouter = require('./modules/course').routes;
const departmentRouter = require('./modules/department').routes;
const studentScheduleRouter = require('./routers/student-schedule.router');
const teacherScheduleRouter = require('./routers/teacher-schedule.router');
const studentAttendanceRouter = require('./routers/student-attendance.router');
const teacherAttendanceRouter = require('./routers/teacher-attendance.router');
const documentRouter    = require('./modules/document').routes;
const parentRouter      = require('./modules/parent').routes;
const examinationRouter = require('./modules/exam').routes;
const academicPrintRouter = require('./routers/academic-print.router');
const partnerRouter       = require('./modules/partner').routes;
const mentorRouter        = require('./modules/mentor').routes;
const staffRoutes             = require('./modules/staff').routes; // /api/staff + /api/staff-roles
const announcementRouter      = require('./modules/announcement').routes;
const gaetRouter              = require('./modules/gaet').routes;
const settingsRouter          = require('./modules/settings').routes;

app.use('/api/admin', adminRouter);
app.use('/api/campus', campusRouter);
app.use('/api/students', studentRouter);
app.use('/api/teachers', teacherRouter);
app.use('/api/class', classRouter);
app.use('/api/level', levelRouter);
app.use('/api/subject', subjectRouter);
app.use('/api/results', resultRouter);
app.use('/api/courses', courseRouter);
app.use('/api/department', departmentRouter);
app.use('/api/schedules/student', studentScheduleRouter);
app.use('/api/schedules/teacher', teacherScheduleRouter);
app.use('/api/attendance/student', studentAttendanceRouter);
app.use('/api/attendance/teacher', teacherAttendanceRouter);
app.use('/api/documents',   documentRouter);
app.use('/api/parents',     parentRouter);
app.use('/api/examination', examinationRouter);
app.use('/api/print',      academicPrintRouter);
app.use('/api/partners',    partnerRouter);
app.use('/api/mentors',    mentorRouter);
app.use('/api',                staffRoutes); // → /api/staff/... + /api/staff-roles/... (URLs inchangées)
app.use('/api/announcements',  announcementRouter);
app.use('/api/gaet',          gaetRouter);
app.use('/api/settings',      settingsRouter);

// ========================================
// 404 HANDLER
// ========================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});

// ========================================
// GLOBAL ERROR HANDLER
// ========================================
app.use((err, req, res, next) => {
  // Log error for debugging
  console.error('❌ Server error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method
  });

  // CORS error
  if (typeof err.message === 'string' && err.message.includes('not allowed by CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS policy: Origin not allowed'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired'
    });
  }

  // MongoDB errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: messages
    });
  }

  if (err.code === 11000) {
    const field = err.keyPattern ? Object.keys(err.keyPattern)[0] : 'A unique field';
    return res.status(409).json({
      success: false,
      message: `${field} already exists`
    });
  }

  // Multer/Formidable file upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      message: 'File too large'
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { 
      stack: err.stack,
      error: err 
    })
  });
});

// ========================================
// GRACEFUL SHUTDOWN
// ========================================
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️ ${signal} received. Starting graceful shutdown...`);
  
  try {
    // Close Puppeteer pools
    await Promise.all([shutdownPool(), shutdownAcademicPool()]).catch(() => {});
    console.log('✅ Puppeteer pools closed');

    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    
    // Exit process
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// ========================================
// CRON JOBS
// ========================================
try {
  const cron = require('node-cron');
  const { runRetentionJob }  = require('./modules/document').service;
  const { runAntiCheatJob }  = require('./modules/exam').service;
  const { runExpiryJob }     = require('./modules/announcement').service;
  const { runCompetitionClosingJob } = require('./modules/public-portal').service;
  cron.schedule('0 2 * * 0', runRetentionJob);          // Every Sunday at 02:00
  cron.schedule('0 3 * * *', runAntiCheatJob);          // Nightly at 03:00
  cron.schedule('0 1 * * *', runExpiryJob);             // Nightly at 01:00
  cron.schedule('5 0 1 * *', runCompetitionClosingJob); // 1st of month at 00:05
} catch {
  console.warn('⚠️  node-cron not available — cron jobs disabled.');
}

// ========================================
// START SERVER
// ========================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log('🚀 ========================================');
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 CORS enabled for: ${allowedOrigins.join(', ')}`);
  console.log(`📁 Static files: ${path.join(__dirname, 'uploads')}`);
  console.log('🚀 ========================================');
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', error);
    process.exit(1);
  }
});

module.exports = app; // Export for testing