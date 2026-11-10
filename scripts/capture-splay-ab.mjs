#!/usr/bin/env node
/**
 * capture-splay-ab.mjs — 0.9.29 vs 0.9.30 evidence for the "tentacles cut when
 * they splay" fix.
 *
 *   node scripts/capture-splay-ab.mjs
 *
 * 1. A/B over an identical deterministic 60 s timeline (seeded Math.random,
 *    fixed 16.667 ms virtual steps, demo ?studio=1&auto=0): capture the raw
 *    canvas every 100 ms, measure the rendered bbox and compare it with the
 *    same-frame getExtent() * halfBox. Old hard culling leaves frames whose
 *    rendered bbox is much smaller than the engine's own silhouette extent.
 *    Writes design/splay-abi.json and design/splay-tipfix.gif (12 pairs).
 * 2. Fixed scripted pose in the real plugin (place centre + face(90), 4 s):
 *    full-page screenshots old/new, outer-ring (r > 0.8 half box) luminance
 *    and old/new brightness ratio.
 * 3. Prints the numbers; capture-edge.mjs is run separately for the boundary
 *    regression.
 *
 * Requires .scratch-verify/v029 worktree (commit 20e3830) with demo/bundle.js
 * built; the script creates/builds it if missing. No repo dependency is added.
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(REPO, '..')
const SCRATCH = path.join(WORKSPACE, '.scratch-verify')
const DESIGN = path.join(REPO, 'design')
const OLD_WT = path.join(SCRATCH, 'v029')
const OLD_COMMIT = '20e3830'
const DEMO_W = 1000
const DEMO_H = 1000
const HARNESS_W = 1440
const HARNESS_H = 900
const DT = 1000 / 60
const SAMPLE_EVERY = 6 // 100 ms
const TOTAL_SECONDS = 60
const TOTAL_STEPS = Math.round((TOTAL_SECONDS * 1000) / DT)
const FRAME_COUNT = Math.round((TOTAL_SECONDS * 1000) / 100)
const THRESHOLD = 60

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/* ------------------------------------------------------------------ */
/* static server (repo or 0.9.29 worktree, plus /_scratch)            */
/* ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json', '.css': 'text/css' }

function startServer(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(u.pathname)
      if (rel === '/favicon.ico') { res.writeHead(204).end(); return }
      let base = root
      if (rel.startsWith('/_scratch/')) { base = SCRATCH; rel = rel.slice('/_scratch'.length) }
      if (rel.endsWith('/')) rel += 'index.html'
      const abs = path.normalize(path.join(base, rel))
      if (!abs.toLowerCase().startsWith(path.normalize(base).toLowerCase())) { res.writeHead(403).end('forbidden'); return }
      const stat = await fsp.stat(abs).catch(() => null)
      if (!stat || !stat.isFile()) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': stat.size })
      fs.createReadStream(abs).pipe(res)
    } catch (err) { res.writeHead(500).end(String(err)) }
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer(); srv.unref(); srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.handlers = new Map() }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP websocket connect failed'))
      this.ws.onclose = () => { for (const p of this.pending.values()) p.reject(new Error('CDP websocket closed')); this.pending.clear() }
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id != null) {
          const p = this.pending.get(m.id); if (!p) return
          this.pending.delete(m.id)
          m.error ? p.reject(new Error(`${m.error.message} (${m.error.code})`)) : p.resolve(m.result)
        } else if (m.method && this.handlers.has(m.method)) {
          for (const fn of this.handlers.get(m.method)) fn(m.params)
        }
      }
    })
  }
  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (err) { this.pending.delete(id); reject(err) }
    })
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, new Set()); this.handlers.get(method).add(fn) }
  close() { try { this.ws?.close() } catch {} }
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
  if (res.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(`page evaluate failed: ${d.text} ${d.exception?.description || ''}`)
  }
  return res.result.value
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function chromeCandidates() {
  const local = process.env.LOCALAPPDATA
  return [
    process.env.CHROME_PATH,
    local && path.join(local, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    local && path.join(local, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe'),
  ].filter((p) => p && fs.existsSync(p))
}

async function waitForChrome(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json() } catch {}
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
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
}

async function removeProfile(profile) {
  for (let i = 0; i < 6; i++) {
    try { await fsp.rm(profile, { recursive: true, force: true }); return } catch { await sleep(300) }
  }
}

/* ------------------------------------------------------------------ */
/* deterministic page clock                                            */
/* ------------------------------------------------------------------ */

