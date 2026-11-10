/**
 * Random-walk locomotion for the ambient overlay.
 *
 * The layer used to follow a Lissajous path: the position was a pure function
 * of an accumulating clock, so the creature never stopped and its heading was
 * dictated by a formula. That reads as "always swimming". This module replaces
 * it with the NPC loop the overlay actually wants:
 *
 *     REST  (hover in place, random duration)
 *       -> CRUISE (random heading, random speed, random duration)
 *       -> SETTLE (bleed the speed off, so it arrives instead of stopping dead)
 *       -> REST
 *
 * There is no path and no waypoint. The position is integrated from a velocity
 * that is re-rolled at every state change and nudged by a small brownian turn
 * while cruising. Randomness is seeded (mulberry32) so a reload resumes the
 * exact wander and the tests can assert distributions instead of sleeping.
 *
 * Rules carried over from the previous motion code (see test/behavior.test.mjs):
 *  - dt-based, frame-rate independent, never NaN;
 *  - no `sin(clock * state)`, in fact no clock at all — only accumulated
 *    random-walk state — so the 0.9.11/0.9.15 phase runaway cannot come back;
 *  - no DOM / three / timers: pure state in, pure state out.
 */

import {
  DEFAULTS as DEPART_DEFAULTS,
  PHASE as DEPART_PHASE,
  getDeparture,
  initDeparture,
  restoreDeparture,
  stepDeparture,
} from './departure.js'

export { getDeparture, startDeparture, PHASE as DEPARTURE_PHASE } from './departure.js'

export const BEHAVIOR_VERSION = 1
const TAU = Math.PI * 2
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v) => clamp(v, 0, 1)

/**
 * Tunables. Distances are layer-box pixels (the overlay is ~400 px), speeds are
 * px/s, times are seconds. `speedScale` / `restScale` / `hoverScale` exist so
 * `prefers-reduced-motion` can slow the whole system down without forking it.
 */
export const DEFAULTS = {
  // --- resting ---------------------------------------------------------
  restMin: 4,
  restMax: 14,
  // A minority of rests are much longer; a uniform 4-14 s rest has a beat to it
  // that reads as a machine, a right-skewed one reads as an animal.
  longRestChance: 0.12,
  longRestMin: 18,
  longRestMax: 30,
  // Chance per second of cutting a rest short — "it got bored and left".
  leaveRestRate: 0.06,
  arrivalRestMin: 1.2,
  arrivalRestMax: 2.6,
  // Hover micro-wander (mean-reverting 2D random walk, not a sine).
  hoverMax: 9,
  hoverAccel: 9,
  hoverDamp: 2,
  hoverMaxSpeed: 9,
  // --- cruising --------------------------------------------------------
  // Leg length bands: mostly short hops, a few long crossings.
  cruiseBands: [
    { chance: 0.6, min: 1.5, max: 3 },
    { chance: 0.25, min: 3, max: 4.5 },
    { chance: 0.15, min: 4.5, max: 6.5 },
  ],
  // Speed bands are independent of leg length on purpose: long legs are not
  // always fast, which is what stops the motion looking like a shuttle.
  speedBands: [
    { chance: 0.5, min: 46, max: 66 },
    { chance: 0.4, min: 88, max: 115 },
    { chance: 0.1, min: 150, max: 195 },
  ],
  accel: 260,
  decel: 300,
  // rad/s: a 180 deg re-roll is a turn that takes ~1.5 s, not a snap.
  turnRate: 2.1,
  // rad/sqrt(s): the hand on the wheel is steady but not perfectly so.
  headingNoise: 0.09,
  // Look-ahead used to start turning before the wall arrives.
  wallLookAhead: 0.45,
  // --- settling --------------------------------------------------------
  settleMin: 0.6,
  settleMax: 1.4,
  settleSpeed: 4,
  // --- depth (distance from the viewer) --------------------------------
  // The layer is a flat quad, so "distance" is expressed as scale: depth 0 is
  // the closest (scale 1) and depth 1 the farthest (scale depthFar). The CSS
  // base box is sized for the CLOSEST appearance, so retreat always downsamples
  // (crisp) instead of upscaling a 400 px buffer (blurry).
  depthNear: 1,
  depthFar: 0.45,
  // Apparent size at startup equals the pre-0.9.24 400 px look (500 px base box).
  depthStart: 0.36,
  depthRetargetMin: 3,
  depthRetargetMax: 12,
  depthTau: 2.2,
  // Was 0.02: that much white noise on the distance produced a visible size
  // wobble at display rate ("有点抖动"). The band re-rolls already make the
  // distance organic; the noise only needs to break the perfect exponential.
  depthWander: 0.005,
  // One-pole low-pass between the simulated distance and the rendered one.
  depthViewTau: 0.35,
  // --- distance drives the direction the body faces --------------------
  // A far TARGET is the decision; the turn follows it. Two thresholds so a
  // target sitting on the boundary cannot flap the body back and forth.
  backDepth: 0.6,
  faceDepth: 0.5,
  // Exponential turn, ~1 s time constant: 63% in 1 s, 95% in 3 s, initial rate
  // ~150 deg/s. The departure choreography uses its own S-curve; this one only
  // has to be smooth enough not to snap when the distance decides to turn.
  backTurnTau: 1.0,
  // Depth also lifts and dims a little. A pure resize reads as "someone shrank
  // the picture"; a small rise + falloff reads as "it went away".
  depthLift: 22,
  depthAlpha: 0.82,
  // Most of the time it stays in the near half; a minority of the time it
  // drifts well away, which is what makes an occasional long retreat read as
  // deliberate rather than as a random size wobble.
  depthBands: [
    { chance: 0.7, min: 0.1, max: 0.5 },
    { chance: 0.15, min: 0.5, max: 0.65 },
    { chance: 0.15, min: 0.65, max: 0.95 },
  ],
  // --- host mapping ----------------------------------------------------
  // Matches the divisor the old velocity-differencing code used (px/s -> 0..1).
  swimSpeedRef: 140,
  // Below this the overlay tells the engine "not travelling" so the arms open.
  swimDeadzone: 12,
  // --- scaling ---------------------------------------------------------
  speedScale: 1,
  restScale: 1,
  hoverScale: 1,
  // --- departure -------------------------------------------------------
  // The "turn its back and leave" choreography (see departure.js). It is passed
  // through here so `prefers-reduced-motion` can switch it off without forking
  // the state machine.
  depart: DEPART_DEFAULTS,
}

