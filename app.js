// ============================================================
// myCFO — Jaime Merino Strategy Signal Engine
// BTC/USD · Bitfinex
// ============================================================

const APP_VERSION    = 'v1.2.0';
const DEPLOY_DATE    = '2026-03-13';
const DEPLOY_TIME    = '08:51 UTC';

// Timeframe → API interval mapping
function getApiUrls(tf) {
  const bfxTf = { '1h': '1h', '4h': '4h', '1d': '1D', '1w': '7D' }[tf] || '4h';
  const bnbTf = { '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' }[tf] || '4h';
  return {
    bitfinex: `https://api-pub.bitfinex.com/v2/candles/trade:${bfxTf}:tBTCUSD/hist?limit=300&sort=1`,
    binance:  `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${bnbTf}&limit=300`,
  };
}

let currentTimeframe = '1h';

let refreshTimer = null;
let countdownInterval = null;
let candleCloseTime = null;
let lastResult = null;
let activeTrade = null;       // { direction, entryPrice, entryTime, leverage, tradeSize, stopLoss, timeframe }
let monitorInterval = null;   // 30s interval when trade is open
let lastCandles = null;       // cache last fetched candles

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

  // Wilder smooth: first value = sum of first `period` items
  function wilderSmooth(arr) {
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

  const sTR  = wilderSmooth(trArr);
  const sPDM = wilderSmooth(plusDM);
  const sMDM = wilderSmooth(minusDM);

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
  // Core EMAs per Jaime Merino: EMA10 (fast) + EMA55 (slow bias)
  // EMA200 kept as macro context only
  const ema10arr  = calcEMA(closes, 10);
  const ema55arr  = calcEMA(closes, 55);
  const ema200arr = calcEMA(closes, 200);
  const rsiArr    = calcRSI(closes, 14);
  const adxArr    = calcADX(candles, 14);
  const bbArr     = calcBB(closes, 20, 2);
  const sqzArr    = calcSqueeze(candles, 20);   // BB(20,2) inside KC(20,1.5)
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
  // Rule: EMA10 > EMA55 = bullish bias. Price must be above EMA55 for long.
  const emaBullish = ema10 > ema55;
  const emaBearish = ema10 < ema55;
  const direction  = emaBullish ? 'long' : 'short';

  // ── CONDITION 1: EMA Bias + Price position ──────────────────
  // Long:  EMA10 > EMA55  AND  price above EMA55
  // Short: EMA10 < EMA55  AND  price below EMA55
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
  // "Slope is king" — must be rising, not just above threshold
  const adxRising = adx !== null && adxPrev !== null && adx > adxPrev;
  const adxStrong = adx !== null && adx > 23;  // Merino uses 23 as threshold
  const adxFlat   = adx !== null && Math.abs(adx - (adxPrev ?? adx)) < 0.3;
  const c2 = {
    met:    adxRising && adxStrong,
    label:  'ADX > 23 with rising slope (trend strengthening)',
    detail: adx !== null
      ? `ADX: ${adx.toFixed(1)} · ${adxStrong ? '✓ Strong (>23)' : '✗ Weak (<23, avoid)'} · Slope: ${adxFlat ? '→ Flat (chop — avoid)' : adxRising ? '↑ Rising ✓' : '↓ Falling (exit zone)'}`
      : 'ADX: not enough data yet',
  };

  // ── CONDITION 3: Squeeze fired + momentum in direction ───────
  // Highest conviction: squeeze JUST fired (was coiling, now exploding)
  // Also valid: recently fired within 3 bars AND momentum still expanding
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
  // Extra: RSI at 50 bounce (bullish when >50, bearish when <50)
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
  // The EMA55 is the key dynamic S/R in this strategy.
  // Also check Volume POC and BB extremes as secondary levels.
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
  const nearEMA55  = distEMA55  < 0.03;  // within 3% of EMA55 = ideal bounce
  const nearAnyKey = keyLevels[0].dist < 0.025;
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
  // SL: 7% (or below EMA55 for precision)
  // TP: 1:3 R/R (21%) per strategy minimum R:R of 1:2.5 to 1:4
  const tradeSize       = capital * 0.10;
  const slPct           = 0.07;
  const tpPct           = 0.21; // 1:3 R/R (strategy recommends 1:2.5–1:4)
  const stopLoss        = direction === 'long'
    ? current * (1 - slPct)
    : current * (1 + slPct);
  const takeProfit      = direction === 'long'
    ? current * (1 + tpPct)
    : current * (1 - tpPct);
  const maxLoss         = tradeSize * slPct;
  const estimatedProfit = tradeSize * leverage * tpPct;

  // ── SUBTITLE ────────────────────────────────────────────────
  let subtitle = '';
  if (signal === 'WAIT') {
    if (!c1met) subtitle = `EMA bias not confirmed — EMA10 and price must align with EMA55 before entering. Stay out.`;
    else if (metCount < 3) subtitle = `${metCount}/5 conditions met — need at least 3 for valid entry. Squeeze ${sqz.sqzOn ? 'is still coiling 🔵 — wait for the fire.' : 'has not confirmed direction yet.'}`;
    else subtitle = `${metCount}/5 conditions met. Waiting for full confluence.`;
  } else {
    subtitle = `${metCount}/5 conditions aligned. ${leverage}x leverage. SL $${fmt(stopLoss)} · TP $${fmt(takeProfit)} (1:3 R/R). ${sqzJustFired ? '⚡ Squeeze just fired — highest conviction entry!' : ''}`;
  }

  return {
    signal, direction, metCount, leverage,
    conditions,
    currentPrice: current, prevClose: prev,
    tradeSize, stopLoss, takeProfit, maxLoss, estimatedProfit, slPct, tpPct,
    ema10, ema55, ema200,
    rsi, adx, adxPrev,
    bb, sqz, poc: vp.poc,
    subtitle,
  };
}

