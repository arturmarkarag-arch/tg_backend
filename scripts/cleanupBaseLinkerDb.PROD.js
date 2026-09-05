'use strict';

const path = require('path');

// On Render/production MONGODB_URI is already injected. For an intentional
// local administrative run, load the same repo-root .env used by the server.
if (!process.env.MONGODB_URI && process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
}

const { runCleanup } = require('./_cleanupBaseLinkerDb');

runCleanup('PROD').catch((error) => {
  console.error(`\n⛔ ${error?.message || error}`);
  process.exitCode = Number(error?.exitCode || 1);
});