/** @returns {number} uniform [0,1) and advances the seeded rng in `st` */
function rand(st) {
  st.rng = (st.rng + 0x6d2b79f5) >>> 0
  let t = st.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const randRange = (st, min, max) => min + (max - min) * rand(st)

/** Sum of three uniforms: cheap, bounded, good enough for steering noise. */
const gauss = (st) => (rand(st) + rand(st) + rand(st) - 1.5) * 2

function randAngle(st) {
  return randRange(st, -Math.PI, Math.PI)
}

/** Wrap to (-PI, PI] so `turnToward` always takes the short way round. */
function wrapPi(a) {
  let x = a
  while (x > Math.PI) x -= TAU
  while (x < -Math.PI) x += TAU
  return x
}

function turnToward(from, to, maxStep) {
  return wrapPi(from + clamp(wrapPi(to - from), -maxStep, maxStep))
}

function approach(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta)
  return Math.max(target, current - maxDelta)
}

function pickBand(st, bands) {
  let r = rand(st)
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    if (r < band.chance || i === bands.length - 1) return randRange(st, band.min, band.max)
    r -= band.chance
  }
  const last = bands[bands.length - 1]
  return randRange(st, last.min, last.max)
}

/**
 * @typedef {object} Bounds layer-box pixel bounds for the top-left corner
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * @typedef {object} BehaviorState
 * @property {number} rng       mulberry32 state (uint32), serialised
 * @property {number} seed      original seed, kept for debugging
 * @property {'rest'|'cruise'|'settle'} mode
 * @property {number} timer     seconds left in the current mode
 * @property {number} x         layer top-left, viewport px
 * @property {number} y
 * @property {number} heading   travel heading, screen space (+y is down)
 * @property {number} targetHeading
 * @property {number} speed     px/s (0 unless cruising/settling)
 * @property {number} targetSpeed
 * @property {number} restX     rest anchor (position without the hover offset)
 * @property {number} restY
 * @property {number} driftX    hover offset from the anchor
 * @property {number} driftY
 * @property {number} driftVX
 * @property {number} driftVY
 * @property {number} depth     0 = closest (scale depthNear), 1 = farthest
 * @property {number} depthTarget
 * @property {number} depthTimer seconds until the depth target is re-rolled
 * @property {number} depthView  low-passed depth: what the layer is drawn at
 * @property {number} facing     body facing rad, distance/departure driven
 * @property {boolean} back      hysteresis flag: a far target keeps it turned
 * @property {number} jet       1 for the step that starts a cruise (event flag)
 * @property {string} dpPhase    departure phase, 'idle' when it is not leaving
 * @property {number} dpTimer    seconds left in the current departure phase
 * @property {number} dpDur      duration of the current departure phase
 * @property {number} dpCooldown seconds until the next departure may start
 * @property {number} dpFacing   body facing rad (0 = viewer, π = back turned)
 * @property {number} dpAlpha    extra opacity multiplier (1 = normal)
 * @property {number} dpLift     upward screen offset in px (0 = none)
 * @property {number} dpFarDepth depth target used during RETREAT/FAR
 */

