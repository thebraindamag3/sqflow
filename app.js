// ============================================================
// SqFlow — Jaime Merino Strategy Signal Engine
// Multi-Asset · Bitfinex / Binance / Yahoo Finance Proxy
// ============================================================

const APP_VERSION = 'v1.4.0';

// Increment SCHEMA_VERSION whenever the stored trade schema changes.
// On mismatch, open trades are auto-closed gracefully before migration.
const SCHEMA_VERSION = '2';

// ── Storage keys ─────────────────────────────────────────────
const STORAGE_KEYS = {
  ACTIVE_TRADES: 'sqFlow_activeTrades',  // v2: array of trades
  HISTORY:       'sqFlow_tradeHistory',
  SCHEMA:        'sqFlow_schemaVersion',
};

// ── Strategy constants (Jaime Merino) ────────────────────────
const STRATEGY = {
  SL_PCT:             0.07,   // stop-loss 7%
  TP_PCT:             0.21,   // take-profit 21% (1:3 R/R)
  RR1_PCT:            0.14,   // partial scale-out at 1:2 R/R
  ADX_THRESHOLD:      23,     // minimum ADX for trend confirmation
  EMA55_PROXIMITY:    0.03,   // within 3% of EMA55 = ideal bounce zone
  KEY_LEVEL_PROXIMITY:0.025,  // within 2.5% of any key level
  CANDLE_LIMIT:       300,    // candles fetched per request
  MAX_HISTORY:        200,    // max trades stored in localStorage
  CAPITAL_PCT:        0.10,   // 10% of capital per trade
};

// ── Asset registry ─────────────────────────────────────────
const ASSETS = {
  // Futures — Indices (Yahoo Finance proxy for data)
  'ES1!':  { name: 'S&P 500 E-mini',     category: 'Futures — Indices',      market: 'cme',   bitfinex: null, binance: null, tradingview: 'CME_MINI:ES1!',  yahoo: 'ES=F' },
  'NQ1!':  { name: 'Nasdaq 100 E-mini',   category: 'Futures — Indices',      market: 'cme',   bitfinex: null, binance: null, tradingview: 'CME_MINI:NQ1!',  yahoo: 'NQ=F' },
  'YM1!':  { name: 'Dow Jones E-mini',    category: 'Futures — Indices',      market: 'cme',   bitfinex: null, binance: null, tradingview: 'CBOT_MINI:YM1!', yahoo: 'YM=F' },
  'RTY1!': { name: 'Russell 2000 E-mini', category: 'Futures — Indices',      market: 'cme',   bitfinex: null, binance: null, tradingview: 'CME_MINI:RTY1!', yahoo: 'RTY=F' },
  'DAX1!': { name: 'DAX Futures',         category: 'Futures — Indices',      market: 'eurex', bitfinex: null, binance: null, tradingview: 'EUREX:FDAX1!',   yahoo: '^GDAXI' },
  'NKD1!': { name: 'Nikkei 225 Futures',  category: 'Futures — Indices',      market: 'cme',   bitfinex: null, binance: null, tradingview: 'CME:NKD1!',      yahoo: 'NKD=F' },
  // Futures — Commodities (Yahoo Finance proxy for data)
  'GC1!':  { name: 'Gold',                category: 'Futures — Commodities',  market: 'cme',   bitfinex: null, binance: null, tradingview: 'COMEX:GC1!',     yahoo: 'GC=F' },
  'SI1!':  { name: 'Silver',              category: 'Futures — Commodities',  market: 'cme',   bitfinex: null, binance: null, tradingview: 'COMEX:SI1!',     yahoo: 'SI=F' },
  'CL1!':  { name: 'Crude Oil WTI',       category: 'Futures — Commodities',  market: 'cme',   bitfinex: null, binance: null, tradingview: 'NYMEX:CL1!',     yahoo: 'CL=F' },
  'NG1!':  { name: 'Natural Gas',         category: 'Futures — Commodities',  market: 'cme',   bitfinex: null, binance: null, tradingview: 'NYMEX:NG1!',     yahoo: 'NG=F' },
  'HG1!':  { name: 'Copper',              category: 'Futures — Commodities',  market: 'cme',   bitfinex: null, binance: null, tradingview: 'COMEX:HG1!',     yahoo: 'HG=F' },
  // FX Pairs (Yahoo Finance proxy for data)
  'GBP/USD': { name: 'British Pound',     category: 'FX Pairs', market: 'forex', bitfinex: null, binance: null, tradingview: 'FX:GBPUSD', yahoo: 'GBPUSD=X' },
  'EUR/USD': { name: 'Euro',              category: 'FX Pairs', market: 'forex', bitfinex: null, binance: null, tradingview: 'FX:EURUSD', yahoo: 'EURUSD=X' },
  'USD/JPY': { name: 'Japanese Yen',      category: 'FX Pairs', market: 'forex', bitfinex: null, binance: null, tradingview: 'FX:USDJPY', yahoo: 'JPY=X' },
  'AUD/USD': { name: 'Australian Dollar', category: 'FX Pairs', market: 'forex', bitfinex: null, binance: null, tradingview: 'FX:AUDUSD', yahoo: 'AUDUSD=X' },
  'USD/CHF': { name: 'Swiss Franc',       category: 'FX Pairs', market: 'forex', bitfinex: null, binance: null, tradingview: 'FX:USDCHF', yahoo: 'CHF=X' },
  // Crypto (Bitfinex + Binance)
  'BTC/USD': { name: 'Bitcoin',   category: 'Crypto', market: 'crypto', bitfinex: 'tBTCUSD', binance: 'BTCUSDT', tradingview: null },
  'ETH/USD': { name: 'Ethereum',  category: 'Crypto', market: 'crypto', bitfinex: 'tETHUSD', binance: 'ETHUSDT', tradingview: null },
  'SOL/USD': { name: 'Solana',    category: 'Crypto', market: 'crypto', bitfinex: 'tSOLUSD', binance: 'SOLUSDT', tradingview: null },
  'XRP/USD': { name: 'XRP',       category: 'Crypto', market: 'crypto', bitfinex: 'tXRPUSD', binance: 'XRPUSDT', tradingview: null },
  'ADA/USD': { name: 'Cardano',   category: 'Crypto', market: 'crypto', bitfinex: 'tADAUSD', binance: 'ADAUSDT', tradingview: null },
  'DOT/USD': { name: 'Polkadot',  category: 'Crypto', market: 'crypto', bitfinex: 'tDOTUSD', binance: 'DOTUSDT', tradingview: null },
};

// ── Market hours ───────────────────────────────────────────
function getETTime() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  return { hour: et.getHours(), minute: et.getMinutes(), day: et.getDay() };
}

function isMarketOpen(assetKey) {
  const asset = ASSETS[assetKey || state.currentAsset];
  if (!asset) return true;
  const { market } = asset;

  if (market === 'crypto') return true;

  const { hour, minute, day } = getETTime();
  const t = hour * 60 + minute;

  if (market === 'cme') {
    // Sun–Fri 18:00–17:00 ET, daily break 17:00–18:00 ET
    if (day === 6) return false;                          // Saturday closed
    if (day === 0 && t < 18 * 60) return false;           // Sunday before 18:00
    if (day === 5 && t >= 17 * 60) return false;           // Friday after 17:00
    if (t >= 17 * 60 && t < 18 * 60) return false;        // daily break
    return true;
  }

  if (market === 'eurex') {
    // Mon–Fri 02:00–22:00 ET
    if (day === 0 || day === 6) return false;
    return t >= 2 * 60 && t < 22 * 60;
  }

  if (market === 'forex') {
    // Sun 17:00 ET → Fri 17:00 ET, continuous
    if (day === 6) return false;
    if (day === 0 && t < 17 * 60) return false;
    if (day === 5 && t >= 17 * 60) return false;
    return true;
  }

  return true;
}

