#!/usr/bin/env node
/**
 * capture-turn.mjs — visual evidence for the void-octopus "tentacles lag when the
 * body turns" change (0.9.28).
 *
 *   node scripts/capture-turn.mjs baseline   # build demo from git HEAD in a worktree, capture
 *   node scripts/capture-turn.mjs after      # capture the current working tree, build compare images
 *
 * What it does
 * ------------
 * 1. Serves the repo (or a git worktree pinned to HEAD for the baseline) over
 *    http and drives the locally cached Chromium through raw CDP. Node 24's
 *    global fetch/WebSocket are the only "client library" used, so nothing is
 *    added to package.json or node_modules.
 * 2. Loads demo/index.html?studio=1&auto=0 and replaces requestAnimationFrame
 *    with a deterministic stepper *before* any page script runs. Every captured
 *    frame is therefore exactly N * 16.667 ms of simulation, independent of how
 *    long the PNG read-back takes (headless SwiftShader read-back is seconds per
 *    frame; hardware D3D11 is ~50 ms). The baseline and the after run share the
 *    identical virtual timeline, which is what makes the side-by-side diff fair.
 * 3. Drives a planned 2.0 s smoothstep turn (facing target advanced every
 *    ~83 ms, 25 steps) and keeps simulating 1.4 s after it stops. Capture every
 *    100 ms => 35 frames.
 * 4. Saves filmstrip + 45/90/135 deg keyframes + JSON timeline; in `after` mode
 *    also composes baseline|after|diff comparison images and the lag series.
 *
 * Outputs (all under design/):
 *   turn-filmstrip-<tag>.png
 *   turn-keyframe-{45,90,135}-<tag>.png
 *   turn-compare-{45,90,135}.png        (after mode only)
 *   turn-<tag>.json
 *   turn-lag-series.json                (after mode only)
 *
 * The script never edits src/, client.js, demo/bundle.js, package.json or tests.
 * The baseline worktree lives in <workspace>/.scratch-verify/baseline.
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(REPO, '..')
const SCRATCH = path.join(WORKSPACE, '.scratch-verify')
const DESIGN = path.join(REPO, 'design')
const BASELINE_WT = path.join(SCRATCH, 'baseline')
const BASELINE_COMMIT_FILE = path.join(SCRATCH, 'baseline-commit.txt')
const DT_MS = 1000 / 60
const DEG = 180 / Math.PI

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (n, d = 4) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/* ------------------------------------------------------------------ */
/* static server                                                       */
/* ------------------------------------------------------------------ */

function startServer(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(u.pathname)
      if (rel === '/favicon.ico') {
        res.writeHead(204).end()
        return
      }
      // blank same-origin page used by the GIF composer (2D canvas only)
      if (rel === '/_gifs') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('<!doctype html><meta charset="utf-8"><title>gif composer</title><body style="margin:0;background:#000">')
        return
      }
      // /_scratch/... serves the verification scratch dir so the browser can load
      // the baseline frames as same-origin images (a cross-origin image would
      // taint the canvas and MediaRecorder would refuse to record it).
      let base = root
      if (rel.startsWith('/_scratch/')) {
        base = SCRATCH
        rel = rel.slice('/_scratch'.length)
      }
      if (rel.endsWith('/')) rel += 'index.html'
      const abs = path.normalize(path.join(base, rel))
      if (!abs.toLowerCase().startsWith(path.normalize(base).toLowerCase())) {
        res.writeHead(403).end('forbidden')
        return
      }
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat || !stat.isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': stat.size,
      })
      fs.createReadStream(abs).pipe(res)
    } catch (err) {
      res.writeHead(500).end(String(err))
    }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------ */
/* minimal CDP client                                                  */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP websocket connect failed'))
      this.ws.onclose = () => {
        this.closed = true
        for (const { reject } of this.pending.values()) reject(new Error('CDP websocket closed'))
        this.pending.clear()
      }
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id != null) {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
          else p.resolve(msg.result)
        } else if (msg.method) {
          const set = this.handlers.get(msg.method)
          if (set) for (const fn of set) fn(msg.params)
        }
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        reject(err)
      }
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method).add(fn)
  }
  close() {
    try { this.ws?.close() } catch { /* already gone */ }
  }
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  })
  if (res.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(`page evaluate failed: ${d.text} ${d.exception?.description || ''}`)
  }
  return res.result.value
}

/* ------------------------------------------------------------------ */
/* page-side code: deterministic rAF stepper                           */
/* ------------------------------------------------------------------ */

// Installed before every new document. Replaces rAF with a queue that only runs
// when __STEP__.step(dt) is called, and lets us stub WebGL draw calls so the
// hundreds of simulation-only steps don't cost a render each.
const STEPPER_SOURCE = `(() => {
  // Seed Math.random so the engine's autonomous micro-actions (blink, gaze,
  // jet timer, ...) are identical in the baseline and the after run; otherwise
  // the before/after pixel diff would be full of unrelated noise.
  let seed = 0x9e3779b9 >>> 0
  Math.random = function () {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const queue = new Map()
  let nextId = 1
  let vnow = 0
  let init = false
  let skipDraw = false
  const ensure = () => { if (!init) { vnow = performance.now(); init = true } }
  window.__STEP__ = {
    step(dtMs) {
      ensure()
      vnow += dtMs
      const callbacks = [...queue.values()]
      queue.clear()
      for (const cb of callbacks) {
        try { cb(vnow) } catch (err) { console.error('stepped callback threw', err) }
      }
      return { now: vnow, pending: queue.size }
    },
    resetTime() { vnow = performance.now(); init = true; return vnow },
    get pending() { return queue.size },
    get now() { return vnow },
  }
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
  window.__setSkipDraw__ = (value) => { skipDraw = Boolean(value) }
  for (const Ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!Ctor) continue
    const proto = Ctor.prototype
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      if (typeof proto[name] !== 'function') continue
      const orig = proto[name]
      proto[name] = function (...args) { if (skipDraw) return; return orig.apply(this, args) }
    }
  }
})()`

