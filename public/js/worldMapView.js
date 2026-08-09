/**
 * worldMapView.js
 * Handles all world-round map interactions:
 *  - Leaflet map for pin-drop guessing
 *  - Mapillary viewer for 360° street-level imagery
 *  - Reveal map: animating all 100 guess pins + correct answer pin
 *
 * Designed to be stateless between rounds — init() fully resets state.
 */

/* global L, ROUND_TYPE */
window.MAPILLARY_CLIENT_TOKEN = 'MLY|28241307835482284|40a9903301c40dd2362c530bd97e51ee';

const WorldMapView = (() => {

  // ── Leaflet instance refs ──────────────────────────────────────────────────

  let _guessMap = null;  // Active-round Leaflet map
  let _guessMarker = null;  // Player's current pin
  let _onPinPlaced = null;  // Callback to PlayerApp

  let _revealMap = null;  // Reveal-screen Leaflet map
  let _revealLayers = null;  // LayerGroup holding all reveal pins

  // ── Mapillary viewer ref ───────────────────────────────────────────────────

  let _mapillaryViewer = null;

  // ── Tile layer URL (OpenStreetMap — no API key required) ──────────────────

  const OSM_TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  /**
   * Dark-styled tile layer from CartoDB — matches our dark UI theme.
   * Falls back to standard OSM if CartoDB is unavailable.
   */
  const DARK_TILE = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  const DARK_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';

  // ── Pin Colours ────────────────────────────────────────────────────────────

  // For Dark Mode 
  // const COLOURS = {
  //   self: '#C8F135', // accent lime — player's own pin
  //   correct: '#FF4D4D', // red — correct answer pin
  //   top3: '#FFD166', // gold — top 3 guessers
  //   other: '#4A9EFF', // blue — everyone else
  //   offline: '#555555', // grey — disconnected player
  // };

  // For Light Mode
  const COLOURS = {
  self:    '#1a8c2e', // dark green — visible on white map
  correct: '#FF4D4D',
  top3:    '#cc8800', // darker gold — visible on white
  other:   '#1a5eb8', // darker blue — visible on white
  offline: '#999999',
};


  // ── Active Round Map ───────────────────────────────────────────────────────

  /**
   * Initialise (or reinitialise) the Leaflet guess map.
   * Fully resets any existing map instance so it's safe to call
   * at the start of every world round.
   *
   * @param {string}   containerId  HTML element ID for the map container
   * @param {Function} onPinPlaced  Callback({ lat, lng }) when player clicks
   */
  function init(containerId, onPinPlaced) {
    _onPinPlaced = onPinPlaced;
    _guessMarker = null;

    // Destroy previous instance if it exists
    if (_guessMap) {
      _guessMap.off();
      _guessMap.remove();
      _guessMap = null;
    }

    _guessMap = L.map(containerId, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      zoomControl: true,
      attributionControl: true,
      // Prevent wrapping so pins don't appear on duplicate world copies
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0,
    });

    // Dark tile layer
    L.tileLayer(DARK_TILE, {
      attribution: DARK_ATTR,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(_guessMap);

    // Click handler — place or move pin
    _guessMap.on('click', (e) => {
      const { lat, lng } = e.latlng;
      _placeGuessPin(lat, lng);
    });

    // Invalidate size after DOM settles
    // (Leaflet needs the container to have its final dimensions)
    requestAnimationFrame(() => {
      _guessMap.invalidateSize();
    });
  }

  /**
   * Place or move the player's guess pin on the active map.
   *
   * @param {number} lat
   * @param {number} lng
   */
  function _placeGuessPin(lat, lng) {
    const icon = _makeCircleIcon(COLOURS.self, 14, true);

    if (_guessMarker) {
      _guessMarker.setLatLng([lat, lng]);
    } else {
      _guessMarker = L.marker([lat, lng], {
        icon,
        draggable: true,
        zIndexOffset: 1000,
        title: 'Your guess',
      }).addTo(_guessMap);

      // Allow player to drag pin after placing
      _guessMarker.on('dragend', () => {
        const pos = _guessMarker.getLatLng();
        if (_onPinPlaced) _onPinPlaced({ lat: pos.lat, lng: pos.lng });
      });
    }

    if (_onPinPlaced) _onPinPlaced({ lat, lng });
  }

  // ── Reveal Map ─────────────────────────────────────────────────────────────

  function resizeViewer() {
    if (_mapillaryViewer) {
      try {
        _mapillaryViewer.resize();
      } catch (_) { }
    }
    if (_guessMap) {
      _guessMap.invalidateSize();
    }
  }

  /**
   * Render the post-round reveal on a separate Leaflet map.
   * Animates all guess pins in staggered batches, then drops the
   * correct answer pin last with a bounce effect.
   *
   * @param {string}   containerId   HTML element ID
   * @param {{ lat: number, lng: number }} answer  Correct coordinate
   * @param {Array}    scores        Scored guess array from server
   * @param {string}   selfPlayerId  Current player's ID (for highlight)
   */
  function renderReveal(containerId, answer, scores, selfPlayerId) {

    // ── Init or reuse reveal map ─────────────────────────────────────────

    if (_revealMap) {
      _revealMap.off();
      _revealMap.remove();
      _revealMap = null;
    }

    _revealMap = L.map(containerId, {
      center: [20, 0],
      zoom: 2,
      minZoom: 1,
      maxZoom: 10,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer(DARK_TILE, {
      attribution: DARK_ATTR,
      subdomains: 'abcd',
      maxZoom: 10,
    }).addTo(_revealMap);

    _revealLayers = L.layerGroup().addTo(_revealMap);

    requestAnimationFrame(() => {
      _revealMap.invalidateSize();
      _animateRevealPins(answer, scores, selfPlayerId);
    });
  }

  /**
   * Stagger-animate all guess pins onto the reveal map.
   * Pins appear in rank order (worst → best) so the best guess
   * lands last and gets a moment of attention before the answer drops.
   *
   * @param {{ lat: number, lng: number }} answer
   * @param {Array}  scores
   * @param {string} selfPlayerId
   */
  function _animateRevealPins(answer, scores, selfPlayerId) {
    if (!_revealMap || !_revealLayers) return;

    // Sort worst → best (highest rank number first)
    const sorted = [...scores].sort((a, b) => b.rank - a.rank);

    const STAGGER_MS = 30;   // ms between each pin drop
    const ANSWER_DELAY = 800;  // ms after last pin before answer drops
    const MAX_CONCURRENT = 20;   // drop in batches to avoid DOM thrashing

    let index = 0;

    function dropNext() {
      if (!_revealMap) return; // guard if map was destroyed mid-animation

      const batch = sorted.slice(index, index + MAX_CONCURRENT);
      batch.forEach((score) => {
        const isSelf = score.playerId === selfPlayerId;
        const isTop3 = score.rank <= 3;
        const colour = isSelf ? COLOURS.self
          : isTop3 ? COLOURS.top3
            : COLOURS.other;
        const size = isSelf ? 12 : isTop3 ? 10 : 7;

        const marker = L.marker([score.coord.lat, score.coord.lng], {
          icon: _makeCircleIcon(colour, size, false),
          zIndexOffset: isSelf ? 900 : isTop3 ? 500 : 0,
          title: `Rank #${score.rank} — ${score.distanceDisplay}`,
        });

        marker.addTo(_revealLayers);

        // Popup on hover for top 3 and self
        if (isSelf || isTop3) {
          marker.bindTooltip(
            `<strong>#${score.rank}</strong> ${score.distanceDisplay}`,
            { permanent: false, direction: 'top', className: 'reveal-tooltip' }
          );
        }
      });

      index += MAX_CONCURRENT;

      if (index < sorted.length) {
        setTimeout(dropNext, STAGGER_MS * MAX_CONCURRENT);
      } else {
        // All guess pins placed — drop correct answer pin
        setTimeout(() => _dropAnswerPin(answer), ANSWER_DELAY);
      }
    }

    // Collect all coordinates to auto-fit bounds after answer drops
    const allCoords = scores
      .map((s) => [s.coord.lat, s.coord.lng])
      .concat([[answer.lat, answer.lng]]);

    dropNext();

    // Fit map bounds to show all pins + answer after animation
    const totalDelay = (sorted.length / MAX_CONCURRENT) * STAGGER_MS * MAX_CONCURRENT
      + ANSWER_DELAY + 400;

    setTimeout(() => {
      if (!_revealMap) return;
      try {
        const bounds = L.latLngBounds(allCoords);
        _revealMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
      } catch (_) {
        // fitBounds throws if bounds are invalid (e.g. no guesses) — safe to ignore
      }
    }, totalDelay);
  }

  /**
   * Drop the correct answer pin with a pulsing circle.
   *
   * @param {{ lat: number, lng: number }} answer
   */
  function _dropAnswerPin(answer) {
    if (!_revealMap || !_revealLayers) return;

    // Outer pulse ring
    L.circleMarker([answer.lat, answer.lng], {
      radius: 20,
      color: COLOURS.correct,
      fillColor: COLOURS.correct,
      fillOpacity: 0.15,
      weight: 2,
      className: 'answer-pulse',
    }).addTo(_revealLayers);

    // Inner solid dot
    const marker = L.marker([answer.lat, answer.lng], {
      icon: _makeCircleIcon(COLOURS.correct, 14, true),
      zIndexOffset: 2000,
      title: 'Correct location',
    }).addTo(_revealLayers);

    marker.bindTooltip('Correct location', {
      permanent: true,
      direction: 'top',
      className: 'reveal-tooltip reveal-tooltip--answer',
    }).openTooltip();
  }

  // ── Mapillary Viewer ───────────────────────────────────────────────────────

  /**
   * Initialise the Mapillary street-level panorama viewer.
   *
   * Uses Mapillary's JavaScript SDK (mapillary-js).
   * The SDK is loaded as a <script> tag in player.html and host.html.
   *
   * @param {string} containerId  HTML element ID for viewer container
   * @param {string} imageId      Mapillary image ID from worldRounds.json
   */
  function prefetchSequence(imageId) {
  fetch(
    `https://graph.mapillary.com/${imageId}?fields=id,sequence,computed_geometry`,
    { headers: { 'Authorization': `OAuth ${window.MAPILLARY_CLIENT_TOKEN}` } }
  ).catch(() => {}); // fire and forget — just warming the browser cache
}
  function initMapillaryViewer(containerId, imageId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error(`[WorldMapView] Mapillary container #${containerId} not found`);
      return;
    }

    // Destroy previous instance
    if (_mapillaryViewer) {
      try { _mapillaryViewer.remove(); } catch (_) { }
      _mapillaryViewer = null;
    }

    // Clear container
    container.innerHTML = '';

    // Guard: mapillary-js must be loaded
    if (typeof window.mapillary === 'undefined') {
      console.error('[WorldMapView] mapillary-js not loaded — check script tag in HTML');
      _renderMapillaryFallback(container, imageId);
      return;
    }

    try {
      _mapillaryViewer = new window.mapillary.Viewer({
        accessToken: window.MAPILLARY_CLIENT_TOKEN,
        container: containerId,
        imageId,
        component: {
          cover: false,
          sequence: true,   // hide sequence navigation arrows
          direction: true,   // hide compass
          attribution: false,
          pointer: true,
          keyboard: true,
          zoom: true,
        },
      });

      _mapillaryViewer.on('load', () => {
        console.info('[WorldMapView] Mapillary viewer loaded:', imageId);
        _mapillaryViewer.resize();
      });

      _mapillaryViewer.on('dataloaded', () => {
        // Viewer is ready — nothing to do but log
        console.debug('[WorldMapView] Mapillary data loaded');
        _mapillaryViewer.resize();
        window.dispatchEvent(new Event('resize'));
      });
      _mapillaryViewer.on('image', () => {
        _mapillaryViewer.resize();
      });

    } catch (err) {
      console.error('[WorldMapView] Mapillary init error:', err);
      _renderMapillaryFallback(container, imageId);
    }
  }

  /**
   * Render a fallback message if Mapillary fails to load.
   * Better than a blank black panel at the event.
   *
   * @param {HTMLElement} container
   * @param {string}      imageId
   */
  function _renderMapillaryFallback(container, imageId) {
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      background: #0a0f1a;
      color: #888;
      font-family: var(--font-body);
      font-size: 0.875rem;
      text-align: center;
      padding: 2rem;
    `;
    container.innerHTML = `
      <span style="font-size:2rem">🗺️</span>
      <p style="color:var(--text-primary);font-weight:600">Street view unavailable</p>
      <p style="color:var(--text-secondary);font-size:0.8rem">
        Mapillary image ID: <code style="color:var(--accent)">${imageId}</code>
      </p>
      <p style="color:var(--text-secondary);font-size:0.75rem">
        Check your Mapillary client token in .env
      </p>
    `;
  }

  // ── Icon Factory ───────────────────────────────────────────────────────────

  /**
   * Create a circular Leaflet DivIcon.
   * Avoids the default Leaflet marker image which doesn't match our dark theme.
   *
   * @param {string}  colour   CSS colour string
   * @param {number}  size     Diameter in pixels
   * @param {boolean} border   Whether to add a white border ring
   * @returns {L.DivIcon}
   */
  function _makeCircleIcon(colour, size, border) {
    const borderStyle = border
      ? `box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,0.5);`
      : `box-shadow: 0 1px 4px rgba(0,0,0,0.4);`;

    return L.divIcon({
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div style="
        width:${size}px;
        height:${size}px;
        border-radius:50%;
        background:${colour};
        ${borderStyle}
        pointer-events:none;
      "></div>`,
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Destroy all Leaflet map instances and the Mapillary viewer.
   * Call when navigating away from the game entirely.
   */
  function destroy() {
    if (_guessMap) {
      _guessMap.off();
      _guessMap.remove();
      _guessMap = null;
    }
    if (_revealMap) {
      _revealMap.off();
      _revealMap.remove();
      _revealMap = null;
    }
    if (_mapillaryViewer) {
      try { _mapillaryViewer.remove(); } catch (_) { }
      _mapillaryViewer = null;
    }
    _guessMarker = null;
    _revealLayers = null;
    _onPinPlaced = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    initMapillaryViewer,
    renderReveal,
    destroy,
    prefetchSequence
  };

})();