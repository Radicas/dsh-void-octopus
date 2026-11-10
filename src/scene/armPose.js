/**
 * Pure arm-pose solver.
 *
 * This module exists to be testable. The sway/stroke/drift/trail stack used to
 * live inline in the render closure, so no test could reach it — which is how
 * two separate `sin(t · f(t))` phase bugs shipped (`strokePhase` in 0.9.11 and
 * `waveOffset` in 0.9.15). Keeping the math pure lets test/armPose.test.mjs
 * assert invariants that would have caught both.
 *
 * Rules this module must keep:
 *  - Every angle handed to sin/cos is either a constant frequency times the
 *    clock, or an ACCUMULATED phase. Never `clock * state`.
 *  - `out` holds ARM_COUNT * POINTS_PER_ARM points, laid out arm-major.
 */

export const ARM_COUNT = 8
export const POINTS_PER_ARM = 8
export const TAU = Math.PI * 2

/**
 * @typedef {object} ArmPoseInput
 * @property {number} time          accumulated animation clock (seconds)
 * @property {number} strokePhase   accumulated travelling-stroke phase (radians)
 * @property {number} waveOffset    accumulated crown-ripple offset (radians)
 * @property {number} effort        blended host motion + body momentum, 0..~1.6
 * @property {number} swimX         unit x of travel direction, body space
 * @property {number} swimY         unit y of travel direction, body space
 * @property {number} yaw           body yaw (radians)
 * @property {number} jetSurge      0..1 jet envelope value
 * @property {number} pulse         0..1 glow pulse
 * @property {number} stretch       0..1 overall stretch action
 * @property {number} coil          0..1 whole-crown contraction
 * @property {ArrayLike<number>} armCurl  per-arm curl, length 8
 * @property {number} [turnLag]     rad the arms' yaw trails the body's (signed)
 * @property {number} [turnBrace]   0..1 how hard the arms are bracing in a turn
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Wrap to (-PI, PI] so a yaw delta is always taken the short way round. */
const wrapPi = (a) => {
  let x = (a + Math.PI) % TAU
  if (x < 0) x += TAU
  return x - Math.PI
}

/**
 * Rotation weight along one arm, root -> tip.
 *
 * The root (point 0) sits INSIDE the mantle and must travel with the body: a
 * root that lagged would tear the arm out of the body and would also eat into
 * the 1.15x neighbour-gap invariant. Everything the eye reads as "the tentacles
 * slide" happens further out, so the lag is weighted in as `u ** 1.4`.
 */
const LAG_WEIGHT = new Float64Array(POINTS_PER_ARM)
for (let i = 0; i < POINTS_PER_ARM; i++) {
  LAG_WEIGHT[i] = Math.pow(i / (POINTS_PER_ARM - 1), 1.4)
}

/**
 * The crown's own yaw: a damped torsional follower that trails the body's.
 *
 * Why this exists (0.9.28). The body yaw is applied in the shader as a view
 * rotation, so before this the arms had no way to know the body was turning —
 * the whole creature rotated as one rigid piece. On screen that reads as "a
 * picture being turned around", not "an animal turning itself". A real octopus
 * turns with its mantle and its arms are towed: their angular rate differs from
 * the body's, the difference is largest at the tips, and it is still draining
 * away after the body has stopped.
 *
 * Steady state: while the body turns at `rate`, the arms sit `tau * rate`
 * behind it. When the body stops, the target returns to zero and the deliberately
 * under-damped spring (zeta < 1) carries the arms PAST neutral once before they
 * settle — that single overshoot is the "they keep sliding for a moment" read.
 */
export const TURN_LAG_DEFAULTS = {
  tau: 0.13, // s: steady-state trail per rad/s of body yaw rate
  omega: 7.0, // rad/s: natural frequency of the lag spring
  zeta: 0.38, // damping ratio: < 1 on purpose; the settle-back overshoots once
  limit: 0.3, // rad: soft cap (arm tips are ~1.8 out, so 0.3 rad is ~0.54 units)
  rateSmooth: 14, // 1/s: one-pole low-pass on the measured yaw rate
  substeps: 2,
}

/**
 * @param {object} [opts] overrides for TURN_LAG_DEFAULTS
 * @returns {{lag:number, vel:number, yawRate:number, lastYaw:number, brace:number}}
 */
export function createTurnLag(opts) {
  return Object.assign(
    { lag: 0, vel: 0, yawRate: 0, lastYaw: 0, brace: 0 },
    TURN_LAG_DEFAULTS,
    opts || {},
  )
}

/**
 * Advance the lag spring by `dt` toward the body yaw `yaw`. Mutates `st`.
 *
 * The measured rate is low-passed before it drives the target: a dropped frame
 * otherwise turns one stiff body step into a spike in the arms, which is the
 * opposite of "towed". Semi-implicit Euler in `substeps` passes, so a 20 fps
 * frame (dt = 0.05) integrates the same spring as 120 fps does.
 *
 * @param {object} st state from createTurnLag
 * @param {number} yaw current body yaw (radians)
 * @param {number} dt seconds
 * @returns {number} the lag to hand to computeArmTargets, radians (signed)
 */