// Installed after the engine is ready. Exposes the scripted-turn driver.
const DRIVER_SOURCE = `(() => {
  const DT = 1000 / 60
  const TURN_MS = 2000
  const HOLD_MS = 1400
  const UPDATE_EVERY = 5
  const SAMPLE_EVERY = 6
  const SETTLE_STEPS = 150
  const TOTAL_STEPS = Math.round((TURN_MS + HOLD_MS) / DT)
  const DEG = 180 / Math.PI
  const oct = () => window.__VOID__.octopus
  const stepOnce = () => window.__STEP__.step(DT)
  const ease = (p) => p * p * (3 - 2 * p)
  const lagOf = (o) => (typeof o.getTurnLag === 'function' ? o.getTurnLag() : null)
  const braceOf = (o) => (typeof o.getTurnBrace === 'function' ? o.getTurnBrace() : null)
  const setTarget = (k, o) => {
    if (k % UPDATE_EVERY !== 0) return
    const p = Math.min(1, (k * DT) / TURN_MS)
    o.setFacing(Math.PI * ease(p))
  }
  const frames = new Map()
  const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('PNG decode failed'))
    img.src = url
  })
  const sampleSignature = (img) => {
    const c = document.createElement('canvas')
    c.width = 96
    c.height = 96
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0, 96, 96)
    const px = ctx.getImageData(0, 0, 96, 96).data
    const sig = new Float32Array(96 * 96)
    let lit = 0
    let sum = 0
    for (let i = 0; i < px.length; i += 4) {
      const mx = Math.max(px[i], px[i + 1], px[i + 2])
      if (mx > 10) lit++
      sum += mx
      sig[i >> 2] = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
    }
    return { sig, litRatio: lit / (96 * 96), mean: sum / (96 * 96 * 4) }
  }
  const bytesToBase64 = (bytes) => {
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  const probeVideo = (blob) => new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      const info = {
        width: video.videoWidth,
        height: video.videoHeight,
        durationSec: Number.isFinite(video.duration) ? video.duration : null,
      }
      URL.revokeObjectURL(url)
      resolve(info)
    }
    video.onloadedmetadata = finish
    video.onerror = finish
    setTimeout(finish, 5000)
    video.src = url
  })
  // Real-time canvas recording. MediaRecorder emits H.264/MP4 in this headless
  // Chrome (verified), so the deliverable is a genuine .mp4, not a WebM
  // masquerade; VP9/VP8 WebM stays as a fallback.
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
  ]
  const recordCanvas = async (canvas, count, fps, draw, bitsPerSecond) => {
    let lastError = null
    for (const mimeType of MIME_CANDIDATES) {
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType)) {
        lastError = new Error('unsupported ' + mimeType)
        continue
      }
      try {
        const stream = canvas.captureStream(fps)
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond })
        const chunks = []
        let mediaError = null
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
        recorder.onerror = (e) => { mediaError = String((e && e.error) || e) }
        const stopped = new Promise((resolve) => { recorder.onstop = resolve })
        await draw(0)
        await new Promise((r) => setTimeout(r, 120))
        recorder.start(250)
        const frameMs = 1000 / fps
        const t0 = performance.now()
        for (let i = 0; i < count; i++) {
          await draw(i)
          const target = t0 + (i + 1) * frameMs
          const wait = target - performance.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        }
        await new Promise((r) => setTimeout(r, 350))
        recorder.stop()
        await stopped
        const blob = new Blob(chunks, { type: recorder.mimeType })
        if (!blob.size || mediaError) {
          lastError = new Error(mediaError || 'MediaRecorder produced no data')
          continue
        }
        const buffer = await blob.arrayBuffer()
        const info = await probeVideo(blob)
        return {
          mime: recorder.mimeType,
          bytes: blob.size,
          base64: bytesToBase64(new Uint8Array(buffer)),
          width: info.width,
          height: info.height,
          durationSec: info.durationSec,
          frames: count,
        }
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('no supported video mime type')
  }
  const api = {
    DT, TURN_MS, HOLD_MS, TOTAL_STEPS, SAMPLE_EVERY, SETTLE_STEPS,
    filmstripTitle: '',
    init(scale) {
      const a = window.__VOID__
      const o = a.octopus
      a.setAuto(false)
      if (typeof o.setAutoJet === 'function') o.setAutoJet(false)
      o.debug.setAdaptive(false)
      o.debug.setRenderScale(scale)
      window.__STEP__.resetTime()
      window.__setSkipDraw__(true)
      for (let i = 0; i < 30; i++) stepOnce()
      window.__setSkipDraw__(false)
      return { facing: o.getFacing(), stats: o.debug.getStats() }
    },
    verifyCapture() {
      const o = oct()
      const url = o.debug.capture()
      return loadImage(url).then((img) => {
        const s = sampleSignature(img)
        return { litRatio: s.litRatio, mean: s.mean, urlLength: url.length }
      })
    },
    settle(steps) {
      const o = oct()
      window.__setSkipDraw__(true)
      for (let i = 0; i < steps; i++) stepOnce()
      return { facing: o.getFacing() }
    },
    resetToFront() {
      const o = oct()
      o.setFacing(0)
      window.__setSkipDraw__(true)
      for (let i = 0; i < SETTLE_STEPS; i++) stepOnce()
      return { facing: o.getFacing() }
    },
    /** Advance the planned turn without rendering, recording facing (and lag). */
    planTurn() {
      const o = oct()
      const facing = []
      const lags = []
      const braces = []
      window.__setSkipDraw__(true)
      for (let k = 0; k < TOTAL_STEPS; k++) {
        setTarget(k, o)
        stepOnce()
        facing.push(o.getFacing())
        lags.push(lagOf(o))
        braces.push(braceOf(o))
      }
      return {
        facing,
        lags,
        braces,
        steps: TOTAL_STEPS,
        lagSupported: typeof o.getTurnLag === 'function',
        braceSupported: typeof o.getTurnBrace === 'function',
      }
    },
    /** Replay the identical planned turn and render only the requested steps. */
    runCaptures(stepList) {
      const o = oct()
      const wanted = new Set(stepList)
      const captured = []
      const t0 = performance.now()
      const grab = (step, ms) => {
        const c0 = performance.now()
        window.__setSkipDraw__(false)
        const url = o.debug.capture()
        const captureMs = performance.now() - c0
        window.__setSkipDraw__(true)
        const facing = o.getFacing()
        const lag = lagOf(o)
        const brace = braceOf(o)
        frames.set(step, { step, ms, facing, lag, brace, url })
        captured.push({ step, ms, facing, lag, brace, captureMs })
      }
      window.__setSkipDraw__(true)
      if (wanted.has(0)) grab(0, 0)
      for (let k = 0; k < TOTAL_STEPS; k++) {
        setTarget(k, o)
        stepOnce()
        const j = k + 1
        if (wanted.has(j)) grab(j, j * DT)
      }
      window.__setSkipDraw__(false)
      return { captured, wallMs: performance.now() - t0, totalSteps: TOTAL_STEPS }
    },
    analyzeSamples(sampleSteps) {
      return (async () => {
        const items = []
        for (const step of sampleSteps) {
          const f = frames.get(step)
          if (!f) throw new Error('missing captured frame ' + step)
          const img = await loadImage(f.url)
          const s = sampleSignature(img)
          items.push({ f, img, sig: s.sig, litRatio: s.litRatio })
        }
        const diff = (a, b) => {
          let sum = 0
          for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
          return sum / a.length
        }
        const perFrame = items.map((it, i) => ({
          step: it.f.step,
          litRatio: it.litRatio,
          diffPrev: i === 0 ? 0 : diff(items[i - 1].sig, it.sig),
          diffFirst: diff(items[0].sig, it.sig),
        }))
        const THUMB = 176
        const GAP = 8
        const PAD = 16
        const TITLE_H = 42
        const LABEL_H = 32
        const n = items.length
        const W = PAD * 2 + n * THUMB + (n - 1) * GAP
        const H = PAD + TITLE_H + LABEL_H + THUMB + PAD
        const fc = document.createElement('canvas')
        fc.width = W
        fc.height = H
        const fx = fc.getContext('2d')
        fx.fillStyle = '#04060c'
        fx.fillRect(0, 0, W, H)
        fx.fillStyle = '#c8efff'
        fx.font = '600 17px ui-sans-serif, "Segoe UI", sans-serif'
        fx.textBaseline = 'top'
        fx.fillText(api.filmstripTitle, PAD, PAD + 3)
        fx.font = '12px ui-monospace, Consolas, monospace'
        for (let i = 0; i < n; i++) {
          const it = items[i]
          const x = PAD + i * (THUMB + GAP)
          const y = PAD + TITLE_H + LABEL_H
          fx.fillStyle = '#9ad8ee'
          fx.fillText('#' + i + ' ' + Math.round(it.f.ms) + 'ms', x + 2, y - 16)
          fx.fillText((it.f.facing * DEG).toFixed(1) + '\\u00b0', x + 2, y - 3)
          fx.drawImage(it.img, x, y, THUMB, THUMB)
          fx.strokeStyle = 'rgba(110,244,255,0.22)'
          fx.strokeRect(x + 0.5, y + 0.5, THUMB - 1, THUMB - 1)
        }
        return { filmstrip: fc.toDataURL('image/png'), perFrame, width: W, height: H }
      })()
    },
    getFrame(step) {
      const f = frames.get(step)
      if (!f) return null
      return { step: f.step, ms: f.ms, facing: f.facing, lag: f.lag, brace: f.brace, url: f.url }
    },
    measureFrame(step) {
      const f = frames.get(step)
      if (!f) return Promise.resolve(null)
      return loadImage(f.url).then((img) => sampleSignature(img).litRatio)
    },
    /** 10 fps MP4 of the filmstrip frames, recorded offscreen via MediaRecorder. */
    recordFilmstripVideo(sampleSteps, fps) {
      return (async () => {
        const images = []
        for (const step of sampleSteps) {
          const f = frames.get(step)
          if (!f) throw new Error('missing frame ' + step)
          images.push(await loadImage(f.url))
        }
        const w = images[0].naturalWidth
        const h = images[0].naturalHeight
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        return recordCanvas(canvas, images.length, fps, async (i) => {
          ctx.drawImage(images[i], 0, 0, w, h)
        }, 4000000)
      })()
    },
    /** 10 fps MP4 of baseline | after pairs, labels on top, identical frame index. */
    recordPairVideo(pairs, fps) {
      return (async () => {
        const lefts = []
        const rights = []
        for (const p of pairs) {
          lefts.push(await loadImage(p.leftUrl))
          const f = frames.get(p.rightStep)
          if (!f) throw new Error('missing frame ' + p.rightStep)
          rights.push(await loadImage(f.url))
        }
        const w = lefts[0].naturalWidth
        const h = lefts[0].naturalHeight
        const PAD = 14
        const GAP = 12
        const HEADER = 46
        const FOOTER = 10
        const W = PAD * 2 + w * 2 + GAP
        const H = HEADER + h + FOOTER
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')
        return recordCanvas(canvas, pairs.length, fps, async (i) => {
          ctx.fillStyle = '#04060c'
          ctx.fillRect(0, 0, W, H)
          ctx.textBaseline = 'top'
          ctx.font = '600 17px ui-sans-serif, "Segoe UI", sans-serif'
          ctx.fillStyle = '#c8efff'
          ctx.fillText(pairs[i].leftLabel, PAD, 15)
          ctx.fillStyle = '#ffd9a0'
          ctx.fillText(pairs[i].rightLabel, PAD + w + GAP, 15)
          ctx.drawImage(lefts[i], PAD, HEADER)
          ctx.drawImage(rights[i], PAD + w + GAP, HEADER)
          ctx.fillStyle = 'rgba(110,244,255,0.18)'
          ctx.fillRect(PAD + w + GAP / 2 - 0.5, HEADER, 1, h)
        }, 6000000)
      })()
    },
    /** Two-up composite for the side-by-side video (labels on top, no diff panel). */
    composePair(opts) {
      return (async () => {
        const left = await loadImage(opts.leftUrl)
        const right = await loadImage(opts.rightUrl)
        const w = left.naturalWidth
        const h = left.naturalHeight
        const PAD = 14
        const GAP = 12
        const HEADER = 46
        const FOOTER = 10
        const W = PAD * 2 + w * 2 + GAP
        const H = HEADER + h + FOOTER
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#04060c'
        ctx.fillRect(0, 0, W, H)
        ctx.textBaseline = 'top'
        ctx.font = '600 17px ui-sans-serif, "Segoe UI", sans-serif'
        ctx.fillStyle = '#c8efff'
        ctx.fillText(opts.leftLabel, PAD, 15)
        ctx.fillStyle = '#ffd9a0'
        ctx.fillText(opts.rightLabel, PAD + w + GAP, 15)
        ctx.drawImage(left, PAD, HEADER)
        ctx.drawImage(right, PAD + w + GAP, HEADER)
        ctx.fillStyle = 'rgba(110,244,255,0.18)'
        ctx.fillRect(PAD + w + GAP / 2 - 0.5, HEADER, 1, h)
        return { url: c.toDataURL('image/png'), width: W, height: H }
      })()
    },
    /**
     * Region statistics for a baseline/after keyframe pair. The whole point is
     * to separate "mantle/eyes did not move" from "outer tentacles moved".
     * Regions are pre-registered: top 42% of the lit bounding box, inner half
     * of that box width = mantle core; everything else lit = tentacles.
     */
    analyzePair(opts) {
      return (async () => {
        const left = await loadImage(opts.leftUrl)
        const right = await loadImage(opts.rightUrl)
        const w = left.naturalWidth
        const h = left.naturalHeight
        const lc = document.createElement('canvas')
        lc.width = w
        lc.height = h
        const lctx = lc.getContext('2d')
        lctx.drawImage(left, 0, 0, w, h)
        const rc = document.createElement('canvas')
        rc.width = w
        rc.height = h
        const rctx = rc.getContext('2d')
        rctx.drawImage(right, 0, 0, w, h)
        const A = lctx.getImageData(0, 0, w, h).data
        const B = rctx.getImageData(0, 0, w, h).data
        const N = w * h
        const diff = new Float32Array(N)
        const lit = new Uint8Array(N)
        let litCount = 0
        let sumDiff = 0
        let x0 = w
        let y0 = h
        let x1 = -1
        let y1 = -1
        let sx = 0
        let sy = 0
        const hist = new Uint32Array(256)
        for (let i = 0; i < N; i++) {
          const o = i * 4
          const ea = Math.max(A[o], A[o + 1], A[o + 2])
          const eb = Math.max(B[o], B[o + 1], B[o + 2])
          const d = (Math.abs(A[o] - B[o]) + Math.abs(A[o + 1] - B[o + 1]) + Math.abs(A[o + 2] - B[o + 2])) / 3
          diff[i] = d
          sumDiff += d
          if (ea > 24 || eb > 24) {
            lit[i] = 1
            litCount++
            hist[Math.min(255, Math.round(d))]++
            const x = i % w
            const y = (i / w) | 0
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
            sx += x
            sy += y
          }
        }
        const bw = x1 - x0 + 1
        const bh = y1 - y0 + 1
        const bodyX = sx / litCount
        const bodyY = sy / litCount
        const mantleBottom = y0 + 0.42 * bh
        const coreHalf = 0.28 * bw
        const makeRegion = () => ({ count: 0, diffSum: 0 })
        const mantleCore = makeRegion()
        const upperArms = makeRegion()
        const lowerArms = makeRegion()
        const allLit = makeRegion()
        const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, makeRegion))
        const radial = Array.from({ length: 4 }, makeRegion)
        const quad = { left: 0, right: 0, up: 0, down: 0 }
        let brightSum = 0
        let bSumX = 0
        let bSumY = 0
        let maxDiff = 0
        let maxAt = [0, 0]
        const radialMax = 0.5 * Math.max(bw, bh)
        for (let i = 0; i < N; i++) {
          if (!lit[i]) continue
          const x = i % w
          const y = (i / w) | 0
          const d = diff[i]
          const inUpper = y <= mantleBottom
          let region
          if (inUpper && Math.abs(x - bodyX) <= coreHalf) {
            region = mantleCore
          } else if (inUpper) {
            region = upperArms
          } else {
            region = lowerArms
          }
          region.count++
          region.diffSum += d
          allLit.count++
          allLit.diffSum += d
          const gx = Math.min(4, Math.floor(((x - x0) / bw) * 5))
          const gy = Math.min(4, Math.floor(((y - y0) / bh) * 5))
          grid[gy][gx].count++
          grid[gy][gx].diffSum += d
          const r = Math.hypot(x - bodyX, y - bodyY) / radialMax
          const rb = r < 0.35 ? 0 : r < 0.6 ? 1 : r < 0.85 ? 2 : 3
          radial[rb].count++
          radial[rb].diffSum += d
          if (x < bodyX) quad.left += d
          else quad.right += d
          if (y < bodyY) quad.up += d
          else quad.down += d
          if (d > maxDiff) {
            maxDiff = d
            maxAt = [x, y]
          }
        }
        // top 2% diff pixels among lit pixels: threshold from the histogram
        const target = Math.max(1, Math.round(litCount * 0.02))
        let acc = 0
        let threshold = 0
        for (let v = 255; v >= 0; v--) {
          acc += hist[v]
          if (acc >= target) {
            threshold = v
            break
          }
        }
        let brightCount = 0
        for (let i = 0; i < N; i++) {
          if (!lit[i] || diff[i] < threshold) continue
          brightCount++
          bSumX += i % w
          bSumY += (i / w) | 0
          brightSum += diff[i]
        }
        let massX = 0
        let massY = 0
        let mass = 0
        for (let i = 0; i < N; i++) {
          if (!lit[i] || diff[i] <= 0.001) continue
          massX += (i % w) * diff[i]
          massY += ((i / w) | 0) * diff[i]
          mass += diff[i]
        }
        const brightX = brightCount ? bSumX / brightCount : bodyX
        const brightY = brightCount ? bSumY / brightCount : bodyY
        const massCenterX = mass ? massX / mass : bodyX
        const massCenterY = mass ? massY / mass : bodyY
        const r = (v, dd) => Number(v.toFixed(dd))
        const meanOf = (reg) => (reg.count ? reg.diffSum / reg.count : 0)
        const shareOf = (reg) => (allLit.diffSum ? (reg.diffSum / allLit.diffSum) * 100 : 0)
        const angleDeg = (Math.atan2(-(brightY - bodyY), brightX - bodyX) * 180) / Math.PI
        return {
          width: w,
          height: h,
          bbox: [x0, y0, bw, bh],
          bodyCenter: [r(bodyX, 1), r(bodyY, 1)],
          litPixels: litCount,
          litRatio: r(litCount / N, 4),
          meanDiffLit: r(meanOf(allLit), 3),
          meanDiffAll: r(sumDiff / N, 3),
          maxDiff: r(maxDiff, 3),
          maxAt,
          regions: {
            mantleCore: { pixels: mantleCore.count, meanDiff: r(meanOf(mantleCore), 3), energySharePct: r(shareOf(mantleCore), 1) },
            upperArms: { pixels: upperArms.count, meanDiff: r(meanOf(upperArms), 3), energySharePct: r(shareOf(upperArms), 1) },
            lowerArms: { pixels: lowerArms.count, meanDiff: r(meanOf(lowerArms), 3), energySharePct: r(shareOf(lowerArms), 1) },
            tentaclesAll: {
              pixels: upperArms.count + lowerArms.count,
              meanDiff: r((upperArms.diffSum + lowerArms.diffSum) / Math.max(1, upperArms.count + lowerArms.count), 3),
              energySharePct: r(shareOf(upperArms) + shareOf(lowerArms), 1),
            },
          },
          grid5: grid.map((row) => row.map((cell) => r(meanOf(cell), 2))),
          grid5Pixels: grid.map((row) => row.map((cell) => cell.count)),
          radialBands: radial.map((reg, i) => ({
            band: ['0-0.35', '0.35-0.6', '0.6-0.85', '>0.85'][i],
            pixels: reg.count,
            meanDiff: r(meanOf(reg), 3),
            energySharePct: r(shareOf(reg), 1),
          })),
          quadrants: {
            leftEnergyPct: r((quad.left / Math.max(1, quad.left + quad.right)) * 100, 1),
            rightEnergyPct: r((quad.right / Math.max(1, quad.left + quad.right)) * 100, 1),
            upEnergyPct: r((quad.up / Math.max(1, quad.up + quad.down)) * 100, 1),
            downEnergyPct: r((quad.down / Math.max(1, quad.up + quad.down)) * 100, 1),
          },
          bright: {
            thresholdDiff: threshold,
            pixels: brightCount,
            centroid: [r(brightX, 1), r(brightY, 1)],
            offsetFromBody: [r(brightX - bodyX, 1), r(brightY - bodyY, 1)],
            screenAngleDeg: r(angleDeg, 1),
            direction: angleDeg >= -45 && angleDeg < 45 ? 'right'
              : angleDeg >= 45 && angleDeg < 135 ? 'up'
                : angleDeg >= 135 || angleDeg < -135 ? 'left' : 'down',
            meanDiff: r(brightCount ? brightSum / brightCount : 0, 3),
          },
          diffMassCentroid: {
            centroid: [r(massCenterX, 1), r(massCenterY, 1)],
            offsetFromBody: [r(massCenterX - bodyX, 1), r(massCenterY - bodyY, 1)],
          },
        }
      })()
    },
    /** Keep simulating the stopped turn (no rendering) to see the lag settle. */
    recordLagTail(extraSteps) {
      const o = oct()
      const baseMs = TOTAL_STEPS * DT
      const entries = []
      window.__setSkipDraw__(true)
      for (let i = 0; i < extraSteps; i++) {
        stepOnce()
        entries.push({
          ms: baseMs + (i + 1) * DT,
          facing: o.getFacing(),
          lag: lagOf(o),
          brace: braceOf(o),
        })
      }
      window.__setSkipDraw__(false)
      return entries
    },
    /** Side-by-side baseline | after | difference composite (2D canvas only). */
    composeCompare(opts) {
      return (async () => {
        const left = await loadImage(opts.leftUrl)
        const right = await loadImage(opts.rightUrl)
        const w = left.naturalWidth
        const h = left.naturalHeight
        const PAD = 18
        const GAP = 14
        const HEADER = 66
        const FOOTER = 34
        const W = PAD * 2 + w * 3 + GAP * 2
        const H = HEADER + h + FOOTER
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#04060c'
        ctx.fillRect(0, 0, W, H)
        const ax = PAD
        const bx = PAD + w + GAP
        const cx = PAD + (w + GAP) * 2
        const ty = HEADER
        ctx.textBaseline = 'top'
        ctx.font = '600 19px ui-sans-serif, "Segoe UI", sans-serif'
        ctx.fillStyle = '#c8efff'
        ctx.fillText(opts.leftLabel, ax, 20)
        ctx.fillStyle = '#ffd9a0'
        ctx.fillText(opts.rightLabel, bx, 20)
        ctx.fillStyle = '#ff9de0'
        ctx.fillText(opts.diffLabel, cx, 20)
        ctx.drawImage(left, ax, ty)
        ctx.drawImage(right, bx, ty)
        // difference panel: absolute per-channel difference, amplified
        const lc = document.createElement('canvas')
        lc.width = w
        lc.height = h
        const lctx = lc.getContext('2d')
        lctx.drawImage(left, 0, 0)
        const rc = document.createElement('canvas')
        rc.width = w
        rc.height = h
        const rctx = rc.getContext('2d')
        const rw = right.naturalWidth
        const rh = right.naturalHeight
        rctx.drawImage(right, 0, 0, w, h)
        const a = lctx.getImageData(0, 0, w, h).data
        const b = rctx.getImageData(0, 0, w, h).data
        const dc = document.createElement('canvas')
        dc.width = w
        dc.height = h
        const dctx = dc.getContext('2d')
        const out = dctx.createImageData(w, h)
        const GAIN = 6
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.min(255, Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) * GAIN / 3
          const v = 255 - Math.min(255, d)
          out.data[i] = v
          out.data[i + 1] = v
          out.data[i + 2] = v
          out.data[i + 3] = 255
        }
        dctx.putImageData(out, 0, 0)
        ctx.drawImage(dc, cx, ty)
        ctx.font = '12px ui-monospace, Consolas, monospace'
        ctx.fillStyle = '#7fb8cd'
        const note = 'baseline ' + opts.leftInfo + '   |   after ' + opts.rightInfo + '   |   ' + opts.note
        ctx.fillText(note, PAD, H - FOOTER + 10)
        return { url: c.toDataURL('image/png'), width: W, height: H, leftNatural: [left.naturalWidth, left.naturalHeight], rightNatural: [rw, rh] }
      })()
    },
  }
  window.__TURN_TEST__ = api
})()`

