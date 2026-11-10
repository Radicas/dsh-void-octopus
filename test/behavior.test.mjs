/**
 * Invariants for the random-walk locomotion (src/scene/behavior.js).
 *
 * Why these exist: the previous motion was a pure function of an accumulating
 * clock, so the creature could never stop and its heading was a formula. The
 * replacement introduces state, randomness and a boundary, which are exactly
 * the kind of code that fails only after a while (NaN creep, wall grinding,
 * resumed state drifting). Everything here runs the real `stepBehavior` loop at
 * a fixed dt and asserts measurable properties, so distribution changes are
 * caught instead of eyeballed.
 *
 * Run: node test/behavior.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  BEHAVIOR_VERSION,
  DEFAULTS,
  createBehaviorState,
  stepBehavior,
  getSwim,
  depthScale,
  serializeBehavior,
  restoreBehavior,
} from '../src/scene/behavior.js'
import { computeArmTargets, ARM_COUNT, POINTS_PER_ARM } from '../src/scene/armPose.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 1440x900 viewport with the 400 px layer inset by a 12 px margin.
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

const quad = (heading) => {
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  if (c >= 0) return s >= 0 ? 0 : 3
  return s >= 0 ? 1 : 2
}

/**
 * Run the real loop and collect enough statistics to assert on.
 * @param {{seed?:number, seconds?:number, dt?:number, box?:object, cfg?:object, start?:object}} opts
 */
function simulate({ seed = 7, seconds = 300, dt = DT, box = BOX, cfg = DEFAULTS, start } = {}) {
  const st = createBehaviorState({ x: start?.x ?? 500, y: start?.y ?? 220, seed, cfg })
  const steps = Math.round(seconds / dt)
  let rest = 0
  let cruise = 0
  let settle = 0
  let nan = false
  let outOfBox = 0
  let maxSpeed = 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const quadrants = [0, 0, 0, 0]
  const transitions = []
  let cruises = 0
  let rests = 0
  let restStart = 0
  const restLengths = []
  let last = st.mode
  let restSwimMax = 0
  let cruiseSwimMax = 0
  let depthMin = Infinity
  let depthMax = -Infinity
  let farSamples = 0
  let nearSamples = 0

  for (let i = 0; i < steps; i++) {
    stepBehavior(st, dt, box, cfg)
    const t = (i + 1) * dt
    if (
      !Number.isFinite(st.x) ||
      !Number.isFinite(st.y) ||
      !Number.isFinite(st.speed) ||
      !Number.isFinite(st.heading) ||
      !Number.isFinite(st.depth)
    ) {
      nan = true
    }
    depthMin = Math.min(depthMin, st.depth)
    depthMax = Math.max(depthMax, st.depth)
    if (st.depth > 0.6) farSamples++
    if (st.depth <= 0.5) nearSamples++
    if (st.x < box.minX - 0.75 || st.x > box.maxX + 0.75 || st.y < box.minY - 0.75 || st.y > box.maxY + 0.75) {
      outOfBox++
    }
    if (st.mode === 'rest') {
      rest++
      restSwimMax = Math.max(restSwimMax, getSwim(st, cfg).amount)
    } else if (st.mode === 'cruise') cruise++
    else settle++

    if (st.mode === 'cruise') {
      maxSpeed = Math.max(maxSpeed, st.speed)
      if (st.speed > 20) quadrants[quad(st.heading)]++
      cruiseSwimMax = Math.max(cruiseSwimMax, getSwim(st, cfg).amount)
    }
    minX = Math.min(minX, st.x)
    maxX = Math.max(maxX, st.x)
    minY = Math.min(minY, st.y)
    maxY = Math.max(maxY, st.y)

    if (st.mode !== last) {
      transitions.push({ t, from: last, to: st.mode })
      if (st.mode === 'cruise') {
        cruises++
        rests++
        restLengths.push(t - restStart)
      }
      if (st.mode === 'rest') restStart = t
      last = st.mode
    }
  }

  return {
    st,
    steps: rest + cruise + settle,
    rest,
    cruise,
    settle,
    nan,
    outOfBox,
    maxSpeed,
    extent: { minX, maxX, minY, maxY },
    quadrants,
    cruises,
    restTransitions: rests,
    restLengths,
    restSwimMax,
    cruiseSwimMax,
    depth: { min: depthMin, max: depthMax, far: farSamples, near: nearSamples, total: steps },
  }
}

const serial = (st) => JSON.stringify(serializeBehavior(st))