/**
 * @param {{x:number, y:number, seed:number, cfg?:object}} opts
 * @returns {BehaviorState}
 */
export function createBehaviorState({ x = 0, y = 0, seed = 1, cfg = DEFAULTS } = {}) {
  const st = {
    rng: (seed >>> 0) || 1,
    seed: seed >>> 0,
    mode: 'rest',
    timer: 0,
    x,
    y,
    heading: 0,
    targetHeading: 0,
    speed: 0,
    targetSpeed: 0,
    restX: x,
    restY: y,
    driftX: 0,
    driftY: 0,
    driftVX: 0,
    driftVY: 0,
    depth: cfg.depthStart,
    depthTarget: cfg.depthStart,
    depthTimer: 0,
    depthView: cfg.depthStart,
    facing: 0,
    back: false,
    jet: 0,
  }
  st.heading = randAngle(st)
  st.targetHeading = st.heading
  // First rest is short: the creature arrives from the corner and starts moving
  // soon after, instead of idling for 4-14 s right at the edge.
  st.timer = randRange(st, cfg.arrivalRestMin, cfg.arrivalRestMax)
  st.depthTimer = randRange(st, cfg.depthRetargetMin, cfg.depthRetargetMax)
  initDeparture(st, () => rand(st), cfg.depart || DEPART_DEFAULTS)
  return st
}

function beginCruise(st, cfg) {
  st.mode = 'cruise'
  st.targetHeading = randAngle(st)
  st.targetSpeed = pickBand(st, cfg.speedBands) * cfg.speedScale
  st.timer = pickBand(st, cfg.cruiseBands)
  st.jet = 1
}

function beginSettle(st, cfg) {
  st.mode = 'settle'
  st.targetSpeed = 0
  st.timer = randRange(st, cfg.settleMin, cfg.settleMax)
}

function beginRest(st, cfg) {
  st.mode = 'rest'
  st.speed = 0
  st.targetSpeed = 0
  st.restX = st.x
  st.restY = st.y
  st.driftX = 0
  st.driftY = 0
  st.driftVX = 0
  st.driftVY = 0
  const long = rand(st) < cfg.longRestChance
  const min = long ? cfg.longRestMin : cfg.restMin
  const max = long ? cfg.longRestMax : cfg.restMax
  // u^1.7 skews the sample toward the short end: most rests are short, a few
  // linger. Multiplying the whole rest by restScale keeps the shape intact.
  const u = Math.pow(rand(st), 1.7)
  st.timer = (min + (max - min) * u) * cfg.restScale
}

function clampToBounds(st, bounds) {
  const minX = Math.min(bounds.minX, bounds.maxX)
  const maxX = Math.max(bounds.minX, bounds.maxX)
  const minY = Math.min(bounds.minY, bounds.maxY)
  const maxY = Math.max(bounds.minY, bounds.maxY)

  if (st.x < minX || st.x > maxX) {
    st.x = clamp(st.x, minX, maxX)
    // Turn away from the wall. Reflecting the CURRENT heading (not just the
    // target) keeps a clamped creature from grinding against the edge while it
    // spends a second turning round.
    st.heading = wrapPi(Math.PI - st.heading) + randRange(st, -0.22, 0.22)
    st.targetHeading = st.heading
    if (st.mode === 'rest') {
      st.restX = clamp(st.restX, minX, maxX)
      st.driftVX = 0
    }
  }
  if (st.y < minY || st.y > maxY) {
    st.y = clamp(st.y, minY, maxY)
    st.heading = wrapPi(-st.heading) + randRange(st, -0.22, 0.22)
    st.targetHeading = st.heading
    if (st.mode === 'rest') {
      st.restY = clamp(st.restY, minY, maxY)
      st.driftVY = 0
    }
  }
}

