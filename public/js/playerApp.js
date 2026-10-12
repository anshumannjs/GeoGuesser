/**
 * playerApp.js
 * Main orchestrator for the player view.
 *
 * Key changes from previous version:
 *  - Auto-rejoin on page load via C_REJOIN (no form re-entry needed)
 *  - Nickname saved to sessionStorage so it survives refresh
 *  - S_GAME_STATE_SYNC handler snaps player to correct screen mid-game
 *  - Timer is purely driven by S_ROUND_TICK (no local drift)
 */

/* global SocketClient, EVENTS, GAME_STATE, ROUND_TYPE, ROLE, SESSION_KEYS, WorldMapView, CampusMapView */

const PlayerApp = (() => {

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    nickname:        null,
    roomCode:        null,
    playerId:        null,
    role:            null,
    currentRound:    null,
    roundIndex:      -1,
    totalRounds:     0,
    guessSubmitted:  false,
    pendingCoord:    null,
    timerInterval:   null,
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
    inputCode:         $('input-code'),
    inputNick:         $('input-nick'),
    btnJoin:           $('btn-join'),
    joinError:         $('join-error'),

    // Waiting
    waitingCount:      $('waiting-player-count'),
    waitingNick:       $('waiting-nick-badge'),

    // Countdown
    countdownNumber:   $('countdown-number'),
    countdownLabel:    $('countdown-label'),

    // Round
    roundChip:         $('round-chip'),
    timerDigit:        $('timer-digit'),
    timerBar:          $('timer-bar'),
    guessStatus:       $('guess-status'),
    guessPill:         $('guess-pill'),
    btnSubmit:         $('btn-submit-guess'),
    submittedOverlay:  $('submitted-overlay'),
    worldMap:          $('world-map'),
    campusMapWrap:     $('campus-map-wrap'),

    // Reveal
    revealRoundLabel:   $('reveal-round-label'),
    revealLocation:     $('reveal-location'),
    revealDistance:     $('reveal-distance'),
    revealPointsBadge:  $('reveal-points-badge'),
    revealRankBadge:    $('reveal-rank-badge'),
    revealWorldMap:     $('reveal-world-map'),
    revealCampusWrap:   $('reveal-campus-wrap'),
    revealCampusImg:    $('reveal-campus-img'),
    revealCampusCanvas: $('reveal-campus-canvas'),

    // Leaderboard
    lbList:            $('lb-list'),
    lbRoundLabel:      $('lb-round-label'),

    // Game over
    gameoverPodium:    $('gameover-podium'),
    btnPlayAgain:      $('btn-play-again'),

    // Toast
    toastContainer:    $('toast-container'),
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
   * @param {string}  message
   * @param {'default'|'error'|'success'} [type='default']
   * @param {number}  [durationMs=3000]
   */
  function toast(message, type = 'default', durationMs = 3000) {
    const el = document.createElement('div');
    el.className = `toast${
      type === 'error'   ? ' toast-error'   :
      type === 'success' ? ' toast-success' : ''}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  /**
   * Start the visual timer.
   * The local interval only renders — S_ROUND_TICK corrects drift every second.
   *
   * @param {number} endsAt      Server Unix ms timestamp
   * @param {number} durationMs  Total round duration for bar scaling
   */
  function startTimer(endsAt, durationMs) {
    _clearTimer();
    state.roundEndsAt    = endsAt;
    state.roundDurationMs = durationMs;

    function tick() {
      const remaining = Math.max(0, state.roundEndsAt - Date.now());
      const secs      = Math.ceil(remaining / 1000);
      const progress  = remaining / state.roundDurationMs;

      els.timerDigit.textContent       = secs;
      els.timerBar.style.transform     = `scaleX(${progress})`;

      const isWarn   = secs <= 10 && secs > 5;
      const isDanger = secs <= 5;

      [els.timerDigit, els.timerBar].forEach((el) => {
        el.classList.toggle('warn',   isWarn);
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

  // ── Guess Coordination ────────────────────────────────────────────────────

  /**
   * Called by WorldMapView or CampusMapView when player clicks a location.
   *
   * @param {{ lat: number, lng: number }|{ x: number, y: number }} coord
   */
  function onPinPlaced(coord) {
    if (state.guessSubmitted) return;
    state.pendingCoord = coord;
    els.btnSubmit.disabled          = false;
    els.guessStatus.textContent     = 'Pin placed — confirm when ready';
    els.guessStatus.style.color     = 'var(--accent)';
  }

  function _submitGuess() {
    if (!state.pendingCoord || state.guessSubmitted) return;
    state.guessSubmitted = true;
    SocketClient.submitGuess(state.roundIndex, state.pendingCoord);
    els.btnSubmit.disabled          = true;
    els.submittedOverlay.style.display = 'flex';
    els.guessStatus.textContent     = 'Guess locked in!';
    els.guessStatus.style.color     = 'var(--text-secondary)';
  }

  // ── Round Setup ───────────────────────────────────────────────────────────

  /**
   * @param {Object} round
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

    const isWorld = round.type === ROUND_TYPE.WORLD;
    els.roundChip.textContent = isWorld ? 'World' : 'Campus';
    els.roundChip.className   = `round-chip ${isWorld ? 'world' : 'campus'}`;

    els.btnSubmit.disabled             = true;
    els.submittedOverlay.style.display = 'none';
    els.guessStatus.textContent        = 'Drop a pin on the map';
    els.guessStatus.style.color        = 'var(--text-secondary)';
    els.guessPill.textContent          = '— / —';
    els.guessPill.classList.remove('all-guessed');

    if (isWorld) {
      els.worldMap.style.display      = 'block';
      els.campusMapWrap.style.display = 'none';
      WorldMapView.init('world-map', onPinPlaced);
    } else {
      els.worldMap.style.display      = 'none';
      els.campusMapWrap.style.display = 'flex';
      CampusMapView.init('campus-canvas', 'campus-map-img', round.photoUrl, onPinPlaced);
    }

    _initViewer(round);
    startTimer(endsAt, durationMs);
  }

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

  function _initPannellum(container, photoUrl) {
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

  // ── State Sync (mid-game rejoin) ──────────────────────────────────────────

  /**
   * Called when S_GAME_STATE_SYNC is received after a rejoin.
   * Snaps the player to whatever screen matches the current game state
   * without waiting for the next server broadcast.
   *
   * @param {Object} sync  S_GAME_STATE_SYNC payload
   */
  function applyStateSync(sync) {
    const { gameState: gs, currentRoundPayload, players } = sync;

    switch (gs) {
      case GAME_STATE.LOBBY:
      case GAME_STATE.ROUND_COUNTDOWN:
        showScreen('waiting');
        break;

      case GAME_STATE.ROUND_ACTIVE: {
        if (!currentRoundPayload) { showScreen('waiting'); break; }
        const { round, roundIndex, totalRounds, durationMs, endsAt } = currentRoundPayload;
        // Only set up map/viewer if endsAt is still in the future
        if (endsAt && endsAt > Date.now()) {
          setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
          showScreen('round');
        } else {
          // Round already over by the time we connected — wait for reveal
          showScreen('waiting');
        }
        break;
      }

      case GAME_STATE.ROUND_REVEAL:
        // Reveal is already in progress — wait for next S_ROUND_REVEAL
        // or S_LEADERBOARD broadcast
        showScreen('waiting');
        break;

      case GAME_STATE.LEADERBOARD:
        if (players) renderLeaderboard({ players, roundIndex: sync.roundIndex, totalRounds: sync.totalRounds });
        break;

      case GAME_STATE.GAME_OVER:
        // Show game over with whatever we have
        showScreen('gameover');
        break;

      default:
        showScreen('waiting');
    }
  }

  // ── Reveal Screen ─────────────────────────────────────────────────────────

  /**
   * @param {Object} payload  S_ROUND_REVEAL payload
   */
  function renderReveal(payload) {
    _clearTimer();

    const { answer, scores, roundType, roundLabel, locationHint } = payload;

    const myScore = scores.find((s) => s.playerId === state.playerId);

    els.revealRoundLabel.textContent = roundLabel ?? '';
    els.revealLocation.textContent   = locationHint
      ?? (roundType === ROUND_TYPE.WORLD ? 'Unknown location' : 'Campus location');
    els.revealDistance.textContent   = myScore
      ? `Your guess: ${myScore.distanceDisplay}`
      : 'You did not submit a guess this round';

    if (myScore) {
      els.revealPointsBadge.textContent = `+${myScore.points} pts`;
      els.revealRankBadge.textContent   = `Rank #${myScore.rank}`;
      els.revealPointsBadge.classList.remove('hidden');
      els.revealRankBadge.classList.remove('hidden');
    } else {
      els.revealPointsBadge.classList.add('hidden');
      els.revealRankBadge.classList.add('hidden');
    }

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
   * @param {Object} payload  S_LEADERBOARD payload
   */
  function renderLeaderboard(payload) {
    const { players, roundIndex, totalRounds } = payload;

    els.lbRoundLabel.textContent =
      `After Round ${roundIndex + 1} of ${totalRounds}`;

    els.lbList.innerHTML = '';

    players.forEach((p, i) => {
      const isSelf = p.id === state.playerId;
      const pos    = i + 1;

      const row = document.createElement('div');
      row.className = [
        'lb-row',
        isSelf  ? 'lb-row--self'   : '',
        pos === 1 ? 'lb-row--podium1' : '',
        pos === 2 ? 'lb-row--podium2' : '',
        pos === 3 ? 'lb-row--podium3' : '',
      ].filter(Boolean).join(' ');

      row.innerHTML = `
        <span class="lb-pos ${pos <= 3 ? `pos-${pos}` : ''}">${_posIcon(pos)}</span>
        <span class="lb-nick ${p.connected ? '' : 'disconnected'}" title="${_escHtml(p.nickname)}">
          ${_escHtml(p.nickname)}
          ${isSelf ? '<span class="badge badge-accent" style="font-size:0.6rem">you</span>' : ''}
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
   * @param {Object} payload  S_GAME_OVER payload
   */
  function renderGameOver(payload) {
    _clearTimer();
    const { leaderboard } = payload;

    els.gameoverPodium.innerHTML = '';

    leaderboard.slice(0, 10).forEach((p, i) => {
      const pos    = i + 1;
      const isSelf = p.id === state.playerId;

      const row = document.createElement('div');
      row.className = 'lb-row' + (isSelf ? ' lb-row--self' : '');
      row.style.cssText = 'display:grid;gap:0.75rem';
      row.innerHTML = `
        <span class="lb-pos ${pos <= 3 ? `pos-${pos}` : ''}">${_posIcon(pos)}</span>
        <span class="lb-nick">
          ${_escHtml(p.nickname)}
          ${isSelf ? '<span class="badge badge-accent" style="font-size:0.6rem">you</span>' : ''}
        </span>
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

    // ── Connection lifecycle ─────────────────────────────────────────────

    SocketClient.on('_connected', () => {
      // On every connection (including reconnects), attempt auto-rejoin first
      const saved = SocketClient.getSavedSession();
      if (saved.playerId && saved.nickname) {
        // Restore in-memory state from sessionStorage
        state.nickname  = saved.nickname;
        state.roomCode  = saved.roomCode;
        state.playerId  = saved.playerId;
        state.role      = saved.role;

        SocketClient.rejoin({
          playerId: saved.playerId,
          nickname: saved.nickname,
          // Players never have adminToken — host uses hostApp.js
        });
      }
      // If no saved session, just sit on lobby screen waiting for user input
    });

    SocketClient.on('_disconnected', () => {
      toast('Connection lost — reconnecting…', 'error', 8000);
    });

    SocketClient.on('_reconnected', () => {
      toast('Reconnected!', 'success');
      // _connected will fire after reconnect and handle the rejoin automatically
    });

    SocketClient.on('_reconnect_failed', () => {
      toast('Could not reconnect. Please refresh the page.', 'error', 0);
    });

    // ── S_ROOM_JOINED ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_JOINED, (payload) => {
      const { roomCode, playerId, players, reconnected, gameState: gs } = payload;

      state.roomCode = roomCode;
      state.playerId = playerId;
      state.role     = payload.role;

      // Persist full session so page refresh works seamlessly
      SocketClient.setSession({
        roomCode,
        playerId,
        nickname: state.nickname,
        role:     payload.role,
      });

      els.waitingNick.textContent  = state.nickname;
      els.waitingCount.textContent =
        `${players.filter(p => p.role !== 'host').length} player(s) joined`;

      if (reconnected && gs && gs !== GAME_STATE.LOBBY) {
        toast('Reconnected to game in progress', 'success');
        // S_GAME_STATE_SYNC will arrive immediately after and snap to correct screen
        showScreen('waiting'); // temporary holding screen
      } else {
        showScreen('waiting');
      }
    });

    // ── S_GAME_STATE_SYNC ────────────────────────────────────────────────
    // Received after C_REJOIN — snaps player to current game screen

    SocketClient.on(EVENTS.S_GAME_STATE_SYNC, (payload) => {
      applyStateSync(payload);
    });

    // ── S_ROOM_PLAYERS ───────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_PLAYERS, (payload) => {
      const nonHost = payload.players.filter(p => p.role !== 'host');
      els.waitingCount.textContent = `${nonHost.length} player(s) joined`;
    });

    // ── S_GAME_COUNTDOWN ─────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_COUNTDOWN, (payload) => {
      const { countdownMs, totalRounds } = payload;
      state.totalRounds = totalRounds;

      showScreen('countdown');
      els.countdownLabel.textContent = `${totalRounds} rounds — good luck!`;

      const steps = Math.ceil(countdownMs / 1000);
      let current = steps;

      function tick() {
        els.countdownNumber.textContent     = current;
        els.countdownNumber.style.animation = 'none';
        void els.countdownNumber.offsetWidth;
        els.countdownNumber.style.animation = '';
        current--;
        if (current > 0) setTimeout(tick, 1000);
      }
      tick();
    });

    // ── S_ROUND_START ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_START, (payload) => {
      const { round, roundIndex, totalRounds, durationMs, endsAt } = payload;

      if (round.type === ROUND_TYPE.WORLD && round.panoId) {
        WorldMapView.prefetchSequence(round.panoId);
      }

      setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
      showScreen('round');

      // Staggered resize to fix Mapillary/Leaflet zero-size init
      [100, 300, 600].forEach((delay) => {
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          if (round.type === ROUND_TYPE.WORLD && WorldMapView.resizeViewer) {
            WorldMapView.resizeViewer();
          }
        }, delay);
      });
    });

    // ── S_ROUND_TICK — server clock drives the timer display ─────────────

    SocketClient.on(EVENTS.S_ROUND_TICK, ({ remainingMs }) => {
      // Overwrite local endsAt with server's authoritative value
      state.roundEndsAt = Date.now() + remainingMs;
    });

    // ── S_GUESS_COUNT ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_COUNT, ({ guessCount, totalPlayers }) => {
      els.guessPill.textContent = `${guessCount} / ${totalPlayers}`;
      els.guessPill.classList.toggle('all-guessed', guessCount >= totalPlayers);
    });

    // ── S_GUESS_ACK ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_ACK, (payload) => {
      if (!payload.accepted) {
        toast('Guess already recorded — first pin counts!');
      }
    });

    // ── S_ROUND_REVEAL ───────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_REVEAL, (payload) => {
      renderReveal(payload);
    });

    // ── S_LEADERBOARD ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_LEADERBOARD, (payload) => {
      if (payload.resumed) toast('Game resumed from last checkpoint', 'success');
      renderLeaderboard(payload);
    });

    // ── S_GAME_OVER ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_OVER, (payload) => {
      renderGameOver(payload);
    });

    // ── S_ERROR ──────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ERROR, (payload) => {
      const { code, message } = payload;
      console.error('[player error]', code, message);

      if (code === 'ROOM_NOT_FOUND' || code === 'PLAYER_NOT_FOUND') {
        // Saved session is stale — clear it and show join form
        SocketClient.clearSession();
        els.joinError.textContent = 'Session expired. Please join again.';
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
        els.joinError.textContent = 'Game has already started. If you were playing, use your saved session.';
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

      state.nickname           = nick;
      els.btnJoin.disabled     = true;
      els.btnJoin.textContent  = 'Joining…';

      SocketClient.joinRoom(code, nick);

      setTimeout(() => {
        els.btnJoin.disabled    = false;
        els.btnJoin.textContent = 'Join Game';
      }, 5000);
    }

    els.btnJoin.addEventListener('click', _attemptJoin);

    [els.inputCode, els.inputNick].forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') _attemptJoin();
      });
    });

    els.inputCode.addEventListener('input', () => {
      const pos = els.inputCode.selectionStart;
      els.inputCode.value = els.inputCode.value.toUpperCase();
      els.inputCode.setSelectionRange(pos, pos);
    });

    els.btnSubmit.addEventListener('click', _submitGuess);

    els.btnPlayAgain.addEventListener('click', () => {
      SocketClient.clearSession();
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

  // ── Page Load: auto-rejoin or pre-fill lobby ──────────────────────────────

  /**
   * Check sessionStorage before showing any screen.
   * If a valid session exists, pre-fill the join form.
   * The actual rejoin fires in the _connected handler once the socket connects.
   */
  function _checkSavedSession() {
    const saved = SocketClient.getSavedSession();

    if (saved.roomCode) {
      // Pre-fill the form in case auto-rejoin fails
      // (stale session, game over, etc)
      els.inputCode.value = saved.roomCode;
      if (saved.nickname) {
        els.inputNick.value = saved.nickname;
      }
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  function _posIcon(pos) {
    if (pos === 1) return '🥇';
    if (pos === 2) return '🥈';
    if (pos === 3) return '🥉';
    return String(pos);
  }

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
    SocketClient.connect();
    _wireEvents();
    _wireDom();
    _checkSavedSession();
    showScreen('lobby');
  }

  return { init, toast, onPinPlaced };

})();

document.addEventListener('DOMContentLoaded', () => PlayerApp.init());