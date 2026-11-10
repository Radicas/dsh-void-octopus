/**
 * The departure: a rare, deliberate exit.
 *
 * behavior.js only ever moves the layer ACROSS the screen. This module adds the
 * one thing screen space cannot express: the body turns its back on the viewer
 * and then recedes into the depth field.
 *
 * It is its own module because it is a different kind of motion — a short
 * choreography with a beginning, a held pose and an end, not an open-ended
 * stepping state machine — and because it must stay a pure function of
 * (state, dt, random) so the timing can be asserted without a browser.
 *
 *   IDLE ──cooldown & resting──> PREP ──> TURN ──> RETREAT ──> FAR ──> RETURN ──> IDLE
 *                               0.5-0.9   2.0-2.8   2.6-4.2     6-18     2.2-3.4
 *
 * PREP    holds position and lets the arms settle: the gather before a push.
 * TURN    swings the body from facing the viewer (0) to back-to-viewer (π).
 * RETREAT the depth target jumps to the far band; stepDepth integrates it, so
 *         the retreat eases rather than snaps. This is where the jet fires.
 * FAR     holds: back turned, smaller, dimmer. Reads as "it left".
 * RETURN  turns back toward the viewer and comes closer again.
 *
 * Rules carried over from the rest of the motion code:
 *  - no `sin(clock * state)`: every curve here is a function of PHASE PROGRESS,
 *    so nothing can drift with uptime;
 *  - every change is rate-limited or damped: a huge `dt` cannot teleport the
 *    body, and the facing never jumps.
 */

export const PHASE = {
  IDLE: 'idle',
  PREP: 'prep',
  TURN: 'turn',
  RETREAT: 'retreat',
  FAR: 'far',
  RETURN: 'return',
}

const PHASES = [PHASE.IDLE, PHASE.PREP, PHASE.TURN, PHASE.RETREAT, PHASE.FAR, PHASE.RETURN]

export const DEFAULTS = {
  enabled: true,
  // --- scheduling -------------------------------------------------------
  // First chance 35-75 s after load. The ambient layer resumes a saved wander,
  // so this also acts as the quiet period after a refresh.
  firstDelayMin: 35,
  firstDelayMax: 75,
  // Between departures: mean ~2.4 min, so it stays an event and not a loop.
  gapMin: 80,
  gapMax: 210,
  // --- choreography -----------------------------------------------------
  prepMin: 0.5,
  prepMax: 0.9,
  // A 180 deg swing in 2.0-2.8 s peaks around 170 deg/s — slower than a
  // startled animal, fast enough that the profile shot only lasts a few frames.
  turnMin: 2.0,
  turnMax: 2.8,
  facingTarget: Math.PI,
  retreatMin: 2.6,
  retreatMax: 4.2,
  farDepthMin: 0.86,
  farDepthMax: 0.97,
  farMin: 6,
  farMax: 18,
  returnMin: 2.2,
  returnMax: 3.4,
  // Where it settles when it comes back. The normal depth wander takes over
  // afterwards, but only after this hold — otherwise a far band could be drawn
  // on the very next frame and the body would immediately swing away again.
  nearDepthMin: 0.18,
  nearDepthMax: 0.42,
  homeHoldMin: 4,
  homeHoldMax: 9,
  // --- how it looks at distance ----------------------------------------
  // Opacity and a screen-space lift, on top of the depth scale. The lift is what
  // stops the retreat reading as "someone shrank the picture": the visual
  // centre actually travels.
  alphaFar: 0.42,
  liftMax: 30,
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v) => clamp(v, 0, 1)
const lerp = (a, b, t) => a + (b - a) * t
const approach = (current, target, maxDelta) =>
  current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta)