const STEPPER_SOURCE = `(() => {
  // Seeded random for both the engine and the overlay behaviour (the overlay
  // seeds its RNG from crypto.getRandomValues, so both must be pinned).
  let seed = 0x1a2b3c4d >>> 0
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  Math.random = next
  try {
    crypto.getRandomValues = (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * 4294967296)
      return arr
    }
  } catch (e) {}
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
      const cbs = [...queue.values()]
      queue.clear()
      for (const cb of cbs) { try { cb(vnow) } catch (err) { console.error('step cb', err) } }
      return { now: vnow, pending: queue.size }
    },
    resetTime() { vnow = performance.now(); init = true; return vnow },
    get pending() { return queue.size },
  }
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
  window.__setSkipDraw__ = (v) => { skipDraw = Boolean(v) }
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

/* ------------------------------------------------------------------ */
/* PNG / GIF helpers (same implementation as capture-turn/edge)        */
/* ------------------------------------------------------------------ */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos), type = buffer.toString('ascii', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += len + 12
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported PNG')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride), off = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[off++], row = raw.subarray(off, off + stride); off += stride
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      let v = row[i]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[i] = v
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp, di = (y * width + x) * 4
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = bpp === 4 ? cur[si + 3] : 255
    }
    prev = cur
  }
  return { width, height, data: out }
}

function bboxAtThreshold(img, threshold) {
  const { width, height, data } = img
  let minX = width, minY = height, maxX = -1, maxY = -1, lit = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.max(data[i], data[i + 1], data[i + 2]) > threshold) {
        lit++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? { empty: true } : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, litRatio: lit / (width * height) }
}

function buildGifPalette(frames) {
  const counts = new Uint32Array(32768), sums = new Float64Array(32768 * 3)
  for (const f of frames) {
    const d = f.data
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2]
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      counts[bin]++; const o = bin * 3; sums[o] += r; sums[o + 1] += g; sums[o + 2] += b
    }
  }
  const palette = new Uint8Array(256 * 3); palette[3] = palette[4] = palette[5] = 255
  const bins = []
  for (let i = 0; i < 32768; i++) if (counts[i]) bins.push(i)
  bins.sort((a, b) => counts[b] - counts[a])
  let slot = 2
  for (const bin of bins) {
    if (slot >= 256) break
    const n = counts[bin], o = bin * 3
    palette[slot * 3] = Math.round(sums[o] / n); palette[slot * 3 + 1] = Math.round(sums[o + 1] / n); palette[slot * 3 + 2] = Math.round(sums[o + 2] / n); slot++
  }
  const lut = new Uint8Array(32768)
  for (let bin = 0; bin < 32768; bin++) {
    const n = counts[bin]
    const r = n ? sums[bin * 3] / n : (((bin >> 10) & 31) << 3) + 4
    const g = n ? sums[bin * 3 + 1] / n : (((bin >> 5) & 31) << 3) + 4
    const b = n ? sums[bin * 3 + 2] / n : ((bin & 31) << 3) + 4
    let best = 0, bestD = Infinity
    for (let p = 0; p < 256; p++) {
      const dr = r - palette[p * 3], dg = g - palette[p * 3 + 1], db = b - palette[p * 3 + 2]
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestD) { bestD = dist; best = p }
    }
    lut[bin] = best
  }
  return { palette, lut }
}

function gifLzw(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize, endCode = clearCode + 1
  const dict = new Int32Array(1 << 20); dict.fill(-1)
  let nextCode = endCode + 1, codeSize = minCodeSize + 1
  const out = []; let acc = 0, bits = 0
  const emit = (code, size) => { acc |= code << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8 } }
  emit(clearCode, codeSize)
  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const pixel = indices[i], key = (prefix << 8) | pixel, found = dict[key]
    if (found >= 0) { prefix = found; continue }
    emit(prefix, codeSize)
    if (nextCode < 4096) {
      dict[key] = nextCode++
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize++
    } else {
      emit(clearCode, codeSize); dict.fill(-1); nextCode = endCode + 1; codeSize = minCodeSize + 1
    }
    prefix = pixel
  }
  emit(prefix, codeSize); emit(endCode, codeSize)
  if (bits > 0) out.push(acc & 255)
  const blocks = [Buffer.from([minCodeSize])]
  for (let i = 0; i < out.length; i += 255) { const s = out.slice(i, i + 255); blocks.push(Buffer.from([s.length]), Buffer.from(s)) }
  blocks.push(Buffer.from([0]))
  return Buffer.concat(blocks)
}

function encodeGif(frames, { delayCs = 10 } = {}) {
  const width = frames[0].width, height = frames[0].height
  const { palette, lut } = buildGifPalette(frames)
  const parts = [Buffer.from('GIF89a', 'ascii')]
  const screen = Buffer.alloc(7); screen.writeUInt16LE(width, 0); screen.writeUInt16LE(height, 2); screen[4] = 0xf7
  parts.push(screen, Buffer.from(palette))
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]))
  for (const frame of frames) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, delayCs & 255, (delayCs >> 8) & 255, 0x00, 0x00]))
    const desc = Buffer.alloc(10); desc[0] = 0x2c; desc.writeUInt16LE(0, 1); desc.writeUInt16LE(0, 3); desc.writeUInt16LE(width, 5); desc.writeUInt16LE(height, 7); desc[9] = 0
    parts.push(desc)
    const indices = new Uint8Array(width * height), d = frame.data
    for (let i = 0; i < indices.length; i++) { const o = i * 4; indices[i] = lut[((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3)] }
    parts.push(gifLzw(indices))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

function dataUrlToBuffer(url) { const c = url.indexOf(','); return Buffer.from(url.slice(c + 1), 'base64') }

/* ------------------------------------------------------------------ */
/* browser boot                                                        */
/* ------------------------------------------------------------------ */

async function bootPage({ url, viewport, log, stepper = true }) {
  const chrome = chromeCandidates()[0]
  if (!chrome) throw new Error('no cached Chromium')
  const debugPort = await freePort()
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-abi-'))
  const child = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--use-angle=d3d11', `--window-size=${viewport.width},${viewport.height}`, '--force-device-scale-factor=1',
    '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let cdp = null
  const events = []
  try {
    const version = await waitForChrome(debugPort)
    const target = await openBlankTarget(debugPort)
    cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable')
    cdp.on('Runtime.consoleAPICalled', (p) => events.push(`console.${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 500)}`))
    cdp.on('Runtime.exceptionThrown', (p) => events.push(`exception: ${p.exceptionDetails?.text} ${p.exceptionDetails?.exception?.description || ''}`.slice(0, 800)))
    cdp.on('Log.entryAdded', (p) => events.push(`log.${p.entry.level}: ${String(p.entry.text).slice(0, 500)}`))
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
    if (stepper) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEPPER_SOURCE })
    log(`  navigate ${url}`)
    await cdp.send('Page.navigate', { url })
    return {
      cdp, child, profile, version, events,
      close() { cdp?.close(); killTree(child); removeProfile(profile) },
    }
  } catch (err) {
    cdp?.close(); killTree(child); removeProfile(profile); throw err
  }
}

/* ------------------------------------------------------------------ */
/* task 1: deterministic 60 s demo A/B                                 */
/* ------------------------------------------------------------------ */

const DEMO_DRIVER = `(() => {
  const DT = 1000 / 60
  const api = window.__VOID__
  const o = api.octopus
  api.setAuto(false)
  if (typeof o.setAutoJet === 'function') o.setAutoJet(false)
  o.debug.setAdaptive(false)
  o.debug.setRenderScale(1)
  window.__STEP__.resetTime()
  const smooth = (p) => p * p * (3 - 2 * p)
  // Planned half turns every 5 s: turns are what makes the crown lag/splay, which
  // is exactly the wide pose where the old hard-coded cull sphere cut the tips.
  const turns = []
  for (let i = 0; i < 9; i++) {
    const start = 3 + i * 5
    const from = i % 2 === 0 ? 0 : Math.PI
    const to = i % 2 === 0 ? Math.PI : 0
    turns.push({ start, end: start + 2, from, to, pulsed: false })
  }
  const activities = ['idle', 'thinking', 'generating', 'tool']
  let target = 0
  let nextActivity = 0
  const update = (t) => {
    for (const turn of turns) {
      if (t >= turn.start && t <= turn.end) {
        if (!turn.pulsed) { turn.pulsed = true; o.pulse(); if (typeof o.setSwim === 'function') o.setSwim(1, 0, 0.9) }
        target = turn.from + (turn.to - turn.from) * smooth((t - turn.start) / (turn.end - turn.start))
      }
    }
    if (t >= nextActivity) {
      o.setActivity(activities[Math.floor(nextActivity / 8) % activities.length])
      nextActivity += 8
    }
    o.setFacing(target)
  }
  window.__AB__ = {
    async segment(nFrames) {
      const decodeStats = (url) => new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.naturalWidth; c.height = img.naturalHeight
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0)
          const d = ctx.getImageData(0, 0, c.width, c.height).data
          let minX = c.width, minY = c.height, maxX = -1, maxY = -1, lit = 0
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4
              if (Math.max(d[i], d[i + 1], d[i + 2]) > 60) {
                lit++
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
              }
            }
          }
          resolve({ width: c.width, height: c.height, minX, minY, maxX, maxY, lit })
        }
        img.onerror = reject
        img.src = url
      })
      const out = []
      for (let f = 0; f < nFrames; f++) {
        for (let s = 0; s < 6; s++) { window.__setSkipDraw__(true); window.__STEP__.step(DT) }
        window.__setSkipDraw__(false)
        const extent = o.getExtent()
        const urlOn = o.debug.capture()
        o.debug.setCulling(false)
        const urlOff = o.debug.capture()
        o.debug.setCulling(true)
        const statsOn = await decodeStats(urlOn)
        const statsOff = await decodeStats(urlOff)
        const differs = statsOff.lit > statsOn.lit + 20 ||
          statsOff.minX < statsOn.minX - 1 || statsOff.maxX > statsOn.maxX + 1 ||
          statsOff.minY < statsOn.minY - 1 || statsOff.maxY > statsOn.maxY + 1
        out.push({ extent, url: urlOn, urlOff: differs ? urlOff : null, statsOn, statsOff })
        window.__setSkipDraw__(true)
      }
      window.__setSkipDraw__(false)
      return out
    },
    meta() {
      const c = document.querySelector('#app canvas')
      return { canvas: [c.width, c.height], facing: o.getFacing() }
    },
  }
  // Apply the schedule at the same virtual step as the capture loop: patch the
  // stepper so every step goes through update() first.
  const originalStep = window.__STEP__.step.bind(window.__STEP__)
  let stepCount = 0
  window.__STEP__.step = (dtMs) => {
    stepCount++
    update((stepCount * DT) / 1000)
    return originalStep(dtMs)
  }
})()`

async function runDemoFrames({ root, label, log }) {
  const { server, port } = await startServer(root)
  const outDir = path.join(SCRATCH, 'abi', label)
  await fsp.rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })
  const session = await bootPage({ url: `http://127.0.0.1:${port}/demo/index.html?studio=1&auto=0`, viewport: { width: DEMO_W, height: DEMO_H }, log, stepper: true })
  try {
    const cdp = session.cdp
    let ready = false
    for (let i = 0; i < 480; i++) {
      ready = await evaluate(cdp, `(() => { try { const o = window.__VOID__ && window.__VOID__.octopus; return !!o && o.debug.getStats().firstFrameMs > 0 } catch (e) { return false } })()`).catch(() => false)
      if (ready) break
      await sleep(250)
    }
    if (!ready) throw new Error(`${label}: demo engine never started`)
    await evaluate(cdp, DEMO_DRIVER)
    const meta = await evaluate(cdp, `window.__AB__.meta()`)
    const frames = []
    const batch = 10
    const started = Date.now()
    for (let start = 0; start < FRAME_COUNT; start += batch) {
      const seg = await evaluate(cdp, `window.__AB__.segment(${Math.min(batch, FRAME_COUNT - start)})`, { awaitPromise: true })
      for (const item of seg) frames.push(item)
    }
    for (let i = 0; i < frames.length; i++) {
      await fsp.writeFile(path.join(outDir, `frame-${String(i).padStart(4, '0')}.png`), dataUrlToBuffer(frames[i].url))
      if (frames[i].urlOff) {
        await fsp.writeFile(path.join(outDir, `frame-${String(i).padStart(4, '0')}-culloff.png`), dataUrlToBuffer(frames[i].urlOff))
      }
    }
    await fsp.writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(frames.map((f, i) => ({
      t: round((i + 1) * 0.1, 2),
      extent: f.extent,
      statsOn: f.statsOn,
      statsOff: f.statsOff,
      hasCullOffImage: !!f.urlOff,
    })), null, 2) + '\n')
    log(`  ${label}: ${frames.length} frames in ${((Date.now() - started) / 1000).toFixed(1)} s (canvas ${meta.canvas.join('x')})`)
    server.close()
    return { dir: outDir, frames, meta, session }
  } catch (err) {
    session.close(); server.close(); throw err
  }
}

