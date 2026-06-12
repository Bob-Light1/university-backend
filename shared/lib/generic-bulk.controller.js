const mongoose = require('mongoose');
const {
  sendSuccess,
  sendError,
  sendNotFound,
} = require('../utils/response-helpers');
const { isValidObjectId } = require('../../utils/validation-helpers'); // ancien chemin: couplé aux models core, migrera avec le core
const ExportService = require('../../services/export.service');
const ImportService = require('../../services/import.service');

/**
 * GENERIC BULK OPERATIONS CONTROLLER :
 * 
 * Reusable bulk operations for any entity
 * 
 * Features:
 * - Bulk change related entity (class, department)
 * - Bulk send email
 * - Bulk archive
 * - Export to CSV and Excel
 * - Import from CSV and Excel
 * - Get import templates
 */

class GenericBulkController {
  constructor(Model, config) {
    this.Model = Model;
    this.entityName = config.entityName || 'Entity';
    this.entityNameLower = this.entityName.toLowerCase();
    
    // Related model for bulk operations (e.g., Class for students)
    this.RelatedModel = config.RelatedModel || null;
    this.relatedField = config.relatedField || null; // e.g., 'studentClass'
    
    // Initialize Export Service
    this.exportService = new ExportService(Model, {
      name: this.entityName,
      columns: config.exportColumns || this.getDefaultExportColumns(),
      populateFields: config.populateFields || this.getDefaultPopulateFields(),
      classField: config.classField || 'studentClass',
    });
    
    // Initialize Import Service
    this.importService = new ImportService(Model, {
      name: this.entityName,
      requiredFields: config.importRequiredFields || ['firstName', 'lastName', 'email'],
      uniqueFields: config.importUniqueFields || ['email'],
      defaultValues: config.importDefaultValues || {},
      fieldMapping: config.importFieldMapping || {},
      validators: config.importValidators || {},
      transformer: config.importTransformer,
      defaultPassword: config.defaultPassword || 'Default@123',
      maxErrors: config.maxImportErrors || 100,
    });
  }

