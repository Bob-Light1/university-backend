'use strict';

/**
 * @file document.template.controller.js
 * @description Template CRUD and typed document generation.
 *
 * Routes handled:
 *   POST   /api/documents/templates              — Create template
 *   GET    /api/documents/templates              — List (global + campus-own)
 *   GET    /api/documents/templates/:id          — Get template
 *   PATCH  /api/documents/templates/:id          — Update template
 *   DELETE /api/documents/templates/:id          — Delete template
 *   POST   /api/documents/templates/:id/generate — Generate document from template
 *   POST   /api/documents/templates/:id/preview  — Preview rendered HTML
 *
 * Typed generation routes:
 *   POST   /api/documents/generate/student-card/:studentId
 *   POST   /api/documents/generate/student-transcript/:studentId
 *   POST   /api/documents/generate/teacher-payslip/:teacherId
 *   POST   /api/documents/generate/class-list/:classId
 *   POST   /api/documents/generate/badge/:entityType/:entityId
 */

const mongoose = require('mongoose');

const DocumentTemplate = require('../../models/document-models/documentTemplate.model');
const Document         = require('../../models/document-models/document.model');
const { AUDIT_ACTION }     = require('../../models/document-models/documentAudit.model');
const documentService      = require('../../services/document-services/document.service');
const { validateContentBlocks, validateTemplateData } = require('../../services/document-services/document.validation.service');

const Student = require('../../models/student-models/student.model');
const Teacher = require('../../models/teacher-models/teacher.model');
const Class   = require('../../models/class.model');
const Campus  = require('../../models/campus.model');

const {
  sendSuccess, sendCreated, sendError, sendForbidden, sendNotFound, asyncHandler,
} = require('../../utils/responseHelpers');

// ── Template CRUD ─────────────────────────────────────────────────────────────

/**
 * POST /api/documents/templates
 * Only CAMPUS_MANAGER and above can create templates.
 * Global templates (isGlobal=true) require ADMIN/DIRECTOR.
 */
const createTemplate = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Creating templates requires CAMPUS_MANAGER or higher role');
  }

  const dto = { ...req.body };

  if (dto.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    return sendForbidden(res, 'Only ADMIN or DIRECTOR can create global templates');
  }

  // Campus-scoped templates use the requester's campusId
  if (!dto.isGlobal) {
    dto.campusId = req.campusId;
  }

  if (dto.layout && dto.layout.length > 0) {
    validateContentBlocks(dto.layout);
  }

  dto.createdBy = {
    userId:    req.user.id,
    userModel: documentService.resolveUserModel(req.user.role),
  };

  const template = await DocumentTemplate.create(dto);
  return sendCreated(res, 'Template created successfully', { template });
});

/**
 * GET /api/documents/templates
 * Returns both global templates and the campus's own templates.
 */
const listTemplates = asyncHandler(async (req, res) => {
  const filter = {
    isActive: true,
    $or: [
      { isGlobal: true },
      { campusId: req.campusId },
    ],
  };

  if (req.query.type) filter.type = req.query.type;

  const templates = await DocumentTemplate
    .find(filter)
    .sort({ usageCount: -1, createdAt: -1 })
    .lean();

  return sendSuccess(res, 200, 'Templates retrieved', { templates });
});

/**
 * GET /api/documents/templates/:id
 */
const getTemplate = asyncHandler(async (req, res) => {
  const template = await DocumentTemplate.findById(req.params.id).lean();
  if (!template) return sendNotFound(res, 'Template');

  // Campus isolation check
  if (!template.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    if (template.campusId?.toString() !== req.campusId?.toString()) {
      return sendForbidden(res, 'Access denied');
    }
  }

  return sendSuccess(res, 200, 'Template retrieved', { template });
});

/**
 * PATCH /api/documents/templates/:id
 */
const updateTemplate = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Updating templates requires CAMPUS_MANAGER or higher role');
  }

  const template = await DocumentTemplate.findById(req.params.id);
  if (!template) return sendNotFound(res, 'Template');

  if (template.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    return sendForbidden(res, 'Only ADMIN or DIRECTOR can update global templates');
  }

  if (!template.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    if (template.campusId?.toString() !== req.campusId?.toString()) {
      return sendForbidden(res, 'Access denied');
    }
  }

  const dto = { ...req.body };
  if (dto.layout && dto.layout.length > 0) {
    validateContentBlocks(dto.layout);
  }

  dto.lastModifiedBy = {
    userId:    req.user.id,
    userModel: documentService.resolveUserModel(req.user.role),
  };

  Object.assign(template, dto);
  await template.save();

  return sendSuccess(res, 200, 'Template updated successfully', { template });
});

