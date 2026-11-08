import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import {
  mantleVertex,
  mantleFragment,
  tentacleVertex,
  tentacleFragment,
  backgroundVertex,
  backgroundFragment,
  moteVertex,
  moteFragment,
  eyeVertex,
  eyeFragment,
  webVertex,
  webFragment,
} from './shaders.js'

const TAU = Math.PI * 2
const ARM_COUNT = 8
const RINGS = 64
const RADIAL = 12
const ARM_POINTS = 10
const SUCKER_ROWS = 2
const SUCKERS_PER_ROW = 9
const SUCKERS_PER_ARM = SUCKER_ROWS * SUCKERS_PER_ROW
const WEB_GAPS = ARM_COUNT - 1
const WEB_SEGMENTS = 14
const UP = new THREE.Vector3(0, 1, 0)
const RIGHT = new THREE.Vector3(1, 0, 0)

/** Named moods. The plugin maps harness state onto these later. */
export const ACTIVITIES = {
  idle: { speed: 0.72, glow: 0.75, energy: 0.22, spread: 0.92, mote: 0.4, tint: 0.55 },
  thinking: { speed: 1.08, glow: 1.0, energy: 0.48, spread: 0.86, mote: 0.65, tint: 0.72 },
  generating: { speed: 1.6, glow: 1.45, energy: 0.86, spread: 1.12, mote: 1.0, tint: 0.4 },
  tool: { speed: 2.2, glow: 1.25, energy: 1.0, spread: 0.78, mote: 0.8, tint: 0.85 },
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt))

function makeGlowTexture(size = 128) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.18, 'rgba(190,250,255,0.9)')
  g.addColorStop(0.45, 'rgba(70,180,255,0.28)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeRingTexture(size = 256) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.5)
  g.addColorStop(0, 'rgba(120,240,255,0)')
  g.addColorStop(0.62, 'rgba(120,240,255,0)')
  g.addColorStop(0.72, 'rgba(150,245,255,0.85)')
  g.addColorStop(0.8, 'rgba(100,190,255,0.22)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeEyeTexture(size = 512) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const c = size / 2

  ctx.fillStyle = '#01030a'
  ctx.fillRect(0, 0, size, size)

  const iris = ctx.createRadialGradient(c, c, size * 0.02, c, c, size * 0.44)
  iris.addColorStop(0.0, '#f4ffff')
  iris.addColorStop(0.16, '#d8feff')
  iris.addColorStop(0.32, '#7ff2ff')
  iris.addColorStop(0.52, '#20b9ff')
  iris.addColorStop(0.72, '#0a4e9a')
  iris.addColorStop(0.9, '#041a3c')
  iris.addColorStop(1.0, '#02050f')
  ctx.fillStyle = iris
  ctx.beginPath()
  ctx.arc(c, c, size * 0.44, 0, TAU)
  ctx.fill()

  // faint concentric rings
  ctx.strokeStyle = 'rgba(180,250,255,0.18)'
  ctx.lineWidth = size * 0.006
  for (const r of [0.3, 0.36, 0.4]) {
    ctx.beginPath()
    ctx.arc(c, c, size * r, 0, TAU)
    ctx.stroke()
  }

  // vertical slit pupil
  ctx.fillStyle = '#000208'
  ctx.beginPath()
  const w = size * 0.045
  const h = size * 0.29
  ctx.roundRect(c - w, c - h, w * 2, h * 2, w)
  ctx.fill()

  // glints
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.beginPath()
  ctx.ellipse(c - size * 0.13, c - size * 0.15, size * 0.035, size * 0.02, -0.5, 0, TAU)
  ctx.fill()
  ctx.fillStyle = 'rgba(190,245,255,0.55)'
  ctx.beginPath()
  ctx.ellipse(c + size * 0.11, c + size * 0.12, size * 0.02, size * 0.012, 0.6, 0, TAU)
  ctx.fill()

  // dark limbal ring
  ctx.strokeStyle = 'rgba(0,3,10,0.85)'
  ctx.lineWidth = size * 0.035
  ctx.beginPath()
  ctx.arc(c, c, size * 0.445, 0, TAU)
  ctx.stroke()

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function makeMantle() {
  const profile = [
    [0.001, 1.66],
    [0.17, 1.635],
    [0.33, 1.585],
    [0.48, 1.505],
    [0.6, 1.4],
    [0.7, 1.26],
    [0.765, 1.09],
    [0.79, 0.91],
    [0.78, 0.73],
    [0.735, 0.54],
    [0.66, 0.35],
    [0.56, 0.18],
    [0.44, 0.06],
    [0.34, 0.0],
    [0.31, -0.025],
    [0.25, -0.055],
    [0.16, -0.083],
    [0.07, -0.098],
    [0.001, -0.105],
  ].map(([x, y]) => new THREE.Vector2(x, y))

  const geometry = new THREE.LatheGeometry(profile, 128)
  geometry.computeVertexNormals()

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uPulse: { value: 0 },
      uEnergy: { value: 0.3 },
      uRimA: { value: new THREE.Color('#31e6ff') },
      uRimB: { value: new THREE.Color('#9a5cff') },
    },
    vertexShader: mantleVertex,
    fragmentShader: mantleFragment,
    side: THREE.FrontSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 2
  return mesh
}

function makeArmGeometry() {
  const geometry = new THREE.BufferGeometry()
  const count = RINGS * RADIAL
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const indices = []

  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const k = i * RADIAL + j
      uvs[k * 2] = j / RADIAL
      uvs[k * 2 + 1] = i / (RINGS - 1)
      if (i < RINGS - 1) {
        const a = i * RADIAL + j
        const b = i * RADIAL + ((j + 1) % RADIAL)
        const c = (i + 1) * RADIAL + j
        const d = (i + 1) * RADIAL + ((j + 1) % RADIAL)
        indices.push(a, b, c, b, d, c)
      }
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

function computeTransportFrames(points, frames) {
  const n = points.length
  const { tangents, normals, binormals } = frames

  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(n - 1, i + 1)]
    const tangent = tangents[i].subVectors(next, prev)
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1)
    else tangent.normalize()
  }

  const reference = Math.abs(tangents[0].y) < 0.9 ? UP : RIGHT
  normals[0].crossVectors(tangents[0], reference)
  if (normals[0].lengthSq() < 1e-8) normals[0].set(1, 0, 0)
  else normals[0].normalize()

  for (let i = 1; i < n; i++) {
    const normal = normals[i].copy(normals[i - 1])
    normal.addScaledVector(tangents[i], -normal.dot(tangents[i]))
    if (normal.lengthSq() < 1e-8) normal.copy(normals[i - 1])
    else normal.normalize()
  }

  for (let i = 0; i < n; i++) {
    binormals[i].crossVectors(tangents[i], normals[i])
    if (binormals[i].lengthSq() < 1e-8) binormals[i].set(0, 0, 1)
    else binormals[i].normalize()
  }
}