function stepRest(st, dt, bounds, cfg) {
  st.timer -= dt
  // Mean-reverting 2D random walk (Ornstein-Uhlenbeck). Slow, organic, and —
  // unlike a sine — it does not retrace the same little ellipse in place.
  const sigma = cfg.hoverAccel * cfg.hoverScale
  st.driftVX += -cfg.hoverDamp * st.driftVX * dt + gauss(st) * sigma * Math.sqrt(dt)
  st.driftVY += -cfg.hoverDamp * st.driftVY * dt + gauss(st) * sigma * Math.sqrt(dt)
  const maxV = cfg.hoverMaxSpeed * cfg.hoverScale
  st.driftVX = clamp(st.driftVX, -maxV, maxV)
  st.driftVY = clamp(st.driftVY, -maxV, maxV)
  const maxOffset = cfg.hoverMax * cfg.hoverScale
  st.driftX = clamp(st.driftX + st.driftVX * dt, -maxOffset, maxOffset)
  st.driftY = clamp(st.driftY + st.driftVY * dt, -maxOffset, maxOffset)
  st.x = st.restX + st.driftX
  st.y = st.restY + st.driftY

  // A departure is a deliberate exit: the base wander must not "get bored" in
  // the middle of it and start a cruise leg. (The timer is held by stepBehavior;
  // this is the other half — the random early-leave roll.)
  const holding = st.dpPhase !== DEPART_PHASE.IDLE
  if (st.timer <= 0 || (!holding && rand(st) < cfg.leaveRestRate * dt)) {
    // Clamp before leaving: the hover offset can put the layer past a wall on
    // the exact frame a rest ends, and the cruise branch would only fix it one
    // frame later (one out-of-bounds sample).
    clampToBounds(st, bounds)
    beginCruise(st, cfg)
    return
  }
  clampToBounds(st, bounds)
}

function stepCruise(st, dt, bounds, cfg) {
  st.timer -= dt
  // A slow brownian wobble on the heading, then a rate-limited turn toward the
  // heading that was re-rolled when this leg started.
  st.heading = wrapPi(st.heading + gauss(st) * cfg.headingNoise * Math.sqrt(dt))
  st.heading = turnToward(st.heading, st.targetHeading, cfg.turnRate * dt)
  const rate = st.targetSpeed > st.speed ? cfg.accel : cfg.decel
  st.speed = approach(st.speed, st.targetSpeed, rate * dt)

  // Start turning before the wall arrives, otherwise a fast leg slams into the
  // edge and the clamp does the steering.
  const lookAhead = cfg.wallLookAhead * st.speed + 8
  const aheadX = st.x + Math.cos(st.heading) * lookAhead
  const aheadY = st.y + Math.sin(st.heading) * lookAhead
  if (aheadX < bounds.minX || aheadX > bounds.maxX) {
    st.targetHeading = wrapPi(Math.PI - st.heading) + randRange(st, -0.25, 0.25)
  }
  if (aheadY < bounds.minY || aheadY > bounds.maxY) {
    st.targetHeading = wrapPi(-st.heading) + randRange(st, -0.25, 0.25)
  }

  st.x += Math.cos(st.heading) * st.speed * dt
  st.y += Math.sin(st.heading) * st.speed * dt

  if (st.timer <= 0) {
    beginSettle(st, cfg)
    // The step that ends a leg still moved the layer; clamp before returning so
    // a leg that ends right at a wall cannot leave one frame out of bounds.
    clampToBounds(st, bounds)
    return
  }
  clampToBounds(st, bounds)
}

function stepSettle(st, dt, cfg) {
  st.timer -= dt
  st.speed = approach(st.speed, 0, cfg.decel * dt)
  st.heading = wrapPi(st.heading + gauss(st) * 0.04 * Math.sqrt(dt))
  st.x += Math.cos(st.heading) * st.speed * dt
  st.y += Math.sin(st.heading) * st.speed * dt
}

/**
 * Depth is its own slow dimension: it re-targets every few seconds, then drifts
 * toward the target with a time constant, plus a little noise. It runs in every
 * mode (rest included), because "how far away it is" is a different axis from
 * "is it travelling".
 */
