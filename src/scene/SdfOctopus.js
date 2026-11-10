import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { sdfVertex, sdfFragment, ARM_POINT_RADIUS } from './sdfShader.js'
import { computeArmTargets, advanceStrokePhase, advanceWaveOffset } from './armPose.js'

export const ACTIVITIES = {
  idle: { speed: 0.72, glow: 0.75, energy: 0.22 },
  thinking: { speed: 1.08, glow: 1.0, energy: 0.48 },
  generating: { speed: 1.6, glow: 1.45, energy: 0.86 },
  tool: { speed: 2.2, glow: 1.25, energy: 1.0 },
}

/**
 * Palette presets. `deep` is the body base, `a` the rim/highlight, `b` the
 * depth/back hue, and the iris pair the only warm (or deliberately cold) note.
 * Values are authored as sRGB hex; three converts them to working space.
 */
export const PALETTES = {
  'deep-void': {
    label: 'Deep Void',
    deep: '#02060e',
    a: '#19d9ff',
    b: '#7b33e6',
    irisA: '#ffd761',
    irisB: '#b86a10',
  },
  abyss: {
    label: 'Abyss',
    deep: '#04121a',
    a: '#2ef2c8',
    b: '#f22e9e',
    irisA: '#ffb347',
    irisB: '#d4600c',
  },
  'pale-ghost': {
    label: 'Pale Ghost',
    deep: '#070a10',
    a: '#e8f6ff',
    b: '#7fa8c8',
    irisA: '#bfe9ff',
    irisB: '#4e7d9e',
  },
  ember: {
    label: 'Ember',
    deep: '#120608',
    a: '#ff7a3d',
    b: '#8e2a5e',
    irisA: '#4dfff0',
    irisB: '#1a8fa0',
  },
}

export const DEFAULT_PALETTE = 'abyss'

/**
 * Resolve which palette to draw.
 * Priority: Loader-row config > localStorage override > default. The storage
 * layer exists so a preset can be tried without editing and reloading config.
 * @param {unknown} requested palette id from config
 * @returns {string} a key of PALETTES
 */
export function resolvePalette(requested) {
  if (typeof requested === 'string' && PALETTES[requested] != null) return requested
  try {
    const stored = window.localStorage.getItem('dsh-void-octopus:palette-v1')
    if (typeof stored === 'string' && PALETTES[stored] != null) return stored
  } catch (err) {
    /* storage unavailable */
  }
  return DEFAULT_PALETTE
}

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt))

function makeArmPoints() {
  return Array.from({ length: 64 }, () => new THREE.Vector3())
}

