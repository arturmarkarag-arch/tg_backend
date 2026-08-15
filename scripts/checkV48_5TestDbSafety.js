'use strict';

const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const liveEntries = Object.entries(scripts).filter(([name]) => name.startsWith('test:live:'));
for (const [name, command] of liveEntries) {
  if (!command.includes('-r ../dev-use-test-db.js')) {
    throw new Error(`${name} does not preload the TEST DB guard`);
  }
}

const readiness = scripts['test:db:readiness:preflight'] || '';
if (!readiness.includes('-r ../dev-use-test-db.js')) {
  throw new Error('test:db:readiness:preflight can bypass the TEST DB guard');
}

console.log(`V48.5 TEST DB safety: PASS (${liveEntries.length} live scripts + readiness preflight guarded)`);
