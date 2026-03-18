/**
 * UPLOAD MIDDLEWARE - MULTER CONFIGURATION (FIXED)
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

// ========================================
// CONFIGURATION
// ========================================

const UPLOAD_PATHS = {
  students: process.env.STUDENT_IMAGE_PATH || 'uploads/students',
  teachers: process.env.TEACHER_IMAGE_PATH || 'uploads/teachers',
  parents: process.env.PARENT_IMAGE_PATH || 'uploads/parents',
  campuses: process.env.CAMPUS_IMAGE_PATH || 'uploads/campuses',
  documents: process.env.DOCUMENT_PATH || 'uploads/documents',
  temp: 'uploads/temp'
};

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_PROFILE_SIZE = 2 * 1024 * 1024; // 2MB

// Ensure upload directories exist
const ensureUploadDirs = async () => {
  const dirs = [
    `${UPLOAD_DIR}/campuses`,
    `${UPLOAD_DIR}/students`,
    `${UPLOAD_DIR}/teachers`,
    `${UPLOAD_DIR}/parents`,
    `${UPLOAD_DIR}/documents`,
    `${UPLOAD_DIR}/temp`
  ];

  for (const dir of dirs) {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }
};

ensureUploadDirs().catch(console.error);

// ========================================
// STORAGE STRATEGIES
// ========================================

/**
 * Local Disk Storage Configuration
 */
const setUploadFolder = (folder) => (req, res, next) => {
  req.uploadFolder = folder;
  next();
};

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = UPLOAD_PATHS.temp;
    
    if (req.baseUrl.includes('student')) {
      folder = UPLOAD_PATHS.students;
    } else if (req.baseUrl.includes('teacher')) {
      folder = UPLOAD_PATHS.teachers;
    } else if (req.baseUrl.includes('parent')) {
      folder = UPLOAD_PATHS.parents;
    } else if (req.baseUrl.includes('campus')) {
      folder = UPLOAD_PATHS.campuses;
    } else if (file.fieldname === 'profileImage') {
      
      folder = req.uploadFolder ? UPLOAD_PATHS[req.uploadFolder] : UPLOAD_PATHS.temp;
    }
    
    cb(null, folder);
  },
  
  filename: (req, file, cb) => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const sanitizedName = (file.originalname || 'file')
      .replace(ext, '')
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .substring(0, 50);
    
    const filename = `${sanitizedName}-${timestamp}-${uniqueId}${ext}`;
    cb(null, filename);
  }
});

/**
 * Memory Storage
 */
const memoryStorage = multer.memoryStorage();

// ========================================
// FILE FILTERS (VALIDATION) - FIXED
// ========================================

/**
 * Image File Filter - FIXED VERSION
 * Better error handling and logging
 */
const imageFilter = (req, file, cb) => {
  try {
    // Allowed MIME types
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif'
    ];
    
    // Allowed extensions
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    
    // Safely extract extension
    const filename = file.originalname || '';
    
    // Log pour debug (à supprimer en production)
    console.log('📁 File validation:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    
    if (!filename) {
      console.error('❌ No filename provided');
      return cb(new Error('No filename provided'), false);
    }
    
    const ext = path.extname(filename).toLowerCase();
    
    if (!ext) {
      console.error('❌ No file extension found');
      return cb(new Error('File must have an extension'), false);
    }

    const mimeValid = allowedMimeTypes.includes(file.mimetype);
    const extValid = allowedExtensions.includes(ext);
    
    console.log('✓ Validation:', { 
      ext, 
      mimeValid, 
      extValid,
      mimetype: file.mimetype 
    });
    
    if (!mimeValid) {
      console.error(`❌ Invalid MIME type: ${file.mimetype}`);
      return cb(
        new Error(`Invalid file type "${file.mimetype}". Only JPEG, PNG, WEBP, and GIF images are allowed.`), 
        false
      );
    }
    
    if (!extValid) {
      console.error(`❌ Invalid extension: ${ext}`);
      return cb(
        new Error(`Invalid file extension "${ext}". Only .jpg, .jpeg, .png, .webp, .gif are allowed.`), 
        false
      );
    }
    
    console.log('✅ File validation passed');
    cb(null, true);
    
  } catch (error) {
    console.error('❌ Error in imageFilter:', error);
    cb(new Error('File validation error: ' + error.message), false);
  }
};

/**
 * Document File Filter
 */
const documentFilter = (req, file, cb) => {
  try {
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ];
    
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv'];
    
    const filename = file.originalname || '';
    if (!filename) {
      return cb(new Error('No filename provided'), false);
    }
    
    const ext = path.extname(filename).toLowerCase();
    const mimeValid = allowedMimeTypes.includes(file.mimetype);
    const extValid = allowedExtensions.includes(ext);
    
    console.log('📄 Document validation:', { 
      filename, 
      ext, 
      mimetype: file.mimetype,
      mimeValid, 
      extValid 
    });
    
    if (mimeValid && extValid) {
      cb(null, true);
    } else {
      cb(
        new Error('Invalid document type. Only PDF, DOC, DOCX, XLS, XLSX, CSV are allowed.'), 
        false
      );
    }
  } catch (error) {
    console.error('❌ Error in documentFilter:', error);
    cb(new Error('Document validation error: ' + error.message), false);
  }
};