class Arm {
  constructor(index, sharedUniforms, glowTexture, suckerMesh) {
    this.index = index
    this.suckerMesh = suckerMesh
    this.suckerBase = index * SUCKERS_PER_ARM

    this.geometry = makeArmGeometry()
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...sharedUniforms,
        uBase: { value: new THREE.Color('#0c3158') },
        uTip: { value: new THREE.Color('#3d2478') },
      },
      vertexShader: tentacleVertex,
      fragmentShader: tentacleFragment,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1

    this.curve = new THREE.CatmullRomCurve3(
      Array.from({ length: ARM_POINTS }, () => new THREE.Vector3()),
      false,
      'centripetal',
    )
    this.control = this.curve.points

    this.smooth = Array.from({ length: ARM_POINTS }, () => new THREE.Vector3())
    this.velocity = Array.from({ length: ARM_POINTS }, () => new THREE.Vector3())
    this.initialized = false

    this.sampled = Array.from({ length: RINGS }, () => new THREE.Vector3())
    this.frames = {
      tangents: Array.from({ length: RINGS }, () => new THREE.Vector3()),
      normals: Array.from({ length: RINGS }, () => new THREE.Vector3()),
      binormals: Array.from({ length: RINGS }, () => new THREE.Vector3()),
    }
    this.matrix = new THREE.Matrix4()
    this.quat = new THREE.Quaternion()
    this.scaleVec = new THREE.Vector3()
    this.tempPos = new THREE.Vector3()
    this.downProj = new THREE.Vector3()
    this.lateral = new THREE.Vector3()

