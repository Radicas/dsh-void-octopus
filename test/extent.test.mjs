/**
 * "The tentacles get cut by a boundary when they splay" — the invariant suite.
 *
 * 0.9.30 fixed two real causes, and both are the kind of thing that silently
 * comes back when someone tunes a constant:
 *
 *  1. the shader's whole-creature cull sphere was a hardcoded 2.1 world units,
 *     while the control points (which already carry the tip spring's overshoot)
 *     reach 2.17 — everything outside the sphere is never marched, so the
 *     outermost arm pixels were deleted. It is now derived from the uploaded
 *     points (`uCullR`) and may never be a constant again;
 *  2. the CSS mask used to start fading at 0.63 of a half box, so the splayed
 *     arms were dimmed to ~20% opacity exactly at their widest — read as the
 *     tentacles being cropped. It now only fades the canvas border.
 *
 * The geometric envelope is computed from the REAL pose solver plus the REAL
 * arm spring, so "it fits" is a number, not an opinion.
 *
 * Run: node test/extent.test.mjs
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
  TURN_LAG_DEFAULTS,
} from '../src/scene/armPose.js'
import { FOV_SCALE, ARM_POINT_RADIUS } from '../src/scene/sdfShader.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

let failures = 0
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ------------------------------------------------------------------ envelope
// The shader's camera and the CPU probe's projection must be the same math.
const PROJ = 4 / 1.9 / FOV_SCALE
const CAM_Z = 4.3
const FOCUS_Y = 0.35
const N = ARM_COUNT * POINTS_PER_ARM
const BOX_PX = 500 * FOV_SCALE // 500 px is the apparent-size datum the CSS mirrors

/** The arm spring exactly as SdfOctopus integrates it (2 substeps, 60 fps). */
function runEnvelope({ seconds = 60, dt = 1 / 60 } = {}) {
  const makePoints = () => Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0 }))
  const targets = makePoints()
  const points = makePoints()
  const vel = makePoints()
  const armCurl = new Float32Array(ARM_COUNT)
  const stiff = new Float32Array(N)
  const damp = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const p = i & 7
    const k = 800 - p * 100
    stiff[i] = k
    damp[i] = 2 * Math.sqrt(k) * (0.93 - p * 0.082)
  }
  const state = {
    time: 0,
    strokePhase: 0,
    waveOffset: 0,
    effort: 0,
    swimX: 0.5,
    swimY: -0.2,
    yaw: 0,
    jetSurge: 0,
    pulse: 0.3,
    stretch: 0,
    coil: 0,
    armCurl,
    turnLag: 0,
    turnBrace: 0,
  }
  let worstNdc = 0
  let worstRadius = 0
  const sub = dt / 2
  for (let step = 0; step < seconds / dt; step++) {
    const t = step * dt
    const wave = Math.sin(t * 0.9)
    const burst = Math.max(0, Math.sin(t * 2.3))
    state.time = t
    state.effort = 0.5 + 0.5 * wave
    state.strokePhase = advanceStrokePhase(state.strokePhase, dt, 0.6, 0.3)
    state.waveOffset = advanceWaveOffset(state.waveOffset, dt, 0.5 + 0.5 * wave)
    state.jetSurge = Math.max(0, Math.sin(t * 1.7))
    state.stretch = burst
    state.coil = Math.max(0, Math.sin(t * 0.37 + 1))
    state.turnLag = TURN_LAG_DEFAULTS.limit * Math.sin(t * 1.3)
    state.turnBrace = Math.min(1, Math.abs(Math.sin(t * 1.3)))
    armCurl.fill(burst * 0.85)
    computeArmTargets(targets, state)
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < N; i++) {
        const p = points[i]
        const v = vel[i]
        const tg = targets[i]
        v.x += ((tg.x - p.x) * stiff[i] - v.x * damp[i]) * sub
        v.y += ((tg.y - p.y) * stiff[i] - v.y * damp[i]) * sub
        v.z += ((tg.z - p.z) * stiff[i] - v.z * damp[i]) * sub
        p.x += v.x * sub
        p.y += v.y * sub
        p.z += v.z * sub
      }
    }
    for (let i = 0; i < N; i++) {
      const p = points[i]
      const r = ARM_POINT_RADIUS[i & 7]
      const rad = Math.hypot(p.x, p.z)
      const radius = Math.hypot(rad, p.y - FOCUS_Y, 0) + r
      if (radius > worstRadius) worstRadius = radius
      // Worst yaw: rotate the point around the body axis and also pick the ring
      // angle that pushes it toward the camera (which magnifies it).
      for (const a of [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2]) {
        const pa = Math.atan2(p.z, p.x) + a
        const x = rad * Math.cos(pa)
        const z = rad * Math.sin(pa)
        const den = Math.max(0.6, CAM_Z - z)
        const ndc = (Math.abs(x) + r) * (PROJ / den)
        const ndcY = (Math.abs(p.y - FOCUS_Y) + r) * (PROJ / den)
        const m = Math.max(ndc, ndcY)
        if (m > worstNdc) worstNdc = m
      }
    }
  }
  return { worstNdc, worstRadius }
}

