/**
 * Departure invariants: the one choreography that leaves screen space.
 *
 * The wander tests (behavior.test.mjs) assert how it crosses the screen with the
 * departure disabled. This suite asserts the choreography itself: the phase
 * order, how long the turn takes and how fast it may swing, that the depth and
 * opacity really follow it, that it comes home, that it persists through a
 * reload, and that the whole thing is off when the layer says so.
 */

import { DEFAULTS as DEPART_DEFAULTS, PHASE, startDeparture, getDeparture } from '../src/scene/departure.js'
import { DEFAULTS, createBehaviorState, stepBehavior, serializeBehavior, restoreBehavior, getView } from '../src/scene/behavior.js'

const BOX = { minX: 12, minY: 12, maxX: 1028, maxY: 488 }
const DT = 1 / 30

let failures = 0
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

/** Drive the real loop and record everything the choreography promises. */
function run({ seed = 5, seconds = 420, dt = DT, cfg = DEFAULTS } = {}) {
  const st = createBehaviorState({ x: 500, y: 220, seed, cfg })
  const steps = Math.round(seconds / dt)
  const log = []
  const transitions = []
  const starts = []
  let nan = false
  let outOfBox = 0
  let jetSteps = 0
  let maxFacing = 0
  let maxFacingStep = 0
  let maxAlpha = 0
  let minAlpha = 1
  let maxLift = 0
  let minLift = 0
  let restViolations = 0
  let lastFacing = 0

  for (let i = 0; i < steps; i++) {
    const before = st.dpPhase
    stepBehavior(st, dt, BOX, cfg)
    const t = (i + 1) * dt

    if (st.dpPhase !== before) {
      transitions.push({
        t,
        from: before,
        to: st.dpPhase,
        facing: st.facing,
        alpha: st.dpAlpha,
        lift: st.dpLift,
        depth: st.depth,
        depthTarget: st.depthTarget,
      })
      // A departure may begin with PREP or straight with TURN, so count the
      // transition out of idle, not one phase name.
      if (before === PHASE.IDLE && st.dpPhase !== PHASE.IDLE) starts.push(t)
    }

    if (st.dpPhase !== PHASE.IDLE) {
      if (st.mode !== 'rest') restViolations++
      maxFacing = Math.max(maxFacing, Math.abs(st.facing))
      maxFacingStep = Math.max(maxFacingStep, Math.abs(st.facing - lastFacing))
      maxAlpha = Math.max(maxAlpha, st.dpAlpha)
      minAlpha = Math.min(minAlpha, st.dpAlpha)
      maxLift = Math.max(maxLift, st.dpLift)
      minLift = Math.min(minLift, st.dpLift)
    }
    lastFacing = st.facing

    if (!Number.isFinite(st.x) || !Number.isFinite(st.y) || !Number.isFinite(st.facing) || !Number.isFinite(st.depth)) nan = true
    if (st.x < BOX.minX - 0.75 || st.x > BOX.maxX + 0.75 || st.y < BOX.minY - 0.75 || st.y > BOX.maxY + 0.75) outOfBox++

    if (st.jet) jetSteps++
    log.push({ phase: st.dpPhase, facing: st.facing, alpha: st.dpAlpha, lift: st.dpLift, depth: st.depth, mode: st.mode })
  }

  return {
    st,
    log,
    transitions,
    starts,
    nan,
    outOfBox,
    jetSteps,
    maxFacing,
    maxFacingStep,
    maxAlpha,
    minAlpha,
    maxLift,
    minLift,
    restViolations,
  }
}

const at = (r, name) => r.transitions.filter((x) => x.to === name)
const serial = (st) => JSON.stringify(serializeBehavior(st))

console.log('departure: turning its back and leaving')
console.log('')