/**
 * Permissive Filter
 */
const anyFileFilter = (req, file, cb) => {
  cb(null, true);
};

// ========================================
// MULTER CONFIGURATIONS
// ========================================

/**
 * Campus Image Upload
 */
const uploadCampusImage = multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: imageFilter
}).single('campus_image');

/**
 * Profile Image Upload - FIXED
 */
const uploadProfileImage = multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_PROFILE_SIZE,
    files: 1
  },
  fileFilter: imageFilter
}).single('profileImage');

/**
 * Multiple Images Upload
 */
const uploadMultipleImages = (maxCount = 10) => multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: maxCount
  },
  fileFilter: imageFilter
}).array('images', maxCount);

/**
 * Document Upload
 */
const uploadDocument = multer({
  storage: diskStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  },
  fileFilter: documentFilter
}).single('document');

/**
 * Multiple Fields Upload
 */
const uploadMultipleFields = (fields) => multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10
  },
  fileFilter: imageFilter
}).fields(fields);

/**
 * Any File Upload
 */
const uploadAnyFile = multer({
  storage: diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: anyFileFilter
}).single('file');

// ========================================
// ERROR HANDLING MIDDLEWARE - ENHANCED
// ========================================

/**
 * Multer Error Handler - ENHANCED
 * ✅ Better error messages and logging
 */
const handleMulterError = (err, req, res, next) => {
  // Log l'erreur complète pour debug
  if (err) {
    console.error('❌ Multer Error:', {
      name: err.name,
      message: err.message,
      code: err.code,
      field: err.field,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }

  if (err instanceof multer.MulterError) {
    // Multer-specific errors
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(400).json({
          success: false,
          message: 'File too large',
          error: `Maximum file size is ${MAX_PROFILE_SIZE / 1024 / 1024}MB for profile images`
        });
      
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          message: 'Too many files',
          error: err.message
        });
      
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          message: 'Unexpected field',
          error: `Invalid file field name. Expected: ${err.field}`
        });
      
      case 'LIMIT_PART_COUNT':
      case 'LIMIT_FIELD_KEY':
      case 'LIMIT_FIELD_VALUE':
      case 'LIMIT_FIELD_COUNT':
        return res.status(400).json({
          success: false,
          message: 'Request format error',
          error: err.message
        });
      
      default:
        return res.status(400).json({
          success: false,
          message: 'File upload error',
          error: err.message
        });
    }
  } else if (err) {
    // Custom file filter errors or other errors
    return res.status(400).json({
      success: false,
      message: 'File validation error',
      error: err.message
    });
  }
  
  next();
};

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Clean up uploaded file on error
 */
const cleanupUploadedFile = async (file) => {
  if (file && file.path) {
    try {
      await fs.unlink(file.path);
      console.log(`🗑️  Cleaned up file: ${file.path}`);
    } catch (error) {
      console.error(`❌ Failed to cleanup file: ${file.path}`, error);
    }
  }
};

/**
 * Clean up multiple uploaded files
 */
const cleanupUploadedFiles = async (files) => {
  if (!files) return;
  
  if (Array.isArray(files)) {
    for (const file of files) {
      await cleanupUploadedFile(file);
    }
    return;
  }
  
  if (typeof files === 'object') {
    for (const fieldName in files) {
      const fieldFiles = files[fieldName];
      if (Array.isArray(fieldFiles)) {
        for (const file of fieldFiles) {
          await cleanupUploadedFile(file);
        }
      } else {
        await cleanupUploadedFile(fieldFiles);
      }
    }
  }
};

/**
 * Get file URL for response
 */
const getFileUrl = (file) => {
  if (!file) return null;
  
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const publicPath = file.path.replace(/^uploads\//, '');
  
  return `${baseUrl}/uploads/${publicPath}`;
};

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Main upload middleware
  uploadCampusImage,
  uploadProfileImage,
  uploadMultipleImages,
  uploadDocument,
  uploadMultipleFields,
  uploadAnyFile,
  
  // Error handling
  handleMulterError,
  
  // Utilities
  cleanupUploadedFile,
  cleanupUploadedFiles,
  getFileUrl,
  setUploadFolder,
  
  // Storage configurations
  diskStorage,
  memoryStorage,
  
  // Filters
  imageFilter,
  documentFilter,
  anyFileFilter,
  
  // Constants
  MAX_FILE_SIZE,
  MAX_PROFILE_SIZE,
  UPLOAD_DIR
};