/* ------------------------------------------------------------------ */
/* chrome launching                                                    */
/* ------------------------------------------------------------------ */

function chromeCandidates(cliChrome) {
  const list = []
  if (cliChrome) list.push(cliChrome)
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH)
  const local = process.env.LOCALAPPDATA
  if (local) {
    list.push(path.join(local, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'))
    list.push(path.join(local, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe'))
    list.push(path.join(local, 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'))
  }
  return [...new Set(list)].filter((p) => p && fs.existsSync(p))
}

const RENDERER_CONFIGS = [
  {
    name: 'hardware-d3d11',
    args: ['--use-angle=d3d11'],
    why: 'Intel/ANGLE D3D11; renders the same image as SwiftShader but ~100x faster',
  },
  {
    name: 'swiftshader',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
    why: 'ANGLE SwiftShader software fallback',
  },
]

function browserArgs(debugPort, profile, extra) {
  return [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1000,1000',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
    ...extra,
    'about:blank',
  ]
}

async function waitForChrome(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    await sleep(100)
  }
  throw new Error('Chrome never exposed its debugging endpoint')
}

async function openBlankTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`/json/new returned ${res.status}`)
  return await res.json()
}

function killTree(child) {
  if (!child || child.exitCode != null) return
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch { /* best effort */ }
}

async function removeProfile(profile) {
  for (let i = 0; i < 6; i++) {
    try {
      await fsp.rm(profile, { recursive: true, force: true })
      return
    } catch {
      await sleep(300)
    }
  }
}

/**
 * Boot one browser configuration, load the demo page, install the deterministic
 * driver and prove the canvas is not blank. Returns a session or throws.
 */
async function bootSession({ root, httpPort, chrome, config, scale, waitMs, log }) {
  const debugPort = await freePort()
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-turn-'))
  const args = browserArgs(debugPort, profile, config.args)
  const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true })
  const consoleEvents = []
  let cdp = null
  const bust = () => {
    cdp?.close()
    killTree(child)
    removeProfile(profile)
  }
  try {
    const version = await waitForChrome(debugPort)
    const target = await openBlankTarget(debugPort)
    cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      consoleEvents.push({ source: 'console', level: p.type, text: String(text).slice(0, 800) })
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      consoleEvents.push({ source: 'exception', level: 'error', text: `${d.text || ''} ${d.exception?.description || ''}`.trim().slice(0, 1200) })
    })
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {}
      consoleEvents.push({ source: 'log', level: e.level, text: String(e.text || '').slice(0, 800) })
    })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEPPER_SOURCE })

    const url = `http://127.0.0.1:${httpPort}/demo/index.html?studio=1&auto=0`
    log(`  navigate ${url}`)
    await cdp.send('Page.navigate', { url })

    // read-back through the driver needs the engine's own render loop to exist,
    // which means firstFrameMs > 0 and a queued rAF callback.
    const bootStart = Date.now()
    let ready = null
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      ready = await evaluate(cdp, `(() => {
        try {
          const v = window.__VOID__
          if (!v || !v.octopus || !v.octopus.debug) return null
          const s = v.octopus.debug.getStats()
          if (!(s.firstFrameMs > 0)) return null
          return {
            firstFrameMs: s.firstFrameMs,
            buffer: s.buffer,
            css: s.css,
            dpr: s.dpr,
            hidden: s.hidden,
            rafPending: window.__STEP__ ? window.__STEP__.pending : -1,
          }
        } catch (err) { return null }
      })()`).catch(() => null)
      if (ready) break
      await sleep(250)
    }
    if (!ready) throw new Error('engine never rendered its first frame')
    if (ready.hidden) throw new Error('page is hidden (document.hidden), animation paused')
    if (ready.rafPending < 1) throw new Error('requestAnimationFrame stepper did not intercept the render loop')

    const gl = await evaluate(cdp, `(() => {
      const c = document.createElement('canvas')
      const g = c.getContext('webgl2') || c.getContext('webgl')
      if (!g) return { webgl: false }
      const dbg = g.getExtension('WEBGL_debug_renderer_info')
      return {
        webgl: true,
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
        vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
        version: g.getParameter(g.VERSION),
      }
    })()`)
    if (!gl.webgl) throw new Error('WebGL context unavailable')

    await evaluate(cdp, DRIVER_SOURCE)
    const init = await evaluate(cdp, `window.__TURN_TEST__.init(${JSON.stringify(scale)})`)
    log(`  engine ready in ${Date.now() - bootStart} ms, buffer ${init.stats.buffer.join('x')}, hidden=${init.stats.hidden}`)
    const sanity = await evaluate(cdp, `window.__TURN_TEST__.verifyCapture()`, { awaitPromise: true })
    log(`  sanity capture: litRatio=${sanity.litRatio.toFixed(4)} mean=${sanity.mean.toFixed(2)} png=${sanity.urlLength}B`)
    if (!(sanity.litRatio > 0.005)) {
      throw new Error(`canvas is effectively blank (litRatio=${sanity.litRatio.toFixed(5)})`)
    }
    log(`  renderer: ${gl.renderer}`)
    return {
      cdp,
      child,
      profile,
      version,
      renderer: gl.renderer,
      vendor: gl.vendor,
      glVersion: gl.version,
      mode: config.name,
      httpPort,
      root,
      consoleEvents,
      bootMs: Date.now() - bootStart,
      initial: init,
      sanity,
      close() { bust() },
    }
  } catch (err) {
    bust()
    throw err
  }
}

