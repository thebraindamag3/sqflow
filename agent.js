// ============================================================
// SqFlow — AI Agent Tab  (Issue #123)
// Powered by Claude via server-side /api/claude proxy.
// Reads window.sqflowState written by app.js after each renderDashboard().
// ============================================================

(function () {
  'use strict';

  var SYSTEM_PROMPT = [
    'You are an expert swing trading analyst specializing in the Jaime Merino',
    '(TradingLatino) strategy. You will receive live technical indicator data',
    'from a trading dashboard called SqFlow and must produce a structured',
    'analysis following the methodology below.',
    '',
    '## METHODOLOGY',
    '',
    '- Trend defined by EMA55 and EMA200 alignment',
    '- Entry on pullback to EMA55 zone (within 3%)',
    '- Confirmation via ADX > 23 with rising slope',
    '- Momentum filter: RSI(14) not overextended (< 70 for longs, > 30 for shorts)',
    '- Volatility catalyst: TTM Squeeze fired or positive momentum histogram',
    '- Volume anchor: price within 2.5% of Volume Point of Control (VOL POC)',
    '- Stop Loss: fixed 7% below entry',
    '- Take Profit: fixed 21% above entry (1:3 R:R)',
    '- Partial scale-out at +14% (1:2 R:R)',
    '- Minimum acceptable R:R: 2:1',
    '',
    '## OUTPUT FORMAT',
    '',
    'Always respond with this exact structure:',
    '',
    '---',
    '### VERDICT: [LONG \u2705 / SHORT \u2705 / WAIT \u23f3 / DISCARD \u274c]',
    '### SCORE: [X/10]',
    '',
    '**Trend Context**',
    '[2-3 sentences on EMA alignment and macro bias]',
    '',
    '**Pullback Quality**',
    '[Is price in the ideal zone? Is the pullback orderly?]',
    '',
    '**Confirmation**',
    '[ADX, RSI, Squeeze, VOL POC status]',
    '',
    '**Levels**',
    '- Entry: [price or "current market"]',
    '- Stop Loss: [price] (\u22127%)',
    '- Target 1: [price] (+14% / 1:2 R:R)',
    '- Target 2: [price] (+21% / 1:3 R:R)',
    '',
    '**Positive Factors**',
    '- [bullet list]',
    '',
    '**Risk Factors**',
    '- [bullet list]',
    '',
    '**Summary**',
    '[3-4 sentence synthesis. Be direct. If the setup is weak, say so.]',
    '---',
    '',
    'Do not add disclaimers or financial advice warnings.',
    'Keep the tone analytical, direct, and professional.',
  ].join('\n');

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return 'N/A';
    return Number(n).toFixed(2);
  }

  function buildUserContext(s) {
    var ind = s.indicators || {};
    var tp  = s.tradeParams || {};
    var sqz = ind.squeeze || {};
    var conditions = (s.conditions || []).map(function (c, i) {
      return 'C' + (i + 1) + ': ' + c.label + ' — ' + (c.met ? 'MET' : 'NOT MET') + (c.detail ? ' | ' + c.detail : '');
    }).join('\n');

    return [
      'ASSET: ' + s.asset + ' (' + s.assetName + ')',
      'TIMEFRAME: ' + s.timeframe,
      'CURRENT PRICE: ' + fmtNum(s.price),
      'MARKET OPEN: ' + (s.marketOpen ? 'Yes' : 'No'),
      'SIGNAL: ' + s.signal,
      'DIRECTION BIAS: ' + s.direction,
      'CONDITIONS MET: ' + s.metCount + '/5',
      '',
      '--- INDICATORS ---',
      'EMA10:  ' + fmtNum(ind.ema10),
      'EMA55:  ' + fmtNum(ind.ema55),
      'EMA200: ' + fmtNum(ind.ema200),
      'RSI(14): ' + fmtNum(ind.rsi),
      'ADX(14): ' + fmtNum(ind.adx),
      'BB Upper: ' + fmtNum(ind.bbUpper),
      'BB Lower: ' + fmtNum(ind.bbLower),
      'Squeeze ON: ' + (sqz.sqzOn ? 'Yes' : 'No'),
      'Squeeze Just Fired: ' + (sqz.sqzJustFired ? 'Yes' : 'No'),
      'Squeeze Histogram: ' + fmtNum(sqz.histogram),
      'VOL POC: ' + fmtNum(ind.poc),
      '',
      '--- TRADE PARAMETERS ---',
      'Entry: ' + fmtNum(tp.entry),
      'Stop Loss: ' + fmtNum(tp.stopLoss),
      'Take Profit: ' + fmtNum(tp.takeProfit),
      'Leverage: ' + (tp.leverage || 0) + 'x',
      '',
      '--- CONDITIONS ---',
      conditions,
      '',
      'Please provide your full Jaime Merino strategy analysis for this setup.',
    ].join('\n');
  }

  // ── DOM helpers ────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSkeleton(panel) {
    panel.innerHTML =
      '<div class="agent-loading" role="status" aria-live="polite">' +
        '<div class="agent-skeleton agent-skeleton-title"></div>' +
        '<div class="agent-skeleton agent-skeleton-line"></div>' +
        '<div class="agent-skeleton agent-skeleton-line short"></div>' +
        '<div class="agent-skeleton agent-skeleton-line"></div>' +
        '<div class="agent-skeleton agent-skeleton-line short"></div>' +
      '</div>';
  }

  function renderError(panel, msg) {
    panel.innerHTML =
      '<div class="agent-error" role="alert">' +
        '<div class="agent-error-icon" aria-hidden="true">&#9888;</div>' +
        '<div class="agent-error-title">Analysis Unavailable</div>' +
        '<div class="agent-error-msg">' + escHtml(msg) + '</div>' +
      '</div>' +
      renderChatHtml();
    bindChat(panel);
  }

  function markdownToHtml(text) {
    // Basic markdown: headers, bold, bullets, horizontal rules, newlines
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^---$/gm, '<hr>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, function(m) { return '<ul>' + m + '</ul>'; })
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  function renderChatHtml() {
    return '<div class="agent-chat-wrap">' +
      '<div class="agent-chat-history" id="agent-chat-history" aria-live="polite" aria-label="Chat history"></div>' +
      '<div class="agent-chat-input-row">' +
        '<input type="text" class="agent-chat-input" id="agent-chat-input" ' +
          'placeholder="Ask a follow-up question about this setup\u2026" ' +
          'aria-label="Follow-up question">' +
        '<button class="agent-chat-send" id="agent-chat-send" aria-label="Send question">Send</button>' +
      '</div>' +
    '</div>';
  }

  function renderAnalysis(panel, text, s) {
    var header =
      '<div class="agent-header">' +
        '<span class="agent-asset-badge">' + escHtml(s.asset) + ' &middot; ' + escHtml(s.timeframe) + '</span>' +
        '<button class="agent-rerun-btn" id="agent-rerun-btn" aria-label="Re-run analysis">' +
          '&#8635; Re-run Analysis' +
        '</button>' +
      '</div>';

    var analysisHtml =
      '<div class="agent-analysis" role="region" aria-label="AI analysis">' +
        '<div class="agent-analysis-body">' + markdownToHtml(text) + '</div>' +
      '</div>';

    panel.innerHTML = header + analysisHtml + renderChatHtml();

    var rerunBtn = document.getElementById('agent-rerun-btn');
    if (rerunBtn) {
      rerunBtn.addEventListener('click', function () {
        runAnalysis(panel, window.sqflowState);
      });
    }

    bindChat(panel);
  }

  // ── Chat ───────────────────────────────────────────────────

  var chatMessages = [];

  function bindChat(panel) {
    var input  = document.getElementById('agent-chat-input');
    var sendBtn = document.getElementById('agent-chat-send');
    if (!input || !sendBtn) return;

    function send() {
      var q = input.value.trim();
      if (!q) return;
      input.value = '';
      sendFollowUp(panel, q);
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
  }

  function appendChatMessage(role, text) {
    var history = document.getElementById('agent-chat-history');
    if (!history) return;
    var div = document.createElement('div');
    div.className = 'agent-chat-msg agent-chat-msg-' + role;
    div.innerHTML = role === 'assistant'
      ? markdownToHtml(text)
      : escHtml(text);
    history.appendChild(div);
    history.scrollTop = history.scrollHeight;
  }

  function sendFollowUp(panel, question) {
    chatMessages.push({ role: 'user', content: question });
    appendChatMessage('user', question);

    var sendBtn = document.getElementById('agent-chat-send');
    var input   = document.getElementById('agent-chat-input');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '\u23f3'; }
    if (input) input.disabled = true;

    var messages = chatMessages.slice();

    fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: messages,
      }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) throw new Error(data.error);
      var reply = data.content && data.content[0] && data.content[0].text
        ? data.content[0].text
        : JSON.stringify(data);
      chatMessages.push({ role: 'assistant', content: reply });
      appendChatMessage('assistant', reply);
    })
    .catch(function (err) {
      appendChatMessage('assistant', 'Error: ' + err.message);
    })
    .finally(function () {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      if (input) input.disabled = false;
    });
  }

  // ── API call ───────────────────────────────────────────────

  function runAnalysis(panel, s) {
    if (!s) {
      renderError(panel, 'No market data available yet. Please wait for the dashboard to load and try again.');
      return;
    }

    chatMessages = [];

    var userContent = buildUserContext(s);
    renderSkeleton(panel);

    // Seed chat history with this analysis request
    chatMessages.push({ role: 'user', content: userContent });

    fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) throw new Error(data.error);
      var text = data.content && data.content[0] && data.content[0].text
        ? data.content[0].text
        : JSON.stringify(data);
      chatMessages.push({ role: 'assistant', content: text });
      renderAnalysis(panel, text, s);
    })
    .catch(function (err) {
      renderError(panel, err.message);
    });
  }

  // ── State-updated banner ───────────────────────────────────

  var _pendingStateUpdate = false;

  window.addEventListener('sqflow:stateUpdated', function () {
    // Only show prompt if agent tab is not currently active
    var activeTab = document.querySelector('.tab-nav-btn.active');
    if (activeTab && activeTab.dataset && activeTab.dataset.tab === 'agent') return;
    _pendingStateUpdate = true;
  });

  function maybeShowUpdateBanner(panel) {
    if (!_pendingStateUpdate) return;
    _pendingStateUpdate = false;
    var existing = panel.querySelector('.agent-update-banner');
    if (existing) existing.remove();

    var banner = document.createElement('div');
    banner.className = 'agent-update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      'State updated \u2014 <button class="agent-update-banner-btn" id="agent-rerun-banner-btn">re-run analysis?</button>' +
      '<button class="agent-update-banner-close" aria-label="Dismiss">&times;</button>';
    panel.insertBefore(banner, panel.firstChild);

    var rerunBtn = banner.querySelector('#agent-rerun-banner-btn');
    if (rerunBtn) {
      rerunBtn.addEventListener('click', function () {
        banner.remove();
        runAnalysis(panel, window.sqflowState);
      });
    }
    var closeBtn = banner.querySelector('.agent-update-banner-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { banner.remove(); });
    }
  }

  // ── Init ───────────────────────────────────────────────────

  function initAgentTab() {
    var panel = document.getElementById('panel-agent');
    if (!panel) return;

    // Show placeholder on first load
    panel.innerHTML =
      '<div class="agent-placeholder">' +
        '<div class="agent-placeholder-icon" aria-hidden="true">&#129302;</div>' +
        '<div class="agent-placeholder-title">AI Agent</div>' +
        '<div class="agent-placeholder-desc">Switch to this tab after loading dashboard data to get a full Jaime Merino strategy analysis for the current asset.</div>' +
      '</div>';

    window.addEventListener('sqflow:agentTabActivated', function () {
      maybeShowUpdateBanner(panel);
      // Only auto-run if no analysis is showing yet
      var hasAnalysis = panel.querySelector('.agent-analysis');
      if (!hasAnalysis) {
        runAnalysis(panel, window.sqflowState);
      }
    });
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAgentTab);
  } else {
    initAgentTab();
  }

}());
