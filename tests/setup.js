/**
 * Setup Jest — exécuté avant chaque fichier de test.
 * Fournit des variables d'environnement neutres pour que le chargement des
 * modules (et de app.js) ne dépende pas d'un vrai .env ni d'une base de données.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';
