# SqFlow — Cybersecurity Audit Report

**Date:** 2026-03-14
**Auditor:** Claude (Anthropic)
**Repository:** thebraindamag3/sqflow
**Version audited:** v1.4.0
**Scope:** Full application — server.js, app.js, auth.js, build.js, index.html, package.json, .env.example, .gitignore

---

## Executive Summary

SqFlow is a lightweight Node.js + vanilla JavaScript trading signal dashboard. It has **no npm dependencies**, uses Firebase for authentication and cloud storage, and proxies market data from Yahoo Finance and public crypto APIs. The overall security posture is **good for a personal/small-team project**, with several solid design choices: no hardcoded credentials, proper secret management via `.env.local`, sanitized authentication error messages, and a symbol whitelist on the proxy endpoint.

However, several findings require attention — most notably the complete absence of HTTP security headers, overly permissive CORS, and reliance on unverified third-party CORS proxies for market data routing.

No Critical vulnerabilities were found. There are **2 High**, **4 Medium**, and **5 Low** findings.

---

## Severity Summary

| ID   | Severity | Title                                                  | Location               |
|------|----------|--------------------------------------------------------|------------------------|
| H-01 | HIGH     | Missing HTTP security headers across all responses     | server.js              |
| H-02 | HIGH     | CORS wildcard on all API routes                        | server.js:274-278      |
| M-01 | MEDIUM   | Untrusted third-party CORS proxies relay user queries  | app.js:1313-1333       |
| M-02 | MEDIUM   | Auth rate limiting is client-side only (bypassable)    | auth.js:48-73          |
| M-03 | MEDIUM   | Firebase SDK loaded from CDN without Subresource Integrity (SRI) | index.html:254-256 |
| M-04 | MEDIUM   | `interval` and `range` parameters not whitelisted in proxy | server.js:133,154  |
| L-01 | LOW      | `user.photoURL` injected into innerHTML without escaping | auth.js:356-358      |
| L-02 | LOW      | Error message string injected directly into innerHTML  | app.js:1702            |
| L-03 | LOW      | `path.startsWith(__dirname)` susceptible to path confusion | server.js:243-247  |
| L-04 | LOW      | `url.parse` is deprecated (use `new URL()`)            | server.js:270          |
| L-05 | LOW      | Firebase config served unauthenticated                 | server.js:287-290      |

---

## 1. Secret Scanning

**Result: PASS**

- No hardcoded API keys, tokens, passwords, or credentials were found in any source file.
- `.env.local` (which holds real Firebase credentials) is correctly listed in `.gitignore`.
- `.env.example` contains only empty placeholder keys — safe to commit.
- No secrets were found in `package.json`, `build.js`, or any HTML/CSS file.

```
# .gitignore — correctly excludes credential files
.env.local
.env*.local
```

**Recommendation:** Keep the current practice. Consider adding a pre-commit hook (e.g., `git-secrets` or `gitleaks`) to automatically prevent accidental credential commits in the future.

---

## 2. Dependency Analysis

**Result: PASS (minimal attack surface)**

`package.json` declares **zero runtime dependencies**. The only tool dependency is `node` itself (the built-in `http`, `https`, `fs`, `path`, `url`, and `child_process` modules are used). This eliminates the entire class of supply-chain vulnerabilities from third-party npm packages.

```json
{
  "name": "sqflow",
  "version": "1.4.0",
  "scripts": { "start": "node server.js", "build": "node build.js" }
}
```

**Front-end dependencies via CDN:**

| Library        | Version | Source                      | Risk  |
|----------------|---------|-----------------------------|-------|
| Firebase App   | 9.23.0  | gstatic.com CDN             | See M-03 |
| Firebase Auth  | 9.23.0  | gstatic.com CDN             | See M-03 |
| Firebase Firestore | 9.23.0 | gstatic.com CDN          | See M-03 |

Firebase 9.23.0 (compat build) was released in 2023. As of early 2026, the current stable is Firebase v10.x. While the compat SDK remains functional, upgrading to Firebase v10 modular API would reduce bundle size and benefit from the latest security patches.

**Recommendation:** Upgrade Firebase SDK to the latest stable v10 and add SRI hashes to the `<script>` tags (see M-03).

---

## 3. OWASP Top 10

