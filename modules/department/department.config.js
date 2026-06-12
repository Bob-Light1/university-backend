const Department = require('./department.model');
const mongoose = require('mongoose');

/**
 * DEPARTMENT CONFIGURATION FOR GENERIC ENTITY CONTROLLER
 */
const departmentConfig = {
  Model: Department,
  entityName: 'Department',
  folderName: null, // no file uploads

  searchFields: ['name', 'code', 'description'],

  populateFields: [
    { path: 'schoolCampus', select: 'campus_name location' },
    { path: 'headOfDepartment', select: 'firstName lastName email matricule' },
  ],

  /**
   * buildExtraFilters — no extra query params needed currently
   */
  buildExtraFilters: () => ({}),

  /**
   * statsFacets — analytics for department management
   */
  statsFacets: (startOfMonth) => ({
    byStatus: [
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ],
    newThisMonth: [
      { $match: { createdAt: { $gte: startOfMonth } } },
      { $count: 'count' },
    ],
  }),

  /**
   * statsFormatter
   */
  statsFormatter: (result) => ({
    byStatus: (result.byStatus || []).reduce((acc, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {}),
    newThisMonth: result.newThisMonth?.[0]?.count || 0,
  }),
};

module.exports = departmentConfig;