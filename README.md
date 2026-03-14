# SqFlow — Multi-Asset Signal Dashboard for the Jaime Merino Strategy

SqFlow is a real-time trading signal engine that implements the **Jaime Merino Strategy** across futures, FX, and crypto markets. It analyzes five confluence-based entry conditions — EMA bias, ADX trend strength, Bollinger/Keltner squeeze momentum, RSI extremes, and EMA55 bounce zones — to generate high-conviction trade signals with calculated leverage, stop-loss, and take-profit levels. Built for discretionary traders who want systematic signal generation without black-box complexity.

![Version](https://img.shields.io/badge/version-1.4.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D14.0-brightgreen)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)
![License](https://img.shields.io/badge/license-Unlicensed-lightgrey)

---

## Features

### Signal Engine
- **5-condition confluence scoring** — EMA bias + price position, ADX > 23 trend confirmation, Bollinger/Keltner squeeze fire + momentum, RSI non-extreme filter, EMA55 bounce/rejection zone
- **Dynamic leverage calculation** — 1x–5x leverage based on how many conditions are met
- **Automatic stop-loss (−7%) and take-profit (+21%)** — 1:3 risk/reward ratio with optional 1:2 partial scale-out
- **Multi-timeframe analysis** — 1H, 4H, 1D, and 1W candle intervals

### Multi-Asset Coverage
- **Futures — Indices**: S&P 500 (ES), Nasdaq 100 (NQ), Dow Jones (YM), Russell 2000 (RTY), DAX, Nikkei 225
- **Futures — Commodities**: Gold (GC), Silver (SI), Crude Oil WTI (CL), Natural Gas (NG), Copper (HG)
- **FX Pairs**: GBP/USD, EUR/USD, USD/JPY, AUD/USD, USD/CHF
- **Crypto**: BTC, ETH, SOL, XRP, ADA, DOT

### Trade Management
- **One-click market entry** with real-time position tracking
- **30-second automated exit monitoring** — closes trades on stop-loss, take-profit, squeeze collapse, ADX drop, or EMA reversal
- **Persistent trade history** with JSON export
- **Multi-trade support** — run concurrent positions across different instruments

### Authentication & Cloud Sync
- **Firebase Auth** — Google OAuth + email/password
- **Firestore cloud sync** — active trades and history available across devices
- **Guest mode** — fully functional without authentication; seamless migration to account on sign-in
- **Security** — brute-force rate limiting (5 attempts/min), strict password policy, sanitized error messages

### Technical Indicators (Computed Client-Side)
- EMA (10, 55, 200) — Exponential Moving Averages
- RSI (14) — Wilder's Smoothing Method
- ADX (14) — Average Directional Index
- Bollinger Bands (20, 2σ)
- Squeeze Momentum — LazyBear implementation (BB inside Keltner Channel)
- Volume Profile — approximate Point of Control (POC)

---

## Demo

> Screenshot — add a GIF or screenshot of the dashboard here

![Dashboard](docs/screenshot.png)

---

## Architecture

SqFlow is a zero-build, single-page application with a thin Node.js backend. The frontend runs entirely in vanilla JavaScript — no frameworks, no transpilers, no bundlers. The server serves static files and acts as a CORS proxy for Yahoo Finance, while crypto data is fetched directly from Bitfinex and Binance public APIs.

| Layer      | Technology                                          |
|------------|-----------------------------------------------------|
| Frontend   | Vanilla JavaScript (ES2020), HTML5, CSS3             |
| Backend    | Node.js HTTP server (zero dependencies)              |
| Data       | Yahoo Finance (proxy), Bitfinex API, Binance API     |
| Auth       | Firebase Auth + Firestore (optional, graceful degradation) |
| Styling    | Custom CSS with CSS variables (dark theme)           |
| Deployment | Any Node.js host (Render, Railway, Fly.io, VPS)     |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) >= 14.0
- npm (included with Node.js)
- *(Optional)* A Firebase project for authentication and cloud sync

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/thebraindamag3/sqflow.git
cd sqflow

# 2. Install dependencies (none — zero production dependencies)
npm install

# 3. Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

| Variable | Required | Default | Description                          |
|----------|----------|---------|--------------------------------------|
| `PORT`   | No       | `3000`  | HTTP server port                     |

### Firebase Configuration (Optional)

To enable authentication and cloud sync, edit `auth.js` and replace the placeholder values in `FIREBASE_CONFIG` with your Firebase project credentials:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId:             'YOUR_APP_ID',
};
```

If Firebase is not configured, SqFlow runs in **guest-only mode** with all features available (data stored in localStorage only).

---

## Project Structure

```
sqflow/
├── server.js       # Node.js HTTP server + Yahoo Finance CORS proxy
├── app.js          # Signal engine, indicators, trade management, UI rendering
├── auth.js         # Firebase Auth module (OAuth, email, guest mode, cloud sync)
├── index.html      # Single-page application shell
├── style.css       # Dashboard styles (dark theme, responsive)
├── auth.css        # Authentication modal and form styles
├── build.js        # Build script — generates version.json with git SHA
├── package.json    # Project metadata and scripts
└── .gitignore      # Ignores version.json (regenerated at deploy time)
```

---

## Supported Instruments

| Asset Class            | Symbols                                    | Data Source                      |
|------------------------|--------------------------------------------|----------------------------------|
| Futures — Indices      | ES1!, NQ1!, YM1!, RTY1!, DAX1!, NKD1!     | Yahoo Finance (server proxy)     |
| Futures — Commodities  | GC1!, SI1!, CL1!, NG1!, HG1!              | Yahoo Finance (server proxy)     |
| FX Pairs               | GBP/USD, EUR/USD, USD/JPY, AUD/USD, USD/CHF | Yahoo Finance (server proxy)   |
| Crypto                 | BTC/USD, ETH/USD, SOL/USD, XRP/USD, ADA/USD, DOT/USD | Bitfinex (primary), Binance (fallback) |

Market hours are tracked per exchange (CME, EUREX, Forex, Crypto 24/7) with real-time open/closed status display.

---

## API Reference

The server exposes a single API endpoint that proxies Yahoo Finance data to resolve CORS restrictions:

| Method | Endpoint            | Query Params                          | Description                                |
|--------|---------------------|---------------------------------------|--------------------------------------------|
| GET    | `/api/market-data`  | `symbol` (required), `interval`, `range` | Fetch OHLCV candles for a supported symbol |

**Example:**

```bash
curl "http://localhost:3000/api/market-data?symbol=ES1!&interval=1h&range=1mo"
```

**Response:** JSON array of `{ time, open, high, low, close, volume }` objects.

For 4H interval requests, the server fetches 1H data from Yahoo Finance and aggregates it into 4H candles server-side.

---

## Running Tests

Tests coming soon — contributions welcome.

```bash
# To generate a build artifact (version.json with git SHA + timestamp):
npm run build
```

---

## Contributing

1. Fork the repo
2. Create your branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to your branch: `git push origin feature/your-feature`
5. Open a Pull Request

Please follow the existing code style — vanilla JS, clear section comments, no external build tools.

---

## Roadmap

- [ ] #20 — Train strategy more
- [ ] #19 — Create backtest
- [ ] #18 — Create cafecito
- [ ] #17 — Check UI
- [ ] #16 — Check security
- [ ] #15 — Check design patterns
- [ ] #14 — Create about me
- [ ] #13 — Create about the strategy

---

## Strategy Parameters

| Parameter           | Value   | Description                              |
|---------------------|---------|------------------------------------------|
| Stop-Loss           | 7%      | Maximum loss per trade                   |
| Take-Profit         | 21%     | Target profit (1:3 R/R)                  |
| Partial Scale-Out   | 14%     | Optional exit at 1:2 R/R                 |
| ADX Threshold       | 23      | Minimum ADX to confirm trend             |
| EMA55 Proximity     | 3%      | Bounce zone around EMA55                 |
| Capital Per Trade   | 10%     | Position sizing as % of total capital    |
| Candle Limit        | 300     | Candles fetched per API request          |
| Max History         | 200     | Maximum trades stored in history         |

---

## License

This project does not currently include a license file. All rights reserved by the author.

---

Built by [@thebraindamag3](https://github.com/thebraindamag3) 😊
:)