### A01: Broken Access Control — PARTIAL PASS

All market data and static assets are intentionally public. The Firebase config endpoint (`/api/firebase-config`) is unauthenticated by design (see L-05). Firestore access is controlled by Firebase Security Rules (not audited here — see recommendation below).

**Recommendation:** Review Firestore security rules in the Firebase console to ensure users can only read/write their own `users/{uid}/state/**` documents. A minimal safe ruleset:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/state/{document} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### A02: Cryptographic Failures — PASS

- No sensitive data is stored server-side.
- Firebase SDK handles JWT issuance, rotation, and short-lived token management automatically.
- No custom cryptography is implemented.
- HTTPS is not enforced by the Node.js server itself but is expected to be handled by the deployment platform (GitHub Pages or a reverse proxy). Document this assumption explicitly.

### A03: Injection — PARTIAL PASS

- **SQL Injection**: Not applicable (no database on the server).
- **Command Injection** (`build.js`): `execSync('git rev-parse --short HEAD')` does not use user input — no risk.
- **Path Traversal**: See L-03.
- **URL Injection in proxy**: See M-04.
- **XSS**: See L-01 and L-02.

### A04: Insecure Design — PARTIAL PASS

The auth rate-limiting is client-side only (see M-02). The overall architecture is simple and does not introduce complex attack surfaces. Trade data is scoped per authenticated user in Firestore.

### A05: Security Misconfiguration — FAIL

Missing security headers on all HTTP responses (see H-01). CORS is misconfigured (see H-02).

### A06: Vulnerable and Outdated Components — PARTIAL PASS

No vulnerable npm packages. Firebase SDK is outdated (9.x vs 10.x). CDN resources lack SRI (see M-03).

### A07: Identification and Authentication Failures — PARTIAL PASS

- Authentication errors are correctly generalized (no email enumeration): `_sanitizeError()` in `auth.js:76-92` maps all Firebase error codes to generic messages.
- Rate limiting exists but is client-side only (see M-02).
- Google OAuth uses `prompt: 'select_account'` to prevent account confusion.

### A08: Software and Data Integrity Failures — FAIL

Firebase SDK loaded from CDN without SRI hashes. See M-03.

### A09: Security Logging and Monitoring Failures — PARTIAL PASS

- Server logs proxy requests via `console.log` and errors via `console.error`.
- No structured logging, no alerting, no audit trail for authentication events.
- For a personal/small project this is acceptable; for production use, structured logging should be added.

### A10: Server-Side Request Forgery (SSRF) — PASS

The Yahoo Finance proxy uses a strict symbol whitelist:

```javascript
// server.js:142-147
const yahooSymbol = YAHOO_SYMBOLS[symbol];
if (!yahooSymbol) {
  res.writeHead(400, { ... });
  res.end(JSON.stringify({ error: `Unsupported symbol: ${symbol}` }));
  return;
}
```

Only symbols defined in the `YAHOO_SYMBOLS` map are forwarded. The final URL is constructed using `encodeURIComponent(yahooSymbol)`. This effectively prevents arbitrary SSRF via the symbol parameter. The `interval` and `range` parameters have a lower-severity issue (see M-04).

---

## 4. Security Headers

**Finding: H-01 — HIGH**

The Node.js HTTP server sends **no HTTP security headers** on any response. This exposes users to clickjacking, MIME-type sniffing attacks, cross-site scripting, and protocol downgrade attacks.

**Evidence** — `server.js:218-222` (market data response) and `server.js:263` (static file response):
```javascript
res.writeHead(200, { 'Content-Type': contentType });  // No security headers
res.end(data);
```

**Missing headers:**

| Header                      | Risk if absent                     |
|-----------------------------|------------------------------------|
| `Content-Security-Policy`   | XSS, data injection                |
| `X-Frame-Options`           | Clickjacking                       |
| `X-Content-Type-Options`    | MIME-type sniffing                 |
| `Strict-Transport-Security` | Protocol downgrade / SSL stripping |
| `Referrer-Policy`           | Sensitive URL leakage              |
| `Permissions-Policy`        | Unwanted browser feature access    |

**Recommendation:** Add a security headers helper and apply it to all responses:

```javascript
// server.js — add this helper function
function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://www.gstatic.com",
      "connect-src 'self' https://api-pub.bitfinex.com https://api.binance.com https://query1.finance.yahoo.com https://api.allorigins.win https://corsproxy.io https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://lh3.googleusercontent.com",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  // Only add HSTS if running over HTTPS
  // res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Call addSecurityHeaders(res) at the top of the request handler,
// before any writeHead() call.
```

---

## 5. Authentication & Authorization

**Overall: GOOD with caveats**

### Strengths

- Firebase Auth handles token lifecycle, refresh, and storage securely.
- Password policy enforced client-side: minimum 8 characters, uppercase, number, and special character (`auth.js:39-45`).
- Error messages are sanitized to prevent email enumeration (`auth.js:76-92`).
- Google OAuth uses `prompt: 'select_account'` to prevent silent account reuse.
- Guest-to-authenticated migration is handled gracefully.
- XSS escape function `_esc()` is implemented and used for user display names (`auth.js:598-604`).

### Finding: M-02 — MEDIUM — Client-side only rate limiting

Rate limiting for email/password sign-in is implemented entirely in `localStorage`:

```javascript
// auth.js:48-73
function _isRateLimited() {
  const until = parseInt(localStorage.getItem(_AUTH_KEYS.LOCKOUT_UNTIL) || '0', 10);
  // ...
}
```

**Risk:** An attacker can bypass this entirely by:
- Clearing `localStorage` between attempts
- Using a different browser or incognito window
- Using an automated tool that doesn't execute JavaScript

**Mitigation:** Firebase's own backend enforces server-side rate limiting (`auth/too-many-requests` error), which is the actual line of defense. The client-side rate limiting provides UX feedback only and should be understood as such — not relied upon for security.

**Recommendation:** Add a comment to `auth.js` clarifying this. For production deployments, consider enabling Firebase App Check to enforce attestation.

---

## 6. Input Validation

### Finding: M-04 — MEDIUM — `interval` and `range` not whitelisted in proxy

**Evidence** — `server.js:133-154`:
```javascript
let interval = query.interval || '4h';
const range = query.range || '3mo';
// ...
const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/...?interval=${yahooInterval}&range=${yahooRange}`;
```

The `interval` and `range` query parameters are read directly from user input and appended to the Yahoo Finance URL without validation. While `encodeURIComponent` is applied to the symbol, the interval and range values are not encoded, allowing URL parameter injection into the Yahoo Finance request.

**Recommendation:** Validate against explicit allowlists:

```javascript
const VALID_INTERVALS = new Set(['1m','5m','15m','30m','1h','4h','1d','1wk','1mo']);
const VALID_RANGES    = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);

const interval = VALID_INTERVALS.has(query.interval) ? query.interval : '1h';
const range    = VALID_RANGES.has(query.range)    ? query.range    : '3mo';
```

### Finding: L-01 — LOW — `user.photoURL` in innerHTML without escaping

**Evidence** — `auth.js:356-358`:
```javascript
const photo = user.photoURL;
const avatarHTML = photo
  ? `<img class="user-avatar-img" src="${photo}" alt="" referrerpolicy="no-referrer" />`
  : ...
```

`user.photoURL` is a URL from Firebase and is trusted in normal operation. However, if the value contains `"` characters (e.g., via an account with a specially crafted photo URL), it could break out of the `src` attribute and inject HTML attributes. The risk is low because Firebase sanitizes these values, but defense-in-depth is advisable.

**Recommendation:** Use `_esc(photo)` or set the `src` attribute via `setAttribute` rather than template string interpolation.

### Finding: L-02 — LOW — Error message string in innerHTML

**Evidence** — `app.js:1689-1704`:
```javascript
const safeMsg = (err.message && !looksLikeHtml(err.message))
  ? err.message
  : `Market data unavailable...`;

signalCard.innerHTML = `
  ...
  <div class="error-state-message">${safeMsg}</div>
  <pre>${safeMsg}</pre>
  ...
`;
```

`err.message` originates from network errors (CORS proxy responses, Yahoo Finance errors, Binance/Bitfinex errors). The `looksLikeHtml` check only strips full HTML documents, not HTML fragments. A malicious proxy response could inject `<script>` or HTML into the error message.