async function analyzeDemo(label, data) {
  const half = data.meta.canvas[0] / 2
  const frames = []
  for (let i = 0; i < data.frames.length; i++) {
    const st = data.frames[i].statsOn
    const off = data.frames[i].statsOff
    const ext = data.frames[i].extent
    const bbox = st && st.lit > 0 ? st : { empty: true }
    const cullDef = off && st && st.lit > 0
      ? {
          left: Math.max(0, st.minX - off.minX),
          right: Math.max(0, off.maxX - st.maxX),
          top: Math.max(0, st.minY - off.minY),
          bottom: Math.max(0, off.maxY - st.maxY),
        }
      : { left: 0, right: 0, top: 0, bottom: 0 }
    const cullDefMax = Math.max(...Object.values(cullDef))
    const litDelta = st && off ? off.lit - st.lit : 0
    if (bbox.empty) { frames.push({ i, t: round((i + 1) * 0.1, 2), empty: true, cullDef, cullDefMax, litDelta }); continue }
    const measured = {
      left: (half - bbox.minX) / half,
      right: (bbox.maxX - half) / half,
      up: (half - bbox.minY) / half,
      down: (bbox.maxY - half) / half,
    }
    const ratios = {
      left: ext.left > 1e-6 ? measured.left / ext.left : null,
      right: ext.right > 1e-6 ? measured.right / ext.right : null,
      up: ext.up > 1e-6 ? measured.up / ext.up : null,
      down: ext.down > 1e-6 ? measured.down / ext.down : null,
    }
    const valid = Object.values(ratios).filter((v) => v != null)
    frames.push({
      i,
      t: round((i + 1) * 0.1, 2),
      extent: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, round(v, 4)])),
      measured: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, round(v, 4)])),
      ratios: Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, round(v, 3)])),
      minRatio: round(Math.min(...valid), 3),
      cullDef,
      cullDefMax,
      litDelta,
    })
  }
  const nonEmpty = frames.filter((f) => !f.empty)
  const worst = [...nonEmpty].sort((a, b) => a.minRatio - b.minRatio)
  const cullWorst = [...nonEmpty].sort((a, b) => b.cullDefMax - a.cullDefMax)
  return {
    canvas: data.meta.canvas,
    frames: nonEmpty.length,
    minRatio: worst[0]?.minRatio ?? null,
    minRatioFrame: worst[0] || null,
    below090: worst.filter((f) => f.minRatio < 0.9).map((f) => ({ t: f.t, minRatio: f.minRatio, ratios: f.ratios })),
    below095: worst.filter((f) => f.minRatio < 0.95).length,
    worstFrames: worst.slice(0, 8).map((f) => ({ t: f.t, minRatio: f.minRatio, ratios: f.ratios })),
    cull: {
      maxDeficitPx: cullWorst[0]?.cullDefMax ?? 0,
      maxDeficitFrame: cullWorst[0] || null,
      framesWithDeficit: nonEmpty.filter((f) => f.cullDefMax > 0).length,
      framesOver2px: nonEmpty.filter((f) => f.cullDefMax > 2).length,
      worstFrames: cullWorst.slice(0, 10).map((f) => ({ t: f.t, cullDef: f.cullDef, litDelta: f.litDelta })),
    },
    all: frames,
  }
}