// ============================================================
// EXIT SIGNAL ANALYSIS  (Jaime Merino "patrones de salida")
// ============================================================

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
  // "La montaña se vuelve transparente" = histogram shrinking
  const sqzShrinking1  = sqzP  && Math.abs(sqz.val)  < Math.abs(sqzP.val);
  const sqzShrinking2  = sqzP2 && Math.abs(sqzP.val) < Math.abs(sqzP2.val);
  const sqzConsecWeak  = sqzShrinking1 && sqzShrinking2;  // 2 bars shrinking = warning
  // Direction flipped = immediate exit
  const sqzFlipped     = isLong ? sqz.val < 0 : sqz.val > 0;
  // Peak: was expanding, now shrinking
  const sqzPeaked      = sqzShrinking1 && sqzP2 && Math.abs(sqzP.val) > Math.abs(sqzP2.val);

  // ── ADX exit signals ────────────────────────────────────────
  // "Slope is king" — falling = exit
  const adxFalling1    = adx !== null && adxPrev !== null && adx < adxPrev;
  const adxFalling2    = adxPrev !== null && adxPrev2 !== null && adxPrev < adxPrev2;
  const adxConsecFall  = adxFalling1 && adxFalling2;
  const adxFlat        = adx !== null && adxPrev !== null && Math.abs(adx - adxPrev) < 0.5;
  const adxWeak        = adx !== null && adx < 23;

  // ── EMA exit signals ────────────────────────────────────────
  const brokeEMA10  = isLong ? current < ema10  : current > ema10;
  const brokeEMA55  = isLong ? current < ema55  : current > ema55;  // major violation

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
  const rr1hit = Math.abs(pctMove) >= 0.14;  // 1:2 (partial scale out level)
  const rr2hit = Math.abs(pctMove) >= 0.21;  // 1:3 (second target)

  // ── BUILD EXIT STATUS ────────────────────────────────────────
  const tips = [];
  let status = 'HOLD'; // HOLD | WATCH | CAUTION | EXIT

  // Critical exits — override everything
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

  // Caution signals
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

  // R:R tips
  if (rr2hit && pctMove > 0) {
    tips.push({ level: 'hold', text: `💰 1:3 R/R target reached (+${unrealizedPct.toFixed(1)}%). Consider closing 50–70% of position and trailing the rest with EMA10` });
  } else if (rr1hit && pctMove > 0) {
    tips.push({ level: 'hold', text: `💰 1:2 R/R reached (+${unrealizedPct.toFixed(1)}%). Merino says: scale out 30–50%, move SL to breakeven, let the runner go` });
  }

  // Hold tips when everything is good
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

  const statusLabels = {
    HOLD:    '✅ HOLD — All signals positive, let the trade run',
    WATCH:   '👁 WATCH — One signal weakening, monitor closely',
    CAUTION: '⚠️ CAUTION — Multiple weakening signals, prepare to scale out',
    EXIT:    '🔴 EXIT NOW — Critical signal triggered',
  };

  return {
    status,
    statusLabel: statusLabels[status],
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
  if (!lastResult || lastResult.signal === 'WAIT') return;

  activeTrade = {
    direction:  lastResult.direction,
    entryPrice: lastResult.currentPrice,
    entryTime:  Date.now(),
    leverage:   lastResult.leverage,
    tradeSize:  lastResult.tradeSize,
    stopLoss:   lastResult.stopLoss,
    timeframe:  currentTimeframe,
  };
  saveTrade();
  startTradeMonitor();
  showTradeMonitor();

  // Hide the Enter button
  el('enter-trade-wrap').style.display = 'none';
}