/* ------------------------------------------------------------------ */
/* plain 2D-canvas browser session used by the GIF composer            */
/* ------------------------------------------------------------------ */

async function bootPlainSession({ httpPort, chrome, config, log, waitMs = 30000 }) {
  const debugPort = await freePort()
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-gif-'))
  const child = spawn(chrome, browserArgs(debugPort, profile, config.args), { stdio: 'ignore', windowsHide: true })
  let cdp = null
  const bust = () => {
    cdp?.close()
    killTree(child)
    removeProfile(profile)
  }
  try {
    await waitForChrome(debugPort)
    const target = await openBlankTarget(debugPort)
    cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    log(`  ${config.name}: loading GIF page`)
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/_gifs` })
    const deadline = Date.now() + waitMs
    let ready = false
    while (Date.now() < deadline) {
      ready = await evaluate(cdp, `document.readyState === 'complete'`).catch(() => false)
      if (ready) break
      await sleep(100)
    }
    if (!ready) throw new Error('GIF page did not load')
    await evaluate(cdp, GIF_PAGE_SOURCE)
    return { cdp, child, profile, mode: config.name, close: bust }
  } catch (err) {
    bust()
    throw err
  }
}

const GIF_PAGE_SOURCE = `(() => {
  const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image failed: ' + url))
    img.src = url
  })
  window.__GIF_COMPOSE__ = {
    async singles(urls, width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      const out = []
      for (const url of urls) {
        const img = await loadImage(url)
        ctx.fillStyle = '#04060c'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        out.push(canvas.toDataURL('image/png'))
      }
      return out
    },
    async pairs(items, width, height) {
      const PAD = 10
      const GAP = 10
      const HEADER = 30
      const W = PAD * 2 + width * 2 + GAP
      const H = HEADER + height
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      const out = []
      for (const item of items) {
        const left = await loadImage(item.left)
        const right = await loadImage(item.right)
        ctx.fillStyle = '#04060c'
        ctx.fillRect(0, 0, W, H)
        ctx.textBaseline = 'top'
        ctx.font = '600 12px ui-sans-serif, "Segoe UI", sans-serif'
        ctx.fillStyle = '#c8efff'
        ctx.fillText(item.leftLabel, PAD, 9)
        ctx.fillStyle = '#ffd9a0'
        ctx.fillText(item.rightLabel, PAD + width + GAP, 9)
        ctx.drawImage(left, PAD, HEADER, width, height)
        ctx.drawImage(right, PAD + width + GAP, HEADER, width, height)
        ctx.fillStyle = 'rgba(110,244,255,0.18)'
        ctx.fillRect(PAD + width + GAP / 2 - 0.5, HEADER, 1, height)
        out.push(canvas.toDataURL('image/png'))
      }
      return out
    },
  }
})()`

async function runGifs(opts, log, overallStart) {
  const baseDir = path.join(SCRATCH, 'frames-baseline')
  const afterDir = path.join(SCRATCH, 'frames-after')
  const baseFiles = fs.existsSync(baseDir) ? (await fsp.readdir(baseDir)).filter((f) => /^frame-\d{3}\.png$/.test(f)) : []
  const afterFiles = fs.existsSync(afterDir) ? (await fsp.readdir(afterDir)).filter((f) => /^frame-\d{3}\.png$/.test(f)) : []
  if (baseFiles.length < 35 || afterFiles.length < 35) {
    throw new Error(`need both frame sets (baseline=${baseFiles.length}, after=${afterFiles.length}); run the baseline and after modes first`)
  }
  const baselineJson = await readJsonSafe(path.join(DESIGN, 'turn-baseline.json'))
  const afterJson = await readJsonSafe(path.join(DESIGN, 'turn-after.json'))
  const baseFrames = baselineJson?.frames || []
  const afterFrames = afterJson?.frames || []

  const { server, port: httpPort } = await startServer(REPO)
  const chromeList = chromeCandidates(opts.chrome)
  if (!chromeList.length) throw new Error('no cached Chromium found; pass --chrome=<path>')
  let session = null
  try {
    for (const chrome of chromeList) {
      for (const config of RENDERER_CONFIGS) {
        try {
          log(`starting ${config.name} for 2D canvas composition`)
          session = await bootPlainSession({ httpPort, chrome, config, log })
          break
        } catch (err) {
          log(`  ${config.name} failed: ${err.message}`)
        }
      }
      if (session) break
    }
    if (!session) throw new Error('could not boot a browser for GIF composition')
    const cdp = session.cdp
    const urlFor = (tag, i) => `http://127.0.0.1:${httpPort}/_scratch/frames-${tag}/frame-${String(i).padStart(3, '0')}.png`
    const beforeUrls = Array.from({ length: 35 }, (_, i) => urlFor('baseline', i))
    const afterUrls = Array.from({ length: 35 }, (_, i) => urlFor('after', i))

    const writeGif = async (pngDataUrls, file, label) => {
      log(`${label}: decoding ${pngDataUrls.length} composed frames`)
      const frames = pngDataUrls.map((url) => decodePng(dataUrlToBuffer(url)))
      let lit = 0
      let sum = 0
      const probe = frames[0]
      for (let i = 0; i < probe.data.length; i += 4) {
        const m = Math.max(probe.data[i], probe.data[i + 1], probe.data[i + 2])
        if (m > 10) lit++
        sum += m
      }
      log(`  frame 0 source check: ${probe.width}x${probe.height} litRatio=${(lit / (probe.width * probe.height)).toFixed(3)} mean=${(sum / (probe.width * probe.height * 4)).toFixed(2)}`)
      log(`${label}: encoding GIF89a (256-color global palette)`)
      const gif = encodeGif(frames, { delayCs: 10 })
      await fsp.writeFile(file, gif)
      const meta = {
        file: path.relative(REPO, file).replaceAll('\\', '/'),
        width: frames[0].width,
        height: frames[0].height,
        frames: frames.length,
        fps: 10,
        loop: true,
        bytes: gif.length,
      }
      log(`  wrote ${meta.file} (${meta.width}x${meta.height}, ${meta.frames} frames, ${(meta.bytes / 1024).toFixed(0)} KB)`)
      return meta
    }

    const beforePngs = await evaluate(cdp, `window.__GIF_COMPOSE__.singles(${JSON.stringify(beforeUrls)}, 480, 480)`, { awaitPromise: true })
    const beforeGif = await writeGif(beforePngs, path.join(DESIGN, 'turn-before.gif'), 'turn-before.gif')
    const afterPngs = await evaluate(cdp, `window.__GIF_COMPOSE__.singles(${JSON.stringify(afterUrls)}, 480, 480)`, { awaitPromise: true })
    const afterGif = await writeGif(afterPngs, path.join(DESIGN, 'turn-after.gif'), 'turn-after.gif')

    const pairItems = Array.from({ length: 35 }, (_, i) => {
      const bf = baseFrames[i] || {}
      const af = afterFrames[i] || {}
      return {
        left: beforeUrls[i],
        right: afterUrls[i],
        leftLabel: `BASELINE · v${baselineJson?.version || '0.9.27'} · t=${Math.round(bf.ms ?? i * 100)} ms · facing ${(bf.facingDeg ?? 0).toFixed(1)}°`,
        rightLabel: `AFTER · v${afterJson?.version || '0.9.28'} · t=${Math.round(af.ms ?? i * 100)} ms · facing ${(af.facingDeg ?? 0).toFixed(1)}°`,
      }
    })
    // Compose in small chunks: each pair loads two 760 px images, and keeping
    // 70 decoded images alive at once can kill the headless renderer.
    const comparePngs = []
    for (let start = 0; start < pairItems.length; start += 5) {
      const chunk = pairItems.slice(start, start + 5)
      const pngs = await evaluate(cdp, `window.__GIF_COMPOSE__.pairs(${JSON.stringify(chunk)}, 480, 480)`, { awaitPromise: true })
      comparePngs.push(...pngs)
    }
    const compareGif = await writeGif(comparePngs, path.join(DESIGN, 'turn-compare.gif'), 'turn-compare.gif')

    // record the GIF metadata next to the MP4 metadata
    const gifs = { before: beforeGif, after: afterGif, compare: compareGif }
    for (const [jsonPath, keys] of [
      [path.join(DESIGN, 'turn-baseline.json'), ['before']],
      [path.join(DESIGN, 'turn-after.json'), ['after', 'compare']],
    ]) {
      const doc = await readJsonSafe(jsonPath)
      if (!doc) continue
      doc.gifs = Object.fromEntries(keys.map((key) => [key, gifs[key]]))
      await fsp.writeFile(jsonPath, JSON.stringify(doc, null, 2) + '\n')
    }
    log(`GIF done in ${((Date.now() - overallStart) / 1000).toFixed(1)} s`)
  } finally {
    session?.close()
    server.close()
  }
}