  /**
   * Default export columns configuration
   */
  getDefaultExportColumns() {
    return [
      { header: 'First Name', key: 'firstName', width: 20 },
      { header: 'Last Name', key: 'lastName', width: 20 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Matricule', key: 'matricule', width: 15 },
      { header: 'Class', key: 'studentClass.className', width: 20 },
      { header: 'Campus', key: 'schoolCampus.campus_name', width: 25 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Created At', key: 'createdAt', width: 20, format: 'date' },
    ];
  }

  /**
   * Default populate fields
   */
  getDefaultPopulateFields() {
    return [
      { path: 'studentClass', select: 'className' },
      { path: 'schoolCampus', select: 'campus_name' },
    ];
  }

  /**
   * BULK CHANGE RELATED ENTITY (e.g., change class)
   */
  bulkChangeRelated = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { entityIds, newRelatedId } = req.body;
      const idsKey = `${this.entityNameLower}Ids`;
      const ids = entityIds || req.body[idsKey];

      // Validation
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        await session.abortTransaction();
        return sendError(res, 400, `${this.entityName} IDs array is required`);
      }

      if (!newRelatedId || !isValidObjectId(newRelatedId)) {
        await session.abortTransaction();
        return sendError(res, 400, 'Valid related ID is required');
      }

      // Validate related entity exists
      if (this.RelatedModel) {
        const relatedEntity = await this.RelatedModel.findById(newRelatedId).session(session);
        if (!relatedEntity) {
          await session.abortTransaction();
          return sendNotFound(res, 'Related entity');
        }

        // Campus isolation for related entity
        if (req.user.role === 'CAMPUS_MANAGER') {
          if (relatedEntity.campus?.toString() !== req.user.campusId) {
            await session.abortTransaction();
            return sendError(res, 403, 'Related entity does not belong to your campus');
          }
        }
      }

      // Fetch entities
      const entities = await this.Model.find({ _id: { $in: ids } }).session(session);

      if (entities.length !== ids.length) {
        await session.abortTransaction();
        return sendError(res, 400, `Some ${this.entityNameLower}s not found`);
      }

      // Campus isolation check for entities
      if (req.user.role === 'CAMPUS_MANAGER') {
        const unauthorized = entities.filter(
          e => e.schoolCampus?.toString() !== req.user.campusId
        );
        
        if (unauthorized.length > 0) {
          await session.abortTransaction();
          return sendError(res, 403, `Can only modify your campus ${this.entityNameLower}s`);
        }
      }

      // Perform update
      const result = await this.Model.updateMany(
        { _id: { $in: ids } },
        { $set: { [this.relatedField]: newRelatedId } },
        { session }
      );

      await session.commitTransaction();

      return sendSuccess(res, 200, `Moved ${result.modifiedCount} ${this.entityNameLower}s`, {
        modifiedCount: result.modifiedCount
      });

    } catch (error) {
      await session.abortTransaction();
      console.error(`❌ Bulk change error:`, error);
      return sendError(res, 500, `Failed to update ${this.entityNameLower}s`);
    } finally {
      session.endSession();
    }
  };

  /**
   * BULK SEND EMAIL
   */
  bulkSendEmail = async (req, res) => {
    try {
      const { entityIds, subject, message } = req.body;
      const idsKey = `${this.entityNameLower}Ids`;
      const ids = entityIds || req.body[idsKey];

      // Validation
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return sendError(res, 400, `${this.entityName} IDs required`);
      }

      if (!subject || !message) {
        return sendError(res, 400, 'Subject and message required');
      }

      // Fetch entities
      const entities = await this.Model.find({
        _id: { $in: ids }
      }).select('email firstName lastName schoolCampus');

      if (entities.length === 0) {
        return sendNotFound(res, this.entityName + 's');
      }

      // Campus isolation
      if (req.user.role === 'CAMPUS_MANAGER') {
        const unauthorized = entities.filter(
          e => e.schoolCampus?.toString() !== req.user.campusId
        );
        
        if (unauthorized.length > 0) {
          return sendError(res, 403, `Can only email your campus ${this.entityNameLower}s`);
        }
      }

      // TODO: Integrate actual email service (SendGrid, Mailgun, etc.)
      console.log(`📧 Sending "${subject}" to ${entities.length} ${this.entityNameLower}s`);
      // Example:
      // await sendBulkEmail(entities.map(e => e.email), subject, message);

      return sendSuccess(res, 200, `Email sent to ${entities.length} ${this.entityNameLower}s`, {
        sent: entities.length
      });
    } catch (error) {
      console.error(`❌ Bulk email error:`, error);
      return sendError(res, 500, 'Failed to send emails');
    }
  };

  /**
   * BULK ARCHIVE
   */
  bulkArchive = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { entityIds } = req.body;
      const idsKey = `${this.entityNameLower}Ids`;
      const ids = entityIds || req.body[idsKey];

      // Validation
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        await session.abortTransaction();
        return sendError(res, 400, `${this.entityName} IDs required`);
      }

      // Campus isolation
      if (req.user.role === 'CAMPUS_MANAGER') {
        const entities = await this.Model.find({
          _id: { $in: ids }
        }).select('schoolCampus').session(session);

        const unauthorized = entities.filter(
          e => e.schoolCampus?.toString() !== req.user.campusId
        );
        
        if (unauthorized.length > 0) {
          await session.abortTransaction();
          return sendError(res, 403, `Can only archive your campus ${this.entityNameLower}s`);
        }
      }

      // Perform archive
      const result = await this.Model.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'archived' } },
        { session }
      );

      await session.commitTransaction();

      return sendSuccess(res, 200, `Archived ${result.modifiedCount} ${this.entityNameLower}s`, {
        archivedCount: result.modifiedCount
      });
    } catch (error) {
      await session.abortTransaction();
      console.error(`❌ Bulk archive error:`, error);
      return sendError(res, 500, `Failed to archive ${this.entityNameLower}s`);
    } finally {
      session.endSession();
    }
  };

  /**
   * EXPORT TO CSV
   */
  exportToCSV = async (req, res) => {
    try {
      const result = await this.exportService.exportToCSV(req.query, req.user);

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      
      return res.send(result.data);
    } catch (error) {
      console.error(`❌ CSV Export error:`, error);
      return sendError(res, 500, error.message || `Failed to export ${this.entityNameLower}s`);
    }
  };

  /**
   * EXPORT TO EXCEL
   */
  exportToExcel = async (req, res) => {
    try {
      const result = await this.exportService.exportToExcel(req.query, req.user);

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      
      return res.send(result.data);
    } catch (error) {
      console.error(`❌ Excel Export error:`, error);
      return sendError(res, 500, error.message || `Failed to export ${this.entityNameLower}s`);
    }
  };

  /**
   * IMPORT FROM CSV/EXCEL
   */
  importFromFile = async (req, res) => {
    try {
      const { campusId, dryRun } = req.body;
      const file = req.file;

      // Validation
      if (!file) {
        return sendError(res, 400, 'File is required');
      }

      if (!campusId) {
        return sendError(res, 400, 'Campus ID is required');
      }

      // Import
      const result = await this.importService.import(
        file,
        campusId,
        req.user.role,
        req.user.campusId,
        { dryRun: dryRun === 'true' || dryRun === true }
      );

      return sendSuccess(res, 200, result.message, result.data);

    } catch (error) {
      console.error(`❌ Import error:`, error);
      return sendError(res, 500, error.message || `Failed to import ${this.entityNameLower}s`);
    }
  };

  /**
   * GET IMPORT TEMPLATE (CSV)
   */
  getImportTemplateCSV = async (req, res) => {
    try {
      const template = this.importService.getTemplateCSV();

      res.setHeader('Content-Type', template.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${template.filename}"`);
      
      return res.send(template.data);
    } catch (error) {
      console.error(`❌ Template generation error:`, error);
      return sendError(res, 500, 'Failed to generate template');
    }
  };

  /**
   * GET IMPORT TEMPLATE (EXCEL)
   */
  getImportTemplateExcel = async (req, res) => {
    try {
      const template = await this.importService.getTemplateExcel();

      res.setHeader('Content-Type', template.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${template.filename}"`);
      
      return res.send(template.data);
    } catch (error) {
      console.error(`❌ Template generation error:`, error);
      return sendError(res, 500, 'Failed to generate template');
    }
  };
}

module.exports = GenericBulkController;