// Convert an ET hour (0-23) to the user's local time string.
// Dynamically computes the current ET→UTC offset so DST is handled correctly.
function etToLocalTimeStr(etHour, etMinute = 0) {
  const now = new Date();
  // Sample current ET hour/minute via Intl to get the live ET offset from UTC
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const etH = parseInt(etParts.find(p => p.type === 'hour').value, 10) % 24;
  const etM = parseInt(etParts.find(p => p.type === 'minute').value, 10);
  const etOffsetMin = (now.getUTCHours() * 60 + now.getUTCMinutes()) - (etH * 60 + etM);
  // Build a Date at the target ET hour in UTC, then format in local time
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const targetDate = new Date(base.getTime() + (etHour * 60 + etMinute + etOffsetMin) * 60000);
  return targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getMarketScheduleLabel(assetKey) {
  const asset = ASSETS[assetKey || state.currentAsset];
  if (!asset) return '';
  const tz = USER_TZ_ABBR ? ` ${USER_TZ_ABBR}` : '';
  switch (asset.market) {
    case 'cme':
      return `CME: Sun–Fri 18:00–17:00 ET · your time: ${etToLocalTimeStr(18)}–${etToLocalTimeStr(17)}${tz} (daily break ${etToLocalTimeStr(17)}–${etToLocalTimeStr(18)}${tz})`;
    case 'eurex':
      return `Eurex: Mon–Fri 02:00–22:00 ET · your time: ${etToLocalTimeStr(2)}–${etToLocalTimeStr(22)}${tz}`;
    case 'forex':
      return `Forex: Sun 17:00 – Fri 17:00 ET · your time: ${etToLocalTimeStr(17)}${tz} Sun – ${etToLocalTimeStr(17)}${tz} Fri`;
    case 'crypto':
      return '24/7';
    default:
      return '';
  }
}

// User's local timezone abbreviation (e.g. "CET", "EST", "GMT+5")
const USER_TZ_ABBR = (() => {
  try {
    return new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch { return ''; }
})();

// Timeframe → API interval mapping (multi-asset aware)
function getApiUrls(tf, assetKey) {
  const asset = ASSETS[assetKey || state.currentAsset];
  const bfxTf = { '1h': '1h', '4h': '4h', '1d': '1D', '1w': '7D' }[tf] || '4h';
  const bnbTf = { '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' }[tf] || '4h';

  // Crypto assets: Bitfinex primary, Binance fallback
  if (asset && asset.bitfinex && asset.binance) {
    return {
      provider: 'crypto',
      bitfinex: `https://api-pub.bitfinex.com/v2/candles/trade:${bfxTf}:${asset.bitfinex}/hist?limit=${STRATEGY.CANDLE_LIMIT}&sort=1`,
      binance:  `https://api.binance.com/api/v3/klines?symbol=${asset.binance}&interval=${bnbTf}&limit=${STRATEGY.CANDLE_LIMIT}`,
    };
  }

  // Non-crypto assets (Futures, FX): server-side Yahoo Finance proxy with CORS fallback
  if (asset && asset.yahoo) {
    const needs4h = tf === '4h';
    const yahooTf = needs4h ? '1h' : ({ '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1wk' }[tf] || '4h');
    const range   = needs4h ? '2y' : ({ '1h': '1mo', '4h': '3mo', '1d': '2y', '1w': '10y' }[tf] || '3mo');
    const yahooSymbol = asset.yahoo;
    const yahooDirectUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${yahooTf}&range=${range}`;
    return {
      provider: 'yahoo',
      proxyUrl: `/api/market-data?symbol=${encodeURIComponent(assetKey || state.currentAsset)}&interval=${tf === '4h' ? '4h' : yahooTf}&range=${tf === '4h' ? '3mo' : range}`,
      directUrl: yahooDirectUrl,
      needs4h,
    };
  }

  return null;
}

// ── Application state ────────────────────────────────────────
const state = {
  currentAsset:     'BTC/USD',
  currentTimeframe: '4h',
  refreshTimer:     null,
  countdownInterval:null,
  candleCloseTime:  null,
  lastResult:       null,
  activeTrades:     [],   // array of open trade objects
  monitorInterval:  null, // single 30s interval for all open trades
  lastCandles:      null, // cache last fetched candles for current TF
};

// Per-asset candle cache — keyed by `${assetKey}|${tf}`.
// Populated by run() and the 30 s monitor so closeTrade() can look up
// the correct last price even when a different asset is currently displayed.
const candleCache = {};

// ============================================================
// MATH HELPERS
// ============================================================

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// Linear regression: returns value at last index (index = n-1)
function linReg(arr) {
  const n = arr.length;
  if (n < 2) return arr[arr.length - 1];
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += arr[i]; sxy += i * arr[i]; sx2 += i * i;
  }
  const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return slope * (n - 1) + intercept;
}

// ============================================================
// INDICATOR CALCULATIONS
// ============================================================

// Exponential Moving Average
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = [];
  let ema = closes[0];
  result.push(ema);
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// RSI — Wilder's Smoothing Method
function calcRSI(closes, period = 14) {
  const result = new Array(period).fill(null);
  let gainSum = 0, lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  if (avgLoss === 0) result.push(100);
  else result.push(100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) result.push(100);
    else result.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

// Wilder's smoothing: first smoothed value = sum of first `period` items,
// then incrementally updated. Used by ADX.
function wilderSmooth(arr, period) {
  const s = [];
  let val = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  for (let i = 0; i < period; i++) s.push(null);
  s.push(val);
  for (let i = period + 1; i < arr.length; i++) {
    val = val - val / period + arr[i];
    s.push(val);
  }
  return s;
}

// ADX — Average Directional Index (Wilder's Smoothing)
function calcADX(candles, period = 14) {
  const n = candles.length;
  const plusDM  = [0];
  const minusDM = [0];
  const trArr   = [0];

  for (let i = 1; i < n; i++) {
    const c  = candles[i];
    const cp = candles[i - 1];
    const upMove   = c.high  - cp.high;
    const downMove = cp.low  - c.low;
    plusDM.push( upMove   > downMove && upMove   > 0 ? upMove   : 0);
    minusDM.push(downMove > upMove   && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - cp.close),
      Math.abs(c.low  - cp.close)
    ));
  }

  const sTR  = wilderSmooth(trArr,  period);
  const sPDM = wilderSmooth(plusDM, period);
  const sMDM = wilderSmooth(minusDM, period);

  const dxArr  = [];
  const adxOut = [];

  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === null || sTR[i] < 0.0001) {
      adxOut.push(null);
      continue;
    }
    const pdi = 100 * sPDM[i] / sTR[i];
    const mdi = 100 * sMDM[i] / sTR[i];
    const sum = pdi + mdi;
    const dx  = sum < 0.0001 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
    dxArr.push(dx);

    if (dxArr.length < period) {
      adxOut.push(null);
    } else if (dxArr.length === period) {
      adxOut.push(mean(dxArr));
    } else {
      const prev = adxOut[adxOut.length - 1];
      adxOut.push(prev === null ? dx : (prev * (period - 1) + dx) / period);
    }
  }

  return adxOut;
}

// Bollinger Bands
function calcBB(closes, period = 20, mult = 2) {
  const result = [];
  for (let i = period - 1; i < closes.length; i++) {
    const sl  = closes.slice(i - period + 1, i + 1);
    const mid = mean(sl);
    const sd  = stdDev(sl);
    result.push({ mid, upper: mid + mult * sd, lower: mid - mult * sd, std: sd });
  }
  return result;
}

// Squeeze Momentum — LazyBear implementation
function calcSqueeze(candles, length = 20, multBB = 2.0, multKC = 1.5) {
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const result = [];

  for (let i = length - 1; i < candles.length; i++) {
    const slC = closes.slice(i - length + 1, i + 1);
    const slH = highs.slice(i - length + 1,  i + 1);
    const slL = lows.slice(i - length + 1,   i + 1);

    // Bollinger Bands
    const bbMid   = mean(slC);
    const bbStd   = stdDev(slC);
    const bbUpper = bbMid + multBB * bbStd;
    const bbLower = bbMid - multBB * bbStd;

    // True Range ATR for Keltner Channel
    let atrSum = 0;
    for (let j = i - length + 2; j <= i; j++) {
      atrSum += Math.max(
        candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j - 1].close),
        Math.abs(candles[j].low  - candles[j - 1].close)
      );
    }
    const atr = atrSum / (length - 1);

    // Keltner Channel (midline = SMA for simplicity)
    const kcUpper = bbMid + multKC * atr;
    const kcLower = bbMid - multKC * atr;

    // Squeeze: BB is inside KC  → low volatility, coiling
    const sqzOn = bbUpper < kcUpper && bbLower > kcLower;

    // Momentum delta: price vs midpoint of range + SMA
    const highest = Math.max(...slH);
    const lowest  = Math.min(...slL);
    const delta   = slC.map(c => c - ((highest + lowest) / 2 + bbMid) / 2);
    const val     = linReg(delta);

    result.push({ sqzOn, val });
  }
  return result;
}

// Volume Profile — approximate POC from last N candles
function calcVolumeProfile(candles, buckets = 80) {
  const maxP = Math.max(...candles.map(c => c.high));
  const minP = Math.min(...candles.map(c => c.low));
  if (maxP <= minP) return { poc: (maxP + minP) / 2 };

  const bSize = (maxP - minP) / buckets;
  const vol   = new Array(buckets).fill(0);

  for (const c of candles) {
    const rng = c.high - c.low;
    if (rng < 0.01) {
      const b = Math.min(buckets - 1, Math.floor((c.close - minP) / bSize));
      if (b >= 0) vol[b] += c.volume;
      continue;
    }
    const bLo = Math.max(0,          Math.floor((c.low  - minP) / bSize));
    const bHi = Math.min(buckets - 1, Math.floor((c.high - minP) / bSize));
    for (let b = bLo; b <= bHi; b++) {
      const bL     = minP + b * bSize;
      const bH     = bL + bSize;
      const ovlp   = Math.min(c.high, bH) - Math.max(c.low, bL);
      vol[b]      += c.volume * (ovlp / rng);
    }
  }

  let maxVol = 0, pocBucket = 0;
  for (let b = 0; b < buckets; b++) {
    if (vol[b] > maxVol) { maxVol = vol[b]; pocBucket = b; }
  }
  return { poc: minP + (pocBucket + 0.5) * bSize };
}

// ============================================================
// MAIN SIGNAL ANALYSIS
// ============================================================

function analyzeSignal(candles, capital) {
  const closes  = candles.map(c => c.close);
  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];

  // ── INDICATORS ──────────────────────────────────────────────
  const ema10arr  = calcEMA(closes, 10);
  const ema55arr  = calcEMA(closes, 55);
  const ema200arr = calcEMA(closes, 200);
  const rsiArr    = calcRSI(closes, 14);
  const adxArr    = calcADX(candles, 14);
  const bbArr     = calcBB(closes, 20, 2);
  const sqzArr    = calcSqueeze(candles, 20);
  const vp        = calcVolumeProfile(candles.slice(-100));

  // Latest values
  const ema10  = ema10arr[ema10arr.length - 1];
  const ema55  = ema55arr[ema55arr.length - 1];
  const ema200 = ema200arr[ema200arr.length - 1];
  const rsi    = rsiArr[rsiArr.length - 1];
  const bb     = bbArr[bbArr.length - 1];

  // Last 4 squeeze bars to detect recent fire
  const sqzRecent = sqzArr.slice(-4);
  const sqz       = sqzRecent[sqzRecent.length - 1];
  const sqzP      = sqzRecent[sqzRecent.length - 2];

  // ADX: last two valid values
  const adxValid = adxArr.filter(v => v !== null);
  const adx      = adxValid[adxValid.length - 1] ?? null;
  const adxPrev  = adxValid[adxValid.length - 2] ?? null;

  // ── TREND DIRECTION from EMA10 vs EMA55 ─────────────────────
  const emaBullish = ema10 > ema55;
  const emaBearish = ema10 < ema55;
  const direction  = emaBullish ? 'long' : 'short';

  // ── CONDITION 1: EMA Bias + Price position ──────────────────
  const priceAboveEMA55 = current > ema55;
  const priceBelowEMA55 = current < ema55;
  const c1met = direction === 'long'
    ? (emaBullish && priceAboveEMA55)
    : (emaBearish && priceBelowEMA55);
  const c1 = {
    met:    c1met,
    label:  'EMA Bias — price on right side of EMA55',
    detail: `EMA10 $${fmt(ema10)} ${emaBullish ? '>' : '<'} EMA55 $${fmt(ema55)} · Price $${fmt(current)} is ${priceAboveEMA55 ? 'ABOVE' : 'BELOW'} EMA55 → ${c1met ? '✓ Aligned' : '✗ Not aligned'} · Macro EMA200: $${fmt(ema200)}`,
  };

  // ── CONDITION 2: ADX > 23 and rising slope ──────────────────
  const adxRising = adx !== null && adxPrev !== null && adx > adxPrev;
  const adxStrong = adx !== null && adx > STRATEGY.ADX_THRESHOLD;
  const adxFlat   = adx !== null && Math.abs(adx - (adxPrev ?? adx)) < 0.3;
  const c2 = {
    met:    adxRising && adxStrong,
    label:  'ADX > 23 with rising slope (trend strengthening)',
    detail: adx !== null
      ? `ADX: ${adx.toFixed(1)} · ${adxStrong ? '✓ Strong (>23)' : '✗ Weak (<23, avoid)'} · Slope: ${adxFlat ? '→ Flat (chop — avoid)' : adxRising ? '↑ Rising ✓' : '↓ Falling (exit zone)'}`
      : 'ADX: not enough data yet',
  };

  // ── CONDITION 3: Squeeze fired + momentum in direction ───────
  const sqzJustFired   = sqzP && sqzP.sqzOn && !sqz.sqzOn;
  const sqzRecentlyFired = sqzRecent.some((s, i, arr) =>
    i > 0 && arr[i - 1].sqzOn && !s.sqzOn
  );
  const momExpanding   = sqzP ? Math.abs(sqz.val) > Math.abs(sqzP.val) : false;
  const momBullish     = sqz.val > 0;
  const momBearish     = sqz.val < 0;

  const c3met = direction === 'long'
    ? momBullish && (sqzJustFired || (sqzRecentlyFired && momExpanding))
    : momBearish && (sqzJustFired || (sqzRecentlyFired && momExpanding));

  const sqzStatus = sqz.sqzOn
    ? '🔵 Squeeze ON — coiling, wait'
    : sqzJustFired
      ? '⚡ JUST FIRED — highest conviction!'
      : sqzRecentlyFired
        ? '📈 Recently fired — still valid'
        : '📊 Expanded (no recent fire)';
  const c3 = {
    met:    c3met,
    label:  'Squeeze Momentum fired in trade direction',
    detail: `${sqzStatus} · Histogram: ${sqz.val > 0 ? '🟢' : '🔴'} ${sqz.val.toFixed(2)} · ${momExpanding ? 'Expanding ↑ (strong)' : 'Shrinking ↓ (weakening)'}`,
  };

  // ── CONDITION 4: RSI not in extreme / divergence check ───────
  const rsiOk = rsi !== null
    ? (direction === 'long' ? rsi < 70 : rsi > 30)
    : false;
  const rsiAligned = rsi !== null
    ? (direction === 'long' ? rsi > 45 : rsi < 55)
    : false;
  const rsiZone = rsi !== null
    ? (rsi > 70 ? '⛔ Overbought' : rsi < 30 ? '⛔ Oversold' : rsi > 50 ? '🟢 Above 50 (bullish)' : '🔴 Below 50 (bearish)')
    : '—';
  const c4 = {
    met:    rsiOk,
    label:  `RSI ${direction === 'long' ? '< 70 — room to move up' : '> 30 — room to move down'}`,
    detail: rsi !== null
      ? `RSI: ${rsi.toFixed(1)} · ${rsiZone} · ${rsiOk ? `✓ ${rsiAligned ? 'Confirmed' : 'Acceptable'}` : direction === 'long' ? '✗ Overbought — wait for reset' : '✗ Oversold — wait for recovery'}`
      : 'RSI: not enough data',
  };

  // ── CONDITION 5: Price bouncing from / rejecting at EMA55 ────
  const distEMA10  = Math.abs(current - ema10)  / current;
  const distEMA55  = Math.abs(current - ema55)  / current;
  const distEMA200 = Math.abs(current - ema200) / current;
  const distPOC    = Math.abs(current - vp.poc) / current;
  const distBBLow  = Math.abs(current - bb.lower) / current;
  const distBBHigh = Math.abs(current - bb.upper) / current;

  const keyLevels = [
    { label: 'EMA 10',    dist: distEMA10  },
    { label: 'EMA 55',    dist: distEMA55  },
    { label: 'EMA 200',   dist: distEMA200 },
    { label: 'Vol POC',   dist: distPOC    },
    ...(direction === 'long'  ? [{ label: 'BB Lower', dist: distBBLow  }] : []),
    ...(direction === 'short' ? [{ label: 'BB Upper', dist: distBBHigh }] : []),
  ];
  keyLevels.sort((a, b) => a.dist - b.dist);
  const nearEMA55  = distEMA55  < STRATEGY.EMA55_PROXIMITY;
  const nearAnyKey = keyLevels[0].dist < STRATEGY.KEY_LEVEL_PROXIMITY;
  const c5 = {
    met:    nearEMA55 || nearAnyKey,
    label:  'Price near key level — EMA55 bounce / rejection',
    detail: `EMA55 distance: ${(distEMA55 * 100).toFixed(2)}% ${nearEMA55 ? '✓ Ideal bounce zone' : ''} · Closest: ${keyLevels[0].label} (${(keyLevels[0].dist * 100).toFixed(2)}% away) ${nearAnyKey ? '✓' : '✗ Too far from any key level'}`,
  };

  const conditions = [c1, c2, c3, c4, c5];
  const metCount   = conditions.filter(c => c.met).length;

  // ── SIGNAL: require EMA bias (c1) + at least 2 more ─────────
  let signal = 'WAIT';
  if (c1met && metCount >= 3) {
    signal = direction === 'long' ? 'LONG' : 'SHORT';
  }

  // ── LEVERAGE: based on confluence strength ───────────────────
  let leverage = 0;
  if (c1met && metCount === 3) leverage = 3;
  else if (c1met && metCount === 4) leverage = 6;
  else if (c1met && metCount === 5) leverage = 10;

  // ── TRADE PARAMETERS ────────────────────────────────────────
  const tradeSize       = capital * STRATEGY.CAPITAL_PCT;
  const slPct           = STRATEGY.SL_PCT;
  const tpPct           = STRATEGY.TP_PCT;
  const stopLoss        = direction === 'long'
    ? current * (1 - slPct)
    : current * (1 + slPct);
  const takeProfit      = direction === 'long'
    ? current * (1 + tpPct)
    : current * (1 - tpPct);
  const maxLoss         = tradeSize * slPct;
  const estimatedProfit = tradeSize * leverage * tpPct;

  return {
    signal, direction, metCount, leverage,
    conditions,
    currentPrice: current, prevClose: prev,
    tradeSize, stopLoss, takeProfit, maxLoss, estimatedProfit, slPct, tpPct,
    ema10, ema55, ema200,
    rsi, adx, adxPrev,
    bb, sqz, sqzJustFired, poc: vp.poc,
    c1met,
  };
}

// ============================================================
// EXIT SIGNAL ANALYSIS  (Jaime Merino "patrones de salida")
// ============================================================

const EXIT_STATUS_LABELS = {
  HOLD:    '✅ HOLD — All signals positive, let the trade run',
  WATCH:   '👁 WATCH — One signal weakening, monitor closely',
  CAUTION: '⚠️ CAUTION — Multiple weakening signals, prepare to scale out',
  EXIT:    '🔴 EXIT NOW — Critical signal triggered',
};

function analyzeExitSignals(candles, trade) {
  const closes = candles.map(c => c.close);
  const current = closes[closes.length - 1];
  const isLong  = trade.direction === 'long';

  // Indicators
  const ema10arr = calcEMA(closes, 10);
  const ema55arr = calcEMA(closes, 55);
  const adxArr   = calcADX(candles, 14);
  const sqzArr   = calcSqueeze(candles, 20);

  const ema10 = ema10arr[ema10arr.length - 1];
  const ema55 = ema55arr[ema55arr.length - 1];

  const adxValid = adxArr.filter(v => v !== null);
  const adx      = adxValid[adxValid.length - 1] ?? null;
  const adxPrev  = adxValid[adxValid.length - 2] ?? null;
  const adxPrev2 = adxValid[adxValid.length - 3] ?? null;

  const sqz  = sqzArr[sqzArr.length - 1];
  const sqzP = sqzArr[sqzArr.length - 2];
  const sqzP2= sqzArr[sqzArr.length - 3];

  // ── SQUEEZE exit signals ───────────────────────────────────
  const sqzShrinking1  = sqzP  && Math.abs(sqz.val)  < Math.abs(sqzP.val);
  const sqzShrinking2  = sqzP2 && Math.abs(sqzP.val) < Math.abs(sqzP2.val);
  const sqzConsecWeak  = sqzShrinking1 && sqzShrinking2;
  const sqzFlipped     = isLong ? sqz.val < 0 : sqz.val > 0;
  const sqzPeaked      = sqzShrinking1 && sqzP2 && Math.abs(sqzP.val) > Math.abs(sqzP2.val);

  // ── ADX exit signals ────────────────────────────────────────
  const adxFalling1    = adx !== null && adxPrev !== null && adx < adxPrev;
  const adxFalling2    = adxPrev !== null && adxPrev2 !== null && adxPrev < adxPrev2;
  const adxConsecFall  = adxFalling1 && adxFalling2;
  const adxFlat        = adx !== null && adxPrev !== null && Math.abs(adx - adxPrev) < 0.5;
  const adxWeak        = adx !== null && adx < STRATEGY.ADX_THRESHOLD;

  // ── EMA exit signals ────────────────────────────────────────
  const brokeEMA10  = isLong ? current < ema10  : current > ema10;
  const brokeEMA55  = isLong ? current < ema55  : current > ema55;

  // ── STOP LOSS HIT ────────────────────────────────────────────
  const hitSL = isLong ? current <= trade.stopLoss : current >= trade.stopLoss;

  // ── P&L CALCULATION ─────────────────────────────────────────
  const priceDiff    = isLong
    ? current - trade.entryPrice
    : trade.entryPrice - current;
  const pctMove      = priceDiff / trade.entryPrice;
  const unrealizedPnL = trade.tradeSize * trade.leverage * pctMove;
  const unrealizedPct = pctMove * 100;

  // ── R:R reached? ─────────────────────────────────────────────
  const rr1hit = Math.abs(pctMove) >= STRATEGY.RR1_PCT;
  const rr2hit = Math.abs(pctMove) >= STRATEGY.TP_PCT;

  // ── BUILD EXIT STATUS ────────────────────────────────────────
  const tips = [];
  let status = 'HOLD';

  if (hitSL) {
    status = 'EXIT';
    tips.push({ level: 'exit', text: `🔴 STOP LOSS HIT at $${fmt(trade.stopLoss)} — close now to protect capital` });
  }
  if (sqzFlipped) {
    status = 'EXIT';
    tips.push({ level: 'exit', text: `🔴 Squeeze histogram flipped ${isLong ? 'bearish (red)' : 'bullish (green)'} — "la montaña cambió de color", EXIT now` });
  }
  if (brokeEMA55 && !hitSL) {
    status = 'EXIT';
    tips.push({ level: 'exit', text: `🔴 Price broke ${isLong ? 'below' : 'above'} EMA55 — major structure violation, EXIT immediately` });
  }

  if (sqzConsecWeak && status !== 'EXIT') {
    status = 'CAUTION';
    tips.push({ level: 'caution', text: `⚠️ Squeeze histogram shrinking for 2+ bars in a row — momentum peak may be in. Scale out 30–50% now, trail the rest` });
  } else if (sqzPeaked && status !== 'EXIT') {
    if (status === 'HOLD') status = 'WATCH';
    tips.push({ level: 'watch', text: `👁 Squeeze histogram just started shrinking after peak — first warning, monitor closely` });
  }

  if (adxConsecFall && status !== 'EXIT') {
    if (status === 'HOLD' || status === 'WATCH') status = 'CAUTION';
    tips.push({ level: 'caution', text: `⚠️ ADX falling for 2+ consecutive bars (now ${adx?.toFixed(1)}) — trend losing strength (Merino: "cuando el ADX muestra debilidad")` });
  } else if (adxFalling1 && adxWeak && status !== 'EXIT') {
    if (status === 'HOLD') status = 'WATCH';
    tips.push({ level: 'watch', text: `👁 ADX falling and below 23 (${adx?.toFixed(1)}) — trend weakening, move SL to breakeven` });
  } else if (adxFlat && status !== 'EXIT') {
    if (status === 'HOLD') status = 'WATCH';
    tips.push({ level: 'watch', text: `👁 ADX flat — trend in consolidation, not ideal for new runners but existing position may continue` });
  }

  if (brokeEMA10 && !brokeEMA55 && status !== 'EXIT') {
    if (status === 'HOLD') status = 'WATCH';
    tips.push({ level: 'watch', text: `👁 Price ${isLong ? 'below' : 'above'} EMA10 — dynamic support broken, consider tightening trailing stop` });
  }

  if (rr2hit && pctMove > 0) {
    tips.push({ level: 'hold', text: `💰 1:3 R/R target reached (+${unrealizedPct.toFixed(1)}%). Consider closing 50–70% of position and trailing the rest with EMA10` });
  } else if (rr1hit && pctMove > 0) {
    tips.push({ level: 'hold', text: `💰 1:2 R/R reached (+${unrealizedPct.toFixed(1)}%). Merino says: scale out 30–50%, move SL to breakeven, let the runner go` });
  }

  if (status === 'HOLD') {
    if (sqz.sqzOn) {
      tips.push({ level: 'hold', text: `🔵 New squeeze forming — market coiling again. May be a pause before next leg. Hold with current stop` });
    } else {
      tips.push({ level: 'hold', text: `✅ Squeeze histogram ${isLong ? 'green and expanding' : 'red and expanding'} — momentum is strong, let it run` });
    }
    if (!adxFalling1) {
      tips.push({ level: 'hold', text: `✅ ADX rising (${adx?.toFixed(1)}) — trend gaining strength, no exit signal yet` });
    }
    tips.push({ level: 'hold', text: `✅ Price ${isLong ? 'above' : 'below'} EMA10 ($${fmt(ema10)}) and EMA55 ($${fmt(ema55)}) — structure intact` });
    tips.push({ level: 'hold', text: `💡 Trail stop to previous swing ${isLong ? 'low' : 'high'} or use EMA10 as dynamic stop as trade develops` });
  }

  return {
    status,
    tips,
    current, unrealizedPnL, unrealizedPct,
    ema10, ema55, adx,
    sqzVal: sqz.val, sqzOn: sqz.sqzOn,
    hitSL, rr1hit, rr2hit,
  };
}

// ============================================================
// TRADE ENTRY / EXIT
// ============================================================

function enterTrade() {
  if (!state.lastResult || state.lastResult.signal === 'WAIT') return;
  if (!isMarketOpen()) return;

  const trade = {
    id:         String(Date.now()) + Math.random().toString(36).slice(2, 6),
    asset:      state.currentAsset,
    direction:  state.lastResult.direction,
    entryPrice: state.lastResult.currentPrice,
    entryTime:  Date.now(),
    leverage:   state.lastResult.leverage,
    tradeSize:  state.lastResult.tradeSize,
    stopLoss:   state.lastResult.stopLoss,
    timeframe:  state.currentTimeframe,
  };

  state.activeTrades.push(trade);
  saveTrades();
  renderTradeMonitors();
  ensureMonitorRunning();

  // Immediate initial analysis using cached candles
  if (state.lastCandles) {
    const exit = analyzeExitSignals(state.lastCandles, trade);
    updateTradeCard(trade.id, exit);
  }
}

function closeTrade(tradeId, exitPrice, reason) {
  const idx = state.activeTrades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;

  const trade = state.activeTrades[idx];

  // Use the per-asset candle cache so the exit price is always for THIS trade's
  // instrument, even when the user is currently viewing a different asset.
  const ep = exitPrice != null
    ? exitPrice
    : (() => {
        const key = `${trade.asset || 'BTC/USD'}|${trade.timeframe || state.currentTimeframe}`;
        const cached = candleCache[key];
        if (cached && cached.length > 0) return cached[cached.length - 1].close;
        // Same-asset fallback
        if (state.lastCandles && state.lastCandles.length > 0) return state.lastCandles[state.lastCandles.length - 1].close;
        return trade.entryPrice;
      })();

  saveTradeToHistory(trade, ep, reason || 'manual');
  state.activeTrades.splice(idx, 1);
  saveTrades();

  // Remove only the closed trade's card — rebuilding all cards via renderTradeMonitors()
  // would reset every remaining card to "Analyzing…" until the next 30 s monitor tick.
  const card = el(`trade-card-${tradeId}`);
  if (card) card.remove();

  // Sync the badge and empty-state (same logic as renderTradeMonitors)
  const badge = el('activetrades-tab-badge');
  if (badge) {
    badge.textContent   = state.activeTrades.length;
    badge.style.display = state.activeTrades.length ? '' : 'none';
  }
  const emptyEl = el('activetrades-empty');
  if (emptyEl) emptyEl.style.display = state.activeTrades.length === 0 ? '' : 'none';

  renderTradeHistory();
  if (state.activeTrades.length === 0) stopTradeMonitor();
}

function saveTrades() {
  localStorage.setItem(STORAGE_KEYS.ACTIVE_TRADES, JSON.stringify(state.activeTrades));
  // Cloud sync: persist to Firestore when the user is authenticated.
  if (typeof Auth !== 'undefined' && !Auth.isGuest()) {
    Auth.saveActiveTrades(state.activeTrades).catch(e => console.warn('[saveTrades cloud]', e));
  }
}

function loadTrades() {
  const storedSchema = localStorage.getItem(STORAGE_KEYS.SCHEMA);

  // ── Schema migration: v1 (single trade) → v2 (array) ───────
  if (storedSchema !== SCHEMA_VERSION) {
    const v1Raw = localStorage.getItem('sqFlow_activeTrade');
    if (v1Raw) {
      try {
        const v1Trade = JSON.parse(v1Raw);
        if (v1Trade && v1Trade.entryPrice) {
          saveTradeToHistory(
            v1Trade,
            v1Trade.entryPrice,
            'auto-closed',
            `Auto-closed: app updated to ${APP_VERSION} — schema migration`
          );
        }
      } catch (_) {}
    }
    localStorage.removeItem('sqFlow_activeTrade');
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_TRADES);
    localStorage.setItem(STORAGE_KEYS.SCHEMA, SCHEMA_VERSION);
    state.activeTrades = [];
    return;
  }

  try {
    const saved  = localStorage.getItem(STORAGE_KEYS.ACTIVE_TRADES);
    const parsed = saved ? JSON.parse(saved) : [];
    state.activeTrades = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    state.activeTrades = [];
  }
}

// ============================================================
// TRADE MONITOR UI
// ============================================================

function buildSince(entryTime) {
  const secAgo = Math.floor((Date.now() - entryTime) / 1000);
  const minAgo = Math.floor(secAgo / 60);
  const hrsAgo = Math.floor(minAgo / 60);
  return hrsAgo > 0
    ? `Entered ${hrsAgo}h ${minAgo % 60}m ago`
    : `Entered ${minAgo}m ago`;
}

function buildTradeCardHTML(trade) {
  const isShort = trade.direction === 'short';
  return `
    <div class="monitor-header">
      <div class="monitor-left">
        <span class="monitor-badge${isShort ? ' short' : ''}">${isShort ? 'SHORT ACTIVE' : 'LONG ACTIVE'}</span>
        <span class="monitor-since">${buildSince(trade.entryTime)}</span>
        <span class="monitor-tf-tag">${trade.timeframe.toUpperCase()} · ${trade.asset || 'BTC/USD'}</span>
      </div>
      <button class="close-trade-btn">✕ Close Trade</button>
    </div>
    <div class="monitor-pnl-row">
      <div class="monitor-pnl-block">
        <div class="monitor-pnl-label">Unrealized P&amp;L</div>
        <div class="monitor-pnl-value" id="pnl-${trade.id}">—</div>
        <div class="monitor-pnl-pct" id="pnl-pct-${trade.id}">—</div>
      </div>
      <div class="monitor-entry-block">
        <div class="monitor-entry-row"><span>Entry</span><strong>$${fmt(trade.entryPrice)}</strong></div>
        <div class="monitor-entry-row"><span>Current</span><strong id="cur-${trade.id}">—</strong></div>
        <div class="monitor-entry-row"><span>Stop Loss</span><strong>$${fmt(trade.stopLoss)}</strong></div>
        <div class="monitor-entry-row"><span>Leverage</span><strong>${trade.leverage}×</strong></div>
      </div>
    </div>
    <div class="exit-status-bar" id="exit-bar-${trade.id}">
      <div class="exit-status-dot"></div>
      <div class="exit-status-text">Analyzing…</div>
    </div>
    <div class="exit-tips-list" id="tips-${trade.id}"></div>
    <div class="monitor-footer">
      <span>🔄 Monitoring every 30s · Last check: <strong id="check-${trade.id}">—</strong></span>
    </div>
  `;
}

// Rebuild all trade monitor cards. Called when trades are added or removed.
function renderTradeMonitors() {
  const container = el('trades-monitor-list');
  if (!container) return;
  container.innerHTML = '';
  state.activeTrades.forEach(trade => {
    const card = document.createElement('section');
    card.className = `trade-monitor monitor-${trade.direction}`;
    card.id = `trade-card-${trade.id}`;
    card.innerHTML = buildTradeCardHTML(trade);
    card.querySelector('.close-trade-btn').addEventListener('click', () => closeTrade(trade.id));
    container.appendChild(card);
  });

  // Update Active Trades tab badge
  const badge = el('activetrades-tab-badge');
  if (badge) {
    badge.textContent   = state.activeTrades.length;
    badge.style.display = state.activeTrades.length ? '' : 'none';
  }

  // Show/hide empty state
  const emptyEl = el('activetrades-empty');
  if (emptyEl) {
    emptyEl.style.display = state.activeTrades.length === 0 ? '' : 'none';
  }
}

// Update the live data inside one trade card (no DOM rebuild).
function updateTradeCard(tradeId, exit) {
  const card = el(`trade-card-${tradeId}`);
  if (!card) return;

  const trade = state.activeTrades.find(t => t.id === tradeId);
  if (!trade) return;

  // Since time
  const sinceEl = card.querySelector('.monitor-since');
  if (sinceEl) sinceEl.textContent = buildSince(trade.entryTime);

  // Current price
  const curEl = el(`cur-${tradeId}`);
  if (curEl) curEl.textContent = '$' + fmt(exit.current);

  // P&L
  const pnlEl = el(`pnl-${tradeId}`);
  const pctEl = el(`pnl-pct-${tradeId}`);
  if (pnlEl && pctEl) {
    const isProfit = exit.unrealizedPnL >= 0;
    pnlEl.textContent = (isProfit ? '+' : '') + fmtUSD(exit.unrealizedPnL);
    pnlEl.className   = 'monitor-pnl-value ' + (isProfit ? 'profit' : 'loss');
    pctEl.textContent = (isProfit ? '+' : '') + exit.unrealizedPct.toFixed(2) + '%  (pos. move)';
    pctEl.className   = 'monitor-pnl-pct ' + (isProfit ? 'profit' : 'loss');
  }

  // Exit status bar
  const bar = el(`exit-bar-${tradeId}`);
  if (bar) {
    bar.className = `exit-status-bar status-${exit.status.toLowerCase()}`;
    bar.querySelector('.exit-status-text').textContent = EXIT_STATUS_LABELS[exit.status];
  }

  // Tips
  const tipsList = el(`tips-${tradeId}`);
  if (tipsList) {
    tipsList.innerHTML = '';
    exit.tips.forEach(t => {
      const div = document.createElement('div');
      div.className = `exit-tip tip-${t.level}`;
      div.textContent = t.text;
      tipsList.appendChild(div);
    });
  }

  // Last check
  const checkEl = el(`check-${tradeId}`);
  if (checkEl) {
    checkEl.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
}

function showEnterButton(signal) {
  const wrap = el('enter-trade-wrap');
  const btn  = el('enter-trade-btn');
  wrap.style.display = 'flex';
  btn.textContent = signal === 'LONG'
    ? '⬆ Enter LONG at Market Price'
    : '⬇ Enter SHORT at Market Price';
  btn.className = 'enter-trade-btn' + (signal === 'SHORT' ? ' short-btn' : '');
}

// ============================================================
// MONITOR INTERVAL (30 seconds)
// ============================================================

// Starts the 30s polling loop if not already running.
function ensureMonitorRunning() {
  if (state.monitorInterval || state.activeTrades.length === 0) return;
  state.monitorInterval = setInterval(async () => {
    if (state.activeTrades.length === 0) { stopTradeMonitor(); return; }

    // Group trades by timeframe+asset to minimise API calls
    const byKey = {};
    state.activeTrades.forEach(t => {
      const k = `${t.timeframe}|${t.asset || 'BTC/USD'}`;
      (byKey[k] = byKey[k] || []).push(t);
    });

    for (const [key, trades] of Object.entries(byKey)) {
      const [tf, asset] = key.split('|');
      try {
        const candles = await fetchCandles(tf, asset);
        candleCache[`${asset}|${tf}`] = candles;
        if (tf === state.currentTimeframe && asset === state.currentAsset) state.lastCandles = candles;
        trades.forEach(trade => {
          const exit = analyzeExitSignals(candles, trade);
          updateTradeCard(trade.id, exit);
          autoCloseIfNeeded(trade, exit);
        });
      } catch (e) {
        console.warn('Monitor error for TF', tf, ':', e);
      }
    }
  }, 30000);
}

function autoCloseIfNeeded(trade, exit) {
  const isLong = trade.direction === 'long';

  if (exit.hitSL) {
    showAutoCloseAlert(
      trade.id,
      '🔴 STOP LOSS HIT',
      `Price reached stop loss at $${fmt(trade.stopLoss)}.\nTrade closed automatically. Loss: ${fmtUSD(exit.unrealizedPnL)}`,
      'loss',
      exit.current
    );
    return;
  }

  const tpPrice = isLong
    ? trade.entryPrice * (1 + STRATEGY.TP_PCT)
    : trade.entryPrice * (1 - STRATEGY.TP_PCT);
  const tpHit = isLong ? exit.current >= tpPrice : exit.current <= tpPrice;

  if (tpHit) {
    showAutoCloseAlert(
      trade.id,
      '🎯 TAKE PROFIT HIT',
      `Price reached 1:3 R/R target at $${fmt(tpPrice)}.\nTrade closed automatically. Profit: ${fmtUSD(exit.unrealizedPnL)}`,
      'profit',
      exit.current
    );
  }
}

function showAutoCloseAlert(tradeId, title, message, type, exitPrice) {
  const bar = el(`exit-bar-${tradeId}`);
  if (bar) {
    bar.className = `exit-status-bar status-${type === 'loss' ? 'exit' : 'hold'}`;
    bar.querySelector('.exit-status-text').textContent = `${title} — Trade closed automatically`;
  }

  const tipsList = el(`tips-${tradeId}`);
  if (tipsList) {
    tipsList.innerHTML = '';
    const div = document.createElement('div');
    div.className = `exit-tip tip-${type === 'loss' ? 'exit' : 'hold'}`;
    div.textContent = message.replace('\n', ' ');
    tipsList.appendChild(div);
  }

  setTimeout(() => {
    closeTrade(tradeId, exitPrice, type === 'loss' ? 'sl' : 'tp');
  }, 5000);
}

function stopTradeMonitor() {
  if (state.monitorInterval) { clearInterval(state.monitorInterval); state.monitorInterval = null; }
}

// ============================================================
// TRADE HISTORY
// ============================================================

function saveTradeToHistory(trade, exitPrice, reason, notes) {
  const isLong    = trade.direction === 'long';
  const priceDiff = isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  const pctMove   = priceDiff / trade.entryPrice;
  const pnl       = trade.tradeSize * trade.leverage * pctMove;
  const exitTime  = Date.now();

  const record = {
    id:           exitTime,
    asset:        trade.asset || state.currentAsset,
    direction:    trade.direction,
    timeframe:    trade.timeframe || state.currentTimeframe,
    entryPrice:   trade.entryPrice,
    exitPrice,
    entryTime:    trade.entryTime,
    exitTime,
    entryDateISO: new Date(trade.entryTime).toISOString(),
    exitDateISO:  new Date(exitTime).toISOString(),
    leverage:     trade.leverage,
    tradeSize:    trade.tradeSize,
    pnl,
    pnlPct:       pctMove * 100,
    pnlAbs:       Math.abs(pnl),
    reason,
    notes:        notes || '',
    version:      APP_VERSION,
  };

  const history        = getTradeHistory();
  history.unshift(record);
  const trimmedHistory = history.slice(0, STRATEGY.MAX_HISTORY);
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(trimmedHistory));
  // Cloud sync: persist history to Firestore when the user is authenticated.
  if (typeof Auth !== 'undefined' && !Auth.isGuest()) {
    Auth.saveTradeHistory(trimmedHistory).catch(e => console.warn('[saveHistory cloud]', e));
  }
}

function getTradeHistory() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.HISTORY);
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

function clearTradeHistory() {
  if (!confirm('Delete all trade history? This cannot be undone.')) return;
  localStorage.removeItem(STORAGE_KEYS.HISTORY);
  // Cloud sync: clear Firestore history when the user is authenticated.
  if (typeof Auth !== 'undefined' && !Auth.isGuest()) {
    Auth.saveTradeHistory([]).catch(e => console.warn('[clearHistory cloud]', e));
  }
  renderTradeHistory();
}

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs  / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs  > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function exportTradeHistory() {
  const history = getTradeHistory();
  if (!history.length) return;
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `trades_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderTradeHistory() {
  const history = getTradeHistory();
  const list    = el('history-list');
  const countEl = el('history-count');
  const badge   = el('history-tab-badge');
  if (!list) return;

  if (badge) {
    badge.textContent    = history.length;
    badge.style.display  = history.length ? '' : 'none';
  }
  if (countEl) countEl.textContent = `${history.length} trade${history.length !== 1 ? 's' : ''}`;

  list.innerHTML = '';

  if (history.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon" aria-hidden="true">&#128200;</div>
        <div class="history-empty-title">No trades yet</div>
        <div class="history-empty-desc">When you enter and close a trade, your history will appear here with full P&amp;L tracking, duration, and export options.</div>
      </div>`;
    return;
  }

  const wins    = history.filter(t => t.pnl >= 0).length;
  const totalPnl= history.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = Math.round((wins / history.length) * 100);

  const summaryBar = document.createElement('div');
  summaryBar.className = 'history-summary';
  summaryBar.innerHTML = `
    <span class="history-summary-item">Win rate: <strong class="${totalPnl >= 0 ? 'profit' : 'loss'}">${winRate}%</strong></span>
    <span class="history-summary-sep">·</span>
    <span class="history-summary-item">Net P&amp;L: <strong class="${totalPnl >= 0 ? 'profit' : 'loss'}">${totalPnl >= 0 ? '+' : ''}${fmtUSD(totalPnl)}</strong></span>
    <span class="history-summary-sep">·</span>
    <span class="history-summary-item">${wins}W / ${history.length - wins}L</span>
  `;
  list.appendChild(summaryBar);

  history.forEach(t => {
    const isProfit    = t.pnl >= 0;
    const reasonLabel = { tp: '🎯 TP', sl: '🔴 SL', manual: '✋ Manual', 'auto-closed': '🔄 Auto-closed' }[t.reason] || t.reason;
    const duration    = formatDuration(t.exitTime - t.entryTime);

    const fmtDT = (ts) => new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const row = document.createElement('div');
    row.className = `history-row${isProfit ? ' history-win' : ' history-loss'}`;
    row.innerHTML = `
      <div class="history-row-top">
        <div class="history-dir-wrap">
          <span class="history-dir ${t.direction}">${t.direction === 'long' ? '⬆' : '⬇'} ${t.direction.toUpperCase()}</span>
          <span class="history-tf-badge">${(t.timeframe || '4h').toUpperCase()}</span>
          <span class="history-asset">${t.asset || 'BTC/USD'}</span>
        </div>
        <div class="history-pnl-wrap">
          <span class="history-pnl ${isProfit ? 'profit' : 'loss'}">${isProfit ? '+' : ''}${fmtUSD(t.pnl)}</span>
          <span class="history-pct ${isProfit ? 'profit' : 'loss'}">(${isProfit ? '+' : ''}${t.pnlPct.toFixed(2)}%)</span>
        </div>
      </div>
      <div class="history-row-prices">
        <span class="history-price-block"><span class="history-price-lbl">Entry</span> <strong>$${fmt(t.entryPrice)}</strong></span>
        <span class="history-arrow">→</span>
        <span class="history-price-block"><span class="history-price-lbl">Exit</span> <strong>$${fmt(t.exitPrice)}</strong></span>
        <span class="history-lev">${t.leverage}×</span>
        <span class="history-reason">${reasonLabel}</span>
      </div>
      <div class="history-row-times">
        <span>Open: ${fmtDT(t.entryTime)}</span>
        <span class="history-sep">·</span>
        <span>Close: ${fmtDT(t.exitTime)}</span>
        <span class="history-sep">·</span>
        <span>Duration: ${duration}</span>
      </div>
      ${t.notes ? `<div class="history-notes">📝 ${t.notes}</div>` : ''}
    `;
    list.appendChild(row);
  });
}

// ============================================================
// FETCH CANDLES — Bitfinex/Binance for Crypto, Yahoo Finance Proxy for Futures/FX
// ============================================================

async function fetchCandles(tf, assetKey) {
  const key  = assetKey || state.currentAsset;
  const urls = getApiUrls(tf || state.currentTimeframe, key);

  if (!urls) {
    throw new Error(`No data provider configured for ${key}.`);
  }

  // Yahoo Finance proxy provider (Futures, FX, Stocks)
  if (urls.provider === 'yahoo') {
    return await fetchYahooCandles(urls, key);
  }

  // Crypto provider: Bitfinex primary, Binance fallback
  try {
    const res = await fetch(urls.bitfinex);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 50) throw new Error('Insufficient data');
    // Bitfinex format: [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    return raw.map(c => ({
      time:   c[0],
      open:   c[1],
      close:  c[2],
      high:   c[3],
      low:    c[4],
      volume: c[5],
    }));
  } catch (err) {
    console.warn('Bitfinex failed, trying Binance fallback:', err.message);
  }

  const res = await fetch(urls.binance);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length < 50) throw new Error('Insufficient data from Binance');
  // Binance format: [openTime, open, high, low, close, volume, ...]
  return raw.map(c => ({
    time:   c[0],
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// Aggregate hourly candles into 4h candles (client-side, mirrors server.js logic)
function aggregate4hClient(candles) {
  if (!candles.length) return [];
  const result = [];
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

// Parse raw Yahoo Finance chart JSON into normalized OHLCV candles
function parseYahooChartResponse(body, key) {
  const data = (typeof body === 'string') ? JSON.parse(body) : body;
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp || result.timestamp.length === 0) {
    throw new Error(`Market data unavailable for ${key}. Please try again later.`);
  }
  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!quote) {
    throw new Error(`Market data unavailable for ${key}. Please try again later.`);
  }
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: timestamps[i] * 1000, open: o, high: h, low: l, close: c, volume: v });
  }
  return candles;
}

// Check if a response body looks like HTML (indicating a proxy/CDN error page)
function looksLikeHtml(text) {
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// L-02 fix: HTML-encode a string before inserting it into innerHTML.
// This prevents XSS even if the string originates from an untrusted source
// (e.g. a manipulated CORS proxy response that injects HTML into the error message).
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchYahooCandles(urls, key) {
  const errors = [];

  // Strategy 1: Try local server proxy (works when running via `node server.js`)
  try {
    const res = await fetch(urls.proxyUrl);
    const text = await res.text();
    if (looksLikeHtml(text)) {
      throw new Error('Local proxy not available (received HTML response)');
    }
    if (!res.ok) {
      throw new Error(`Local proxy HTTP ${res.status}`);
    }
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length >= 50) return data;
    if (Array.isArray(data) && data.length > 0) {
      throw new Error(`Insufficient data from local proxy (${data.length} candles)`);
    }
    throw new Error('Empty response from local proxy');
  } catch (err) {
    console.warn(`[fetchYahoo] Local proxy failed for ${key}:`, err.message);
    errors.push(err.message);
  }

  // Strategy 2: Direct Yahoo Finance via CORS proxies (works on GitHub Pages).
  // Proxies are raced in parallel so the fastest response wins, avoiding the
  // latency cost of sequential retries.
  // M-01 SECURITY NOTE: These are free, unverified public CORS proxies. They can
  // observe all market data queries (symbols, timeframes) and could theoretically
  // serve manipulated candle data. They are used here as a fallback when the local
  // Node.js server is not available (e.g. static GitHub Pages deployments).
  // For production or financial-accuracy-critical deployments, host the Node.js
  // server instead (e.g. Railway, Render, Fly.io) and never reach this fallback.
  const corsProxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  ];

  const PROXY_TIMEOUT_MS = 10000;

  const proxyAttempts = corsProxies.map(makeProxy => new Promise((resolve, reject) => {
    const proxiedUrl = makeProxy(urls.directUrl);
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    fetch(proxiedUrl, { signal: controller.signal })
      .then(res => {
        clearTimeout(tid);
        if (!res.ok) throw new Error(`CORS proxy HTTP ${res.status}`);
        return res.text();
      })
      .then(text => {
        if (looksLikeHtml(text)) throw new Error('CORS proxy returned HTML');
        let candles = parseYahooChartResponse(text, key);
        if (urls.needs4h) candles = aggregate4hClient(candles);
        if (candles.length < 50) throw new Error(`Insufficient data (${candles.length} candles)`);
        resolve(candles);
      })
      .catch(err => {
        clearTimeout(tid);
        console.warn(`[fetchYahoo] CORS proxy failed for ${key}:`, err.message);
        errors.push(err.message);
        reject(err);
      });
  }));

  try {
    return await Promise.any(proxyAttempts);
  } catch {
    // All proxies failed — errors already logged above
  }

  throw new Error(`Market data unavailable for ${key}. Please try again later.`);
}

// ============================================================
// UI HELPERS
// ============================================================

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000)  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (n >= 10)    return n.toFixed(2);
  if (n >= 1)     return n.toFixed(4);    // forex pairs like EUR/USD ≈ 1.08
  return n.toFixed(6);                     // sub-dollar assets
}

function fmtUSD(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function el(id) { return document.getElementById(id); }

// Show or hide the dashboard sections that are only meaningful when the market is open.
// Sections: Trade Parameters (capital + params), Entry Conditions, Live Indicators,
//           Next-candle countdown.  The Refresh button always stays visible.
function setMarketSectionsVisible(visible) {
  const d = visible ? '' : 'none';
  const tradeSection      = document.querySelector('.trade-section');
  const conditionsSection = document.querySelector('.conditions-section');
  const indicatorsSection = document.querySelector('.indicators-section');
  const nextCandleSpan    = el('next-candle') ? el('next-candle').parentElement : null;
  const countdownBarWrap  = document.querySelector('.countdown-bar-wrap');
  if (tradeSection)      tradeSection.style.display      = d;
  if (conditionsSection) conditionsSection.style.display = d;
  if (indicatorsSection) indicatorsSection.style.display = d;
  if (nextCandleSpan)    nextCandleSpan.style.display    = d;
  if (countdownBarWrap)  countdownBarWrap.style.display  = d;
}

function setSignalCard(signal) {
  const card = el('signal-card');

  // Restore signal card DOM if it was replaced by error state
  if (!el('signal-badge')) {
    card.innerHTML = `
      <div class="signal-top">
        <div class="signal-badge-wrap">
          <div class="signal-badge" id="signal-badge" role="status" aria-live="polite">
            <span id="signal-text">LOADING</span>
          </div>
          <div class="signal-direction" id="signal-direction"></div>
        </div>
        <div class="signal-strength-block">
          <div class="strength-label" id="confluence-label">Confluence</div>
          <div class="strength-dots" id="strength-dots" role="meter" aria-label="Confluence strength" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0">
            <span class="dot" id="dot-1" aria-hidden="true"></span>
            <span class="dot" id="dot-2" aria-hidden="true"></span>
            <span class="dot" id="dot-3" aria-hidden="true"></span>
            <span class="dot" id="dot-4" aria-hidden="true"></span>
            <span class="dot" id="dot-5" aria-hidden="true"></span>
          </div>
          <div class="strength-text" id="strength-text">0 / 5 conditions met</div>
        </div>
      </div>
      <div class="signal-subtitle" id="signal-subtitle" role="status" aria-live="polite">Connecting to market data…</div>
      <div class="enter-trade-wrap" id="enter-trade-wrap" style="display:none">
        <button class="enter-trade-btn" id="enter-trade-btn" aria-label="Enter trade at market price">Enter Trade at Market Price</button>
        <div class="enter-trade-note">Records your entry and starts 30s exit monitoring</div>
      </div>
    `;
    el('enter-trade-btn').addEventListener('click', enterTrade);
  }

  const badge = el('signal-badge');
  const text  = el('signal-text');
  card.className  = 'signal-card';
  badge.className = 'signal-badge';

  if (signal === 'LONG')  { card.classList.add('state-long');  badge.classList.add('long');  text.textContent = '⬆ LONG';  }
  if (signal === 'SHORT') { card.classList.add('state-short'); badge.classList.add('short'); text.textContent = '⬇ SHORT'; }
  if (signal === 'WAIT')  { card.classList.add('state-wait');  badge.classList.add('wait');  text.textContent = '⏸ WAIT';  }
}

function setDots(count, direction) {
  for (let i = 1; i <= 5; i++) {
    const d = el(`dot-${i}`);
    d.className = 'dot';
    if (i <= count) {
      d.classList.add(direction === 'long' ? 'active-long' : 'active-short');
    }
  }
  const dotsEl = el('strength-dots');
  if (dotsEl) dotsEl.setAttribute('aria-valuenow', count);
}

function renderConditions(conditions, direction) {
  const list = el('conditions-list');
  list.innerHTML = '';
  conditions.forEach(c => {
    const row  = document.createElement('div');
    const icon = c.met ? (direction === 'long' ? '✅' : '🔵') : '❌';
    row.className = `condition-row${c.met ? (direction === 'long' ? ' met' : ' met-short') : ''}`;
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <div class="condition-icon" aria-hidden="true">${icon}</div>
      <div class="condition-body">
        <div class="condition-label">${c.met ? 'Met: ' : 'Not met: '}${c.label}</div>
        <div class="condition-detail">${c.detail}</div>
      </div>`;
    list.appendChild(row);
  });
}

function renderIndicators(r) {
  const ema10Dir = r.ema10 > r.ema55  ? 'up' : 'down';
  const ema55Dir = r.ema55 > r.ema200 ? 'up' : 'down';
  const rsiDir   = r.rsi   > 50       ? 'up' : 'down';
  const adxDir   = r.adx !== null && r.adxPrev !== null && r.adx > r.adxPrev ? 'up' : 'down';
  const sqzDir   = r.sqz.val > 0 ? 'up' : 'down';

  const set = (id, val, cls) => {
    const e = el(id);
    if (!e) return;
    e.textContent = val;
    e.className   = `ind-value${cls ? ' ' + cls : ''}`;
  };

  set('ind-ema10',   '$' + fmt(r.ema10),   ema10Dir);
  set('ind-ema55',   '$' + fmt(r.ema55),   ema55Dir);
  set('ind-ema200',  '$' + fmt(r.ema200),  '');
  set('ind-rsi',     r.rsi !== null ? r.rsi.toFixed(1) : '—', rsiDir);
  set('ind-adx',     r.adx !== null ? r.adx.toFixed(1) : '—', adxDir);
  set('ind-bb-upper','$' + fmt(r.bb.upper), 'down');
  set('ind-bb-lower','$' + fmt(r.bb.lower), 'up');
  set('ind-squeeze', (r.sqz.val > 0 ? '+' : '') + r.sqz.val.toFixed(2) + (r.sqz.sqzOn ? ' 🔵' : ' ⚡'), sqzDir);
  set('ind-poc',     '$' + fmt(r.poc),      '');
}

function buildSignalSubtitle(r) {
  if (r.signal === 'WAIT') {
    if (!r.c1met) return `EMA bias not confirmed — EMA10 and price must align with EMA55 before entering. Stay out.`;
    if (r.metCount < 3) return `${r.metCount}/5 conditions met — need at least 3 for valid entry. Squeeze ${r.sqz.sqzOn ? 'is still coiling 🔵 — wait for the fire.' : 'has not confirmed direction yet.'}`;
    return `${r.metCount}/5 conditions met. Waiting for full confluence.`;
  }
  return `${r.metCount}/5 conditions aligned. ${r.leverage}x leverage. SL $${fmt(r.stopLoss)} · TP $${fmt(r.takeProfit)} (1:3 R/R). ${r.sqzJustFired ? '⚡ Squeeze just fired — highest conviction entry!' : ''}`;
}

function updateUI(r, capital) {
  // Asset label
  const labelEl = el('asset-label');
  if (labelEl) labelEl.textContent = state.currentAsset;

  // Market status
  const marketOpen = isMarketOpen();
  const statusEl   = el('market-status');
  if (statusEl) {
    if (marketOpen) {
      statusEl.textContent = 'Open';
      statusEl.className   = 'market-status open';
    } else {
      statusEl.textContent = 'Market Closed';
      statusEl.className   = 'market-status closed';
    }
  }

  // Price
  const priceEl = el('asset-price');
  priceEl.textContent = '$' + fmt(r.currentPrice);

  const changeEl  = el('asset-change');
  const changePct = ((r.currentPrice - r.prevClose) / r.prevClose) * 100;
  changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
  changeEl.className   = 'asset-change ' + (changePct >= 0 ? 'up' : 'down');

  // Signal
  setSignalCard(r.signal);
  el('signal-direction').textContent = r.signal !== 'WAIT'
    ? `${r.direction.toUpperCase()} · ${r.metCount}/5 conditions`
    : '';
  el('signal-subtitle').textContent  = buildSignalSubtitle(r);
  el('strength-text').textContent    = `${r.metCount} / 5 conditions met`;
  el('conditions-badge').textContent = `${r.metCount} / 5`;
  setDots(r.metCount, r.direction);

  // Trade params
  const showTrade = r.signal !== 'WAIT';
  el('param-trade-size').textContent = showTrade ? fmtUSD(r.tradeSize) : '—';
  el('param-leverage').textContent   = showTrade ? `${r.leverage}×`   : '—';
  el('param-entry').textContent      = showTrade ? '$' + fmt(r.currentPrice) : '—';
  el('param-stoploss').textContent   = showTrade ? '$' + fmt(r.stopLoss)         : '—';
  el('param-maxloss').textContent    = showTrade ? fmtUSD(r.maxLoss)             : '—';

  const tpPrice = (r.takeProfit && !isNaN(r.takeProfit)) ? r.takeProfit : null;
  el('param-tp').textContent     = (showTrade && tpPrice) ? '$' + fmt(tpPrice) : '—';
  el('param-tp-pct').textContent = (showTrade && tpPrice)
    ? `${(r.tpPct * 100).toFixed(0)}% move from entry (2:1 R/R)`
    : '';

  const estProfit = (r.estimatedProfit && !isNaN(r.estimatedProfit)) ? r.estimatedProfit : null;
  el('param-profit').textContent        = (showTrade && estProfit) ? fmtUSD(estProfit) : '—';
  el('param-profit-detail').textContent = (showTrade && estProfit)
    ? `$${fmt(r.tradeSize)} × ${r.leverage}x lev × ${(r.tpPct * 100).toFixed(0)}%`
    : '';

  renderConditions(r.conditions, r.direction);
  renderIndicators(r);

  // Enter Trade button — visible when signal is active AND market is open
  if (r.signal !== 'WAIT' && marketOpen) {
    showEnterButton(r.signal);
  } else {
    el('enter-trade-wrap').style.display = 'none';
  }

  // Refresh monitors only for trades on the current timeframe AND current asset.
  // Filtering by asset prevents cross-asset price contamination: trade cards for
  // other assets must not be updated with candles fetched for a different symbol.
  if (state.activeTrades.length > 0 && state.lastCandles) {
    state.activeTrades
      .filter(t => t.timeframe === state.currentTimeframe && t.asset === state.currentAsset)
      .forEach(trade => {
        const exit = analyzeExitSignals(state.lastCandles, trade);
        updateTradeCard(trade.id, exit);
      });
  }

  el('last-update').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    + (USER_TZ_ABBR ? '\u00a0' + USER_TZ_ABBR : '');
}

// ============================================================
// REFRESH TIMING — align with candle closes
// ============================================================

function msUntilNextCandle() {
  const now  = new Date();
  const next = new Date(now);

  if (state.currentTimeframe === '1h') {
    next.setUTCHours(now.getUTCHours() + 1, 0, 15, 0);
  } else if (state.currentTimeframe === '4h') {
    const h     = now.getUTCHours();
    const nextH = (Math.floor(h / 4) + 1) * 4;
    next.setUTCHours(nextH % 24, 0, 15, 0);
    if (nextH >= 24) next.setUTCDate(next.getUTCDate() + 1);
    if (next <= now) next.setUTCHours(next.getUTCHours() + 4);
  } else if (state.currentTimeframe === '1d') {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 15, 0);
  } else { // 1w
    const day = now.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMonday);
    next.setUTCHours(0, 0, 15, 0);
  }

  if (next <= now) {
    const periodMs = { '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 };
    const ms = periodMs[state.currentTimeframe] || 14400000;
    return { ms, date: new Date(now.getTime() + ms) };
  }
  return { ms: next - now, date: next };
}

function fmtCountdown(remainingMs) {
  const totalSec = Math.floor(remainingMs / 1000);
  const sec  = totalSec % 60;
  const min  = Math.floor(totalSec / 60) % 60;
  const hrs  = Math.floor(totalSec / 3600) % 24;
  const days = Math.floor(totalSec / 86400);
  if (state.currentTimeframe === '1w') return `${days}d ${hrs}h`;
  if (state.currentTimeframe === '1d') return `${hrs}h ${min}m`;
  if (state.currentTimeframe === '4h') return `${Math.floor(totalSec / 3600)}h ${min}m`;
  return `${Math.floor(totalSec / 60)}m ${sec}s`;
}

function startCountdown() {
  clearInterval(state.countdownInterval);
  const bar    = el('countdown-bar');
  const nextEl = el('next-candle');
  const { ms: totalMs, date: closeDate } = msUntilNextCandle();
  state.candleCloseTime = closeDate;

  state.countdownInterval = setInterval(() => {
    const remaining = state.candleCloseTime - Date.now();
    if (remaining <= 0) {
      clearInterval(state.countdownInterval);
      bar.style.width = '0%';
      return;
    }
    const pct = (remaining / totalMs) * 100;
    bar.style.width = pct + '%';
    nextEl.textContent = fmtCountdown(remaining);
  }, 1000);
}

function scheduleNextRefresh() {
  clearTimeout(state.refreshTimer);
  const { ms } = msUntilNextCandle();
  state.refreshTimer = setTimeout(() => run(), ms);
}

// ============================================================
// TIMEFRAME SELECTOR
// ============================================================

function switchTimeframe(tf) {
  // Timeframe switching is always allowed — each open trade monitors its own TF independently
  state.currentTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(b => {
    const isActive = b.dataset.tf === tf;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive);
  });
  clearTimeout(state.refreshTimer);
  clearInterval(state.countdownInterval);
  run();
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tab) {
  document.querySelectorAll('.tab-nav-btn').forEach(b => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive);
  });
  el('panel-dashboard').style.display    = tab === 'dashboard'    ? '' : 'none';
  el('panel-activetrades').style.display = tab === 'activetrades' ? '' : 'none';
  el('panel-history').style.display      = tab === 'history'      ? '' : 'none';

  // Hide asset selector on non-dashboard tabs — prevents confusing pair-switch
  // flicker in Active Trades and History where the selected pair is irrelevant.
  const assetWrap = document.querySelector('.asset-selector-wrap');
  if (assetWrap) assetWrap.style.display = tab === 'dashboard' ? '' : 'none';

  // Hide the global price block (top-right price + change%) on non-dashboard tabs.
  // It shows the selected pair's price which is meaningless on Active Trades / History.
  const priceBlock = document.querySelector('.asset-price-block');
  if (priceBlock) priceBlock.style.display = tab === 'dashboard' ? '' : 'none';
}

