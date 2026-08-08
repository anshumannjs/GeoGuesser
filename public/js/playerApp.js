/**
 * playerApp.js
 * Main orchestrator for the player view.
 *
 * Responsibilities:
 *  - Screen lifecycle (showScreen)
 *  - Wiring all server → client socket events to UI updates
 *  - Timer rendering (bar + digit)
 *  - Guess submission coordination
 *  - Leaderboard and reveal rendering
 *  - Toast notifications
 */

/* global SocketClient, EVENTS, GAME_STATE, ROUND_TYPE, WorldMapView, CampusMapView */

const PlayerApp = (() => {

  // ── Session state ──────────────────────────────────────────────────────────

  const state = {
    nickname:     null,
    roomCode:     null,
    playerId:     null,
    role:         null,
    currentRound: null,   // round object (client-safe, no answer coords)
    roundIndex:   -1,
    totalRounds:  0,
    guessSubmitted: false,
    pendingCoord:   null, // coord staged but not yet confirmed
    timerInterval:  null,
    roundDurationMs: 0,
    roundEndsAt:     0,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const screens = {
    lobby:       $('screen-lobby'),
    waiting:     $('screen-waiting'),
    countdown:   $('screen-countdown'),
    round:       $('screen-round'),
    reveal:      $('screen-reveal'),
    leaderboard: $('screen-leaderboard'),
    gameover:    $('screen-gameover'),
  };

  const els = {
    // Lobby
    inputCode:       $('input-code'),
    inputNick:       $('input-nick'),
    btnJoin:         $('btn-join'),
    joinError:       $('join-error'),

    // Waiting
    waitingCount:    $('waiting-player-count'),
    waitingNick:     $('waiting-nick-badge'),

    // Countdown
    countdownNumber: $('countdown-number'),
    countdownLabel:  $('countdown-label'),

    // Round
    roundChip:       $('round-chip'),
    timerDigit:      $('timer-digit'),
    timerBar:        $('timer-bar'),
    guessStatus:     $('guess-status'),
    guessPill:       $('guess-pill'),
    btnSubmit:       $('btn-submit-guess'),
    submittedOverlay:$('submitted-overlay'),
    worldMap:        $('world-map'),
    campusMapWrap:   $('campus-map-wrap'),

    // Reveal
    revealRoundLabel:  $('reveal-round-label'),
    revealLocation:    $('reveal-location'),
    revealDistance:    $('reveal-distance'),
    revealPointsBadge: $('reveal-points-badge'),
    revealRankBadge:   $('reveal-rank-badge'),
    revealWorldMap:    $('reveal-world-map'),
    revealCampusWrap:  $('reveal-campus-wrap'),
    revealCampusImg:   $('reveal-campus-img'),
    revealCampusCanvas:$('reveal-campus-canvas'),

    // Leaderboard
    lbList:        $('lb-list'),
    lbRoundLabel:  $('lb-round-label'),

    // Game over
    gameoverPodium: $('gameover-podium'),
    btnPlayAgain:   $('btn-play-again'),

    // Toast
    toastContainer: $('toast-container'),
  };

  // ── Screen Manager ─────────────────────────────────────────────────────────

  /**
   * Show one screen, hide all others.
   * @param {keyof typeof screens} name
   */
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.style.display = key === name ? 'flex' : 'none';
    });
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  /**
   * Show a transient toast notification.
   *
   * @param {string} message
   * @param {'default'|'error'|'success'} [type='default']
   * @param {number} [durationMs=3000]
   */
  function toast(message, type = 'default', durationMs = 3000) {
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : ''}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  /**
   * Start the visual countdown timer.
   * Uses local Date.now() drift-corrected against server-provided endsAt.
   *
   * @param {number} endsAt       Unix ms timestamp from server
   * @param {number} durationMs   Total round duration (for bar scaling)
   */
  function startTimer(endsAt, durationMs) {
    _clearTimer();
    state.roundEndsAt    = endsAt;
    state.roundDurationMs = durationMs;

    function tick() {
      const remaining = Math.max(0, state.roundEndsAt - Date.now());
      const secs      = Math.ceil(remaining / 1000);
      const progress  = remaining / state.roundDurationMs; // 1 → 0

      // Digit
      els.timerDigit.textContent = secs;

      // Bar scale
      els.timerBar.style.transform = `scaleX(${progress})`;

      // Colour states
      const isWarn   = secs <= 10 && secs > 5;
      const isDanger = secs <= 5;

      [els.timerDigit, els.timerBar].forEach((el) => {
        el.classList.toggle('warn',   isWarn);
        el.classList.toggle('danger', isDanger);
      });

      if (remaining <= 0) {
        _clearTimer();
      }
    }

    tick();
    state.timerInterval = setInterval(tick, 250); // 250ms for smoothness
  }

  function _clearTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  // ── Guess Coordination ────────────────────────────────────────────────────

  /**
   * Called by WorldMapView or CampusMapView when the player clicks a location.
   * Stages the coord and enables the confirm button.
   *
   * @param {{ lat: number, lng: number }|{ x: number, y: number }} coord
   */
  function onPinPlaced(coord) {
    if (state.guessSubmitted) return;
    state.pendingCoord = coord;
    els.btnSubmit.disabled = false;
    els.guessStatus.textContent = 'Pin placed — confirm when ready';
    els.guessStatus.style.color = 'var(--accent)';
  }

  /**
   * Submit the staged guess to the server.
   */
  function _submitGuess() {
    if (!state.pendingCoord || state.guessSubmitted) return;
    state.guessSubmitted = true;

    SocketClient.submitGuess(state.roundIndex, state.pendingCoord);

    // Immediately lock UI
    els.btnSubmit.disabled = true;
    els.submittedOverlay.style.display = 'flex';
    els.guessStatus.textContent = 'Guess locked in!';
    els.guessStatus.style.color = 'var(--text-secondary)';
  }

  // ── Round Setup ───────────────────────────────────────────────────────────

  /**
   * Configure the round screen for the incoming round.
   * Initialises the correct map/viewer, resets guess state.
   *
   * @param {Object} round       Client-safe round object
   * @param {number} roundIndex
   * @param {number} totalRounds
   * @param {number} durationMs
   * @param {number} endsAt
   */
  function setupRound(round, roundIndex, totalRounds, durationMs, endsAt) {
    state.currentRound   = round;
    state.roundIndex     = roundIndex;
    state.totalRounds    = totalRounds;
    state.guessSubmitted = false;
    state.pendingCoord   = null;

    // Round type chip
    const isWorld = round.type === ROUND_TYPE.WORLD;
    els.roundChip.textContent = isWorld ? 'World' : 'Campus';
    els.roundChip.className   = `round-chip ${isWorld ? 'world' : 'campus'}`;

    // Reset submit button
    els.btnSubmit.disabled = true;
    els.submittedOverlay.style.display = 'none';
    els.guessStatus.textContent = 'Drop a pin on the map';
    els.guessStatus.style.color = 'var(--text-secondary)';
    els.guessPill.textContent   = '— / —';
    els.guessPill.classList.remove('all-guessed');

    // Show correct map, hide other
    if (isWorld) {
      els.worldMap.style.display      = 'block';
      els.campusMapWrap.style.display = 'none';
      WorldMapView.init('world-map', onPinPlaced);
    } else {
      els.worldMap.style.display      = 'none';
      els.campusMapWrap.style.display = 'flex';
      CampusMapView.init('campus-canvas', 'campus-map-img', round.photoUrl, onPinPlaced);
    }

    // 360° panorama viewer
    _initViewer(round);

    // Timer
    startTimer(endsAt, durationMs);
  }

  /**
   * Initialise the panorama viewer for the current round.
   * World rounds → Mapillary, campus rounds → Pannellum.
   *
   * @param {Object} round
   */
  function _initViewer(round) {
    const pannellumEl = $('pannellum-viewer');
    const mapillaryEl = $('mapillary-viewer');

    if (round.type === ROUND_TYPE.WORLD) {
      pannellumEl.style.display = 'none';
      mapillaryEl.style.display = 'block';
      WorldMapView.initMapillaryViewer('mapillary-viewer', round.panoId);
    } else {
      mapillaryEl.style.display = 'none';
      pannellumEl.style.display = 'block';
      _initPannellum(pannellumEl, round.photoUrl);
    }
  }

  /**
   * Initialise or reinitialise the Pannellum 360° viewer.
   *
   * @param {HTMLElement} container
   * @param {string}      photoUrl
   */
  function _initPannellum(container, photoUrl) {
    // Pannellum attaches to a container element by ID
    // Destroy previous instance if it exists
    if (window._pannellumViewer) {
      try { window._pannellumViewer.destroy(); } catch (_) {}
    }
    window._pannellumViewer = window.pannellum.viewer(container.id, {
      type:         'equirectangular',
      panorama:     photoUrl,
      autoLoad:     true,
      showControls: true,
      compass:      false,
      mouseZoom:    true,
      hfov:         100,
    });
  }

  // ── Reveal Screen ─────────────────────────────────────────────────────────

  /**
   * Render the post-round reveal screen.
   * Shows correct pin + all guess pins, player's own result.
   *
   * @param {Object} payload  S_ROUND_REVEAL payload from server
   */
  function renderReveal(payload) {
    _clearTimer();

    const {
      answer,
      scores,
      roundType,
      roundLabel,
      locationHint,
    } = payload;

    // Find this player's own score entry
    const myScore = scores.find((s) => s.playerId === state.playerId);

    // Round label + location
    els.revealRoundLabel.textContent = roundLabel ?? '';
    els.revealLocation.textContent   = locationHint ?? (roundType === ROUND_TYPE.WORLD ? 'Unknown location' : 'Campus location');
    els.revealDistance.textContent   = myScore
      ? `Your guess: ${myScore.distanceDisplay}`
      : 'You did not submit a guess this round';

    // Points + rank badges
    if (myScore) {
      els.revealPointsBadge.textContent = `+${myScore.points} pts`;
      els.revealRankBadge.textContent   = `Rank #${myScore.rank}`;
      els.revealPointsBadge.classList.remove('hidden');
      els.revealRankBadge.classList.remove('hidden');
    } else {
      els.revealPointsBadge.classList.add('hidden');
      els.revealRankBadge.classList.add('hidden');
    }

    // Map reveal
    if (roundType === ROUND_TYPE.WORLD) {
      els.revealWorldMap.style.display   = 'block';
      els.revealCampusWrap.style.display = 'none';
      WorldMapView.renderReveal('reveal-world-map', answer, scores, state.playerId);
    } else {
      els.revealWorldMap.style.display   = 'none';
      els.revealCampusWrap.style.display = 'block';
      CampusMapView.renderReveal(
        'reveal-campus-canvas',
        'reveal-campus-img',
        answer,
        scores,
        state.playerId
      );
    }

    showScreen('reveal');
  }

  // ── Leaderboard ────────────────────────────────────────────────────────────

  /**
   * Render the between-rounds leaderboard.
   *
   * @param {Object} payload  S_LEADERBOARD payload
   */
  function renderLeaderboard(payload) {
    const { players, roundIndex, totalRounds } = payload;

    els.lbRoundLabel.textContent =
      `After Round ${roundIndex + 1} of ${totalRounds}`;

    els.lbList.innerHTML = '';

    players.forEach((p, i) => {
      const isSelf   = p.id === state.playerId;
      const pos      = i + 1;
      const posClass = pos <= 3 ? `pos-${pos}` : '';

      const row = document.createElement('div');
      row.className = [
        'lb-row',
        isSelf               ? 'lb-row--self'    : '',
        pos === 1            ? 'lb-row--podium1'  : '',
        pos === 2            ? 'lb-row--podium2'  : '',
        pos === 3            ? 'lb-row--podium3'  : '',
      ].filter(Boolean).join(' ');

      row.innerHTML = `
        <span class="lb-pos ${posClass}">${_posIcon(pos)}</span>
        <span class="lb-nick ${p.connected ? '' : 'disconnected'}"
              title="${p.nickname}">
          ${_escHtml(p.nickname)}${isSelf ? ' <span class="badge badge-accent" style="font-size:0.6rem">you</span>' : ''}
        </span>
        <span class="lb-round-pts">${p.roundPoints != null ? `+${p.roundPoints}` : ''}</span>
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
    const { leaderboard, podium } = payload;

    els.gameoverPodium.innerHTML = '';

    leaderboard.slice(0, 10).forEach((p, i) => {
      const pos    = i + 1;
      const isSelf = p.id === state.playerId;

      const row = document.createElement('div');
      row.className = 'lb-row' + (isSelf ? ' lb-row--self' : '');
      row.style.cssText = 'display:grid;gap:0.75rem';
      row.innerHTML = `
        <span class="lb-pos ${pos <= 3 ? `pos-${pos}` : ''}">${_posIcon(pos)}</span>
        <span class="lb-nick">${_escHtml(p.nickname)}${isSelf ? ' <span class="badge badge-accent" style="font-size:0.6rem">you</span>' : ''}</span>
        <span></span>
        <span class="lb-total-pts t-mono">${p.score}</span>
      `;
      els.gameoverPodium.appendChild(row);
    });

    SocketClient.clearSession();
    showScreen('gameover');
  }

  // ── Socket Event Wiring ───────────────────────────────────────────────────

  function _wireEvents() {
    // ── Connection lifecycle ───────────────────────────────────────────────

    SocketClient.on('_disconnected', () => {
      toast('Connection lost — reconnecting…', 'error', 8000);
    });

    SocketClient.on('_reconnected', () => {
      toast('Reconnected!', 'success');
      // Re-join with saved session
      const saved = SocketClient.getSavedSession();
      if (saved.roomCode && state.nickname) {
        SocketClient.joinRoom(saved.roomCode, state.nickname);
      }
    });

    SocketClient.on('_reconnect_failed', () => {
      toast('Could not reconnect to server. Please refresh the page.', 'error', 0);
    });

    // ── S_ROOM_JOINED ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_JOINED, (payload) => {
      const { roomCode, playerId, players, reconnected, gameState: gs } = payload;

      state.roomCode = roomCode;
      state.playerId = playerId;
      state.role     = payload.role;

      SocketClient.setSession(roomCode, playerId);

      // Update waiting screen
      els.waitingNick.textContent  = state.nickname;
      els.waitingCount.textContent = `${players.length} player${players.length !== 1 ? 's' : ''} joined`;

      if (reconnected && gs && gs !== GAME_STATE.LOBBY) {
        toast('You\'ve been reconnected mid-game', 'success');
        // If game is active, they'll get next round-start/reveal event naturally
        // For now put them on the waiting screen until next broadcast
      }

      showScreen('waiting');
    });

    // ── S_ROOM_PLAYERS ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_PLAYERS, (payload) => {
      const { players } = payload;
      els.waitingCount.textContent =
        `${players.length} player${players.length !== 1 ? 's' : ''} joined`;
    });

    // ── S_GAME_COUNTDOWN ───────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_COUNTDOWN, (payload) => {
      const { countdownMs, totalRounds } = payload;
      state.totalRounds = totalRounds;

      showScreen('countdown');
      els.countdownLabel.textContent =
        `${totalRounds} rounds — good luck!`;

      // Animate 3-2-1
      const steps = Math.ceil(countdownMs / 1000);
      let current = steps;

      function tick() {
        els.countdownNumber.textContent = current;
        // Re-trigger the CSS pop animation
        els.countdownNumber.style.animation = 'none';
        void els.countdownNumber.offsetWidth; // force reflow
        els.countdownNumber.style.animation = '';

        current--;
        if (current > 0) {
          setTimeout(tick, 1000);
        }
      }
      tick();
    });

    // ── S_ROUND_START ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_START, (payload) => {
      const { round, roundIndex, totalRounds, durationMs, endsAt } = payload;
      // Prefetch sequence data immediately so arrows appear faster
  if (round.type === ROUND_TYPE.WORLD && round.panoId) {
    WorldMapView.prefetchSequence(round.panoId);
  }
      setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
      showScreen('round');

      // Multiple resize attempts at increasing delays
      // because the browser may still be painting the layout
      // when the first one fires
      [100, 300, 600].forEach((delay) => {
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          if (round.type === ROUND_TYPE.WORLD && WorldMapView.resizeViewer) {
            WorldMapView.resizeViewer();
          }
        }, delay);
      });
    });

    // ── S_ROUND_TICK ───────────────────────────────────────────────────────
    // Server sends this every second as an authoritative time source.
    // We use it to correct any drift in our local timer.

    SocketClient.on(EVENTS.S_ROUND_TICK, (payload) => {
      const { remainingMs } = payload;
      // Resync local endsAt to prevent accumulated drift
      state.roundEndsAt = Date.now() + remainingMs;
    });

    // ── S_GUESS_COUNT ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_COUNT, (payload) => {
      const { guessCount, totalPlayers } = payload;
      const allIn = guessCount >= totalPlayers;
      els.guessPill.textContent = `${guessCount} / ${totalPlayers}`;
      els.guessPill.classList.toggle('all-guessed', allIn);
    });

    // ── S_GUESS_ACK ────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_ACK, (payload) => {
      if (!payload.accepted) {
        toast('Guess already recorded — first pin counts!', 'default');
      }
    });

    // ── S_ROUND_REVEAL ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_REVEAL, (payload) => {
      renderReveal(payload);
    });

    // ── S_LEADERBOARD ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_LEADERBOARD, (payload) => {
      renderLeaderboard(payload);
    });

    // ── S_GAME_OVER ────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_OVER, (payload) => {
      renderGameOver(payload);
    });

    // ── S_ERROR ────────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ERROR, (payload) => {
      const { code, message } = payload;
      console.error('[game error]', code, message);

      if (code === 'ROOM_NOT_FOUND') {
        els.joinError.textContent = 'Room not found. Check the code and try again.';
        els.joinError.classList.remove('hidden');
        showScreen('lobby');
        return;
      }

      if (code === 'NICKNAME_TAKEN') {
        els.joinError.textContent = 'That nickname is already taken. Choose another.';
        els.joinError.classList.remove('hidden');
        showScreen('lobby');
        return;
      }

      if (code === 'ROOM_ALREADY_STARTED') {
        els.joinError.textContent = 'The game has already started — you cannot join now.';
        els.joinError.classList.remove('hidden');
        showScreen('lobby');
        return;
      }

      if (code === 'HOST_DISCONNECTED') {
        toast('Host disconnected — waiting for them to return…', 'error', 8000);
        return;
      }

      toast(message ?? 'Something went wrong', 'error');
    });
  }

  // ── DOM Event Listeners ───────────────────────────────────────────────────

  function _wireDom() {

    // ── Join form ──────────────────────────────────────────────────────────

    function _attemptJoin() {
      const code = els.inputCode.value.trim().toUpperCase();
      const nick = els.inputNick.value.trim();

      els.joinError.classList.add('hidden');
      els.joinError.textContent = '';

      if (code.length !== 5) {
        els.joinError.textContent = 'Room code must be 5 characters.';
        els.joinError.classList.remove('hidden');
        return;
      }
      if (nick.length < 2 || nick.length > 20) {
        els.joinError.textContent = 'Nickname must be 2–20 characters.';
        els.joinError.classList.remove('hidden');
        return;
      }

      state.nickname = nick;
      els.btnJoin.disabled = true;
      els.btnJoin.textContent = 'Joining…';

      SocketClient.joinRoom(code, nick);

      // Re-enable after timeout in case of error
      setTimeout(() => {
        els.btnJoin.disabled    = false;
        els.btnJoin.textContent = 'Join Game';
      }, 5000);
    }

    els.btnJoin.addEventListener('click', _attemptJoin);

    // Allow pressing Enter in either input field
    [els.inputCode, els.inputNick].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _attemptJoin();
      });
    });

    // Auto-uppercase room code as typed
    els.inputCode.addEventListener('input', () => {
      const pos = els.inputCode.selectionStart;
      els.inputCode.value = els.inputCode.value.toUpperCase();
      els.inputCode.setSelectionRange(pos, pos);
    });

    // ── Submit guess button ────────────────────────────────────────────────

    els.btnSubmit.addEventListener('click', _submitGuess);

    // ── Play again ─────────────────────────────────────────────────────────

    els.btnPlayAgain.addEventListener('click', () => {
      state.nickname   = null;
      state.roomCode   = null;
      state.playerId   = null;
      els.inputCode.value = '';
      els.inputNick.value = '';
      els.joinError.classList.add('hidden');
      els.btnJoin.disabled    = false;
      els.btnJoin.textContent = 'Join Game';
      showScreen('lobby');
    });
  }

  // ── Reconnection on page load ─────────────────────────────────────────────

  /**
   * On page load, check sessionStorage for a saved session.
   * If found, prompt the player to confirm their nickname and attempt reconnect.
   * This handles the "accidentally refreshed the tab" case.
   */
  function _checkSavedSession() {
    const saved = SocketClient.getSavedSession();
    if (saved.roomCode) {
      // Pre-fill the join form with saved values so the user
      // just has to press Join to reconnect
      els.inputCode.value = saved.roomCode;
      // We don't restore nickname from storage — the player types it again
      // This is intentional: it's the verification mechanism for reconnection
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Return a display string for a leaderboard position.
   * Top 3 get medal emoji; rest get their number.
   *
   * @param {number} pos  1-based
   * @returns {string}
   */
  function _posIcon(pos) {
    if (pos === 1) return '🥇';
    if (pos === 2) return '🥈';
    if (pos === 3) return '🥉';
    return String(pos);
  }

  /**
   * Escape HTML special characters to prevent XSS from nicknames.
   * Nicknames come from other users, so they must be escaped before
   * injecting into innerHTML.
   *
   * @param {string} str
   * @returns {string}
   */
  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Connect socket
    SocketClient.connect();

    // Wire all events and DOM listeners
    _wireEvents();
    _wireDom();

    // Check for saved session (page refresh recovery)
    _checkSavedSession();

    // Start on lobby screen
    showScreen('lobby');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return { init, toast, onPinPlaced };

})();

// Boot
document.addEventListener('DOMContentLoaded', () => PlayerApp.init());