/* ------------------------------------------------------------------ */
/* baseline worktree + esbuild                                         */
/* ------------------------------------------------------------------ */

function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${res.stderr || res.stdout || ''}`)
  }
  return res
}

function git(cwd, args) {
  return runSync('git', ['-C', cwd, ...args]).stdout.trim()
}

async function ensureBaselineWorktree(log) {
  await fsp.mkdir(SCRATCH, { recursive: true })
  let commit
  if (fs.existsSync(path.join(BASELINE_WT, '.git'))) {
    commit = fs.existsSync(BASELINE_COMMIT_FILE)
      ? (await fsp.readFile(BASELINE_COMMIT_FILE, 'utf8')).trim()
      : git(BASELINE_WT, ['rev-parse', 'HEAD'])
    const actual = git(BASELINE_WT, ['rev-parse', 'HEAD'])
    if (actual !== commit) {
      throw new Error(
        `baseline worktree is at ${actual} but was created from ${commit}; ` +
          `remove ${BASELINE_WT} and ${BASELINE_COMMIT_FILE} to recreate it`,
      )
    }
    log(`baseline worktree: ${BASELINE_WT} @ ${commit.slice(0, 7)}`)
  } else {
    commit = git(REPO, ['rev-parse', 'HEAD'])
    log(`creating baseline worktree at ${BASELINE_WT} from HEAD ${commit.slice(0, 7)}`)
    await fsp.mkdir(path.dirname(BASELINE_WT), { recursive: true })
    git(REPO, ['worktree', 'add', BASELINE_WT, commit, '--detach'])
    await fsp.writeFile(BASELINE_COMMIT_FILE, commit + '\n')
  }
  const modules = path.join(BASELINE_WT, 'node_modules')
  if (!fs.existsSync(modules)) {
    try {
      fs.symlinkSync(path.join(REPO, 'node_modules'), modules, 'junction')
      log('  linked node_modules into worktree (junction)')
    } catch (err) {
      throw new Error(`could not link node_modules into the baseline worktree: ${err.message}`)
    }
  }
  const esbuild = path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (!fs.existsSync(esbuild)) throw new Error(`esbuild not found at ${esbuild}`)
  log('  building demo/bundle.js from worktree src')
  runSync(process.execPath, [
    esbuild,
    'demo/main.js',
    '--bundle',
    '--format=esm',
    '--target=es2022',
    '--outfile=demo/bundle.js',
    '--sourcemap',
  ], { cwd: BASELINE_WT })
  const bundle = path.join(BASELINE_WT, 'demo', 'bundle.js')
  const stat = await fsp.stat(bundle)
  return { root: BASELINE_WT, commit, bundlePath: bundle, bundleSha256: sha256(await fsp.readFile(bundle)), bundleBytes: stat.size }
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function readPackageVersion(root) {
  const pkg = await readJsonSafe(path.join(root, 'package.json'))
  return pkg?.version || null
}

function saveDataUrl(file, dataUrl) {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('not a data URL')
  return fsp.writeFile(file, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
}

function fileToDataUrl(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
}

/* ------------------------------------------------------------------ */
/* minimal PNG decode + GIF89a encode (pure Node, no dependencies)     */
/* ------------------------------------------------------------------ */
// Needed because the bundled Playwright ffmpeg build has no GIF or H.264
// encoder, and the final MP4 cannot be shown inline in the chat. GIFs are
// encoded here from the exact same 480 px canvases that feed the MP4.

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += len + 12
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (depth=${bitDepth} color=${colorType} interlace=${interlace})`)
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[off++]
    const row = raw.subarray(off, off + stride)
    off += stride
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = row[i]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[i] = v
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp
      const di = (y * width + x) * 4
      out[di] = cur[si]
      out[di + 1] = cur[si + 1]
      out[di + 2] = cur[si + 2]
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
    prev = cur
  }
  return { width, height, data: out }
}

/**
 * Global 256-entry palette over all frames, plus a 15-bit RGB -> index LUT.
 * Index 0 is black and 1 is white (labels/background), the rest are the most
 * populous 5-bit color bins.
 */
function buildGifPalette(frames) {
  const counts = new Uint32Array(32768)
  const sums = new Float64Array(32768 * 3)
  for (const frame of frames) {
    const d = frame.data
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]
      const g = d[i + 1]
      const b = d[i + 2]
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      counts[bin]++
      const o = bin * 3
      sums[o] += r
      sums[o + 1] += g
      sums[o + 2] += b
    }
  }
  const palette = new Uint8Array(256 * 3)
  palette[0] = 0
  palette[1] = 0
  palette[2] = 0
  palette[3] = 255
  palette[4] = 255
  palette[5] = 255
  const bins = []
  for (let i = 0; i < 32768; i++) if (counts[i]) bins.push(i)
  bins.sort((a, b) => counts[b] - counts[a])
  let slot = 2
  for (const bin of bins) {
    if (slot >= 256) break
    const n = counts[bin]
    const o = bin * 3
    palette[slot * 3] = Math.round(sums[o] / n)
    palette[slot * 3 + 1] = Math.round(sums[o + 1] / n)
    palette[slot * 3 + 2] = Math.round(sums[o + 2] / n)
    slot++
  }
  const lut = new Uint8Array(32768)
  for (let bin = 0; bin < 32768; bin++) {
    const n = counts[bin]
    const r = n ? sums[bin * 3] / n : (((bin >> 10) & 31) << 3) + 4
    const g = n ? sums[bin * 3 + 1] / n : (((bin >> 5) & 31) << 3) + 4
    const b = n ? sums[bin * 3 + 2] / n : ((bin & 31) << 3) + 4
    let best = 0
    let bestD = Infinity
    for (let p = 0; p < 256; p++) {
      const dr = r - palette[p * 3]
      const dg = g - palette[p * 3 + 1]
      const db = b - palette[p * 3 + 2]
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestD) {
        bestD = dist
        best = p
      }
    }
    lut[bin] = best
  }
  return { palette, lut }
}