function closeTrade(exitPrice, reason) {
  if (activeTrade) {
    const ep = exitPrice != null
      ? exitPrice
      : (lastCandles ? lastCandles[lastCandles.length - 1].close : activeTrade.entryPrice);
    saveTradeToHistory(activeTrade, ep, reason || 'manual');
  }
  activeTrade = null;
  localStorage.removeItem('myCFO_activeTrade');
  stopTradeMonitor();
  el('trade-monitor').style.display = 'none';
  // Re-enable timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(b => { b.disabled = false; });
  // Restore Enter button if signal is still active
  if (lastResult && lastResult.signal !== 'WAIT') {
    showEnterButton(lastResult.signal);
  }
}

function saveTrade() {
  localStorage.setItem('myCFO_activeTrade', JSON.stringify(activeTrade));
}

function loadTrade() {
  try {
    const saved = localStorage.getItem('myCFO_activeTrade');
    if (saved) activeTrade = JSON.parse(saved);
  } catch (e) { activeTrade = null; }
}

// ============================================================
// TRADE MONITOR UI
// ============================================================

function showEnterButton(signal) {
  const wrap = el('enter-trade-wrap');
  const btn  = el('enter-trade-btn');
  wrap.style.display = 'flex';
  btn.textContent = signal === 'LONG'
    ? '⬆ Enter LONG at Market Price'
    : '⬇ Enter SHORT at Market Price';
  btn.className = 'enter-trade-btn' + (signal === 'SHORT' ? ' short-btn' : '');
}

function showTradeMonitor() {
  if (!activeTrade) return;
  // Disable timeframe switching while trade is open
  document.querySelectorAll('.tf-btn').forEach(b => { b.disabled = true; });
  const monitor = el('trade-monitor');
  monitor.style.display = 'block';
  monitor.className = `trade-monitor monitor-${activeTrade.direction}`;
  el('monitor-badge').textContent = activeTrade.direction === 'long' ? 'LONG ACTIVE' : 'SHORT ACTIVE';
  el('monitor-badge').className   = `monitor-badge${activeTrade.direction === 'short' ? ' short' : ''}`;
  el('monitor-entry-price').textContent = '$' + fmt(activeTrade.entryPrice);
  el('monitor-sl').textContent          = '$' + fmt(activeTrade.stopLoss);
  el('monitor-lev').textContent         = activeTrade.leverage + '×';
}

