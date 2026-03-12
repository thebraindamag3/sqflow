// ============================================================
// myCFO — Jaime Merino Strategy Signal Engine
// BTC/USD · 4H · Bitfinex
// ============================================================

const CANDLE_URL =
  'https://api-pub.bitfinex.com/v2/candles/trade:4h:tBTCUSD/hist?limit=300&sort=1';

// Fallback: Binance BTCUSDT (same price, more reliable CORS)
const CANDLE_URL_FALLBACK =
  'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=300';

let refreshTimer = null;
let countdownInterval = null;
let candleCloseTime = null;
let lastResult = null;

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

  // — Calculate all indicators —
  const ema50arr  = calcEMA(closes, 50);
  const ema100arr = calcEMA(closes, 100);
  const ema200arr = calcEMA(closes, 200);
  const rsiArr    = calcRSI(closes, 14);
  const adxArr    = calcADX(candles, 14);
  const bbArr     = calcBB(closes, 20, 2);
  const sqzArr    = calcSqueeze(candles, 20);
  const vp        = calcVolumeProfile(candles.slice(-100));

  // — Latest values —
  const ema50  = ema50arr[ema50arr.length - 1];
  const ema100 = ema100arr[ema100arr.length - 1];
  const ema200 = ema200arr[ema200arr.length - 1];
  const rsi    = rsiArr[rsiArr.length - 1];
  const bb     = bbArr[bbArr.length - 1];
  const sqz    = sqzArr[sqzArr.length - 1];
  const sqzP   = sqzArr[sqzArr.length - 2];

  // ADX: get last two valid values
  const adxValid = adxArr.filter(v => v !== null);
  const adx      = adxValid[adxValid.length - 1]  ?? null;
  const adxPrev  = adxValid[adxValid.length - 2]  ?? null;

  // — Determine macro trend direction —
  const trendLong  = ema50 > ema200;
  const trendShort = ema50 < ema200;
  const direction  = trendLong ? 'long' : 'short';

  // ── CONDITION 1: EMA Trend Aligned ──────────────────────────
  const c1 = {
    met:    trendLong || trendShort,
    label:  'EMA Trend aligned',
    detail: `EMA50 ($${fmt(ema50)}) is ${trendLong ? 'ABOVE' : 'BELOW'} EMA200 ($${fmt(ema200)}) → ${trendLong ? 'Bullish' : 'Bearish'} trend`,
  };

  // ── CONDITION 2: ADX Rising (trend strength growing) ────────
  const adxRising = adx !== null && adxPrev !== null && adx > adxPrev;
  const adxStrong = adx !== null && adx > 20;
  const c2 = {
    met:    adxRising && adxStrong,
    label:  'ADX rising — trend gaining strength',
    detail: adx !== null
      ? `ADX: ${adx.toFixed(1)} (${adxRising ? '↑ rising' : '↓ falling'}, ${adxStrong ? 'strong >20' : 'weak <20'})`
      : 'ADX: not enough data yet',
  };

  // ── CONDITION 3: Squeeze Momentum aligned with direction ─────
  // Momentum must be in the right direction AND expanding
  const sqzBull  = sqz.val > 0;
  const sqzBear  = sqz.val < 0;
  const momRising = sqzP ? Math.abs(sqz.val) > Math.abs(sqzP.val) : false;
  const sqzFired  = sqzP && sqzP.sqzOn && !sqz.sqzOn; // just broke out of compression
  const c3 = {
    met: direction === 'long'
      ? sqzBull && (momRising || sqzFired)
      : sqzBear && (momRising || sqzFired),
    label:  'Squeeze Momentum confirms direction',
    detail: `Momentum: ${sqz.val.toFixed(2)} (${sqzBull ? '🟢 Bullish' : '🔴 Bearish'}) · ${sqz.sqzOn ? '🔵 Squeeze ON (coiling)' : sqzFired ? '⚡ Just fired!' : '📈 Expanding'} · ${momRising ? 'Increasing ↑' : 'Decreasing ↓'}`,
  };

  // ── CONDITION 4: RSI not in extreme zone ────────────────────
  const rsiOk = rsi !== null
    ? (direction === 'long' ? rsi < 70 : rsi > 30)
    : false;
  const rsiZone = rsi !== null
    ? (rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : rsi > 50 ? 'Bullish zone' : 'Bearish zone')
    : '—';
  const c4 = {
    met:    rsiOk,
    label:  `RSI ${direction === 'long' ? 'not overbought' : 'not oversold'}`,
    detail: rsi !== null
      ? `RSI: ${rsi.toFixed(1)} · ${rsiZone} · ${rsiOk ? 'OK ✓' : direction === 'long' ? 'Overbought — wait for pullback' : 'Oversold — wait for recovery'}`
      : 'RSI: not enough data',
  };

  // ── CONDITION 5: Price near a key support/resistance level ──
  const keyLevels = [
    { label: 'EMA 50',    value: ema50  },
    { label: 'EMA 100',   value: ema100 },
    { label: 'EMA 200',   value: ema200 },
    { label: 'BB Middle', value: bb.mid },
    { label: 'Vol POC',   value: vp.poc },
    ...(direction === 'long'  ? [{ label: 'BB Lower', value: bb.lower }] : []),
    ...(direction === 'short' ? [{ label: 'BB Upper', value: bb.upper }] : []),
  ];

  const withDist = keyLevels.map(l => ({
    ...l,
    dist: Math.abs(current - l.value) / current,
  }));
  withDist.sort((a, b) => a.dist - b.dist);
  const closest = withDist[0];
  const nearLevel = closest.dist < 0.025; // within 2.5%

  const c5 = {
    met:    nearLevel,
    label:  'Price near key support / resistance',
    detail: `Closest: ${closest.label} @ $${fmt(closest.value)} · ${(closest.dist * 100).toFixed(2)}% away ${nearLevel ? '✓' : '(too far)'}`,
  };

  const conditions = [c1, c2, c3, c4, c5];
  const metCount   = conditions.filter(c => c.met).length;

  // — Determine signal —
  let signal = 'WAIT';
  if (metCount >= 3 && c1.met) {
    signal = direction === 'long' ? 'LONG' : 'SHORT';
  }

  // — Leverage based on conditions met —
  let leverage = 0;
  if (metCount === 3) leverage = 3;
  else if (metCount === 4) leverage = 6;
  else if (metCount === 5) leverage = 10;

  // — Trade parameters —
  const tradeSize  = capital * 0.10;
  const slPct      = 0.07;
  const stopLoss   = direction === 'long'
    ? current * (1 - slPct)
    : current * (1 + slPct);
  const maxLoss    = tradeSize * slPct;

  // — Reason text —
  let subtitle = '';
  if (signal === 'WAIT') {
    if (metCount === 0) subtitle = 'No conditions met. Market structure is unclear — stay on the sidelines.';
    else if (metCount === 1) subtitle = `Only 1/5 conditions met. Not enough confluence to enter a trade.`;
    else subtitle = `${metCount}/5 conditions met — need at least 3 for a valid entry. Stay patient.`;
  } else {
    subtitle = `${metCount}/5 conditions met. ${leverage}x leverage suggested. Entry at market price. Stop loss at $${fmt(stopLoss)}.`;
  }

  return {
    signal, direction, metCount, leverage,
    conditions,
    currentPrice: current, prevClose: prev,
    tradeSize, stopLoss, maxLoss, slPct,
    ema50, ema100, ema200,
    rsi, adx, adxPrev,
    bb, sqz, poc: vp.poc,
    subtitle,
  };
}