// ---------------------------------------------------------------- it departs
console.log('1) it actually leaves, in the designed order, and comes home neutral')
{
  const r = run({ seed: 5 })
  check('no NaN', !r.nan)
  check('stays inside the viewport', r.outOfBox === 0, `${r.outOfBox} samples out`)
  check('at least two departures in 7 min', r.starts.length >= 2, `${r.starts.length} departures`)
  check(
    'reaches (nearly) a full back turn',
    r.maxFacing >= Math.PI * 0.87 && r.maxFacing <= Math.PI + 1e-6,
    `${r.maxFacing.toFixed(3)} rad`,
  )

  const order = r.transitions.map((x) => x.to)
  // PREP is optional now (it sometimes just turns), so compare the phases after
  // whichever comes first of prep/turn.
  const first = order.indexOf(PHASE.TURN)
  const prefix = order.slice(first, first + 5)
  check(
    'phase order [prep?]>turn>retreat>far>return>idle',
    first >= 0 && prefix.join('>') === [PHASE.TURN, PHASE.RETREAT, PHASE.FAR, PHASE.RETURN, PHASE.IDLE].join('>'),
    prefix.join(' > '),
  )

  const homes = at(r, PHASE.IDLE)
  // The last departure may still be in flight when the window closes.
  check('every departure comes home', homes.length >= r.starts.length - 1, `${homes.length} home calls / ${r.starts.length} departures`)
  check(
    'home is neutral: facing 0, alpha 1, no lift',
    homes.every((h) => Math.abs(h.facing) < 0.06 && h.alpha > 0.999 && h.lift < 1e-6),
    homes.map((h) => `${h.facing.toFixed(2)}/${h.alpha.toFixed(2)}/${h.lift.toFixed(0)}`).join(' '),
  )
  check('the opacity really dipped on the way out', r.minAlpha <= DEPART_DEFAULTS.alphaFar + 1e-6, r.minAlpha.toFixed(3))
  check('it really travelled upward', r.maxLift >= DEPART_DEFAULTS.liftMax - 1e-6, r.maxLift.toFixed(1))
  check('alpha stays in 0..1', r.minAlpha >= 0 && r.maxAlpha <= 1)
  check('lift never goes negative', r.minLift >= 0)
}

// ---------------------------------------------------------------- the turn
console.log('')
console.log('2) the turn is a turn: bounded speed, monotonic, timed')
{
  const r = run({ seed: 5 })
  // Planned turns use ease-in-out shapes (peak slope ~1.6x the mean) over at
  // least `backTurnMin` seconds; the departure adds smootherstep. 0.18 rad/step
  // at 30 Hz is the resulting no-teleport ceiling. The engine damps the rest.
  const ceiling = 0.18
  check('facing never jumps', r.maxFacingStep <= ceiling, `${r.maxFacingStep.toFixed(3)} rad/step (ceiling ${ceiling.toFixed(3)})`)

  const turnStart = r.log.findIndex((s) => s.phase === PHASE.TURN)
  let seen = 0
  let backwards = 0
  let prev = 0
  for (let i = turnStart; i >= 0 && i < r.log.length && r.log[i].phase === PHASE.TURN; i++) {
    seen++
    // The turn may go either way; what must not happen is turning back on
    // itself (wobble) or overshooting the pose before the retreat starts.
    if (Math.abs(r.log[i].facing) < prev - 1e-9) backwards++
    prev = Math.abs(r.log[i].facing)
  }
  check('turn samples were visited', seen > 0, `${seen}`)
  check('turn is monotonic in |facing| (no wobble)', backwards === 0, `${backwards} backwards steps`)

  const turnIn = at(r, PHASE.TURN)[0]
  const turnOut = at(r, PHASE.RETREAT)[0]
  const took = turnOut.t - turnIn.t
  check(
    'turn takes the configured 1.6-2.6 s',
    took >= DEPART_DEFAULTS.turnMin - 2 * DT && took <= DEPART_DEFAULTS.turnMax + 2 * DT,
    `${took.toFixed(2)} s`,
  )
  check(
    'turn ends between 0.88 and 1.0 of a half turn',
    Math.abs(turnOut.facing) >= Math.PI * 0.87 && Math.abs(turnOut.facing) <= Math.PI + 1e-6,
    turnOut.facing.toFixed(3),
  )
}

