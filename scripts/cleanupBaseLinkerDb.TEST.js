'use strict';

// TEST cleanup is intentionally impossible without the same preload/host guard
// used by the destructive live TEST harnesses.
const { runCleanup } = require('./_cleanupBaseLinkerDb');

runCleanup('TEST').catch((error) => {
  console.error(`\n⛔ ${error?.message || error}`);
  process.exitCode = Number(error?.exitCode || 1);
});