// ============================================================
// FETCH CANDLES — Bitfinex with Binance fallback
// ============================================================

async function fetchCandles() {
  // Try Bitfinex first
  try {
    const res = await fetch(CANDLE_URL);
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
  const res = await fetch(CANDLE_URL_FALLBACK);
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
  const ema50Dir  = r.ema50  > r.ema200 ? 'up'   : 'down';
  const ema100Dir = r.ema100 > r.ema200 ? 'up'   : 'down';
  const rsiDir    = r.rsi    > 50       ? 'up'   : 'down';
  const adxDir    = r.adx !== null && r.adxPrev !== null && r.adx > r.adxPrev ? 'up' : 'down';
  const sqzDir    = r.sqz.val > 0 ? 'up' : 'down';

  const set = (id, val, cls) => {
    const e = el(id);
    e.textContent = val;
    e.className   = `ind-value${cls ? ' ' + cls : ''}`;
  };

  set('ind-ema50',   '$' + fmt(r.ema50),   ema50Dir);
  set('ind-ema100',  '$' + fmt(r.ema100),  ema100Dir);
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
  el('param-stoploss').textContent   = showTrade ? '$' + fmt(r.stopLoss)     : '—';
  el('param-maxloss').textContent    = showTrade ? fmtUSD(r.maxLoss)         : '—';

  // Conditions
  renderConditions(r.conditions, r.direction);
  // Indicators
  renderIndicators(r);

  // Time
  el('last-update').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ============================================================
// REFRESH TIMING — align with 4H candle closes
// ============================================================

function msUntilNextCandle() {
  const now      = new Date();
  const h        = now.getUTCHours();
  const nextH    = (Math.floor(h / 4) + 1) * 4;  // next 4H boundary (0,4,8,12,16,20)
  const next     = new Date(now);
  next.setUTCHours(nextH % 24, 0, 15, 0);         // 15s after candle close
  if (nextH >= 24) next.setUTCDate(next.getUTCDate() + 1);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 4);
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
// MAIN RUN
// ============================================================

async function run() {
  const btn     = el('refresh-btn');
  const capital = parseFloat(el('capital-input').value) || 5000;

  btn.disabled = true;
  btn.textContent = '↻ Loading…';

  try {
    const candles = await fetchCandles();
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
    const tradeSize = capital * 0.10;
    const maxLoss   = tradeSize * lastResult.slPct;
    lastResult.tradeSize = tradeSize;
    lastResult.maxLoss   = maxLoss;
    el('param-trade-size').textContent = lastResult.signal !== 'WAIT' ? fmtUSD(tradeSize) : '—';
    el('param-maxloss').textContent    = lastResult.signal !== 'WAIT' ? fmtUSD(maxLoss)   : '—';
  }
});

// ============================================================
// BOOT
// ============================================================
run();
