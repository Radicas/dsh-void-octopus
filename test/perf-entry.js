// Render harness for tests/benchmarks: a fixed 400×400 ambient-mode layer,
// the same CSS size the DSH plugin uses, with the engine's debug hooks exposed
// so a headless browser can pin the render scale and time real GPU frames.
//
// Built with: npx esbuild test/perf-entry.js --bundle --format=esm --target=es2022 --outfile=test/perf.bundle.js

import { createSdfOctopus } from '../src/scene/SdfOctopus.js'

const params = new URLSearchParams(location.search)
const state = params.get('state') || 'idle'
const stage = document.getElementById('stage')
window.__STAGES__ = []
const engine = createSdfOctopus({
  container: stage,
  mode: 'ambient',
  activity: state,
  palette: params.get('palette') || undefined,
  onStage: (name) => window.__STAGES__.push({ stage: name, at: Math.round(performance.now()) }),
})

window.__P__ = {
  engine,
  stats: () => engine.debug.getStats(),
  setScale: (value) => engine.debug.setRenderScale(value),
  bench: (frames) => engine.debug.renderFrames(frames),
  ready: true,
}
