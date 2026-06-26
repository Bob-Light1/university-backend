require('dotenv').config();

const mongoose = require('mongoose');
const path = require('path');

const { shutdownPool }         = require('./modules/document').service;
const { shutdownAcademicPool } = require('./modules/academic-print').service;
const { shutdownQueue: shutdownGaetQueue } = require('./modules/gaet').service;
const { shutdownIngestionQueue }           = require('./modules/public-portal').service;
const { shutdownRateLimiter }              = require('./shared/middleware/rate-limiter');

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

// Application Express (middlewares + montage des routes) — sans effet de bord.
const app = require('./app');

// ========================================
// DATABASE CONNECTION
// ========================================
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
// GRACEFUL SHUTDOWN
// ========================================
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️ ${signal} received. Starting graceful shutdown...`);

  try {
    // Close Puppeteer pools + GAET queue + public-portal ingestion queue + rate-limit Redis
    await Promise.all([
      shutdownPool(),
      shutdownAcademicPool(),
      shutdownGaetQueue(),
      shutdownIngestionQueue(),
      shutdownRateLimiter(),
    ]).catch(() => {});
    console.log('✅ Puppeteer pools + queues + rate-limit store closed');

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
  const { runRetryJob: runNotificationRetryJob } = require('./modules/notification').service;
  const { runOverdueJob: runFinanceOverdueJob }  = require('./modules/finance').service;
  const { runPrintQueueJob } = require('./modules/academic-print').service;
  cron.schedule('0 2 * * 0', runRetentionJob);          // Every Sunday at 02:00
  cron.schedule('0 3 * * *', runAntiCheatJob);          // Nightly at 03:00
  cron.schedule('0 1 * * *', runExpiryJob);             // Nightly at 01:00
  cron.schedule('5 0 1 * *', runCompetitionClosingJob); // 1st of month at 00:05
  cron.schedule('*/10 * * * *', runNotificationRetryJob); // Every 10 min — flush external sends
  cron.schedule('0 6 * * *', runFinanceOverdueJob);       // Nightly at 06:00 — overdue fees + reminders
  cron.schedule('*/2 * * * *', runPrintQueueJob);         // Every 2 min — sweep pending/stale print jobs
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
