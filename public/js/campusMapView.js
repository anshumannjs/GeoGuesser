/**
 * campusMapView.js
 * Handles all campus-round map interactions:
 *  - Canvas overlay on a static campus map image for pin-drop guessing
 *  - Normalised pixel coordinate system (0-1 range, resolution-independent)
 *  - Reveal canvas: animating all 100 guess pins + correct answer pin
 *
 * Coordinate system:
 *   (0,0) = top-left of campus map image
 *   (1,1) = bottom-right of campus map image
 *   All stored/transmitted coords are normalised — never raw pixels.
 *   Raw pixels are only used for rendering and are computed at draw time.
 */

/* global PlayerApp */

const CampusMapView = (() => {

  // ── Active round state ─────────────────────────────────────────────────────

  let _canvas       = null;  // HTMLCanvasElement (guess)
  let _ctx          = null;  // CanvasRenderingContext2D (guess)
  let _img          = null;  // HTMLImageElement (campus map)
  let _onPinPlaced  = null;  // Callback to PlayerApp
  let _pinCoord     = null;  // { x, y } normalised — current guess pin

  // Reveal canvas refs
  let _revealCanvas = null;
  let _revealCtx    = null;
  let _revealImg    = null;

  // ResizeObserver for responsive canvas sizing
  let _resizeObserver = null;

  // ── Colours ────────────────────────────────────────────────────────────────

  const COLOURS = {
    self:          '#C8F135', // accent lime — player's own pin
    correct:       '#FF4D4D', // red — correct answer
    top3:          '#FFD166', // gold — top 3 guessers
    other:         '#4A9EFF', // blue — everyone else
    correctRing:   'rgba(255,77,77,0.2)',
    selfRing:      'rgba(200,241,53,0.2)',
    line:          'rgba(255,77,77,0.5)', // line from self guess → answer
  };

  // ── Pin sizes (in normalised units, scaled to canvas at draw time) ─────────

  const PIN = {
    self:    { r: 8, border: 2.5 },
    top3:    { r: 7, border: 2   },
    other:   { r: 5, border: 1.5 },
    correct: { r: 10, border: 3  },
  };

  // ── Active Round: Init ─────────────────────────────────────────────────────

  /**
   * Initialise (or reinitialise) the campus map canvas for a new round.
   * Loads the map image, sets up the canvas overlay, and wires click events.
   *
   * @param {string}   canvasId    HTML element ID of the <canvas>
   * @param {string}   imgId       HTML element ID of the <img> (campus map)
   * @param {string}   photoUrl    URL/path of the campus map image
   * @param {Function} onPinPlaced Callback({ x, y }) when player clicks
   */
  function init(canvasId, imgId, photoUrl, onPinPlaced) {
    _onPinPlaced  = onPinPlaced;
    _pinCoord     = null;

    _canvas = document.getElementById(canvasId);
    _img    = document.getElementById(imgId);
    _ctx    = _canvas.getContext('2d');

    // Remove previous listeners by cloning the canvas node
    const fresh = _canvas.cloneNode(false);
    _canvas.parentNode.replaceChild(fresh, _canvas);
    _canvas = fresh;
    _ctx    = _canvas.getContext('2d');

    // Load campus map image
    _img.onload  = () => {
      _syncCanvasSize();
      _drawGuessCanvas();
    };
    _img.onerror = () => {
      console.error('[CampusMapView] Failed to load campus map image:', photoUrl);
      _renderImageError(_ctx, _canvas);
    };

    // If image is already cached, onload won't fire — draw immediately
    if (_img.complete && _img.naturalWidth > 0) {
      _syncCanvasSize();
      _drawGuessCanvas();
    }

    _img.src = photoUrl;

    // ── Click handler ──────────────────────────────────────────────────────

    _canvas.addEventListener('click', _handleCanvasClick);

    // ── Resize observer — keep canvas in sync with image layout ───────────

    if (_resizeObserver) _resizeObserver.disconnect();

    _resizeObserver = new ResizeObserver(() => {
      _syncCanvasSize();
      _drawGuessCanvas();
    });
    _resizeObserver.observe(_img);
  }

  /**
   * Handle a click on the guess canvas.
   * Converts raw pixel click position to normalised (0-1) coords.
   *
   * @param {MouseEvent} e
   */
  function _handleCanvasClick(e) {
    if (!_canvas || !_img) return;

    const rect   = _canvas.getBoundingClientRect();
    const rawX   = e.clientX - rect.left;
    const rawY   = e.clientY - rect.top;

    // The campus map image may be letter-boxed inside its container
    // (object-fit: contain). We need the actual rendered image rect,
    // not the container rect, to get accurate normalised coords.
    const imageRect = _getRenderedImageRect();
    if (!imageRect) return;

    // Clamp to image bounds
    const clampedX = Math.max(imageRect.left, Math.min(rawX, imageRect.right));
    const clampedY = Math.max(imageRect.top,  Math.min(rawY, imageRect.bottom));

    // Normalise to 0-1 within image bounds
    const normX = (clampedX - imageRect.left) / imageRect.width;
    const normY = (clampedY - imageRect.top)  / imageRect.height;

    _pinCoord = { x: _clamp01(normX), y: _clamp01(normY) };

    _drawGuessCanvas();

    if (_onPinPlaced) _onPinPlaced(_pinCoord);
  }

  // ── Active Round: Draw ─────────────────────────────────────────────────────

  /**
   * Draw the current state of the guess canvas:
   *  - Crosshair cursor hint (before pin placed)
   *  - Player's guess pin (after pin placed)
   */
  function _drawGuessCanvas() {
    if (!_ctx || !_canvas) return;

    const { width, height } = _canvas;
    _ctx.clearRect(0, 0, width, height);

    const imageRect = _getRenderedImageRect();
    if (!imageRect) return;

    // Dim area outside the image (letterbox zones)
    _drawLetterboxMask(imageRect);

    if (_pinCoord) {
      const px = _normToPixel(_pinCoord.x, _pinCoord.y, imageRect);
      _drawPin(_ctx, px.x, px.y, COLOURS.self, PIN.self, true);
      _drawPinLabel(_ctx, px.x, px.y - PIN.self.r - 8, 'Your guess', COLOURS.self);
    } else {
      // Hint text when no pin placed yet
      _drawHintText(imageRect);
    }
  }

  /**
   * Draw a subtle mask over letterbox zones (areas outside the map image
   * when it's displayed with object-fit: contain inside its container).
   *
   * @param {Object} imageRect  { left, top, width, height }
   */
  function _drawLetterboxMask(imageRect) {
    if (!_ctx || !_canvas) return;
    _ctx.fillStyle = 'rgba(0,0,0,0.4)';

    // Top bar
    if (imageRect.top > 0) {
      _ctx.fillRect(0, 0, _canvas.width, imageRect.top);
    }
    // Bottom bar
    const bottomY = imageRect.top + imageRect.height;
    if (bottomY < _canvas.height) {
      _ctx.fillRect(0, bottomY, _canvas.width, _canvas.height - bottomY);
    }
    // Left bar
    if (imageRect.left > 0) {
      _ctx.fillRect(0, imageRect.top, imageRect.left, imageRect.height);
    }
    // Right bar
    const rightX = imageRect.left + imageRect.width;
    if (rightX < _canvas.width) {
      _ctx.fillRect(rightX, imageRect.top, _canvas.width - rightX, imageRect.height);
    }
  }

  /**
   * Draw a "Click to place pin" hint centered on the map image.
   *
   * @param {Object} imageRect
   */
  function _drawHintText(imageRect) {
    if (!_ctx) return;
    const cx = imageRect.left + imageRect.width  / 2;
    const cy = imageRect.top  + imageRect.height / 2;

    _ctx.font      = '600 14px Inter, sans-serif';
    _ctx.fillStyle = 'rgba(255,255,255,0.35)';
    _ctx.textAlign    = 'center';
    _ctx.textBaseline = 'middle';
    _ctx.fillText('Click to place your pin', cx, cy);
  }

  // ── Reveal Canvas ──────────────────────────────────────────────────────────

  /**
   * Render the post-round reveal on the campus map canvas.
   * Shows all guess pins with staggered animation, then the correct answer.
   *
   * @param {string}   canvasId      HTML element ID of the reveal <canvas>
   * @param {string}   imgId         HTML element ID of the reveal <img>
   * @param {{ x: number, y: number }} answer  Correct normalised coordinate
   * @param {Array}    scores        Scored guesses from server
   * @param {string}   selfPlayerId  Current player's ID
   */
  function renderReveal(canvasId, imgId, answer, scores, selfPlayerId) {
    _revealCanvas = document.getElementById(canvasId);
    _revealImg    = document.getElementById(imgId);
    _revealCtx    = _revealCanvas.getContext('2d');

    // Sync canvas size to image
    _syncCanvasSizeFor(_revealCanvas, _revealImg);

    function _doReveal() {
      _syncCanvasSizeFor(_revealCanvas, _revealImg);
      _animateRevealPins(answer, scores, selfPlayerId);
    }

    if (_revealImg.complete && _revealImg.naturalWidth > 0) {
      _doReveal();
    } else {
      _revealImg.onload = _doReveal;
    }
  }

  /**
   * Stagger-animate guess pins onto the reveal canvas.
   * Same ordering logic as WorldMapView: worst → best → answer.
   *
   * @param {{ x: number, y: number }} answer
   * @param {Array}  scores
   * @param {string} selfPlayerId
   */
  function _animateRevealPins(answer, scores, selfPlayerId) {
    if (!_revealCtx || !_revealCanvas) return;

    // Sort worst → best (highest rank number first)
    const sorted = [...scores].sort((a, b) => b.rank - a.rank);

    const STAGGER_MS     = 25;
    const ANSWER_DELAY   = 700;
    const BATCH_SIZE     = 15;

    const imageRect = _getRenderedImageRectFor(_revealCanvas, _revealImg);
    if (!imageRect) return;

    // Clear canvas
    _revealCtx.clearRect(0, 0, _revealCanvas.width, _revealCanvas.height);
    _drawLetterboxMaskFor(_revealCtx, _revealCanvas, imageRect);

    // Collect all placed items for final redraw
    const placed = [];

    let index = 0;

    function dropBatch() {
      if (!_revealCtx) return;

      const batch = sorted.slice(index, index + BATCH_SIZE);

      batch.forEach((score) => {
        const isSelf = score.playerId === selfPlayerId;
        const isTop3 = score.rank <= 3;

        const colour = isSelf  ? COLOURS.self
                     : isTop3  ? COLOURS.top3
                     : COLOURS.other;

        const pinDef = isSelf  ? PIN.self
                      : isTop3  ? PIN.top3
                      : PIN.other;

        const px = _normToPixel(score.coord.x, score.coord.y, imageRect);

        placed.push({ px, colour, pinDef, isSelf, isTop3, score });
        _drawPin(_revealCtx, px.x, px.y, colour, pinDef, isSelf || isTop3);
      });

      index += BATCH_SIZE;

      if (index < sorted.length) {
        setTimeout(dropBatch, STAGGER_MS * BATCH_SIZE);
      } else {
        // All guess pins placed — draw answer pin
        setTimeout(() => {
          _dropAnswerPin(imageRect, answer, placed, selfPlayerId);
        }, ANSWER_DELAY);
      }
    }

    dropBatch();
  }

  /**
   * Draw the correct answer pin, a pulse ring around it,
   * and a line from the player's own guess to the answer.
   *
   * @param {Object} imageRect
   * @param {{ x: number, y: number }} answer
   * @param {Array}  placed          All previously placed pin data
   * @param {string} selfPlayerId
   */
  function _dropAnswerPin(imageRect, answer, placed, selfPlayerId) {
    if (!_revealCtx || !_revealCanvas) return;

    const answerPx = _normToPixel(answer.x, answer.y, imageRect);

    // Find self pin for distance line
    const selfEntry = placed.find((p) => p.score.playerId === selfPlayerId);

    // Redraw everything cleanly (prevents render order issues)
    _revealCtx.clearRect(0, 0, _revealCanvas.width, _revealCanvas.height);
    _drawLetterboxMaskFor(_revealCtx, _revealCanvas, imageRect);

    // Draw all guess pins first (bottom layer)
    placed.forEach(({ px, colour, pinDef, isSelf, isTop3 }) => {
      _drawPin(_revealCtx, px.x, px.y, colour, pinDef, isSelf || isTop3);
    });

    // Draw line from self guess → answer
    if (selfEntry) {
      _drawLine(
        _revealCtx,
        selfEntry.px.x, selfEntry.px.y,
        answerPx.x,     answerPx.y,
        COLOURS.line
      );
    }

    // Draw answer pulse ring
    _drawPulseRing(_revealCtx, answerPx.x, answerPx.y, PIN.correct.r + 12, COLOURS.correctRing);

    // Draw answer pin (top layer)
    _drawPin(_revealCtx, answerPx.x, answerPx.y, COLOURS.correct, PIN.correct, true);
    _drawPinLabel(_revealCtx, answerPx.x, answerPx.y - PIN.correct.r - 8, '✓ Answer', COLOURS.correct);
  }

  // ── Canvas Drawing Primitives ──────────────────────────────────────────────

  /**
   * Draw a filled circle pin with optional border ring.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number}  x
   * @param {number}  y
   * @param {string}  colour
   * @param {{ r: number, border: number }} pinDef
   * @param {boolean} withRing   Draw a subtle glow ring around the pin
   */
  function _drawPin(ctx, x, y, colour, pinDef, withRing) {
    const { r, border } = pinDef;

    // Outer glow ring
    if (withRing) {
      ctx.beginPath();
      ctx.arc(x, y, r + border + 3, 0, Math.PI * 2);
      ctx.fillStyle = colour.replace(')', ', 0.2)').replace('rgb', 'rgba');
      ctx.fill();
    }

    // White border
    ctx.beginPath();
    ctx.arc(x, y, r + border, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Coloured fill
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  /**
   * Draw a text label above a pin.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @param {string} colour
   */
  function _drawPinLabel(ctx, x, y, text, colour) {
    ctx.font         = '600 11px Inter, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';

    // Background pill
    const metrics = ctx.measureText(text);
    const pw      = metrics.width + 10;
    const ph      = 16;
    const px      = x - pw / 2;
    const py      = y - ph;

    ctx.fillStyle   = 'rgba(0,0,0,0.65)';
    _roundRect(ctx, px, py, pw, ph, 4);
    ctx.fill();

    // Text
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  /**
   * Draw a dashed line between two points.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {string} colour
   */
  function _drawLine(ctx, x1, y1, x2, y2, colour) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = colour;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Draw a semi-transparent pulse ring around a point.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {string} colour   rgba string
   */
  function _drawPulseRing(ctx, x, y, radius, colour) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  /**
   * Draw an error message on the canvas when the map image fails to load.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement}        canvas
   */
  function _renderImageError(ctx, canvas) {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font         = '500 14px Inter, sans-serif';
    ctx.fillStyle    = 'rgba(255,77,77,0.8)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Campus map failed to load', canvas.width / 2, canvas.height / 2);
  }

  /**
   * Draw a rounded rectangle path (no fill/stroke — caller does that).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r  Corner radius
   */
  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x,     y + h, x,     y + h - r);
    ctx.lineTo(x,     y + r);
    ctx.quadraticCurveTo(x,     y,     x + r, y);
    ctx.closePath();
  }

  // ── Coordinate Helpers ─────────────────────────────────────────────────────

  /**
   * Convert normalised (0-1) coordinates to canvas pixel coordinates.
   * Accounts for letterboxing (object-fit: contain).
   *
   * @param {number} normX
   * @param {number} normY
   * @param {{ left: number, top: number, width: number, height: number }} imageRect
   * @returns {{ x: number, y: number }}
   */
  function _normToPixel(normX, normY, imageRect) {
    return {
      x: imageRect.left + normX * imageRect.width,
      y: imageRect.top  + normY * imageRect.height,
    };
  }

  /**
   * Calculate the rendered image rect within the canvas, accounting for
   * object-fit: contain letterboxing.
   *
   * When an image is displayed with object-fit:contain, it is scaled to fit
   * the container while preserving aspect ratio. This means there may be
   * empty bars on the top/bottom (pillarbox) or left/right (letterbox).
   * We need the actual rendered image rect to map clicks correctly.
   *
   * @returns {{ left: number, top: number, width: number, height: number } | null}
   */
  function _getRenderedImageRect() {
    return _getRenderedImageRectFor(_canvas, _img);
  }

  /**
   * Generic version of _getRenderedImageRect for any canvas/img pair.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLImageElement}  img
   * @returns {{ left: number, top: number, width: number, height: number } | null}
   */
  function _getRenderedImageRectFor(canvas, img) {
    if (!canvas || !img || !img.naturalWidth || !img.naturalHeight) return null;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Scale to fit while preserving aspect ratio (object-fit: contain behaviour)
    const scale  = Math.min(cw / iw, ch / ih);
    const rw     = iw * scale;
    const rh     = ih * scale;
    const left   = (cw - rw) / 2;
    const top    = (ch - rh) / 2;

    return { left, top, width: rw, height: rh };
  }

  /**
   * Sync a canvas element's pixel dimensions to match its CSS dimensions.
   * Must be called whenever the container resizes.
   */
  function _syncCanvasSize() {
    _syncCanvasSizeFor(_canvas, _img);
  }

  /**
   * Generic version of _syncCanvasSize for any canvas/img pair.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLImageElement}  img
   */
  function _syncCanvasSizeFor(canvas, img) {
    if (!canvas || !img) return;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width  = rect.width;
    canvas.height = rect.height;
  }

  /**
   * Draw letterbox mask for a specific canvas/ctx pair.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement}        canvas
   * @param {Object}                   imageRect
   */
  function _drawLetterboxMaskFor(ctx, canvas, imageRect) {
    if (!ctx || !canvas) return;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';

    if (imageRect.top > 0) {
      ctx.fillRect(0, 0, canvas.width, imageRect.top);
    }
    const bottomY = imageRect.top + imageRect.height;
    if (bottomY < canvas.height) {
      ctx.fillRect(0, bottomY, canvas.width, canvas.height - bottomY);
    }
    if (imageRect.left > 0) {
      ctx.fillRect(0, imageRect.top, imageRect.left, imageRect.height);
    }
    const rightX = imageRect.left + imageRect.width;
    if (rightX < canvas.width) {
      ctx.fillRect(rightX, imageRect.top, canvas.width - rightX, imageRect.height);
    }
  }

  /**
   * Clamp a value to [0, 1].
   *
   * @param {number} v
   * @returns {number}
   */
  function _clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Tear down all canvas state and observers.
   * Call at the end of a campus round or when switching round types.
   */
  function destroy() {
    if (_resizeObserver) {
      _resizeObserver.disconnect();
      _resizeObserver = null;
    }
    if (_canvas) {
      _canvas.removeEventListener('click', _handleCanvasClick);
    }
    if (_ctx && _canvas) {
      _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    }
    if (_revealCtx && _revealCanvas) {
      _revealCtx.clearRect(0, 0, _revealCanvas.width, _revealCanvas.height);
    }
    _canvas       = null;
    _ctx          = null;
    _img          = null;
    _revealCanvas = null;
    _revealCtx    = null;
    _revealImg    = null;
    _pinCoord     = null;
    _onPinPlaced  = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    renderReveal,
    destroy,
  };

})();