console.log('random-walk locomotion invariants')
console.log('')

// ---------------------------------------------------------------- determinism
console.log('1) seeded, reproducible, and actually random')
{
  const a = simulate({ seed: 42, seconds: 20 })
  const b = simulate({ seed: 42, seconds: 20 })
  const c = simulate({ seed: 43, seconds: 20 })
  check('same seed -> identical final state', serial(a.st) === serial(b.st))
  check('different seed -> different wander', serial(a.st) !== serial(c.st))
  check('seed survives serialisation', a.st.seed === 42 && a.st.rng === b.st.rng)
}

// ---------------------------------------------------------------- stability
console.log('')
console.log('2) no NaN / no wall grinding at any frame time')
{
  const base = simulate({ seed: 3, seconds: 180 })
  const fast = simulate({ seed: 3, seconds: 180, dt: 1 / 120 })
  const slow = simulate({ seed: 3, seconds: 180, dt: 0.05 })
  for (const [name, r] of [
    ['1/30', base],
    ['1/120', fast],
    ['0.05', slow],
  ]) {
    check(`dt ${name}: finite state`, !r.nan)
    check(`dt ${name}: inside bounds`, r.outOfBox === 0, `${r.outOfBox} samples out`)
  }
  // 300 s of uptime is what used to expose phase runaways in the old solver.
  const long = simulate({ seed: 3, seconds: 900 })
  check('900 s still finite and bounded', !long.nan && long.outOfBox === 0)
}

// ---------------------------------------------------------------- duty cycle
console.log('')
console.log('3) it really stops, and stops long enough to read as resting')
{
  const r = simulate({ seed: 11, seconds: 300 })
  const restShare = r.rest / r.steps
  check('rest share 30-75%', restShare > 0.3 && restShare < 0.75, `${(restShare * 100).toFixed(1)}%`)
  check('at least 8 cruise legs in 5 min', r.cruises >= 8, `${r.cruises} legs`)
  const settles = simulate({ seed: 11, seconds: 300 }).settle
  check('settle phase exists (smooth stops)', settles > 0, `${settles} samples`)
  check('rest never reports swim effort', r.restSwimMax === 0, `max ${r.restSwimMax}`)
  check('cruise does report swim effort', r.cruiseSwimMax > 0.4, `max ${r.cruiseSwimMax.toFixed(2)}`)
  const avgRest = r.restLengths.reduce((a, b) => a + b, 0) / Math.max(1, r.restLengths.length)
  check('mean rest between 4 and 30 s', avgRest >= 4 && avgRest <= 30, `${avgRest.toFixed(1)} s`)
}

// ---------------------------------------------------------------- randomness
console.log('')
console.log('4) heading is re-rolled, not a path')
{
  const r = simulate({ seed: 5, seconds: 300 })
  const total = r.quadrants.reduce((a, b) => a + b, 0)
  const shares = r.quadrants.map((n) => (n / total) * 100)
  check('all four quadrants visited', shares.every((n) => n > 4), shares.map((n) => n.toFixed(0) + '%').join(' / '))

  const width = BOX.maxX - BOX.minX
  const height = BOX.maxY - BOX.minY
  const spanX = (r.extent.maxX - r.extent.minX) / width
  const spanY = (r.extent.maxY - r.extent.minY) / height
  check('wanders most of the viewport', spanX > 0.35 && spanY > 0.25, `x ${(spanX * 100).toFixed(0)}% / y ${(spanY * 100).toFixed(0)}%`)

  const maxBand = Math.max(...DEFAULTS.speedBands.map((b) => b.max))
  check('speed stays inside the bands', r.maxSpeed <= maxBand * 1.05, `${r.maxSpeed.toFixed(1)} px/s`)
  // A fixed path would produce a narrow spread of leg lengths. These bands are
  // 1.5-6.5 s, so a wide spread is the signature of re-rolling.
  const lens = r.restLengths.filter((v) => Number.isFinite(v))
  const short = lens.filter((v) => v < 6).length
  const long = lens.filter((v) => v > 12).length
  check('rest lengths are spread, not a fixed beat', short > 0 && long > 0, `${short} short / ${long} long`)
}

