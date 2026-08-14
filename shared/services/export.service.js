const ExcelJS = require('exceljs');
const { buildCampusFilter, escapeRegex } = require('../utils/validation-helpers');
const { csvField } = require('../utils/csv');

/**
 * EXPORT SERVICE
 * 
 * Handles export to CSV and Excel formats
 * Reusable for any entity (Student, Teacher, Parent, etc.)
 * 
 * Features:
 * - CSV export (UTF-8 BOM for Excel compatibility)
 * - Excel export (.xlsx) with formatting
 * - Custom column mapping
 * - Date formatting
 * - Campus/class population
 * - Filter support
 */

class ExportService {
  constructor(Model, entityConfig) {
    this.Model = Model;
    this.entityConfig = {
      name: entityConfig.name || 'Entity',
      nameLower: (entityConfig.name || 'entity').toLowerCase(),
      columns: entityConfig.columns || this.getDefaultColumns(),
      populateFields: entityConfig.populateFields || [],
      ...entityConfig,
    };
  }

  /**
   * Default column configuration
   */
  getDefaultColumns() {
    return [
      { header: 'First Name', key: 'firstName', width: 20 },
      { header: 'Last Name', key: 'lastName', width: 20 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Created At', key: 'createdAt', width: 20, format: 'date' },
    ];
  }

  /**
   * Build the export query filter.
   *
   * Campus isolation is DERIVED from the caller's role via buildCampusFilter
   * (CLAUDE.md §2) — never hand-rolled here. The helper consults the role first:
   * a global role may scope to any campus with `?campusId=`, a scoped role always
   * gets its own campus whatever it asked for, and a scoped token without a campus
   * throws (fail closed).
   *
   * @param {Object} query - req.query
   * @param {Object} user  - req.user ({ id, role, campusId })
   * @returns {Object} Mongo filter, campus-scoped for every non-global role
   * @throws  {Error}  403-tagged error when a scoped token carries no valid campus
   */
  buildFilter(query, user) {
    let campusFilter;
    try {
      campusFilter = buildCampusFilter(user, query.campusId || null);
    } catch (err) {
      console.error('[export CampusIsolation] breach prevented:', err.message);
      const error = new Error('Campus information is missing from your session. Please log in again.');
      error.statusCode = 403;
      throw error;
    }

    // Specific entities by IDs — an id list NARROWS the result set, it never
    // authorises it: the campus filter still applies.
    if (query.entityIds) {
      const ids = Array.isArray(query.entityIds)
        ? query.entityIds
        : query.entityIds.split(',');
      return { _id: { $in: ids }, ...campusFilter };
    }

    const filter = { ...campusFilter };

    // Class filter
    if (query.classId) {
      filter[this.entityConfig.classField || 'studentClass'] = query.classId;
    }

    // Status filter
    if (query.status) {
      filter.status = query.status;
    }

    // Gender filter
    if (query.gender) {
      filter.gender = query.gender;
    }

    // Search — escaped before reaching $regex (ReDoS / pattern injection)
    if (query.search) {
      const safeSearch = escapeRegex(query.search);
      filter.$or = [
        { firstName: { $regex: safeSearch, $options: 'i' } },
        { lastName: { $regex: safeSearch, $options: 'i' } },
        { email: { $regex: safeSearch, $options: 'i' } },
      ];

      if (query.matricule !== undefined) {
        filter.$or.push({ matricule: { $regex: safeSearch, $options: 'i' } });
      }
    }

    return filter;
  }

  /**
   * Fetch entities with population
   */
  async fetchEntities(filter) {
    let query = this.Model.find(filter).select('-password');

    // Populate related fields
    this.entityConfig.populateFields.forEach(field => {
      query = query.populate(field.path, field.select);
    });

    return await query.lean();
  }

  /**
   * Format cell value
   */
  formatValue(value, format) {
    if (value === null || value === undefined) {
      return '';
    }

    switch (format) {
      case 'date':
        return value instanceof Date 
          ? value.toLocaleDateString('en-US') 
          : new Date(value).toLocaleDateString('en-US');
      case 'datetime':
        return value instanceof Date 
          ? value.toLocaleString('en-US') 
          : new Date(value).toLocaleString('en-US');
      
      case 'boolean':
        return value ? 'Yes' : 'No';
      
      default:
        return value.toString();
    }
  }

  /**
   * Get nested property value
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => 
      current?.[key], obj
    );
  }

  /**
   * Export to CSV
   */
  async exportToCSV(query, user) {
    try {
      const filter = this.buildFilter(query, user);
      const entities = await this.fetchEntities(filter);

      if (entities.length === 0) {
        throw new Error(`No ${this.entityConfig.nameLower}s to export`);
      }

      // UTF-8 BOM for Excel compatibility
      let csv = '\uFEFF';

      // Headers \u2014 csvField too: the header text is column config, not user input today,
      // but encoding the whole file one way is what stops the next column from being the
      // exception.
      const headers = this.entityConfig.columns
        .map(col => csvField(col.header))
        .join(',');
      csv += headers + '\n';

      // Rows. csvField neutralizes spreadsheet formulas BEFORE quoting: the previous
      // expression quoted and escaped correctly, which is CSV-valid and no defence at all
      // \u2014 the parser consumes the quotes and hands the raw string to the spreadsheet,
      // which evaluates anything opening with =, +, - or @.
      entities.forEach(entity => {
        const row = this.entityConfig.columns.map(col => {
          const value = this.getNestedValue(entity, col.key);
          return csvField(this.formatValue(value, col.format));
        }).join(',');

        csv += row + '\n';
      });

      return {
        success: true,
        data: csv,
        filename: `${this.entityConfig.nameLower}s_${Date.now()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        count: entities.length,
      };
    } catch (error) {
      console.error('❌ CSV Export Error:', error);
      throw error;
    }
  }

  /**
   * Export to Excel (.xlsx)
   */
  async exportToExcel(query, user) {
    try {
      const filter = this.buildFilter(query, user);
      const entities = await this.fetchEntities(filter);

      if (entities.length === 0) {
        throw new Error(`No ${this.entityConfig.nameLower}s to export`);
      }

      // Create workbook
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'wewigo';
      workbook.created = new Date();

      const worksheet = workbook.addWorksheet(this.entityConfig.name + 's', {
        properties: { tabColor: { argb: '1F4E78' } },
      });

      // Define columns
      worksheet.columns = this.entityConfig.columns.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width || 15,
        style: col.style || {},
      }));

      // Style header row
      worksheet.getRow(1).font = { bold: true, size: 12, color: { argb: 'FFFFFF' } };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '1F4E78' },
      };
      worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

      // Add data rows
      entities.forEach(entity => {
        const rowData = {};
        
        this.entityConfig.columns.forEach(col => {
          const value = this.getNestedValue(entity, col.key);
          
          if (col.format === 'date' || col.format === 'datetime') {
            rowData[col.key] = value ? new Date(value) : null;
          } else {
            rowData[col.key] = this.formatValue(value, col.format);
          }
        });

        worksheet.addRow(rowData);
      });

      // Auto-filter
      worksheet.autoFilter = {
        from: 'A1',
        to: `${String.fromCharCode(64 + this.entityConfig.columns.length)}1`,
      };

      // Freeze header row
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];

      // Format date columns
      this.entityConfig.columns.forEach((col, index) => {
        if (col.format === 'date') {
          worksheet.getColumn(index + 1).numFmt = 'mm/dd/yyyy';
        } else if (col.format === 'datetime') {
          worksheet.getColumn(index + 1).numFmt = 'mm/dd/yyyy hh:mm:ss';
        }
      });

      // Generate buffer
      const buffer = await workbook.xlsx.writeBuffer();

      return {
        success: true,
        data: buffer,
        filename: `${this.entityConfig.nameLower}s_${Date.now()}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        count: entities.length,
      };
    } catch (error) {
      console.error('❌ Excel Export Error:', error);
      throw error;
    }
  }
}

module.exports = ExportService;