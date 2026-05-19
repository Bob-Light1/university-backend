const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

/**
 * Configuration for file uploads
 */
const UPLOAD_CONFIG = {
  maxSize: 5 * 1024 * 1024, // 5MB
  allowedExtensions: {
    image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
    document: ['.pdf', '.doc', '.docx'],
    all: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.doc', '.docx']
  },
  baseUploadDir: path.join(__dirname, '..', 'uploads')
};

/**
 * Validates file type and size
 * @param {Object} file - The uploaded file
 * @param {Array} allowedExtensions - List of allowed extensions
 * @param {Number} maxSize - Maximum file size in bytes
 */
const validateFile = (file, allowedExtensions, maxSize) => {
  if (!file) {
    throw new Error("No file provided");
  }

  // Get extension
  const extension = path.extname(file.originalFilename || file.name || '').toLowerCase();
  
  // Validate extension
  if (!allowedExtensions.includes(extension)) {
    throw new Error(
      `Invalid file format. Only ${allowedExtensions.join(', ')} are allowed.`
    );
  }

  // Validate size
  const fileSize = file.size || 0;
  if (fileSize > maxSize) {
    const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);
    throw new Error(`File is too large. Maximum size is ${maxSizeMB}MB.`);
  }

  return { extension, fileSize };
};

/**
 * Generates a unique filename
 * @param {String} prefix - Filename prefix
 * @param {String} extension - File extension
 */