    this.tip = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: new THREE.Color('#7ff6ff'),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
      }),
    )
    this.tip.scale.setScalar(0.55)
    this.mesh.add(this.tip)
  }

  update(points, time, mood, dt) {
    if (!this.initialized) {
      for (let i = 0; i < ARM_POINTS; i++) {
        this.smooth[i].copy(points[i])
        this.velocity[i].set(0, 0, 0)
      }
      this.initialized = true
    }

    // secondary motion: the arm lags behind its target and settles with weight
    const stiffness = 45
    const damping = 10.5
    for (let i = 0; i < ARM_POINTS; i++) {
      const p = this.smooth[i]
      const v = this.velocity[i]
      const target = points[i]
      v.x += ((target.x - p.x) * stiffness - v.x * damping) * dt
      v.y += ((target.y - p.y) * stiffness - v.y * damping) * dt
      v.z += ((target.z - p.z) * stiffness - v.z * damping) * dt
      p.addScaledVector(v, dt)
    }

    for (let i = 0; i < ARM_POINTS; i++) {
      this.control[i].copy(this.smooth[i])
    }
    this.curve.updateArcLengths()

    for (let i = 0; i < RINGS; i++) {
      this.curve.getPointAt(i / (RINGS - 1), this.sampled[i])
    }
    computeTransportFrames(this.sampled, this.frames)

    const positions = this.geometry.attributes.position.array
    const normals = this.geometry.attributes.normal.array

    const baseRadius = 0.225
    const tipRadius = 0.005
    const baseRadiusB = baseRadius * 0.86
    const tipRadiusB = tipRadius * 0.86

    for (let i = 0; i < RINGS; i++) {
      const t = i / (RINGS - 1)
      const taper = Math.pow(1 - t, 1.26)
      const radius = baseRadius * taper + tipRadius
      const radiusB = baseRadiusB * taper + tipRadiusB
      const p = this.sampled[i]
      const frameN = this.frames.normals[i]
      const frameB = this.frames.binormals[i]

      for (let j = 0; j < RADIAL; j++) {
        const angle = (j / RADIAL) * TAU
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)

        const nx = frameN.x * cos + frameB.x * sin
        const ny = frameN.y * cos + frameB.y * sin
        const nz = frameN.z * cos + frameB.z * sin

        const k = (i * RADIAL + j) * 3
        positions[k] = p.x + nx * radius
        positions[k + 1] = p.y + ny * radius
        positions[k + 2] = p.z + nz * radius

        // ellipse normal: (cos / rN, sin / rB) in the local frame
        const ex = (frameN.x * cos) / radius + (frameB.x * sin) / radiusB
        const ey = (frameN.y * cos) / radius + (frameB.y * sin) / radiusB
        const ez = (frameN.z * cos) / radius + (frameB.z * sin) / radiusB
        const len = Math.hypot(ex, ey, ez) || 1
        normals[k] = ex / len
        normals[k + 1] = ey / len
        normals[k + 2] = ez / len
      }
    }

    this.geometry.attributes.position.needsUpdate = true
    this.geometry.attributes.normal.needsUpdate = true

    // suckers: two alternating rows of small cups on the underside
    if (this.suckerMesh) {
      for (let row = 0; row < SUCKER_ROWS; row++) {
        for (let j = 0; j < SUCKERS_PER_ROW; j++) {
          const t = 0.14 + (j / (SUCKERS_PER_ROW - 1)) * 0.72
          const sampleIndex = Math.min(RINGS - 1, Math.round(t * (RINGS - 1)))
          const p = this.sampled[sampleIndex]
          const tangent = this.frames.tangents[sampleIndex]
          const frameN = this.frames.normals[sampleIndex]
          const frameB = this.frames.binormals[sampleIndex]
          const taper = Math.pow(1 - t, 1.26)
          const radius = baseRadius * taper + tipRadius

          this.downProj.set(0, -1, 0).addScaledVector(tangent, tangent.y)
          if (this.downProj.lengthSq() < 1e-6) this.downProj.copy(frameN)
          else this.downProj.normalize()

          this.lateral.copy(frameB).multiplyScalar((row === 0 ? -1 : 1) * radius * 0.36)
          this.tempPos
            .copy(p)
            .addScaledVector(this.downProj, radius * 0.9)
            .add(this.lateral)

          this.quat.setFromUnitVectors(UP, this.downProj)
          const size = (0.0125 + 0.006 * (1 - t)) * (0.85 + mood.glow * 0.2)
          this.scaleVec.set(size, size * 0.45, size)
          this.matrix.compose(this.tempPos, this.quat, this.scaleVec)
          this.suckerMesh.setMatrixAt(this.suckerBase + row * SUCKERS_PER_ROW + j, this.matrix)
        }
      }
    }

    const last = this.sampled[RINGS - 1]
    this.tip.position.copy(last)
    const tipScale = 0.42 + mood.glow * 0.1 + Math.sin(time * 2.2 + this.index) * 0.02
    this.tip.scale.setScalar(tipScale)
    this.tip.material.opacity = 0.5 + mood.glow * 0.28
    this.tip.material.color.setRGB(0.42 + mood.tint * 0.2, 0.9 - mood.tint * 0.25, 1.0)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.tip.material.dispose()
  }
}

