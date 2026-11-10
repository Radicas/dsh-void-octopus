/**
 * Invariant tests for the turn-lag solver (0.9.28).
 *
 * The complaint this fixes was qualitative ("转身像被转了一张图"), so the test
 * has to pin down the three properties that make it read as an animal instead:
 *
 *  1. the arms' yaw TRAILS the body's while the body turns, and the trail is
 *     visible (there is a measurable angle) but bounded (it must not spin the
 *     crown into its neighbours);
 *  2. it does not stop when the body does — the lag keeps draining, overshoots
 *     neutral once, and settles within ~1 s;
 *  3. it is a pure function of yaw(t), so a 120 fps and a 20 fps frame step
 *     integrate the same spring (the 0.9.11/0.9.15 bugs were both frame-rate
 *     dependent drifts).
 *
 * Run: node test/turnLag.test.mjs
 */

import {
  ARM_COUNT,
  POINTS_PER_ARM,
  TURN_LAG_DEFAULTS,
  createTurnLag,
  stepTurnLag,
  computeArmTargets,
} from '../src/scene/armPose.js'

let failures = 0
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const smooth = (p) => p * p * (3 - 2 * p)

/**
 * Drive the solver exactly like the engine does: a planned half turn over
 * `dur` seconds (the shape 0.9.27's buildTurn produces), then hold.
 * @returns {{samples:Array<{t:number,yaw:number,lag:number,brace:number}>, peak:number}}
 */