// ============================================================
// MAIN RUN
// ============================================================

async function run() {
  const btn     = el('refresh-btn');
  const capital = parseFloat(el('capital-input').value) || 5000;

  btn.disabled = true;
  btn.textContent = '↻ Loading…';

  // Update market status badge
  const marketOpen = isMarketOpen();
  const statusEl   = el('market-status');
  if (statusEl) {
    if (marketOpen) {
      statusEl.textContent = 'Open';
      statusEl.className   = 'market-status open';
    } else {
      statusEl.textContent = 'Market Closed';
      statusEl.className   = 'market-status closed';
    }
  }

  // Update asset label
  const labelEl = el('asset-label');
  if (labelEl) labelEl.textContent = state.currentAsset;

  // If market is closed, skip the fetch entirely and show a clear closed state.
  if (!marketOpen) {
    const schedule = getMarketScheduleLabel(state.currentAsset);
    const signalCard = el('signal-card');
    if (signalCard) {
      signalCard.className = 'signal-card state-wait';
      signalCard.innerHTML = `
        <div class="market-closed-state" role="status" aria-live="polite">
          <div class="market-closed-icon" aria-hidden="true">🔴</div>
          <div class="market-closed-title">Market Closed</div>
          <div class="market-closed-schedule">${escHtml(schedule)}</div>
        </div>
      `;
    }
    const priceEl = el('asset-price');
    if (priceEl) priceEl.textContent = '—';
    const changeEl = el('asset-change');
    if (changeEl) changeEl.textContent = '';
    // Hide sections that only make sense when the market is open
    setMarketSectionsVisible(false);
    btn.disabled    = false;
    btn.textContent = '↻ Refresh Now';
    return;
  }

  try {
    const candles = await fetchCandles();
    state.lastCandles = candles;
    candleCache[`${state.currentAsset}|${state.currentTimeframe}`] = candles;
    // Ensure market-sensitive sections are visible now that we have live data
    setMarketSectionsVisible(true);
    state.lastResult    = analyzeSignal(candles, capital);
    updateUI(state.lastResult, capital);
    startCountdown();
    scheduleNextRefresh();
  } catch (err) {
    console.error('Error fetching data:', err);
    el('signal-text').textContent = 'ERROR';
    // Sanitize error message — never display raw HTML to the user
    const safeMsg = (err.message && !looksLikeHtml(err.message))
      ? err.message
      : `Market data unavailable for ${state.currentAsset}. Please try again later.`;

    // Render error state with retry button (Priority 4)
    const signalCard = el('signal-card');
    if (signalCard) {
      signalCard.className = 'signal-card';
      signalCard.innerHTML = `
        <div class="error-state" role="alert">
          <div class="error-state-icon" aria-hidden="true">&#9888;</div>
          <div class="error-state-title">Unable to Load Market Data</div>
          <div class="error-state-message">${escHtml(safeMsg)}</div>
          <details class="error-state-details">
            <summary>Technical details</summary>
            <pre>${escHtml(safeMsg)}</pre>
          </details>
          <button class="error-state-retry" id="error-retry-btn" aria-label="Retry loading market data">Retry</button>
        </div>
      `;
      const retryBtn = el('error-retry-btn');
      if (retryBtn) retryBtn.addEventListener('click', manualRefresh);
    }

    // Still update price display for context
    const priceEl = el('asset-price');
    if (priceEl) priceEl.textContent = '—';
    el('enter-trade-wrap')?.style && (el('enter-trade-wrap').style.display = 'none');
  } finally {
    btn.disabled    = false;
    btn.textContent = '↻ Refresh Now';
  }
}

