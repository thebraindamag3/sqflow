#!/usr/bin/env node
// ============================================================
// SqFlow Server — Static file server + Yahoo Finance proxy
// Resolves CORS issues for non-crypto market data (Issue #21)
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── CORS allowlist ────────────────────────────────────────────
// Only these origins are permitted to make cross-origin API requests.
// H-02 fix: replace wildcard Access-Control-Allow-Origin with an explicit allowlist.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://thebraindamag3.github.io',
]);

// ── Security headers helper ───────────────────────────────────
// H-01 fix: apply security headers to every HTTP response.
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
      // Allow connections to Firebase, Yahoo Finance, Twelve Data, and crypto APIs
      "connect-src 'self' https://api-pub.bitfinex.com https://api.binance.com " +
        "https://query1.finance.yahoo.com https://api.allorigins.win https://corsproxy.io " +
        "https://api.twelvedata.com " +
        "https://*.firebaseio.com https://identitytoolkit.googleapis.com " +
        "https://securetoken.googleapis.com",
      "style-src 'self' 'unsafe-inline'",
      // Allow Google user profile pictures in avatars
      "img-src 'self' data: https://lh3.googleusercontent.com",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  // HSTS is only effective over HTTPS; enable when deployed behind TLS.
  // res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ── CORS headers helper ───────────────────────────────────────
// H-02 fix: only set CORS header for explicitly allowed origins.
function setCORSHeaders(req, res) {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Vary: Origin tells caches to store separate responses per origin.
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Server-side rate limiter (token bucket, no dependencies) ──
// Limits each IP to 60 requests per minute on API routes.
const _rateLimitMap = new Map();
function _isRateLimited(ip) {
  const now = Date.now();
  const entry = _rateLimitMap.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  _rateLimitMap.set(ip, entry);
  return entry.count > 60;
}
// Periodically evict expired entries to prevent unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateLimitMap) {
    if (now > entry.resetAt) _rateLimitMap.delete(ip);
  }
}, 60_000);

// ── Load .env.local (simple parser, zero dependencies) ───────
function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {
    // .env.local is optional — app runs in guest mode without it
  }
}
loadEnvFile(path.join(__dirname, '.env.local'));

// ── Firebase config from environment variables ───────────────
function getFirebaseConfig() {
  return {
    apiKey:            process.env.FIREBASE_API_KEY            || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
    projectId:         process.env.FIREBASE_PROJECT_ID         || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID             || '',
    measurementId:     process.env.FIREBASE_MEASUREMENT_ID     || '',
  };
}

// ── Symbol mapping: internal keys → Yahoo Finance tickers ────
const YAHOO_SYMBOLS = {
  // Futures — Indices
  'ES1!':  'ES=F',
  'NQ1!':  'NQ=F',
  'YM1!':  'YM=F',
  'RTY1!': 'RTY=F',
  'DAX1!': '^GDAXI',
  'NKD1!': 'NKD=F',
  // Futures — Commodities
  'GC1!':  'GC=F',
  'SI1!':  'SI=F',
  'CL1!':  'CL=F',
  'NG1!':  'NG=F',
  'HG1!':  'HG=F',
  // FX Pairs
  'GBP/USD': 'GBPUSD=X',
  'EUR/USD': 'EURUSD=X',
  'USD/JPY': 'JPY=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CHF': 'CHF=X',
};

// ── Symbol mapping: internal keys → Twelve Data symbols ──────
// Twelve Data supports 4h natively (no aggregation needed).
// FX pairs use the standard "BASE/QUOTE" format.
// Futures use their standard root symbol.
const TWELVE_DATA_SYMBOLS = {
  // Futures — Indices
  'ES1!':  'ES1!',
  'NQ1!':  'NQ1!',
  'YM1!':  'YM1!',
  'RTY1!': 'RTY1!',
  'DAX1!': 'DAX1!',
  'NKD1!': 'NKD1!',
  // Futures — Commodities
  'GC1!':  'GC1!',
  'SI1!':  'SI1!',
  'CL1!':  'CL1!',
  'NG1!':  'NG1!',
  'HG1!':  'HG1!',
  // FX Pairs
  'GBP/USD': 'GBP/USD',
  'EUR/USD': 'EUR/USD',
  'USD/JPY': 'USD/JPY',
  'AUD/USD': 'AUD/USD',
  'USD/CHF': 'USD/CHF',
};