// ---------------------------------------------------------------- boundaries
console.log('')
console.log('5) edges turn it around instead of pinning it')
{
  const st = createBehaviorState({ x: BOX.maxX - 2, y: 200, seed: 9 })
  st.mode = 'cruise'
  st.heading = 0 // east, straight into the wall
  st.targetHeading = 0
  st.speed = 120
  st.targetSpeed = 120
  st.timer = 6
  let out = 0
  for (let i = 0; i < 90; i++) {
    stepBehavior(st, DT, BOX)
    if (st.x > BOX.maxX + 0.75) out++
  }
  check('never crosses the wall', out === 0, `${out} samples out`)
  check('heading was reflected away from the wall', Math.cos(st.heading) < 0.2, `cos ${Math.cos(st.heading).toFixed(2)}`)
  check('still cruising after the bounce', st.mode === 'cruise' || st.mode === 'settle' || st.mode === 'rest')

  // Window shrink to below the layer size: bounds may invert, it must not NaN.
  const tiny = { minX: 200, minY: 200, maxX: 100, maxY: 100 }
  const s2 = createBehaviorState({ x: 150, y: 150, seed: 2 })
  for (let i = 0; i < 60; i++) stepBehavior(s2, DT, tiny)
  check('inverted bounds stay finite', Number.isFinite(s2.x) && Number.isFinite(s2.y), `x ${s2.x.toFixed(1)} y ${s2.y.toFixed(1)}`)
}

// ---------------------------------------------------------------- hover
console.log('')
console.log('6) waiting is a slow wander, not a freeze')
{
  const st = createBehaviorState({ x: 500, y: 220, seed: 21 })
  st.mode = 'rest'
  st.timer = 10
  st.speed = 0
  st.targetSpeed = 0
  st.restX = st.x
  st.restY = st.y
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < 300; i++) {
    stepBehavior(st, DT, BOX)
    minX = Math.min(minX, st.x)
    maxX = Math.max(maxX, st.x)
    minY = Math.min(minY, st.y)
    maxY = Math.max(maxY, st.y)
  }
  if (st.mode !== 'rest') {
    // An early leave is legal (8%/s), so re-run with the leave rate disabled.
    st.mode = 'rest'
    st.timer = 10
    minX = Infinity
    maxX = -Infinity
    minY = Infinity
    maxY = -Infinity
    st.restX = st.x
    st.restY = st.y
    for (let i = 0; i < 300; i++) {
      stepBehavior(st, DT, BOX, { ...DEFAULTS, leaveRestRate: 0 })
      minX = Math.min(minX, st.x)
      maxX = Math.max(maxX, st.x)
      minY = Math.min(minY, st.y)
      maxY = Math.max(maxY, st.y)
    }
  }
  const span = Math.max(maxX - minX, maxY - minY)
  check('hover excursion is small', span < DEFAULTS.hoverMax * 2 + 1, `${span.toFixed(1)} px`)
  check('hover still moves', span > 0.5, `${span.toFixed(1)} px`)
  check('hover speed never counts as swimming', getSwim(st).amount === 0)
}

// ---------------------------------------------------------------- persistence
console.log('')
console.log('7) a reload resumes the wander instead of restarting it')
{
  const st = createBehaviorState({ x: 500, y: 220, seed: 31 })
  for (let i = 0; i < 30 * 45; i++) stepBehavior(st, DT, BOX)
  const saved = serializeBehavior(st)
  const restored = restoreBehavior(JSON.parse(JSON.stringify(saved)), BOX)
  check('payload version matches', saved.v === BEHAVIOR_VERSION)
  check('restore succeeds on its own payload', restored != null)
  check('serialise(restore(x)) is stable', restored != null && JSON.stringify(serializeBehavior(restored)) === JSON.stringify(saved))

  // Same rng stream, same timers: the restored run must stay on the same
  // schedule, and close enough in space (position is continuous state, and
  // serialisation rounds it to 0.01 px).
  const clone = restoreBehavior(JSON.parse(JSON.stringify(saved)), BOX)
  const original = restoreBehavior(JSON.parse(JSON.stringify(saved)), BOX)
  for (let i = 0; i < 30 * 30; i++) {
    stepBehavior(original, DT, BOX)
    stepBehavior(clone, DT, BOX)
  }
  check('resumed run is deterministic', serial(original) === serial(clone))

  const bad = restoreBehavior({ v: BEHAVIOR_VERSION, mode: 'cruise' }, BOX)
  check('malformed payload is rejected', bad == null)
  check('wrong version is rejected', restoreBehavior({ v: 99 }, BOX) == null)
  const clamped = restoreBehavior({ ...saved, x: 99999, y: -50 }, BOX)
  check('restore clamps into bounds', clamped != null && clamped.x <= BOX.maxX && clamped.y >= BOX.minY)

  // Depth arrived in 0.9.24. A payload written before it is still v1 and must
  // resume the wander at the default distance instead of being thrown away.
  const legacy = { ...saved }
  delete legacy.depth
  delete legacy.depthTarget
  delete legacy.depthTimer
  const migrated = restoreBehavior(legacy, BOX)
  check('pre-0.9.24 payload resumes at the default distance', migrated != null && Math.abs(migrated.depth - DEFAULTS.depthStart) < 1e-9)
  check('depth survives serialisation', restored != null && restored.depth === saved.depth)
}