function plannedTurn({ dur = 2, tail = 1.6, dt = 1 / 60, start = 0, to = Math.PI } = {}) {
  const st = createTurnLag()
  const samples = []
  let peak = 0
  const total = dur + tail
  const frames = Math.round(total / dt)
  for (let f = 0; f <= frames; f++) {
    const t = f * dt
    const yaw = t < dur ? start + (to - start) * smooth(t / dur) : to
    const lag = stepTurnLag(st, yaw, dt)
    peak = Math.max(peak, Math.abs(lag))
    samples.push({ t, yaw, lag, brace: st.brace })
  }
  return { samples, peak, st }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const maxAbs = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

console.log('turn-lag invariants')
console.log('')

// ------------------------------------------------------------------ at rest
console.log('1) at rest the arms have no yaw of their own')
{
  const st = createTurnLag()
  let worstLag = 0
  let worstBrace = 0
  for (let f = 0; f < 120; f++) {
    const lag = stepTurnLag(st, 0, 1 / 60)
    worstLag = Math.max(worstLag, Math.abs(lag))
    worstBrace = Math.max(worstBrace, st.brace)
  }
  // Wiggling the body a little (the sway channel is clamped to +-0.8 rad but at
  // rest it is nearly still) must not leave a permanent offset behind.
  for (let f = 0; f < 120; f++) {
    const yaw = Math.sin(f / 60 * 0.7) * 0.02
    stepTurnLag(st, yaw, 1 / 60)
  }
  const resting = stepTurnLag(st, 0, 1 / 60)
  check('no lag while the body is still', worstLag < 1e-6, `worst ${worstLag.toExponential(2)}`)
  check('no brace while the body is still', worstBrace === 0)
  check('a settled sway leaves no offset', Math.abs(resting) < 5e-3, `${resting.toFixed(4)} rad`)
}

// ---------------------------------------------------------------- the trail
console.log('')
console.log('2) while turning, the arms trail the body by a visible but bounded angle')
{
  const { samples, peak } = plannedTurn()
  check(
    'peak lag is visible (> 0.15 rad = 8.6 deg at the tip)',
    peak > 0.15,
    `${peak.toFixed(3)} rad`,
  )
  check(
    'peak lag stays inside the soft cap',
    peak <= TURN_LAG_DEFAULTS.limit + 1e-9,
    `${peak.toFixed(3)} <= ${TURN_LAG_DEFAULTS.limit}`,
  )

  // During the fast middle of the turn the lag must point AGAINST the body's
  // rotation (the arms are behind, not ahead), and the arm yaw must never lead.
  const middle = samples.filter((s) => s.t > 0.35 && s.t < 1.65)
  let leading = 0
  let worstRatio = 0
  for (let i = 1; i < middle.length; i++) {
    const yawRate = (middle[i].yaw - middle[i - 1].yaw) / (middle[i].t - middle[i - 1].t)
    if (yawRate < 0.4) continue
    if (middle[i].lag >= 0) leading++
    worstRatio = Math.max(worstRatio, Math.abs(middle[i].lag) / yawRate)
  }
  check('the arm yaw never leads the body during a turn', leading === 0, `${leading} leading samples`)
  check(
    'lag tracks the turn rate (tau within 30%)',
    Math.abs(worstRatio - TURN_LAG_DEFAULTS.tau) < TURN_LAG_DEFAULTS.tau * 0.3,
    `${worstRatio.toFixed(3)} s vs tau ${TURN_LAG_DEFAULTS.tau}`,
  )

  // The lag must be an ANGLE, not a wobble: at every mid-turn sample the arms
  // are genuinely behind the mantle by more than a tenth of a radian.
  const sustained = middle.filter((s) => Math.abs(s.lag) > 0.1).length
  check('lag is sustained for most of the turn', sustained > middle.length * 0.8, `${sustained}/${middle.length} samples > 0.1 rad`)
}

// ------------------------------------------------------- it keeps sliding
console.log('')
console.log('3) the slide outlasts the body: it drains, overshoots once, then settles')
{
  const { samples } = plannedTurn()
  const at = (t) => samples.find((s) => s.t >= t - 1e-9)
  const stop = at(2)
  const plus100 = at(2.1)
  const plus200 = at(2.2)
  check('the arms are still behind when the body stops', stop.lag < -0.05, `${stop.lag.toFixed(3)} rad`)
  check(
    'they are still sliding 0.1 s later',
    plus100.lag < -0.03,
    `${plus100.lag.toFixed(3)} rad`,
  )
  check('they have caught up 0.25 s later', Math.abs(plus200.lag) < 0.03, `${plus200.lag.toFixed(3)} rad`)

  // One overshoot past neutral is the whole point of zeta < 1: it is what a
  // rigid rotation can never do.
  const after = samples.filter((s) => s.t > 2.05)
  const overshoot = Math.max(...after.map((s) => s.lag))
  check('they swing slightly past neutral once', overshoot > 0.005 && overshoot < 0.08, `+${overshoot.toFixed(3)} rad`)

  const settled = at(3.0)
  check('and settle within 1 s of the body', Math.abs(settled.lag) < 0.01, `${settled.lag.toFixed(3)} rad`)
  const later = samples.filter((s) => s.t >= 3.0)
  check('no residual offset far from the turn', maxAbs(later.map((s) => s.lag)) < 0.01)
}

// ------------------------------------------------------------ frame-rate
console.log('')
console.log('4) the spring integrates the same at 120 fps, 60, 30 and 20 fps')
{
  const runs = [1 / 120, 1 / 60, 1 / 30, 0.05].map((dt) => ({ dt, ...plannedTurn({ dt }) }))
  for (const r of runs) {
    console.log(`     dt ${r.dt.toFixed(4)} -> peak ${r.peak.toFixed(3)} rad, finite ${r.samples.every((s) => Number.isFinite(s.lag))}`)
  }
  const peaks = runs.map((r) => r.peak)
  const spread = Math.max(...peaks) - Math.min(...peaks)
  check('peak lag is frame-rate independent (< 5%)', spread < Math.max(...peaks) * 0.05, `spread ${spread.toFixed(4)}`)
  check('all samples finite', runs.every((r) => r.samples.every((s) => Number.isFinite(s.lag) && Number.isFinite(s.brace))))
  check(
    'lag never exceeds the cap',
    runs.every((r) => r.samples.every((s) => Math.abs(s.lag) <= TURN_LAG_DEFAULTS.limit + 1e-9)),
  )
}

// ------------------------------------------------------- yaw wrap / abuse
console.log('')
console.log('5) a yaw jump (wrap, debug pin, restored state) cannot kick the crown')
{
  const st = createTurnLag()
  const dt = 1 / 60
  let worst = 0
  // A half turn planned at 60 fps, then a teleport across the +-pi seam: the
  // measured rate must be taken the short way round, not 2pi / dt.
  for (let f = 0; f < 200; f++) stepTurnLag(st, 3.0, dt)
  const seam = stepTurnLag(st, -3.0, dt)
  worst = Math.max(worst, Math.abs(seam))
  for (let f = 0; f < 200; f++) worst = Math.max(worst, Math.abs(stepTurnLag(st, -3.0, dt)))
  check('wrap seam keeps the lag bounded', worst <= TURN_LAG_DEFAULTS.limit + 1e-9, `${worst.toFixed(3)} rad`)
  const dead = stepTurnLag(st, -3.0, 0)
  check('dt 0 is a no-op (paused tab)', Number.isFinite(dead))
  const nan = stepTurnLag(st, Number.NaN, dt)
  check('NaN yaw does not poison the spring', Number.isFinite(nan), `${nan.toFixed(3)}`)
}

// --------------------------------------------------------- pose geometry
console.log('')
console.log('6) the pose: tips swing, roots do not, neighbours stay apart')
{
  const makePoints = () => Array.from({ length: ARM_COUNT * POINTS_PER_ARM }, () => ({ x: 0, y: 0, z: 0 }))
  const makeState = () => ({
    time: 30,
    strokePhase: 40,
    waveOffset: 10,
    effort: 1,
    swimX: 0.5,
    swimY: -0.2,
    yaw: 0,
    jetSurge: 0.4,
    pulse: 0.3,
    stretch: 0,
    coil: 0,
    armCurl: new Float32Array(ARM_COUNT),
    turnLag: 0,
    turnBrace: 0,
  })
  const ra = [0.2, 0.175, 0.15, 0.12, 0.09, 0.06, 0.035]
  const gapRatio = (pts) => {
    let worst = Infinity
    for (let k = 0; k < ARM_COUNT; k++) {
      const k2 = (k + 1) % ARM_COUNT
      for (let i = 1; i < POINTS_PER_ARM - 1; i++) {
        const a = pts[k * POINTS_PER_ARM + i]
        const b = pts[k2 * POINTS_PER_ARM + i]
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
        worst = Math.min(worst, d / (2 * ra[Math.min(i, ra.length - 1)]))
      }
    }
    return worst
  }

  const neutral = makePoints()
  computeArmTargets(neutral, makeState())

  const peak = 0.238
  const lagged = makePoints()
  const st = makeState()
  st.turnLag = peak
  st.turnBrace = 0.78
  computeArmTargets(lagged, st)

  const at = (pts, k, i) => pts[k * POINTS_PER_ARM + i]
  let rootMove = 0
  let midMove = 0
  let tipMove = 0
  for (let k = 0; k < ARM_COUNT; k++) {
    const root = at(neutral, k, 0)
    const rootL = at(lagged, k, 0)
    rootMove = Math.max(rootMove, Math.hypot(root.x - rootL.x, root.y - rootL.y, root.z - rootL.z))
    const mid = at(neutral, k, 4)
    const midL = at(lagged, k, 4)
    midMove = Math.max(midMove, Math.hypot(mid.x - midL.x, mid.y - midL.y, mid.z - midL.z))
    const tip = at(neutral, k, 7)
    const tipL = at(lagged, k, 7)
    tipMove = Math.max(tipMove, Math.hypot(tip.x - tipL.x, tip.y - tipL.y, tip.z - tipL.z))
  }
  check('the root stays with the mantle', rootMove < 1e-9, `${rootMove.toExponential(2)}`)
  check('the tip is towed furthest', tipMove > midMove * 1.5, `tip ${tipMove.toFixed(3)} vs mid ${midMove.toFixed(3)}`)
  check('the tip actually swings (0.2-1.0 world units)', tipMove > 0.2 && tipMove < 1.0, `${tipMove.toFixed(3)}`)
  check('lag larger than 90 deg is impossible by construction', Math.abs(TURN_LAG_DEFAULTS.limit) < Math.PI / 2)

  // THE hard constraint: rotating every arm by the same angle at a given point
  // index is a rigid rotation of that ring, so the neighbour gap is preserved
  // EXACTLY — including the vertical brace sink, which is also uniform per index.
  const neutralGap = gapRatio(neutral)
  const laggedGap = gapRatio(lagged)
  check(
    'neighbour gap is unchanged by the lag',
    Math.abs(laggedGap - neutralGap) < 1e-6,
    `${neutralGap.toFixed(4)} -> ${laggedGap.toFixed(4)}`,
  )
  check('neighbour gap still clears 1.15x sum of radii', laggedGap >= 1.15, `${laggedGap.toFixed(3)}`)
  // And in the other direction, symmetric.
  const other = makePoints()
  const st2 = makeState()
  st2.turnLag = -peak
  st2.turnBrace = 0.78
  computeArmTargets(other, st2)
  check('the other shoulder is symmetric', Math.abs(gapRatio(other) - neutralGap) < 1e-6)
}

console.log('')
if (failures > 0) {
  console.log(`TURN-LAG-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('TURN-LAG-CHECK PASSED')
