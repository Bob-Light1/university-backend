const Campus = require('./campus.model');

/**
 * CAMPUS CONFIGURATION FOR GENERIC ENTITY CONTROLLER
 * Defines Campus-specific behavior while leveraging generic CRUD operations
 */

module.exports = {
  Model: Campus,
  entityName: 'Campus',
  folderName: 'campuses',
  
  searchFields: ['campus_name', 'manager_name', 'email', 'campus_number', 'location.city'],
  
  populateFields: [], // Campus has no references to populate
  
  /**
   * Custom validation for campus creation
   */
  customValidation: async (fields, campusId, session) => {
    // No additional validation needed for campus
    return { valid: true };
  },

  /**
   * Before create hook - Campus-specific logic
   */
  beforeCreate: async (fields, campusId, session) => {
    // Campus doesn't need a campusId reference (it IS the campus)
    // This hook allows us to skip the standard campus assignment
    return { success: true };
  },

  /**
   * After create hook
   */
  afterCreate: async (campus) => {
    // Could trigger notifications, welcome emails, etc.
    console.log(`✅ Campus created: ${campus.campus_name}`);
  },

  /**
   * Before update hook
   */
  beforeUpdate: async (campus, updates) => {
    // Prevent certain fields from being updated
    delete updates._id;
    delete updates.createdAt;
    delete updates.__v;
    delete updates.password; 

    return { success: true };
  },

  /**
   * After update hook
   */
  afterUpdate: async (campus) => {
    console.log(`✅ Campus updated: ${campus.campus_name}`);
  },

  /**
   * Custom statistics facets for campus
   */
  statsFacets: (startOfMonth) => ({
    byStatus: [
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ],
    
    byCity: [
      {
        $group: {
          _id: "$location.city",
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ],
    
    recentlyCreated: [
      { $match: { createdAt: { $gte: startOfMonth } } },
      {
        $project: {
          campus_name: 1,
          manager_name: 1,
          location: 1,
          createdAt: 1
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: 5 }
    ]
  }),

  /**
   * Format statistics output
   */
  statsFormatter: (result) => ({
    byStatus: result.byStatus || [],
    topCities: result.byCity || [],
    recentCampuses: result.recentlyCreated || []
  })
};