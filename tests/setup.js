/**
 * Jest setup — run before each test file.
 * Provides neutral environment variables so that loading the modules
 * (and app.js) does not depend on a real .env or a database.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';
