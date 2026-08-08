'use strict';

// Legacy User rows created before accountState existed have no field. They are
// active unless explicitly marked `removed`.
function isRemovedUser(user) {
  return Boolean(user && user.accountState === 'removed');
}

function activeUserFilter(extra = {}) {
  return {
    ...extra,
    accountState: { $ne: 'removed' },
  };
}

module.exports = { isRemovedUser, activeUserFilter };
