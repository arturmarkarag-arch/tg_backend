'use strict';
/**
 * READ-ONLY diagnostic. Connects to MONGODB_URI, tallies which hosts product
 * image URLs point at, and (if a custom-domain host is given) checks whether the
 * new host actually serves a known-good object. Writes NOTHING.
 *
 *   cd NEW_VERSION
 *   node server/scripts/inspect-image-hosts.js
 *   node server/scripts/inspect-image-hosts.js --check https://img.zlotoweczka.com.pl
 */
try { require('dotenv').config(); } catch { /* optional */ }
const mongoose = require('mongoose');
const https = require('https');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : undefined; }
const CHECK_BASE = (arg('check') || process.env.NEW_IMAGE_HOST || 'https://img.zlotoweczka.com.pl').replace(/\/+$/, '');

function getStatus(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 12000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve(`ERR:${e.code || e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.end();
  });
}

(async () => {
  const URI = process.env.MONGODB_URI;
  if (!URI) { console.error('✖ MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(URI);
  const db = mongoose.connection.db;

  const hostCounts = {};
  const samplePaths = []; // collect several distinct paths so the serving check
  const seenPaths = new Set(); // doesn't hinge on one (possibly-missing) object
  const tally = (u) => {
    if (typeof u !== 'string' || !u.startsWith('http')) return;
    try {
      const { host, pathname } = new URL(u);
      hostCounts[host] = (hostCounts[host] || 0) + 1;
      if (samplePaths.length < 40 && pathname.includes('/products/') && !seenPaths.has(pathname)) { seenPaths.add(pathname); samplePaths.push(pathname); }
    } catch { /* skip */ }
  };

  for (const coll of ['products', 'shopproducts']) {
    const cur = db.collection(coll).find({}, { projection: { imageUrls: 1, originalImageUrl: 1, imageUrl: 1, localImageUrl: 1 } });
    for await (const d of cur) {
      if (Array.isArray(d.imageUrls)) d.imageUrls.forEach(tally);
      tally(d.originalImageUrl); tally(d.imageUrl); tally(d.localImageUrl);
    }
  }

  console.log('\nImage URL hosts (field occurrences):');
  const rows = Object.entries(hostCounts).sort((a, b) => b[1] - a[1]);
  if (!rows.length) console.log('  (no http image URLs found)');
  rows.forEach(([h, c]) => console.log(`  ${String(c).padStart(7)}  ${h}`));

  // Verify the new host serves REAL objects. Probe several sample paths on the
  // old r2.dev host until we find ones that exist (200), then compare the SAME
  // paths on the new custom domain. (One sample alone can be a deleted object.)
  const r2Host = rows.map(([h]) => h).find((h) => h.includes('r2.dev'));
  if (r2Host && samplePaths.length) {
    console.log(`\nServing check — probing ${samplePaths.length} sample objects:`);
    let oldOk = 0, oldMissing = 0, newOk = 0, newFail = 0;
    let firstGood = null;
    for (const p of samplePaths) {
      const oldStatus = await getStatus(`https://${r2Host}${p}`);
      if (oldStatus === 200) { oldOk++; if (!firstGood) firstGood = p; } else oldMissing++;
    }
    console.log(`  old r2.dev: ${oldOk} exist (200), ${oldMissing} missing/non-200 (of ${samplePaths.length} probed)`);
    if (firstGood) {
      // Check a handful of the EXISTING objects against the new domain.
      const goodOnes = [];
      for (const p of samplePaths) {
        if (goodOnes.length >= 6) break;
        const s = await getStatus(`https://${r2Host}${p}`);
        if (s === 200) goodOnes.push(p);
      }
      console.log(`\n  Same existing objects on ${CHECK_BASE}:`);
      for (const p of goodOnes) {
        const s = await getStatus(`${CHECK_BASE}${p}`);
        if (s === 200) newOk++; else newFail++;
        console.log(`    ${String(s).padStart(7)}   ${CHECK_BASE}${p}`);
      }
      console.log(`\n  → ${newOk}/${goodOnes.length} existing objects load on the new host.`);
      console.log(newOk === goodOnes.length && newOk > 0
        ? '  ✓ Custom domain serves existing objects → migration is SAFE to --apply.'
        : '  ✗ New host does NOT serve existing objects → fix the R2 custom domain BEFORE --apply.');
    } else {
      console.log('  (No existing object found among the probed samples — try more.)');
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
