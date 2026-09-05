'use strict';

const { getBaseLinkerAccountScope } = require('../../services/baseLinkerAccount');

const QUERY_OPERATIONS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

/**
 * Fail-closed BaseLinker tenant boundary.
 *
 * Service queries are automatically restricted to the BaseLinker account
 * bound to the current process. This makes a future unqualified find/update
 * safe by default instead of relying on every caller to remember the filter.
 */
module.exports = function baseLinkerAccountScopePlugin(schema) {
  schema.pre(QUERY_OPERATIONS, function addCurrentAccountScope(next) {
    this.where({ accountScope: getBaseLinkerAccountScope() });
    next();
  });

  schema.pre('aggregate', function addCurrentAccountScopeToAggregate(next) {
    const accountMatch = { $match: { accountScope: getBaseLinkerAccountScope() } };
    const pipeline = this.pipeline();
    // $geoNear/$search must stay first if a future aggregation uses them.
    if (pipeline[0]?.$geoNear || pipeline[0]?.$search) pipeline.splice(1, 0, accountMatch);
    else pipeline.unshift(accountMatch);
    next();
  });
};