function updateTradeMonitorUI(exit) {
  if (!activeTrade) return;

  // Since
  const secAgo = Math.floor((Date.now() - activeTrade.entryTime) / 1000);
  const minAgo = Math.floor(secAgo / 60);
  const hrsAgo = Math.floor(minAgo / 60);
  el('monitor-since').textContent = hrsAgo > 0
    ? `Entered ${hrsAgo}h ${minAgo % 60}m ago`
    : `Entered ${minAgo}m ago`;

  // Current price
  el('monitor-current-price').textContent = '$' + fmt(exit.current);

  // P&L
  const pnlEl  = el('monitor-pnl');
  const pctEl  = el('monitor-pnl-pct');
  const isProfit = exit.unrealizedPnL >= 0;
  pnlEl.textContent = (isProfit ? '+' : '') + fmtUSD(exit.unrealizedPnL);
  pnlEl.className   = 'monitor-pnl-value ' + (isProfit ? 'profit' : 'loss');
  pctEl.textContent = (isProfit ? '+' : '') + exit.unrealizedPct.toFixed(2) + '%  (pos. move)';
  pctEl.className   = 'monitor-pnl-pct ' + (isProfit ? 'profit' : 'loss');

  // Exit status bar
  const bar = el('exit-status-bar');
  bar.className = `exit-status-bar status-${exit.status.toLowerCase()}`;
  el('exit-status-text').textContent = exit.statusLabel;

  // Tips
  const tipsList = el('exit-tips-list');
  tipsList.innerHTML = '';
  exit.tips.forEach(t => {
    const div = document.createElement('div');
    div.className = `exit-tip tip-${t.level}`;
    div.textContent = t.text;
    tipsList.appendChild(div);
  });

  // Last check time
  el('monitor-last-check').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ============================================================
// MONITOR INTERVAL (30 seconds)
// ============================================================

function startTradeMonitor() {
  stopTradeMonitor();
  monitorInterval = setInterval(async () => {
    if (!activeTrade) { stopTradeMonitor(); return; }
    try {
      const candles = await fetchCandles(activeTrade.timeframe);
      lastCandles   = candles;
      const exit    = analyzeExitSignals(candles, activeTrade);
      updateTradeMonitorUI(exit);
      autoCloseIfNeeded(exit);
    } catch (e) {
      console.warn('Monitor refresh error:', e);
    }
  }, 30000);
}

function autoCloseIfNeeded(exit) {
  if (!activeTrade) return;
  const isLong = activeTrade.direction === 'long';

  // Check SL hit
  if (exit.hitSL) {
    showAutoCloseAlert(
      '🔴 STOP LOSS HIT',
      `Price reached your stop loss at $${fmt(activeTrade.stopLoss)}.\nTrade closed automatically. Loss: ${fmtUSD(exit.unrealizedPnL)}`,
      'loss',
      exit.current
    );
    return;
  }

  // Check TP hit — price moved 21% (1:3 R/R) in favor
  const tpPct   = 0.21;
  const tpPrice = isLong
    ? activeTrade.entryPrice * (1 + tpPct)
    : activeTrade.entryPrice * (1 - tpPct);
  const tpHit = isLong ? exit.current >= tpPrice : exit.current <= tpPrice;

  if (tpHit) {
    showAutoCloseAlert(
      '🎯 TAKE PROFIT HIT',
      `Price reached 1:3 R/R target at $${fmt(tpPrice)}.\nTrade closed automatically. Profit: ${fmtUSD(exit.unrealizedPnL)}`,
      'profit',
      exit.current
    );
  }
}

function showAutoCloseAlert(title, message, type, exitPrice) {
  // Update monitor UI to show the final result before closing
  const bar = el('exit-status-bar');
  bar.className = `exit-status-bar status-${type === 'loss' ? 'exit' : 'hold'}`;
  el('exit-status-text').textContent = `${title} — Trade closed automatically`;

  const tipsList = el('exit-tips-list');
  tipsList.innerHTML = '';
  const div = document.createElement('div');
  div.className = `exit-tip tip-${type === 'loss' ? 'exit' : 'hold'}`;
  div.textContent = message.replace('\n', ' ');
  tipsList.appendChild(div);

  // Close after 5 seconds so user can read the result
  const reason = type === 'loss' ? 'sl' : 'tp';
  setTimeout(() => {
    closeTrade(exitPrice, reason);
  }, 5000);
}

function stopTradeMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
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
    asset:        'BTC/USD',
    direction:    trade.direction,
    timeframe:    trade.timeframe || currentTimeframe,
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

  const history = getTradeHistory();
  history.unshift(record);
  localStorage.setItem('myCFO_tradeHistory', JSON.stringify(history.slice(0, 200)));
  renderTradeHistory();
}

