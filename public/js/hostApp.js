/**
 * hostApp.js
 * Orchestrator for the host/projector display.
 *
 * Responsibilities:
 *  - Create room and display join code
 *  - Wire all server → client events to the projector UI
 *  - Drive the large-screen timer, guess counter, reveal, leaderboard
 *  - Provide host controls (start game, end round early, advance)
 */

/* global SocketClient, EVENTS, GAME_STATE, ROUND_TYPE, WorldMapView, CampusMapView */

const HostApp = (() => {

  // ── State ──────────────────────────────────────────────────────────────────

  // Track whether this is the first connection or a reconnection
  let _hasConnectedBefore = false;

  const state = {
    roomCode: null,
    playerId: null,
    totalRounds: 0,
    roundIndex: -1,
    currentRound: null,
    timerInterval: null,
    roundEndsAt: 0,
    roundDurationMs: 0,
    totalPlayers: 0,
  };

  // ── DOM Refs ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const screens = {
    lobby: $('screen-lobby'),
    countdown: $('screen-countdown'),
    round: $('screen-round'),
    reveal: $('screen-reveal'),
    leaderboard: $('screen-leaderboard'),
    gameover: $('screen-gameover'),
  };

  const els = {
    // Lobby
    lobbyCode: $('lobby-code'),
    lobbyJoinUrl: $('lobby-join-url'),
    lobbyPlayerGrid: $('lobby-player-grid'),
    lobbyPlayerCount: $('lobby-player-count'),
    btnStart: $('btn-start'),

    // Countdown
    countdownNumber: $('host-countdown-number'),
    countdownLabel: $('host-countdown-label'),

    // Round
    panoRoundLabel: $('pano-round-label'),
    panoRoundTitle: $('pano-round-title'),
    hostRoundChip: $('host-round-chip'),
    hostTimerDigit: $('host-timer-digit'),
    hostTimerBar: $('host-timer-bar'),
    hostGuessCount: $('host-guess-count'),
    hostGuessTotal: $('host-guess-total'),
    hostGuessBar: $('host-guess-bar'),
    hostWorldMiniMap: $('host-world-mini-map'),
    hostCampusMiniWrap: $('host-campus-mini-wrap'),
    hostCampusMiniImg: $('host-campus-mini-img'),
    hostCampusMiniCanvas: $('host-campus-mini-canvas'),
    btnEndRoundEarly: $('btn-end-round-early'),

    // Reveal
    revealRoundLabel: $('reveal-round-label'),
    revealLocationLabel: $('reveal-location-label'),
    revealNextBtn: $('reveal-next-btn'),
    revealPodiumList: $('reveal-podium-list'),
    revealStats: $('reveal-stats'),
    hostRevealWorldMap: $('host-reveal-world-map'),
    hostRevealCampusWrap: $('host-reveal-campus-wrap'),
    hostRevealCampusImg: $('host-reveal-campus-img'),
    hostRevealCampusCanvas: $('host-reveal-campus-canvas'),

    // Leaderboard
    lbTitle: $('lb-title'),
    lbSubtitle: $('lb-subtitle'),
    lbList: $('host-lb-list'),
    lbNextBtn: $('lb-next-btn'),

    // Game Over
    gameoverPodium: $('gameover-podium-wrap'),

    // Toast
    toastContainer: $('toast-container'),
  };

  // ── Screen Manager ─────────────────────────────────────────────────────────

  /**
   * @param {keyof typeof screens} name
   */
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.style.display = key === name ? 'flex' : 'none';
    });
  }

  /**
 * Show a temporary "reconnecting" screen while waiting for the next
 * server broadcast to resync the host display to the current game state.
 *
 * @param {string} currentState  GAME_STATE value
 */
  function _showResyncScreen(currentState) {
    // We don't have enough info to fully rebuild the current screen,
    // but the next server event (S_ROUND_START, S_ROUND_REVEAL, etc)
    // will arrive shortly and update the display correctly.
    // For now show a neutral holding screen.
    Object.values(screens).forEach((el) => el.style.display = 'none');

    // Reuse countdown screen as a holding state
    els.countdownNumber.textContent = '↺';
    els.countdownLabel.textContent = `Rejoined game — waiting for next event…`;
    screens.countdown.style.display = 'flex';
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  /**
   * @param {string} message
   * @param {'default'|'error'|'success'} [type='default']
   * @param {number} [durationMs=3500]
   */
  function toast(message, type = 'default', durationMs = 3500) {
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : ''}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  /**
   * Start the host-side visual timer.
   *
   * @param {number} endsAt      Server-provided Unix ms timestamp
   * @param {number} durationMs  Total round duration for bar scaling
   */
  function startTimer(endsAt, durationMs) {
    _clearTimer();
    state.roundEndsAt = endsAt;
    state.roundDurationMs = durationMs;

    function tick() {
      const remaining = Math.max(0, state.roundEndsAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      const progress = remaining / state.roundDurationMs;

      els.hostTimerDigit.textContent = secs;
      els.hostTimerBar.style.transform = `scaleX(${progress})`;

      const isWarn = secs <= 10 && secs > 5;
      const isDanger = secs <= 5;

      [els.hostTimerDigit, els.hostTimerBar].forEach((el) => {
        el.classList.toggle('warn', isWarn);
        el.classList.toggle('danger', isDanger);
      });

      if (remaining <= 0) _clearTimer();
    }

    tick();
    state.timerInterval = setInterval(tick, 250);
  }

  function _clearTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  // ── Lobby ──────────────────────────────────────────────────────────────────

  /**
   * Update the lobby player grid with name chips.
   *
   * @param {Array} players
   */
  function updateLobbyPlayers(players) {
    // Filter out the host from the player grid display
    const nonHost = players.filter((p) => p.role !== 'host');

    els.lobbyPlayerCount.textContent =
      `${nonHost.length} player${nonHost.length !== 1 ? 's' : ''} joined`;

    // Rebuild grid — simple approach is fine since lobby updates aren't
    // high-frequency and the DOM is small
    els.lobbyPlayerGrid.innerHTML = '';
    nonHost.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'lobby-player-chip';
      chip.textContent = _escHtml(p.nickname);
      els.lobbyPlayerGrid.appendChild(chip);
    });
  }

  // ── Round Setup ───────────────────────────────────────────────────────────

  /**
   * Set up the round screen for the host display.
   *
   * @param {Object} round
   * @param {number} roundIndex
   * @param {number} totalRounds
   * @param {number} durationMs
   * @param {number} endsAt
   */
  function setupRound(round, roundIndex, totalRounds, durationMs, endsAt) {
    state.currentRound = round;
    state.roundIndex = roundIndex;
    state.totalRounds = totalRounds;

    const isWorld = round.type === ROUND_TYPE.WORLD;

    // Info bar
    els.panoRoundLabel.textContent =
      `Round ${roundIndex + 1} of ${totalRounds}`;
    els.panoRoundTitle.textContent = round.label ?? '';

    // Round chip
    els.hostRoundChip.textContent = isWorld ? 'World' : 'Campus';
    els.hostRoundChip.className = `round-chip ${isWorld ? 'world' : 'campus'}`;

    // Reset guess counter
    _updateGuessCounter(0, state.totalPlayers);

    // Panorama viewer
    _initViewer(round);

    // Mini map in sidebar
    if (isWorld) {
      els.hostWorldMiniMap.style.display = 'block';
      els.hostCampusMiniWrap.style.display = 'none';
      WorldMapView.init('host-world-mini-map', null); // null = no pin callback; host doesn't guess
    } else {
      els.hostWorldMiniMap.style.display = 'none';
      els.hostCampusMiniWrap.style.display = 'flex';
      els.hostCampusMiniImg.src = round.photoUrl ?? '';
      // Sync mini canvas size once image loads
      els.hostCampusMiniImg.onload = () => {
        _syncMiniCanvas();
      };
      if (els.hostCampusMiniImg.complete && els.hostCampusMiniImg.naturalWidth > 0) {
        _syncMiniCanvas();
      }
    }

    startTimer(endsAt, durationMs);
  }

  /**
   * Sync the campus mini-map canvas size to the image.
   */
  function _syncMiniCanvas() {
    const img = els.hostCampusMiniImg;
    const canvas = els.hostCampusMiniCanvas;
    const rect = img.getBoundingClientRect();
    if (rect.width > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  }

  // In hostApp.js — extracted so it can be called multiple times
  async function _acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        await navigator.wakeLock.request('screen');
        console.info('[host] Wake lock acquired');
      } catch (err) {
        console.warn('[host] Wake lock failed:', err);
      }
    }
  }

  /**
   * Initialise the 360° panorama viewer for the current round.
   *
   * @param {Object} round
   */
  function _initViewer(round) {
    const pannellumEl = $('host-pannellum-viewer');
    const mapillaryEl = $('host-mapillary-viewer');

    if (round.type === ROUND_TYPE.WORLD) {
      pannellumEl.style.display = 'none';
      mapillaryEl.style.display = 'block';
      WorldMapView.initMapillaryViewer('host-mapillary-viewer', round.panoId);
    } else {
      mapillaryEl.style.display = 'none';
      pannellumEl.style.display = 'block';
      if (window._hostPannellumViewer) {
        try { window._hostPannellumViewer.destroy(); } catch (_) { }
      }
      window._hostPannellumViewer = window.pannellum.viewer('host-pannellum-viewer', {
        type: 'equirectangular',
        panorama: round.photoUrl,
        autoLoad: true,
        showControls: false, // host display is read-only
        compass: false,
        mouseZoom: false,
        hfov: 100,
        autoRotate: -2, // slow auto-rotate for visual interest on projector
      });
    }
  }

  // ── Guess Counter ──────────────────────────────────────────────────────────

  /**
   * Update the live guess counter in the sidebar.
   *
   * @param {number} count
   * @param {number} total
   */
  function _updateGuessCounter(count, total) {
    els.hostGuessCount.textContent = count;
    els.hostGuessTotal.textContent = `/ ${total || '—'}`;

    const pct = total > 0 ? (count / total) * 100 : 0;
    els.hostGuessBar.style.width = `${pct}%`;

    // Turn bar accent green when all guessed
    if (count > 0 && count >= total) {
      els.hostGuessBar.style.background = 'var(--accent)';
    } else {
      els.hostGuessBar.style.background = 'var(--accent)';
    }
  }

  // ── Reveal ─────────────────────────────────────────────────────────────────

  /**
   * Render the reveal screen on the host display.
   * Shows the correct location label, all guess pins animating onto the map,
   * and the top-3 podium sidebar.
   *
   * @param {Object} payload  S_ROUND_REVEAL payload
   */
  function renderReveal(payload) {
    _clearTimer();

    const {
      answer,
      scores,
      roundType,
      roundLabel,
      locationHint,
      podium,
      noGuessList,
      leaderboard,
    } = payload;

    // Top bar
    els.revealRoundLabel.textContent = roundLabel ?? '';
    els.revealLocationLabel.textContent = locationHint ?? '—';

    // Podium sidebar — top 3 guessers this round
    _renderRevealPodium(scores, podium);

    // Round stats
    _renderRevealStats(scores, noGuessList);

    // Map reveal
    if (roundType === ROUND_TYPE.WORLD) {
      els.hostRevealWorldMap.style.display = 'block';
      els.hostRevealCampusWrap.style.display = 'none';
      WorldMapView.renderReveal(
        'host-reveal-world-map',
        answer,
        scores,
        null // no self-player on host display
      );
    } else {
      els.hostRevealWorldMap.style.display = 'none';
      els.hostRevealCampusWrap.style.display = 'flex';
      els.hostRevealCampusImg.src = state.currentRound?.photoUrl ?? '';
      CampusMapView.renderReveal(
        'host-reveal-campus-canvas',
        'host-reveal-campus-img',
        answer,
        scores,
        null // no self-player
      );
    }

    showScreen('reveal');
  }

  /**
   * Build the top-3 podium list in the reveal sidebar.
   *
   * @param {Array} scores     All scored guesses this round
   * @param {Array} podiumData Top 3 from leaderboard (cumulative)
   */
  function _renderRevealPodium(scores, podiumData) {
    els.revealPodiumList.innerHTML = '';

    // Show top 3 scorers for THIS round (by distance rank)
    const topThisRound = [...scores]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3);

    const medals = ['🥇', '🥈', '🥉'];

    topThisRound.forEach((entry, i) => {
      const el = document.createElement('div');
      el.className = 'podium-entry';
      el.innerHTML = `
        <span class="podium-medal">${medals[i]}</span>
        <div class="podium-info">
          <div class="podium-nick">${_escHtml(_getNickname(entry.playerId))}</div>
          <div class="podium-dist">${entry.distanceDisplay}</div>
        </div>
        <span class="podium-pts">+${entry.points}</span>
      `;
      els.revealPodiumList.appendChild(el);
    });
  }

  /**
   * Render round statistics in the reveal sidebar.
   *
   * @param {Array} scores
   * @param {Array} noGuessList
   */
  function _renderRevealStats(scores, noGuessList) {
    els.revealStats.innerHTML = '';

    const guessCount = scores.length;
    const noGuess = noGuessList.length;
    const bestDist = scores.length > 0
      ? scores.find((s) => s.rank === 1)?.distanceDisplay ?? '—'
      : '—';
    const avgNorm = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.distanceNorm, 0) / scores.length
      : null;

    const stats = [
      { label: 'Guesses submitted', value: `${guessCount}` },
      { label: 'No guess', value: `${noGuess}` },
      { label: 'Best guess', value: bestDist },
    ];

    if (avgNorm !== null) {
      stats.push({
        label: 'Avg accuracy',
        value: `${Math.round((1 - avgNorm) * 100)}%`,
      });
    }

    stats.forEach(({ label, value }) => {
      const row = document.createElement('div');
      row.className = 'reveal-stat-row';
      row.style.cssText = 'margin-bottom:0.6rem';
      row.innerHTML = `
        <span class="reveal-stat-label">${label}</span>
        <span class="reveal-stat-value">${value}</span>
      `;
      els.revealStats.appendChild(row);
    });
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────

  /**
   * Render the host leaderboard screen.
   * Shows all players in a two-column grid optimised for projector viewing.
   *
   * @param {Object} payload  S_LEADERBOARD payload
   */
  function renderLeaderboard(payload) {
    const { players, roundIndex, totalRounds, isLastRound } = payload;

    els.lbTitle.textContent = isLastRound ? 'Final Standings' : 'Leaderboard';
    els.lbSubtitle.textContent =
      `After Round ${roundIndex + 1} of ${totalRounds}`;

    els.lbNextBtn.textContent = isLastRound ? 'See Final Results →' : 'Next Round →';

    // Store player nicknames for reveal podium lookup
    players.forEach((p) => {
      _nicknameCache.set(p.id, p.nickname);
    });

    els.lbList.innerHTML = '';

    players.forEach((p, i) => {
      const pos = i + 1;
      const isSelf = false; // host has no self

      const row = document.createElement('div');
      row.className = [
        'lb-row',
        pos === 1 ? 'lb-row--podium1' : '',
        pos === 2 ? 'lb-row--podium2' : '',
        pos === 3 ? 'lb-row--podium3' : '',
      ].filter(Boolean).join(' ');

      row.innerHTML = `
        <span class="lb-pos ${pos <= 3 ? `pos-${pos}` : ''}">${_posIcon(pos)}</span>
        <span class="lb-nick ${p.connected ? '' : 'disconnected'}">${_escHtml(p.nickname)}</span>
        <span class="lb-round-pts">${p.roundPoints != null && p.roundPoints > 0 ? `+${p.roundPoints}` : ''}</span>
        <span class="lb-total-pts t-mono">${p.score}</span>
      `;

      els.lbList.appendChild(row);
    });

    showScreen('leaderboard');
  }

  // ── Game Over ──────────────────────────────────────────────────────────────

  /**
   * Render the final game over / podium screen.
   *
   * @param {Object} payload  S_GAME_OVER payload
   */
  function renderGameOver(payload) {
    _clearTimer();
    const { leaderboard } = payload;

    els.gameoverPodium.innerHTML = '';

    const medals = ['🥇', '🥈', '🥉'];

    leaderboard.slice(0, 3).forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'gameover-podium-entry';
      el.innerHTML = `
        <span class="gameover-medal">${medals[i]}</span>
        <span class="gameover-nick">${_escHtml(p.nickname)}</span>
        <span class="gameover-score">${p.score}</span>
      `;
      els.gameoverPodium.appendChild(el);
    });

    SocketClient.clearSession();
    showScreen('gameover');
  }

  // ── Nickname Cache ────────────────────────────────────────────────────────

  /**
   * Cache player IDs → nicknames so the reveal podium can look up
   * nicknames from just a playerId (scores don't include nicknames).
   * @type {Map<string, string>}
   */
  const _nicknameCache = new Map();

  /**
   * Look up a player's nickname from the cache.
   * Falls back to a truncated player ID if not found.
   *
   * @param {string} playerId
   * @returns {string}
   */
  function _getNickname(playerId) {
    return _nicknameCache.get(playerId) ?? playerId.slice(0, 8);
  }

  // ── Socket Event Wiring ────────────────────────────────────────────────────

  function _wireEvents() {

    // ── Connection ─────────────────────────────────────────────────────────

    // _connected fires on EVERY connection including reconnects
    SocketClient.on('_connected', () => {
      if (_hasConnectedBefore) {
        // This is a reconnection — _reconnected handler below takes care of it
        return;
      }

      // First connection only — create or rejoin room
      _hasConnectedBefore = true;
      const saved = SocketClient.getSavedSession();

      if (saved.roomCode) {
        console.info('[host] Found saved session — rejoining:', saved.roomCode);
        SocketClient.joinRoom(saved.roomCode, 'Host');
      } else {
        SocketClient.createRoom('Host');
      }
    });

    // _reconnected fires specifically after a dropped connection recovers
    SocketClient.on('_reconnected', async () => {
      // Re-acquire wake lock (browser releases it when tab goes background)
      await _acquireWakeLock();

      toast('Reconnected!', 'success');

      const saved = SocketClient.getSavedSession();
      if (saved.roomCode) {
        SocketClient.joinRoom(saved.roomCode, 'Host');
      } else {
        toast('Reconnected but lost session — please refresh', 'error', 0);
      }
    });

    SocketClient.on('_disconnected', () => {
      toast('Connection lost — reconnecting…', 'error', 8000);
    });

    SocketClient.on('_reconnect_failed', () => {
      toast('Lost connection to server. Please refresh this page.', 'error', 0);
    });

    // ── S_ROOM_JOINED ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_JOINED, (payload) => {
      const { roomCode, playerId, players, reconnected, gameState: gs } = payload;

      state.roomCode = roomCode;
      state.playerId = playerId;

      SocketClient.setSession(roomCode, playerId);

      // Cache all player nicknames
      players.forEach((p) => _nicknameCache.set(p.id, p.nickname));

      if (reconnected && gs && gs !== GAME_STATE.LOBBY) {
        // Host reconnected mid-game — show a reconnecting screen
        // and wait for the next server broadcast to resync display
        toast('Reconnected to game in progress — resyncing…', 'success');
        _showResyncScreen(gs);
        return;
      }

      // Fresh join — show lobby as normal
      els.lobbyCode.textContent = roomCode;
      els.lobbyJoinUrl.textContent = `${window.location.hostname}/play`;
      updateLobbyPlayers(players);
      showScreen('lobby');
    });

    // ── S_ROOM_PLAYERS ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_PLAYERS, (payload) => {
      const { players } = payload;
      state.totalPlayers = players.filter((p) => p.role !== 'host').length;
      players.forEach((p) => _nicknameCache.set(p.id, p.nickname));
      updateLobbyPlayers(players);
    });

    // ── S_GAME_COUNTDOWN ───────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_COUNTDOWN, (payload) => {
      const { countdownMs, totalRounds } = payload;
      state.totalRounds = totalRounds;

      showScreen('countdown');
      els.countdownLabel.textContent = `${totalRounds} rounds — let's go!`;

      const steps = Math.ceil(countdownMs / 1000);
      let current = steps;

      function tick() {
        els.countdownNumber.textContent = current;
        els.countdownNumber.style.animation = 'none';
        void els.countdownNumber.offsetWidth;
        els.countdownNumber.style.animation = '';
        current--;
        if (current > 0) setTimeout(tick, 1000);
      }
      tick();
    });

    // ── S_ROUND_START ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_START, (payload) => {
      const { round, roundIndex, totalRounds, durationMs, endsAt } = payload;
      setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
      showScreen('round');
    });

    // ── S_ROUND_TICK ───────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_TICK, (payload) => {
      state.roundEndsAt = Date.now() + payload.remainingMs;
    });

    // ── S_GUESS_COUNT ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_COUNT, (payload) => {
      const { guessCount, totalPlayers } = payload;
      state.totalPlayers = totalPlayers;
      _updateGuessCounter(guessCount, totalPlayers);
    });

    // ── S_ROUND_REVEAL ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_REVEAL, (payload) => {
      renderReveal(payload);
    });

    // ── S_LEADERBOARD ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_LEADERBOARD, (payload) => {
      // Update nickname cache from leaderboard
      (payload.players ?? []).forEach((p) => {
        if (p.id && p.nickname) _nicknameCache.set(p.id, p.nickname);
      });
      renderLeaderboard(payload);
    });

    // ── S_GAME_OVER ────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_OVER, (payload) => {
      renderGameOver(payload);
    });

    // ── S_ERROR ────────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ERROR, (payload) => {
      const { code, message } = payload;
      console.error('[host error]', code, message);

      if (code === 'NOT_ENOUGH_PLAYERS') {
        toast('Need at least 1 player to start', 'error');
        return;
      }

      toast(message ?? 'Something went wrong', 'error');
    });
  }

  // ── DOM Event Wiring ──────────────────────────────────────────────────────

  function _wireDom() {

    // Start game
    els.btnStart.addEventListener('click', () => {
      els.btnStart.disabled = true;
      els.btnStart.textContent = 'Starting…';
      SocketClient.startGame();
      setTimeout(() => {
        els.btnStart.disabled = false;
        els.btnStart.textContent = 'Start Game';
      }, 4000);
    });

    // End round early (during active round)
    els.btnEndRoundEarly.addEventListener('click', () => {
      if (!confirm('End this round now for all players?')) return;
      SocketClient.hostNext();
    });

    // Advance from reveal → leaderboard
    els.revealNextBtn.addEventListener('click', () => {
      SocketClient.hostNext();
    });

    // Advance from leaderboard → next round (or game over)
    els.lbNextBtn.addEventListener('click', () => {
      SocketClient.hostNext();
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /** @param {number} pos */
  function _posIcon(pos) {
    if (pos === 1) return '🥇';
    if (pos === 2) return '🥈';
    if (pos === 3) return '🥉';
    return String(pos);
  }

  /** @param {string} str */
  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  // Browser releases wake lock when tab goes hidden — re-acquire when it comes back
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await _acquireWakeLock();
  }
});

async function init() {
  await _acquireWakeLock();
  SocketClient.connect();
  _wireEvents();
  _wireDom();
}

  return { init, toast };

})();

document.addEventListener('DOMContentLoaded', () => HostApp.init());