const generateUniqueFilename = (prefix, extension) => {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${randomString}${extension}`;
};

/**
 * Ensures a directory exists, creates it if not
 * @param {String} dirPath - Directory path
 */
const ensureDirectoryExists = async (dirPath) => {
  try {
    if (!fsSync.existsSync(dirPath)) {
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`✅ Directory created: ${dirPath}`);
    }
  } catch (error) {
    console.error(`❌ Error creating directory ${dirPath}:`, error);
    throw new Error(`Failed to create upload directory: ${error.message}`);
  }
};

/**
 * Main upload function - Handles validation and storage
 * @param {Object} file - The file from formidable
 * @param {String} folder - Destination subfolder (e.g., 'students', 'campuses')
 * @param {String} prefix - Filename prefix (e.g., 'student', 'campus')
 * @param {Object} options - Additional options
 * @returns {String} The generated filename
 */
const uploadImage = async (file, folder, prefix = 'img', options = {}) => {
  try {
    // Default options
    const {
      maxSize = UPLOAD_CONFIG.maxSize,
      allowedExtensions = UPLOAD_CONFIG.allowedExtensions.image,
      customPath = null
    } = options;

    // Validate file
    const { extension } = validateFile(file, allowedExtensions, maxSize);

    // Generate unique filename
    const fileName = generateUniqueFilename(prefix, extension);

    // Prepare upload directory
    const uploadDir = customPath || path.join(UPLOAD_CONFIG.baseUploadDir, folder);
    await ensureDirectoryExists(uploadDir);

    // Source and destination paths
    const sourcePath = file.filepath || file.path;
    const destinationPath = path.join(uploadDir, fileName);

    // Copy file
    await fs.copyFile(sourcePath, destinationPath);
    
    console.log(`✅ File uploaded: ${fileName} to ${folder}/`);
    
    return fileName;

  } catch (error) {
    console.error('❌ Upload error:', error.message);
    throw error; // Re-throw to be handled by controller
  }
};

/**
 * Upload multiple files
 * @param {Array} files - Array of files
 * @param {String} folder - Destination folder
 * @param {String} prefix - Filename prefix
 * @param {Object} options - Upload options
 * @returns {Array} Array of uploaded filenames
 */
const uploadMultipleImages = async (files, folder, prefix = 'img', options = {}) => {
  if (!files || files.length === 0) {
    return [];
  }

  const uploadedFiles = [];
  const errors = [];

  for (const file of files) {
    try {
      const fileName = await uploadImage(file, folder, prefix, options);
      uploadedFiles.push(fileName);
    } catch (error) {
      errors.push({ file: file.originalFilename, error: error.message });
    }
  }

  if (errors.length > 0) {
    console.warn('⚠️ Some files failed to upload:', errors);
  }

  return uploadedFiles;
};

/**
 * Deletes a file from the server
 * @param {String} folder - Folder name
 * @param {String} fileName - File name
 * @param {String} customPath - Custom base path (optional)
 */
const deleteFile = async (folder, fileName, customPath = null) => {
  if (!fileName) {
    console.warn('⚠️ No filename provided for deletion');
    return false;
  }

  try {
    const basePath = customPath || UPLOAD_CONFIG.baseUploadDir;
    const filePath = path.join(basePath, folder, fileName);
    
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
      console.log(`✅ File deleted: ${fileName}`);
      return true;
    } else {
      console.warn(`⚠️ File not found: ${fileName}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error deleting file ${fileName}:`, error.message);
    return false;
  }
};

/**
 * Delete multiple files
 * @param {String} folder - Folder name
 * @param {Array} fileNames - Array of file names
 */
const deleteMultipleFiles = async (folder, fileNames) => {
  if (!fileNames || fileNames.length === 0) {
    return { deleted: 0, failed: 0 };
  }

  let deleted = 0;
  let failed = 0;

  for (const fileName of fileNames) {
    const result = await deleteFile(folder, fileName);
    if (result) {
      deleted++;
    } else {
      failed++;
    }
  }

  return { deleted, failed };
};

/**
 * Get file info
 * @param {String} folder - Folder name
 * @param {String} fileName - File name
 */
const getFileInfo = async (folder, fileName) => {
  if (!fileName) return null;

  try {
    const filePath = path.join(UPLOAD_CONFIG.baseUploadDir, folder, fileName);
    
    if (!fsSync.existsSync(filePath)) {
      return null;
    }

    const stats = await fs.stat(filePath);
    
    return {
      fileName,
      size: stats.size,
      sizeKB: (stats.size / 1024).toFixed(2),
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      created: stats.birthtime,
      modified: stats.mtime,
      extension: path.extname(fileName)
    };
  } catch (error) {
    console.error(`❌ Error getting file info for ${fileName}:`, error.message);
    return null;
  }
};

/**
 * Replace an existing file with a new one
 * @param {Object} newFile - New file to upload
 * @param {String} folder - Folder name
 * @param {String} oldFileName - Old file name to delete
 * @param {String} prefix - New filename prefix
 * @param {Object} options - Upload options
 */
const replaceFile = async (newFile, folder, oldFileName, prefix, options = {}) => {
  try {
    // Upload new file first
    const newFileName = await uploadImage(newFile, folder, prefix, options);
    
    // Delete old file if upload successful
    if (oldFileName) {
      await deleteFile(folder, oldFileName);
    }
    
    return newFileName;
  } catch (error) {
    console.error('❌ Error replacing file:', error.message);
    throw error;
  }
};

/**
 * Get upload directory path
 * @param {String} folder - Folder name
 */
const getUploadPath = (folder) => {
  return path.join(UPLOAD_CONFIG.baseUploadDir, folder);
};

/**
 * Clean up old files in a directory
 * @param {String} folder - Folder name
 * @param {Number} daysOld - Delete files older than this many days
 */
const cleanupOldFiles = async (folder, daysOld = 30) => {
  try {
    const dirPath = path.join(UPLOAD_CONFIG.baseUploadDir, folder);
    
    if (!fsSync.existsSync(dirPath)) {
      return { deleted: 0, errors: 0 };
    }

    const files = await fs.readdir(dirPath);
    const now = Date.now();
    const maxAge = daysOld * 24 * 60 * 60 * 1000;

    let deleted = 0;
    let errors = 0;

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          await fs.unlink(filePath);
          deleted++;
          console.log(`🗑️ Deleted old file: ${file}`);
        }
      } catch (error) {
        console.error(`❌ Error processing file ${file}:`, error.message);
        errors++;
      }
    }

    return { deleted, errors };
  } catch (error) {
    console.error(`❌ Error cleaning up folder ${folder}:`, error.message);
    return { deleted: 0, errors: 1 };
  }
};

module.exports = {
  uploadImage,
  uploadMultipleImages,
  deleteFile,
  deleteMultipleFiles,
  replaceFile,
  getFileInfo,
  getUploadPath,
  cleanupOldFiles,
  UPLOAD_CONFIG
};