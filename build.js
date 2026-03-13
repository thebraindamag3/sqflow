#!/usr/bin/env node
// Stamps the current UTC timestamp into version.json before deploy.
// Run: node build.js  (or: npm run build)

const fs   = require('fs');
const path = require('path');

const versionFile = path.join(__dirname, 'version.json');
const v = JSON.parse(fs.readFileSync(versionFile, 'utf8'));

v.buildDate = new Date().toISOString();

fs.writeFileSync(versionFile, JSON.stringify(v, null, 2) + '\n');
console.log(`[build] Timestamp set → ${v.buildDate}`);