console.log('extent invariants (the "tentacles get cut at the boundary" class)')
console.log('')

const env = runEnvelope()
console.log(`1) geometric envelope over a 60 s pose sweep (spring included)`)
console.log(`     worst projected extent ${env.worstNdc.toFixed(4)} NDC  (canvas edge = 1.0)`)
console.log(`     worst world radius ${env.worstRadius.toFixed(3)} from the focus`)
{
  check(
    'the silhouette fits the canvas with room for the bloom (< 0.97)',
    env.worstNdc < 0.97,
    `${env.worstNdc.toFixed(4)} — ${((1 - env.worstNdc) * (BOX_PX / 2)).toFixed(1)} px headroom`,
  )
  check(
    'the canvas headroom exceeds a realistic bloom spill (> 8 px)',
    (1 - env.worstNdc) * (BOX_PX / 2) > 8,
    `${((1 - env.worstNdc) * (BOX_PX / 2)).toFixed(1)} px`,
  )
  check(
    'the arm spring can push the tips past the old hardcoded 2.1 cull sphere',
    env.worstRadius > 2.1,
    `worst ${env.worstRadius.toFixed(3)} > 2.1 — this is exactly what used to be deleted`,
  )
}

// -------------------------------------------------------------- static scans
console.log('')
console.log('2) the cull sphere is derived, not hardcoded')
{
  const shader = src('src/scene/sdfShader.js')
  const engine = src('src/scene/SdfOctopus.js')
  check('the shader declares uCullR', /uniform\s+float\s+uCullR\s*;/.test(shader))
  check('the shader uses uCullR for the early-out', /uCullR\s*\*\s*uCullR/.test(shader))
  check('the old hardcoded 2.1 sphere is gone', !/2\.1\s*\*\s*2\.1/.test(shader))
  check('the engine writes uCullR every frame', /uniforms\.uCullR\.value\s*=/.test(engine))
  check(
    'the engine computes it from the uploaded points plus a margin',
    /fromFocus\s*>?\s*cullR/.test(engine) && /cullR\s*\+\s*0?\.?05/.test(engine),
  )
}

console.log('')
console.log('3) the CSS mask can only hide the canvas border, never dim the creature')
{
  const entry = src('src/client-entry.js')
  const mask = entry.match(/radial-gradient\(ellipse at 50% 50%, #000 ([\d.]+)%, rgba\(0, 0, 0, 0\.72\) ([\d.]+)%, transparent ([\d.]+)%\)/)
  check('the mask is still there', mask != null)
  if (mask != null) {
    const opaque = Number(mask[1]) / 100
    const clear = Number(mask[3]) / 100
    // The gradient's 100% is the farthest CORNER, so full transparency at the
    // canvas edge (half box) means clear >= 1 / sqrt(2).
    check(
      'the mask reaches full transparency no later than the canvas edge',
      clear >= 1 / Math.SQRT2 - 1e-3,
      `${(clear * 100).toFixed(1)}% of the corner = ${(clear * Math.SQRT2 * 100).toFixed(1)}% of the half box`,
    )
    // And it must stay opaque past the worst-case silhouette: 1.0 (NDC) is the
    // canvas edge, which sits at 1/sqrt(2) of the corner.
    const opaqueInNdc = opaque / (1 / Math.SQRT2)
    check(
      'the mask is fully opaque past the widest pose',
      opaqueInNdc >= env.worstNdc,
      `opaque to ${opaqueInNdc.toFixed(3)} NDC vs worst ${env.worstNdc.toFixed(3)}`,
    )
  }
}

console.log('')
console.log('4) the field of view and the CSS box stay in step')
{
  const entry = src('src/client-entry.js')
  const desktop = entry.match(/width: min\(([\d.]+)vw, (\d+)px\)/)
  const mobile = entry.match(/@media \(max-width: 720px\)[\s\S]*?width: min\(([\d.]+)vw, (\d+)px\)/)
  check('desktop box found', desktop != null)
  check('mobile box found', mobile != null)
  if (desktop != null) {
    check(
      'desktop base box == 500 px * FOV_SCALE (apparent size unchanged)',
      Math.abs(Number(desktop[2]) - 500 * FOV_SCALE) < 0.51,
      `${desktop[2]} px vs ${500 * FOV_SCALE} px`,
    )
    check(
      'desktop vw cap == 42vw * FOV_SCALE',
      Math.abs(Number(desktop[1]) - 42 * FOV_SCALE) < 0.06,
      `${desktop[1]}vw vs ${(42 * FOV_SCALE).toFixed(2)}vw`,
    )
  }
  if (mobile != null) {
    check(
      'mobile base box == 400 px * FOV_SCALE',
      Math.abs(Number(mobile[2]) - 400 * FOV_SCALE) < 0.51,
      `${mobile[2]} px vs ${400 * FOV_SCALE} px`,
    )
  }
}

console.log('')
if (failures > 0) {
  console.log(`EXTENT-CHECK FAILED — ${failures} invariant(s) broken`)
  process.exit(1)
}
console.log('EXTENT-CHECK PASSED')