/**
 * DELETE /api/documents/templates/:id
 * Soft-deactivates the template (isActive=false). Does not hard-delete.
 */
const deleteTemplate = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Deleting templates requires CAMPUS_MANAGER or higher role');
  }

  const template = await DocumentTemplate.findById(req.params.id);
  if (!template) return sendNotFound(res, 'Template');

  if (template.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    return sendForbidden(res, 'Only ADMIN or DIRECTOR can delete global templates');
  }

  template.isActive = false;
  await template.save();

  return sendSuccess(res, 200, 'Template deactivated successfully');
});

// ── Generate Document from Template ──────────────────────────────────────────

/**
 * POST /api/documents/templates/:id/generate
 * Body: { templateData: object, title?: string, metadata?: object }
 *
 * Resolves all template variables, creates a new DRAFT document,
 * and writes a TEMPLATE_GENERATE audit entry.
 */
const generateFromTemplate = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Document generation requires CAMPUS_MANAGER or higher role');
  }

  const template = await DocumentTemplate.findById(req.params.id).lean();
  if (!template || !template.isActive) return sendNotFound(res, 'Template');

  // Campus access check
  if (!template.isGlobal && !['ADMIN', 'DIRECTOR'].includes(req.user.role)) {
    if (template.campusId?.toString() !== req.campusId?.toString()) {
      return sendForbidden(res, 'Access denied');
    }
  }

  const { templateData = {}, title, metadata = {} } = req.body;

  // Validate all required template variables are provided
  validateTemplateData(template.variables || [], templateData);

  // Resolve variable placeholders in layout blocks
  const resolvedBody = resolveTemplateVariables(template.layout, templateData);

  // Validate resolved content blocks
  validateContentBlocks(resolvedBody);

  const dto = {
    title:        title || `${template.name} — ${new Date().toLocaleDateString()}`,
    type:         template.type,
    category:     inferCategory(template.type),
    body:         resolvedBody,
    branding:     template.branding,
    printConfig:  template.printConfig,
    templateId:   template._id,
    templateData,
    metadata,
    campusId:     req.campusId,
  };

  const document = await documentService.createDocument(req, dto);

  // Increment template usage count (non-blocking)
  DocumentTemplate.findByIdAndUpdate(template._id, { $inc: { usageCount: 1 } }).catch(() => {});

  // Write template generation audit
  await documentService.writeAudit(null, {
    documentId: document._id,
    campusId:   document.campusId,
    action:     AUDIT_ACTION.TEMPLATE_GENERATE,
    req,
    metadata:   { templateId: template._id, templateName: template.name },
  });

  return sendCreated(res, 'Document generated from template', { document });
});

/**
 * POST /api/documents/templates/:id/preview
 * Returns the rendered HTML for a template without saving to the database.
 */
const previewTemplate = asyncHandler(async (req, res) => {
  const template = await DocumentTemplate.findById(req.params.id).lean();
  if (!template || !template.isActive) return sendNotFound(res, 'Template');

  const { templateData = {} } = req.body;
  const resolvedBody          = resolveTemplateVariables(template.layout, templateData);

  const { buildHtmlTemplate } = require('../services/document.pdf.service');
  const campus     = req.campusId ? await Campus.findById(req.campusId).select('campus_name').lean() : null;
  const mockDoc    = { title: template.name, body: resolvedBody, branding: template.branding, ref: 'PREVIEW' };
  const html       = buildHtmlTemplate(mockDoc, campus?.campus_name || '');

  return sendSuccess(res, 200, 'Template preview generated', { html });
});

// ── Typed Document Generation ─────────────────────────────────────────────────

/**
 * POST /api/documents/generate/student-card/:studentId
 * Generates a student ID card document linked to the given student.
 */
