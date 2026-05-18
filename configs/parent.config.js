'use strict';

/**
 * PARENT CONFIGURATION
 *
 * NOTE: The Parent entity uses a hand-written controller
 * (parent.crud.controller.js) rather than GenericEntityController,
 * so this config is NOT consumed by GenericEntityController.
 *
 * Search is implemented directly in getAllParents() and covers:
 *   firstName | lastName | email | parentRef
 *
 * This file is kept for documentation and in case the parent
 * controller is ever migrated to GenericEntityController.
 */
const Parent = require('../models/parent.model');

const parentConfig = {
  Model:      Parent,
  entityName: 'Parent',
  folderName: 'parents',

  searchFields: [
    'firstName',
    'lastName',
    'email',
    'parentRef',
  ],

  populateFields: [
    { path: 'schoolCampus', select: 'campus_name'                       },
    { path: 'children',     select: 'firstName lastName profileImage'    },
  ],

  buildExtraFilters: (query) => {
    const filters = {};
    if (query.relationship) filters.relationship = query.relationship;
    return filters;
  },
};

module.exports = parentConfig;