function gifLzw(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  const dict = new Int32Array(1 << 20)
  dict.fill(-1)
  let nextCode = endCode + 1
  let codeSize = minCodeSize + 1
  const out = []
  let acc = 0
  let bits = 0
  const emit = (code, size) => {
    acc |= code << bits
    bits += size
    while (bits >= 8) {
      out.push(acc & 255)
      acc >>>= 8
      bits -= 8
    }
  }
  emit(clearCode, codeSize)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const pixel = indices[i]
    const key = (prefix << 8) | pixel
    const found = dict[key]
    if (found >= 0) {
      prefix = found
      continue
    }
    emit(prefix, codeSize)
    if (nextCode < 4096) {
      dict[key] = nextCode++
      // The decoder's table is one entry behind the encoder's while it reads:
      // it only grows after consuming the code we just emitted, so switch one
      // step later than a naive equality check would.
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize++
    } else {
      emit(clearCode, codeSize)
      dict.fill(-1)
      nextCode = endCode + 1
      codeSize = minCodeSize + 1
    }
    prefix = pixel
  }
  emit(prefix, codeSize)
  emit(endCode, codeSize)
  if (bits > 0) out.push(acc & 255)
  const blocks = [Buffer.from([minCodeSize])]
  for (let i = 0; i < out.length; i += 255) {
    const slice = out.slice(i, i + 255)
    blocks.push(Buffer.from([slice.length]), Buffer.from(slice))
  }
  blocks.push(Buffer.from([0]))
  return Buffer.concat(blocks)
}