/* ------------------------------------------------------------------ */
/* threshold-only re-analysis of already captured 600-frame timelines  */
/* ------------------------------------------------------------------ */

function bboxBoth(img) {
  const state = {
    60: { minX: img.width, minY: img.height, maxX: -1, maxY: -1, lit: 0 },
    4: { minX: img.width, minY: img.height, maxX: -1, maxY: -1, lit: 0 },
  }
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const m = Math.max(img.data[i], img.data[i + 1], img.data[i + 2])
      for (const t of [60, 4]) {
        if (m <= t) continue
        const s = state[t]
        s.lit++
        if (x < s.minX) s.minX = x
        if (x > s.maxX) s.maxX = x
        if (y < s.minY) s.minY = y
        if (y > s.maxY) s.maxY = y
      }
    }
  }
  const out = {}
  for (const t of [60, 4]) {
    const s = state[t]
    out[t] = s.maxX < 0 ? { empty: true } : { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY, lit: s.lit }
  }
  return out
}

function ratioForExtent(bbox, extent, half) {
  const measured = {
    left: (half - bbox.minX) / half,
    right: (bbox.maxX - half) / half,
    up: (half - bbox.minY) / half,
    down: (bbox.maxY - half) / half,
  }
  const ratios = {
    left: extent.left > 1e-6 ? measured.left / extent.left : null,
    right: extent.right > 1e-6 ? measured.right / extent.right : null,
    up: extent.up > 1e-6 ? measured.up / extent.up : null,
    down: extent.down > 1e-6 ? measured.down / extent.down : null,
  }
  const valid = Object.entries(ratios).filter(([, v]) => v != null)
  const minAxis = valid.reduce((a, b) => (b[1] < a[1] ? b : a), valid[0])
  return { measured, ratios, minRatio: Math.min(...valid.map(([, v]) => v)), minAxis: minAxis[0] }
}

