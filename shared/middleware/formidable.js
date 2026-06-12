const { formidable } = require('formidable');

/**
 * Middleware to parse multipart/form-data
 * Uses formidable to handle file uploads
 */

const parseFormData = (options = {}) => {
  return (req, res, next) => {
    // Skip if not multipart/form-data
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return next();
    }

    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: 5 * 1024 * 1024, // 5MB max
      ...options
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error('Formidable parse error:', err);
        return res.status(400).json({
          success: false,
          message: 'Error parsing form data',
          error: err.message
        });
      }

      // Flatten single-value arrays (formidable wraps all values in arrays)
      const flattenedFields = {};
      for (const key in fields) {
        const value = fields[key];
        flattenedFields[key] = Array.isArray(value) && value.length === 1 
          ? value[0] 
          : value;
      }

      // Attach parsed data to request
      req.fields = flattenedFields;
      req.files = files;

      // Also attach to req.body for compatibility
      req.body = { ...req.body, ...flattenedFields };

      console.log('Parsed fields:', flattenedFields);
      console.log('Parsed files:', Object.keys(files));

      next();
    });
  };
};

module.exports = parseFormData;