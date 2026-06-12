const ExcelJS = require('exceljs');

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
   * Build filter query
   */
  buildFilter(query, userRole, userCampusId) {
    const filter = {};

    // Specific entities by IDs
    if (query.entityIds) {
      const ids = Array.isArray(query.entityIds) 
        ? query.entityIds 
        : query.entityIds.split(',');
      filter._id = { $in: ids };
      return filter;
    }

    // Campus isolation
    if (query.campusId) {
      filter.schoolCampus = query.campusId;
    } else if (userRole === 'CAMPUS_MANAGER') {
      filter.schoolCampus = userCampusId;
    }

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

    // Search
    if (query.search) {
      filter.$or = [
        { firstName: { $regex: query.search, $options: 'i' } },
        { lastName: { $regex: query.search, $options: 'i' } },
        { email: { $regex: query.search, $options: 'i' } },
      ];

      if (query.matricule !== undefined) {
        filter.$or.push({ matricule: { $regex: query.search, $options: 'i' } });
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
          const ExcelJS = require('exceljs');

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
             * Build filter query
             */
            buildFilter(query, userRole, userCampusId) {
              const filter = {};
          
              // Specific entities by IDs
              if (query.entityIds) {
                const ids = Array.isArray(query.entityIds) 
                  ? query.entityIds 
                  : query.entityIds.split(',');
                filter._id = { $in: ids };
                return filter;
              }
          
              // Campus isolation
              if (query.campusId) {
                filter.schoolCampus = query.campusId;
              } else if (userRole === 'CAMPUS_MANAGER') {
                filter.schoolCampus = userCampusId;
              }
          
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
          
              // Search
              if (query.search) {
                filter.$or = [
                  { firstName: { $regex: query.search, $options: 'i' } },
                  { lastName: { $regex: query.search, $options: 'i' } },
                  { email: { $regex: query.search, $options: 'i' } },
                ];
          
                if (query.matricule !== undefined) {
                  filter.$or.push({ matricule: { $regex: query.search, $options: 'i' } });
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
                const filter = this.buildFilter(query, user.role, user.campusId);
                const entities = await this.fetchEntities(filter);
          
                if (entities.length === 0) {
                  throw new Error(`No ${this.entityConfig.nameLower}s to export`);
                }
          
                // UTF-8 BOM for Excel compatibility
                let csv = '\uFEFF';
          
                // Headers
                const headers = this.entityConfig.columns
                  .map(col => `"${col.header}"`)
                  .join(',');
                csv += headers + '\n';
          
                // Rows
                entities.forEach(entity => {
                  const row = this.entityConfig.columns.map(col => {
                    const value = this.getNestedValue(entity, col.key);
                    const formatted = this.formatValue(value, col.format);
                    
                    // Escape double quotes
                    const escaped = formatted.toString().replace(/"/g, '""');
                    return `"${escaped}"`;
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
                const filter = this.buildFilter(query, user.role, user.campusId);
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
      const filter = this.buildFilter(query, user.role, user.campusId);
      const entities = await this.fetchEntities(filter);

      if (entities.length === 0) {
        throw new Error(`No ${this.entityConfig.nameLower}s to export`);
      }

      // UTF-8 BOM for Excel compatibility
      let csv = '\uFEFF';

      // Headers
      const headers = this.entityConfig.columns
        .map(col => `"${col.header}"`)
        .join(',');
      csv += headers + '\n';

      // Rows
      entities.forEach(entity => {
        const row = this.entityConfig.columns.map(col => {
          const value = this.getNestedValue(entity, col.key);
          const formatted = this.formatValue(value, col.format);
          
          // Escape double quotes
          const escaped = formatted.toString().replace(/"/g, '""');
          return `"${escaped}"`;
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
      const filter = this.buildFilter(query, user.role, user.campusId);
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