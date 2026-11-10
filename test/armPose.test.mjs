/**
 * Invariant tests for the arm pose solver.
 *
 * These exist because two shipped bugs (0.9.11, 0.9.15) were both the same
 * mistake: `sin(clock * state)`. Both were invisible at startup and got worse
 * with uptime, so only a long-run test can catch them.
 *
 * Run: node test/armPose.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  ARM_COUNT,
  POINTS_PER_ARM,
  computeArmTargets,
  advanceStrokePhase,
  advanceWaveOffset,
} from '../src/scene/armPose.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const makePoints = () => Array.from({ length: ARM_COUNT * POINTS_PER_ARM }, () => ({ x: 0, y: 0, z: 0 }))
const makeState = () => ({
  time: 0,
  strokePhase: 0,
  waveOffset: 0,
  effort: 0.25,
  swimX: 0.5,
  swimY: -0.2,
  yaw: 0,
  jetSurge: 0,
  pulse: 0,
  stretch: 0,
  coil: 0,
  armCurl: new Float32Array(ARM_COUNT),
})

const maxDelta = (a, b) => {
  let m = 0
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - b[i].x
    const dy = a[i].y - b[i].y
    const dz = a[i].z - b[i].z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > m) m = d
  }
  return m
}

const allFinite = (pts) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))

/**
 * Drive the solver exactly like the render loop does, including the accumulated
 * phases, and return the largest per-frame point displacement.
 * @param {object} opts
 * @returns {{peakDelta:number, finite:boolean, frames:number}}
 */
function runSim({ warmSeconds = 0, seconds = 4, dt = 1 / 60, rampSwim = false }) {
  const state = makeState()
  const prev = makePoints()
  const cur = makePoints()
  let swimAmount = 0.25
  let momentum = 0
  let peak = 0
  let finite = true
  let frames = 0

  const simulate = (n) => {
    for (let f = 0; f < n; f++) {
      // moments of host-driven effort, mirroring client-entry's ramp
      if (rampSwim) swimAmount = Math.min(1, swimAmount + dt * 2.2 * (1 - swimAmount))
      momentum *= Math.exp(-0.42 * dt)
      // a jet every ~7 s keeps momentum alive like the real loop
      if (f % 420 === 0) momentum = Math.min(1.6, momentum + 1.0)
      const effort = Math.max(swimAmount, momentum * 0.72)
      const swimPose = Math.min(1, Math.max(0, effort * (0.55 + 0.45 * state.jetSurge)))

      state.time += dt * 1.42
      state.effort = effort
      state.strokePhase = advanceStrokePhase(state.strokePhase, dt, swimPose, state.jetSurge)
      state.waveOffset = advanceWaveOffset(state.waveOffset, dt, state.waveOffset === 0 ? 0 : 1)

      computeArmTargets(cur, state)
      if (!finite || !allFinite(cur)) finite = false
      if (frames > 0) {
        const d = maxDelta(prev, cur)
        if (d > peak) peak = d
      }
      for (let i = 0; i < cur.length; i++) {
        prev[i].x = cur[i].x
        prev[i].y = cur[i].y
        prev[i].z = cur[i].z
      }
      frames++
    }
  }

  // Long idle warm-up: this is what exposes `clock * state` bugs.
  simulate(Math.round(warmSeconds / dt))
  frames = 0
  peak = 0
  // Now the layer moves and effort ramps — the exact moment both bugs appeared.
  state.coil = 0
  state.waveOffset = 0
  simulate(Math.round(seconds / dt))
  return { peakDelta: peak, finite, frames }
}

console.log('arm pose invariants')
console.log('')

