'use strict';

/**
 * @file student.service.js — API inter-modules du domaine student.
 *
 * Exposé :
 *   - entityConfig : config GenericEntityController (consommé par campus,
 *     qui instancie un controller d'entité student pour son dashboard).
 *
 * Reste à résorber : les consommateurs des shims models/student-models/
 * (~13 pour student.model) — vague C du chantier 20b.
 */

const entityConfig = require('./student.config');

module.exports = {
  entityConfig,
};
