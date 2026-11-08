import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { sdfVertex, sdfFragment } from './sdfShader.js'

export const ACTIVITIES = {
  idle: { speed: 0.72, glow: 0.75, energy: 0.22 },
  thinking: { speed: 1.08, glow: 1.0, energy: 0.48 },
  generating: { speed: 1.6, glow: 1.45, energy: 0.86 },
  tool: { speed: 2.2, glow: 1.25, energy: 1.0 },
}

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt))

function makeArmPoints() {
  return Array.from({ length: 64 }, () => new THREE.Vector3())
}

export function createSdfOctopus({ container = document.body, mode = 'demo', activity = 'idle' } = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: mode === 'ambient',
    powerPreference: 'high-performance',
    preserveDrawingBuffer: mode !== 'ambient',
  })
  renderer.setPixelRatio(mode === 'ambient' ? 1 : Math.min(window.devicePixelRatio || 1, 1.25))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.pointerEvents = 'none'

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
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: sdfVertex,
    fragmentShader: sdfFragment,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  scene.add(quad)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), mode === 'ambient' ? 0.24 : 0.28, 0.45, 0.82)
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
  const armCurl = new Float32Array(8)
  const armCurlTarget = new Float32Array(8)
  let stretch = 0
  let stretchTarget = 0
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

  const minFrame = mode === 'ambient' ? 1000 / 24 : 0
  const renderScale = mode === 'ambient' ? 0.7 : 0.9

  const resize = () => {
    const rect = container.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width || window.innerWidth))
    const h = Math.max(1, Math.floor(rect.height || window.innerHeight))
    renderer.setSize(Math.max(1, Math.floor(w * renderScale)), Math.max(1, Math.floor(h * renderScale)), false)
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

  const startAction = () => {
    const pick = Math.random()
    if (pick < 0.28) {
      action = 'look'
      actionDuration = 2.4
      lookTarget.set((Math.random() * 2 - 1) * 0.7, (Math.random() * 2 - 1) * 0.32)
    } else if (pick < 0.52) {
      action = 'arm'
      actionDuration = 2.6
      actionArm = Math.floor(Math.random() * 8)
      armCurlTarget[actionArm] = 1
    } else if (pick < 0.72) {
      action = 'stretch'
      actionDuration = 2.3
      stretchTarget = 1
    } else if (pick < 0.88) {
      action = 'jet'
      actionDuration = 0.9
      pulse = 1
      kick = 1
      jetImpulse = 1
    } else {
      action = 'blink'
      actionDuration = 0.5
      blinkTimer = 0
    }
    actionTime = 0
  }

  const buildArms = (t) => {
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * TAU + 0.22
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      const phase = k * 1.7
      const sway = Math.sin(t * 1.0 + phase) * 0.18
      const sway2 = Math.cos(t * 0.8 + phase * 1.3) * 0.12
      const length = 0.9 + 0.1 * Math.sin(k * 2.3)
      const pose = Math.sin(k * 1.7 + 0.4)
      const lift = pose > 0.35 ? 0.22 : 0.0
      const curl = armCurl[k]
      const flare = pulse * 0.03
      const stretchK = 1 + stretch * 0.13
      const base = k * 8
      const stream = 1 - swimAmount * 0.2
      const jetStream = 1 - jetImpulse * 0.12

      const p0 = [c * 0.28, 0.2, s * 0.28]
      const p1 = [
        c * (0.9 + sway * 0.2) * stretchK * stream,
        -0.55 * length,
        s * (0.9 + sway * 0.2) * stretchK * stream,
      ]
      const p2 = [
        c * (1.65 + sway * 0.4 + flare) * stretchK * stream * jetStream,
        (-0.75 + lift * 0.5 + curl * 0.4) * length,
        s * (1.65 + sway * 0.4 + flare) * stretchK * stream * jetStream,
      ]
      const tangentX = -s
      const tangentZ = c
      const p3 = [
        c * (1.8 + sway2 * 0.3 + flare * 1.2) * stretchK * stream * jetStream + tangentX * (0.16 + curl * 0.12),
        (-0.08 + lift * 1.2 + curl * 0.85) * length,
        s * (1.8 + sway2 * 0.3 + flare * 1.2) * stretchK * stream * jetStream + tangentZ * (0.16 + curl * 0.12),
      ]

      const swimK = swimAmount
      for (let i = 0; i < 8; i++) {
        const u = i / 7
        const v = 1 - u
        const b0 = v * v * v
        const b1 = 3 * v * v * u
        const b2 = 3 * v * u * u
        const b3 = u * u * u
        let x = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0]
        let y = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]
        let z = b0 * p0[2] + b1 * p1[2] + b2 * p2[2] + b3 * p3[2]

        // real octopuses swim by jetting; the arms mostly trail and undulate,
        // so the stroke is stronger than before but the tips are dragged back hard.
        const stroke = Math.sin(t * (1.9 + swimK * 1.1) + phase - i * 0.5)
          * (0.012 + i * 0.007)
          * (0.7 + swimK * 2.0)
        x += tangentX * stroke
        y += stroke * 0.4
        z += tangentZ * stroke

        const drag = (i / 7) * (i / 7) * (0.35 + jetImpulse * 0.55) * swimK
        x -= swim.x * drag
        y += swim.y * drag
        z -= swim.x * drag * 0.3

        armTargets[base + i].set(x, y, z)
      }
    }
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
    if (minFrame > 0 && now - last < minFrame) {
      raf = requestAnimationFrame(frame)
      return
    }
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
    last = now
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

    if (activityName === 'idle') {
      if (action == null) {
        autonomyTimer -= dt
        if (autonomyTimer <= 0) startAction()
      } else {
        actionTime += dt
        if (actionTime >= actionDuration) {
          lookTarget.set(0, 0)
          if (actionArm >= 0) armCurlTarget[actionArm] = 0
          stretchTarget = 0
          action = null
          actionArm = -1
          autonomyTimer = 2.5 + Math.random() * 4
        }
      }
    } else {
      lookTarget.set(0, 0)
      stretchTarget = 0
      for (let i = 0; i < 8; i++) armCurlTarget[i] = 0
      action = null
      actionArm = -1
    }
    look.x = damp(look.x, lookTarget.x, 3.0, dt)
    look.y = damp(look.y, lookTarget.y, 3.0, dt)
    stretch = damp(stretch, stretchTarget, 3.2, dt)
    for (let i = 0; i < 8; i++) armCurl[i] = damp(armCurl[i], armCurlTarget[i], 3.6, dt)
    kick = Math.max(0, kick - dt * 2.4)
    jetImpulse = Math.max(0, jetImpulse - dt * 1.3)

    buildArms(time)
    for (let i = 0; i < armPoints.length; i++) {
      armPoints[i].lerp(armTargets[i], 1 - Math.exp(-14 * dt))
    }

    uniforms.uTime.value = time
    uniforms.uGlow.value = mood.glow + pulse * 0.2
    uniforms.uEnergy.value = mood.energy
    uniforms.uPulse.value = pulse
    uniforms.uBlink.value = blink
    uniforms.uPupil.value = 0.86 + mood.energy * 0.34 + Math.sin(time * 0.8) * 0.05
    uniforms.uGaze.value.copy(gaze)
    jetTimer -= dt
    if (jetTimer <= 0) {
      pulse = 1
      jetTimer = 7 + Math.random() * 7
    }
    swim.lerp(swimTarget, 1 - Math.exp(-2.5 * dt))
    swimAmount = damp(swimAmount, swimAmountTarget, 2.2, dt)
    uniforms.uSwim.value.copy(swim)
    uniforms.uSwimAmount.value = swimAmount

    uniforms.uYaw.value = Math.sin(time * 0.11) * 0.02 + pointer.x * 0.05 + look.x * 0.18 + swim.x * 0.32 * swimAmount
    uniforms.uPitch.value = -0.02 - pointer.y * 0.04 + look.y * 0.1 - swim.y * 0.18 * swimAmount
    uniforms.uRoll.value = Math.sin(time * 0.17) * 0.015 + swim.x * 0.1 * swimAmount
    const breathLift = Math.sin(time * 0.55) * 0.045 + kick * 0.12 - swim.y * 0.035 * swimAmount
    uniforms.uOffset.value.set(0, breathLift, 0)
    pulse = Math.max(0, pulse - dt * 1.8)

    composer.render()
    raf = requestAnimationFrame(frame)
  }

  resize()
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', resize)
  raf = requestAnimationFrame(frame)

  return {
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
      return Math.min(1, pulse * 0.7 + jetImpulse * 0.6)
    },
    getActivity() {
      return activityName
    },
    pulse() {
      pulse = 1
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
      quad.geometry.dispose()
      material.dispose()
      composer.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