// ── MIME types for static file serving ───────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ── Fetch helper (HTTPS GET with redirects) ──────────────────
function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const get = (targetUrl, redirectCount) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      https.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SqFlow/1.0)',
          'Accept': 'application/json',
        },
      }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirectCount + 1);
        }

        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        res.on('error', reject);
      }).on('error', reject);
    };

    get(reqUrl, 0);
  });
}

// ── Aggregate hourly candles into 4h candles ─────────────────
function aggregate4h(candles) {
  if (!candles.length) return [];
  const result = [];
  // Group into blocks of 4
  for (let i = 0; i < candles.length; i += 4) {
    const block = candles.slice(i, i + 4);
    if (block.length === 0) break;
    result.push({
      time:   block[0].time,
      open:   block[0].open,
      high:   Math.max(...block.map(c => c.high)),
      low:    Math.min(...block.map(c => c.low)),
      close:  block[block.length - 1].close,
      volume: block.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

// ── Yahoo Finance proxy handler ──────────────────────────────

// M-04 fix: validate interval and range against explicit allowlists to prevent
// URL parameter injection into the upstream Yahoo Finance request.
const VALID_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1wk', '1mo']);
const VALID_RANGES    = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

async function handleMarketData(query, res) {
  const symbol = query.symbol;
  // Fall back to safe defaults if caller supplies an unrecognised value.
  const interval = VALID_INTERVALS.has(query.interval) ? query.interval : '4h';
  const range    = VALID_RANGES.has(query.range)       ? query.range    : '3mo';

  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required parameter: symbol' }));
    return;
  }

  const yahooSymbol = YAHOO_SYMBOLS[symbol];
  if (!yahooSymbol) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unsupported symbol: ${symbol}. Available: ${Object.keys(YAHOO_SYMBOLS).join(', ')}` }));
    return;
  }

  // Yahoo Finance doesn't support 4h intervals — fetch 1h and aggregate
  const needs4hAggregation = interval === '4h';
  const yahooInterval = needs4hAggregation ? '1h' : interval;
  const yahooRange = needs4hAggregation ? '2y' : range;

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${yahooInterval}&range=${yahooRange}`;

  try {
    console.log(`[proxy] ${symbol} → ${yahooSymbol} (interval=${yahooInterval}, range=${yahooRange})`);
    const { statusCode, body } = await httpsGet(yahooUrl);

    if (statusCode !== 200) {
      console.warn(`[proxy] Yahoo returned HTTP ${statusCode} for ${yahooSymbol}`);
      res.writeHead(statusCode === 404 ? 404 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Market data temporarily unavailable for ${symbol}. Yahoo Finance returned HTTP ${statusCode}.`,
      }));
      return;
    }

    const data = JSON.parse(body);
    const result = data?.chart?.result?.[0];

    if (!result || !result.timestamp || result.timestamp.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `No data available for ${symbol}. The instrument may be delisted or not yet trading.`,
      }));
      return;
    }

    const timestamps = result.timestamp;
    const quote = result.indicators?.quote?.[0];

    if (!quote) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Malformed response from Yahoo Finance for ${symbol}.` }));
      return;
    }

    // Build normalized OHLCV array, filtering out null entries
    let candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;

      // Skip candles with null OHLC data (market closed / no trading)
      if (o == null || h == null || l == null || c == null) continue;

      candles.push({
        time:   timestamps[i] * 1000, // seconds → milliseconds
        open:   o,
        high:   h,
        low:    l,
        close:  c,
        volume: v,
      });
    }

    // Aggregate to 4h if needed
    if (needs4hAggregation) {
      candles = aggregate4h(candles);
    }

    console.log(`[proxy] ${symbol}: ${candles.length} candles returned`);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    });
    res.end(JSON.stringify(candles));

  } catch (err) {
    console.error(`[proxy] Error fetching ${symbol}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: `Failed to fetch market data for ${symbol}. Please try again later.`,
    }));
  }
}

// ── Twelve Data proxy handler ────────────────────────────────
// Proxies requests to api.twelvedata.com so the browser never exposes the API key.
// Supports the same interval/range parameters as the Yahoo proxy for drop-in use.
// Twelve Data supports 4h natively — no server-side aggregation needed.

const TD_VALID_INTERVALS = new Set(['1min', '5min', '15min', '30min', '1h', '2h', '4h', '1day', '1week', '1month']);

async function handleTwelveData(query, res) {
  const apiKey = process.env.TWELVE_DATA_API_KEY || '';
  if (!apiKey) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Twelve Data API key not configured on this server.' }));
    return;
  }

  const symbol = query.symbol;
  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required parameter: symbol' }));
    return;
  }

  const tdSymbol = TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unsupported symbol: ${symbol}. Available: ${Object.keys(TWELVE_DATA_SYMBOLS).join(', ')}` }));
    return;
  }

  // Map our internal timeframe names to Twelve Data interval strings
  const intervalMap = { '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' };
  const rawInterval = query.interval || '4h';
  const interval = intervalMap[rawInterval] || (TD_VALID_INTERVALS.has(rawInterval) ? rawInterval : '4h');

  // outputsize: max 5000; use 300 to match STRATEGY.CANDLE_LIMIT
  const outputsize = Math.min(parseInt(query.outputsize, 10) || 300, 5000);

  const tdUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${outputsize}&order=ASC&apikey=${apiKey}`;

  try {
    console.log(`[td-proxy] ${symbol} → ${tdSymbol} (interval=${interval}, outputsize=${outputsize})`);
    const { statusCode, body } = await httpsGet(tdUrl);

    if (statusCode !== 200) {
      console.warn(`[td-proxy] Twelve Data returned HTTP ${statusCode} for ${tdSymbol}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Twelve Data returned HTTP ${statusCode} for ${symbol}.` }));
      return;
    }

    const data = JSON.parse(body);

    if (data.status === 'error' || !data.values || !Array.isArray(data.values) || data.values.length === 0) {
      const msg = data.message || `No data available for ${symbol}.`;
      console.warn(`[td-proxy] Twelve Data error for ${tdSymbol}:`, msg);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    // Normalize Twelve Data response to our standard OHLCV format.
    // Twelve Data returns datetimes as "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD" strings.
    const candles = data.values
      .map(v => {
        const o = parseFloat(v.open);
        const h = parseFloat(v.high);
        const l = parseFloat(v.low);
        const c = parseFloat(v.close);
        const vol = parseFloat(v.volume) || 0;
        if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return null;
        return {
          time:   new Date(v.datetime.replace(' ', 'T') + (v.datetime.length === 10 ? 'T00:00:00Z' : 'Z')).getTime(),
          open:   o,
          high:   h,
          low:    l,
          close:  c,
          volume: vol,
        };
      })
      .filter(Boolean);

    if (candles.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No valid candles for ${symbol}. Market may be closed or symbol unsupported.` }));
      return;
    }

    console.log(`[td-proxy] ${symbol}: ${candles.length} candles returned`);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    });
    res.end(JSON.stringify(candles));

  } catch (err) {
    console.error(`[td-proxy] Error fetching ${symbol}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to fetch Twelve Data for ${symbol}. Please try again later.` }));
  }
}