function getTradeHistory() {
  try {
    const saved = localStorage.getItem('myCFO_tradeHistory');
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

function clearTradeHistory() {
  if (!confirm('Delete all trade history? This cannot be undone.')) return;
  localStorage.removeItem('myCFO_tradeHistory');
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
  const section = el('history-section');
  const list    = el('history-list');
  const countEl = el('history-count');
  if (!section) return;

  if (history.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.textContent   = `${history.length} trade${history.length !== 1 ? 's' : ''}`;

  // Totals summary
  const wins    = history.filter(t => t.pnl >= 0).length;
  const totalPnl= history.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = Math.round((wins / history.length) * 100);

  list.innerHTML = '';

  // Summary bar
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
    const reasonLabel = { tp: '🎯 TP', sl: '🔴 SL', manual: '✋ Manual' }[t.reason] || t.reason;
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
// FETCH CANDLES — Bitfinex with Binance fallback
// ============================================================

async function fetchCandles(tf) {
  const urls = getApiUrls(tf || currentTimeframe);
  // Try Bitfinex first
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

  // Fallback: Binance
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

// ============================================================
// UI HELPERS
// ============================================================

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000)  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return n.toFixed(2);
}

function fmtUSD(n) {
  if (!n || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function el(id) { return document.getElementById(id); }

function setSignalCard(signal) {
  const card  = el('signal-card');
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
}

function renderConditions(conditions, direction) {
  const list = el('conditions-list');
  list.innerHTML = '';
  conditions.forEach(c => {
    const row  = document.createElement('div');
    const icon = c.met ? (direction === 'long' ? '✅' : '✅') : '❌';
    row.className = `condition-row${c.met ? (direction === 'long' ? ' met' : ' met-short') : ''}`;
    row.innerHTML = `
      <div class="condition-icon">${icon}</div>
      <div class="condition-body">
        <div class="condition-label">${c.label}</div>
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

function updateUI(r, capital) {
  // Price
  const priceEl = el('btc-price');
  priceEl.textContent = '$' + fmt(r.currentPrice);

  const changeEl  = el('btc-change');
  const changePct = ((r.currentPrice - r.prevClose) / r.prevClose) * 100;
  changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
  changeEl.className   = 'btc-change ' + (changePct >= 0 ? 'up' : 'down');

  // Signal
  setSignalCard(r.signal);
  el('signal-direction').textContent = r.signal !== 'WAIT'
    ? `${r.direction.toUpperCase()} · ${r.metCount}/5 conditions`
    : '';
  el('signal-subtitle').textContent  = r.subtitle;
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

  // Take Profit
  const tpPrice = (r.takeProfit && !isNaN(r.takeProfit)) ? r.takeProfit : null;
  el('param-tp').textContent     = (showTrade && tpPrice) ? '$' + fmt(tpPrice) : '—';
  el('param-tp-pct').textContent = (showTrade && tpPrice)
    ? `${(r.tpPct * 100).toFixed(0)}% move from entry (2:1 R/R)`
    : '';

  // Estimated Profit
  const estProfit = (r.estimatedProfit && !isNaN(r.estimatedProfit)) ? r.estimatedProfit : null;
  el('param-profit').textContent        = (showTrade && estProfit) ? fmtUSD(estProfit) : '—';
  el('param-profit-detail').textContent = (showTrade && estProfit)
    ? `$${fmt(r.tradeSize)} × ${r.leverage}x lev × ${(r.tpPct * 100).toFixed(0)}%`
    : '';

  // Conditions
  renderConditions(r.conditions, r.direction);
  // Indicators
  renderIndicators(r);

  // Enter Trade button — show only when signal active and no open trade
  if (r.signal !== 'WAIT' && !activeTrade) {
    showEnterButton(r.signal);
  } else {
    el('enter-trade-wrap').style.display = 'none';
  }

  // If trade is open, refresh the monitor too
  if (activeTrade && lastCandles) {
    const exit = analyzeExitSignals(lastCandles, activeTrade);
    updateTradeMonitorUI(exit);
  }

  // Time
  el('last-update').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// REFRESH TIMING — align with 4H candle closes
// ============================================================

function msUntilNextCandle() {
  const now  = new Date();
  const next = new Date(now);

  if (currentTimeframe === '1h') {
    next.setUTCHours(now.getUTCHours() + 1, 0, 15, 0);
  } else if (currentTimeframe === '4h') {
    const h     = now.getUTCHours();
    const nextH = (Math.floor(h / 4) + 1) * 4;
    next.setUTCHours(nextH % 24, 0, 15, 0);
    if (nextH >= 24) next.setUTCDate(next.getUTCDate() + 1);
    if (next <= now) next.setUTCHours(next.getUTCHours() + 4);
  } else if (currentTimeframe === '1d') {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 15, 0);
  } else { // 1w
    const day = now.getUTCDay(); // 0=Sun … 6=Sat
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMonday);
    next.setUTCHours(0, 0, 15, 0);
  }

  // Sanity: must be in the future
  if (next <= now) {
    const periodMs = { '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 };
    const ms = periodMs[currentTimeframe] || 14400000;
    return { ms, date: new Date(now.getTime() + ms) };
  }
  return { ms: next - now, date: next };
}

function startCountdown() {
  clearInterval(countdownInterval);
  const bar    = el('countdown-bar');
  const nextEl = el('next-candle');
  const { ms: totalMs, date: closeDate } = msUntilNextCandle();
  candleCloseTime = closeDate;

  countdownInterval = setInterval(() => {
    const remaining = candleCloseTime - Date.now();
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      bar.style.width = '0%';
      return;
    }
    const pct = (remaining / totalMs) * 100;
    bar.style.width = pct + '%';

    // Format countdown
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    nextEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, 1000);
}

function scheduleNextRefresh() {
  clearTimeout(refreshTimer);
  const { ms } = msUntilNextCandle();
  refreshTimer = setTimeout(() => run(), ms);
}

// ============================================================
// TIMEFRAME SELECTOR
// ============================================================

function switchTimeframe(tf) {
  if (activeTrade) return; // monitor must use trade's original timeframe
  currentTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === tf);
  });
  clearTimeout(refreshTimer);
  clearInterval(countdownInterval);
  run();
}

// ============================================================
// MAIN RUN
// ============================================================

async function run() {
  const btn     = el('refresh-btn');
  const capital = parseFloat(el('capital-input').value) || 5000;

  btn.disabled = true;
  btn.textContent = '↻ Loading…';

  try {
    const candles = await fetchCandles();
    lastCandles   = candles;
    lastResult    = analyzeSignal(candles, capital);
    updateUI(lastResult, capital);
    startCountdown();
    scheduleNextRefresh();
  } catch (err) {
    console.error('Error fetching data:', err);
    el('signal-text').textContent = 'ERROR';
    el('signal-subtitle').textContent =
      `Could not load market data: ${err.message}. Check your internet connection and try again.`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '↻ Refresh Now';
  }
}

// Manual refresh button
function manualRefresh() {
  clearTimeout(refreshTimer);
  run();
}

// Re-run analysis if capital changes (no new fetch needed)
el('capital-input').addEventListener('change', () => {
  if (lastResult) {
    const capital     = parseFloat(el('capital-input').value) || 5000;
    const candles_placeholder = null;
    // Recalculate trade params with new capital
    const tradeSize       = capital * 0.10;
    const maxLoss         = tradeSize * lastResult.slPct;
    const estimatedProfit = tradeSize * lastResult.leverage * lastResult.tpPct;
    lastResult.tradeSize       = tradeSize;
    lastResult.maxLoss         = maxLoss;
    lastResult.estimatedProfit = estimatedProfit;
    const show = lastResult.signal !== 'WAIT';
    el('param-trade-size').textContent    = show ? fmtUSD(tradeSize)       : '—';
    el('param-maxloss').textContent       = show ? fmtUSD(maxLoss)         : '—';
    el('param-profit').textContent        = show ? fmtUSD(estimatedProfit) : '—';
    el('param-profit-detail').textContent = show
      ? `$${fmt(tradeSize)} × ${lastResult.leverage}x × ${(lastResult.tpPct * 100).toFixed(0)}%`
      : '';
  }
});

// ============================================================
// BOOT
// ============================================================

// Version + deploy info in footer
const _footerMeta = el('footer-meta');
if (_footerMeta) _footerMeta.innerHTML =
  `<span class="footer-version">${APP_VERSION}</span>` +
  `<span class="footer-sep">·</span>` +
  `<span>Last deploy: ${DEPLOY_DATE} ${DEPLOY_TIME}</span>`;

// Init timeframe button states
document.querySelectorAll('.tf-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.tf === currentTimeframe);
});

loadTrade();                  // restore any open trade from localStorage
if (activeTrade) {
  showTradeMonitor();
  startTradeMonitor();
}
renderTradeHistory();
run();
