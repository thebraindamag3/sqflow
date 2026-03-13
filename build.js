#!/usr/bin/env node
// Generates version.json with a fresh UTC timestamp + short git SHA.
// Run: node build.js  (or: npm run build)
// This file is intentionally gitignored — it is always regenerated at deploy time.

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');
const pkg           = require('./package.json');

// ── Capture git SHA (short, 7 chars) ─────────────────────────
let buildHash = 'unknown';
try {
  buildHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch (_) {
  // Not a git repo or git not available — leave as 'unknown'
}

const buildDate = new Date().toISOString();

const versionData = {
  version:   pkg.version,
  buildDate,
  buildHash,
};

const versionFile = path.join(__dirname, 'version.json');
fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2) + '\n');
console.log(`[build] v${versionData.version} (${buildHash}) → ${buildDate}`);
