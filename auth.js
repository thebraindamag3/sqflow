// ============================================================
// SqFlow — Authentication Module
// Firebase Auth + Firestore
//
// Supports: Google OAuth, Email + Password, Guest session
//
// SETUP:
//   1. Go to https://console.firebase.google.com
//   2. Create a project (or select existing)
//   3. Enable Authentication providers: Google, Email/Password
//   4. Enable Firestore Database (start in production mode)
//   5. Copy .env.example to .env.local and fill in your Firebase credentials
//   6. Restart the dev server (npm start)
// ============================================================

// ── Firebase project configuration ───────────────────────────
// Loaded at runtime from the server (/api/firebase-config).
// The server reads credentials from .env.local (never committed).
// See .env.example for the required keys.
let FIREBASE_CONFIG = null;

// ── Rate-limiting constants ───────────────────────────────────
// Brute-force protection: max 5 email/password sign-in attempts per minute per browser.
// (Firebase also enforces server-side rate limiting.)
const _AUTH_RATE = {
  maxAttempts: 5,
  windowMs:    60_000,  // 1-minute sliding window
  lockoutMs:   60_000,  // 1-minute lockout after limit hit
};

const _AUTH_KEYS = {
  ATTEMPTS:      'sqFlow_loginAttempts',
  LOCKOUT_UNTIL: 'sqFlow_lockoutUntil',
};

// ── Helpers ───────────────────────────────────────────────────

// Strict password policy: 8+ chars, uppercase, number, special char.
function _validatePassword(pwd) {
  if (!pwd || pwd.length < 8)          return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pwd))              return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(pwd))              return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(pwd))       return 'Password must contain at least one special character (e.g. !@#$%).';
  return null;
}

// Returns an error message if the user is rate-limited, null otherwise.
function _isRateLimited() {
  const until = parseInt(localStorage.getItem(_AUTH_KEYS.LOCKOUT_UNTIL) || '0', 10);
  if (Date.now() < until) {
    const s = Math.ceil((until - Date.now()) / 1000);
    return `Too many sign-in attempts. Please wait ${s}s and try again.`;
  }
  return null;
}

// Records a login attempt; triggers lockout after maxAttempts failures in windowMs.
function _recordAttempt(success) {
  if (success) {
    localStorage.removeItem(_AUTH_KEYS.ATTEMPTS);
    localStorage.removeItem(_AUTH_KEYS.LOCKOUT_UNTIL);
    return;
  }
  const now = Date.now();
  let list = [];
  try { list = JSON.parse(localStorage.getItem(_AUTH_KEYS.ATTEMPTS) || '[]'); } catch (_) {}
  list = list.filter(t => now - t < _AUTH_RATE.windowMs);
  list.push(now);
  localStorage.setItem(_AUTH_KEYS.ATTEMPTS, JSON.stringify(list));
  if (list.length >= _AUTH_RATE.maxAttempts) {
    localStorage.setItem(_AUTH_KEYS.LOCKOUT_UNTIL, String(now + _AUTH_RATE.lockoutMs));
  }
}

// Generic error messages — never reveal whether an email address exists.
function _sanitizeError(code) {
  const MAP = {
    'auth/invalid-credential':                       'Incorrect email or password.',
    'auth/wrong-password':                           'Incorrect email or password.',
    'auth/user-not-found':                           'Incorrect email or password.',
    'auth/email-already-in-use':                     'Unable to create account. Try a different email or sign in instead.',
    'auth/invalid-email':                            'Please enter a valid email address.',
    'auth/too-many-requests':                        'Too many failed attempts. Please wait before trying again.',
    'auth/network-request-failed':                   'Network error. Check your connection and try again.',
    'auth/popup-closed-by-user':                     'Sign-in window closed. Please try again.',
    'auth/cancelled-popup-request':                  'Sign-in cancelled.',
    'auth/popup-blocked':                            'Pop-up blocked. Please allow pop-ups for this site.',
    'auth/account-exists-with-different-credential': 'An account with this email exists using a different sign-in method.',
    'auth/operation-not-allowed':                    'This sign-in method is not currently enabled.',
  };
  return MAP[code] || 'Authentication failed. Please try again.';
}