function manualRefresh() {
  clearTimeout(state.refreshTimer);
  run();
}

function recalcTradeParams(capital) {
  const r             = state.lastResult;
  const tradeSize     = capital * STRATEGY.CAPITAL_PCT;
  const maxLoss       = tradeSize * r.slPct;
  const estProfit     = tradeSize * r.leverage * r.tpPct;
  return { tradeSize, maxLoss, estProfit };
}

function onCapitalChange() {
  if (!state.lastResult) return;
  const capital = parseFloat(el('capital-input').value) || 5000;
  const { tradeSize, maxLoss, estProfit } = recalcTradeParams(capital);
  state.lastResult.tradeSize       = tradeSize;
  state.lastResult.maxLoss         = maxLoss;
  state.lastResult.estimatedProfit = estProfit;
  const show = state.lastResult.signal !== 'WAIT';
  el('param-trade-size').textContent    = show ? fmtUSD(tradeSize) : '—';
  el('param-maxloss').textContent       = show ? fmtUSD(maxLoss)   : '—';
  el('param-profit').textContent        = show ? fmtUSD(estProfit)  : '—';
  el('param-profit-detail').textContent = show
    ? `$${fmt(tradeSize)} × ${state.lastResult.leverage}x × ${(state.lastResult.tpPct * 100).toFixed(0)}%`
    : '';
}