export function createSdfOctopus({
  container = document.body,
  mode = 'demo',
  activity = 'idle',
  palette = DEFAULT_PALETTE,
  onStage,
} = {}) {
  // Boot progress for the host UI. Stages: "context" (WebGL ready), "compile"
  // (shader compilation started), "ready" (first frame has been drawn). The
  // callback must never break the scene.
  const reportStage = (name) => {
    try {
      if (typeof onStage === 'function') onStage(name)
    } catch (err) {
      /* a broken progress listener must not take the scene down */
    }
  }
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: mode === 'ambient',
    powerPreference: 'high-performance',
    preserveDrawingBuffer: mode !== 'ambient',
  })
  // The canvas is sized explicitly from CSS px × renderScale, where renderScale
  // is measured in device pixels. Leaving a device-pixel-ratio on the renderer
  // as well would multiply the two and make the adaptive range meaningless.
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.pointerEvents = 'none'
  reportStage('context')

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const uniforms = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uGlow: { value: 0.75 },
    uEnergy: { value: 0.22 },
    uPulse: { value: 0 },
    uBlink: { value: 0 },
    uPupil: { value: 1 },
    uGaze: { value: new THREE.Vector2(0, 0) },
    uYaw: { value: 0 },
    uPitch: { value: 0 },
    uRoll: { value: 0 },
    uOffset: { value: new THREE.Vector3(0, 0, 0) },
    uSwim: { value: new THREE.Vector2(0.5, -0.2) },
    uSwimAmount: { value: 0.25 },
    uArmPts: { value: makeArmPoints() },
    // Per-control-point tube radius, shared by the shader's arm loop and the
    // CPU-side bounding spheres.
    uRadii: { value: new Float32Array(ARM_POINT_RADIUS) },
    // Composed once per frame on the CPU: rotZ(-roll)·rotX(-pitch)·rotY(-yaw).
    // Doing it in the shader cost three mat3 multiplies per map() call, and
    // map() runs dozens of times per pixel.
    uInvRot: { value: new THREE.Matrix3() },
    // One conservative sphere per arm plus one for the body, in model space.
    // Sample points outside a sphere skip that shape's distance evaluation.
    uArmBound: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)) },
    uBodyBound: { value: new THREE.Vector4(0, 0.45, 0, 1.22) },
    // 1 = use the bounds, 0 = evaluate everything (A/B regression test only).
    uCull: { value: 1 },
    uColDeep: { value: new THREE.Color() },
    uColA: { value: new THREE.Color() },
    uColB: { value: new THREE.Color() },
    uIrisA: { value: new THREE.Color() },
    uIrisB: { value: new THREE.Color() },
  }

  /**
   * Push one preset into the palette uniforms.
   * @param {{deep:string,a:string,b:string,irisA:string,irisB:string}} def
   * @returns {void}
   */
  const applyPalette = (def) => {
    uniforms.uColDeep.value.set(def.deep)
    uniforms.uColA.value.set(def.a)
    uniforms.uColB.value.set(def.b)
    uniforms.uIrisA.value.set(def.irisA)
    uniforms.uIrisB.value.set(def.irisB)
  }
  let paletteName = PALETTES[palette] != null ? palette : DEFAULT_PALETTE
  applyPalette(PALETTES[paletteName])

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: sdfVertex,
    fragmentShader: sdfFragment,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  scene.add(quad)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    mode === 'ambient' ? 0.2 : 0.26,
    // A tighter radius keeps the eye highlights glowing without smearing the
    // whole silhouette — the old 0.45 was a large part of the "hazy" read.
    mode === 'ambient' ? 0.3 : 0.38,
    0.82,
  )
  composer.addPass(bloom)

  const mood = { ...ACTIVITIES[activity] }
  const targetMood = { ...ACTIVITIES[activity] }
  let activityName = activity
  let time = 0
  let last = performance.now()
  let raf = 0
  let disposed = false
  let paused = false
  let pulse = 0
  let jetTimer = 6 + Math.random() * 5
  let kick = 0
  let jetImpulse = 0
  let jetSurge = 0
  let yaw = 0
  let pitch = 0
  let roll = 0
  let lastYaw = 0
  const armCurl = new Float32Array(8)
  const armCurlTarget = new Float32Array(8)
  let stretch = 0
  let stretchTarget = 0
  // Stroke phase is INTEGRATED, never recomputed as `t * f(t)`. Multiplying a
  // running clock by a changing frequency gives an instantaneous rate of
  // `f + t·f'`, and that second term grows without bound: at t = 5 min it
  // amplified the arm wave ~290x and the whole body visibly vibrated. Only the
  // phase accumulates; the frequency itself stays near-constant, as a real
  // animal's does — changing effort changes amplitude, not cadence.
  let strokePhase = 0
  // One jet is an EVENT with an asymmetric envelope (quick contraction, slow
  // relaxation). A linearly-decayed flag reads as a machine, not an animal.
  let jetPhase = 1
  let jetDuration = 0.9
  // Void inertia. Water kills momentum almost immediately; vacuum does not.
  // A jet adds to this and it bleeds off very slowly, so one thrust becomes a
  // long glide with the arms still streamlined, then gradually relaxing.
  let momentum = 0
  // Whole-body actions that water would not allow: drawing every arm in and
  // then letting them unfurl, and a slow travelling ripple across the crown.
  let coil = 0
  let coilTarget = 0
  let waveAmount = 0
  let waveTarget = 0
  // The travelling-wave OFFSET is integrated, never `clock * amplitude`. Writing
  // `wavePhase * waveAmount` would multiply a running clock by a time-varying
  // amplitude, which is the exact t·f'(t) runaway that caused the original
  // vibration — the crown would shake for a moment every time a wave started.
  let waveOffset = 0
  let look = new THREE.Vector2(0, 0)
  let lookTarget = new THREE.Vector2(0, 0)
  let autonomyTimer = 2.5 + Math.random() * 3
  let action = null
  let actionTime = 0
  let actionDuration = 0
  let actionArm = -1
  const swim = new THREE.Vector2(0.5, -0.2)
  const swimTarget = new THREE.Vector2(0.5, -0.2)
  let swimAmount = 0.25
  let swimAmountTarget = 0.25
  let blinkTimer = 2.5 + Math.random() * 2.5
  let blinkActive = false
  let blinkProgress = 0
  let blinkDuration = 0.18
  let blink = 0
  const gaze = new THREE.Vector2()
  const gazeJitter = new THREE.Vector2()
  let gazeTimer = 0.7
  const pointer = new THREE.Vector2()
  const pointerTarget = new THREE.Vector2()
  const armTargets = makeArmPoints()
  const armPoints = uniforms.uArmPts.value
  // Velocity state for the per-point spring below. A one-pole lerp carries no
  // velocity, which is why it can only ever "stick" to its target: it is an
  // over-damped spring, so the arms never swung past a pose and settled back.
  const armVel = makeArmPoints()
  // Per-point spring constants are fixed, so solve them once. Stiffness and
  // damping ratio both fall from root to tip: the root stays with the body
  // (zeta 0.95, no overshoot), while the tip is under-damped (zeta 0.39) and
  // overshoots ~25% before ringing back — the towed-through-water feel.
  const armStiff = new Float32Array(armPoints.length)
  const armDamp = new Float32Array(armPoints.length)
  for (let i = 0; i < armPoints.length; i++) {
    const point = i & 7
    const k = 800 - point * 100
    armStiff[i] = k
    armDamp[i] = 2 * Math.sqrt(k) * (0.93 - point * 0.082)
  }

  // The view rotation is composed once per frame rather than rebuilt inside
  // every map() call (three mat3 products per sample point).
  const viewZ = new THREE.Matrix4()
  const viewX = new THREE.Matrix4()
  const viewY = new THREE.Matrix4()
  const viewInv = new THREE.Matrix4()
  const updateView = () => {
    viewZ.makeRotationZ(-roll)
    viewX.makeRotationX(-pitch)
    viewY.makeRotationY(-yaw)
    // Same order as the old in-shader chain: rotZ(-roll)·rotX(-pitch)·rotY(-yaw)
    viewInv.copy(viewZ).multiply(viewX).multiply(viewY)
    uniforms.uInvRot.value.setFromMatrix4(viewInv)
  }
  // Conservative per-arm bounding spheres, recomputed from the control points
  // that were actually uploaded this frame. A stale or too-small bound would
  // cull real geometry (phantom faces, holes), so this runs after the spring
  // integration and before the render, and the radius is only ever inflated.
  const armBounds = uniforms.uArmBound.value
  const updateArmBounds = () => {
    for (let k = 0; k < 8; k++) {
      const base = k << 3
      let cx = 0
      let cy = 0
      let cz = 0
      for (let i = 0; i < 8; i++) {
        const pt = armPoints[base + i]
        cx += pt.x
        cy += pt.y
        cz += pt.z
      }
      cx /= 8
      cy /= 8
      cz /= 8
      let r = 0
      for (let i = 0; i < 8; i++) {
        const pt = armPoints[base + i]
        const d = Math.hypot(pt.x - cx, pt.y - cy, pt.z - cz) + ARM_POINT_RADIUS[i]
        if (d > r) r = d
      }
      // +0.05 covers the largest smooth-union bulge (k/4 = 0.02) with margin.
      armBounds[k].set(cx, cy, cz, r + 0.05)
    }
  }

  // No artificial fps cap any more. The 24 fps ceiling was a deliberate power
  // trade-off, but it is also the single biggest reason the creature read as
  // janky: 24 fps against a 60 Hz display is a visible cadence mismatch on every
  // pan. The loop now runs at the display rate and the frame BUDGET is held by
  // adaptive resolution instead — drop pixels, never frames.
  //
  // 0.9.20: the budget is now expressed in DEVICE pixels, not CSS pixels. The
  // layer is 400 CSS px, but the canvas was drawn at 0.7× that (280 px) and then
  // upscaled by the compositor — the single largest source of blur. The floor is
  // also raised: 0.45 was fine as a last-resort safety valve, but it means 180 px
  // of geometry stretched over 400 px, which is mush.
  //
  // Culling the arms and the body by bounding volume made the shader ~7× cheaper
  // (16.0 → 2.3 ms/frame at the old 280 px on the same integrated GPU), so the
  // saved budget goes straight into pixels, plus a little supersampling.
  const dprCap = 1.6
  const currentDpr = () => clamp(window.devicePixelRatio || 1, 1, dprCap)
  let maxScale = Math.min(currentDpr() * 1.15, dprCap)
  let minScale = Math.min(maxScale, 0.9)
  let renderScale = Math.min(maxScale, 1.0)
  // Recovery is capped to just above the last affordable scale, so the loop
  // settles instead of oscillating between a quality it cannot pay for and one
  // it can.
  let scaleCeiling = maxScale
  let frameAvgMs = 16.7
  let lastScaleChange = 0
  // Verification hooks (test/perf.html) can pin the scale; the live layer keeps
  // the adaptive controller on.
  let adaptive = true
  // The ambient overlay schedules propulsion itself — one jet per cruise leg,
  // so the creature thrusts when it actually sets off. Left on, this timer
  // fires during a rest and re-streamlines the arms that are meant to be
  // opening. Demo / harness runs keep it on (the default).
  let autoJet = true

  const resize = () => {
    // clientWidth/Height are the LAYOUT box: unlike getBoundingClientRect they
    // ignore the layer's CSS transform, so a depth-scaled layer sizes its buffer
    // for the closest (largest) appearance instead of the scale it happens to be
    // at right now — otherwise approaching would upscale the canvas and blur.
    const rect = container.getBoundingClientRect()
    const w = Math.max(1, Math.floor(container.clientWidth || rect.width || window.innerWidth))
    const h = Math.max(1, Math.floor(container.clientHeight || rect.height || window.innerHeight))
    renderer.setSize(
      Math.max(1, Math.floor(w * renderScale)),
      Math.max(1, Math.floor(h * renderScale)),
      false,
    )
    const target = renderer.getDrawingBufferSize(new THREE.Vector2())
    uniforms.uResolution.value.copy(target)
    composer.setSize(target.x, target.y)
  }

  const onPointerMove = (event) => {
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    pointerTarget.x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    pointerTarget.y = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1)
  }

  const onVisibility = () => {
    paused = document.hidden
    last = performance.now()
  }

  const startAction = (busy = false) => {
    actionTime = 0
    if (busy) {
      // While the session is working only the two gestures that do not pull the
      // creature out of its "following along" posture stay available: a glance
      // and a blink. The big ones (arm / stretch / jet / coil / wave) stay off,
      // as they have since 0.9.3. The point is that the creature is no longer
      // frozen solid whenever the model is running — that read as "switched
      // off" rather than as "concentrating".
      if (Math.random() < 0.62) {
        action = 'look'
        actionDuration = 2.0 + Math.random() * 0.8
        lookTarget.set((Math.random() * 2 - 1) * 0.6, (Math.random() * 2 - 1) * 0.26)
      } else {
        action = 'blink'
        actionDuration = 0.5
        blinkTimer = 0
      }
      return
    }
    const pick = Math.random()
    if (pick < 0.18) {
      action = 'look'
      actionDuration = 2.4
      lookTarget.set((Math.random() * 2 - 1) * 0.7, (Math.random() * 2 - 1) * 0.32)
    } else if (pick < 0.34) {
      action = 'arm'
      actionDuration = 2.6
      actionArm = Math.floor(Math.random() * 8)
      armCurlTarget[actionArm] = 1
    } else if (pick < 0.48) {
      action = 'stretch'
      actionDuration = 2.3
      stretchTarget = 1
    } else if (pick < 0.60) {
      action = 'jet'
      actionDuration = 0.9
      pulse = 1
      kick = 1
      jetImpulse = 1
      jetPhase = 0
      jetDuration = 0.85 + Math.random() * 0.3
      momentum = Math.min(1.6, momentum + 1.0)
    } else if (pick < 0.70) {
      action = 'blink'
      actionDuration = 0.5
      blinkTimer = 0
    } else if (pick < 0.85) {
      // Draw the whole crown in, hold, then let it unfurl. In vacuum there is
      // no water pressure to spring the arms back, so this needs its own slow
      // relaxation rather than a bounce.
      action = 'coil'
      actionDuration = 3.4
      coilTarget = 1
    } else {
      // A ripple that travels around the arm crown — no propulsion, just the
      // body rearranging itself in free space.
      action = 'wave'
      actionDuration = 3.6
      waveTarget = 1
    }
  }

  // Thin wrapper: the pose maths lives in armPose.js so it is unit-testable.
  // Two sin(t*f(t)) phase bugs shipped because this block used to be unreachable
  // from any test; see test/armPose.test.mjs.
  const armState = {
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
    armCurl,
  }

  const buildArms = (t) => {
    armState.time = t
    armState.strokePhase = strokePhase
    armState.waveOffset = waveOffset
    armState.effort = Math.max(swimAmount, momentum * 0.72)
    armState.swimX = swim.x
    armState.swimY = swim.y
    armState.yaw = yaw
    armState.jetSurge = jetSurge
    armState.pulse = pulse
    armState.stretch = stretch
    armState.coil = coil
    computeArmTargets(armTargets, armState)
  }

  buildArms(0)
  armPoints.forEach((p, i) => p.copy(armTargets[i]))

  const frame = (now) => {
    if (disposed) return
    if (paused) {
      last = now
      raf = requestAnimationFrame(frame)
      return
    }
    const rawMs = Math.max(0.001, now - last)
    const dt = Math.min(0.05, Math.max(0.001, rawMs / 1000))
    last = now

    // Adaptive resolution: dropping is immediate, recovery is slow and capped,
    // so the loop converges on an affordable scale instead of hunting.
    frameAvgMs += (Math.min(rawMs, 60) - frameAvgMs) * 0.06
    if (!adaptive) {
      // pinned by a verification harness
    } else if (frameAvgMs > 20 && renderScale > minScale && now - lastScaleChange > 700) {
      renderScale = Math.max(minScale, renderScale * 0.88)
      scaleCeiling = Math.min(maxScale, renderScale * 1.12)
      resize()
      lastScaleChange = now
    } else if (frameAvgMs < 17.3 && renderScale < scaleCeiling && now - lastScaleChange > 3000) {
      renderScale = Math.min(scaleCeiling, renderScale * 1.05)
      resize()
      lastScaleChange = now
    }

    time += dt * (0.7 + mood.speed)

    for (const key of Object.keys(mood)) {
      mood[key] = damp(mood[key], targetMood[key], 2.4, dt)
    }

    pointer.lerp(pointerTarget, 1 - Math.exp(-4 * dt))
    gazeTimer -= dt
    if (gazeTimer <= 0) {
      gazeTimer = 0.8 + Math.random() * 2.0
      gazeJitter.set((Math.random() * 2 - 1) * 0.7, (Math.random() * 2 - 1) * 0.5)
    }
    const attention = Math.min(1, Math.hypot(pointer.x, pointer.y) * 1.45)
    gaze.x = damp(gaze.x, clamp(pointer.x * 0.7 * attention + gazeJitter.x * (1 - attention * 0.6), -1, 1), 8, dt)
    gaze.y = damp(gaze.y, clamp(pointer.y * 0.55 * attention + gazeJitter.y * (1 - attention * 0.6), -1, 1), 8, dt)

    blinkTimer -= dt
    if (blinkTimer <= 0 && !blinkActive) {
      blinkActive = true
      blinkProgress = 0
      blinkDuration = Math.random() < 0.16 ? 0.32 : 0.16
      blinkTimer = 2.2 + Math.random() * 4.0
    }
    if (blinkActive) {
      blinkProgress += dt
      const p = clamp(blinkProgress / blinkDuration, 0, 1)
      blink = Math.sin(p * Math.PI)
      if (p >= 1) {
        blinkActive = false
        blink = 0
        if (Math.random() < 0.2) blinkTimer = 0.26
      }
    }

    const busy = activityName !== 'idle'
    if (busy) {
      // Drop any big gesture that was under way when the session started. The
      // quiet pool below is allowed to keep running.
      stretchTarget = 0
      coilTarget = 0
      waveTarget = 0
      for (let i = 0; i < 8; i++) armCurlTarget[i] = 0
      if (action != null && action !== 'look' && action !== 'blink') {
        action = null
        actionArm = -1
      }
    }
    if (action == null) {
      autonomyTimer -= dt
      if (autonomyTimer <= 0) startAction(busy)
    } else {
      actionTime += dt
      if (actionTime >= actionDuration) {
        lookTarget.set(0, 0)
        if (actionArm >= 0) armCurlTarget[actionArm] = 0
        stretchTarget = 0
        coilTarget = 0
        waveTarget = 0
        action = null
        actionArm = -1
        autonomyTimer = (busy ? 5.5 : 2.5) + Math.random() * 4
      }
    }
    look.x = damp(look.x, lookTarget.x, 3.0, dt)
    look.y = damp(look.y, lookTarget.y, 3.0, dt)
    stretch = damp(stretch, stretchTarget, 3.2, dt)
    for (let i = 0; i < 8; i++) armCurl[i] = damp(armCurl[i], armCurlTarget[i], 3.6, dt)
    // Coil and crown-ripple are slower than the arm springs on purpose: in
    // vacuum nothing pushes back, so a shape change is committed to in full and
    // released gradually.
    coil = damp(coil, coilTarget, 1.9, dt)
    waveAmount = damp(waveAmount, waveTarget, 1.6, dt)
    waveOffset = advanceWaveOffset(waveOffset, dt, waveAmount)
    kick = Math.max(0, kick - dt * 2.4)
    jetImpulse = Math.max(0, jetImpulse - dt * 1.1)

    // Jet envelope: a quick contraction over the first 22% of the event, then a
    // slow relaxation whose exponent lets the tail trail off instead of
    // snapping to zero. This asymmetry is what separates "an animal pushed
    // itself" from "a value oscillated".
    if (jetPhase < 1) {
      jetPhase = Math.min(1, jetPhase + dt / jetDuration)
      jetSurge =
        jetPhase < 0.22
          ? Math.sin((jetPhase / 0.22) * (Math.PI / 2))
          : Math.pow(Math.cos(((jetPhase - 0.22) / 0.78) * (Math.PI / 2)), 1.6)
    } else {
      jetSurge = 0
    }

    if (autoJet) {
      jetTimer -= dt
      if (jetTimer <= 0) {
        pulse = 1
        kick = Math.max(kick, 0.55)
        jetImpulse = 1
        jetPhase = 0
        jetDuration = 0.85 + Math.random() * 0.3
        momentum = Math.min(1.6, momentum + 1.0)
        jetTimer = (6 + Math.random() * 6) * (1 - swimAmount * 0.35)
      }
    }

    // Void inertia: almost no bleed-off. One thrust carries the body for
    // seconds, which is what separates a glide from a decay.
    momentum *= Math.exp(-0.42 * dt)

    swim.lerp(swimTarget, 1 - Math.exp(-2.5 * dt))
    swimAmount = damp(swimAmount, swimAmountTarget, 2.2, dt)

    // Advance the stroke phase by the CURRENT cadence. Effort may drift the
    // cadence slightly, but because we integrate, the instantaneous rate always
    // equals the frequency — no time-dependent runaway, no vibration.
    const swimPoseNow = clamp(swimAmount * (0.55 + 0.45 * jetSurge), 0, 1)
    strokePhase = advanceStrokePhase(strokePhase, dt, swimPoseNow, jetSurge)

    // The body follows travel with a little inertia; banking comes from the
    // turn rate, not directly from velocity, so straight glides stay level.
    const targetYaw = clamp(
      Math.sin(time * 0.11) * 0.02 +
        pointer.x * 0.05 +
        look.x * 0.18 +
        swim.x * (0.5 + jetSurge * 0.1) * swimAmount,
      -0.8,
      0.8,
    )
    const targetPitch = clamp(
      -0.02 - pointer.y * 0.04 + look.y * 0.1 + swim.y * (0.24 + jetSurge * 0.08) * swimAmount,
      -0.5,
      0.5,
    )
    yaw = damp(yaw, targetYaw, 2.6, dt)
    pitch = damp(pitch, targetPitch, 2.6, dt)
    const yawRate = (yaw - lastYaw) / Math.max(dt, 1e-3)
    lastYaw = yaw
    roll = damp(
      roll,
      Math.sin(time * 0.17) * 0.015 +
        clamp(-yawRate * 0.35, -0.12, 0.12) +
        swim.x * 0.03 * swimAmount,
      3.2,
      dt,
    )

    buildArms(time)
    // Secondary motion: every control point is a damped spring chasing its
    // animated target, integrated semi-implicitly (velocity first, then
    // position) in two substeps so the stiff root stays stable at a 24 fps
    // frame step. The root tracks the body; the tip overshoots and rings back,
    // which is what turns a posed curve into a towed one.
    const SUBSTEPS = 2
    const sub = dt / SUBSTEPS
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < armPoints.length; i++) {
        const p = armPoints[i]
        const v = armVel[i]
        const target = armTargets[i]
        const k = armStiff[i]
        const c = armDamp[i]
        v.x += ((target.x - p.x) * k - v.x * c) * sub
        v.y += ((target.y - p.y) * k - v.y * c) * sub
        v.z += ((target.z - p.z) * k - v.z * c) * sub
        p.addScaledVector(v, sub)
      }
    }

    updateView()
    updateArmBounds()
    uniforms.uTime.value = time
    uniforms.uGlow.value = mood.glow + pulse * 0.2
    uniforms.uEnergy.value = mood.energy
    uniforms.uPulse.value = pulse
    uniforms.uBlink.value = blink
    uniforms.uPupil.value = 0.86 + mood.energy * 0.34 + Math.sin(time * 0.8) * 0.05
    uniforms.uGaze.value.copy(gaze)
    uniforms.uSwim.value.copy(swim)
    uniforms.uSwimAmount.value = Math.max(swimAmount, momentum * 0.72)

    uniforms.uYaw.value = yaw
    uniforms.uPitch.value = pitch
    uniforms.uRoll.value = roll
    const breathLift = Math.sin(time * 0.55) * 0.045 + kick * 0.12 - swim.y * 0.035 * swimAmount
    // Three axes of slow drift at mutually incommensurable rates, so the
    // position never repeats. "Down" is not special out here: the body wanders
    // as readily sideways as vertically.
    uniforms.uOffset.value.set(
      Math.sin(time * 0.19) * 0.04 + Math.sin(time * 0.071 + 1.3) * 0.022,
      breathLift,
      Math.cos(time * 0.23) * 0.034 + Math.cos(time * 0.089 + 2.1) * 0.018,
    )
    pulse = Math.max(0, pulse - dt * 1.8)

    composer.render()
    raf = requestAnimationFrame(frame)
  }

  // A viewport change is a different cost regime, so let the adaptive scale try
  // the full range again instead of staying capped by the old layout.
  const onWindowResize = () => {
    // Dragging the window to a different monitor changes devicePixelRatio, so
    // the whole scale envelope is recomputed rather than just the size.
    maxScale = Math.min(currentDpr() * 1.15, dprCap)
    minScale = Math.min(maxScale, 0.9)
    renderScale = clamp(renderScale, minScale, maxScale)
    scaleCeiling = maxScale
    resize()
  }

  resize()
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onWindowResize)

  // Shader compilation is the one genuinely slow, main-thread-blocking step of
  // boot (ANGLE has to translate the unrolled SDF to HLSL and run the D3D
  // compiler). Starting the render loop straight away would block the page the
  // moment the layer mounts; instead compile first — asynchronously when
  // KHR_parallel_shader_compile is available — and only then start drawing.
  // The host UI shows its own ring until reportStage('ready') fires.
  //
  // The timeout matters: `compileAsync` can stay pending indefinitely on some
  // driver/extension combinations (observed on headless ANGLE/D3D11), and the
  // creature must never depend on that promise to appear. When the fallback
  // fires, the first render blocks for as long as the compile needs — with the
  // compositor-animated ring still turning.
  let started = false
  let firstFrameMs = 0
  const start = () => {
    if (disposed || started) return
    started = true
    last = performance.now()
    const began = performance.now()
    frame(began)
    firstFrameMs = performance.now() - began
    reportStage('ready')
  }
  reportStage('compile')
  let compileSettled = false
  let compileFallback = 0
  const startOnce = () => {
    if (compileSettled) return
    compileSettled = true
    window.clearTimeout(compileFallback)
    try {
      start()
    } catch (err) {
      console.warn('[dsh-void-octopus] first frame failed:', err)
    }
  }
  // The timeout only exists so a driver that never reports completion cannot
  // hold the creature back forever; it is deliberately longer than a normal
  // compile so the async path (which keeps the page responsive) wins.
  compileFallback = window.setTimeout(startOnce, 8000)
  try {
    if (typeof renderer.compileAsync === 'function') renderer.compileAsync(scene, camera).then(startOnce, startOnce)
    else startOnce()
  } catch (err) {
    startOnce()
  }

  return {
    /**
     * Verification hooks. They only exist so a headless browser can pin the
     * render scale and time real frames (see test/perf.html); the shipped layer
     * never calls them.
     */
    debug: {
      setRenderScale(value) {
        adaptive = false
        renderScale = clamp(value, 0.2, 2)
        resize()
        return renderScale
      },
      setAdaptive(value) {
        adaptive = Boolean(value)
      },
      /** Freeze animation so two captures share the exact same pose. */
      pause() {
        paused = true
      },
      resume() {
        paused = false
        last = performance.now()
      },
      /**
       * Disable the bounding-volume early-outs without touching anything else.
       * Rendering the same paused pose twice (culling on/off) is the regression
       * test that proves the cull never changes the image.
       */
      setCulling(enabled) {
        uniforms.uCull.value = enabled ? 1 : 0
        return Boolean(enabled)
      },
      getStats() {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2())
        const rect = container.getBoundingClientRect()
        return {
          renderScale,
          scaleCeiling,
          adaptive,
          frameAvgMs,
          firstFrameMs,
          hidden: document.hidden,
          paused,
          buffer: [size.x, size.y],
          css: [rect.width, rect.height],
          dpr: window.devicePixelRatio || 1,
        }
      },
      /** Force `frames` complete renders and return the mean wall time (ms). */
      renderFrames(frames = 30) {
        // gl.finish() does not synchronise with the GPU in headless Chromium
        // (it returns immediately), so force completion with a 1-pixel readback.
        const gl = renderer.getContext()
        const pixel = new Uint8Array(4)
        composer.render()
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        const start = performance.now()
        for (let i = 0; i < frames; i++) composer.render()
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        return (performance.now() - start) / frames
      },
      /**
       * Render one frame and return the drawing buffer as a PNG data URL. Used
       * to compare real rendered detail without the browser compositor in the
       * way (screenshots of a continuously animating WebGL layer are slow).
       */
      capture() {
        composer.render()
        return renderer.domElement.toDataURL('image/png')
      },
    },
    setActivity(name) {
      if (!ACTIVITIES[name]) return activityName
      activityName = name
      Object.assign(targetMood, ACTIVITIES[name])
      return activityName
    },
    setSwim(vx, vy, amount = 0.6) {
      const len = Math.hypot(vx, vy)
      if (len > 0.0001) swimTarget.set(vx / len, vy / len)
      swimAmountTarget = clamp(amount, 0, 1)
    },
    getJet() {
      return Math.min(1, pulse * 0.6 + jetImpulse * 0.5 + jetSurge * 0.55)
    },
    /**
     * Turn the built-in jet timer off (and back on). The ambient overlay turns
     * it off and calls pulse() once per cruise leg, so propulsion happens when
     * the creature actually sets off instead of mid-rest. Demo and harness runs
     * leave it on, which keeps their behaviour unchanged.
     * @param {boolean} enabled
     * @returns {boolean} the new value
     */
    setAutoJet(enabled) {
      autoJet = Boolean(enabled)
      return autoJet
    },
    getActivity() {
      return activityName
    },
    /** Switch palette at runtime; returns the applied name or null if unknown. */
    setPalette(name) {
      if (PALETTES[name] == null) return null
      paletteName = name
      applyPalette(PALETTES[name])
      return paletteName
    },
    getPalette() {
      return paletteName
    },
    pulse() {
      pulse = 1
      jetPhase = 0
      jetDuration = 0.85
      momentum = Math.min(1.6, momentum + 1.0)
    },
    dispose() {
      disposed = true
      window.clearTimeout(compileFallback)
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onWindowResize)
      quad.geometry.dispose()
      material.dispose()
      composer.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
