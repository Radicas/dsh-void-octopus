import { Component, createElement as h, useEffect, useRef, useState } from 'react'
import { createSdfOctopus, resolvePalette } from './scene/SdfOctopus.js'
import {
  DEFAULTS as MOTION_DEFAULTS,
  createBehaviorState,
  stepBehavior,
  getSwim,
  getView,
  getDeparture,
  startDeparture,
  depthScale,
  serializeBehavior,
  restoreBehavior,
  clampBehavior,
  bodyBounds,
} from './scene/behavior.js'

const CSS = `
.dsh-void-ambient {
  position: fixed;
  right: 10px;
  bottom: 8px;
  /* The box is the render target, sized for the CLOSEST appearance (scale 1) and
     for the WIDEST arm pose: 0.9.29 widened the shader lens by FOV_SCALE (1.25)
     because the arm tips projected to |ndc| ~1.2 and were being sliced by the
     canvas edge. The box grew by the same factor, so the creature's apparent
     size is unchanged — the extra pixels only hold the arms. Depth retreats by
     scaling DOWN from here, so the canvas is only ever downsampled. */
  width: min(54.6vw, 650px);
  height: min(54.6vw, 650px);
  z-index: 50;
  pointer-events: none;
  mix-blend-mode: screen;
  /* The departure changes distance, so the opacity is a product: the base fade
     (typing dims it to 0.2) times the distance fade. It cannot be an inline
     style.opacity, because that would override the .is-quiet class instead of
     composing with it. */
  opacity: calc(0.8 * var(--void-alpha, 1));
  transition: opacity 460ms ease;
  will-change: transform;
  transform-origin: 50% 50%;
  /* Edge-only fade. The mask used to start fading at 0.63 of a half box, which
     cut the splayed arms down to ~20% opacity exactly when they reached furthest
     — it read as the tentacles being cropped by a boundary. Now it is opaque up
     to 0.954 of the half box (past the 0.953 worst-case silhouette) and reaches
     full transparency AT the canvas edge, so it can only ever hide the canvas
     border, never dim the creature. */
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, #000 67.5%, rgba(0, 0, 0, 0.72) 69.1%, transparent 70.7%);
  mask-image: radial-gradient(ellipse at 50% 50%, #000 67.5%, rgba(0, 0, 0, 0.72) 69.1%, transparent 70.7%);
}
.dsh-void-ambient.is-quiet {
  opacity: calc(0.2 * var(--void-alpha, 1));
}
.dsh-void-ambient canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
@media (max-width: 720px) {
  .dsh-void-ambient {
    right: -18px;
    bottom: -14px;
    width: min(84.5vw, 520px);
    height: min(84.5vw, 520px);
  }
}
.dsh-void-ambient.is-wandering {
  left: 0;
  top: 0;
  right: auto;
  bottom: auto;
}
/* Boot ring. It sits where the creature will appear and spins on the
   compositor, so it keeps moving even while the main thread is blocked by
   shader compilation. */
.dsh-void-boot {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 13px;
  pointer-events: none;
  opacity: 1;
  transition: opacity 520ms ease;
}
.dsh-void-boot.is-done {
  opacity: 0;
}
.dsh-void-boot-dial {
  position: relative;
  width: 46px;
  height: 46px;
}
.dsh-void-boot-track,
.dsh-void-boot-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
}
.dsh-void-boot-track {
  border: 1px solid rgba(110, 244, 255, 0.14);
}
.dsh-void-boot-ring {
  background: conic-gradient(
    from 0deg,
    rgba(110, 244, 255, 0) 0deg,
    rgba(110, 244, 255, 0.1) 120deg,
    rgba(110, 244, 255, 0.85) 320deg,
    rgba(110, 244, 255, 0) 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
  filter: drop-shadow(0 0 7px rgba(110, 244, 255, 0.5));
  animation: dsh-void-spin 1.1s linear infinite;
}
.dsh-void-boot-label {
  font: 500 10px/1 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: rgba(158, 216, 236, 0.74);
  text-shadow: 0 0 12px rgba(110, 244, 255, 0.28);
  white-space: nowrap;
}
@keyframes dsh-void-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-void-boot-ring {
    animation: dsh-void-breathe 2.6s ease-in-out infinite;
  }
}
@keyframes dsh-void-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.9;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-void-ambient { opacity: calc(0.5 * var(--void-alpha, 1)); }
}
`

class Boundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function VoidOctopusAmbient(props) {
  const sessionId = props.sessionId
  const engineRef = useRef(null)
  const hostRef = useRef(null)
  const [mood, setMood] = useState('idle')
  const [quiet, setQuiet] = useState(false)

  let status
  try {
    if (typeof props.useSessionStatus === 'function') {
      status = props.useSessionStatus((snapshot) => (sessionId == null ? undefined : snapshot.get(sessionId)))
    }
  } catch (err) {
    status = undefined
  }

  let runningCalls = 0
  let streamed = 0
  try {
    if (typeof props.useChat === 'function') {
      runningCalls = props.useChat((state) => {
        const calls = state && state.legacy && state.legacy.runningCalls
        return Array.isArray(calls) ? calls.length : 0
      })
      streamed = props.useChat((state) => {
        const partial = state && state.legacy && state.legacy.partial
        if (partial == null || !Array.isArray(partial.blocks)) return 0
        let n = 0
        for (const block of partial.blocks) {
          if (block == null) continue
          if (typeof block.text === 'string') n += block.text.length
          else if (typeof block.reasoning === 'string') n += block.reasoning.length
        }
        return n
      })
    }
  } catch (err) {
    runningCalls = 0
    streamed = 0
  }

  let nextMood = 'idle'
  if (status != null && status.running === true) {
    if (runningCalls > 0) nextMood = 'tool'
    else if (streamed > 0) nextMood = 'generating'
    else nextMood = 'thinking'
  }

  useEffect(() => {
    if (mood !== nextMood) setMood(nextMood)
  }, [nextMood, mood])

