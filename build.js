#!/usr/bin/env node
// Generates version.json and assembles the dist/ folder for GitHub Pages.
// Run: node build.js  (or: npm run build)

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

// ── Create dist/ folder ───────────────────────────────────────
const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// ── Write version.json into dist/ ────────────────────────────
const versionFile = path.join(distDir, 'version.json');
fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2) + '\n');

// ── Copy static assets into dist/ ────────────────────────────
const staticFiles = ['index.html', 'app.js', 'auth.js', 'auth.css', 'style.css'];
for (const file of staticFiles) {
  const src = path.join(__dirname, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(distDir, file));
  }
}

// ── Copy src/ directory into dist/src/ ───────────────────────
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const srcDir = path.join(__dirname, 'src');
if (fs.existsSync(srcDir)) {
  copyDir(srcDir, path.join(distDir, 'src'));
}

console.log(`[build] v${versionData.version} (${buildHash}) → ${buildDate}`);
console.log(`[build] dist/ folder created at ${distDir}`);