const generateStudentCard = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Generating typed documents requires CAMPUS_MANAGER or higher role');
  }

  const student = await Student.findOne({ _id: req.params.studentId, schoolCampus: req.campusId }).lean();
  if (!student) return sendNotFound(res, 'Student');

  const campus = await Campus.findById(req.campusId).select('campus_name').lean();

  const dto = {
    title:    `Student ID Card — ${student.firstName} ${student.lastName}`,
    type:     'STUDENT_ID_CARD',
    category: 'IDENTITY',
    campusId: req.campusId,
    linkedEntities: [{ entityType: 'Student', entityId: student._id }],
    metadata: {
      studentId:    student._id,
      academicYear: req.body.academicYear || new Date().getFullYear().toString(),
    },
    body: buildStudentCardBlocks(student, campus?.campus_name, req.body),
  };

  const document = await documentService.createDocument(req, dto);
  return sendCreated(res, 'Student ID card generated', { document });
});

/**
 * POST /api/documents/generate/teacher-payslip/:teacherId
 * Body: { month, year, baseSalary, allowances, deductions, signedBy }
 */
const generateTeacherPayslip = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Generating payslips requires CAMPUS_MANAGER or higher role');
  }

  const teacher = await Teacher.findOne({ _id: req.params.teacherId, schoolCampus: req.campusId }).lean();
  if (!teacher) return sendNotFound(res, 'Teacher');

  const { month, year, baseSalary, allowances = [], deductions = [], signedBy } = req.body;

  if (!month || !year || baseSalary === undefined) {
    return sendError(res, 400, 'month, year, and baseSalary are required for payslip generation');
  }

  const campus = await Campus.findById(req.campusId).select('campus_name').lean();

  const dto = {
    title:    `Payslip — ${teacher.firstName} ${teacher.lastName} — ${month}/${year}`,
    type:     'TEACHER_PAYSLIP',
    category: 'FINANCIAL',
    campusId: req.campusId,
    linkedEntities: [{ entityType: 'Teacher', entityId: teacher._id }],
    metadata: { teacherId: teacher._id, month: parseInt(month), year: parseInt(year) },
    body: buildPayslipBlocks({ teacher, campus: campus?.campus_name, month, year, baseSalary, allowances, deductions, signedBy }),
  };

  const document = await documentService.createDocument(req, dto);
  return sendCreated(res, 'Teacher payslip generated', { document });
});

/**
 * POST /api/documents/generate/class-list/:classId
 * Generates a class roster document.
 */
const generateClassList = asyncHandler(async (req, res) => {
  if (!['ADMIN', 'DIRECTOR', 'CAMPUS_MANAGER'].includes(req.user.role)) {
    return sendForbidden(res, 'Generating class lists requires CAMPUS_MANAGER or higher role');
  }

  const classDoc = await Class
    .findOne({ _id: req.params.classId, campus: req.campusId })
    .populate('students', 'firstName lastName gender studentId')
    .populate('mainTeacher', 'firstName lastName')
    .lean();

  if (!classDoc) return sendNotFound(res, 'Class');

  const campus = await Campus.findById(req.campusId).select('campus_name').lean();

  const dto = {
    title:    `Class List — ${classDoc.name || classDoc.className} — ${req.body.academicYear || ''}`,
    type:     'CLASS_LIST',
    category: 'ACADEMIC',
    campusId: req.campusId,
    linkedEntities: [{ entityType: 'Class', entityId: classDoc._id }],
    metadata: {
      classId:      classDoc._id,
      academicYear: req.body.academicYear,
    },
    body: buildClassListBlocks(classDoc, campus?.campus_name, req.body),
  };

  const document = await documentService.createDocument(req, dto);
  return sendCreated(res, 'Class list generated', { document });
});

// ── Template Variable Resolution ──────────────────────────────────────────────

/**
 * Recursively replaces {{variable_key}} placeholders in ContentBlock content fields.
 *
 * @param {object[]} blocks
 * @param {object}   data   - Flat key-value map
 * @returns {object[]}      - Resolved block copies (does not mutate input)
 */
const resolveTemplateVariables = (blocks, data) => {
  const replace = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? `{{${key}}}`);
  };

  const resolveContent = (content) => {
    if (!content || typeof content !== 'object') return replace(content);
    const resolved = {};
    for (const [k, v] of Object.entries(content)) {
      resolved[k] = typeof v === 'string' ? replace(v)
        : Array.isArray(v) ? v.map((i) => (typeof i === 'string' ? replace(i) : i))
        : v;
    }
    return resolved;
  };

  return blocks.map((block) => ({
    ...block,
    content: resolveContent(block.content),
  }));
};

// ── Block Builders (minimal — frontend-overridable via templates) ──────────────