**Recommendation:** Use `textContent` instead of innerHTML for error messages, or apply HTML entity encoding to `safeMsg` before interpolation:

```javascript
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Then: <div class="error-state-message">${escHtml(safeMsg)}</div>
```

---

## 7. Rate Limiting & Attack Protection

**Finding: H-01 partially covers this** — no server-side rate limiting exists on any endpoint.

| Endpoint              | Rate limited? | Notes |
|-----------------------|---------------|-------|
| `/api/market-data`    | No            | Could be abused to hammer Yahoo Finance |
| `/api/firebase-config`| No            | Low-value endpoint but still open |
| Static files          | No            | Standard, low risk |

The Yahoo Finance proxy makes outbound requests to `query1.finance.yahoo.com`. An attacker could use it as a makeshift request amplifier or to exhaust any rate limits Yahoo Finance enforces against the server's IP.

**Recommendation:** Add a simple request rate limiter using a token-bucket pattern (no dependencies required):

```javascript
// Simple in-memory rate limiter: max 60 requests per minute per IP
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > 60;
}
```

---

## 8. General Configuration

### Correct practices found

- `.env.local` and `.env*.local` are in `.gitignore` — credentials are not committed.
- `.env.example` uses empty values — safe template.
- `YAHOO_SYMBOLS` whitelist prevents arbitrary SSRF on the proxy endpoint.
- Firebase tokens are managed by the SDK (not stored in `localStorage` manually).
- `path.normalize` + `__dirname` boundary check is used in the static file server.

### Finding: H-02 — HIGH — CORS wildcard on all API routes

**Evidence** — `server.js:274-278`:
```javascript
if (pathname.startsWith('/api/')) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
```

`Access-Control-Allow-Origin: *` allows any website on the internet to make cross-origin requests to the API — including `/api/firebase-config` which exposes the Firebase project configuration.

**Recommendation:** Restrict CORS to known origins:

```javascript
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'https://thebraindamag3.github.io',   // GitHub Pages deployment
]);

function setCORSHeaders(req, res) {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
```

### Finding: L-03 — LOW — `startsWith(__dirname)` path confusion

**Evidence** — `server.js:243-247`:
```javascript
const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
const filePath = path.join(__dirname, safePath);

if (!filePath.startsWith(__dirname)) {
  res.writeHead(403);
  res.end('Forbidden');
  return;
}
```

If `__dirname` is `/app` and the resolved `filePath` is `/application/secret.txt`, then `filePath.startsWith('/app')` returns `true` even though the file is outside the project directory. This is a known path confusion issue with string prefix checks.

**Recommendation:** Use `path.sep` as a separator in the check:

```javascript
// Ensure the resolved path is truly inside __dirname
const projectDir = __dirname + path.sep;
if (filePath !== __dirname && !filePath.startsWith(projectDir)) {
  res.writeHead(403);
  res.end('Forbidden');
  return;
}
```

### Finding: L-04 — LOW — `url.parse` is deprecated

**Evidence** — `server.js:270`:
```javascript
const parsed = url.parse(req.url, true);
```

`url.parse` is deprecated in Node.js and has known quirks with certain URL inputs. The WHATWG `URL` API is the modern replacement.