// ---------------------------------------------------------------- the retreat
console.log('')
console.log('3) it retreats: depth far, one push-off jet, and the arms stay open')
{
  const r = run({ seed: 5 })
  // PREP may be skipped, so the starting depth comes from whichever phase began
  // the departure.
  const startRec = at(r, PHASE.PREP)[0] || at(r, PHASE.TURN)[0]
  const retreat = at(r, PHASE.RETREAT)[0]
  const far = at(r, PHASE.FAR)[0]
  check('the far phase happens', far != null)
  check('depth target is in the far band', far.depthTarget >= DEPART_DEFAULTS.farDepthMin - 1e-9, far.depthTarget.toFixed(3))
  check('depth actually receded by FAR', far.depth > startRec.depth + 0.25, `${startRec.depth.toFixed(2)} -> ${far.depth.toFixed(2)}`)
  check('the retreat starts the push-off', retreat != null && r.jetSteps >= r.starts.length, `${r.jetSteps} jet steps / ${r.starts.length} departures`)
  check('the base wander keeps resting while it leaves', r.restViolations === 0, `${r.restViolations} non-rest steps`)

  const idx = r.log.findIndex((s) => s.phase === PHASE.FAR)
  const sample = r.log[idx + Math.round(2 / DT)]
  check(
    'at FAR: back turned, alpha far, lift max, depth far',
    Math.abs(sample.facing) >= Math.PI * 0.87 &&
      Math.abs(sample.alpha - DEPART_DEFAULTS.alphaFar) < 1e-6 &&
      Math.abs(sample.lift - DEPART_DEFAULTS.liftMax) < 1e-6 &&
      sample.depth > 0.7,
    `facing ${sample.facing.toFixed(2)} alpha ${sample.alpha.toFixed(2)} lift ${sample.lift.toFixed(0)} depth ${sample.depth.toFixed(2)}`,
  )
}

// ---------------------------------------------------------------- scheduling
console.log('')
console.log('4) it is an event, not a loop')
{
  const r = run({ seed: 9, seconds: 900 })
  const gaps = r.starts.slice(1).map((t, i) => t - r.starts[i])
  check('at least three departures in 15 min', r.starts.length >= 3, `${r.starts.length}`)
  check(
    'every gap respects the cooldown',
    gaps.every((g) => g >= DEPART_DEFAULTS.gapMin - 0.5),
    gaps.map((g) => g.toFixed(0)).join(' / '),
  )
}

// ---------------------------------------------------------------- disabled
console.log('')
console.log('5) reduced motion switches the whole thing off')
{
  const off = { ...DEFAULTS, depart: { ...DEPART_DEFAULTS, enabled: false } }
  const r = run({ seed: 4, seconds: 400, cfg: off })
  check('never leaves idle', r.transitions.length === 0, `${r.transitions.length} transitions`)
  check('facing stays 0', r.maxFacing === 0 && r.st.facing === 0)
  check('alpha stays 1', r.st.dpAlpha === 1)
  check('lift stays 0', r.maxLift === 0 && r.st.dpLift === 0)
}

// ---------------------------------------------------------------- persistence
console.log('')
console.log('6) a reload resumes the departure instead of snapping back')
{
  const st = createBehaviorState({ x: 500, y: 220, seed: 13 })
  let guard = 0
  while (st.dpPhase !== PHASE.TURN && guard++ < 20000) stepBehavior(st, DT, BOX)
  for (let i = 0; i < 30; i++) stepBehavior(st, DT, BOX)
  const saved = serializeBehavior(st)
  check('saved mid-turn state keeps the phase', saved.dp.phase === PHASE.TURN, saved.dp.phase)
  check('saved mid-turn state keeps a partial facing', Math.abs(saved.dp.facing) > 0 && Math.abs(saved.dp.facing) < Math.PI, saved.dp.facing.toFixed(2))

  const restored = restoreBehavior(JSON.parse(JSON.stringify(saved)), BOX)
  check('restore keeps the phase', restored != null && restored.dpPhase === PHASE.TURN)
  check('restore is idempotent', restored != null && serial(restored) === JSON.stringify(saved))

  // A payload written before departures existed must still resume the wander.
  const legacy = JSON.parse(JSON.stringify(saved))
  delete legacy.dp
  const migrated = restoreBehavior(legacy, BOX)
  check('pre-departure payload resumes idle', migrated != null && migrated.dpPhase === PHASE.IDLE)
  check('pre-departure payload resumes facing forward', migrated != null && migrated.dpFacing === 0 && migrated.dpAlpha === 1)
}