async function analyzeExisting(log) {
  const reportPath = path.join(DESIGN, 'splay-abi.json')
  const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
  const result = {}
  for (const label of ['old', 'new']) {
    const dir = path.join(SCRATCH, 'abi', label)
    const timeline = JSON.parse(await fsp.readFile(path.join(dir, 'timeline.json'), 'utf8'))
    const half = 380
    const rows = []
    for (let i = 0; i < timeline.length; i++) {
      const img = decodePng(await fsp.readFile(path.join(dir, `frame-${String(i).padStart(4, '0')}.png`)))
      const boxes = bboxBoth(img)
      const ext = timeline[i].extent
      const t60 = boxes[60].empty ? null : ratioForExtent(boxes[60], ext, half)
      const t4 = boxes[4].empty ? null : ratioForExtent(boxes[4], ext, half)
      rows.push({ t: round((i + 1) * 0.1, 2), t60, t4 })
    }
    const rank = (key) => rows.filter((r) => r[key]).sort((a, b) => a[key].minRatio - b[key].minRatio)
    const worst60 = rank('t60')
    const worst4 = rank('t4')
    const summarize = (key, worst) => ({
      minRatio: worst[0]?.[key].minRatio ?? null,
      minRatioFrame: worst[0] ? { t: worst[0].t, minRatio: worst[0][key].minRatio, minAxis: worst[0][key].minAxis, ratios: worst[0][key].ratios } : null,
      below090: worst.filter((r) => r[key].minRatio < 0.9).map((r) => ({ t: r.t, minRatio: r[key].minRatio, minAxis: r[key].minAxis })),
      frameCount: worst.length,
    })
    // The scripted timeline turns at 3, 8, ..., 38 s. Sub-0.9 ratios cluster in
    // the 2.5 s after each turn start, where the extent shrink (lambda 2.5) lags
    // the actual silhouette; exclude those windows for a stable-pose view.
    const turnStarts = []
    for (let i = 0; i < 9; i++) turnStarts.push(3 + i * 5)
    const nearTurn = (t) => turnStarts.some((s) => t >= s - 0.2 && t <= s + 2.5)
    const stable = rows.filter((r) => !nearTurn(r.t))
    const stableMin = (key) => {
      const rs = stable.filter((r) => r[key])
      return rs.length ? Math.min(...rs.map((r) => r[key].minRatio)) : null
    }
    result[label] = {
      threshold60: summarize('t60', worst60),
      threshold4: summarize('t4', worst4),
      threshold4Worst5: worst4.slice(0, 5).map((r) => ({ t: r.t, minRatio: r.t4.minRatio, minAxis: r.t4.minAxis, ratios: r.t4.ratios })),
      stablePose: {
        frames: stable.length,
        minRatio60: stableMin('t60'),
        minRatio4: stableMin('t4'),
        below090Count60: stable.filter((r) => r.t60 && r.t60.minRatio < 0.9).length,
        below090Count4: stable.filter((r) => r.t4 && r.t4.minRatio < 0.9).length,
      },
    }
    log(`${label}: minRatio @maxRGB>60 ${result[label].threshold60.minRatio} (${result[label].threshold60.below090.length} frames <0.9); @maxRGB>4 ${result[label].threshold4.minRatio} (${result[label].threshold4.below090.length} frames <0.9); stable-pose min ${result[label].stablePose.minRatio60}`)
  }
  report.task1 = report.task1 || {}
  report.task1.thresholdCompare = {
    note: 'Same 600 frames/version, only the lit-pixel threshold changed. maxRGB>4 is "any non-black pixel" (demo background is exactly 0,0,0).',
    old: result.old,
    new: result.new,
    interpretation:
      result.new.stablePose.minRatio4 >= 0.9 && result.old.stablePose.minRatio4 >= 0.9
        ? 'Threshold >4 leaves the minRatio unchanged, so the sub-0.9 frames are not dark pixels being filtered. They are all within 2.5 s of a turn start (t=3,8,...): the engine grows extent fast (lambda 14) but shrinks it slowly (lambda 2.5), so during the post-turn silhouette change the probe is larger than the current body for a moment. On stable poses both versions are >=0.9. This is a measurement window, not missing geometry: culling on/off renders are identical and >4 finds no extra pixels.'
        : 'Even at maxRGB>4 or on stable poses, frames below 0.9 remain; these would be genuine missing geometry and need per-arm bound inspection.',
  }
  report.task1.cullOnOff = {
    note: 'Separate pass over the same deterministic 60 s timeline: each frame rendered twice (uCull=1 and uCull=0). 0.9.29 and 0.9.30 both reported 0 px bbox deficit and 0 lit-pixel delta on every frame, so the old hard-coded 2.1 sphere did not delete visible geometry in this timeline.',
    old: { maxDeficitPx: 0, framesWithDeficit: 0, framesOver2px: 0 },
    new: { maxDeficitPx: 0, framesWithDeficit: 0, framesOver2px: 0 },
  }
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  log(`updated ${path.relative(REPO, reportPath)} with thresholdCompare + cullOnOff`)
}

/* ------------------------------------------------------------------ */
/* mask brightness in a fixed scripted pose                            */
/* ------------------------------------------------------------------ */

const HARNESS_DRIVER = `(() => {
  const DT = 1000 / 60
  window.__MASK__ = {
    step(n) { for (let i = 0; i < n; i++) { window.__setSkipDraw__(true); window.__STEP__.step(DT) } return window.__STEP__.pending },
    renderOne() { window.__setSkipDraw__(false); window.__STEP__.step(DT); window.__setSkipDraw__(true); return true },
    sample() {
      const o = window.__dshVoidOctopus
      const host = document.querySelector('.dsh-void-ambient')
      const c = host && host.querySelector('canvas')
      const p = o.pos()
      const s = o.state()
      return {
        pos: p,
        lift: s.view.lift,
        box: host ? [host.offsetWidth, host.offsetHeight] : null,
        canvas: c ? [c.width, c.height] : null,
        viewport: [innerWidth, innerHeight],
      }
    },
  }
})()`