**Recommendation:**
```javascript
// Replace url.parse with WHATWG URL API
const parsed = new URL(req.url, `http://localhost`);
const pathname = parsed.pathname;
const query = Object.fromEntries(parsed.searchParams);
```

### Finding: L-05 — LOW — Firebase config served unauthenticated

**Evidence** — `server.js:287-290`:
```javascript
if (pathname === '/api/firebase-config' && req.method === 'GET') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getFirebaseConfig()));
  return;
}
```

The Firebase Web API key and project identifiers are served to any client without authentication. **This is by design** — Firebase Web API keys are public client-side identifiers, not secrets, and must be embedded in client applications. However, this endpoint:

1. Makes it easy for anyone to enumerate the Firebase project ID.
2. Could allow unauthorized Firebase sign-up (if Firebase Authentication settings allow it).

**Recommendation:**
- In the Firebase console, restrict the API key to allowed referrer domains (HTTP referrer restrictions).
- Enable Firebase App Check to prevent unauthorized clients from using your Firebase project.
- Consider setting `signIn` methods to invitation-only if the app is not meant to be public.

---

## 9. Additional Findings

### Finding: M-01 — MEDIUM — Untrusted third-party CORS proxies

**Evidence** — `app.js:1313-1333`:
```javascript
const corsProxies = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];
```

When running on GitHub Pages (no local server), market data requests to Yahoo Finance are routed through `allorigins.win` and `corsproxy.io`. These are:

1. **Free, unverified public services** with no SLA or security guarantees.
2. **Able to observe all market data requests** made by users (symbols, timeframes, timestamps).
3. **Able to serve manipulated data** — a compromised proxy could return fake candle data, causing the signal engine to produce incorrect trading signals.
4. **Unreliable** — downtime of these services would break the app for GitHub Pages deployments.

**Recommendation:**
- Always use the local server proxy (`/api/market-data`) for production deployments. Avoid GitHub Pages for this application if financial accuracy is important.
- If a public deployment is required, deploy the Node.js server (e.g., on Railway, Render, Fly.io) rather than using a static host with third-party proxies.
- If third-party proxies must be used, validate the response schema before processing (already partially done via `parseYahooChartResponse` — good).

### Finding: M-03 — MEDIUM — Firebase SDK loaded without Subresource Integrity

**Evidence** — `index.html:254-256`:
```html
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js"></script>
```

If Google's CDN were compromised (or a CDN-level MITM were performed), a modified Firebase SDK could be injected — capturing credentials, session tokens, or manipulating authentication.

**Recommendation:** Add `integrity` and `crossorigin` attributes using the SHA-384 hash of each script. Generate hashes with:

```bash
curl -s https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Then apply:
```html
<script
  src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"
  integrity="sha384-<HASH>"
  crossorigin="anonymous">
</script>
```

Alternatively, self-host the Firebase SDK or use a build tool to bundle it.

---

## 10. Recommendations — Priority Order

| Priority | Finding | Action |
|----------|---------|--------|
| 1 | H-01 | Add `addSecurityHeaders()` helper and apply to all responses in `server.js` |
| 2 | H-02 | Replace `Access-Control-Allow-Origin: *` with an origin allowlist |
| 3 | M-01 | Deploy the Node.js server rather than using third-party CORS proxies |
| 4 | M-03 | Add SRI hashes to Firebase CDN `<script>` tags |
| 5 | M-04 | Whitelist `interval` and `range` parameters in the Yahoo Finance proxy |
| 6 | M-02 | Document that client-side rate limiting is UX-only; enable Firebase App Check |
| 7 | L-01 | Escape `user.photoURL` before using in innerHTML |
| 8 | L-02 | Use `textContent` or escape `safeMsg` before innerHTML injection |
| 9 | L-03 | Fix `startsWith(__dirname)` path confusion with `path.sep` boundary check |
| 10 | L-04 | Replace `url.parse` with `new URL()` |
| 11 | L-05 | Apply Firebase API key referrer restrictions and consider App Check |
| 12 | A01  | Audit Firestore security rules in the Firebase console |

---

## Positive Security Practices

The following security-conscious decisions were found in the codebase and should be maintained:

- **No hardcoded credentials** — all secrets managed via `.env.local` with proper `.gitignore` entries.
- **SSRF protection** — the Yahoo Finance proxy uses a strict symbol whitelist, preventing arbitrary outbound requests.
- **Error message sanitization** — `_sanitizeError()` in `auth.js` prevents email enumeration across all Firebase error codes.
- **HTML escaping** — `_esc()` function in `auth.js` is implemented and used for user display names.
- **HTML injection prevention** — `looksLikeHtml()` check prevents full HTML error pages from being displayed.
- **Zero npm dependencies** — eliminates the entire supply-chain risk category from third-party packages.
- **Guest mode** — unauthenticated users can use the app without creating an account, reducing credential collection.
- **Password policy** — enforces minimum strength (8+ chars, uppercase, number, special char).
- **Path traversal mitigation** — static file server includes directory boundary check.
- **`referrerpolicy="no-referrer"`** — applied to user avatar `<img>` tags.

---

*This report was generated by automated static analysis and manual code review. It does not include dynamic testing, penetration testing, or runtime behavior analysis. Firestore security rules were not audited as they are configured externally in the Firebase console.*