function makeMotes(glowTexture, pixelRatio) {
  const count = 620
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const seeds = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 12
    positions[i * 3 + 1] = (Math.random() - 0.5) * 8
    positions[i * 3 + 2] = (Math.random() - 0.5) * 7 - 1
    sizes[i] = 0.7 + Math.random() * 2.4
    seeds[i] = Math.random()
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uOpacity: { value: 0.7 },
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader: moteVertex,
    fragmentShader: moteFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return points
}

function makeStars(glowTexture) {
  const count = 1400
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const color = new THREE.Color()

  for (let i = 0; i < count; i++) {
    const r = 9 + Math.random() * 18
    const theta = Math.random() * TAU
    const phi = Math.acos(2 * Math.random() - 1)
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.65
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 6

    color.setHSL(0.55 + Math.random() * 0.18, 0.45, 0.55 + Math.random() * 0.3)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const material = new THREE.PointsMaterial({
    size: 0.055,
    map: glowTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return points
}

function makeBackground() {
  const geometry = new THREE.PlaneGeometry(56, 32)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color('#010208') },
      uColorB: { value: new THREE.Color('#08051c') },
      uColorC: { value: new THREE.Color('#221046') },
    },
    vertexShader: backgroundVertex,
    fragmentShader: backgroundFragment,
    depthWrite: false,
    depthTest: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(0, 0, -18)
  mesh.renderOrder = -10
  return mesh
}

function makeAura(glowTexture, ambient = false) {
  const group = new THREE.Group()

  const wide = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color('#3a1e8f'),
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  wide.scale.set(9.5, 9.5, 1)
  wide.position.set(0, 0.25, -3.5)
  if (!ambient) group.add(wide)

  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color('#26b9e8'),
      transparent: true,
      opacity: ambient ? 0.08 : 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  core.scale.set(ambient ? 3.2 : 4.6, ambient ? 3.2 : 4.6, 1)
  core.position.set(0, 0.3, -2.2)
  group.add(core)
  return group
}

export function createVoidOctopus({
  container = document.body,
  mode = 'demo',
  activity = 'idle',
  interactive = mode === 'window',
  eventsTarget = interactive ? container : window,
} = {}) {
  const transparent = mode === 'overlay' || mode === 'ambient'
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: transparent,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  if (transparent) renderer.setClearColor(0x000000, 0)
  container.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.pointerEvents = interactive ? 'auto' : 'none'

  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x02030a, 0.018)

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 0.35, mode === 'window' ? 8.5 : 7.4)

  const glowTexture = makeGlowTexture()
  const ringTexture = makeRingTexture()

  const world = new THREE.Group()
  world.position.set(0, -0.1, 0)
  scene.add(world)

  const octopus = new THREE.Group()
  octopus.position.set(0, 0.24, 0)
  octopus.rotation.y = -0.1
  octopus.rotation.z = 0.03
  octopus.scale.setScalar(1.05)
  world.add(octopus)

  const scenic = mode === 'demo' || mode === 'window'
  const background = scenic ? makeBackground() : null
  if (background) scene.add(background)

  const aura = makeAura(glowTexture, mode === 'ambient')
  world.add(aura)

  const stars = scenic ? makeStars(glowTexture) : null
  if (stars) world.add(stars)

  const mantle = makeMantle()
  octopus.add(mantle)

  const bodyHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color('#3a2a9a'),
      transparent: true,
      opacity: mode === 'ambient' ? 0.09 : 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  bodyHalo.position.set(0, 0.9, -0.9)
  bodyHalo.scale.set(mode === 'ambient' ? 3.2 : 4.2, mode === 'ambient' ? 3.2 : 4.2, 1)
  octopus.add(bodyHalo)

  // eyes ---------------------------------------------------------------
  const eyeGeometry = new THREE.SphereGeometry(0.2, 40, 28)
  const eyeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGaze: { value: new THREE.Vector2(0, 0) },
      uPupil: { value: 1 },
      uBlink: { value: 0 },
      uGlow: { value: 1 },
    },
    vertexShader: eyeVertex,
    fragmentShader: eyeFragment,
  })
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.3, 0.86, 0.7)
    pivot.rotation.y = side * 0.28
    pivot.rotation.x = -0.06

    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial)
    eye.scale.set(1.08, 1.32, 0.54)
    eye.rotation.y = -Math.PI / 2
    pivot.add(eye)
    octopus.add(pivot)
  }

  // a soft ring where the arms meet the mantle
  const skirtGlow = new THREE.Mesh(
    new THREE.TorusGeometry(0.43, 0.01, 8, 96),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color('#7bf4ff'),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  skirtGlow.rotation.x = Math.PI / 2
  skirtGlow.position.y = 0.02
  octopus.add(skirtGlow)

  // arms ---------------------------------------------------------------
  const sharedArmUniforms = {
    uTime: { value: 0 },
    uGlow: { value: 1 },
    uPulse: { value: 0 },
    uEnergy: { value: 0.3 },
  }
  const suckerGeometry = new THREE.SphereGeometry(1, 8, 6)
  const suckerMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#c9fbff'),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const suckerMesh = new THREE.InstancedMesh(
    suckerGeometry,
    suckerMaterial,
    ARM_COUNT * SUCKERS_PER_ARM,
  )
  suckerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  suckerMesh.frustumCulled = false
  suckerMesh.renderOrder = 3
  octopus.add(suckerMesh)

  const arms = Array.from({ length: ARM_COUNT }, (_, i) => {
    const arm = new Arm(i, sharedArmUniforms, glowTexture, suckerMesh)
    octopus.add(arm.mesh)
    return arm
  })

  // the web: a thin luminous membrane bridging the arm bases so the junction reads as one body
  const webGeometry = new THREE.BufferGeometry()
  const webVertexCount = WEB_GAPS * (WEB_SEGMENTS + 1) * 2
  const webPositions = new Float32Array(webVertexCount * 3)
  const webUvs = new Float32Array(webVertexCount * 2)
  const webIndices = []
  for (let g = 0; g < WEB_GAPS; g++) {
    for (let s = 0; s <= WEB_SEGMENTS; s++) {
      const vertex = (g * (WEB_SEGMENTS + 1) + s) * 2
      webUvs[(vertex * 2)] = 0
      webUvs[(vertex * 2) + 1] = s / WEB_SEGMENTS
      webUvs[((vertex + 1) * 2)] = 1
      webUvs[((vertex + 1) * 2) + 1] = s / WEB_SEGMENTS
      if (s < WEB_SEGMENTS) {
        const a = vertex
        const b = vertex + 1
        const c = vertex + 2
        const d = vertex + 3
        webIndices.push(a, b, c, b, d, c)
      }
    }
  }
  webGeometry.setAttribute('position', new THREE.BufferAttribute(webPositions, 3))
  webGeometry.setAttribute('uv', new THREE.BufferAttribute(webUvs, 2))
  webGeometry.setIndex(webIndices)
  const webMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 1 },
      uOpacity: { value: 1 },
    },
    vertexShader: webVertex,
    fragmentShader: webFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  const web = new THREE.Mesh(webGeometry, webMaterial)
  web.frustumCulled = false
  web.renderOrder = 2
  octopus.add(web)

  const motes = scenic ? makeMotes(glowTexture, Math.min(window.devicePixelRatio || 1, 1.5)) : null
  if (motes) world.add(motes)

  // click ripple -------------------------------------------------------
  const ripple = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: ringTexture,
      color: new THREE.Color('#9ef8ff'),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  ripple.position.set(0, 0.1, 1.5)
  ripple.scale.setScalar(1)
  world.add(ripple)

  // post ---------------------------------------------------------------
  let composer = null
  let bloom = null
  if (mode !== 'overlay') {
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      mode === 'ambient' ? 0.46 : mode === 'window' ? 0.52 : 0.64,
      0.5,
      mode === 'ambient' ? 0.8 : 0.74,
    )
    composer.addPass(bloom)
    composer.addPass(new OutputPass())
  }

  // mood state ---------------------------------------------------------
  const mood = { ...ACTIVITIES[activity] }
  const targetMood = { ...ACTIVITIES[activity] }
  let activityName = activity

  let width = 1
  let height = 1
  let time = 0
  let pulse = 0
  let rippleLife = 0
  let blinkTimer = 2.5 + Math.random() * 3
  let blinkProgress = 0
  let blinkActive = false
  let blinkValue = 0
  let blinkDuration = 0.18
  const gaze = new THREE.Vector2(0, 0)
  const gazeJitter = new THREE.Vector2(0, 0)
  let gazeTimer = 0.6
  let jet = 0
  let jetTimer = 5 + Math.random() * 7
  let raf = 0
  let lastFrame = performance.now()
  let paused = false
  let disposed = false

  const pointer = new THREE.Vector2(0, 0)
  const pointerTarget = new THREE.Vector2(0, 0)
  const baseRotY = 0
  let rotY = 0
  let rotX = 0
  let camX = 0
  let camY = 0

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const minFrameInterval = mode === 'ambient' ? 1000 / 30 : 0

  const resize = () => {
    const rect = container.getBoundingClientRect()
    width = Math.max(1, Math.floor(rect.width || window.innerWidth))
    height = Math.max(1, Math.floor(rect.height || window.innerHeight))
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    if (composer) composer.setSize(width, height)
  }

  const onPointerMove = (event) => {
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    pointerTarget.x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    pointerTarget.y = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1)
  }

  const pulseNow = () => {
    pulse = Math.min(1.35, pulse + 1)
    rippleLife = 1
  }

  const pulseEnabled = mode !== 'ambient'
  const onPointerDown = (event) => {
    if (!pulseEnabled) return
    if (event.button !== undefined && event.button !== 0) return
    pulseNow()
  }

  const buildArmPoints = (index) => {
    const points = []
    const phase = index * 1.71
    const side = index < ARM_COUNT / 2 ? -1 : 1
    const rank = (index % (ARM_COUNT / 2)) / (ARM_COUNT / 2 - 1)

    const baseX = side * (0.1 + rank * 0.3)
    const baseZ = 0.2 * Math.sin(index * 1.87)
    const lengthScale = 0.92 + 0.16 * Math.sin(index * 2.3)
    const spread = 0.94 + 0.16 * Math.sin(index * 3.1 + 0.7)

    const sway = Math.sin(time * 1.02 + phase) * 0.19
    const sway2 = Math.cos(time * 0.82 + phase * 1.3) * 0.14
    const curl = 0.6 + 0.32 * Math.sin(time * 0.72 + phase)

    const push = (x, y, z) => {
      points.push(new THREE.Vector3(x, y, z))
    }

    const outward = side * (0.16 + rank * 0.42) * spread

    // start inside the mantle so the tube emerges from the body, not from a cut rim
    push(baseX * 0.55, 0.36, baseZ * 0.55)
    push(baseX, 0.03, baseZ)
    push(baseX + side * 0.1, -0.36 * lengthScale, baseZ + sway2 * 0.06)
    push(baseX + outward * 0.55 + sway * 0.16, -0.92 * lengthScale, baseZ + sway2 * 0.12)
    push(baseX + outward * 0.95 + sway * 0.3, -1.42 * lengthScale, baseZ + sway * 0.16)
    push(baseX + outward * 1.35 + sway * 0.46, -1.8 * lengthScale, baseZ + sway * 0.22)

    const tipX = baseX + outward * 1.7 + sway * 0.56
    const tipY = (-1.94 + curl * 0.06) * lengthScale
    const tipZ = baseZ + sway * 0.28
    push(tipX, tipY, tipZ)
    push(tipX - side * 0.05 + sway * 0.04, tipY - 0.12, tipZ + sway * 0.02)
    push(tipX - side * 0.13 + sway * 0.06, tipY - 0.16, tipZ + sway * 0.04)
    push(tipX - side * 0.22 + sway * 0.08, tipY - 0.08, tipZ + sway * 0.05)

    // travelling wave down the arm: neighbours move with a phase lag
    for (let i = 0; i < points.length; i++) {
      const wave = Math.sin(time * 1.4 + phase - i * 0.55) * (0.004 + i * 0.0032) * (0.8 + mood.energy * 0.55)
      points[i].x += wave * 0.7
      points[i].y += wave * 0.35
      points[i].z += wave
    }

    // occasional tip flick, plus a flare when the body jets
    const twitch = Math.pow(Math.max(0, Math.sin(time * 0.74 + phase * 2.2)), 12) * 0.05
    points[8].y += twitch
    points[9].y += twitch * 1.1
    points[9].x += side * twitch * 0.4
    const flare = jet * 0.07
    points[6].x += side * flare * 0.7
    points[6].y += flare * 0.35
    points[7].x += side * flare * 0.9
    points[8].x += side * flare * 0.6

    return points
  }

  const updateEyes = (dt) => {
    // saccades: follow the pointer when it matters, otherwise glance around
    gazeTimer -= dt
    if (gazeTimer <= 0) {
      gazeTimer = 0.75 + Math.random() * 1.9
      gazeJitter.set((Math.random() * 2 - 1) * 0.72, (Math.random() * 2 - 1) * 0.56)
    }
    const attention = Math.min(1, Math.hypot(pointer.x, pointer.y) * 1.45)
    const targetX = clamp(pointer.x * 0.68 * attention + gazeJitter.x * (1 - attention * 0.62), -1, 1)
    const targetY = clamp(pointer.y * 0.55 * attention + gazeJitter.y * (1 - attention * 0.62), -1, 1)
    gaze.x = damp(gaze.x, targetX, 8.5, dt)
    gaze.y = damp(gaze.y, targetY, 8.5, dt)

    blinkTimer -= dt
    if (blinkTimer <= 0 && !blinkActive) {
      blinkActive = true
      blinkProgress = 0
      blinkDuration = Math.random() < 0.16 ? 0.34 + Math.random() * 0.1 : 0.15 + Math.random() * 0.1
      blinkTimer = 2.2 + Math.random() * 4.2
    }
    if (blinkActive) {
      blinkProgress += dt
      const p = clamp(blinkProgress / blinkDuration, 0, 1)
      blinkValue = Math.sin(p * Math.PI)
      if (p >= 1) {
        blinkActive = false
        blinkValue = 0
        if (Math.random() < 0.22) blinkTimer = 0.28
      }
    }

    eyeMaterial.uniforms.uTime.value = time
    eyeMaterial.uniforms.uGaze.value.copy(gaze)
    eyeMaterial.uniforms.uPupil.value = 0.84 + mood.energy * 0.34 + Math.sin(time * 0.8) * 0.06
    eyeMaterial.uniforms.uBlink.value = blinkValue
    eyeMaterial.uniforms.uGlow.value = mood.glow + pulse * 0.25 + jet * 0.2
  }

  const updateRipple = (dt) => {
    if (rippleLife <= 0) {
      ripple.material.opacity = 0
      return
    }
    rippleLife = Math.max(0, rippleLife - dt * 0.9)
    const life = 1 - rippleLife
    ripple.scale.setScalar(1.2 + life * 7.5)
    ripple.material.opacity = Math.sin(rippleLife * Math.PI) * 0.42 * rippleLife
  }

  const frame = (now) => {
    if (disposed) return
    if (paused) {
      lastFrame = now
      raf = requestAnimationFrame(frame)
      return
    }
    if (minFrameInterval > 0 && now - lastFrame < minFrameInterval) {
      raf = requestAnimationFrame(frame)
      return
    }
    const rawDt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000))
    lastFrame = now
    if (rawDt === 0) {
      raf = requestAnimationFrame(frame)
      return
    }

    const speed = reduceMotion ? 0.28 : 1
    const dt = rawDt * speed
    time += dt * (0.7 + mood.speed)

    // ease moods
    for (const key of Object.keys(mood)) {
      if (typeof mood[key] === 'number') {
        mood[key] = damp(mood[key], targetMood[key], 2.4, dt)
      }
    }
    pulse = Math.max(0, pulse - dt * 1.6)
    jetTimer -= dt
    if (jetTimer <= 0) {
      jet = 1
      jetTimer = 7 + Math.random() * 9
    }
    jet = Math.max(0, jet - dt * 1.7)

    pointer.lerp(pointerTarget, 1 - Math.exp(-4 * dt))
    rotY = damp(rotY, pointer.x * 0.2, 3.2, dt)
    rotX = damp(rotX, -pointer.y * 0.14, 3.2, dt)
    camX = damp(camX, pointer.x * 0.28, 2.6, dt)
    camY = damp(camY, -pointer.y * 0.18, 2.6, dt)

    world.rotation.y = rotY * 0.55 + Math.sin(time * 0.11) * 0.06 + Math.sin(time * 0.037) * 0.04
    world.rotation.x = rotX * 0.5 + Math.sin(time * 0.17) * 0.018
    octopus.position.y = 0.24 + Math.sin(time * 0.6) * 0.085 + pulse * 0.04 + jet * 0.03
    octopus.rotation.z = 0.03 + Math.sin(time * 0.33) * 0.04 + jet * 0.02
    aura.rotation.z = Math.sin(time * 0.15) * 0.1

    camera.position.x = camX
    camera.position.y = 0.35 + camY
    camera.lookAt(0, -0.05, 0)

    mantle.material.uniforms.uTime.value = time
    mantle.material.uniforms.uGlow.value = mood.glow
    mantle.material.uniforms.uPulse.value = Math.max(pulse, jet * 0.55)
    mantle.material.uniforms.uEnergy.value = mood.energy

    sharedArmUniforms.uTime.value = time
    sharedArmUniforms.uGlow.value = mood.glow
    sharedArmUniforms.uPulse.value = pulse
    sharedArmUniforms.uEnergy.value = mood.energy

    for (const arm of arms) {
      arm.update(buildArmPoints(arm.index), time, mood, dt)
    }
    suckerMesh.instanceMatrix.needsUpdate = true
    suckerMaterial.opacity = 0.26 + mood.glow * 0.24 + pulse * 0.18

    let webCursor = 0
    for (let g = 0; g < WEB_GAPS; g++) {
      const a = arms[g]
      const b = arms[g + 1]
      for (let s = 0; s <= WEB_SEGMENTS; s++) {
        const t = 0.02 + (s / WEB_SEGMENTS) * 0.32
        const sampleIndex = Math.min(RINGS - 1, Math.round(t * (RINGS - 1)))
        const pa = a.sampled[sampleIndex]
        const pb = b.sampled[sampleIndex]
        const sag = Math.sin((s / WEB_SEGMENTS) * Math.PI) * 0.018
        webPositions[webCursor++] = pa.x
        webPositions[webCursor++] = pa.y - sag
        webPositions[webCursor++] = pa.z
        webPositions[webCursor++] = pb.x
        webPositions[webCursor++] = pb.y - sag
        webPositions[webCursor++] = pb.z
      }
    }
    webGeometry.attributes.position.needsUpdate = true
    webGeometry.computeBoundingSphere()
    webMaterial.uniforms.uTime.value = time
    webMaterial.uniforms.uGlow.value = mood.glow
    webMaterial.uniforms.uOpacity.value = 0.55 + mood.energy * 0.45

    skirtGlow.material.opacity = 0.1 + mood.glow * 0.1 + pulse * 0.12
    skirtGlow.rotation.z += dt * 0.12

    if (motes) {
      motes.material.uniforms.uTime.value = time
      motes.material.uniforms.uGlow.value = mood.glow
      motes.material.uniforms.uOpacity.value = 0.28 + mood.mote * 0.6
    }

    if (background) {
      background.material.uniforms.uTime.value = time
    }

    updateEyes(dt)
    updateRipple(dt)

    if (composer) composer.render()
    else renderer.render(scene, camera)

    raf = requestAnimationFrame(frame)
  }

  const onVisibility = () => {
    paused = document.hidden
    lastFrame = performance.now()
  }

  const onResize = () => resize()

  eventsTarget.addEventListener('pointermove', onPointerMove, { passive: true })
  if (pulseEnabled) eventsTarget.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onResize)
  let observer = null
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => resize())
    observer.observe(container)
  }

  resize()
  raf = requestAnimationFrame(frame)

  return {
    scene,
    camera,
    renderer,
    setActivity(name) {
      if (!ACTIVITIES[name]) return activityName
      activityName = name
      Object.assign(targetMood, ACTIVITIES[name])
      return activityName
    },
    getActivity() {
      return activityName
    },
    pulse: pulseNow,
    resize,
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      eventsTarget.removeEventListener('pointermove', onPointerMove)
      if (pulseEnabled) eventsTarget.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      if (observer) observer.disconnect()
      for (const arm of arms) arm.dispose()
      mantle.geometry.dispose()
      mantle.material.dispose()
      eyeGeometry.dispose()
      eyeMaterial.dispose()
      skirtGlow.geometry.dispose()
      skirtGlow.material.dispose()
      bodyHalo.material.dispose()
      if (motes) {
        motes.geometry.dispose()
        motes.material.dispose()
      }
      suckerMesh.dispose()
      suckerGeometry.dispose()
      suckerMaterial.dispose()
      webGeometry.dispose()
      webMaterial.dispose()
      if (background) {
        background.geometry.dispose()
        background.material.dispose()
      }
      if (stars) {
        stars.geometry.dispose()
        stars.material.dispose()
      }
      for (const obj of [ripple, ...aura.children]) {
        obj.material.map?.dispose()
        obj.material.dispose()
      }
      glowTexture.dispose()
      ringTexture.dispose()
      if (composer) composer.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
