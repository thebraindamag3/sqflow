#!/usr/bin/env node
// ============================================================
// SqFlow Server — Static file server + Yahoo Finance proxy
// Resolves CORS issues for non-crypto market data (Issue #21)
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

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
async function handleMarketData(query, res) {
  const symbol = query.symbol;
  let interval = query.interval || '4h';
  const range = query.range || '3mo';

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

// ── Static file server ───────────────────────────────────────
function serveStatic(pathname, res) {
  // Default to index.html
  if (pathname === '/') pathname = '/index.html';

  // Security: prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  // Ensure the file is within the project directory
  if (!filePath.startsWith(__dirname)) {
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
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS headers for API routes
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // Route: /api/market-data
  if (pathname === '/api/market-data' && req.method === 'GET') {
    handleMarketData(parsed.query, res);
    return;
  }

  // Everything else: serve static files
  serveStatic(pathname, res);
});

server.listen(PORT, () => {
  console.log(`[sqflow] Server running at http://localhost:${PORT}`);
  console.log(`[sqflow] Market data proxy: http://localhost:${PORT}/api/market-data?symbol=ES1!&interval=1h&range=1mo`);
});