function stepDepth(st, dt, cfg) {
  // While a departure is active IT owns the depth target (freeze during the
  // turn, far during the retreat, near on the way back); the band re-roll would
  // fight it.
  if (st.dpPhase === DEPART_PHASE.IDLE) {
    st.depthTimer -= dt
    if (st.depthTimer <= 0) {
      st.depthTarget = pickBand(st, cfg.depthBands)
      st.depthTimer = randRange(st, cfg.depthRetargetMin, cfg.depthRetargetMax)
    }
  }
  // Exponential approach: no snap, and independent of the frame rate.
  st.depth += (st.depthTarget - st.depth) * (1 - Math.exp(-dt / cfg.depthTau))
  st.depth += gauss(st) * cfg.depthWander * Math.sqrt(dt)
  st.depth = clamp01(st.depth)
  // The rendered distance gets its own low-pass: white noise in the state is
  // fine for statistics, but each pixel of it is a size change on screen.
  const viewTau = cfg.depthViewTau
  if (viewTau > 0) st.depthView += (st.depth - st.depthView) * (1 - Math.exp(-dt / viewTau))
  else st.depthView = st.depth
  st.depthView = clamp01(st.depthView)
}

/**
 * Which way the body faces. Two drivers, in priority order:
 *
 *  1. a departure owns the turn (it turns at close range, then withdraws);
 *  2. otherwise DISTANCE owns it — a far target turns the back, a near one
 *     turns it back toward the viewer. That is the whole answer to "为什么它
 *     缩小的时候不背对我": going away and facing away are the same decision.
 *
 * Thresholds are hysteretic so a target sitting on the boundary cannot flap.
 */
function stepFacing(st, dt, cfg) {
  const depCfg = cfg.depart || DEPART_DEFAULTS
  if (st.dpPhase !== DEPART_PHASE.IDLE) {
    st.facing = st.dpFacing
    st.back = st.dpPhase !== DEPART_PHASE.RETURN
    return
  }
  if (depCfg.enabled === false) {
    st.back = false
    st.facing += (0 - st.facing) * (1 - Math.exp(-dt / cfg.backTurnTau))
    return
  }
  if (st.depthTarget >= cfg.backDepth) st.back = true
  else if (st.depthTarget <= cfg.faceDepth) st.back = false
  const target = st.back ? Math.PI : 0
  st.facing += (target - st.facing) * (1 - Math.exp(-dt / (cfg.backTurnTau > 0 ? cfg.backTurnTau : 0.55)))
}

/**
 * Advance the wander by `dt` seconds. Mutates and returns `st`.
 * @param {BehaviorState} st
 * @param {number} dt seconds
 * @param {Bounds} bounds
 * @param {object} [cfg]
 * @returns {BehaviorState}
 */
export function stepBehavior(st, dt, bounds, cfg = DEFAULTS) {
  st.jet = 0
  const step = clamp(dt, 0, 0.1)
  if (!(step > 0)) return st

  const departCfg = cfg.depart || DEPART_DEFAULTS
  // The departure runs first: it owns the depth target while it is active, and
  // it may raise `jet` this step (the push-off at the start of the retreat).
  stepDeparture(st, step, departCfg, () => rand(st))
  // While it is turned away and withdrawing, the base wander must not decide to
  // set off. Holding the rest timer keeps it in REST — which is also what keeps
  // the arms open at FAR, so the figure reads as floating rather than fleeing.
  if (st.dpPhase !== DEPART_PHASE.IDLE && st.mode === 'rest') st.timer = Math.max(st.timer, 0.25)

  stepDepth(st, step, cfg)
  stepFacing(st, step, cfg)

  if (st.mode === 'cruise') {
    stepCruise(st, step, bounds, cfg)
  } else if (st.mode === 'settle') {
    stepSettle(st, step, cfg)
    if (st.timer <= 0 || st.speed < cfg.settleSpeed) beginRest(st, cfg)
    clampToBounds(st, bounds)
  } else {
    if (st.mode !== 'rest') st.mode = 'rest'
    stepRest(st, step, bounds, cfg)
  }
  return st
}

/**
 * Keep an existing state inside bounds. Used on resize (and by restore) so a
 * viewport change can never leave the layer parked off-screen.
 * @param {BehaviorState} st
 * @param {Bounds} bounds
 * @returns {BehaviorState}
 */
