/**
 * hostApp.js
 * Orchestrator for the host/projector display.
 *
 * Key changes from previous version:
 *  - Password prompt screen added (C_ADMIN_AUTH flow)
 *  - Auto-rejoin via adminToken stored in sessionStorage
 *  - C_HOST_END_ROUND replaces C_HOST_NEXT for ending active rounds
 *  - S_GAME_STATE_SYNC snaps host display to current game screen on rejoin
 *  - Single _connected handler — no duplicate room creation on refresh
 */

/* global SocketClient, EVENTS, GAME_STATE, ROUND_TYPE, ROLE, SESSION_KEYS, WorldMapView, CampusMapView */

const HostApp = (() => {

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    roomCode:        null,
    playerId:        null,
    totalRounds:     0,
    roundIndex:      -1,
    currentRound:    null,
    timerInterval:   null,
    roundEndsAt:     0,
    roundDurationMs: 0,
    totalPlayers:    0,
  };

  // ── DOM Refs ───────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  const screens = {
    auth:        $('screen-auth'),        // password prompt — new screen
    lobby:       $('screen-lobby'),
    countdown:   $('screen-countdown'),
    round:       $('screen-round'),
    reveal:      $('screen-reveal'),
    leaderboard: $('screen-leaderboard'),
    gameover:    $('screen-gameover'),
  };

  const els = {
    // Auth screen
    inputPassword:    $('input-password'),
    inputHostNick:    $('input-host-nick'),
    btnAuth:          $('btn-auth'),
    authError:        $('auth-error'),

    // Lobby
    lobbyCode:        $('lobby-code'),
    lobbyJoinUrl:     $('lobby-join-url'),
    lobbyPlayerGrid:  $('lobby-player-grid'),
    lobbyPlayerCount: $('lobby-player-count'),
    btnStart:         $('btn-start'),

    // Countdown
    countdownNumber:  $('host-countdown-number'),
    countdownLabel:   $('host-countdown-label'),

    // Round
    panoRoundLabel:       $('pano-round-label'),
    panoRoundTitle:       $('pano-round-title'),
    hostRoundChip:        $('host-round-chip'),
    hostTimerDigit:       $('host-timer-digit'),
    hostTimerBar:         $('host-timer-bar'),
    hostGuessCount:       $('host-guess-count'),
    hostGuessTotal:       $('host-guess-total'),
    hostGuessBar:         $('host-guess-bar'),
    hostWorldMiniMap:     $('host-world-mini-map'),
    hostCampusMiniWrap:   $('host-campus-mini-wrap'),
    hostCampusMiniImg:    $('host-campus-mini-img'),
    hostCampusMiniCanvas: $('host-campus-mini-canvas'),
    btnEndRoundEarly:     $('btn-end-round-early'),

    // Reveal
    revealRoundLabel:       $('reveal-round-label'),
    revealLocationLabel:    $('reveal-location-label'),
    revealNextBtn:          $('reveal-next-btn'),
    revealPodiumList:       $('reveal-podium-list'),
    revealStats:            $('reveal-stats'),
    hostRevealWorldMap:     $('host-reveal-world-map'),
    hostRevealCampusWrap:   $('host-reveal-campus-wrap'),
    hostRevealCampusImg:    $('host-reveal-campus-img'),
    hostRevealCampusCanvas: $('host-reveal-campus-canvas'),

    // Leaderboard
    lbTitle:      $('lb-title'),
    lbSubtitle:   $('lb-subtitle'),
    lbList:       $('host-lb-list'),
    lbNextBtn:    $('lb-next-btn'),

    // Game Over
    gameoverPodium: $('gameover-podium-wrap'),

    // Toast
    toastContainer: $('toast-container'),
  };

  // ── Screen Manager ─────────────────────────────────────────────────────────

  /** @param {keyof typeof screens} name */
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.style.display = key === name ? 'flex' : 'none';
    });
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  function toast(message, type = 'default', durationMs = 3500) {
    const el = document.createElement('div');
    el.className = `toast${
      type === 'error'   ? ' toast-error'   :
      type === 'success' ? ' toast-success' : ''}`;
    el.textContent = message;
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  // ── Wake Lock ──────────────────────────────────────────────────────────────

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

  // ── Timer ──────────────────────────────────────────────────────────────────

  function startTimer(endsAt, durationMs) {
    _clearTimer();
    state.roundEndsAt     = endsAt;
    state.roundDurationMs = durationMs;

    function tick() {
      const remaining = Math.max(0, state.roundEndsAt - Date.now());
      const secs      = Math.ceil(remaining / 1000);
      const progress  = remaining / state.roundDurationMs;

      els.hostTimerDigit.textContent   = secs;
      els.hostTimerBar.style.transform = `scaleX(${progress})`;

      const isWarn   = secs <= 10 && secs > 5;
      const isDanger = secs <= 5;

      [els.hostTimerDigit, els.hostTimerBar].forEach((el) => {
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

  // ── Lobby ──────────────────────────────────────────────────────────────────

  function updateLobbyPlayers(players) {
    const nonHost = players.filter((p) => p.role !== ROLE.HOST);
    els.lobbyPlayerCount.textContent =
      `${nonHost.length} player${nonHost.length !== 1 ? 's' : ''} joined`;

    els.lobbyPlayerGrid.innerHTML = '';
    nonHost.forEach((p) => {
      const chip = document.createElement('div');
      chip.className   = 'lobby-player-chip';
      chip.textContent = _escHtml(p.nickname);
      els.lobbyPlayerGrid.appendChild(chip);
    });
  }

  // ── Round Setup ───────────────────────────────────────────────────────────

  function setupRound(round, roundIndex, totalRounds, durationMs, endsAt) {
    state.currentRound = round;
    state.roundIndex   = roundIndex;
    state.totalRounds  = totalRounds;

    const isWorld = round.type === ROUND_TYPE.WORLD;

    els.panoRoundLabel.textContent  = `Round ${roundIndex + 1} of ${totalRounds}`;
    els.panoRoundTitle.textContent  = round.label ?? '';
    els.hostRoundChip.textContent   = isWorld ? 'World' : 'Campus';
    els.hostRoundChip.className     = `round-chip ${isWorld ? 'world' : 'campus'}`;

    _updateGuessCounter(0, state.totalPlayers);
    _initViewer(round);

    if (isWorld) {
      els.hostWorldMiniMap.style.display   = 'block';
      els.hostCampusMiniWrap.style.display = 'none';
      WorldMapView.init('host-world-mini-map', null);
    } else {
      els.hostWorldMiniMap.style.display   = 'none';
      els.hostCampusMiniWrap.style.display = 'flex';
      els.hostCampusMiniImg.src            = round.photoUrl ?? '';
      els.hostCampusMiniImg.onload         = _syncMiniCanvas;
      if (els.hostCampusMiniImg.complete && els.hostCampusMiniImg.naturalWidth > 0) {
        _syncMiniCanvas();
      }
    }

    startTimer(endsAt, durationMs);
  }

  function _syncMiniCanvas() {
    const img    = els.hostCampusMiniImg;
    const canvas = els.hostCampusMiniCanvas;
    const rect   = img.getBoundingClientRect();
    if (rect.width > 0) {
      canvas.width  = rect.width;
      canvas.height = rect.height;
    }
  }

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
        try { window._hostPannellumViewer.destroy(); } catch (_) {}
      }
      window._hostPannellumViewer = window.pannellum.viewer('host-pannellum-viewer', {
        type:         'equirectangular',
        panorama:     round.photoUrl,
        autoLoad:     true,
        showControls: false,
        compass:      false,
        mouseZoom:    false,
        hfov:         100,
        autoRotate:   -2,
      });
    }
  }

  // ── Guess Counter ──────────────────────────────────────────────────────────

  function _updateGuessCounter(count, total) {
    els.hostGuessCount.textContent = count;
    els.hostGuessTotal.textContent = `/ ${total || '—'}`;
    const pct = total > 0 ? (count / total) * 100 : 0;
    els.hostGuessBar.style.width = `${pct}%`;
  }

  // ── State Sync (mid-game rejoin) ──────────────────────────────────────────

  /**
   * Snap the host display to the current game screen on rejoin.
   * Called when S_GAME_STATE_SYNC is received.
   *
   * @param {Object} sync  S_GAME_STATE_SYNC payload
   */
  function applyStateSync(sync) {
    const { gameState: gs, currentRoundPayload, players } = sync;

    // Update nickname cache from player list
    (players ?? []).forEach((p) => _nicknameCache.set(p.id, p.nickname));

    switch (gs) {
      case GAME_STATE.LOBBY:
        updateLobbyPlayers(players ?? []);
        showScreen('lobby');
        break;

      case GAME_STATE.ROUND_COUNTDOWN:
        showScreen('countdown');
        els.countdownNumber.textContent = '…';
        els.countdownLabel.textContent  = 'Round starting…';
        break;

      case GAME_STATE.ROUND_ACTIVE: {
        if (!currentRoundPayload) { showScreen('countdown'); break; }
        const { round, roundIndex, totalRounds, durationMs, endsAt } = currentRoundPayload;
        if (endsAt && endsAt > Date.now()) {
          setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
          showScreen('round');
        } else {
          showScreen('countdown');
        }
        break;
      }

      case GAME_STATE.ROUND_REVEAL:
        // Reveal in progress — wait for next S_ROUND_REVEAL broadcast
        showScreen('countdown');
        els.countdownLabel.textContent = 'Resuming…';
        break;

      case GAME_STATE.LEADERBOARD:
        if (players) {
          renderLeaderboard({
            players,
            roundIndex:  sync.roundIndex,
            totalRounds: sync.totalRounds,
            isLastRound: sync.roundIndex >= sync.totalRounds - 1,
          });
        }
        break;

      case GAME_STATE.GAME_OVER:
        showScreen('gameover');
        break;

      default:
        showScreen('lobby');
    }
  }

  // ── Reveal ─────────────────────────────────────────────────────────────────

  function renderReveal(payload) {
    _clearTimer();

    const { answer, scores, roundType, roundLabel, locationHint, noGuessList } = payload;

    els.revealRoundLabel.textContent    = roundLabel ?? '';
    els.revealLocationLabel.textContent = locationHint ?? '—';

    _renderRevealPodium(scores);
    _renderRevealStats(scores, noGuessList);

    if (roundType === ROUND_TYPE.WORLD) {
      els.hostRevealWorldMap.style.display   = 'block';
      els.hostRevealCampusWrap.style.display = 'none';
      WorldMapView.renderReveal('host-reveal-world-map', answer, scores, null);
    } else {
      els.hostRevealWorldMap.style.display   = 'none';
      els.hostRevealCampusWrap.style.display = 'flex';
      els.hostRevealCampusImg.src            = state.currentRound?.photoUrl ?? '';
      CampusMapView.renderReveal(
        'host-reveal-campus-canvas',
        'host-reveal-campus-img',
        answer,
        scores,
        null
      );
    }

    showScreen('reveal');
  }

  function _renderRevealPodium(scores) {
    els.revealPodiumList.innerHTML = '';
    const top    = [...scores].sort((a, b) => a.rank - b.rank).slice(0, 3);
    const medals = ['🥇', '🥈', '🥉'];

    top.forEach((entry, i) => {
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

  function _renderRevealStats(scores, noGuessList) {
    els.revealStats.innerHTML = '';

    const bestDist = scores.length > 0
      ? scores.find((s) => s.rank === 1)?.distanceDisplay ?? '—'
      : '—';
    const avgNorm  = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.distanceNorm, 0) / scores.length
      : null;

    const stats = [
      { label: 'Guesses submitted', value: `${scores.length}`           },
      { label: 'No guess',          value: `${noGuessList?.length ?? 0}`},
      { label: 'Best guess',        value: bestDist                      },
    ];

    if (avgNorm !== null) {
      stats.push({ label: 'Avg accuracy', value: `${Math.round((1 - avgNorm) * 100)}%` });
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

  function renderLeaderboard(payload) {
    const { players, roundIndex, totalRounds, isLastRound } = payload;

    els.lbTitle.textContent    = isLastRound ? 'Final Standings' : 'Leaderboard';
    els.lbSubtitle.textContent = `After Round ${roundIndex + 1} of ${totalRounds}`;
    els.lbNextBtn.textContent  = isLastRound ? 'See Final Results →' : 'Next Round →';

    players.forEach((p) => _nicknameCache.set(p.id, p.nickname));

    els.lbList.innerHTML = '';
    players.forEach((p, i) => {
      const pos = i + 1;
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

  function renderGameOver(payload) {
    _clearTimer();
    const { leaderboard } = payload;
    const medals = ['🥇', '🥈', '🥉'];

    els.gameoverPodium.innerHTML = '';
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

  const _nicknameCache = new Map();

  function _getNickname(playerId) {
    return _nicknameCache.get(playerId) ?? playerId.slice(0, 8);
  }

  // ── Socket Event Wiring ────────────────────────────────────────────────────

  function _wireEvents() {

    // ── _connected ───────────────────────────────────────────────────────
    // Single handler for both first connect and reconnects.
    // Checks sessionStorage first — if adminToken exists, rejoin silently.
    // If not, show the password prompt screen.

    SocketClient.on('_connected', async () => {
      await _acquireWakeLock();

      const saved = SocketClient.getSavedSession();

      if (saved.adminToken && saved.playerId && saved.nickname) {
        // Silent rejoin — host had a valid session
        console.info('[host] Found saved session — rejoining silently');
        SocketClient.rejoin({
          playerId:   saved.playerId,
          nickname:   saved.nickname,
          adminToken: saved.adminToken,
        });
      } else {
        // No session — show password prompt
        showScreen('auth');
      }
    });

    SocketClient.on('_disconnected', () => {
      toast('Connection lost — reconnecting…', 'error', 8000);
    });

    SocketClient.on('_reconnected', async () => {
      await _acquireWakeLock();
      toast('Reconnected!', 'success');
      // _connected fires after reconnect and handles rejoin automatically
    });

    SocketClient.on('_reconnect_failed', () => {
      toast('Lost connection. Please refresh this page.', 'error', 0);
    });

    // ── S_ADMIN_AUTH_OK ───────────────────────────────────────────────────
    // Room created successfully — save session and show lobby

    SocketClient.on(EVENTS.S_ADMIN_AUTH_OK, (payload) => {
      const { roomCode, playerId, adminToken, players } = payload;

      state.roomCode = roomCode;
      state.playerId = playerId;

      SocketClient.setSession({
        roomCode,
        playerId,
        nickname:   els.inputHostNick.value.trim() || 'Host',
        role:       ROLE.HOST,
        adminToken,
      });

      els.lobbyCode.textContent    = roomCode;
      els.lobbyJoinUrl.textContent = `${window.location.hostname}/play`;
      updateLobbyPlayers(players);
      showScreen('lobby');

      logger.info?.(`[host] Room created: ${roomCode}`);
    });

    // ── S_ADMIN_AUTH_FAIL ─────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ADMIN_AUTH_FAIL, (payload) => {
      els.authError.textContent = payload.message ?? 'Authentication failed.';
      els.authError.classList.remove('hidden');
      els.btnAuth.disabled    = false;
      els.btnAuth.textContent = 'Enter';
    });

    // ── S_ROOM_JOINED (after C_REJOIN) ────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_JOINED, (payload) => {
      const { roomCode, playerId, players, reconnected, gameState: gs } = payload;

      state.roomCode = roomCode;
      state.playerId = playerId;

      // Refresh session with updated playerId (in case it changed)
      const saved = SocketClient.getSavedSession();
      SocketClient.setSession({
        roomCode,
        playerId,
        nickname:   saved.nickname ?? 'Host',
        role:       ROLE.HOST,
        adminToken: saved.adminToken,
      });

      players.forEach((p) => _nicknameCache.set(p.id, p.nickname));

      if (reconnected && gs && gs !== GAME_STATE.LOBBY) {
        toast('Reconnected to game in progress — resyncing…', 'success');
        // S_GAME_STATE_SYNC arrives next and snaps to correct screen
        return;
      }

      // Fresh join after auth
      els.lobbyCode.textContent    = roomCode;
      els.lobbyJoinUrl.textContent = `${window.location.hostname}/play`;
      updateLobbyPlayers(players);
      showScreen('lobby');
    });

    // ── S_GAME_STATE_SYNC ─────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_STATE_SYNC, (payload) => {
      applyStateSync(payload);
    });

    // ── S_ROOM_PLAYERS ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROOM_PLAYERS, (payload) => {
      const { players } = payload;
      state.totalPlayers = players.filter((p) => p.role !== ROLE.HOST).length;
      players.forEach((p) => _nicknameCache.set(p.id, p.nickname));
      updateLobbyPlayers(players);
    });

    // ── S_GAME_COUNTDOWN ──────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_COUNTDOWN, (payload) => {
      const { countdownMs, totalRounds } = payload;
      state.totalRounds = totalRounds;

      showScreen('countdown');
      els.countdownLabel.textContent = `${totalRounds} rounds — let's go!`;

      const steps   = Math.ceil(countdownMs / 1000);
      let   current = steps;

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

    // ── S_ROUND_START ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_START, (payload) => {
      const { round, roundIndex, totalRounds, durationMs, endsAt } = payload;
      setupRound(round, roundIndex, totalRounds, durationMs, endsAt);
      showScreen('round');
    });

    // ── S_ROUND_TICK ──────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_TICK, ({ remainingMs }) => {
      state.roundEndsAt = Date.now() + remainingMs;
    });

    // ── S_GUESS_COUNT ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GUESS_COUNT, ({ guessCount, totalPlayers }) => {
      state.totalPlayers = totalPlayers;
      _updateGuessCounter(guessCount, totalPlayers);
    });

    // ── S_ROUND_REVEAL ────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ROUND_REVEAL, (payload) => {
      renderReveal(payload);
    });

    // ── S_LEADERBOARD ─────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_LEADERBOARD, (payload) => {
      (payload.players ?? []).forEach((p) => {
        if (p.id && p.nickname) _nicknameCache.set(p.id, p.nickname);
      });
      if (payload.resumed) toast('Game resumed from last checkpoint', 'success');
      renderLeaderboard(payload);
    });

    // ── S_GAME_OVER ───────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_GAME_OVER, (payload) => {
      renderGameOver(payload);
    });

    // ── S_ERROR ───────────────────────────────────────────────────────────

    SocketClient.on(EVENTS.S_ERROR, (payload) => {
      const { code, message } = payload;
      console.error('[host error]', code, message);

      if (code === 'NOT_ENOUGH_PLAYERS') {
        toast('Need at least 1 player to start', 'error');
        return;
      }

      if (code === 'HOST_DISCONNECTED') {
        // We are the host — this fires on other clients, not us
        return;
      }

      toast(message ?? 'Something went wrong', 'error');
    });
  }

  // ── DOM Event Wiring ──────────────────────────────────────────────────────

  function _wireDom() {

    // ── Auth screen ───────────────────────────────────────────────────────

    function _attemptAuth() {
      const password = els.inputPassword.value;
      const nickname = els.inputHostNick.value.trim() || 'Host';

      els.authError.classList.add('hidden');
      els.authError.textContent = '';

      if (!password) {
        els.authError.textContent = 'Please enter the admin password.';
        els.authError.classList.remove('hidden');
        return;
      }

      els.btnAuth.disabled    = true;
      els.btnAuth.textContent = 'Verifying…';

      SocketClient.adminAuth(password, nickname);

      // Re-enable after timeout in case of network issue
      setTimeout(() => {
        els.btnAuth.disabled    = false;
        els.btnAuth.textContent = 'Enter';
      }, 6000);
    }

    els.btnAuth.addEventListener('click', _attemptAuth);
    els.inputPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _attemptAuth();
    });

    // ── Start game ────────────────────────────────────────────────────────

    els.btnStart.addEventListener('click', () => {
      els.btnStart.disabled    = true;
      els.btnStart.textContent = 'Starting…';
      SocketClient.startGame();
      setTimeout(() => {
        els.btnStart.disabled    = false;
        els.btnStart.textContent = 'Start Game';
      }, 4000);
    });

    // ── End round early ───────────────────────────────────────────────────
    // Now correctly calls hostEndRound() → C_HOST_END_ROUND → forceEndRound()

    els.btnEndRoundEarly.addEventListener('click', () => {
      if (!confirm('End this round now for all players?')) return;
      SocketClient.hostEndRound();
    });

    // ── Advance from reveal → leaderboard ─────────────────────────────────

    els.revealNextBtn.addEventListener('click', () => {
      SocketClient.hostNext();
    });

    // ── Advance from leaderboard → next round / game over ─────────────────

    els.lbNextBtn.addEventListener('click', () => {
      SocketClient.hostNext();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    await _acquireWakeLock();

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') await _acquireWakeLock();
    });

    SocketClient.connect();
    _wireEvents();
    _wireDom();

    // Start on auth screen — _connected handler will skip it if session exists
    showScreen('auth');
  }

  return { init, toast };

})();

document.addEventListener('DOMContentLoaded', () => HostApp.init());