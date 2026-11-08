import { createSdfOctopus } from '../src/scene/SdfOctopus.js'
const app = document.getElementById('app')
const engine = createSdfOctopus({ container: app, mode: 'demo', activity: 'idle' })
window.__SDF__ = engine
setTimeout(() => { window.__SDF_READY__ = true }, 1500)