export function clampBehavior(st, bounds) {
  clampToBounds(st, bounds)
  st.depth = clamp01(Number.isFinite(st.depth) ? st.depth : DEFAULTS.depthStart)
  st.depthView = clamp01(Number.isFinite(st.depthView) ? st.depthView : st.depth)
  st.facing = clamp(Number.isFinite(st.facing) ? st.facing : 0, -Math.PI, Math.PI)
  st.back = st.back === true
  st.dpFacing = clamp(Number.isFinite(st.dpFacing) ? st.dpFacing : 0, -Math.PI, Math.PI)
  st.dpAlpha = clamp01(Number.isFinite(st.dpAlpha) ? st.dpAlpha : 1)
  st.dpLift = clamp(Number.isFinite(st.dpLift) ? st.dpLift : 0, 0, DEPART_DEFAULTS.liftMax)
  if (st.mode === 'rest') {
    // Re-anchor at the position we just clamped to and drop the hover offset,
    // so the layer does not jump by driftX on the next frame.
    st.restX = st.x
    st.restY = st.y
    st.driftX = 0
    st.driftY = 0
    st.driftVX = 0
    st.driftVY = 0
  }
  return st
}

/**
 * Map the wander onto the engine's `setSwim(vx, vy, amount)` contract.
 * While resting the amount is 0, which is what lets the arms open up (the
 * shader's web only shows through when the crown is splayed).
 * @param {BehaviorState} st
 * @param {object} [cfg]
 * @returns {{x:number, y:number, amount:number}}
 */
export function getSwim(st, cfg = DEFAULTS) {
  if (st.mode === 'rest' || st.speed < cfg.swimDeadzone) {
    return { x: Math.cos(st.heading), y: Math.sin(st.heading), amount: 0 }
  }
  return {
    x: Math.cos(st.heading),
    y: Math.sin(st.heading),
    amount: clamp01(st.speed / cfg.swimSpeedRef),
  }
}

/**
 * Map depth (0 = closest, 1 = farthest) onto the layer's CSS scale.
 * Linear on purpose: a curved mapping made small depth changes near the far end
 * invisible, and the creature spends most of its time in the near half.
 * Uses the low-passed depth, so the size the eye sees never carries the state's
 * frame-to-frame noise.
 * @param {BehaviorState} st
 * @param {object} [cfg]
 * @returns {number} scale in [depthFar, depthNear]
 */
export function depthScale(st, cfg = DEFAULTS) {
  const raw = Number.isFinite(st.depthView) ? st.depthView : st.depth
  const d = clamp01(Number.isFinite(raw) ? raw : 0)
  return cfg.depthNear + (cfg.depthFar - cfg.depthNear) * d
}

/**
 * Everything the overlay layer needs for one frame. The departure's numbers are
 * the more extreme of the two while it is active, so a departure is always at
 * least as turned / lifted / dimmed as the distance would have made it.
 * @param {BehaviorState} st
 * @param {object} [cfg]
 * @returns {{active:boolean, phase:string, facing:number, lift:number, alpha:number}}
 */
export function getView(st, cfg = DEFAULTS) {
  const dep = getDeparture(st)
  const depth = clamp01(Number.isFinite(st.depthView) ? st.depthView : st.depth)
  const liftFromDepth = depth * (cfg.depthLift || 0)
  const alphaFromDepth = 1 - depth * (1 - (cfg.depthAlpha == null ? 1 : cfg.depthAlpha))
  return {
    active: dep.active,
    phase: dep.phase,
    facing: Number.isFinite(st.facing) ? st.facing : dep.facing,
    lift: Math.max(dep.lift, liftFromDepth),
    alpha: Math.min(dep.alpha, clamp01(alphaFromDepth)),
  }
}

/**
 * Serialise to a JSON-safe object. Numbers are rounded: sub-0.01 px precision
 * is invisible and would only churn localStorage on every save.
 * @param {BehaviorState} st
 * @returns {object}
 */