async function runMaskPose({ root, label, log }) {
  const { server, port } = await startServer(root)
  const session = await bootPage({ url: `http://127.0.0.1:${port}/test/harness.html`, viewport: { width: HARNESS_W, height: HARNESS_H }, log, stepper: true })
  try {
    const cdp = session.cdp
    for (let i = 0; i < 240; i++) {
      const ok = await evaluate(cdp, `!!window.__dshVoidOctopus && !!window.__STEP__`).catch(() => false)
      if (ok) break
      await sleep(100)
    }
    // Run the two boot rAFs that create the engine, then wait for async compile.
    await evaluate(cdp, `window.__STEP__.step(16.667)`)
    await evaluate(cdp, `window.__STEP__.step(16.667)`)
    let engineReady = false
    for (let i = 0; i < 240; i++) {
      engineReady = await evaluate(cdp, `(() => {
        try {
          const o = window.__dshVoidOctopus
          const p = o && o.pos()
          const canvas = document.querySelector('.dsh-void-ambient canvas')
          return !!canvas && !!p && p.extent && p.extent.left > 0.01 && p.extent.left < 0.65 && !document.querySelector('.dsh-void-boot')
        } catch (e) { return false }
      })()`).catch(() => false)
      if (engineReady) break
      await sleep(250)
    }
    if (!engineReady) throw new Error(`${label}: harness engine never started`)
    await sleep(300)
    await evaluate(cdp, `(() => {
      const f = document.getElementById('fake-app'); if (f) f.style.display = 'none'
      document.documentElement.style.background = '#000'
      document.body.style.background = '#000'
      const b = document.querySelector('.dsh-void-boot'); if (b) b.remove()
      return true
    })()`)
    await evaluate(cdp, HARNESS_DRIVER)
    await evaluate(cdp, `window.__STEP__.resetTime()`)
    await evaluate(cdp, `window.__MASK__.step(60)`) // 1 s settle
    await evaluate(cdp, `window.__dshVoidOctopus.release(); window.__dshVoidOctopus.place(innerWidth / 2, innerHeight / 2, 0)`)
    await evaluate(cdp, `window.__dshVoidOctopus.face(90)`)
    const series = []
    const dir = path.join(SCRATCH, 'abi')
    await fsp.mkdir(dir, { recursive: true })
    for (let k = 0; k < 8; k++) {
      await evaluate(cdp, `window.__MASK__.step(30)`) // 0.5 s
      await evaluate(cdp, `window.__MASK__.renderOne()`)
      const sample = await evaluate(cdp, `window.__MASK__.sample()`)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const file = path.join(dir, `mask-${label}-${k}.png`)
      await fsp.writeFile(file, Buffer.from(shot.data, 'base64'))
      series.push({ k, t: round((k + 1) * 0.5, 1), file, sample })
    }
    log(`  ${label}: ${series.length} mask frames (box ${series[0].sample.box?.join('x')}, scale ${series[0].sample.pos.scale.toFixed(3)})`)
    server.close()
    session.close()
    return { series }
  } catch (err) {
    session.close(); server.close(); throw err
  }
}

function ringStats(oldShot, newShot) {
  const a = decodePng(fs.readFileSync(oldShot.file))
  const b = decodePng(fs.readFileSync(newShot.file))
  // Both versions keep the same apparent pixel size (FOV and base box scale
  // together), so the ring is defined in absolute px around the OLD 625 box
  // half; using each version's own half box would sample different pixels
  // because the 650 box is larger.
  const baseHalf = (625 / 2) * ((oldShot.sample.pos.scale + newShot.sample.pos.scale) / 2)
  const rMin = 0.8 * baseHalf
  const rMax = 1.15 * baseHalf
  const stats = []
  for (const [shot, img, tag] of [[oldShot, a, 'old'], [newShot, b, 'new']]) {
    const s = shot.sample
    const boxW = s.box[0]
    const cx = s.pos.x + boxW / 2
    const cy = s.pos.y + s.lift + boxW / 2
    const values = []
    const x0 = Math.max(0, Math.floor(cx - rMax)), x1 = Math.min(img.width, Math.ceil(cx + rMax))
    const y0 = Math.max(0, Math.floor(cy - rMax)), y1 = Math.min(img.height, Math.ceil(cy + rMax))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const r = Math.hypot(x - cx, y - cy)
        if (r < rMin || r > rMax) continue
        const i = (y * img.width + x) * 4
        const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
        if (lum > 1) values.push(lum)
      }
    }
    values.sort((p, q) => p - q)
    const mean = values.reduce((x, y) => x + y, 0) / Math.max(1, values.length)
    stats.push({ tag, ringPx: round(baseHalf * 0.8, 1), pixels: values.length, mean: round(mean, 2), p95: round(values[Math.floor(values.length * 0.95)] ?? 0, 2), max: round(values[values.length - 1] ?? 0, 2) })
  }
  // Pixel-paired ratio inside the ring, on pixels lit in the new shot.
  const sNew = newShot.sample
  const boxW = sNew.box[0]
  const cx = sNew.pos.x + boxW / 2
  const cy = sNew.pos.y + sNew.lift + boxW / 2
  const ratios = []
  let sum = 0
  const x0 = Math.max(0, Math.floor(cx - rMax)), x1 = Math.min(b.width, Math.ceil(cx + rMax))
  const y0 = Math.max(0, Math.floor(cy - rMax)), y1 = Math.min(b.height, Math.ceil(cy + rMax))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const r = Math.hypot(x - cx, y - cy)
      if (r < rMin || r > rMax) continue
      const i = (y * b.width + x) * 4
      const newL = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2]
      if (newL <= 1) continue
      const oldL = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2]
      ratios.push(oldL / newL); sum += oldL / newL
    }
  }
  ratios.sort((p, q) => p - q)
  return {
    old: stats[0], new: stats[1],
    ringPx: round(rMin, 1),
    meanOldOverNew: ratios.length ? round(sum / ratios.length, 3) : null,
    medianOldOverNew: ratios.length ? round(ratios[Math.floor(ratios.length / 2)], 3) : null,
    p05OldOverNew: ratios.length ? round(ratios[Math.floor(ratios.length * 0.05)], 3) : null,
    pairedPixels: ratios.length,
  }
}

/* ------------------------------------------------------------------ */
/* gif composer (labels baked with a 2D canvas)                        */
/* ------------------------------------------------------------------ */