function _isFirebaseConfigured() {
  return FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
}

function _parseLs(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch (_) { return fallback; }
}

// ── Auth module ───────────────────────────────────────────────
const Auth = (() => {
  let _auth    = null;
  let _db      = null;
  let _user    = null;
  let _guest   = true;
  let _ready   = false;
  let _cbQueue = [];
  let _mode    = 'signin';   // 'signin' | 'register'
  let _modal   = null;

  // ── Initialization ─────────────────────────────────────────
  async function _init() {
    // Fetch Firebase config from the server (reads .env.local)
    try {
      const res = await fetch('/api/firebase-config');
      if (res.ok) FIREBASE_CONFIG = await res.json();
    } catch (_) {
      // Server unreachable — will fall through to guest mode
    }

    // Validate required config keys
    if (_isFirebaseConfigured()) {
      const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
      const missingKeys = requiredKeys.filter(key => !FIREBASE_CONFIG[key]);
      if (missingKeys.length > 0) {
        console.error(`[SqFlow Auth] Firebase config incomplete. Missing: ${missingKeys.join(', ')}`);
        FIREBASE_CONFIG = null; // Force guest mode
      }
    }

    if (!_isFirebaseConfigured()) {
      console.warn('[SqFlow Auth] Firebase not configured — running in guest-only mode.');
      _guest = true;
      _ready = true;
      _flush({ user: null, isGuest: true, firebaseReady: false });
      _renderHeaderUser(null);
      _renderGuestBanner(true);
      _showAuthModal();
      return;
    }

    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      _auth = firebase.auth();
      _db   = firebase.firestore();

      // Firebase handles JWT issuance, rotation, and httpOnly cookie storage
      // internally via its SDK. The access token is short-lived and the
      // refresh token is managed securely by the Firebase SDK.
      _auth.onAuthStateChanged(async user => {
        const wasGuest = _guest && !_user;
        _user  = user;
        _guest = !user;
        _ready = true;

        if (user && wasGuest) {
          // Mid-session guest → account conversion: migrate session data first.
          await _migrateGuestData();
        }

        if (user) {
          await _syncFromCloud();
        }

        _renderHeaderUser(user);
        _renderGuestBanner(!user);
        _flush({ user, isGuest: !user, firebaseReady: true });

        if (!user) _showAuthModal();
        else       _hideAuthModal();
      });
    } catch (e) {
      console.error('[SqFlow Auth] Firebase init error:', e);
      _guest = true;
      _ready = true;
      _flush({ user: null, isGuest: true, firebaseReady: false });
      _renderGuestBanner(true);
      _showAuthModal();
    }
  }

  function _flush(payload) {
    _cbQueue.forEach(fn => fn(payload));
    _cbQueue = [];
  }

  // ── Firestore cloud sync ────────────────────────────────────
  // Loads trade data from Firestore and updates localStorage,
  // then triggers app re-render. Authenticated users have their
  // data available across devices and deploys.
  async function _syncFromCloud() {
    if (!_db || !_user) return;
    try {
      const uid = _user.uid;
      const [tradesDoc, histDoc] = await Promise.all([
        _db.collection('users').doc(uid).collection('state').doc('activeTrades').get(),
        _db.collection('users').doc(uid).collection('state').doc('tradeHistory').get(),
      ]);

      if (tradesDoc.exists) {
        localStorage.setItem('sqFlow_activeTrades', JSON.stringify(tradesDoc.data().trades || []));
      }
      if (histDoc.exists) {
        localStorage.setItem('sqFlow_tradeHistory', JSON.stringify(histDoc.data().history || []));
      }

      // Reload app data from updated localStorage
      if (typeof loadTrades         === 'function') loadTrades();
      if (typeof renderTradeMonitors === 'function') renderTradeMonitors();
      if (typeof renderTradeHistory  === 'function') renderTradeHistory();
      if (typeof ensureMonitorRunning === 'function' &&
          typeof state !== 'undefined' && state.activeTrades?.length > 0) {
        ensureMonitorRunning();
      }
    } catch (e) {
      console.error('[SqFlow Auth] Cloud sync failed:', e);
    }
  }

  // Migrates in-memory guest session data to Firestore,
  // merging with any existing cloud data before discarding the guest session.
  async function _migrateGuestData() {
    if (!_db || !_user) return;
    try {
      const guestTrades  = _parseLs('sqFlow_activeTrades', []);
      const guestHistory = _parseLs('sqFlow_tradeHistory', []);
      if (!guestTrades.length && !guestHistory.length) return;

      const uid = _user.uid;
      const [tradesDoc, histDoc] = await Promise.all([
        _db.collection('users').doc(uid).collection('state').doc('activeTrades').get(),
        _db.collection('users').doc(uid).collection('state').doc('tradeHistory').get(),
      ]);

      const cloudTrades  = tradesDoc.exists ? (tradesDoc.data().trades  || []) : [];
      const cloudHistory = histDoc.exists   ? (histDoc.data().history   || []) : [];

      // Guest data takes precedence; cloud items are appended if not already present.
      const mergedTrades  = [
        ...guestTrades,
        ...cloudTrades.filter(t => !guestTrades.some(g => g.id === t.id)),
      ];
      const mergedHistory = [
        ...guestHistory,
        ...cloudHistory.filter(h => !guestHistory.some(g => g.id === h.id)),
      ].slice(0, 200);

      await Promise.all([
        _db.collection('users').doc(uid).collection('state').doc('activeTrades')
           .set({ trades: mergedTrades, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
        _db.collection('users').doc(uid).collection('state').doc('tradeHistory')
           .set({ history: mergedHistory, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      ]);
      console.log('[SqFlow Auth] Guest session data migrated to Firestore.');
    } catch (e) {
      console.error('[SqFlow Auth] Migration failed:', e);
    }
  }

  // ── Auth operations ─────────────────────────────────────────

  async function signInWithGoogle() {
    if (!_auth) throw new Error('Google sign-in is not yet configured. The Firebase project credentials need to be added to enable this provider.');
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { return await _auth.signInWithPopup(provider); }
    catch (e) { throw new Error(_sanitizeError(e.code)); }
  }

  async function signInWithEmail(email, password) {
    if (!_auth) throw new Error('Firebase not configured. Please set up FIREBASE_CONFIG in auth.js.');
    const limited = _isRateLimited();
    if (limited) throw new Error(limited);
    try {
      const result = await _auth.signInWithEmailAndPassword(email, password);
      _recordAttempt(true);
      return result;
    } catch (e) {
      _recordAttempt(false);
      throw new Error(_sanitizeError(e.code));
    }
  }

  async function registerWithEmail(email, password) {
    if (!_auth) throw new Error('Firebase not configured. Please set up FIREBASE_CONFIG in auth.js.');
    const pwErr   = _validatePassword(password);
    if (pwErr) throw new Error(pwErr);
    const limited = _isRateLimited();
    if (limited) throw new Error(limited);
    try {
      const result = await _auth.createUserWithEmailAndPassword(email, password);
      _recordAttempt(true);
      return result;
    } catch (e) {
      _recordAttempt(false);
      throw new Error(_sanitizeError(e.code));
    }
  }

  function continueAsGuest() {
    _guest = true;
    _hideAuthModal();
    _renderGuestBanner(true);
    _renderHeaderUser(null);
  }

  async function signOut() {
    if (_auth && _user) {
      try { await _auth.signOut(); } catch (_) {}
    }
    _guest = true;
    _user  = null;
    _renderGuestBanner(true);
    _renderHeaderUser(null);
  }

  // ── Firestore write helpers ─────────────────────────────────

  async function saveActiveTrades(trades) {
    if (!_db || !_user) return false;
    try {
      await _db.collection('users').doc(_user.uid)
               .collection('state').doc('activeTrades')
               .set({ trades, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      return true;
    } catch (e) { console.error('[SqFlow Auth] saveActiveTrades:', e); return false; }
  }

  async function saveTradeHistory(history) {
    if (!_db || !_user) return false;
    try {
      await _db.collection('users').doc(_user.uid)
               .collection('state').doc('tradeHistory')
               .set({ history, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      return true;
    } catch (e) { console.error('[SqFlow Auth] saveTradeHistory:', e); return false; }
  }

  // ── Header user block ───────────────────────────────────────

  function _renderHeaderUser(user) {
    const wrap = document.getElementById('header-user');
    if (!wrap) return;

    if (!user) {
      wrap.style.display = 'none';
      return;
    }

    const name       = user.displayName || user.email || 'User';
    const photo      = user.photoURL;
    const initials   = name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase();
    const avatarHTML = photo
      ? `<img class="user-avatar-img" src="${photo}" alt="" referrerpolicy="no-referrer" />`
      : `<span class="user-avatar-initials">${initials}</span>`;

    wrap.innerHTML = `
      <div class="user-avatar">${avatarHTML}</div>
      <span class="user-name">${_esc(name.split(/\s+/)[0])}</span>
      <button class="user-signout-btn" id="signout-btn" title="Sign out">&#x2715;</button>
    `;
    wrap.style.display = 'flex';
    document.getElementById('signout-btn').addEventListener('click', () => {
      if (confirm('Sign out of SqFlow?')) signOut();
    });
  }

  // ── Guest banner ────────────────────────────────────────────

  function _renderGuestBanner(show) {
    const banner = document.getElementById('guest-banner');
    if (!banner) return;
    banner.style.display = show ? 'flex' : 'none';
    if (show) {
      banner.innerHTML = `
        <span class="guest-banner-icon">&#9888;</span>
        <span class="guest-banner-text">Guest mode — your data will not be saved.</span>
        ${_isFirebaseConfigured() ? '<button class="guest-banner-cta" id="guest-sign-in-btn">Sign in</button>' : ''}
      `;
      const btn = document.getElementById('guest-sign-in-btn');
      if (btn) btn.addEventListener('click', _showAuthModal);
    }
  }

  // ── Auth modal ──────────────────────────────────────────────

  function _showAuthModal() {
    if (!_modal) _buildModal();
    _modal.style.display = 'flex';
  }

  function _hideAuthModal() {
    if (_modal) _modal.style.display = 'none';
  }

  function _buildModal() {
    _modal = document.createElement('div');
    _modal.id = 'auth-overlay';
    document.body.appendChild(_modal);
    _rebuildModal();
  }

  function _rebuildModal() {
    if (!_modal) return;
    _modal.innerHTML = _modalHTML();
    _bindModalEvents();
  }

  function _modalHTML() {
    const isSignIn = _mode === 'signin';
    const pwdPlaceholder = isSignIn
      ? '••••••••'
      : 'Min 8 chars, uppercase, number, symbol';

    const providerSection = `
      <div class="auth-providers">
        <button class="auth-provider-btn auth-google" id="btn-google">
          <svg class="provider-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>
      </div>
      <div class="auth-divider"><span>or</span></div>
    `;

    return `
      <div class="auth-modal" role="dialog" aria-modal="true" aria-label="Sign in to SqFlow">
        <div class="auth-modal-logo">SqFlow</div>
        <div class="auth-modal-subtitle">Signal your edge. Own your trades.</div>

        <div id="auth-error"   class="auth-error"   style="display:none" role="alert"></div>
        <div id="auth-success" class="auth-success" style="display:none" role="status"></div>

        ${providerSection}

        <form id="auth-form" class="auth-form" novalidate>
          <div class="auth-field">
            <label class="auth-label" for="auth-email">Email</label>
            <input class="auth-input" type="email" id="auth-email"
              autocomplete="email" placeholder="you@example.com" required />
          </div>
          <div class="auth-field">
            <label class="auth-label" for="auth-password">Password</label>
            <div class="auth-password-wrap">
              <input class="auth-input" type="password" id="auth-password"
                autocomplete="${isSignIn ? 'current-password' : 'new-password'}"
                placeholder="${pwdPlaceholder}" required />
              <button type="button" class="auth-pwd-toggle" id="auth-pwd-toggle"
                aria-label="Show password" title="Show password">
                <svg class="pwd-eye-icon" id="pwd-eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                <svg class="pwd-eye-icon" id="pwd-eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="display:none">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              </button>
            </div>
          </div>
          <button type="submit" class="auth-submit-btn" id="auth-submit">
            ${isSignIn ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div class="auth-toggle">
          ${isSignIn
            ? 'Don\'t have an account? <button class="auth-toggle-btn" id="auth-mode-toggle" type="button">Create one</button>'
            : 'Already have an account? <button class="auth-toggle-btn" id="auth-mode-toggle" type="button">Sign in</button>'}
        </div>

        <div class="auth-divider"><span>or</span></div>

        <div class="auth-guest-wrap">
          <button class="auth-guest-btn" id="btn-guest" type="button">Continue as Guest</button>
        </div>
      </div>
    `;
  }

  // ── Modal event wiring ──────────────────────────────────────

  function _setError(msg) {
    const errEl = document.getElementById('auth-error');
    const okEl  = document.getElementById('auth-success');
    if (errEl) { errEl.textContent = msg; errEl.style.display = msg ? 'block' : 'none'; }
    if (okEl)  okEl.style.display = 'none';
  }

  function _setSuccess(msg) {
    const okEl  = document.getElementById('auth-success');
    const errEl = document.getElementById('auth-error');
    if (okEl)  { okEl.textContent = msg; okEl.style.display = msg ? 'block' : 'none'; }
    if (errEl) errEl.style.display = 'none';
  }

  function _setLoading(id, loading, originalHTML) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Signing in…';
    } else {
      btn.innerHTML = originalHTML || btn.dataset.origHtml || btn.textContent;
    }
  }

  function _bindModalEvents() {
    // ── Provider buttons ──
    function _providerGuard(id, fn) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        _setError('');
        const orig = btn.innerHTML;
        btn.disabled    = true;
        btn.textContent = 'Signing in…';
        try {
          await fn();
        } catch (e) {
          _setError(e.message);
          btn.disabled = false;
          btn.innerHTML = orig;
        }
      });
    }

    _providerGuard('btn-google',  signInWithGoogle);

    // ── Email form ──
    const form = document.getElementById('auth-form');
    if (form) {
      form.addEventListener('submit', async e => {
        e.preventDefault();
        _setError('');
        const email = (document.getElementById('auth-email')?.value || '').trim();
        const pwd   =  document.getElementById('auth-password')?.value || '';
        if (!email || !pwd) { _setError('Please enter your email and password.'); return; }

        _setLoading('auth-submit', true);
        try {
          if (_mode === 'signin') {
            await signInWithEmail(email, pwd);
          } else {
            await registerWithEmail(email, pwd);
            _setSuccess('Account created! Signing you in…');
          }
        } catch (e) {
          _setError(e.message);
          _setLoading('auth-submit', false);
        }
      });
    }

    // ── Mode toggle (signin ↔ register) ──
    const toggle = document.getElementById('auth-mode-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        _mode = _mode === 'signin' ? 'register' : 'signin';
        _setError('');
        _rebuildModal();
      });
    }

    // ── Password visibility toggle ──
    const pwdToggle = document.getElementById('auth-pwd-toggle');
    if (pwdToggle) {
      pwdToggle.addEventListener('click', () => {
        const pwdInput = document.getElementById('auth-password');
        const eyeOpen  = document.getElementById('pwd-eye-open');
        const eyeClosed = document.getElementById('pwd-eye-closed');
        if (!pwdInput) return;
        const show = pwdInput.type === 'password';
        pwdInput.type = show ? 'text' : 'password';
        pwdToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        pwdToggle.title = show ? 'Hide password' : 'Show password';
        if (eyeOpen)   eyeOpen.style.display  = show ? 'none' : '';
        if (eyeClosed) eyeClosed.style.display = show ? '' : 'none';
      });
    }

    // ── Guest ──
    const guestBtn = document.getElementById('btn-guest');
    if (guestBtn) guestBtn.addEventListener('click', continueAsGuest);
  }

  // ── Utility ─────────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Public API ───────────────────────────────────────────────
  return {
    init:            _init,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    continueAsGuest,
    signOut,
    isGuest:         ()   => _guest || !_user,
    getCurrentUser:  ()   => _user,
    isReady:         ()   => _ready,
    onReady:         (fn) => { if (_ready) fn({ user: _user, isGuest: _guest }); else _cbQueue.push(fn); },
    saveActiveTrades,
    saveTradeHistory,
  };
})();

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => Auth.init());