const buildStudentCardBlocks = (student, campusName, extra) => [
  { blockId: 'h1', type: 'HEADING',   order: 0, content: { level: 1, text: campusName || 'Campus', align: 'center' } },
  { blockId: 'h2', type: 'HEADING',   order: 1, content: { level: 2, text: 'STUDENT ID CARD', align: 'center' } },
  { blockId: 'p1', type: 'PARAGRAPH', order: 2, content: { text: `Name: ${student.firstName} ${student.lastName}`, bold: true } },
  { blockId: 'p2', type: 'PARAGRAPH', order: 3, content: { text: `Student ID: ${student.studentId || student._id}` } },
  { blockId: 'p3', type: 'PARAGRAPH', order: 4, content: { text: `Academic Year: ${extra.academicYear || ''}` } },
];

const buildPayslipBlocks = ({ teacher, campus, month, year, baseSalary, allowances, deductions, signedBy }) => {
  const totalAllowances = allowances.reduce((s, a) => s + (a.amount || 0), 0);
  const totalDeductions = deductions.reduce((s, d) => s + (d.amount || 0), 0);
  const netSalary       = baseSalary + totalAllowances - totalDeductions;

  return [
    { blockId: 'h1', type: 'HEADING',   order: 0, content: { level: 1, text: campus || '', align: 'center' } },
    { blockId: 'h2', type: 'HEADING',   order: 1, content: { level: 2, text: 'PAYSLIP', align: 'center' } },
    { blockId: 'p1', type: 'PARAGRAPH', order: 2, content: { text: `Employee: ${teacher.firstName} ${teacher.lastName}`, bold: true } },
    { blockId: 'p2', type: 'PARAGRAPH', order: 3, content: { text: `Period: ${month}/${year}` } },
    { blockId: 't1', type: 'TABLE',     order: 4, content: {
      headers: ['Description', 'Amount'],
      rows: [
        ['Base Salary', `${baseSalary}`],
        ...allowances.map((a) => [a.label, `+${a.amount}`]),
        ...deductions.map((d) => [d.label, `-${d.amount}`]),
        ['NET SALARY', `${netSalary}`],
      ],
      striped: true,
    }},
    { blockId: 's1', type: 'SIGNATURE_PLACEHOLDER', order: 5, content: { label: signedBy || 'Authorized Signatory' } },
  ];
};

const buildClassListBlocks = (classDoc, campusName, extra) => {
  const students = (classDoc.students || []).map((s) => [
    s.studentId || s._id.toString(),
    `${s.firstName} ${s.lastName}`,
    s.gender || '',
  ]);

  return [
    { blockId: 'h1', type: 'HEADING',   order: 0, content: { level: 1, text: campusName || '', align: 'center' } },
    { blockId: 'h2', type: 'HEADING',   order: 1, content: { level: 2, text: `Class List — ${classDoc.name || classDoc.className || ''}`, align: 'center' } },
    { blockId: 'p1', type: 'PARAGRAPH', order: 2, content: { text: `Academic Year: ${extra.academicYear || ''}` } },
    { blockId: 't1', type: 'TABLE',     order: 3, content: {
      headers: ['Student ID', 'Full Name', 'Gender'],
      rows:    students,
      striped: true,
    }},
  ];
};

/**
 * Infers the document category from its type.
 * Used for automatic category assignment in typed generation routes.
 */
const inferCategory = (docType) => {
  const map = {
    STUDENT_ID_CARD:    'IDENTITY',
    STUDENT_TRANSCRIPT: 'ACADEMIC',
    STUDENT_BADGE:      'IDENTITY',
    TEACHER_PAYSLIP:    'FINANCIAL',
    TEACHER_BADGE:      'IDENTITY',
    TEACHER_CONTRACT:   'ADMINISTRATIVE',
    CLASS_LIST:         'ACADEMIC',
    COURSE_MATERIAL:    'ACADEMIC',
    ADMINISTRATIVE:     'ADMINISTRATIVE',
    REPORT:             'ACADEMIC',
    PARTNER_BADGE:      'IDENTITY',
    PARENT_BADGE:       'IDENTITY',
    CUSTOM:             'ADMINISTRATIVE',
    IMPORTED:           'ADMINISTRATIVE',
  };
  return map[docType] || 'ADMINISTRATIVE';
};

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  generateFromTemplate,
  previewTemplate,
  generateStudentCard,
  generateTeacherPayslip,
  generateClassList,
};