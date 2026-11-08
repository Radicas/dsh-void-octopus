import React from 'react'
import * as ReactDOM from 'react-dom'
import * as JsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

const requireMap = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': { createRoot },
  'react/jsx-runtime': JsxRuntime,
}

window.__ModuleLoader__ = {
  load({ id, factory }) {
    try {
      window.__VOID_PLUGIN__ = factory((name) => {
        if (!(name in requireMap)) throw new Error(`harness: unknown module "${name}"`)
        return requireMap[name]
      })
      console.log('[harness] loaded plugin', id)
    } catch (err) {
      console.error('[harness] factory failed', err)
    }
  },
}

let Component = null
const fakeCtx = {
  slots: {
    inject(name, fn) {
      if (name !== 'shell.overlay') throw new Error(`harness: unexpected slot ${name}`)
      return fn()
    },
    register(options, component) {
      if (options.name !== 'shell.overlay') throw new Error('harness: unexpected register')
      Component = component
      return () => {}
    },
  },
}

const waitFor = (test, onReady, timeout = 5000) => {
  const started = performance.now()
  const tick = () => {
    if (test()) return onReady()
    if (performance.now() - started > timeout) {
      console.error('[harness] timed out waiting for plugin')
      return
    }
    requestAnimationFrame(tick)
  }
  tick()
}

window.__VOID_TEST__ = {
  afterClient() {
    waitFor(
      () => window.__VOID_PLUGIN__ != null,
      () => {
        try {
          window.__VOID_PLUGIN__.apply(fakeCtx)
          const root = createRoot(document.getElementById('void-root'))
          root.render(
            React.createElement(Component, {
              sessionId: 'harness',
              useSessionStatus: () => ({ running: true, pendingInteraction: null }),
              useChat: (selector) =>
                selector({
                  legacy: {
                    runningCalls: [],
                    partial: { blocks: [{ text: 'the octopus is drifting' }] },
                  },
                }),
            }),
          )
          console.log('[harness] mounted')
        } catch (err) {
          console.error('[harness] mount failed', err)
        }
      },
    )
  },
}