// ── Static file server ───────────────────────────────────────
function serveStatic(pathname, res) {
  // Default to index.html
  if (pathname === '/') pathname = '/index.html';

  // Security: prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  // L-03 fix: use path.sep to prevent prefix confusion (e.g. /app vs /application).
  // Without the separator a directory named /appX would pass the __dirname check.
  const projectDir = __dirname + path.sep;
  if (filePath !== __dirname && !filePath.startsWith(projectDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── HTTP server ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // H-01 fix: apply security headers to every response.
  addSecurityHeaders(res);

  // L-04 fix: use WHATWG URL API instead of deprecated url.parse.
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query    = Object.fromEntries(parsed.searchParams);

  // H-02 fix: CORS headers for API routes — origin-scoped, not wildcard.
  if (pathname.startsWith('/api/')) {
    setCORSHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate-limit all API routes to 60 req/min per IP.
    const ip = req.socket.remoteAddress || 'unknown';
    if (_isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Please slow down.' }));
      return;
    }
  }

  // Route: /api/firebase-config — serves Firebase config from env vars
  if (pathname === '/api/firebase-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFirebaseConfig()));
    return;
  }

  // Route: /api/market-data (Yahoo Finance proxy)
  if (pathname === '/api/market-data' && req.method === 'GET') {
    handleMarketData(query, res);
    return;
  }

  // Route: /api/td-market-data (Twelve Data proxy)
  if (pathname === '/api/td-market-data' && req.method === 'GET') {
    handleTwelveData(query, res);
    return;
  }

  // Everything else: serve static files
  serveStatic(pathname, res);
});

server.listen(PORT, () => {
  console.log(`[sqflow] Server running at http://localhost:${PORT}`);
  console.log(`[sqflow] Market data proxy: http://localhost:${PORT}/api/market-data?symbol=ES1!&interval=1h&range=1mo`);
});
