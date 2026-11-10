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
import { DEFAULTS, createBehaviorState, stepBehavior, serializeBehavior, restoreBehavior } from '../src/scene/behavior.js'

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

const GOAL_ORDER = [PHASE.PREP, PHASE.TURN, PHASE.RETREAT, PHASE.FAR, PHASE.RETURN, PHASE.IDLE]

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
        facing: st.dpFacing,
        alpha: st.dpAlpha,
        lift: st.dpLift,
        depth: st.depth,
        depthTarget: st.depthTarget,
      })
      if (st.dpPhase === PHASE.PREP) starts.push(t)
    }

    if (st.dpPhase !== PHASE.IDLE) {
      if (st.mode !== 'rest') restViolations++
      maxFacing = Math.max(maxFacing, Math.abs(st.dpFacing))
      maxFacingStep = Math.max(maxFacingStep, Math.abs(st.dpFacing - lastFacing))
      maxAlpha = Math.max(maxAlpha, st.dpAlpha)
      minAlpha = Math.min(minAlpha, st.dpAlpha)
      maxLift = Math.max(maxLift, st.dpLift)
      minLift = Math.min(minLift, st.dpLift)
    }
    lastFacing = st.dpFacing

    if (!Number.isFinite(st.x) || !Number.isFinite(st.y) || !Number.isFinite(st.dpFacing) || !Number.isFinite(st.depth)) nan = true
    if (st.x < BOX.minX - 0.75 || st.x > BOX.maxX + 0.75 || st.y < BOX.minY - 0.75 || st.y > BOX.maxY + 0.75) outOfBox++

    if (st.jet) jetSteps++
    log.push({ phase: st.dpPhase, facing: st.dpFacing, alpha: st.dpAlpha, lift: st.dpLift, depth: st.depth, mode: st.mode })
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
  check('reaches full back turn', Math.abs(r.maxFacing - Math.PI) < 1e-6, `${r.maxFacing.toFixed(4)} rad`)

  const order = r.transitions.map((x) => x.to)
  const first = order.indexOf(PHASE.PREP)
  const prefix = order.slice(first, first + GOAL_ORDER.length)
  check('phase order prep>turn>retreat>far>return>idle', prefix.join('>') === GOAL_ORDER.join('>'), prefix.join(' > '))

  const homes = at(r, PHASE.IDLE)
  check('every departure comes home', homes.length >= r.starts.length, `${homes.length} home calls / ${r.starts.length} departures`)
  check(
    'home is neutral: facing 0, alpha 1, no lift',
    homes.every((h) => Math.abs(h.facing) < 1e-6 && h.alpha > 0.999 && h.lift < 1e-6),
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
  // smootherstep peaks at 1.875x its mean rate, so this is a hard ceiling.
  const ceiling = ((Math.PI * 1.875) / DEPART_DEFAULTS.turnMin) * DT
  check('facing never jumps', r.maxFacingStep <= ceiling * 1.05, `${r.maxFacingStep.toFixed(3)} rad/step (ceiling ${ceiling.toFixed(3)})`)

  const turnStart = r.log.findIndex((s) => s.phase === PHASE.TURN)
  let seen = 0
  let backwards = 0
  let prev = 0
  for (let i = turnStart; i >= 0 && i < r.log.length && r.log[i].phase === PHASE.TURN; i++) {
    seen++
    if (r.log[i].facing < prev - 1e-9) backwards++
    prev = r.log[i].facing
  }
  check('turn samples were visited', seen > 0, `${seen}`)
  check('turn is monotonic (no wobble, no overshoot)', backwards === 0, `${backwards} backwards steps`)

  const turnIn = at(r, PHASE.TURN)[0]
  const turnOut = at(r, PHASE.RETREAT)[0]
  const took = turnOut.t - turnIn.t
  check(
    'turn takes the configured 2.0-2.8 s',
    took >= DEPART_DEFAULTS.turnMin - 2 * DT && took <= DEPART_DEFAULTS.turnMax + 2 * DT,
    `${took.toFixed(2)} s`,
  )
  check('turn ends exactly at π', Math.abs(turnOut.facing - Math.PI) < 1e-6, turnOut.facing.toFixed(4))
}

// ---------------------------------------------------------------- the retreat
console.log('')
console.log('3) it retreats: depth far, one push-off jet, and the arms stay open')
{
  const r = run({ seed: 5 })
  const prep = at(r, PHASE.PREP)[0]
  const retreat = at(r, PHASE.RETREAT)[0]
  const far = at(r, PHASE.FAR)[0]
  check('the far phase happens', far != null)
  check('depth target is in the far band', far.depthTarget >= DEPART_DEFAULTS.farDepthMin - 1e-9, far.depthTarget.toFixed(3))
  check('depth actually receded by FAR', far.depth > prep.depth + 0.25, `${prep.depth.toFixed(2)} -> ${far.depth.toFixed(2)}`)
  check('the retreat starts the push-off', retreat != null && r.jetSteps >= r.starts.length, `${r.jetSteps} jet steps / ${r.starts.length} departures`)
  check('the base wander keeps resting while it leaves', r.restViolations === 0, `${r.restViolations} non-rest steps`)

  const idx = r.log.findIndex((s) => s.phase === PHASE.FAR)
  const sample = r.log[idx + Math.round(2 / DT)]
  check(
    'at FAR: back turned, alpha far, lift max, depth far',
    Math.abs(sample.facing - Math.PI) < 1e-6 &&
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
  check('facing stays 0', r.maxFacing === 0 && r.st.dpFacing === 0)
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
  check('saved mid-turn state keeps a partial facing', saved.dp.facing > 0 && saved.dp.facing < Math.PI, saved.dp.facing.toFixed(2))

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
    check(`dt ${name}: every departure came home`, homes >= r.starts.length, `${homes}/${r.starts.length}`)
  }
}

console.log('')
if (failures > 0) {
  console.log(`DEPARTURE-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('DEPARTURE-CHECK PASSED')