export function stepTurnLag(st, yaw, dt) {
  if (!(dt > 0)) return st.lag
  const healthy = Number.isFinite(yaw) ? yaw : st.lastYaw
  const dYaw = wrapPi(healthy - st.lastYaw)
  st.lastYaw = healthy
  // A teleport (debug `face(180)`, a restored state mid-turn) must not kick the
  // spring with a 30 rad/s spike; the engine's own damping already limits real
  // turns to a few rad/s.
  const raw = clamp(dYaw / Math.max(dt, 1e-3), -8, 8)
  st.yawRate += (raw - st.yawRate) * (1 - Math.exp(-st.rateSmooth * dt))
  // Soft saturation, not a clamp: a clamp makes the arms freeze at the cap for
  // as long as a violent yaw lasts, which reads as a mechanism hitting a stop.
  // tanh keeps the response continuous and only bites on extreme turn rates.
  const target = st.limit * Math.tanh((-st.tau * st.yawRate) / st.limit)
  const steps = Math.max(1, Math.round(st.substeps))
  const h = dt / steps
  const w2 = st.omega * st.omega
  const c = 2 * st.zeta * st.omega
  for (let i = 0; i < steps; i++) {
    st.vel += ((target - st.lag) * w2 - st.vel * c) * h
    st.lag = clamp(st.lag + st.vel * h, -st.limit, st.limit)
  }
  if (Math.abs(st.lag) > st.limit) st.lag = clamp(st.lag, -st.limit, st.limit)
  st.brace = clamp01((Math.abs(st.lag) - 0.02) / (st.limit - 0.02))
  return st.lag
}

/**
 * Write all control points for one frame.
 * @param {Array<{x:number,y:number,z:number}>} out 64 mutable points
 * @param {ArmPoseInput} s
 * @returns {void}
 */
