import { createSdfOctopus, ACTIVITIES } from '../src/scene/SdfOctopus.js'

const params = new URLSearchParams(location.search)
const initial = ACTIVITIES[params.get('state')] ? params.get('state') : 'idle'

const app = document.getElementById('app')
const stateLabel = document.getElementById('state-label')
const ui = document.getElementById('ui')
const toast = document.getElementById('toast')

if (params.get('studio') === '1') {
  const ui = document.getElementById('ui')
  if (ui) ui.classList.add('is-hidden')
  const vignette = document.getElementById('vignette')
  if (vignette) vignette.style.display = 'none'
}

const octopus = createSdfOctopus({
  container: app,
  mode: 'demo',
  activity: initial,
})

// Static facing probe: `?facing=180` holds the body at that yaw, so the back /
// profile views can be captured and judged without waiting for a departure.
const facingRaw = params.get('facing')
if (facingRaw != null && Number.isFinite(Number(facingRaw))) {
  const facingRad = (Number(facingRaw) * Math.PI) / 180
  const applyFacing = () => {
    octopus.setFacing(facingRad)
    requestAnimationFrame(applyFacing)
  }
  requestAnimationFrame(applyFacing)
}

let auto = params.get('auto') !== '0'
let autoTimer = 0
const order = ['idle', 'thinking', 'generating', 'tool']
let autoIndex = order.indexOf(initial)

const setState = (name, { announce = true } = {}) => {
  octopus.setActivity(name)
  stateLabel.textContent = name
  document.body.dataset.state = name
  if (announce) {
    auto = false
    autoTimer = 0
    toast.textContent = `mode · ${name}`
    toast.classList.add('is-on')
    clearTimeout(setState._t)
    setState._t = setTimeout(() => toast.classList.remove('is-on'), 1200)
  }
}

setState(initial, { announce: false })

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const map = { '1': 'idle', '2': 'thinking', '3': 'generating', '4': 'tool' }
  if (map[event.key]) {
    setState(map[event.key])
    autoIndex = order.indexOf(map[event.key])
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    auto = !auto
    toast.textContent = auto ? 'auto · on' : 'auto · off'
    toast.classList.add('is-on')
    clearTimeout(setState._t)
    setState._t = setTimeout(() => toast.classList.remove('is-on'), 1000)
    return
  }
  if (event.key === 'h' || event.key === 'H') {
    ui.classList.toggle('is-hidden')
    return
  }
  if (event.key === 'p' || event.key === 'P') {
    octopus.pulse()
  }
})

const clock = { last: performance.now(), elapsed: 0 }
const autoTick = (now) => {
  const dt = Math.min(0.1, (now - clock.last) / 1000)
  clock.last = now
  if (!auto) {
    clock.elapsed = 0
  } else {
    clock.elapsed += dt
    if (clock.elapsed > 7) {
      clock.elapsed = 0
      autoIndex = (autoIndex + 1) % order.length
      setState(order[autoIndex], { announce: false })
    }
  }
  requestAnimationFrame(autoTick)
}
requestAnimationFrame(autoTick)

window.__VOID__ = {
  octopus,
  setState,
  setAuto(value) {
    auto = Boolean(value)
  },
  /** Pin the facing angle in degrees (0 = front, 180 = back). */
  setFacing(deg) {
    octopus.setFacing((Number(deg) || 0) * (Math.PI / 180))
  },
  list: Object.keys(ACTIVITIES),
}
