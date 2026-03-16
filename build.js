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

// ── Read Twelve Data API key from environment variable ────────
// Injected into index.html as window.SQFLOW_TWELVEDATA_KEY so app.js can read it.
// If absent, Twelve Data is skipped and Yahoo Finance fallback is used.
const twelvedataKey = process.env.VITE_TWELVEDATA_API_KEY || '';

// ── Read EmailJS config from environment variables ────────────
// Required to enable real email delivery from the bug report form.
// 1. Create a free account at https://www.emailjs.com
// 2. Add a Gmail service connected to sqlflow0@gmail.com → copy the Service ID
// 3. Create an email template mapping form fields → copy the Template ID
// 4. Copy your Public Key from Account → API Keys
// 5. Set these env vars in GitHub Actions secrets / Render env / .env:
//    VITE_EMAILJS_PUBLIC_KEY   — your EmailJS public key
//    VITE_EMAILJS_SERVICE_ID   — your EmailJS service ID (e.g. service_xxxxxx)
//    VITE_EMAILJS_TEMPLATE_ID  — your EmailJS template ID (e.g. template_xxxxxx)
const emailjsConfig = {
  publicKey:  process.env.VITE_EMAILJS_PUBLIC_KEY  || '',
  serviceId:  process.env.VITE_EMAILJS_SERVICE_ID  || '',
  templateId: process.env.VITE_EMAILJS_TEMPLATE_ID || '',
};
const hasEmailjsConfig = emailjsConfig.publicKey && emailjsConfig.serviceId && emailjsConfig.templateId;

// ── Copy static assets into dist/ ────────────────────────────
const staticFiles = ['index.html', 'app.js', 'auth.js', 'auth.css', 'style.css', 'firebase.json', 'firestore.rules'];
for (const file of staticFiles) {
  const src = path.join(__dirname, file);
  if (!fs.existsSync(src)) continue;

  if (file === 'index.html') {
    let html = fs.readFileSync(src, 'utf8');
    // Inject window.SQFLOW_FIREBASE_CONFIG before auth.js loads
    if (hasFirebaseConfig) {
      const configScript = `  <script>window.SQFLOW_FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};</script>\n`;
      html = html.replace('  <!-- Auth module must load before app.js', `${configScript}  <!-- Auth module must load before app.js`);
      console.log('[build] Firebase config injected into index.html');
    }
    // Inject window.SQFLOW_TWELVEDATA_KEY for the direct Twelve Data frontend fetch
    if (twelvedataKey) {
      const tdScript = `  <script>window.SQFLOW_TWELVEDATA_KEY = ${JSON.stringify(twelvedataKey)};</script>\n`;
      html = html.replace('  <!-- Auth module must load before app.js', `${tdScript}  <!-- Auth module must load before app.js`);
      console.log('[build] Twelve Data key injected into index.html');
    }
    // Inject window.SQFLOW_EMAILJS_CONFIG for the bug report form EmailJS delivery
    if (hasEmailjsConfig) {
      const ejScript = `  <script>window.SQFLOW_EMAILJS_CONFIG = ${JSON.stringify(emailjsConfig)};</script>\n`;
      html = html.replace('  <!-- Auth module must load before app.js', `${ejScript}  <!-- Auth module must load before app.js`);
      console.log('[build] EmailJS config injected into index.html');
    }
    fs.writeFileSync(path.join(distDir, file), html);
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