export function computeArmTargets(out, s) {
  const effort = s.effort
  const swimPose = clamp01(effort * (0.55 + 0.45 * s.jetSurge))
  const coilK = 1 - s.coil * 0.44
  const cosYaw = Math.cos(s.yaw)
  const sinYaw = Math.sin(s.yaw)
  const trailX = -s.swimX * cosYaw
  const trailY = s.swimY
  const trailZ = -s.swimX * sinYaw
  const strokePhase = s.strokePhase
  const waveOffset = s.waveOffset
  const t = s.time
  const armCurl = s.armCurl
  const pulse = s.pulse
  const jetSurge = s.jetSurge
  const stretch = s.stretch
  // Turn lag is solved OUTSIDE (stepTurnLag) and arrives as an angle. Zero while
  // the body is not turning, and then the whole block below costs one branch.
  const turnLag = Number.isFinite(s.turnLag) ? s.turnLag : 0
  const turnBrace = clamp01(
    s.turnBrace != null && Number.isFinite(s.turnBrace)
      ? s.turnBrace
      : Math.abs(turnLag) / TURN_LAG_DEFAULTS.limit,
  )
  const lagActive = Math.abs(turnLag) > 1e-4

  for (let k = 0; k < ARM_COUNT; k++) {
    const angle = (k / ARM_COUNT) * TAU + 0.22
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const phase = k * 1.7 + waveOffset
    const sway = Math.sin(t * 1.0 + phase) * 0.18
    const sway2 = Math.cos(t * 0.8 + phase * 1.3) * 0.12
    const length = 0.9 + 0.1 * Math.sin(k * 2.3)
    const pose = Math.sin(k * 1.7 + 0.4)
    const lift = pose > 0.35 ? 0.22 : 0.0
    const curl = armCurl[k]
    const flare = pulse * 0.03 * (1 - swimPose * 0.75)
    const stretchK = 1 + stretch * 0.13
    const base = k * POINTS_PER_ARM
    const stream = 1 - effort * 0.3
    // The root does NOT streamline as hard as the rest of the arm. A real
    // octopus swimming keeps the crown splayed into a bell and only draws the
    // outer length in; contracting the root too made neighbouring arms
    // overlap at the first free segment (measured 0.85x the sum of their
    // radii), which is what read as clipping.
    const streamRoot = 1 - effort * 0.08
    const jetStream = 1 - jetSurge * 0.18
    const liftK = 1 - swimPose * 0.85
    const curlK = 1 - swimPose * 0.75
    const tipDrop = swimPose * (0.5 + jetSurge * 0.25)
    const trailBias = 0.85 + 0.15 * Math.sin(k * 1.7 + 0.4)

    const p0x = c * 0.32
    const p0y = 0.2
    const p0z = sn * 0.32
    const p1x = c * (1.1 + sway * 0.2) * stretchK * streamRoot * coilK
    const p1y = -0.55 * length
    const p1z = sn * (1.1 + sway * 0.2) * stretchK * streamRoot * coilK
    const p2x = c * (1.65 + sway * 0.4 + flare) * stretchK * stream * jetStream * coilK
    const p2y = (-0.75 + lift * 0.5 * liftK + curl * 0.4 * curlK - tipDrop * 0.15) * length
    const p2z = sn * (1.65 + sway * 0.4 + flare) * stretchK * stream * jetStream * coilK
    const tangentX = -sn
    const tangentZ = c
    const p3x =
      (c * (1.8 + sway2 * 0.3 + flare * 1.2) * stretchK * stream * jetStream +
        tangentX * (0.16 + curl * 0.12) * (1 - swimPose * 0.6)) *
      coilK
    const p3y = (-0.08 + lift * 1.2 * liftK + curl * 0.85 * curlK - tipDrop) * length
    const p3z =
      (sn * (1.8 + sway2 * 0.3 + flare * 1.2) * stretchK * stream * jetStream +
        tangentZ * (0.16 + curl * 0.12) * (1 - swimPose * 0.6)) *
      coilK

    for (let i = 0; i < POINTS_PER_ARM; i++) {
      const u = i / (POINTS_PER_ARM - 1)
      const v = 1 - u
      const b0 = v * v * v
      const b1 = 3 * v * v * u
      const b2 = 3 * v * u * u
      const b3 = u * u * u
      let x = b0 * p0x + b1 * p1x + b2 * p2x + b3 * p3x
      let y = b0 * p0y + b1 * p1y + b2 * p2y + b3 * p3y
      let z = b0 * p0z + b1 * p1z + b2 * p2z + b3 * p3z

      // A travelling stroke runs from root to tip. At speed it gets larger, but
      // the tip is always behind the root so the arm reads as a whip.
      const stroke =
        Math.sin(strokePhase + phase - i * 0.55) * (0.008 + i * 0.009) * (0.55 + swimPose * 2.2)
      x += tangentX * stroke
      y += stroke * 0.4
      z += tangentZ * stroke

      // Slow omnidirectional drift: vacuum has no preferred "down", so every
      // point wanders on its own phase and never quite settles.
      const drift =
        Math.sin(t * 0.31 + phase * 0.7 + i * 0.42) * (0.006 + i * 0.006) * (0.55 + swimPose * 0.45)
      x += tangentX * drift
      y += drift * 0.3
      z += tangentZ * drift

      // Trail opposite the actual travel direction, in body space.
      const drag = Math.pow(i / (POINTS_PER_ARM - 1), 1.8) * (0.42 + jetSurge * 0.5) * swimPose * trailBias
      x += trailX * drag
      y += trailY * drag
      z += trailZ * drag

      // The arms' yaw trails the body's: rotate this point about the body Y axis
      // by `turnLag * weight`. Root stays with the mantle, tip is towed furthest.
      // Applied to the finished point (not to the control polygon) because the
      // twist has to survive the stroke/drift/trail offsets above — they are
      // part of the arm, not of the body frame.
      //
      // The brace sink is vertical-only and identical for every arm at a given
      // point index. That is deliberate: it keeps neighbouring arms rigidly
      // related, so the "adjacent gap >= 1.15x sum of radii" invariant holds
      // EXACTLY at the maximum lag instead of being eroded by the fix.
      if (lagActive) {
        const a = turnLag * LAG_WEIGHT[i]
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const nx = x * ca + z * sa
        const nz = -x * sa + z * ca
        x = nx
        z = nz
        y -= turnBrace * 0.08 * LAG_WEIGHT[i]
      }

      const point = out[base + i]
      point.x = x
      point.y = y
      point.z = z
    }
  }
}

/**
 * Advance the travelling-stroke phase. The cadence may drift with effort, but it
 * is ACCUMULATED: the instantaneous rate is then exactly the cadence, with no
 * dependence on how long the page has been open.
 * @param {number} phase current phase
 * @param {number} dt seconds
 * @param {number} swimPose 0..1
 * @param {number} jetSurge 0..1
 * @returns {number} next phase
 */
export function advanceStrokePhase(phase, dt, swimPose, jetSurge) {
  return phase + dt * (2.0 + swimPose * 1.5 + jetSurge * 0.5)
}

/**
 * Advance the crown-ripple offset. The amplitude scales the RATE, never the
 * phase itself — `clock * amplitude` is the bug this whole file exists to
 * prevent.
 * @param {number} offset current offset
 * @param {number} dt seconds
 * @param {number} waveAmount 0..1
 * @returns {number} next offset
 */
export function advanceWaveOffset(offset, dt, waveAmount) {
  return offset + dt * 1.5 * waveAmount
}
