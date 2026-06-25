const fs = require('fs').promises;
const csv = require('csv-parser');
const { createReadStream } = require('fs');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

/**
 * IMPORT SERVICE
 * 
 * Handles import from CSV and Excel formats
 * Reusable for any entity (Student, Teacher, Parent, etc.)
 * 
 * Features:
 * - CSV import (handles UTF-8 BOM)
 * - Excel import (.xlsx, .xls)
 * - Data validation
 * - Duplicate detection
 * - Error reporting (row-by-row)
 * - Password hashing
 * - Campus isolation
 * - Dry-run mode (validation only)
 */

class ImportService {
  constructor(Model, entityConfig) {
    this.Model = Model;
    this.entityConfig = {
      name: entityConfig.name || 'Entity',
      nameLower: (entityConfig.name || 'entity').toLowerCase(),
      requiredFields: entityConfig.requiredFields || ['firstName', 'lastName', 'email'],
      uniqueFields: entityConfig.uniqueFields || ['email'],
      defaultValues: entityConfig.defaultValues || {},
      fieldMapping: entityConfig.fieldMapping || {},
      validators: entityConfig.validators || {},
      ...entityConfig,
    };
  }

  /**
   * Parse CSV file
   */
  async parseCSV(filePath) {
    return new Promise((resolve, reject) => {
      const rows = [];
      
      createReadStream(filePath)
        .pipe(csv({
          skipEmptyLines: true,
          trim: true,
          mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/\s+/g, '_'),
        }))
        .on('data', (row) => {
          // Remove BOM if present
          const cleanedRow = {};
          Object.keys(row).forEach(key => {
            const cleanKey = key.replace(/^\uFEFF/, '');
            cleanedRow[cleanKey] = row[key];
          });
          rows.push(cleanedRow);
        })
        .on('end', () => resolve(rows))
        .on('error', reject);
    });
  }

  /**
   * Parse Excel file
   */
  async parseExcel(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('Excel file is empty or invalid');
    }

    const rows = [];
    const headers = [];

    // Get headers from first row
    worksheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = cell.value?.toString()
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_') || `column_${colNumber}`;
    });

    // Get data rows
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const rowData = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          rowData[header] = cell.value?.toString().trim() || '';
        }
      });

      // Only add non-empty rows
      if (Object.values(rowData).some(val => val !== '')) {
        rows.push(rowData);
      }
    });

    return rows;
  }

  /**
   * Map field names (handle different column naming)
   */
  mapFields(row) {
    const mapped = {};
    
    Object.keys(row).forEach(key => {
      const mappedKey = this.entityConfig.fieldMapping[key] || key;
      mapped[mappedKey] = row[key];
    });

    return mapped;
  }

  /**
   * Validate row data
   */
  validateRow(row, rowNumber) {
    const errors = [];

    // Check required fields
    this.entityConfig.requiredFields.forEach(field => {
      if (!row[field] || row[field].toString().trim() === '') {
        errors.push(`Missing required field: ${field}`);
      }
    });

    // Custom validators
    Object.keys(this.entityConfig.validators).forEach(field => {
      const validator = this.entityConfig.validators[field];
      const value = row[field];

      if (value) {
        const validationResult = validator(value);
        if (validationResult !== true) {
          errors.push(validationResult);
        }
      }
    });

    // Email validation
    if (row.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(row.email)) {
        errors.push('Invalid email format');
      }
    }

    return errors.length > 0 ? errors : null;
  }

  /**
   * Check for duplicates.
   * Email is normalized to lowercase; all other fields are compared as-is.
   */
  async checkDuplicates(row) {
    const duplicates = [];

    for (const field of this.entityConfig.uniqueFields) {
      if (row[field]) {
        const value = field === 'email' ? row[field].toLowerCase() : row[field];
        const exists = await this.Model.findOne({ [field]: value }).lean();

        if (exists) {
          duplicates.push(`${field} "${row[field]}" already exists`);
        }
      }
    }

    return duplicates.length > 0 ? duplicates : null;
  }

  /**
   * Prepare entity data
   */
  async prepareEntityData(row, campusId) {
    const data = {
      ...this.entityConfig.defaultValues,
      firstName: row.first_name || row.firstName,
      lastName: row.last_name || row.lastName,
      email: (row.email || '').toLowerCase(),
      phone: row.phone || '',
      gender: row.gender?.toLowerCase() || 'male',
      username: row.username || (row.email || '').split('@')[0].toLowerCase(),
      schoolCampus: campusId,
      status: row.status || 'active',
    };

    // Handle password / status
    if (this.entityConfig.activation) {
      // Activation onboarding: no default password — the user sets their own
      // via the activation link/code. Store an unusable random placeholder.
      data.status   = 'pending';
      data.password = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
    } else {
      const password = row.password || this.entityConfig.defaultPassword || 'Default@123';
      data.password = await bcrypt.hash(password, 12);
    }

    // Additional entity-specific fields
    if (row.matricule) data.matricule = row.matricule;
    if (row.date_of_birth || row.dateOfBirth) {
      data.dateOfBirth = new Date(row.date_of_birth || row.dateOfBirth);
    }

    // Apply custom transformer if provided
    if (this.entityConfig.transformer) {
      return this.entityConfig.transformer(data, row);
    }

    return data;
  }

  /**
   * Import entities
   */
  async import(file, campusId, userRole, userCampusId, options = {}) {
    const { dryRun = false } = options;

    try {
      // Campus isolation check
      if (userRole === 'CAMPUS_MANAGER' && campusId !== userCampusId) {
        throw new Error('Can only import to your campus');
      }

      if (!file || !file.path) {
        throw new Error('No file provided');
      }

      // Determine file type and parse
      const fileExtension = file.originalname.split('.').pop().toLowerCase();
      let rows;

      if (fileExtension === 'csv') {
        rows = await this.parseCSV(file.path);
      } else if (['xlsx', 'xls'].includes(fileExtension)) {
        rows = await this.parseExcel(file.path);
      } else {
        throw new Error('Unsupported file format. Use CSV or Excel (.xlsx, .xls)');
      }

      if (rows.length === 0) {
        throw new Error('File is empty or invalid');
      }

      const results = {
        total: rows.length,
        imported: 0,
        failed: 0,
        errors: [],
        warnings: [],
      };

      // Process each row
      for (let i = 0; i < rows.length; i++) {
        const rawRow = rows[i];
        const rowNumber = i + 2; // +2 because index starts at 0 and row 1 is header

        try {
          // Map fields
          const row = this.mapFields(rawRow);

          // Validate
          const validationErrors = this.validateRow(row, rowNumber);
          if (validationErrors) {
            throw new Error(validationErrors.join('; '));
          }

          // Check duplicates
          const duplicateErrors = await this.checkDuplicates(row);
          if (duplicateErrors) {
            throw new Error(duplicateErrors.join('; '));
          }

          // Prepare data
          const entityData = await this.prepareEntityData(row, campusId);

          // Create entity (if not dry-run)
          if (!dryRun) {
            const created = await this.Model.create(entityData);

            // Activation onboarding: issue a token per row. The activation email
            // is sent when present; the offline code is collected so the admin
            // can relay it to users without an email address.
            if (this.entityConfig.activation) {
              try {
                const act = await require('../../modules/account').service.issueActivationToken({
                  userModel: this.entityConfig.activation.userModel,
                  userId:    created._id,
                  campusId:  created.schoolCampus,
                  email:     created.email || null,
                  name:      created.firstName || '',
                  locale:    created.preferredLanguage,
                });
                results.activations = results.activations || [];
                results.activations.push({
                  row:           rowNumber,
                  name:          `${created.firstName} ${created.lastName}`.trim(),
                  identifier:    created.username || created.email || '',
                  email:         created.email || null,
                  code:          act.code,
                  activationUrl: act.activationUrl,
                });
              } catch (actErr) {
                results.warnings.push(`Row ${rowNumber}: account created but activation link could not be issued (${actErr.message})`);
              }
            }
          }

          results.imported++;

        } catch (error) {
          results.failed++;
          results.errors.push({
            row: rowNumber,
            data: rawRow,
            error: error.message,
          });

          // Stop if too many errors (configurable)
          const maxErrors = this.entityConfig.maxErrors || 100;
          if (results.errors.length >= maxErrors) {
            results.warnings.push(`Stopped after ${maxErrors} errors`);
            break;
          }
        }
      }

      // Cleanup file
      await fs.unlink(file.path).catch(() => {});

      return {
        success: results.failed === 0,
        message: dryRun 
          ? `Validation completed: ${results.imported} valid, ${results.failed} invalid`
          : `Import completed: ${results.imported} imported, ${results.failed} failed`,
        data: results,
      };

    } catch (error) {
      // Cleanup file on error
      if (file?.path) {
        await fs.unlink(file.path).catch(() => {});
      }

      console.error('❌ Import Error:', error);
      throw error;
    }
  }

  /**
   * Build the ordered list of template columns.
   * Merges required fields, default-value keys, and the extra optional
   * fields that prepareEntityData always handles.
   */
  _templateColumns() {
    const EXTRA_OPTIONAL = ['phone', 'matricule', 'dateOfBirth', 'gender', 'username'];
    const seen = new Set();
    const columns = [];

    const add = (field) => {
      if (!seen.has(field)) {
        seen.add(field);
        columns.push(field);
      }
    };

    (this.entityConfig.requiredFields || []).forEach(add);
    Object.keys(this.entityConfig.defaultValues || {}).forEach(add);
    EXTRA_OPTIONAL.forEach(add);

    // Additional entity-specific columns declared in config
    (this.entityConfig.templateColumns || []).forEach(add);

    return columns;
  }

  /**
   * Human-readable header label from a camelCase / snake_case field name.
   */
  _label(field) {
    return field
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .trim();
  }

  /**
   * Get import template (CSV)
   */
  getTemplateCSV() {
    const columns = this._templateColumns();
    const csv = '\uFEFF' + columns.map(this._label).join(',') + '\n';

    return {
      data: csv,
      filename: `${this.entityConfig.nameLower}_import_template.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  /**
   * Get import template (Excel)
   */
  async getTemplateExcel() {
    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Template');
    const columns   = this._templateColumns();

    worksheet.columns = columns.map((field) => ({
      header: this._label(field),
      key:    field,
      width:  22,
    }));

    // Style header row
    worksheet.getRow(1).font = { bold: true, size: 11, color: { argb: 'FFFFFF' } };
    worksheet.getRow(1).fill = {
      type:     'pattern',
      pattern:  'solid',
      fgColor:  { argb: '1F4E78' },
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Example row with realistic placeholder values
    const EXAMPLES = {
      firstName:   'Jean',
      lastName:    'Dupont',
      email:       'jean.dupont@example.com',
      phone:       '+33600000000',
      matricule:   'TCH-2025-001',
      dateOfBirth: '1990-01-15',
      gender:      'male',
      username:    'jean.dupont',
      status:      'active',
    };
    const exampleRow = {};
    columns.forEach((field) => {
      exampleRow[field] = EXAMPLES[field] ?? `example_${field}`;
    });
    const row = worksheet.addRow(exampleRow);
    row.font = { italic: true, color: { argb: '555555' } };

    const buffer = await workbook.xlsx.writeBuffer();

    return {
      data:        buffer,
      filename:    `${this.entityConfig.nameLower}_import_template.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}

module.exports = ImportService;