// ---------------------------------------------------------------- manual start
console.log('')
console.log('7) the debug trigger starts one on demand and only one')
{
  const st = createBehaviorState({ x: 500, y: 220, seed: 2 })
  check('starts from idle', startDeparture(st, DEPART_DEFAULTS, () => 0.5) === true && st.dpPhase === PHASE.PREP)
  check('refuses a second start', startDeparture(st, DEPART_DEFAULTS, () => 0.5) === false && st.dpPhase === PHASE.PREP)
  const view = getDeparture(st)
  check('view reports active with a phase', view.active === true && view.phase === PHASE.PREP)
}

// ---------------------------------------------------------------- stability
console.log('')
console.log('8) frame-time independent, and it always comes home')
{
  for (const [name, dt] of [
    ['1/120', 1 / 120],
    ['0.05', 0.05],
  ]) {
    const r = run({ seed: 5, seconds: 600, dt })
    const homes = at(r, PHASE.IDLE).length
    check(`dt ${name}: finite`, !r.nan)
    check(`dt ${name}: inside bounds`, r.outOfBox === 0, `${r.outOfBox} samples out`)
    check(`dt ${name}: departed at least once`, r.starts.length >= 1, `${r.starts.length}`)
    check(`dt ${name}: every departure came home`, homes >= r.starts.length - 1, `${homes}/${r.starts.length}`)
  }
}

// ---------------------------------------------------------------- distance
console.log('')
console.log('9) distance drives the facing: a far target IS the decision to turn away')
{
  const st = createBehaviorState({ x: 500, y: 220, seed: 3 })
  st.depthTimer = 1e6
  st.dpCooldown = 1e6
  st.depthTarget = 0.85
  st.depth = 0.85
  st.depthView = 0.85
  for (let i = 0; i < 240; i++) stepBehavior(st, DT, BOX)
  check('far target turns the back', Math.abs(st.facing) >= Math.PI * 0.87, st.facing.toFixed(2))
  check('far target lifts the layer', getView(st).lift > 15, getView(st).lift.toFixed(1))
  check('far target dims the layer', getView(st).alpha < 0.95, getView(st).alpha.toFixed(2))

  // The hysteresis band: a target between the thresholds must not flap.
  st.depthTarget = 0.55
  for (let i = 0; i < 240; i++) stepBehavior(st, DT, BOX)
  check('mid target keeps it turned away (no flap)', Math.abs(st.facing) > Math.PI * 0.85, st.facing.toFixed(2))

  st.depthTarget = 0.2
  st.depth = 0.2
  st.depthView = 0.2
  for (let i = 0; i < 240; i++) stepBehavior(st, DT, BOX)
  check('near target turns it back to face you', Math.abs(st.facing) < 0.15, st.facing.toFixed(3))
  check('near target drops the lift', getView(st).lift < 6, getView(st).lift.toFixed(1))
}

// ---------------------------------------------------------------- variety
console.log('')
console.log('10) turns are not one routine: both shoulders, varied angles, varied shapes')
{
  // Both shoulders must show up over a long run, and "back" poses must not all
  // be the same angle (0.88-1.0 of a half turn is the designed band).
  const st = createBehaviorState({ x: 500, y: 220, seed: 21 })
  const signs = new Set()
  const magnitudes = []
  let prevAbs = 0
  let peak = 0
  for (let i = 0; i < Math.round(900 / DT); i++) {
    stepBehavior(st, DT, BOX)
    const abs = Math.abs(st.facing)
    if (abs >= Math.PI * 0.8) {
      peak = Math.max(peak, abs)
      signs.add(Math.sign(st.facing))
    } else if (peak > 0) {
      magnitudes.push(peak)
      peak = 0
    }
    prevAbs = abs
  }
  check('both shoulders are used', signs.has(1) && signs.has(-1), [...signs].join('/'))
  check('back angles vary between turns', magnitudes.length >= 3 && new Set(magnitudes.map((m) => m.toFixed(2))).size >= 2, magnitudes.map((m) => m.toFixed(2)).join(' '))
  check(
    'all back angles stay in the designed band',
    magnitudes.every((m) => m >= Math.PI * 0.82 && m <= Math.PI * 1.03),
    magnitudes.map((m) => (m / Math.PI).toFixed(2)).join(' '),
  )
}

console.log('')
if (failures > 0) {
  console.log(`DEPARTURE-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('DEPARTURE-CHECK PASSED')