// ---------------------------------------------------------------- uptime
console.log('1) frame-to-frame displacement stays bounded regardless of uptime')
{
  const results = []
  for (const warm of [0, 120, 300, 900]) {
    const r = runSim({ warmSeconds: warm, seconds: 4, rampSwim: true })
    results.push({ warm, ...r })
  }
  for (const r of results) {
    console.log(
      `     warm ${String(r.warm).padStart(3)}s -> peak delta ${r.peakDelta.toFixed(4)} over ${r.frames} frames`,
    )
  }
  const worst = Math.max(...results.map((r) => r.peakDelta))
  // A normal frame moves a point by well under 0.1 world units; the 0.9.11 bug
  // produced deltas orders of magnitude larger because the phase rate exploded.
  check('peak delta < 0.12 world units', worst < 0.12, `worst ${worst.toFixed(4)}`)
  const spread = Math.max(...results.map((r) => r.peakDelta)) - Math.min(...results.map((r) => r.peakDelta))
  check('delta does not grow with uptime', spread < 0.02, `spread ${spread.toFixed(4)}`)
  check('all coordinates finite', results.every((r) => r.finite))
}

// ---------------------------------------------------------------- spacing
console.log('')
console.log('2) neighbouring arms never collapse into each other')
{
  // radii copied from sdfShader.js armCode(); two capsules touch when their
  // centre distance drops below ra_i + ra_i
  const ra = [0.2, 0.175, 0.15, 0.12, 0.09, 0.06, 0.035]
  const state = makeState()
  state.effort = 1
  state.jetSurge = 0.4
  state.time = 30
  state.strokePhase = 40
  state.waveOffset = 10
  const pts = makePoints()
  computeArmTargets(pts, state)
  const at = (k, i) => pts[k * POINTS_PER_ARM + i]
  let worstRatio = Infinity
  let worstAt = ''
  for (let k = 0; k < ARM_COUNT; k++) {
    const k2 = (k + 1) % ARM_COUNT
    // Point 0 is the root: all eight are deliberately packed inside the mantle
    // and blended into it by shader segment 0 (blend 0.08). Overlap there is
    // the design, so the separation guarantee starts at the first free segment.
    for (let i = 1; i < POINTS_PER_ARM - 1; i++) {
      const a = at(k, i)
      const b = at(k2, i)
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
      const need = 2 * ra[Math.min(i, ra.length - 1)]
      const ratio = d / need
      if (ratio < worstRatio) {
        worstRatio = ratio
        worstAt = `arm ${k}/${k2} point ${i}`
      }
    }
  }
  check('adjacent arm gap >= 1.0x sum of radii', worstRatio >= 1.0, `min ratio ${worstRatio.toFixed(2)} at ${worstAt}`)
  check('adjacent arm gap >= 1.15x (no visible skirting)', worstRatio >= 1.15, `min ratio ${worstRatio.toFixed(2)}`)
}

// ---------------------------------------------------------------- static scan
console.log('')
console.log('3) no phase is built as clock * state in the pose sources')
{
  const files = ['src/scene/armPose.js', 'src/scene/SdfOctopus.js', 'src/scene/sdfShader.js']
  const offenders = []
  for (const rel of files) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8')
    // A sin/cos argument may start with `t * <number>` (constant frequency) but
    // must never be `t * <identifier>` - that is the exact t·f'(t) runaway.
    const re = /Math\.(?:sin|cos|tan)\(\s*([A-Za-z_$][\w$]*)\s*\*\s*([A-Za-z_$][\w$]*)/g
    let m
    while ((m = re.exec(src)) !== null) {
      // Only a *variable* clock is dangerous. `Math.PI`, `Math.*` results and
      // the TAU constant are fine; so is any numeric literal (which the pattern
      // above already excludes).
      if (/^Math$/.test(m[1]) || /^Math/.test(m[2])) continue
      if (/^(?:Math\.PI|TAU)$/.test(m[2])) continue
      offenders.push(`${rel}: ${m[0]}`)
    }
  }
  check('no sin(clock * identifier) anywhere', offenders.length === 0, offenders.join(' | ') || 'clean')
}

console.log('')
if (failures > 0) {
  console.log(`POSE-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('POSE-CHECK PASSED')