const randRange = (rand, min, max) => min + (max - min) * rand()
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** C2-continuous S-curve: zero velocity and zero acceleration at both ends. */
function smootherstep(t) {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/** C1 S-curve: used where a slightly softer start is enough. */
function smoothstep(t) {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

function enter(st, phase, duration) {
  st.dpPhase = phase
  st.dpDur = duration
  st.dpTimer = duration
}

function beginPrep(st, cfg, rand) {
  enter(st, PHASE.PREP, randRange(rand, cfg.prepMin, cfg.prepMax))
  // Freeze the current distance: without this, the depth re-roll could fire
  // during the turn and make the body both turn and shrink at once.
  st.depthTarget = st.depth
  // Continue from wherever the distance-driven facing already is: a departure
  // can start while the body is already turned away, and snapping to 0 first
  // would be a 180 deg jump.
  st.dpFacing = isNum(st.facing) ? st.facing : 0
}

function beginTurn(st, cfg, rand) {
  enter(st, PHASE.TURN, randRange(rand, cfg.turnMin, cfg.turnMax))
  st.dpFacingFrom = st.dpFacing
}

function beginRetreat(st, cfg, rand) {
  enter(st, PHASE.RETREAT, randRange(rand, cfg.retreatMin, cfg.retreatMax))
  st.dpFarDepth = randRange(rand, cfg.farDepthMin, cfg.farDepthMax)
  st.depthTarget = st.dpFarDepth
  // The push-off. stepBehavior resets `jet` at the top of every step, so setting
  // it here is exactly the existing "a cruise leg started" contract, and the
  // ambient layer fires engine.pulse() on it.
  st.jet = 1
}

function beginReturn(st, cfg, rand) {
  enter(st, PHASE.RETURN, randRange(rand, cfg.returnMin, cfg.returnMax))
  st.depthTarget = randRange(rand, cfg.nearDepthMin, cfg.nearDepthMax)
}

function finish(st, cfg, rand) {
  enter(st, PHASE.IDLE, 0)
  st.dpFacing = 0
  st.dpLift = 0
  st.dpAlpha = 1
  st.dpCooldown = randRange(rand, cfg.gapMin, cfg.gapMax)
  // Come home to the near half and HOLD it for a few seconds. Re-rolling the
  // depth band immediately meant a far band could be drawn on the next frame,
  // so the creature would arrive and instantly start turning away again.
  st.depthTarget = randRange(rand, cfg.nearDepthMin, cfg.nearDepthMax)
  st.depthTimer = randRange(rand, cfg.homeHoldMin, cfg.homeHoldMax)
}

/**
 * Install the departure fields on a behaviour state.
 * @param {object} st behaviour state (mutated)
 * @param {() => number} rand uniform [0,1) source
 * @param {object} [cfg]
 */
export function initDeparture(st, rand = Math.random, cfg = DEFAULTS) {
  st.dpPhase = PHASE.IDLE
  st.dpTimer = 0
  st.dpDur = 0
  st.dpCooldown = randRange(rand, cfg.firstDelayMin, cfg.firstDelayMax)
  st.dpFacing = 0
  st.dpFacingFrom = 0
  st.dpAlpha = 1
  st.dpLift = 0
  st.dpFarDepth = cfg.farDepthMin
  return st
}

/**
 * Rebuild the departure fields from a stored payload. Missing or malformed
 * fields fall back to a fresh idle state — a payload written before this
 * feature existed must still resume the wander.
 * @param {object} st behaviour state (mutated)
 * @param {unknown} raw the stored `dp` object
 * @param {object} [cfg]
 */
export function restoreDeparture(st, raw, cfg = DEFAULTS) {
  const src = raw != null && typeof raw === 'object' ? /** @type {any} */ (raw) : {}
  st.dpPhase = PHASES.includes(src.phase) ? src.phase : PHASE.IDLE
  st.dpTimer = isNum(src.timer) ? Math.max(0.05, src.timer) : 0
  st.dpDur = isNum(src.dur) ? Math.max(0, src.dur) : 0
  st.dpCooldown = isNum(src.cooldown) ? Math.max(0, src.cooldown) : cfg.firstDelayMin
  st.dpFacing = isNum(src.facing) ? clamp(src.facing, -Math.PI, Math.PI) : 0
  st.dpFacingFrom = isNum(src.facingFrom) ? clamp(src.facingFrom, -Math.PI, Math.PI) : st.dpFacing
  st.dpAlpha = isNum(src.alpha) ? clamp01(src.alpha) : 1
  st.dpLift = isNum(src.lift) ? clamp(src.lift, 0, cfg.liftMax) : 0
  st.dpFarDepth = isNum(src.farDepth) ? clamp01(src.farDepth) : cfg.farDepthMin
  return st
}

/**
 * Start a departure now, whatever the cooldown says. Used by the debug hook and
 * by tests; the normal path is the cooldown inside stepDeparture.
 * @returns {boolean} true when a departure actually started
 */
export function startDeparture(st, cfg = DEFAULTS, rand = Math.random) {
  if (st.dpPhase !== PHASE.IDLE) return false
  beginPrep(st, cfg, rand)
  return true
}

/**
 * Advance the choreography by `dt` seconds (mutates `st`).
 * @param {object} st behaviour state
 * @param {number} dt seconds
 * @param {object} [cfg]
 * @param {() => number} [rand]
 * @returns {object} the same state
 */
export function stepDeparture(st, dt, cfg = DEFAULTS, rand = Math.random) {
  if (!(dt > 0)) return st
  // A state created before this feature (or hand-edited storage) has no phase.
  if (st.dpPhase == null) initDeparture(st, rand, cfg)

  if (st.dpCooldown > 0) st.dpCooldown = Math.max(0, st.dpCooldown - dt)

  if (st.dpPhase === PHASE.IDLE) {
    // Soothe any interrupted pose back to neutral: a reload can happen mid
    // departure, and the restored facing must not stick forever.
    st.dpFacing = approach(st.dpFacing, 0, 1.8 * dt)
    st.dpAlpha = approach(st.dpAlpha, 1, 0.9 * dt)
    st.dpLift = approach(st.dpLift, 0, 24 * dt)
    if (cfg.enabled && st.mode === 'rest' && st.dpCooldown <= 0) beginPrep(st, cfg, rand)
    return st
  }

  st.dpTimer -= dt
  const progress = st.dpDur > 0 ? clamp01(1 - st.dpTimer / st.dpDur) : 1

  switch (st.dpPhase) {
    case PHASE.PREP:
      // Facing is held, not eased: it continues from wherever the distance left
      // the body, and the TURN phase takes over from that exact value.
      if (st.dpTimer <= 0) beginTurn(st, cfg, rand)
      break
    case PHASE.TURN:
      st.dpFacing = lerp(isNum(st.dpFacingFrom) ? st.dpFacingFrom : 0, cfg.facingTarget, smootherstep(progress))
      if (st.dpTimer <= 0) {
        st.dpFacing = cfg.facingTarget
        beginRetreat(st, cfg, rand)
      }
      break
    case PHASE.RETREAT: {
      const e = smoothstep(progress)
      st.dpFacing = approach(st.dpFacing, cfg.facingTarget, 1.2 * dt)
      st.dpLift = cfg.liftMax * e
      st.dpAlpha = lerp(1, cfg.alphaFar, e)
      if (st.dpTimer <= 0) enter(st, PHASE.FAR, randRange(rand, cfg.farMin, cfg.farMax))
      break
    }
    case PHASE.FAR:
      st.dpFacing = approach(st.dpFacing, cfg.facingTarget, 1.2 * dt)
      st.dpLift = cfg.liftMax
      st.dpAlpha = cfg.alphaFar
      if (st.dpTimer <= 0) beginReturn(st, cfg, rand)
      break
    case PHASE.RETURN: {
      const e = smootherstep(progress)
      const fade = smoothstep(progress)
      st.dpFacing = cfg.facingTarget * (1 - e)
      st.dpLift = cfg.liftMax * (1 - fade)
      st.dpAlpha = lerp(cfg.alphaFar, 1, fade)
      if (st.dpTimer <= 0) finish(st, cfg, rand)
      break
    }
    default:
      // Unknown phase (hand-edited storage): fall back to idle, not to NaN.
      enter(st, PHASE.IDLE, 0)
      break
  }
  return st
}

/**
 * What the renderer and the layer need this frame.
 * @param {object} st
 * @returns {{active:boolean, phase:string, facing:number, alpha:number, lift:number}}
 */
export function getDeparture(st) {
  return {
    active: st.dpPhase !== PHASE.IDLE,
    phase: st.dpPhase,
    // `facing` is the behaviour's single facing value (distance-driven while
    // idle, choreographed during a departure); dpFacing is the choreography's
    // own curve and only exists for the phases that own it.
    facing: isNum(st.facing) ? st.facing : isNum(st.dpFacing) ? st.dpFacing : 0,
    alpha: isNum(st.dpAlpha) ? clamp01(st.dpAlpha) : 1,
    lift: isNum(st.dpLift) ? st.dpLift : 0,
  }
}