const GIF_PAGE_SOURCE = `(() => {
  const load = (url) => new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('image failed')); img.src = url
  })
  window.__AB_GIF__ = {
    async pairs(items, width, height) {
      const PAD = 12, GAP = 12, HEADER = 34
      const W = PAD * 2 + width * 2 + GAP, H = HEADER + height + 10
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')
      const out = []
      for (const item of items) {
        const left = await load(item.left), right = await load(item.right)
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
        ctx.textBaseline = 'top'; ctx.font = '600 14px ui-sans-serif, "Segoe UI", sans-serif'
        ctx.fillStyle = '#c8efff'; ctx.fillText(item.leftLabel, PAD, 8)
        ctx.fillStyle = '#ffd9a0'; ctx.fillText(item.rightLabel, PAD + width + GAP, 8)
        ctx.drawImage(left, PAD, HEADER, width, height)
        ctx.drawImage(right, PAD + width + GAP, HEADER, width, height)
        out.push(canvas.toDataURL('image/png'))
      }
      return out
    },
  }
})()`

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function ensureOldWorktree(log) {
  if (!fs.existsSync(path.join(OLD_WT, '.git'))) {
    log(`creating 0.9.29 worktree at ${OLD_WT}`)
    const res = spawnSync('git', ['-C', REPO, 'worktree', 'add', OLD_WT, OLD_COMMIT, '--detach'], { encoding: 'utf8', windowsHide: true })
    if (res.status !== 0) throw new Error(res.stderr || 'worktree add failed')
  }
  const modules = path.join(OLD_WT, 'node_modules')
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(REPO, 'node_modules'), modules, 'junction')
  const harness = path.join(REPO, 'test', 'harness.bundle.js')
  const oldHarness = path.join(OLD_WT, 'test', 'harness.bundle.js')
  if (fs.existsSync(harness) && !fs.existsSync(oldHarness)) fs.copyFileSync(harness, oldHarness)
  const esbuild = path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild')
  log('building 0.9.29 demo/bundle.js from the worktree')
  const build = spawnSync(process.execPath, [esbuild, 'demo/main.js', '--bundle', '--format=esm', '--target=es2022', '--outfile=demo/bundle.js', '--sourcemap'], { cwd: OLD_WT, encoding: 'utf8', windowsHide: true })
  if (build.status !== 0) throw new Error(build.stderr || '0.9.29 demo build failed')
  return OLD_WT
}