// ============================================================
// ASSET SELECTOR
// ============================================================

function buildAssetSelector() {
  const container = el('asset-selector-dropdown');
  if (!container) return;

  // Group assets by category
  const groups = {};
  for (const [key, asset] of Object.entries(ASSETS)) {
    if (!groups[asset.category]) groups[asset.category] = [];
    groups[asset.category].push({ key, ...asset });
  }

  container.innerHTML = '';
  for (const [category, assets] of Object.entries(groups)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'asset-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'asset-group-label';
    labelEl.textContent = category;
    groupEl.appendChild(labelEl);

    assets.forEach(a => {
      const item = document.createElement('button');
      item.className = 'asset-item' + (a.key === state.currentAsset ? ' selected' : '');
      if (!a.bitfinex && !a.binance && !a.tradingview) item.classList.add('no-data');

      const open = isMarketOpen(a.key);
      const dot  = a.market === 'crypto' ? '🟢' : (open ? '🟢' : '🔴');

      item.innerHTML = `
        <span class="asset-item-symbol">${a.key}</span>
        <span class="asset-item-name">${a.name}</span>
        <span class="asset-item-status">${dot}</span>
      `;
      item.addEventListener('click', () => {
        switchAsset(a.key);
        toggleAssetSelector(false);
      });
      groupEl.appendChild(item);
    });

    container.appendChild(groupEl);
  }
}

