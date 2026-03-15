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

// ── Read Firebase config from environment variables ───────────
// The deploy workflow passes VITE_FIREBASE_* secrets as env vars.
// We inject them inline into index.html as window.SQFLOW_FIREBASE_CONFIG
// so that auth.js (a plain script, not an ES module) can read them.
const firebaseConfig = {
  apiKey:            process.env.VITE_FIREBASE_API_KEY            || '',
  authDomain:        process.env.VITE_FIREBASE_AUTH_DOMAIN        || '',
  projectId:         process.env.VITE_FIREBASE_PROJECT_ID         || '',
  storageBucket:     process.env.VITE_FIREBASE_STORAGE_BUCKET     || '',
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId:             process.env.VITE_FIREBASE_APP_ID             || '',
};

const hasFirebaseConfig = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'your_api_key_here';

// ── Copy static assets into dist/ ────────────────────────────
const staticFiles = ['index.html', 'app.js', 'auth.js', 'auth.css', 'style.css', 'firebase.json', 'firestore.rules'];
for (const file of staticFiles) {
  const src = path.join(__dirname, file);
  if (!fs.existsSync(src)) continue;

  if (file === 'index.html' && hasFirebaseConfig) {
    // Inject window.SQFLOW_FIREBASE_CONFIG before auth.js loads
    let html = fs.readFileSync(src, 'utf8');
    const configScript = `  <script>window.SQFLOW_FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};</script>\n`;
    html = html.replace('  <!-- Auth module must load before app.js', `${configScript}  <!-- Auth module must load before app.js`);
    fs.writeFileSync(path.join(distDir, file), html);
    console.log('[build] Firebase config injected into index.html');
  } else {
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