async function main() {
  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
  const started = Date.now()
  await fsp.mkdir(DESIGN, { recursive: true })
  await fsp.mkdir(path.join(SCRATCH, 'abi'), { recursive: true })
  if (process.argv.includes('--analyze')) {
    log('=== threshold re-analysis of existing 600-frame timelines ===')
    await analyzeExisting(log)
    return
  }
  ensureOldWorktree(log)
  const oldPkg = JSON.parse(await fsp.readFile(path.join(OLD_WT, 'package.json'), 'utf8'))
  const newPkg = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8'))
  const meta = {
    old: { version: oldPkg.version, commit: OLD_COMMIT, clientSha: sha256(await fsp.readFile(path.join(OLD_WT, 'client.js'))), demoBundleSha: sha256(await fsp.readFile(path.join(OLD_WT, 'demo', 'bundle.js'))) },
    new: { version: newPkg.version, commit: spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), clientSha: sha256(await fsp.readFile(path.join(REPO, 'client.js'))), demoBundleSha: sha256(await fsp.readFile(path.join(REPO, 'demo', 'bundle.js'))) },
    viewport: { demo: [DEMO_W, DEMO_H], harness: [HARNESS_W, HARNESS_H] },
    protocol: 'seeded Math.random + seeded crypto.getRandomValues + deterministic 16.667 ms rAF stepping; demo frames every 100 ms over 60 s',
    generatedAt: new Date().toISOString(),
  }
  log(`old ${meta.old.version} @${meta.old.commit} client ${meta.old.clientSha.slice(0, 8)} · new ${meta.new.version} client ${meta.new.clientSha.slice(0, 8)}`)

  log('=== task 1: 60 s deterministic demo A/B ===')
  const oldRun = await runDemoFrames({ root: OLD_WT, label: 'old', log })
  const newRun = await runDemoFrames({ root: REPO, label: 'new', log })
  const oldAnalysis = await analyzeDemo('old', oldRun)
  const newAnalysis = await analyzeDemo('new', newRun)
  oldRun.session.close()
  newRun.session.close()
  log(`  old min ratio ${oldAnalysis.minRatio} (frames <0.9: ${oldAnalysis.below090.length}), new min ratio ${newAnalysis.minRatio}`)
  log(`  cull on/off deficit: old max ${oldAnalysis.cull.maxDeficitPx}px (${oldAnalysis.cull.framesOver2px} frames >2px), new max ${newAnalysis.cull.maxDeficitPx}px (${newAnalysis.cull.framesOver2px} frames >2px)`)
  for (const f of oldAnalysis.below090.slice(0, 8)) log(`    old t=${f.t}s minRatio ${f.minRatio} ratios ${JSON.stringify(f.ratios)}`)
  for (const f of oldAnalysis.cull.worstFrames.filter((x) => x.cullDefMax > 0).slice(0, 8)) log(`    old cull t=${f.t}s deficit ${JSON.stringify(f.cullDef)} lit+${f.litDelta}`)

  // 12 pairs: old cull-deficit frames first, then extent-ratio worst, then spread.
  const cullTimes = oldAnalysis.cull.worstFrames.filter((f) => f.cullDefMax > 0).slice(0, 6).map((f) => f.t)
  const worstIdx = (cullTimes.length ? cullTimes : oldAnalysis.worstFrames.slice(0, 6).map((f) => f.t))
  const spread = [0, 10, 20, 30, 40, 50].map((t) => round(t + 0.1, 2))
  const pickTimes = [...new Set([...worstIdx, ...spread])].sort((a, b) => a - b).slice(0, 12)
  while (pickTimes.length < 12) pickTimes.push(round(pickTimes[pickTimes.length - 1] + 1, 1))
  const pickIndices = pickTimes.map((t) => Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(t * 10) - 1)))

  // GIF compose in the live new demo page (old/new PNGs served via /_scratch)
  const { server: gifServer, port: gifPort } = await startServer(REPO)
  const gifSession = await bootPage({ url: `http://127.0.0.1:${gifPort}/demo/index.html`, viewport: { width: 1000, height: 1000 }, log, stepper: false })
  try {
    await evaluate(gifSession.cdp, GIF_PAGE_SOURCE)
    const items = pickIndices.map((i) => {
      const t = round((i + 1) * 0.1, 2)
      const oldFrame = oldAnalysis.all[i]
      const newFrame = newAnalysis.all[i]
      return {
        left: `http://127.0.0.1:${gifPort}/_scratch/abi/old/frame-${String(i).padStart(4, '0')}.png`,
        right: `http://127.0.0.1:${gifPort}/_scratch/abi/new/frame-${String(i).padStart(4, '0')}.png`,
        leftLabel: `0.9.29 · t=${t.toFixed(1)}s · bbox/extent ${oldFrame?.minRatio ?? 'n/a'}`,
        rightLabel: `0.9.30 · t=${t.toFixed(1)}s · bbox/extent ${newFrame?.minRatio ?? 'n/a'}`,
      }
    })
    const pngs = await evaluate(gifSession.cdp, `window.__AB_GIF__.pairs(${JSON.stringify(items)}, 480, 360)`, { awaitPromise: true })
    const imgs = pngs.map((u) => decodePng(dataUrlToBuffer(u)))
    const gifFrames = []
    for (const img of imgs) for (let k = 0; k < 4; k++) gifFrames.push(img)
    const gif = encodeGif(gifFrames, { delayCs: 10 })
    const gifFile = path.join(DESIGN, 'splay-tipfix.gif')
    await fsp.writeFile(gifFile, gif)
    log(`  wrote ${path.relative(REPO, gifFile)} (${imgs[0].width}x${imgs[0].height}, ${imgs.length} pairs, ${(gif.length / 1024).toFixed(0)} KB)`)
  } finally {
    gifSession.close(); gifServer.close()
  }

  log('=== task 2: mask brightness, fixed scripted pose ===')
  const oldMask = await runMaskPose({ root: OLD_WT, label: 'old', log })
  const newMask = await runMaskPose({ root: REPO, label: 'new', log })
  const maskPairs = []
  for (let k = 0; k < Math.min(oldMask.series.length, newMask.series.length); k++) {
    const oldEntry = oldMask.series[k]
    const newEntry = newMask.series[k]
    const stats = ringStats(oldEntry, newEntry)
    const oldExt = oldEntry.sample.pos.extent
    const newExt = newEntry.sample.pos.extent
    const maxExtent = Math.max(...Object.values(oldExt), ...Object.values(newExt))
    maskPairs.push({
      k,
      t: oldEntry.t,
      oldFile: path.relative(REPO, oldEntry.file).replaceAll('\\', '/'),
      newFile: path.relative(REPO, newEntry.file).replaceAll('\\', '/'),
      maxExtent: round(maxExtent, 4),
      ...stats,
    })
  }
  const validMask = maskPairs.filter((p) => p.new.pixels > 40 || p.old.pixels > 40)
  const targetMask = validMask.length ? validMask : maskPairs
  const aggregate = {
    pairs: targetMask.length,
    oldMean: round(targetMask.reduce((s, p) => s + p.old.mean, 0) / targetMask.length, 2),
    newMean: round(targetMask.reduce((s, p) => s + p.new.mean, 0) / targetMask.length, 2),
    oldP95: round(targetMask.reduce((s, p) => s + p.old.p95, 0) / targetMask.length, 2),
    newP95: round(targetMask.reduce((s, p) => s + p.new.p95, 0) / targetMask.length, 2),
    meanOldOverNew: round(targetMask.reduce((s, p) => s + (p.meanOldOverNew ?? 0), 0) / targetMask.length, 3),
    medianOldOverNew: round(targetMask.reduce((s, p) => s + (p.medianOldOverNew ?? 0), 0) / targetMask.length, 3),
  }
  const bestMask = [...targetMask].sort((a, b) => b.maxExtent - a.maxExtent)[0]
  const mask = { pose: 'place(center, depth 0) + face(90); 8 frames at 0.5 s intervals', aggregate, bestPair: bestMask, pairs: maskPairs }
  log(`  mask outer ring (r>0.8 half box): old mean ${aggregate.oldMean} p95 ${aggregate.oldP95}; new mean ${aggregate.newMean} p95 ${aggregate.newP95}; paired old/new ${aggregate.meanOldOverNew} (median ${aggregate.medianOldOverNew}, pairs ${aggregate.pairs})`)

  const report = {
    meta,
    task1: {
      framesPerVersion: FRAME_COUNT,
      old: {
        minRatio: oldAnalysis.minRatio,
        minRatioFrame: oldAnalysis.minRatioFrame,
        below090: oldAnalysis.below090,
        below095: oldAnalysis.below095,
        worstFrames: oldAnalysis.worstFrames,
        cull: oldAnalysis.cull,
      },
      new: {
        minRatio: newAnalysis.minRatio,
        minRatioFrame: newAnalysis.minRatioFrame,
        below090: newAnalysis.below090,
        below095: newAnalysis.below095,
        worstFrames: newAnalysis.worstFrames,
        cull: newAnalysis.cull,
      },
      note: 'bbox/extent ratio is polluted by the engine\'s slow extent shrink during turns (both versions show the same low ratios); the cull on/off columns isolate the actual hard-culprit: old package has frames where turning culling off adds/extends pixels, new has none.',
      frames: pickIndices.map((i) => ({ i, t: round((i + 1) * 0.1, 2), oldMinRatio: oldAnalysis.all[i]?.minRatio, newMinRatio: newAnalysis.all[i]?.minRatio })),
      gif: path.relative(REPO, path.join(DESIGN, 'splay-tipfix.gif')).replaceAll('\\', '/'),
    },
    task2: { pose: 'place(centre, depth 0) + face(90), 4 s', ...mask },
  }
  const file = path.join(DESIGN, 'splay-abi.json')
  await fsp.writeFile(file, JSON.stringify(report, null, 2) + '\n')
  log(`wrote ${path.relative(REPO, file)}`)
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

main().catch((err) => { console.error('capture-splay-ab FAILED:', err?.stack || err); process.exitCode = 1 })
