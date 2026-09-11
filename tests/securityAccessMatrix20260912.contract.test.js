'use strict';

const { runChecks } = require('../scripts/checkSecurityAccessMatrix20260912');

describe('Security access matrix 2026-09-12', () => {
  it('keeps REST and Socket role/data boundaries fail-closed', () => {
    expect(() => runChecks({ quiet: true })).not.toThrow();
  });
});