  useEffect(() => {
    if (typeof document === 'undefined' || document.body == null) return undefined
    let engine = null
    let host = null
    let style = null
    let boot = null
    let bootLabel = null
    let bootHideTimer = 0
    let bootRemoveTimer = 0
    let frameA = 0
    let frameB = 0
    let cancelled = false
    const zh = (navigator.language || '').toLowerCase().startsWith('zh')
    const STAGE_TEXT = zh
      ? { context: '初始化 WebGL', compile: '编译着色器', ready: '就绪' }
      : { context: 'Starting WebGL', compile: 'Compiling shader', ready: 'Ready' }
    const finishBoot = () => {
      if (boot == null) return
      boot.classList.add('is-done')
      window.clearTimeout(bootRemoveTimer)
      bootRemoveTimer = window.setTimeout(() => {
        try {
          boot.remove()
        } catch (err) {
          /* already gone */
        }
        boot = null
        bootLabel = null
      }, 620)
    }
    try {
      style = document.createElement('style')
      style.dataset.dshVoidOctopus = 'style'
      style.textContent = CSS
      document.head.appendChild(style)
      host = document.createElement('div')
      host.className = 'dsh-void-ambient'
      host.style.transform = 'translate3d(0px, 0px, 0)'
      document.body.appendChild(host)
      hostRef.current = host

      // The ring is deliberately built before the engine: shader compilation is
      // a long, synchronous block on the main thread, and a compositor-animated
      // spinner is the only thing that keeps moving while it runs.
      boot = document.createElement('div')
      boot.className = 'dsh-void-boot'
      boot.innerHTML =
        '<div class="dsh-void-boot-dial"><div class="dsh-void-boot-track"></div>' +
        '<div class="dsh-void-boot-ring"></div></div>' +
        '<div class="dsh-void-boot-label">' +
        STAGE_TEXT.context +
        '</div>'
      host.appendChild(boot)
      bootLabel = boot.lastChild

      const onStage = (stage) => {
        if (cancelled) return
        if (bootLabel) bootLabel.textContent = STAGE_TEXT[stage] || stage
        if (stage === 'ready') {
          window.clearTimeout(bootHideTimer)
          // A short beat so "Ready" is readable before the ring dissolves.
          bootHideTimer = window.setTimeout(finishBoot, 320)
        }
      }

      // Paint the ring first: two frames is enough for the compositor to start
      // the animation before WebGL context creation begins.
      frameA = requestAnimationFrame(() => {
        frameB = requestAnimationFrame(() => {
          if (cancelled) return
          try {
            engine = createSdfOctopus({
              container: host,
              mode: 'ambient',
              activity: 'idle',
              palette: resolvePalette(props.palette),
              onStage,
            })
            // The wander below schedules one jet per cruise leg; the engine's
            // own 6-12 s timer would fire mid-rest and re-streamline the arms
            // that are supposed to be opening while it waits.
            if (typeof engine.setAutoJet === 'function') engine.setAutoJet(false)
            engineRef.current = engine
          } catch (err) {
            console.warn('[dsh-void-octopus] scene failed to start:', err)
            finishBoot()
          }
        })
      })
      // Never leave the ring up forever if the WebGL context dies mid-boot.
      bootHideTimer = window.setTimeout(finishBoot, 30000)
    } catch (err) {
      console.warn('[dsh-void-octopus] scene failed to start:', err)
      try {
        if (host) host.remove()
        if (style) style.remove()
      } catch (_) {}
      return undefined
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(frameA)
      cancelAnimationFrame(frameB)
      window.clearTimeout(bootHideTimer)
      window.clearTimeout(bootRemoveTimer)
      engineRef.current = null
      try {
        if (engine) engine.dispose()
      } catch (err) {
        /* already gone */
      }
      try {
        hostRef.current = null
        if (host) host.remove()
        if (style) style.remove()
      } catch (err) {
        /* page teardown */
      }
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (host) host.classList.toggle('is-quiet', quiet)
  }, [quiet])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const host = hostRef.current
    if (host == null) return undefined
    host.classList.add('is-wandering')

    const margin = 12
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Reduced motion: same wander, slower and calmer. It still stops and still
    // changes direction at random; it just does less of both.
    const cfg = Object.assign({}, MOTION_DEFAULTS, {
      speedScale: reduce ? 0.4 : 1,
      restScale: reduce ? 1.6 : 1,
      hoverScale: reduce ? 0.45 : 1,
      // Turning its back and sliding away is exactly the kind of large motion
      // reduced-motion users opted out of, so the whole choreography is off
      // there (the wander itself stays, just calmer).
      depart: Object.assign({}, MOTION_DEFAULTS.depart, { enabled: !reduce }),
    })

    let w = host.offsetWidth || 400
    let h = host.offsetHeight || 400
    // Conservative front-on silhouette (NDC half-extents, 1.0 = half a box):
    // used until the engine has drawn a frame and can report the real one, and
    // as the fallback if the engine is unavailable.
    const BODY_EXTENT_FALLBACK = { left: 0.78, right: 0.78, up: 0.52, down: 0.5 }
    const bodyExtent = () => {
      const engine = engineRef.current
      if (engine && typeof engine.getExtent === 'function') {
        const ext = engine.getExtent()
        if (ext != null && Number.isFinite(ext.left)) return ext
      }
      return BODY_EXTENT_FALLBACK
    }
    // The layer box is only the carrier. Since 0.9.29 the BODY collides with the
    // viewport edge: the engine reports how much of the box the silhouette
    // currently covers (it splay/streamline/turn, and shrink with depth), and the
    // box is allowed to hang off-screen by exactly that much. That is what makes
    // "the whole screen" reachable instead of a 625 px box inset from every edge.
    //
    // EDGE_PAD_PX is a fixed pixel margin, not an NDC one: the engine's probe is
    // geometric, while the visible silhouette includes the smooth-union bulge and
    // the bloom halo, which together run ~3-6 px outside it. A fixed pad keeps the
    // residual gap the same at every depth; an NDC pad shrank with the layer scale
    // and let the glow touch (then cross) the viewport edge when far.
    const EDGE_PAD_PX = 8
    const boundsFor = (scale) => {
      const ext = bodyExtent()
      const halfW = (w / 2) * scale
      const halfH = (h / 2) * scale
      return bodyBounds({
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        boxW: w,
        boxH: h,
        left: ext.left * halfW + EDGE_PAD_PX,
        right: ext.right * halfW + EDGE_PAD_PX,
        up: ext.up * halfH + EDGE_PAD_PX,
        down: ext.down * halfH + EDGE_PAD_PX,
      })
    }
    const measure = () => {
      w = host.offsetWidth || 400
      h = host.offsetHeight || 400
    }
    measure()
    // The departure and the distance lift move the layer on its own (apply()
    // adds them to the transform), so the collision has to reserve those pixels
    // at the top — otherwise a body already against the ceiling would be cut
    // when it rises or recedes.
    const boundsForMotion = (m, scale) => {
      const b = boundsFor(scale)
      const lift = getView(m, cfg).lift
      b.minY -= lift
      b.maxY -= lift
      return b
    }
    // Before the first frame there is no measured silhouette, so the initial
    // bounds use the fallback at the startup distance.
    let bounds = boundsFor(depthScale({ depthView: cfg.depthStart }, cfg))

    // Resume the wander instead of restarting it. The old code stored a single
    // number (`elapsed`) because the patrol path was a pure function of it; the
    // wander is state, so the whole state is stored: mode, anchor, heading,
    // speed, timers and the rng cursor.
    const STORE_KEY = 'dsh-void-octopus:behavior-v1'
    const load = () => {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw == null) return null
        return restoreBehavior(JSON.parse(raw), bounds, cfg)
      } catch (err) {
        return null
      }
    }
    const save = () => {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(serializeBehavior(motion)))
      } catch (err) {
        /* storage disabled (private mode / quota) — the wander just won't persist */
      }
    }
    const makeSeed = () => {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
          const buf = new Uint32Array(1)
          crypto.getRandomValues(buf)
          return buf[0] >>> 0
        }
      } catch (err) {
        /* insecure context — Math.random is perfectly fine for a wander */
      }
      return (Math.random() * 4294967296) >>> 0
    }

    const motion =
      load() ||
      createBehaviorState({
        x: Math.max(margin, window.innerWidth - w - margin),
        y: Math.max(margin, window.innerHeight - h - margin),
        seed: makeSeed(),
        cfg,
      })

    let raf = 0
    let lastStep = performance.now()
    let lastSaveAt = lastStep
    let disposed = false

    let facingOverride = null
    const apply = () => {
      // translate first, scale second: the element's centre lands at
      // (x + box/2, y + box/2) and the creature shrinks around that point, so a
      // depth change never makes the layer drift sideways. The behaviour's
      // x/y keep their "top-left of the base box" meaning, and the visual box
      // (box * scale, centred) is always inside the base box, so the existing
      // bounds stay correct.
      const scale = depthScale(motion, cfg)
      const view = getView(motion, cfg)
      // The lift rides on the translate rather than the scale, so "moving away"
      // also travels on screen instead of reading as someone resizing a picture.
      const y = motion.y + view.lift
      host.style.transform = `translate3d(${motion.x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`
      host.style.setProperty('--void-alpha', view.alpha.toFixed(3))
      const swim = getSwim(motion, cfg)
      const engine = engineRef.current
      if (engine) {
        if (typeof engine.setSwim === 'function') engine.setSwim(swim.x, swim.y, swim.amount)
        if (typeof engine.setFacing === 'function') engine.setFacing(facingOverride != null ? facingOverride : view.facing)
      }
    }

    apply()

    const tick = (now) => {
      if (disposed) return
      if (document.hidden) {
        lastStep = now
      } else {
        // Step EVERY frame, not every ~33 ms. The behaviour is dt-based, so the
        // wander itself is unchanged — but the layer's transform used to be
        // written every other frame, so every depth change arrived as a 30 Hz
        // step while the canvas animated at display rate. That reads as judder
        // ("缩放的时候有点抖"). The transform now updates at the same rate as
        // the render, which is what the eye expects from one moving object.
        const step = Math.min(0.1, (now - lastStep) / 1000)
        lastStep = now
        if (step > 0) {
          // Bounds follow the CURRENT silhouette and distance: closer/larger
          // means it must stop further from the wall, far/smaller means it may
          // hug it — the frustum narrowing with depth, expressed on screen.
          bounds = boundsForMotion(motion, depthScale(motion, cfg))
          stepBehavior(motion, step, bounds, cfg)
          if (motion.jet) {
            const engine = engineRef.current
            if (engine && typeof engine.pulse === 'function') engine.pulse()
          }
          apply()
          if (now - lastSaveAt > 2000) {
            lastSaveAt = now
            save()
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Console affordances. A departure is deliberately rare (one every 1-3 min),
    // so there has to be a way to see it on demand without waiting, and a way to
    // pin a facing angle for a screenshot. Nothing in the plugin calls these.
    try {
      window.__dshVoidOctopus = {
        /** Which bundle is actually running. A stale plugin bundle is the first
         *  thing to rule out when a rendering bug is reported. */
        version: typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'dev',
        depart() {
          startDeparture(motion, cfg.depart, Math.random)
          apply()
        },
        face(deg = 0) {
          facingOverride = (Number(deg) || 0) * (Math.PI / 180)
          apply()
        },
        release() {
          facingOverride = null
          apply()
        },
        /** Pin the distance (0 near, 1 far) for a few seconds, e.g. to check
         *  that far really is "back turned, lifted, dimmer". */
        depth(d = 0) {
          motion.depthTarget = Math.max(0, Math.min(1, Number(d) || 0))
          motion.depthTimer = 30
          apply()
        },
        state() {
          return { ...getDeparture(motion), view: getView(motion, cfg) }
        },
        /**
         * Current placement, for verification: layer top-left, the drawn scale,
         * the body half-extents the collision is using (NDC, 1.0 = half a box)
         * and the resulting top-left bounds.
         */
        pos() {
          return {
            x: motion.x,
            y: motion.y,
            scale: depthScale(motion, cfg),
            depth: motion.depthView,
            extent: bodyExtent(),
            bounds: { ...bounds },
          }
        },
        /** Arms-vs-body yaw lag (radians). 0 when not turning. */
        turnLag() {
          const engine = engineRef.current
          return engine && typeof engine.getTurnLag === 'function' ? engine.getTurnLag() : 0
        },
        /**
         * Put the BODY centre at viewport (cx, cy) and optionally pin the
         * distance. Verification only — it is how "can the body really reach
         * this corner without being cut off?" gets answered.
         */
        place(cx = window.innerWidth / 2, cy = window.innerHeight / 2, d = null) {
          if (Number.isFinite(d)) {
            // Pin the distance outright: the normal walk would take ~2 s to get
            // there and a verification shot does not have that long.
            const target = Math.max(0, Math.min(1, d))
            motion.depth = target
            motion.depthView = target
            motion.depthTarget = target
            motion.depthTimer = 30
          }
          bounds = boundsForMotion(motion, depthScale(motion, cfg))
          const lift = getView(motion, cfg).lift
          motion.mode = 'rest'
          motion.speed = 0
          motion.targetSpeed = 0
          motion.timer = 60
          motion.driftX = 0
          motion.driftY = 0
          motion.driftVX = 0
          motion.driftVY = 0
          motion.x = (Number.isFinite(cx) ? cx : window.innerWidth / 2) - w / 2
          motion.y = (Number.isFinite(cy) ? cy : window.innerHeight / 2) - h / 2 - lift
          motion.restX = motion.x
          motion.restY = motion.y
          clampBehavior(motion, bounds)
          apply()
          return { x: motion.x, y: motion.y, facing: getView(motion, cfg).facing }
        },
      }
    } catch (err) {
      /* no window (SSR) */
    }

    const onResize = () => {
      measure()
      // Size changed => the frustum cross-section changed: re-derive the
      // collision bounds before clamping the stored position into them.
      bounds = boundsForMotion(motion, depthScale(motion, cfg))
      clampBehavior(motion, bounds)
      lastStep = performance.now()
      apply()
    }
    window.addEventListener('resize', onResize)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      save()
      window.removeEventListener('resize', onResize)
      try {
        delete window.__dshVoidOctopus
      } catch (err) {
        /* nothing to clean up */
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let timer = 0
    const poke = () => {
      setQuiet(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setQuiet(false), 2600)
    }
    const onKey = (event) => {
      if (event == null) return
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
      poke()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', poke, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', poke, true)
    }
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (engine) engine.setActivity(mood)
  }, [mood])

  return null
}

function Guarded(props) {
  return h(Boundary, null, h(VoidOctopusAmbient, props))
}

const plugin = {
  name: 'dsh-void-octopus',
  inject: ['slots'],
  apply(ctx, config) {
    try {
      // `palette` comes from this row's Loader config; resolvePalette() falls
      // back to a localStorage override and then to the default preset.
      const requested = config == null || typeof config !== 'object' ? undefined : config.palette
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'void-octopus', order: 30 },
          (props) => h(Guarded, Object.assign({}, props, { palette: requested })),
        ),
      )
    } catch (err) {
      console.warn('[dsh-void-octopus] slot registration failed:', err)
    }
  },
}

export default plugin
