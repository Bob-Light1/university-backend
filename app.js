/**
 * @file app.js
 * @description Construction de l'application Express (middlewares + montage des
 * façades de modules). AUCUN effet de bord : pas de connexion MongoDB, pas de
 * cron, pas de app.listen() — ceux-ci vivent dans server.js. Ce découpage
 * (prévu par MODULAR_MONOLITH_MIGRATION.md §2) rend l'app importable telle quelle
 * par Supertest sans démarrer de serveur ni de base de données.
 *
 * L'ordre des middlewares et des montages de routes est identique à l'ancien
 * server.js — ne pas réordonner (comportement sensible à l'ordre).
 */

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const { apiLimiter } = require('./shared/middleware/rate-limiter');
const localeMiddleware = require('./shared/middleware/locale.middleware');

const app = express();

// ========================================
// HELMET FOR HTTP PROTECTION
// ========================================
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
// TRANSVERSE SCHEMA REGISTRATION
// ========================================
// Register transverse schemas not required anywhere else (ref: "User" used by
// exam/income models via populate) — see MODULAR_MONOLITH_MIGRATION.md §5.
// Doit précéder le montage des routes (les models les référencent via populate).
require('./shared/db/user.model');

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
const campusRouter = require('./modules/campus').routes;
const classRouter = require('./modules/class').routes;
const levelRouter = require('./modules/level').routes;
const subjectRouter = require('./modules/subject').routes;
const studentRoutes = require('./modules/student').routes; // /api/students + /api/schedules/student + /api/attendance/student
const teacherRoutes = require('./modules/teacher').routes; // /api/teachers + /api/schedules/teacher + /api/attendance/teacher
const adminRouter = require('./modules/admin').routes;
const resultRouter = require('./modules/result').routes;
const courseRouter = require('./modules/course').routes;
const departmentRouter = require('./modules/department').routes;
const documentRouter    = require('./modules/document').routes;
const parentRouter      = require('./modules/parent').routes;
const examinationRouter = require('./modules/exam').routes;
const academicPrintRouter = require('./modules/academic-print').routes;
const partnerRouter       = require('./modules/partner').routes;
const mentorRouter        = require('./modules/mentor').routes;
const staffRoutes             = require('./modules/staff').routes; // /api/staff + /api/staff-roles
const announcementRouter      = require('./modules/announcement').routes;
const gaetRouter              = require('./modules/gaet').routes;
const settingsRouter          = require('./modules/settings').routes;
const notificationRouter      = require('./modules/notification').routes;
const financeRouter           = require('./modules/finance').routes;

app.use('/api/admin', adminRouter);
app.use('/api/campus', campusRouter);
app.use('/api',          studentRoutes); // → /api/students + /api/schedules/student + /api/attendance/student (URLs inchangées)
app.use('/api',          teacherRoutes); // → /api/teachers + /api/schedules/teacher + /api/attendance/teacher (URLs inchangées)
app.use('/api/class', classRouter);
app.use('/api/level', levelRouter);
app.use('/api/subject', subjectRouter);
app.use('/api/results', resultRouter);
app.use('/api/courses', courseRouter);
app.use('/api/department', departmentRouter);
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
app.use('/api/notifications', notificationRouter);
app.use('/api/finance',       financeRouter);

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

module.exports = app;
