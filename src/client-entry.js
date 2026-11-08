import { Component, createElement as h, useEffect, useRef, useState } from 'react'
import { createSdfOctopus } from './scene/SdfOctopus.js'

const CSS = `
.dsh-void-ambient {
  position: fixed;
  right: 10px;
  bottom: 8px;
  width: min(34vw, 400px);
  height: min(34vw, 400px);
  z-index: 50;
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: 0.8;
  transition: opacity 900ms ease;
  will-change: transform;
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, #000 56%, rgba(0, 0, 0, 0.72) 72%, transparent 88%);
  mask-image: radial-gradient(ellipse at 50% 50%, #000 56%, rgba(0, 0, 0, 0.72) 72%, transparent 88%);
}
.dsh-void-ambient.is-quiet {
  opacity: 0.2;
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
    width: min(52vw, 320px);
    height: min(52vw, 320px);
  }
}
.dsh-void-ambient.is-wandering {
  left: 0;
  top: 0;
  right: auto;
  bottom: auto;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-void-ambient { opacity: 0.5; }
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
      engine = createSdfOctopus({
        container: host,
        mode: 'ambient',
        activity: 'idle',
      })
      engineRef.current = engine
    } catch (err) {
      console.warn('[dsh-void-octopus] scene failed to start:', err)
      try {
        if (host) host.remove()
        if (style) style.remove()
      } catch (_) {}
      return undefined
    }
    return () => {
      engineRef.current = null
      try {
        engine.dispose()
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
    const speed = reduce ? 0.28 : 1

    let raf = 0
    let elapsed = 0
    let last = performance.now()
    let lastMove = 0
    let disposed = false
    let w = host.offsetWidth || 400
    let h = host.offsetHeight || 400
    let startX = 0
    let startY = 0
    let lastX = null
    let lastY = null
    let lastMoveAt = 0

    const measure = () => {
      w = host.offsetWidth || 400
      h = host.offsetHeight || 400
      startX = Math.max(margin, window.innerWidth - w - margin)
      startY = Math.max(margin, window.innerHeight - h - margin)
    }

    const place = () => {
      const freeW = Math.max(0, window.innerWidth - w - margin * 2)
      const freeH = Math.max(0, window.innerHeight - h - margin * 2)
      const nx =
        0.5 +
        0.5 * (0.68 * Math.sin(elapsed * 0.045) + 0.32 * Math.sin(elapsed * 0.021 + 1.7))
      const ny =
        0.5 +
        0.5 * (0.66 * Math.sin(elapsed * 0.037 + 0.7) + 0.34 * Math.sin(elapsed * 0.019 + 2.4))
      const pathX = margin + freeW * nx
      const pathY = margin + freeH * ny
      const blend = Math.min(1, elapsed / 12)
      const ease = blend * blend * (3 - 2 * blend)
      const x = startX + (pathX - startX) * ease
      const y = startY + (pathY - startY) * ease
      host.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`

      const now = performance.now()
      if (lastX != null) {
        const moveDt = (now - lastMoveAt) / 1000
        if (moveDt > 0.008) {
          const vx = (x - lastX) / moveDt
          const vy = (y - lastY) / moveDt
          const speed = Math.min(1, Math.max(0.15, Math.hypot(vx, vy) / 55))
          const engine = engineRef.current
          if (engine && typeof engine.setSwim === 'function') engine.setSwim(vx, vy, speed)
        }
      }
      lastX = x
      lastY = y
      lastMoveAt = now
    }

    measure()
    host.style.transform = `translate3d(${startX}px, ${startY}px, 0)`

    const tick = (now) => {
      if (disposed) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (document.hidden) {
        lastMove = now
      } else if (now - lastMove >= 33) {
        const jet = engineRef.current && typeof engineRef.current.getJet === 'function' ? engineRef.current.getJet() : 0
        elapsed += dt * speed * (0.8 + jet * 1.6)
        lastMove = now
        place()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const onResize = () => {
      measure()
      lastMove = 0
      place()
    }
    window.addEventListener('resize', onResize)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
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
  apply(ctx) {
    try {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'void-octopus', order: 30 }, Guarded),
      )
    } catch (err) {
      console.warn('[dsh-void-octopus] slot registration failed:', err)
    }
  },
}

export default plugin