/** Encode decoded RGBA frames as an infinitely looping GIF89a. */
function encodeGif(frames, { delayCs = 10 } = {}) {
  const width = frames[0].width
  const height = frames[0].height
  const { palette, lut } = buildGifPalette(frames)
  const parts = [Buffer.from('GIF89a', 'ascii')]
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0xf7 // global color table, 256 entries
  parts.push(screen, Buffer.from(palette))
  parts.push(
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  )
  for (const frame of frames) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, delayCs & 255, (delayCs >> 8) & 255, 0x00, 0x00]))
    const descriptor = Buffer.alloc(10)
    descriptor[0] = 0x2c
    descriptor.writeUInt16LE(0, 1)
    descriptor.writeUInt16LE(0, 3)
    descriptor.writeUInt16LE(width, 5)
    descriptor.writeUInt16LE(height, 7)
    descriptor[9] = 0
    parts.push(descriptor)
    const indices = new Uint8Array(width * height)
    const d = frame.data
    for (let i = 0; i < indices.length; i++) {
      const o = i * 4
      indices[i] = lut[((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3)]
    }
    parts.push(gifLzw(indices))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

function dataUrlToBuffer(url) {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('not a data URL')
  return Buffer.from(url.slice(comma + 1), 'base64')
}

/* ------------------------------------------------------------------ */
/* video recording note                                                */
/* ------------------------------------------------------------------ */
// The ffmpeg that ships with the Playwright cache is a stripped build with only
// the VP8 encoder + WebM muxer (no PNG decoder, no H.264, no image2 demuxer),
// so it cannot encode our PNG sequence. Instead the page records the frames
// through MediaRecorder (Chrome's H.264/MP4 encoder is available headless) and
// hands the MP4 back as base64. See recordCanvas() in the page driver.


function classifyConsole(events) {
  const seen = new Map()
  for (const e of events) {
    const key = `${e.source}\u0000${e.level}\u0000${e.text}`
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  const errors = []
  const warnings = []
  for (const [key, count] of seen) {
    const [source, level, text] = key.split('\u0000')
    const entry = { source, level, text, count }
    if (level === 'error' || source === 'exception') errors.push(entry)
    else if (level === 'warning' || level === 'warn') warnings.push(entry)
  }
  return { errors, warnings, total: events.length }
}

/* ------------------------------------------------------------------ */
/* turn capture orchestration                                          */
/* ------------------------------------------------------------------ */

function selectNearestStep(planFacing, targetDeg) {
  let bestStep = 1
  let bestErr = Infinity
  for (let k = 0; k < planFacing.length; k++) {
    const step = k + 1
    const err = Math.abs(planFacing[k] * DEG - targetDeg)
    if (err < bestErr) {
      bestErr = err
      bestStep = step
    }
  }
  return { step: bestStep, errorDeg: bestErr }
}

async function captureTurn(session, opts) {
  const { tag, label, angleTargets, log } = opts
  const { cdp } = session

  log('settling facing at 0 for 2.5 s (deterministic steps)')
  const settled = await evaluate(cdp, `window.__TURN_TEST__.settle(150)`)
  if (Math.abs(settled.facing) > 1e-3) log(`  note: settled facing = ${settled.facing}`)

  log('planning the 2.0 s planned turn (no rendering)')
  const plan = await evaluate(cdp, `window.__TURN_TEST__.planTurn()`)
  const planDeg = plan.facing.map((f) => f * DEG)
  const finalDeg = planDeg[planDeg.length - 1]
  const at90 = planDeg.findIndex((d) => d >= 90)
  const at180 = planDeg.findIndex((d) => d >= 179.5)
  log(`  facing: 90° after ${at90 >= 0 ? Math.round((at90 + 1) * DT_MS) : 'n/a'} ms, ` +
      `179.5° after ${at180 >= 0 ? Math.round((at180 + 1) * DT_MS) : 'n/a'} ms, final ${finalDeg.toFixed(2)}°`)

  const sampleSteps = []
  for (let step = 0; step <= plan.steps; step += 6) sampleSteps.push(step)
  const keyframes = []
  for (const angle of [45, 90, 135]) {
    const targetDeg = angleTargets?.[angle] ?? angle
    const near = selectNearestStep(plan.facing, targetDeg)
    keyframes.push({ angle, targetDeg, step: near.step, planFacingDeg: planDeg[near.step - 1], planErrorDeg: near.errorDeg })
  }
  const captureSteps = [...new Set([...sampleSteps, ...keyframes.map((k) => k.step)])].sort((a, b) => a - b)
  log(`  capture steps: ${captureSteps.length} (${sampleSteps.length} filmstrip + ${keyframes.length} keyframes)`)
  for (const k of keyframes) {
    log(`  keyframe ~${k.angle}° -> step ${k.step} (${Math.round(k.step * DT_MS)} ms, planned ${k.planFacingDeg.toFixed(2)}°)`)
  }

  log('resetting to facing 0 and replaying the turn with renders on capture steps')
  await evaluate(cdp, `window.__TURN_TEST__.resetToFront()`)
  const run = await evaluate(cdp, `window.__TURN_TEST__.runCaptures(${JSON.stringify(captureSteps)})`)
  log(`  captured ${run.captured.length} frames in ${(run.wallMs / 1000).toFixed(2)} s ` +
      `(mean render ${Math.round(run.captured.reduce((s, c) => s + c.captureMs, 0) / run.captured.length)} ms)`)

  log('analyzing pixels, composing filmstrip')
  await evaluate(cdp, `window.__TURN_TEST__.filmstripTitle = ${JSON.stringify(label + ' · planned 2.0 s turn · 60 Hz deterministic sim · one frame per 100 ms')}`)
  const analysis = await evaluate(cdp, `window.__TURN_TEST__.analyzeSamples(${JSON.stringify(sampleSteps)})`, { awaitPromise: true })
  const frameMeta = run.captured.filter((c) => sampleSteps.includes(c.step))
  const byStep = new Map(frameMeta.map((c) => [c.step, c]))
  const perStep = new Map(analysis.perFrame.map((p) => [p.step, p]))
  const frames = sampleSteps.map((step, i) => {
    const meta = byStep.get(step)
    const stats = perStep.get(step)
    return {
      i,
      step,
      ms: round(meta.ms, 2),
      facing: round(meta.facing, 5),
      facingDeg: round(meta.facing * DEG, 3),
      lag: meta.lag == null ? null : round(meta.lag, 5),
      brace: meta.brace == null ? null : round(meta.brace, 4),
      litRatio: round(stats.litRatio, 4),
      diffPrev: round(stats.diffPrev, 3),
      diffFirst: round(stats.diffFirst, 3),
    }
  })

  const filmstripFile = path.join(DESIGN, `turn-filmstrip-${tag}.png`)
  await saveDataUrl(filmstripFile, analysis.filmstrip)
  log(`  wrote ${path.relative(REPO, filmstripFile)} (${analysis.width}x${analysis.height})`)

  const keyframeResults = []
  for (const k of keyframes) {
    const fr = await evaluate(cdp, `window.__TURN_TEST__.getFrame(${JSON.stringify(k.step)})`)
    if (!fr) throw new Error(`missing keyframe capture at step ${k.step}`)
    const file = path.join(DESIGN, `turn-keyframe-${k.angle}-${tag}.png`)
    await saveDataUrl(file, fr.url)
    const lit = await evaluate(cdp, `window.__TURN_TEST__.measureFrame(${JSON.stringify(k.step)})`, { awaitPromise: true })
    keyframeResults.push({
      angle: k.angle,
      targetDeg: round(k.targetDeg, 3),
      step: fr.step,
      ms: round(fr.ms, 2),
      facing: round(fr.facing, 5),
      facingDeg: round(fr.facing * DEG, 3),
      planFacingDeg: round(k.planFacingDeg, 3),
      lag: fr.lag == null ? null : round(fr.lag, 5),
      brace: fr.brace == null ? null : round(fr.brace, 4),
      litRatio: lit == null ? null : round(lit, 4),
      file: path.basename(file),
      dataUrl: fr.url,
    })
    log(`  wrote ${path.relative(REPO, file)} (facing ${(fr.facing * DEG).toFixed(2)}°, target ${k.angle}°)`)
  }

  // Keep the 35 individual frames so ffmpeg can encode the mp4 and so the
  // after run can compose the synchronized side-by-side video.
  const framesDir = path.join(SCRATCH, `frames-${tag}`)
  await fsp.rm(framesDir, { recursive: true, force: true })
  await fsp.mkdir(framesDir, { recursive: true })
  for (let i = 0; i < sampleSteps.length; i++) {
    const fr = await evaluate(cdp, `window.__TURN_TEST__.getFrame(${JSON.stringify(sampleSteps[i])})`)
    if (!fr) throw new Error(`missing filmstrip frame at step ${sampleSteps[i]}`)
    await saveDataUrl(path.join(framesDir, `frame-${String(i).padStart(3, '0')}.png`), fr.url)
  }
  log(`  wrote ${sampleSteps.length} frames to ${path.relative(WORKSPACE, framesDir)} (for mp4 encoding)`)

  // The visible body yaw keeps damped-rotating after the 2.0 s target lands, so
  // the lag drains later than the target does. Keep simulating (cheaply, no
  // renders) past the filmed window so the lag series shows the full settle.
  let lagTail = null
  if (tag === 'after' && plan.lagSupported) {
    lagTail = await evaluate(cdp, `window.__TURN_TEST__.recordLagTail(180)`)
    const last = lagTail[lagTail.length - 1]
    log(`  simulated lag tail to ${Math.round(last.ms)} ms (no frames, settles the spring)`)
  }

  return { frames, keyframes: keyframeResults, filmstrip: analysis, plan, planDeg, run, settled, finalDeg, at90, at180, sampleSteps, framesDir, lagTail }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { mode: null, scale: 1, chrome: null, keepTemp: false, help: false, debugDecode: null }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === 'baseline' || arg === 'after' || arg === 'gifs') opts.mode = arg
    else if (arg.startsWith('--debug-decode=')) opts.debugDecode = arg.slice(15)
    else if (arg.startsWith('--scale=')) opts.scale = Number(arg.slice(8))
    else if (arg.startsWith('--chrome=')) opts.chrome = arg.slice(9)
    else if (arg === '--keep-temp') opts.keepTemp = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const USAGE = `Usage:
  node scripts/capture-turn.mjs baseline [--scale=1] [--chrome=<path>]
  node scripts/capture-turn.mjs after    [--scale=1] [--chrome=<path>]
  node scripts/capture-turn.mjs gifs

baseline  builds demo/bundle.js from git HEAD inside .scratch-verify/baseline
          (worktree, node_modules junction) and writes the v0.9.27 evidence.
after     serves the current working tree (demo/bundle.js must already be
          rebuilt with \`npm run build:demo\`) and writes the v0.9.28 evidence
          plus baseline/after comparison images, videos and the lag series.
gifs      re-encodes the frames already stored in .scratch-verify/frames-* as
          inline-viewable looping GIFs (turn-before/after/compare.gif).`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.mode && !opts.debugDecode)) {
    console.log(USAGE)
    process.exitCode = opts.mode ? 0 : 1
    return
  }
  if (!Number.isFinite(opts.scale) || opts.scale < 0.2 || opts.scale > 2) throw new Error('--scale must be 0.2..2')
  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
  const overallStart = Date.now()

  await fsp.mkdir(DESIGN, { recursive: true })

  if (opts.debugDecode) {
    const png = decodePng(await fsp.readFile(opts.debugDecode))
    let lit = 0
    let sum = 0
    for (let i = 0; i < png.data.length; i += 4) {
      const m = Math.max(png.data[i], png.data[i + 1], png.data[i + 2])
      if (m > 10) lit++
      sum += m
    }
    console.log(JSON.stringify({ file: opts.debugDecode, width: png.width, height: png.height, litRatio: lit / (png.width * png.height), mean: sum / (png.width * png.height * 4) }))
    return
  }

  if (opts.mode === 'gifs') {
    await runGifs(opts, log, overallStart)
    return
  }

  const baselineInfo = opts.mode === 'baseline' ? await ensureBaselineWorktree(log) : null
  const root = baselineInfo ? baselineInfo.root : REPO
  const tag = opts.mode
  const version = await readPackageVersion(root)
  const bundlePath = path.join(root, 'demo', 'bundle.js')
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`${path.relative(REPO, bundlePath)} missing — run \`npm run build:demo\` first`)
  }
  const bundleSha256 = sha256(await fsp.readFile(bundlePath))
  const bundleBytes = (await fsp.stat(bundlePath)).size
  const gitHead = (() => {
    try { return git(root, ['rev-parse', 'HEAD']) } catch { return null }
  })()
  const gitStatus = (() => {
    try { return git(root, ['status', '--porcelain']) } catch { return '' }
  })()
  const baselineJsonPath = path.join(DESIGN, 'turn-baseline.json')
  const baselineJson = opts.mode === 'after' ? await readJsonSafe(baselineJsonPath) : null

  const angleTargets = {}
  if (opts.mode === 'after') {
    if (!baselineJson) {
      log('WARNING: design/turn-baseline.json not found — keyframes use nominal 45/90/135° and no compare images are produced')
    } else {
      for (const k of baselineJson.keyframes || []) {
        if (typeof k.facingDeg === 'number') angleTargets[k.angle] = k.facingDeg
      }
      log(`baseline keyframe angles: ${Object.entries(angleTargets).map(([a, d]) => `${a}°->${d.toFixed(2)}°`).join(', ')}`)
      if (baselineJson.bundle?.sha256 === bundleSha256) {
        log('WARNING: current demo/bundle.js is byte-identical to the baseline bundle — did you run `npm run build:demo`?')
      }
    }
  }

  log(`mode=${tag} version=${version} root=${root}`)
  log(`bundle ${path.relative(REPO, bundlePath) || 'demo/bundle.js'} sha256=${bundleSha256.slice(0, 16)} bytes=${bundleBytes}`)

  const { server, port: httpPort } = await startServer(root)
  const chromeList = chromeCandidates(opts.chrome)
  if (!chromeList.length) throw new Error('no cached Chromium found; pass --chrome=<path>')
  let session = null
  try {
    let lastErr = null
    for (const chrome of chromeList) {
      for (const config of RENDERER_CONFIGS) {
        log(`trying ${config.name} (${path.basename(path.dirname(path.dirname(chrome)))}) — ${config.why}`)
        try {
          session = await bootSession({
            root,
            httpPort,
            chrome,
            config,
            scale: opts.scale,
            waitMs: 120000,
            log,
          })
          break
        } catch (err) {
          lastErr = err
          log(`  ${config.name} failed: ${err.message}`)
        }
      }
      if (session) break
    }
    if (!session) throw lastErr || new Error('could not boot a WebGL-capable headless Chromium')
    const cdp = session.cdp

    const label = `${tag === 'baseline' ? 'BASELINE' : 'AFTER'} · v${version}`
    const cap = await captureTurn(session, { tag, label, angleTargets, log })

    const consoleSummary = classifyConsole(session.consoleEvents)
    const keyframeEntries = cap.keyframes.map(({ dataUrl, ...rest }) => rest)
    const videos = {}

    /* ---------------- videos (10 fps, MP4 via MediaRecorder) ---------------- */
    const saveVideo = async (result, baseName) => {
      const ext = result.mime.includes('mp4') ? '.mp4' : '.webm'
      const file = path.join(DESIGN, baseName + ext)
      await fsp.writeFile(file, Buffer.from(result.base64, 'base64'))
      const meta = {
        file: path.relative(REPO, file).replaceAll('\\', '/'),
        mime: result.mime,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        durationSec: round(result.durationSec, 2),
        fps: 10,
      }
      log(`  wrote ${meta.file} (${meta.mime}, ${meta.width}x${meta.height}, ${meta.durationSec}s, ${(meta.bytes / 1024).toFixed(0)} KB)`)
      return meta
    }
    try {
      if (tag === 'baseline') {
        log('recording 10 fps MP4 of the baseline frames')
        const vid = await evaluate(cdp, `window.__TURN_TEST__.recordFilmstripVideo(${JSON.stringify(cap.sampleSteps)}, 10)`, { awaitPromise: true })
        videos.before = await saveVideo(vid, 'turn-before')
      } else {
        log('recording 10 fps MP4 of the after frames')
        const vid = await evaluate(cdp, `window.__TURN_TEST__.recordFilmstripVideo(${JSON.stringify(cap.sampleSteps)}, 10)`, { awaitPromise: true })
        videos.after = await saveVideo(vid, 'turn-after')

        const baseFramesDir = path.join(SCRATCH, 'frames-baseline')
        const baseFiles = fs.existsSync(baseFramesDir)
          ? (await fsp.readdir(baseFramesDir)).filter((f) => /^frame-\d{3}\.png$/.test(f))
          : []
        if (baseFiles.length >= cap.frames.length) {
          const pairs = cap.frames.map((f, i) => {
            const bf = baselineJson?.frames?.[i] || {}
            return {
              leftUrl: `http://127.0.0.1:${session.httpPort}/_scratch/frames-baseline/frame-${String(i).padStart(3, '0')}.png`,
              rightStep: cap.sampleSteps[i],
              leftLabel: `BASELINE · v${baselineJson?.version || '0.9.27'} · t=${Math.round(bf.ms ?? f.ms)} ms · facing ${(bf.facingDeg ?? 0).toFixed(1)}°`,
              rightLabel: `AFTER · v${version} · t=${Math.round(f.ms)} ms · facing ${f.facingDeg.toFixed(1)}°`,
            }
          })
          log('recording 10 fps MP4 of baseline | after pairs')
          const pairVid = await evaluate(cdp, `window.__TURN_TEST__.recordPairVideo(${JSON.stringify(pairs)}, 10)`, { awaitPromise: true })
          videos.compare = await saveVideo(pairVid, 'turn-compare')
        } else {
          log(`WARNING: only ${baseFiles.length} baseline frames in ${path.relative(WORKSPACE, baseFramesDir)} — rerun the baseline mode before the compare video`)
        }
      }
    } catch (err) {
      log('WARNING: video recording failed: ' + err.message)
    }

    /* ---------------- keyframe comparison images + pixel stats (after) ---------------- */
    if (opts.mode === 'after' && baselineJson) {
      for (let idx = 0; idx < cap.keyframes.length; idx++) {
        const k = cap.keyframes[idx]
        const base = (baselineJson.keyframes || []).find((b) => b.angle === k.angle)
        if (!base) continue
        const baseFile = path.join(DESIGN, base.file)
        if (!fs.existsSync(baseFile)) {
          log(`  compare ${k.angle}°: baseline image ${base.file} missing — skipped`)
          continue
        }
        const baseUrl = fileToDataUrl(baseFile)
        const composed = await evaluate(cdp, `window.__TURN_TEST__.composeCompare(${JSON.stringify({
          leftUrl: baseUrl,
          rightUrl: k.dataUrl,
          leftLabel: `BASELINE · v${baselineJson.version} · facing ${base.facingDeg.toFixed(2)}°`,
          rightLabel: `AFTER · v${version} · facing ${k.facingDeg.toFixed(2)}°`,
          diffLabel: 'DIFF ×6 (baseline − after)',
          leftInfo: `facing ${base.facingDeg.toFixed(2)}° @ ${Math.round(base.ms)} ms`,
          rightInfo: `facing ${k.facingDeg.toFixed(2)}° @ ${Math.round(k.ms)} ms`,
          note: 'same zoom / deterministic 60 Hz virtual timeline',
        })})`, { awaitPromise: true })
        const outFile = path.join(DESIGN, `turn-compare-${k.angle}.png`)
        await saveDataUrl(outFile, composed.url)
        log(`wrote ${path.relative(REPO, outFile)} (${composed.width}x${composed.height})`)

        const stats = await evaluate(cdp, `window.__TURN_TEST__.analyzePair(${JSON.stringify({ leftUrl: baseUrl, rightUrl: k.dataUrl })})`, { awaitPromise: true })
        keyframeEntries[idx].compare = {
          facingDeltaDeg: round(k.facingDeg - base.facingDeg, 3),
          file: path.relative(DESIGN, outFile).replaceAll('\\', '/'),
          stats,
        }
      }
    }

    /* ---------------- lag summary ---------------- */
    let lagSummary = null
    let lagSeries = null
    if (opts.mode === 'after' && cap.plan.lagSupported) {
      lagSeries = cap.plan.lags.map((lag, i) => ({
        ms: round((i + 1) * DT_MS, 2),
        facing: round(cap.plan.facing[i], 5),
        facingDeg: round(cap.planDeg[i], 3),
        lag: lag == null ? null : round(lag, 5),
        brace: cap.plan.braces[i] == null ? null : round(cap.plan.braces[i], 4),
      }))
      if (cap.lagTail) {
        for (const entry of cap.lagTail) {
          lagSeries.push({
            ms: round(entry.ms, 2),
            facing: round(entry.facing, 5),
            facingDeg: round(entry.facing * DEG, 3),
            lag: entry.lag == null ? null : round(entry.lag, 5),
            brace: entry.brace == null ? null : round(entry.brace, 4),
          })
        }
      }
      const finite = lagSeries.filter((s) => s.lag != null)
      const peak = finite.reduce((a, b) => (b.lag < a.lag ? b : a), finite[0])
      const stop = finite.reduce((a, b) => (Math.abs(b.ms - 2000) < Math.abs(a.ms - 2000) ? b : a), finite[0])
      const post = finite.filter((s) => s.ms > 2000)
      const overshoot = post.reduce((a, b) => (b.lag > a.lag ? b : a), post[0] || stop)
      const zeroCross = post.find((s) => s.lag >= 0) || null
      const converged = post.find((s) => Math.abs(s.lag) < 0.01) || null
      const plateau = finite.filter((s) => s.ms >= 400 && s.ms <= 1600)
      const plateauAbs = plateau.map((s) => Math.abs(s.lag))
      const braceVals = lagSeries.map((s) => s.brace).filter((b) => b != null)
      lagSummary = {
        note:
          'The 2.0 s target finishes while the body yaw is still damped-rotating (yaw lambda=2.6), ' +
          'so the lag drains after 2.0 s. The series continues past the filmed 3.4 s window (simulation only) to show the full settle.',
        peakLag: round(peak.lag, 5),
        peakAtMs: round(peak.ms, 1),
        lagAtStop: round(stop.lag, 5),
        lagAtStopMs: round(stop.ms, 1),
        overshootLag: round(overshoot.lag, 5),
        overshootAtMs: round(overshoot.ms, 1),
        zeroCrossAtMs: zeroCross ? round(zeroCross.ms, 1) : null,
        convergedUnder001AtMs: converged ? round(converged.ms, 1) : null,
        simulatedTailToMs: Math.round(finite[finite.length - 1].ms),
        plateau400_1600: {
          meanAbsLag: round(plateauAbs.reduce((a, b) => a + b, 0) / Math.max(1, plateauAbs.length), 5),
          minAbsLag: round(Math.min(...plateauAbs), 5),
          maxAbsLag: round(Math.max(...plateauAbs), 5),
        },
        bracePeak: braceVals.length ? round(Math.max(...braceVals), 4) : null,
      }
      log(`lag summary: peak ${lagSummary.peakLag} rad @ ${lagSummary.peakAtMs} ms, at 2.0 s ${lagSummary.lagAtStop} rad, ` +
          `zero at ${lagSummary.zeroCrossAtMs ?? 'not in window'} ms, convergence <0.01 rad @ ${lagSummary.convergedUnder001AtMs ?? 'not in window'} ms, ` +
          `brace peak ${lagSummary.bracePeak}`)
    }

    /* ---------------- report JSON ---------------- */
    const output = {
      tag,
      label,
      version,
      generatedAt: new Date().toISOString(),
      gitHead,
      gitDirty: Boolean(gitStatus),
      bundle: { path: path.relative(REPO, bundlePath).replaceAll('\\', '/'), sha256: bundleSha256, bytes: bundleBytes },
      baselineWorktree: baselineInfo ? { commit: baselineInfo.commit, dir: path.relative(WORKSPACE, baselineInfo.root).replaceAll('\\', '/') } : null,
      browser: {
        product: session.version.Browser,
        mode: session.mode,
        webglRenderer: session.renderer,
        webglVendor: session.vendor,
        webglVersion: session.glVersion,
        userAgent: session.version['User-Agent'],
      },
      protocol: {
        note:
          'requestAnimationFrame is replaced by a deterministic stepper before page scripts run; ' +
          'each step is exactly 16.667 ms of simulation and PNG read-back cost never advances the clock. ' +
          'Target facing advances over 2.0 s with a smoothstep, updated every 5 steps (~83 ms, 25 updates); ' +
          'the run keeps simulating 1.4 s after the turn stops. Filmstrip frames are every 6 steps (100 ms). ' +
          'Math.random is seeded so autonomous micro-actions are identical between the baseline and after runs.',
        dtMs: round(DT_MS, 4),
        turnMs: 2000,
        holdMs: 1400,
        targetUpdateEverySteps: 5,
        sampleEverySteps: 6,
        settleSteps: 150,
        totalStepsPlanned: cap.plan.steps,
        framesCaptured: cap.run.captured.length,
        filmstripFrames: cap.frames.length,
        renderScale: opts.scale,
        capturePhaseWallMs: Math.round(cap.run.wallMs),
        videoFps: 10,
      },
      viewport: {
        buffer: session.initial.stats.buffer,
        css: session.initial.stats.css,
        dpr: session.initial.stats.dpr,
        hidden: session.initial.stats.hidden,
      },
      sanity: {
        litRatio: round(session.sanity.litRatio, 4),
        meanChannel: round(session.sanity.mean, 3),
        settledFacing: round(cap.settled.facing, 6),
        firstFrameMs: round(session.initial.stats.firstFrameMs, 1),
        bootMs: session.bootMs,
      },
      timeline: {
        facing90AtMs: cap.at90 >= 0 ? Math.round((cap.at90 + 1) * DT_MS) : null,
        facing179_5AtMs: cap.at180 >= 0 ? Math.round((cap.at180 + 1) * DT_MS) : null,
        finalFacingDeg: round(cap.finalDeg, 3),
      },
      frames: cap.frames,
      keyframes: keyframeEntries,
      plan: cap.planDeg.map((deg, i) => ({ ms: round((i + 1) * DT_MS, 2), facingDeg: round(deg, 3) })),
      lagSummary,
      videos,
      console: consoleSummary,
      totalWallMs: Date.now() - overallStart,
    }
    const jsonPath = path.join(DESIGN, `turn-${tag}.json`)
    await fsp.writeFile(jsonPath, JSON.stringify(output, null, 2) + '\n')
    log(`wrote ${path.relative(REPO, jsonPath)}`)

    if (lagSeries) {
      const lagPath = path.join(DESIGN, 'turn-lag-series.json')
      await fsp.writeFile(lagPath, JSON.stringify(lagSeries, null, 2) + '\n')
      log(`wrote ${path.relative(REPO, lagPath)} (${lagSeries.length} samples)`)
    } else if (opts.mode === 'after') {
      log('WARNING: octopus.getTurnLag() is not available; skipped turn-lag-series.json')
    }

    /* ---------------- final report ---------------- */
    log('')
    log(`=== ${tag.toUpperCase()} SUMMARY ===`)
    log(`version ${version} · bundle ${bundleSha256.slice(0, 12)} · ${session.mode} · ${session.renderer}`)
    log(`captured ${cap.run.captured.length} frames / ${cap.frames.length} filmstrip frames, ` +
        `${(cap.run.wallMs / 1000).toFixed(2)} s render, ${((Date.now() - overallStart) / 1000).toFixed(1)} s total`)
    log(`facing timeline: 90° @ ${output.timeline.facing90AtMs ?? '?'} ms, 179.5° @ ${output.timeline.facing179_5AtMs ?? '?'} ms, final ${output.timeline.finalFacingDeg}°`)
    if (opts.mode === 'after' && cap.plan.lagSupported && lagSummary) {
      log(`lag: peak ${lagSummary.peakLag} rad @ ${lagSummary.peakAtMs} ms, at 2.0 s ${lagSummary.lagAtStop} rad, ` +
          `overshoot ${lagSummary.overshootLag} rad @ ${lagSummary.overshootAtMs} ms, <0.01 rad @ ${lagSummary.convergedUnder001AtMs ?? 'n/a'} ms, ` +
          `brace peak ${lagSummary.bracePeak}`)
    }
    for (const k of keyframeEntries) {
      if (!k.compare) continue
      const s = k.compare.stats
      log(`compare ${k.angle}°: facing Δ${k.compare.facingDeltaDeg.toFixed(2)}°, ` +
          `meanDiff ${s.meanDiffLit} (lit), mantle core ${s.regions.mantleCore.meanDiff} ` +
          `(${s.regions.mantleCore.energySharePct}% energy), tentacles ${s.regions.tentaclesAll.meanDiff} ` +
          `(${s.regions.tentaclesAll.energySharePct}% energy), bright diff ${s.bright.direction} ` +
          `offset ${s.bright.offsetFromBody.join(',')} px`)
    }
    const errs = consoleSummary.errors
    const warns = consoleSummary.warnings
    log(`console: ${errs.length} error group(s), ${warns.length} warning group(s)`)
    for (const e of errs.slice(0, 6)) log(`  ERROR ${e.source}/${e.level} x${e.count}: ${e.text}`)
    for (const w of warns.slice(0, 6)) log(`  WARN  ${w.source}/${w.level} x${w.count}: ${w.text}`)
    log(`done in ${((Date.now() - overallStart) / 1000).toFixed(1)} s`)
  } finally {
    session?.close()
    server.close()
    if (session?.profile && !opts.keepTemp) await removeProfile(session.profile)
  }
}

main().catch((err) => {
  console.error('capture-turn FAILED:', err?.stack || err)
  process.exitCode = 1
})
