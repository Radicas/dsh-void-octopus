import { Component, createElement as h, useEffect, useRef, useState } from 'react'
import { createSdfOctopus, resolvePalette } from './scene/SdfOctopus.js'
import {
  DEFAULTS as MOTION_DEFAULTS,
  createBehaviorState,
  stepBehavior,
  getSwim,
  getDeparture,
  startDeparture,
  depthScale,
  serializeBehavior,
  restoreBehavior,
  clampBehavior,
} from './scene/behavior.js'

const CSS = `
.dsh-void-ambient {
  position: fixed;
  right: 10px;
  bottom: 8px;
  /* The box is sized for the CLOSEST appearance (scale 1). Depth retreats by
     scaling DOWN from here, so the canvas is only ever downsampled — resizing a
     400 px buffer up to 500 px would be blurry exactly when detail matters. */
  width: min(42vw, 500px);
  height: min(42vw, 500px);
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
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, #000 56%, rgba(0, 0, 0, 0.72) 72%, transparent 88%);
  mask-image: radial-gradient(ellipse at 50% 50%, #000 56%, rgba(0, 0, 0, 0.72) 72%, transparent 88%);
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
    width: min(65vw, 400px);
    height: min(65vw, 400px);
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
    let bounds = { minX: margin, minY: margin, maxX: margin, maxY: margin }
    const measure = () => {
      w = host.offsetWidth || 400
      h = host.offsetHeight || 400
      bounds = {
        minX: margin,
        minY: margin,
        maxX: Math.max(margin, window.innerWidth - w - margin),
        maxY: Math.max(margin, window.innerHeight - h - margin),
      }
    }
    measure()

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
      const view = getDeparture(motion)
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
      } else if (now - lastStep >= 33) {
        // Advance by the REAL interval since the last placement: the loop runs
        // at display rate but only steps ~30x/s, so a per-frame dt would stretch
        // every leg duration and halve every speed.
        const step = Math.min(0.1, (now - lastStep) / 1000)
        lastStep = now
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
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Console affordances. A departure is deliberately rare (one every 1-3 min),
    // so there has to be a way to see it on demand without waiting, and a way to
    // pin a facing angle for a screenshot. Nothing in the plugin calls these.
    try {
      window.__dshVoidOctopus = {
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
        state() {
          return getDeparture(motion)
        },
      }
    } catch (err) {
      /* no window (SSR) */
    }

    const onResize = () => {
      measure()
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