export function serializeBehavior(st) {
  const r2 = (v) => Math.round(v * 100) / 100
  // Timers are clamped to a floor before rounding: a value that rounds to 0
  // would be bumped to the restore floor and make the payload non-idempotent
  // (serialise(restore(x)) != x), which the persistence test checks.
  const rTimer = (v) => Math.max(0.05, r2(v))
  return {
    v: BEHAVIOR_VERSION,
    rng: st.rng >>> 0,
    seed: st.seed >>> 0,
    mode: st.mode,
    timer: rTimer(st.timer),
    x: r2(st.x),
    y: r2(st.y),
    heading: r2(st.heading),
    targetHeading: r2(st.targetHeading),
    speed: r2(st.speed),
    targetSpeed: r2(st.targetSpeed),
    restX: r2(st.restX),
    restY: r2(st.restY),
    driftX: r2(st.driftX),
    driftY: r2(st.driftY),
    driftVX: r2(st.driftVX),
    driftVY: r2(st.driftVY),
    depth: r2(st.depth),
    depthTarget: r2(st.depthTarget),
    depthTimer: rTimer(st.depthTimer),
    depthView: r2(st.depthView == null ? st.depth : st.depthView),
    facing: r2(st.facing || 0),
    back: st.back === true,
    // Departure state is nested so a payload from before this feature simply
    // lacks the key and restores as idle (see restoreDeparture).
    dp: {
      phase: st.dpPhase || 'idle',
      timer: rTimer(st.dpTimer || 0),
      dur: r2(st.dpDur || 0),
      cooldown: r2(Math.max(0, st.dpCooldown || 0)),
      facing: r2(st.dpFacing || 0),
      facingFrom: r2(st.dpFacingFrom || 0),
      alpha: r2(st.dpAlpha == null ? 1 : st.dpAlpha),
      lift: r2(st.dpLift || 0),
      farDepth: r2(st.dpFarDepth || 0),
    },
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * Rebuild a state from storage. Any missing/invalid field falls back to a fresh
 * wander rather than throwing — stored data is user-editable and versioned.
 * @param {unknown} raw parsed JSON
 * @param {Bounds} bounds
 * @param {object} [cfg]
 * @returns {BehaviorState|null} null when the payload is unusable
 */
export function restoreBehavior(raw, bounds, cfg = DEFAULTS) {
  if (raw == null || typeof raw !== 'object') return null
  const src = /** @type {Record<string, unknown>} */ (raw)
  if (src.v !== BEHAVIOR_VERSION) return null
  const mode = src.mode === 'cruise' || src.mode === 'settle' || src.mode === 'rest' ? src.mode : null
  if (mode == null) return null
  const keys = [
    'x',
    'y',
    'heading',
    'targetHeading',
    'speed',
    'targetSpeed',
    'restX',
    'restY',
    'driftX',
    'driftY',
    'driftVX',
    'driftVY',
    'timer',
  ]
  for (const key of keys) {
    if (!isNum(src[key])) return null
  }
  if (!isNum(src.rng)) return null
  // Depth arrived in 0.9.24. Payloads written before it are still v1, so the
  // three depth fields are optional and fall back to the default distance
  // instead of rejecting a perfectly resumable wander.
  const hasDepth = isNum(src.depth) && isNum(src.depthTarget) && isNum(src.depthTimer)
  const st = {
    rng: (src.rng >>> 0) || 1,
    seed: isNum(src.seed) ? src.seed >>> 0 : 1,
    mode,
    timer: Math.max(0.05, src.timer),
    x: src.x,
    y: src.y,
    heading: src.heading,
    targetHeading: src.targetHeading,
    speed: mode === 'rest' ? 0 : Math.max(0, src.speed),
    targetSpeed: Math.max(0, src.targetSpeed),
    restX: src.restX,
    restY: src.restY,
    driftX: src.driftX,
    driftY: src.driftY,
    driftVX: src.driftVX,
    driftVY: src.driftVY,
    depth: hasDepth ? clamp01(src.depth) : cfg.depthStart,
    depthTarget: hasDepth ? clamp01(src.depthTarget) : cfg.depthStart,
    depthTimer: hasDepth ? Math.max(0.05, src.depthTimer) : cfg.depthRetargetMin,
    // Rendered distance and facing arrived in 0.9.26: payloads from before are
    // still v1, so they restore to the (unfiltered) depth and to facing forward.
    depthView: isNum(src.depthView) ? clamp01(src.depthView) : hasDepth ? clamp01(src.depth) : cfg.depthStart,
    facing: isNum(src.facing) ? clamp(src.facing, -Math.PI, Math.PI) : 0,
    back: src.back === true,
    jet: 0,
  }
  restoreDeparture(st, src.dp, cfg.depart || DEPART_DEFAULTS)
  clampToBounds(st, bounds)
  return st
}