function toggleAssetSelector(forceState) {
  const dropdown = el('asset-selector-dropdown');
  if (!dropdown) return;
  const isOpen = forceState !== undefined ? forceState : !dropdown.classList.contains('open');
  dropdown.classList.toggle('open', isOpen);

  if (isOpen) {
    buildAssetSelector(); // refresh market status dots
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', closeAssetSelectorOnOutside, { once: true });
    }, 0);
  }
}

function closeAssetSelectorOnOutside(e) {
  const dropdown = el('asset-selector-dropdown');
  const trigger  = el('asset-selector-trigger');
  if (dropdown && !dropdown.contains(e.target) && trigger && !trigger.contains(e.target)) {
    dropdown.classList.remove('open');
  } else if (dropdown && dropdown.classList.contains('open')) {
    // Re-attach if click was inside
    setTimeout(() => {
      document.addEventListener('click', closeAssetSelectorOnOutside, { once: true });
    }, 0);
  }
}

function switchAsset(key) {
  if (!ASSETS[key]) return;
  state.currentAsset = key;
  state.lastCandles  = null;
  state.lastResult   = null;

  // Update UI elements
  const labelEl = el('asset-label');
  if (labelEl) labelEl.textContent = key;

  // Update selected state in dropdown
  document.querySelectorAll('.asset-item').forEach(item => {
    item.classList.toggle('selected', item.querySelector('.asset-item-symbol').textContent === key);
  });

  // Reset and re-run
  clearTimeout(state.refreshTimer);
  clearInterval(state.countdownInterval);
  run();
}