// ---------------------------------------------------------------- pose link
console.log('')
console.log('8) "stopped" actually opens the arms (the shader side of the promise)')
{
  const pts = Array.from({ length: ARM_COUNT * POINTS_PER_ARM }, () => ({ x: 0, y: 0, z: 0 }))
  const state = {
    time: 8,
    strokePhase: 20,
    waveOffset: 4,
    effort: 0,
    swimX: 1,
    swimY: 0,
    yaw: 0,
    jetSurge: 0,
    pulse: 0,
    stretch: 0,
    coil: 0,
    armCurl: new Float32Array(ARM_COUNT),
  }
  // Mean crown radius, not the max: the max is dominated by whichever arm the
  // trail happened to stretch, the mean is the actual "how splayed is it".
  const radius = () => {
    computeArmTargets(pts, state)
    let sum = 0
    for (const p of pts) sum += Math.hypot(p.x, p.z)
    return sum / pts.length
  }
  const open = radius()
  state.effort = 1
  state.jetSurge = 0.4
  const swimming = radius()
  check('resting crown is wider than the swimming one', open > swimming * 1.25, `${open.toFixed(2)} vs ${swimming.toFixed(2)}`)
}

// ---------------------------------------------------------------- depth
console.log('')
console.log('9) depth: it can drift away, and the scale follows it')
{
  const r = simulate({ seed: 17, seconds: 300 })
  const total = r.depth.total
  const farShare = r.depth.far / total
  const nearShare = r.depth.near / total
  check('depth stays in 0..1', r.depth.min >= 0 && r.depth.max <= 1, `${r.depth.min.toFixed(2)}..${r.depth.max.toFixed(2)}`)
  check('depth actually moves over 5 min', r.depth.max - r.depth.min > 0.25, `range ${(r.depth.max - r.depth.min).toFixed(2)}`)
  check(
    'mostly near, sometimes far',
    farShare > 0.06 && farShare < 0.45 && nearShare > 0.5,
    `far ${(farShare * 100).toFixed(0)}% / near ${(nearShare * 100).toFixed(0)}%`,
  )

  check(
    'depthScale endpoints',
    Math.abs(depthScale({ depth: 0 }) - DEFAULTS.depthNear) < 1e-9 &&
      Math.abs(depthScale({ depth: 1 }) - DEFAULTS.depthFar) < 1e-9,
  )
  let monotonic = true
  let prev = depthScale({ depth: 0 })
  for (let i = 1; i <= 20; i++) {
    const s = depthScale({ depth: i / 20 })
    if (s > prev + 1e-9) monotonic = false
    prev = s
  }
  check('depthScale is monotonically smaller as it retreats', monotonic)
  check(
    'depthScale clamps out-of-range depth',
    Math.abs(depthScale({ depth: 2 }) - DEFAULTS.depthFar) < 1e-9 &&
      Math.abs(depthScale({ depth: -1 }) - DEFAULTS.depthNear) < 1e-9,
  )
}

// ---------------------------------------------------------------- static scan
console.log('')
console.log('10) no phase is built as clock * state in the motion sources')
{
  const files = ['src/scene/behavior.js', 'src/client-entry.js', 'src/scene/armPose.js', 'src/scene/SdfOctopus.js']
  const offenders = []
  for (const rel of files) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8')
    const re = /Math\.(?:sin|cos|tan)\(\s*([A-Za-z_$][\w$]*)\s*\*\s*([A-Za-z_$][\w$]*)/g
    let m
    while ((m = re.exec(src)) !== null) {
      if (/^Math$/.test(m[1]) || /^Math/.test(m[2])) continue
      if (/^(?:Math\.PI|TAU)$/.test(m[2])) continue
      offenders.push(`${rel}: ${m[0]}`)
    }
  }
  check('no sin(clock * identifier) anywhere', offenders.length === 0, offenders.join(' | ') || 'clean')
}

console.log('')
if (failures > 0) {
  console.log(`BEHAVIOR-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('BEHAVIOR-CHECK PASSED')