// ============================================================
// BOOT
// ============================================================

function initFooter() {
  const footerMeta = el('footer-meta');
  if (!footerMeta) return;
  footerMeta.innerHTML = `<span class="footer-version">${APP_VERSION}</span>`;
  fetch('version.json?_=' + Date.now())
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(v => {
      if (!v.buildDate) return;
      const d       = new Date(v.buildDate);
      const dateStr = d.toLocaleDateString('en-CA');
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const tz      = USER_TZ_ABBR ? '\u00a0' + USER_TZ_ABBR : '';
      const hash    = v.buildHash && v.buildHash !== 'unknown'
        ? `\u00a0<span class="footer-hash">(${v.buildHash})</span>`
        : '';
      footerMeta.innerHTML =
        `<span class="footer-version">v${v.version}</span>` +
        hash +
        `<span class="footer-sep">\u00a0·\u00a0</span>` +
        `<span>Last deploy:\u00a0${dateStr}\u00a0${timeStr}${tz}</span>`;
    })
    .catch(() => {
      footerMeta.innerHTML = `<span class="footer-version">${APP_VERSION}</span>`;
    });
}

function bindEvents() {
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.addEventListener('click', () => switchTimeframe(b.dataset.tf));
  });
  document.querySelectorAll('.tab-nav-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  el('enter-trade-btn').addEventListener('click', enterTrade);
  // Note: close-trade-btn listeners are bound per-card in renderTradeMonitors()
  el('refresh-btn').addEventListener('click', manualRefresh);
  el('export-history-btn').addEventListener('click', exportTradeHistory);
  el('clear-history-btn').addEventListener('click', clearTradeHistory);
  el('capital-input').addEventListener('change', onCapitalChange);

  // Asset selector
  const trigger = el('asset-selector-trigger');
  if (trigger) trigger.addEventListener('click', () => toggleAssetSelector());
}

function init() {
  bindEvents();
  initFooter();
  buildAssetSelector();
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === state.currentTimeframe);
  });
  loadTrades();
  renderTradeMonitors();
  if (state.activeTrades.length > 0) {
    ensureMonitorRunning();
  }
  renderTradeHistory();
  run();
}

init();
