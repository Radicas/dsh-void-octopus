#!/usr/bin/env node
/**
 * capture-edge.mjs — visual evidence for 0.9.29 "the body collides with the
 * viewport edge, not the 500 px layer box".
 *
 *   node scripts/capture-edge.mjs all         # projection + placement + coverage + gif
 *   node scripts/capture-edge.mjs projection  # item 1: extent probe vs measured bbox
 *   node scripts/capture-edge.mjs placement   # item 2: four walls / four corners / splay
 *   node scripts/capture-edge.mjs coverage    # item 3: 90 s wander + edge-coverage.gif
  node scripts/capture-edge.mjs clipcheck   # pixel test: is the body cut by the 500 px canvas edge?
 *
 * It serves the repo, drives the cached headless Chromium through raw CDP
 * (Node 24 fetch/WebSocket only), captures PNGs, measures the body bounding box
 * at several brightness thresholds, compares it with `getExtent()` (demo) and
 * `pos()` (real plugin harness), and writes:
 *
 *   design/edge-report.json        numbers for every case + console output
 *   design/edge-coverage.gif       21 labelled screenshots, 10 fps, looping
 *   design/edge-projection-*.png   raw demo frames used for item 1
 *   .scratch-verify/edge-shots/*.png  full-size harness screenshots
 *
 * The demo bundle and client.js must already be rebuilt from the 0.9.29 src
 * (`npm run build:demo`, `npm run build:client`). Nothing in the repo is edited
 * except the outputs above; scratch files live in .scratch-verify/.
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(REPO, '..')
const SCRATCH = path.join(WORKSPACE, '.scratch-verify')
const DESIGN = path.join(REPO, 'design')
const SHOTS = path.join(SCRATCH, 'edge-shots')
const PLACEMENT_CACHE = path.join(SCRATCH, 'edge-placement.json')
const DEMO_W = 1000
const DEMO_H = 1000
const HARNESS_W = 1440
const HARNESS_H = 900
const THRESHOLDS = [20, 40, 60, 80, 120, 160]
const PRIMARY_THRESHOLD = 60

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)
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
    this.id = 1
    this.pending = new Map()
    this.handlers = new Map()
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('CDP websocket connect failed'))
      this.ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('CDP websocket closed'))
        this.pending.clear()
      }
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id != null) {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`))
          else p.resolve(msg.result)
        } else if (msg.method && this.handlers.has(msg.method)) {
          for (const fn of this.handlers.get(msg.method)) fn(msg.params)
        }
      }
    })
  }
  send(method, params = {}) {
    const id = this.id++
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
    try { this.ws?.close() } catch { /* gone */ }
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
/* chrome boot                                                         */
/* ------------------------------------------------------------------ */

function chromeCandidates(cliChrome) {
  const list = []
  if (cliChrome) list.push(cliChrome)
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH)
  const local = process.env.LOCALAPPDATA
  if (local) {
    list.push(path.join(local, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'))
    list.push(path.join(local, 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe'))
  }
  return [...new Set(list)].filter((p) => p && fs.existsSync(p))
}

const BROWSER_ARGS = (debugPort, profile, w, h) => [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--use-angle=d3d11',
  `--window-size=${w},${h}`,
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
]

async function waitForChrome(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch { /* not up */ }
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

async function bootPage({ url, viewport, chrome, log, waitMs = 120000, readyExpr, consoleEvents, reducedMotion = false }) {
  const debugPort = await freePort()
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'void-edge-'))
  const child = spawn(chrome, BROWSER_ARGS(debugPort, profile, viewport.width, viewport.height), { stdio: 'ignore', windowsHide: true })
  const events = consoleEvents || []
  const pushEvent = (entry) => events.push(entry)
  let cdp = null
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
      pushEvent({ source: 'console', level: p.type, text: String(text).slice(0, 800) })
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      pushEvent({ source: 'exception', level: 'error', text: `${d.text || ''} ${d.exception?.description || ''}`.trim().slice(0, 1200) })
    })
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {}
      pushEvent({ source: 'log', level: e.level, text: String(e.text || '').slice(0, 800) })
    })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    if (reducedMotion) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
    }
    log(`  navigate ${url}`)
    await cdp.send('Page.navigate', { url })
    const started = Date.now()
    let ready = false
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      ready = await evaluate(cdp, readyExpr).catch(() => false)
      if (ready) break
      await sleep(250)
    }
    if (!ready) throw new Error('page never became ready')
    log(`  ready in ${Date.now() - started} ms`)
    return {
      cdp,
      child,
      profile,
      version,
      viewport,
      consoleEvents,
      close() {
        cdp?.close()
        killTree(child)
        removeProfile(profile)
      },
    }
  } catch (err) {
    cdp?.close()
    killTree(child)
    removeProfile(profile)
    throw err
  }
}

/* ------------------------------------------------------------------ */
/* PNG decode / bbox / GIF encode (no dependencies)                    */
/* ------------------------------------------------------------------ */

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

function bboxAtThreshold(img, threshold) {
  const { width, height, data } = img
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let lit = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const m = Math.max(data[i], data[i + 1], data[i + 2])
      if (m > threshold) {
        lit++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { empty: true, threshold }
  return {
    threshold,
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    litRatio: lit / (width * height),
  }
}

function edgeGaps(bbox, viewportW, viewportH) {
  return {
    left: bbox.minX,
    right: viewportW - 1 - bbox.maxX,
    top: bbox.minY,
    bottom: viewportH - 1 - bbox.maxY,
  }
}

/** bbox (canvas px) -> half extents in NDC relative to the layer centre. */
function ndcExtents(bbox, canvasW, canvasH) {
  const cx = canvasW / 2
  const cy = canvasH / 2
  return {
    left: (cx - bbox.minX) / cx,
    right: (bbox.maxX - cx) / cx,
    up: (cy - bbox.minY) / cy,
    down: (bbox.maxY - cy) / cy,
  }
}

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
      // the decoder's table is one entry behind while it reads
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

function encodeGif(frames, { delayCs = 10 } = {}) {
  const width = frames[0].width
  const height = frames[0].height
  const { palette, lut } = buildGifPalette(frames)
  const parts = [Buffer.from('GIF89a', 'ascii')]
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0xf7
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

function fileToDataUrl(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
}

/* ------------------------------------------------------------------ */
/* item 1: demo extent probe vs measured bbox                          */
/* ------------------------------------------------------------------ */

async function runProjection(log, chrome, serverInfo, events) {
  const viewport = { width: DEMO_W, height: DEMO_H }
  const session = await bootPage({
    url: `http://127.0.0.1:${serverInfo.port}/demo/index.html?studio=1&auto=0`,
    viewport,
    chrome,
    log,
    readyExpr: `(() => { try { const o = window.__VOID__ && window.__VOID__.octopus; if (!o) return false; return o.debug.getStats().firstFrameMs > 0 && typeof o.getExtent === 'function' } catch (e) { return false } })()`,
    consoleEvents: events,
  })
  try {
    const cdp = session.cdp
    await evaluate(cdp, `(() => {
      const a = window.__VOID__; const o = a.octopus
      a.setAuto(false)
      if (typeof o.setAutoJet === 'function') o.setAutoJet(false)
      o.debug.setAdaptive(false)
      o.debug.setRenderScale(1)
      return true
    })()`)
    await sleep(500)
    const canvas = await evaluate(cdp, `(() => { const c = document.querySelector('#app canvas'); return { width: c.width, height: c.height, css: [c.clientWidth, c.clientHeight] } })()`)
    log(`  canvas ${canvas.width}x${canvas.height} (css ${canvas.css.join('x')})`)
    const cases = []
    for (const facingDeg of [0, 90, 180]) {
      await evaluate(cdp, `window.__VOID__.octopus.setFacing(${JSON.stringify((facingDeg * Math.PI) / 180)})`)
      await sleep(3000)
      const extent = await evaluate(cdp, `window.__VOID__.octopus.getExtent()`)
      const facing = await evaluate(cdp, `window.__VOID__.octopus.getFacing()`)
      const dataUrl = await evaluate(cdp, `window.__VOID__.octopus.debug.capture()`)
      const file = path.join(DESIGN, `edge-projection-facing-${facingDeg}.png`)
      await fsp.writeFile(file, dataUrlToBuffer(dataUrl))
      const img = decodePng(dataUrlToBuffer(dataUrl))
      const bboxes = {}
      for (const t of THRESHOLDS) bboxes[t] = bboxAtThreshold(img, t)
      const primary = bboxes[PRIMARY_THRESHOLD]
      const measuredNdc = ndcExtents(primary, img.width, img.height)
      const ratio = {
        left: measuredNdc.left > 0 ? extent.left / measuredNdc.left : null,
        right: measuredNdc.right > 0 ? extent.right / measuredNdc.right : null,
        up: measuredNdc.up > 0 ? extent.up / measuredNdc.up : null,
        down: measuredNdc.down > 0 ? extent.down / measuredNdc.down : null,
      }
      const caseData = {
        facingDeg: round((facing * 180) / Math.PI, 2),
        extent: Object.fromEntries(Object.entries(extent).map(([k, v]) => [k, round(v, 4)])),
        measuredNdc: Object.fromEntries(Object.entries(measuredNdc).map(([k, v]) => [k, round(v, 4)])),
        measuredHalfPx: {
          left: round((canvas.width / 2) * measuredNdc.left, 1),
          right: round((canvas.width / 2) * measuredNdc.right, 1),
          up: round((canvas.height / 2) * measuredNdc.up, 1),
          down: round((canvas.height / 2) * measuredNdc.down, 1),
        },
        ratio: Object.fromEntries(Object.entries(ratio).map(([k, v]) => [k, round(v, 3)])),
        canvas: [canvas.width, canvas.height],
        png: path.relative(REPO, file).replaceAll('\\', '/'),
        bboxPx: {
          primaryThreshold: PRIMARY_THRESHOLD,
          bbox: { minX: primary.minX, minY: primary.minY, maxX: primary.maxX, maxY: primary.maxY },
          byThreshold: Object.fromEntries(THRESHOLDS.map((t) => [t, bboxes[t].empty ? { empty: true } : {
            minX: bboxes[t].minX, minY: bboxes[t].minY, maxX: bboxes[t].maxX, maxY: bboxes[t].maxY,
          }])),
        },
      }
      cases.push(caseData)
      log(`  facing ${facingDeg}° (actual ${caseData.facingDeg}°): extent ${JSON.stringify(caseData.extent)} measured ${JSON.stringify(caseData.measuredNdc)} ratio ${JSON.stringify(caseData.ratio)}`)
    }
    const allRatios = cases.flatMap((c) => Object.values(c.ratio).filter((v) => v != null))
    return {
      viewport: [DEMO_W, DEMO_H],
      canvas: [canvas.width, canvas.height],
      primaryThreshold: PRIMARY_THRESHOLD,
      thresholds: THRESHOLDS,
      cases,
      maxRatio: round(Math.max(...allRatios), 3),
      minRatio: round(Math.min(...allRatios), 3),
      // getExtent() is pure geometry now, so the thresholded visible bbox can be
      // a couple of percent larger (bloom + smooth-union bulge). The fixed
      // EDGE_PAD_PX in client-entry covers that; "safe" here means "within a
      // few percent of the measured visible body and never over +25%".
      safe: Math.min(...allRatios) >= 0.97 && Math.max(...allRatios) <= 1.25,
      probeStrictlyConservative: Math.min(...allRatios) >= 1,
    }
  } finally {
    session.close()
  }
}

/* ------------------------------------------------------------------ */
/* item 2: placement against the real plugin harness                   */
/* ------------------------------------------------------------------ */

const CASE_DEFS = [
  { name: 'left', ox: 0, oy: 0.5 },
  { name: 'right', ox: 1, oy: 0.5 },
  { name: 'top', ox: 0.5, oy: 0 },
  { name: 'bottom', ox: 0.5, oy: 1 },
  { name: 'top-left', ox: 0, oy: 0 },
  { name: 'top-right', ox: 1, oy: 0 },
  { name: 'bottom-left', ox: 0, oy: 1 },
  { name: 'bottom-right', ox: 1, oy: 1 },
  { name: 'center', ox: 0.5, oy: 0.5 },
]

function placementSampleExpr() {
  return `(() => {
    const o = window.__dshVoidOctopus
    if (!o) return null
    const host = document.querySelector('.dsh-void-ambient')
    const c = host && host.querySelector('canvas')
    const p = o.pos()
    const s = o.state()
    return {
      pos: p,
      view: s.view,
      lift: s.view.lift,
      box: host ? [host.offsetWidth, host.offsetHeight] : null,
      canvas: c ? [c.width, c.height] : null,
      viewport: [innerWidth, innerHeight],
      boot: !!document.querySelector('.dsh-void-boot'),
    }
  })()`
}

const HARNESS_READY = `(() => {
  const host = document.querySelector('.dsh-void-ambient')
  const c = host && host.querySelector('canvas')
  const boot = host && host.querySelector('.dsh-void-boot')
  return !!window.__dshVoidOctopus && !!host && !!c && !boot
})()`

async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await fsp.writeFile(file, Buffer.from(shot.data, 'base64'))
  return decodePng(Buffer.from(shot.data, 'base64'))
}

async function runPlacement(log, chrome, serverInfo, events, withCoverage) {
  await fsp.mkdir(SHOTS, { recursive: true })
  const viewport = { width: HARNESS_W, height: HARNESS_H }
  const session = await bootPage({
    url: `http://127.0.0.1:${serverInfo.port}/test/harness.html`,
    viewport,
    chrome,
    log,
    readyExpr: HARNESS_READY,
    consoleEvents: events,
    // Random departures lift/turn the body between place() and the screenshot,
    // which is orthogonal to the collision test and was the source of the
    // 50 px outliers. Reduced motion keeps the wander but disables departures.
    reducedMotion: true,
  })
  try {
    const cdp = session.cdp
    // A plain black page makes the body bbox unambiguous; the fake host UI has
    // nothing to do with the overlay and would otherwise dominate the threshold.
    await evaluate(cdp, `(() => {
      const f = document.getElementById('fake-app'); if (f) f.style.display = 'none'
      document.documentElement.style.background = '#000'
      document.body.style.background = '#000'
      return true
    })()`)
    // The engine initialises its probe to FRONT_EXTENT before the arms settle;
    // measuring the very first placement against that transient produced a
    // 36 px gap. Let one idle cycle finish before the 16-case sweep.
    await sleep(3000)
    const cases = []
    for (const depth of [0, 0.95]) {
      for (const def of CASE_DEFS) {
        const cx = def.ox * viewport.width
        const cy = def.oy * viewport.height
        await evaluate(cdp, `window.__dshVoidOctopus.release()`)
        await evaluate(cdp, `window.__dshVoidOctopus.place(${cx}, ${cy}, ${depth})`)
        await sleep(300)
        const settledSample = await evaluate(cdp, placementSampleExpr())
        // Extent shrinks with lambda 2.5 (~0.4 s time constant), so after moving
        // to a different wall the stale larger extent would keep the body a few
        // px inside for ~1 s. Let it converge, then re-place and shoot at the
        // wall: this is the collision result, the 300 ms number is reported too.
        await sleep(3000)
        await evaluate(cdp, `window.__dshVoidOctopus.place(${cx}, ${cy}, ${depth})`)
        await sleep(100)
        const sample = await evaluate(cdp, placementSampleExpr())
        const name = `${def.name}-d${depth}`
        const file = path.join(SHOTS, `${name}.png`)
        const img = await screenshot(cdp, file)
        const bboxes = {}
        for (const t of THRESHOLDS) bboxes[t] = bboxAtThreshold(img, t)
        const primary = bboxes[PRIMARY_THRESHOLD]
        const gaps = primary.empty ? null : edgeGaps(primary, img.width, img.height)
        const pos = sample.pos
        const box = sample.box
        const halfW = (box[0] / 2) * pos.scale
        const halfH = (box[1] / 2) * pos.scale
        const centerX = pos.x + box[0] / 2
        const centerY = pos.y + sample.lift + box[1] / 2
        const ext = pos.extent
        const paddedEdges = {
          left: centerX - ext.left * halfW,
          right: centerX + ext.right * halfW,
          top: centerY - ext.up * halfH,
          bottom: centerY + ext.down * halfH,
        }
        const boundsGaps = {
          left: pos.x - pos.bounds.minX,
          right: pos.bounds.maxX - pos.x,
          top: pos.y - pos.bounds.minY,
          bottom: pos.bounds.maxY - pos.y,
        }
        const settledPos = settledSample.pos
        const settledBoundsGaps = {
          left: settledPos.x - settledPos.bounds.minX,
          right: settledPos.bounds.maxX - settledPos.x,
          top: settledPos.y - settledPos.bounds.minY,
          bottom: settledPos.bounds.maxY - settledPos.y,
        }
        const caseData = {
          name: def.name,
          depth,
          target: { cx: round(cx, 1), cy: round(cy, 1) },
          shot: path.relative(REPO, file).replaceAll('\\', '/'),
          view: {
            active: sample.view.active,
            phase: sample.view.phase,
            facingDeg: round((sample.view.facing * 180) / Math.PI, 2),
            lift: round(sample.lift, 2),
            alpha: round(sample.view.alpha, 3),
          },
          pos: {
            x: round(pos.x, 1),
            y: round(pos.y, 1),
            scale: round(pos.scale, 4),
            depth: round(pos.depth, 4),
            extent: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, round(v, 4)])),
            bounds: Object.fromEntries(Object.entries(pos.bounds).map(([k, v]) => [k, round(v, 1)])),
          },
          lift: round(sample.lift, 2),
          box: box,
          boxRect: [
            round(centerX - (box[0] / 2) * pos.scale, 2),
            round(centerY - (box[1] / 2) * pos.scale, 2),
            round(centerX + (box[0] / 2) * pos.scale, 2),
            round(centerY + (box[1] / 2) * pos.scale, 2),
          ],
          bodyCenter: [round(centerX, 1), round(centerY, 1)],
          paddedEdges: Object.fromEntries(Object.entries(paddedEdges).map(([k, v]) => [k, round(v, 1)])),
          boundsGaps: Object.fromEntries(Object.entries(boundsGaps).map(([k, v]) => [k, round(v, 2)])),
          settledBoundsGaps: Object.fromEntries(Object.entries(settledBoundsGaps).map(([k, v]) => [k, round(v, 2)])),
          settledView: {
            active: settledSample.view.active,
            phase: settledSample.view.phase,
            facingDeg: round((settledSample.view.facing * 180) / Math.PI, 2),
            lift: round(settledSample.lift, 2),
          },
          screenshotGaps: gaps ? Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, round(v, 1)])) : null,
          screenshotBbox: primary.empty ? null : { minX: primary.minX, minY: primary.minY, maxX: primary.maxX, maxY: primary.maxY },
          gapByThreshold: Object.fromEntries(THRESHOLDS.map((t) => [t, bboxes[t].empty ? null : edgeGaps(bboxes[t], img.width, img.height)])),
          insideViewport: gaps ? gaps.left >= 0 && gaps.right >= 0 && gaps.top >= 0 && gaps.bottom >= 0 : null,
          boundsMatchesScreenshot: gaps
            ? {
                left: round((gaps.left - boundsGaps.left), 1),
                right: round((gaps.right - boundsGaps.right), 1),
                top: round((gaps.top - boundsGaps.top), 1),
                bottom: round((gaps.bottom - boundsGaps.bottom), 1),
              }
            : null,
        }
        cases.push(caseData)
        log(`  ${name}: scale ${caseData.pos.scale}, boundsGaps ${JSON.stringify(caseData.boundsGaps)}, screenshotGaps ${JSON.stringify(caseData.screenshotGaps)}, inside=${caseData.insideViewport}`)
      }
    }

    // ---- splay: right wall, then turn the body sideways ----------------
    // The turn is allowed to keep going while the silhouette grows; the test is
    // that the collision re-clamps the body every frame and never cuts it.
    await evaluate(cdp, `window.__dshVoidOctopus.release()`)
    await evaluate(cdp, `window.__dshVoidOctopus.place(innerWidth, innerHeight / 2, 0)`)
    await evaluate(cdp, `window.__dshVoidOctopus.face(90)`)
    const splaySeries = []
    let peak = null
    let peakFile = null
    let peakImg = null
    let peakSample = null
    let splaySample = null
    let splayFile = null
    let splayImg = null
    for (let i = 0; i < 16; i++) {
      await sleep(250)
      const sample = await evaluate(cdp, placementSampleExpr())
      const box = sample.box
      const halfW = (box[0] / 2) * sample.pos.scale
      const halfH = (box[1] / 2) * sample.pos.scale
      const centerX = sample.pos.x + box[0] / 2
      const centerY = sample.pos.y + sample.lift + box[1] / 2
      const ext = sample.pos.extent
      const gaps = {
        left: centerX - ext.left * halfW,
        right: viewport.width - (centerX + ext.right * halfW),
        top: centerY - ext.up * halfH,
        bottom: viewport.height - (centerY + ext.down * halfH),
      }
      const total = ext.left + ext.right + ext.up + ext.down
      const inside = Object.values(gaps).every((g) => g >= -2)
      const ms = (i + 1) * 250
      splaySeries.push({
        ms,
        extent: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, round(v, 4)])),
        paddedGaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, round(v, 1)])),
        inside,
        x: round(sample.pos.x, 1),
      })
      if (!peak || total > peak.totalExtent) {
        peak = { ms, totalExtent: round(total, 4), extent: splaySeries[splaySeries.length - 1].extent, inside }
      }
      if (i === 10) {
        // 2.75 s into the planned turn: the silhouette is at its widest and the
        // body is still being clamped frame by frame.
        peakSample = sample
        peakFile = path.join(SHOTS, 'splay-right-face90-peak.png')
        peakImg = await screenshot(cdp, peakFile)
      }
    }
    // After the turn settles, re-place the splayed body at the right wall and
    // shoot again: this is the "profile silhouette against the wall" case.
    await evaluate(cdp, `window.__dshVoidOctopus.place(innerWidth, innerHeight / 2, 0)`)
    await sleep(250)
    splaySample = await evaluate(cdp, placementSampleExpr())
    splayFile = path.join(SHOTS, 'splay-right-face90.png')
    splayImg = await screenshot(cdp, splayFile)
    const splayBbox = bboxAtThreshold(splayImg, PRIMARY_THRESHOLD)
    const splayGaps = splayBbox.empty ? null : edgeGaps(splayBbox, splayImg.width, splayImg.height)
    const peakBbox = peakImg ? bboxAtThreshold(peakImg, PRIMARY_THRESHOLD) : null
    const peakGaps = peakBbox && !peakBbox.empty ? edgeGaps(peakBbox, peakImg.width, peakImg.height) : null
    const rectOf = (sample) => {
      const bx = sample.box
      const sc = sample.pos.scale
      const cx = sample.pos.x + bx[0] / 2
      const cy = sample.pos.y + sample.lift + bx[1] / 2
      return {
        center: [round(cx, 1), round(cy, 1)],
        scale: round(sc, 4),
        box: [bx[0], bx[1]],
        rect: [
          round(cx - (bx[0] / 2) * sc, 2),
          round(cy - (bx[1] / 2) * sc, 2),
          round(cx + (bx[0] / 2) * sc, 2),
          round(cy + (bx[1] / 2) * sc, 2),
        ],
      }
    }
    const splayRect = rectOf(splaySample)
    const peakRect = peakSample ? rectOf(peakSample) : null
    const splayCase = {
      name: 'splay-right-face90',
      depth: 0,
      shot: path.relative(REPO, splayFile).replaceAll('\\', '/'),
      peakShot: peakFile ? path.relative(REPO, peakFile).replaceAll('\\', '/') : null,
      boxRect: splayRect.rect,
      bodyCenter: splayRect.center,
      scale: splayRect.scale,
      box: splayRect.box,
      view: {
        active: splaySample.view.active,
        phase: splaySample.view.phase,
        facingDeg: round((splaySample.view.facing * 180) / Math.PI, 2),
        lift: round(splaySample.lift, 2),
        alpha: round(splaySample.view.alpha, 3),
      },
      extent: Object.fromEntries(Object.entries(splaySample.pos.extent).map(([k, v]) => [k, round(v, 4)])),
      pos: {
        x: round(splaySample.pos.x, 1),
        y: round(splaySample.pos.y, 1),
        scale: round(splaySample.pos.scale, 4),
        bounds: Object.fromEntries(Object.entries(splaySample.pos.bounds).map(([k, v]) => [k, round(v, 1)])),
      },
      boundsGaps: {
        left: round(splaySample.pos.x - splaySample.pos.bounds.minX, 2),
        right: round(splaySample.pos.bounds.maxX - splaySample.pos.x, 2),
        top: round(splaySample.pos.y - splaySample.pos.bounds.minY, 2),
        bottom: round(splaySample.pos.bounds.maxY - splaySample.pos.y, 2),
      },
      screenshotGaps: splayGaps ? Object.fromEntries(Object.entries(splayGaps).map(([k, v]) => [k, round(v, 1)])) : null,
      insideViewport: splayGaps ? splayGaps.left >= 0 && splayGaps.right >= 0 && splayGaps.top >= 0 && splayGaps.bottom >= 0 : null,
      peak: {
        ...peak,
        boxRect: peakRect ? peakRect.rect : null,
        bodyCenter: peakRect ? peakRect.center : null,
        scale: peakRect ? peakRect.scale : null,
        screenshotGaps: peakGaps ? Object.fromEntries(Object.entries(peakGaps).map(([k, v]) => [k, round(v, 1)])) : null,
        insideViewport: peakGaps ? peakGaps.left >= 0 && peakGaps.right >= 0 && peakGaps.top >= 0 && peakGaps.bottom >= 0 : null,
      },
      allSamplesInside: splaySeries.every((s) => s.inside),
      extentSeries: splaySeries,
    }
    cases.push(splayCase)
    log(`  splay-right-face90: extent ${JSON.stringify(splayCase.extent)}, peak ${JSON.stringify(splayCase.peak)}, screenshotGaps ${JSON.stringify(splayCase.screenshotGaps)}, inside=${splayCase.insideViewport}, allSamplesInside=${splayCase.allSamplesInside}`)

    // ---- dedicated "splayed against the right wall" series ---------------
    // This is the frame the user is most likely to see as "the edge cuts the
    // tentacle": body pinned to the wall while the arms open sideways. Re-place
    // every 400 ms so the collision clamp always uses the current extent, and
    // take a full-page shot each time.
    await evaluate(cdp, `window.__dshVoidOctopus.release()`)
    await evaluate(cdp, `window.__dshVoidOctopus.place(innerWidth, innerHeight / 2, 0)`)
    await evaluate(cdp, `window.__dshVoidOctopus.face(90)`)
    const splayWallFrames = []
    for (let k = 0; k < 8; k++) {
      await sleep(400)
      await evaluate(cdp, `window.__dshVoidOctopus.place(innerWidth, innerHeight / 2, 0)`)
      await sleep(100)
      const sample = await evaluate(cdp, placementSampleExpr())
      const file = path.join(SHOTS, `splay-right-wall-${k}.png`)
      const img = await screenshot(cdp, file)
      const bbox = bboxAtThreshold(img, PRIMARY_THRESHOLD)
      const gaps = !bbox.empty ? edgeGaps(bbox, img.width, img.height) : null
      const box = sample.box
      const scale = sample.pos.scale
      const cx = sample.pos.x + box[0] / 2
      const cy = sample.pos.y + sample.lift + box[0] / 2
      const ext = sample.pos.extent
      splayWallFrames.push({
        k,
        ms: (k + 1) * 400,
        shot: path.relative(REPO, file).replaceAll('\\', '/'),
        scale: round(scale, 4),
        boxRect: [
          round(cx - (box[0] / 2) * scale, 2),
          round(cy - (box[0] / 2) * scale, 2),
          round(cx + (box[0] / 2) * scale, 2),
          round(cy + (box[0] / 2) * scale, 2),
        ],
        bodyCenter: [round(cx, 1), round(cy, 1)],
        extent: Object.fromEntries(Object.entries(ext).map(([x, v]) => [x, round(v, 4)])),
        screenshotGaps: gaps ? Object.fromEntries(Object.entries(gaps).map(([x, v]) => [x, round(v, 1)])) : null,
        insideViewport: gaps ? gaps.left >= 0 && gaps.right >= 0 && gaps.top >= 0 && gaps.bottom >= 0 : null,
      })
    }
    const splayWallWorst = [...splayWallFrames].sort((a, b) => {
      const ea = a.extent.left + a.extent.right, eb = b.extent.left + b.extent.right
      return eb - ea
    })[0]
    const splayRightWall = {
      description: 'right wall + face(90), re-clamped every 400 ms',
      worstFrame: splayWallWorst,
      frames: splayWallFrames,
      allInside: splayWallFrames.every((f) => f.insideViewport),
      minRightGap: Math.min(...splayWallFrames.map((f) => f.screenshotGaps?.right ?? Infinity)),
    }
    log(`  splay-right-wall: worst (widest) frame ${splayWallWorst.ms}ms gaps ${JSON.stringify(splayWallWorst.screenshotGaps)}, min right gap ${splayRightWall.minRightGap}, allInside=${splayRightWall.allInside}`)

    // ---- coverage: 90 s of real wandering -----------------------------
    const allCases = cases
    const peakCase = splayCase.peakShot
      ? {
          ...splayCase,
          name: 'splay-peak',
          shot: splayCase.peakShot,
          screenshotGaps: splayCase.peak.screenshotGaps,
        }
      : null
    const wallCases = cases.filter((c) => c.name !== 'splay-right-face90')
    let coverage = null
    if (withCoverage) {
      // Reload fresh: place() parks the body in "rest" for 60 s, which would
      // eat two thirds of the 90 s window. A fresh page starts with the short
      // 1.2-2.6 s arrival rest and then walks on its own.
      await evaluate(cdp, `(() => { try { localStorage.removeItem('dsh-void-octopus:behavior-v1') } catch (e) {} return true })()`)
      // Restore normal motion for the autonomous coverage run.
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverInfo.port}/test/harness.html` })
      let ready = false
      for (let i = 0; i < 160; i++) {
        ready = await evaluate(cdp, HARNESS_READY).catch(() => false)
        if (ready) break
        await sleep(250)
      }
      if (!ready) throw new Error('harness did not come back after the fresh reload')
      await evaluate(cdp, `(() => {
        const f = document.getElementById('fake-app'); if (f) f.style.display = 'none'
        document.documentElement.style.background = '#000'
        document.body.style.background = '#000'
        return true
      })()`)
      await sleep(400)
      coverage = await runCoverage(cdp, log, 90)
    }

    // ---- labelled GIF --------------------------------------------------
    await evaluate(cdp, GIF_COMPOSE_SOURCE)
    const wallGifCase = {
      ...splayWallWorst,
      name: 'splay-wall',
      depth: 0,
      shot: splayWallWorst.shot,
      screenshotGaps: splayWallWorst.screenshotGaps,
    }
    const gifCases = [...allCases, ...(peakCase ? [peakCase] : []), wallGifCase]
    const gifInfo = await buildCoverageGif(cdp, gifCases, log)

    const sidesAtWall = (name) => {
      if (name === 'left' || name === 'right' || name === 'top' || name === 'bottom') return [name]
      if (name === 'top-left') return ['left', 'top']
      if (name === 'top-right') return ['right', 'top']
      if (name === 'bottom-left') return ['left', 'bottom']
      if (name === 'bottom-right') return ['right', 'bottom']
      return []
    }
    const wallPasses = wallCases
      .filter((c) => c.name !== 'center')
      .map((c) => {
        const sides = sidesAtWall(c.name)
        const gaps = c.screenshotGaps || {}
        return {
          name: c.name,
          depth: c.depth,
          sides,
          gaps: Object.fromEntries(sides.map((s) => [s, gaps[s]])),
          inside: c.insideViewport,
          pass: c.insideViewport && sides.every((s) => gaps[s] >= 5 && gaps[s] <= 16),
          within5to16: c.insideViewport && sides.every((s) => gaps[s] >= 5 && gaps[s] <= 16),
        }
      })
    const result = {
      viewport: [HARNESS_W, HARNESS_H],
      box: allCases[0]?.box || null,
      primaryThreshold: PRIMARY_THRESHOLD,
      thresholds: THRESHOLDS,
      cases: wallCases,
      splay: splayCase,
      splayRightWall,
      coverage,
      gif: gifInfo,
      wallPasses,
      allWallsPass: wallPasses.every((w) => w.pass),
      allWithinExpected5to16: wallPasses.every((w) => w.within5to16),
    }
    await fsp.writeFile(PLACEMENT_CACHE, JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    session.close()
  }
}

async function runCoverage(cdp, log, seconds) {
  const samples = []
  const started = Date.now()
  let nextFormal = 0
  const take = async () => {
    const s = await evaluate(cdp, placementSampleExpr())
    if (!s) return
    const box = s.box
    const halfW = (box[0] / 2) * s.pos.scale
    const halfH = (box[1] / 2) * s.pos.scale
    const centerX = s.pos.x + box[0] / 2
    const centerY = s.pos.y + s.lift + box[1] / 2
    const ext = s.pos.extent
    const edges = {
      left: centerX - ext.left * halfW,
      right: centerX + ext.right * halfW,
      top: centerY - ext.up * halfH,
      bottom: centerY + ext.down * halfH,
    }
    const elapsed = (Date.now() - started) / 1000
    const is5s = elapsed + 0.001 >= nextFormal
    if (is5s) nextFormal += 5
    samples.push({
      t: round(elapsed, 1),
      is5s,
      x: round(s.pos.x, 1),
      y: round(s.pos.y, 1),
      centerX: round(centerX, 1),
      centerY: round(centerY, 1),
      scale: round(s.pos.scale, 3),
      depth: round(s.pos.depth, 3),
      extent: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, round(v, 4)])),
      edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, round(v, 1)])),
      state: { active: s.view.active, phase: s.view.phase, facing: round(s.view.facing, 3), lift: round(s.lift, 2) },
    })
  }
  await take()
  while (Date.now() - started < seconds * 1000) {
    await sleep(500)
    await take()
  }
  const W = HARNESS_W
  const H = HARNESS_H
  const summarize = (rows) => {
    const minGap = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity }
    for (const s of rows) {
      minGap.left = Math.min(minGap.left, s.edges.left)
      minGap.right = Math.min(minGap.right, W - s.edges.right)
      minGap.top = Math.min(minGap.top, s.edges.top)
      minGap.bottom = Math.min(minGap.bottom, H - s.edges.bottom)
    }
    const centerXs = rows.map((s) => s.centerX)
    const centerYs = rows.map((s) => s.centerY)
    return {
      samples: rows.length,
      centerX: [round(Math.min(...centerXs), 1), round(Math.max(...centerXs), 1)],
      centerY: [round(Math.min(...centerYs), 1), round(Math.max(...centerYs), 1)],
      minGapPx: Object.fromEntries(Object.entries(minGap).map(([k, v]) => [k, round(v, 1)])),
      sidesWithin60px: Object.values(minGap).filter((v) => v <= 60).length,
      sidesWithin120px: Object.values(minGap).filter((v) => v <= 120).length,
    }
  }
  // The brief says "sample every 5 s"; 500 ms sampling is reported as well so a
  // wall grazed between two 5 s samples is not missed.
  const formal = samples.filter((s) => s.is5s)
  const reachAll = summarize(samples)
  const reach5s = summarize(formal)
  log(`  coverage 90 s: ${samples.length} samples (${formal.length} at 5 s); body-center x ${reachAll.centerX.join('..')}, y ${reachAll.centerY.join('..')}, min gaps ${JSON.stringify(reachAll.minGapPx)} (5 s subset: ${JSON.stringify(reach5s.minGapPx)})`)
  return { seconds, intervalMs: 500, samples, formalSamples5s: formal.length, reach: reachAll, reach5s }
}

async function buildCoverageGif(cdp, cases, log) {
  const ordered = cases
  const labelFor = (c) => {
    const gaps = c.screenshotGaps || {}
    if (c.name === 'splay-right-face90') return `SPLAY SETTLED · right wall · face(90) · gap R ${gaps.right}px`
    if (c.name === 'splay-peak') return `SPLAY PEAK · right wall · face(90) · gap R ${gaps.right}px`
    if (c.name === 'splay-wall') return `SPLAY @ RIGHT WALL · face(90) · gap R ${gaps.right}px`
    const depth = c.depth.toFixed(2)
    const g = `L ${gaps.left} R ${gaps.right} T ${gaps.top} B ${gaps.bottom}`
    return `${c.name.toUpperCase()} · depth ${depth} · ${g}`
  }
  const items = ordered.map((c) => ({
    url: `http://127.0.0.1:${serverPortForGif}/_scratch/edge-shots/${path.basename(c.shot)}`,
    label: labelFor(c),
  }))
  const pngs = await evaluate(cdp, `window.__EDGE_GIF__.compose(${JSON.stringify(items)}, 640, 400)`, { awaitPromise: true })
  const frameImgs = pngs.map((u) => decodePng(dataUrlToBuffer(u)))
  const gifFrames = []
  for (const img of frameImgs) {
    for (let i = 0; i < 3; i++) gifFrames.push(img)
  }
  const gif = encodeGif(gifFrames, { delayCs: 10 })
  const file = path.join(DESIGN, 'edge-coverage.gif')
  await fsp.writeFile(file, gif)
  const info = { file: path.relative(REPO, file).replaceAll('\\', '/'), width: frameImgs[0].width, height: frameImgs[0].height, frames: gifFrames.length, distinctShots: frameImgs.length, fps: 10, loop: true, bytes: gif.length }
  log(`  wrote ${info.file} (${info.width}x${info.height}, ${info.frames} frames / ${info.distinctShots} shots, ${(info.bytes / 1024).toFixed(0)} KB)`)
  return info
}

/* ------------------------------------------------------------------ */
/* clip check: is the body cut by the 500 px canvas edge?              */
/* ------------------------------------------------------------------ */

function analyzeClipFrame(img, frame) {
  const { width, height, data } = img
  const [x0f, y0f, x1f, y1f] = frame.rect
  const x0 = Math.round(x0f)
  const y0 = Math.round(y0f)
  const x1 = Math.round(x1f)
  const y1 = Math.round(y1f)
  // clamp to the screenshot
  const bx0 = Math.max(0, Math.min(width - 1, x0))
  const by0 = Math.max(0, Math.min(height - 1, y0))
  const bx1 = Math.max(bx0 + 1, Math.min(width, x1))
  const by1 = Math.max(by0 + 1, Math.min(height, y1))
  const stat = (i, mode) => {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (mode === 'lum') return 0.299 * r + 0.587 * g + 0.114 * b
    return Math.max(r, g, b)
  }
  const thresholds = [
    { key: 'body60', mode: 'max', value: 60 },
    { key: 'body120', mode: 'max', value: 120 },
    { key: 'glow8', mode: 'lum', value: 8 },
    { key: 'glow2', mode: 'lum', value: 2 },
  ]
  // A box edge that lies outside the screenshot cannot be inspected: on that
  // side the canvas itself is off-screen, so the viewport clips the body first
  // (which is exactly what "body against the wall" means). Only exposed canvas
  // edges can prove a hard canvas cut.
  const boxVisible = {
    left: x0f >= 0 && x0f < width,
    right: x1f > 0 && x1f <= width,
    top: y0f >= 0 && y0f < height,
    bottom: y1f > 0 && y1f <= height,
  }
  const out = { name: frame.name, box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, boxFloat: [x0f, y0f, x1f, y1f], boxVisible, thresholds: {} }
  for (const thr of thresholds) {
    let minX = Infinity
    let maxX = -1
    let minY = Infinity
    let maxY = -1
    let count = 0
    let outside = 0
    const leftDist = new Float64Array(by1 - by0).fill(Infinity)
    const rightDist = new Float64Array(by1 - by0).fill(Infinity)
    const topDist = new Float64Array(bx1 - bx0).fill(Infinity)
    const bottomDist = new Float64Array(bx1 - bx0).fill(Infinity)
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = (y * width + x) * 4
        if (stat(i, thr.mode) <= thr.value) continue
        count++
        const dLeft = x - bx0
        const dRight = bx1 - 1 - x
        const dTop = y - by0
        const dBottom = by1 - 1 - y
        if (dLeft < leftDist[y - by0]) leftDist[y - by0] = dLeft
        if (dRight < rightDist[y - by0]) rightDist[y - by0] = dRight
        if (dTop < topDist[x - bx0]) topDist[x - bx0] = dTop
        if (dBottom < bottomDist[x - bx0]) bottomDist[x - bx0] = dBottom
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    // pixels outside the reported box (should be none if the canvas really ends there)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= bx0 && x < bx1 && y >= by0 && y < by1) continue
        const i = (y * width + x) * 4
        if (stat(i, thr.mode) > thr.value) outside++
      }
    }
    const longestRun = (arr) => {
      let best = 0
      let cur = 0
      let bestStart = -1
      let start = -1
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] <= 1) {
          if (cur === 0) start = i
          cur++
          if (cur > best) {
            best = cur
            bestStart = start
          }
        } else {
          cur = 0
        }
      }
      return { longest: best, start: bestStart }
    }
    const sides = {
      left: longestRun(leftDist),
      right: longestRun(rightDist),
      top: longestRun(topDist),
      bottom: longestRun(bottomDist),
    }
    const distances = count
      ? {
          left: boxVisible.left ? minX - bx0 : null,
          right: boxVisible.right ? bx1 - 1 - maxX : null,
          top: boxVisible.top ? minY - by0 : null,
          bottom: boxVisible.bottom ? by1 - 1 - maxY : null,
        }
      : null
    // For the low thresholds a run of 30 is not enough: a glow halo naturally
    // touches the edge. For body thresholds a >=30 px straight run means the
    // drawn limbs are cut by the canvas. Off-screen box sides are ignored.
    const bodyCutSides = Object.entries(sides)
      .filter(([k, v]) => boxVisible[k] && v.longest >= 30)
      .map(([k, v]) => ({ side: k, run: v.longest, start: v.start }))
    out.thresholds[thr.key] = {
      value: thr.value,
      pixels: count,
      litOutsideBox: outside,
      bbox: count ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
      distances,
      longestEdgeRun: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, v.longest])),
      bodyCutSides,
    }
  }
  const body = out.thresholds.body60
  const visibleDists = Object.entries(body.distances || {}).filter(([, d]) => d != null)
  const darkDists = Object.entries(out.thresholds.glow2.distances || {}).filter(([, d]) => d != null)
  out.verdict = {
    clipped: body.litOutsideBox > 0 || body.bodyCutSides.length > 0,
    reachesEdge: visibleDists.some(([, d]) => d <= 1),
    darkReachesEdge: darkDists.some(([, d]) => d <= 1),
    darkOutside: out.thresholds.glow2.litOutsideBox,
  }
  return out
}

async function runClipCheck(log) {
  const reportPath = path.join(DESIGN, 'edge-report.json')
  const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
  const placement = report.placement
  if (!placement) throw new Error('edge-report.json has no placement section')
  const frames = []
  for (const c of placement.cases) {
    frames.push({
      name: `${c.name} · d${c.depth}`,
      file: path.resolve(REPO, c.shot),
      rect: c.boxRect,
      bodyCenter: c.bodyCenter,
      scale: c.pos.scale,
    })
  }
  if (placement.splay?.boxRect) {
    frames.push({
      name: 'splay settled',
      file: path.resolve(REPO, placement.splay.shot),
      rect: placement.splay.boxRect,
      bodyCenter: placement.splay.bodyCenter,
      scale: placement.splay.scale,
    })
  }
  if (placement.splay?.peak?.boxRect) {
    frames.push({
      name: 'splay peak',
      file: path.resolve(REPO, placement.splay.peakShot),
      rect: placement.splay.peak.boxRect,
      bodyCenter: placement.splay.peak.bodyCenter,
      scale: placement.splay.peak.scale,
    })
  }
  for (const f of placement.splayRightWall?.frames || []) {
    frames.push({
      name: `splay-wall-${f.ms}`,
      file: path.resolve(REPO, f.shot),
      rect: f.boxRect,
      bodyCenter: f.bodyCenter,
      scale: f.scale,
    })
  }
  const results = []
  for (const frame of frames) {
    const img = decodePng(await fsp.readFile(frame.file))
    results.push(analyzeClipFrame(img, frame))
  }
  // viewport-edge gaps (body bbox to the actual screen edge) come from the
  // placement report; the canvas-edge distances above come from the pixels.
  const vpGapsByName = new Map()
  for (const c of placement.cases) vpGapsByName.set(`${c.name} · d${c.depth}`, c.screenshotGaps)
  if (placement.splay?.screenshotGaps) vpGapsByName.set('splay settled', placement.splay.screenshotGaps)
  if (placement.splay?.peak?.screenshotGaps) vpGapsByName.set('splay peak', placement.splay.peak.screenshotGaps)
  for (const f of placement.splayRightWall?.frames || []) vpGapsByName.set(`splay-wall-${f.ms}`, f.screenshotGaps)
  for (const r of results) r.viewportGaps = vpGapsByName.get(r.name) || null
  const clipped = results.filter((r) => r.verdict.clipped)
  const reaches = results.filter((r) => r.verdict.reachesEdge)
  const darkReaches = results.filter((r) => r.verdict.darkReachesEdge)

  // 1) apparent-size regression against the old 500 px canvas shots
  const oldShots = path.join(SCRATCH, 'edge-shots-500')
  const oldReportPath = path.join(SCRATCH, 'edge-report-500.json')
  const oldReport = fs.existsSync(oldReportPath) ? JSON.parse(fs.readFileSync(oldReportPath, 'utf8')) : null
  const oldCase = (name, depth) =>
    oldReport?.placement?.cases?.find((c) => c.name === name && Math.abs(c.depth - depth) < 1e-9) || null
  const oldBbox = (file) => {
    const full = path.join(oldShots, file)
    if (!fs.existsSync(full)) return null
    const img = decodePng(fs.readFileSync(full))
    const b = bboxAtThreshold(img, PRIMARY_THRESHOLD)
    return b.empty ? null : b
  }
  const sizeRegression = []
  const sizeItems = [
    // The Lead explicitly dropped the d0.95 bbox regression: the old frame was
    // captured mid-departure with a different arm pose, so it is not the same
    // silhouette. Keep d0 as an informational check only.
    { name: 'center · d0', oldFile: 'center-d0.png', base: 'center', depth: 0, informational: true },
  ]
  for (const item of sizeItems) {
    const frame = results.find((r) => r.name === item.name)
    const current = frame?.thresholds.body60.bbox
    const old = oldBbox(item.oldFile)
    const oldState = oldCase(item.base, item.depth)
    const newCase = placement.cases.find((c) => c.name === item.base && Math.abs(c.depth - item.depth) < 1e-9)
    if (!current || !old) {
      sizeRegression.push({ name: item.name, old: old || null, current: current || null, skipped: true })
      continue
    }
    const oldDeparture = Boolean(oldState?.view?.active)
    const newDeparture = Boolean(newCase?.view?.active)
    const comparable = !oldDeparture && !newDeparture
    const widthRatio = current.width / old.width
    const heightRatio = current.height / old.height
    sizeRegression.push({
      name: item.name,
      old: { width: old.width, height: old.height, departureActive: oldDeparture },
      current: { width: current.width, height: current.height, departureActive: newDeparture },
      widthRatio: round(widthRatio, 4),
      heightRatio: round(heightRatio, 4),
      comparable,
      pass: comparable ? Math.abs(widthRatio - 1) < 0.03 && Math.abs(heightRatio - 1) < 0.03 : null,
    })
  }

  // 2) every sampled extent must now fit inside half a canvas (<= 0.97)
  const extents = []
  const collect = (e) => { if (e) for (const k of ['left', 'right', 'up', 'down']) if (Number.isFinite(e[k])) extents.push(e[k]) }
  for (const c of placement.cases) collect(c.pos.extent)
  collect(placement.splay.extent)
  collect(placement.splay.peak?.extent)
  for (const c of report.projection?.cases || []) collect(c.extent)
  // Normal-motion coverage is where the widest poses actually happen.
  for (const run of placement.coverage?.runs || []) {
    for (const s of run.samples || []) collect(s.extent)
  }
  const extentMax = extents.length ? Math.max(...extents) : null

  // 3) the Lead's acceptance set: every placement + splay peak/settled.
  const TARGET_FRAMES = [
    ...placement.cases.map((c) => `${c.name} · d${c.depth}`),
    'splay settled',
    'splay peak',
    ...(placement.splayRightWall?.frames || []).map((f) => `splay-wall-${f.ms}`),
  ]
  const targetChecks = TARGET_FRAMES.map((name) => {
    const r = results.find((x) => x.name === name)
    if (!r) return { name, missing: true, pass: false }
    const body = r.thresholds.body60
    const distances = Object.fromEntries(Object.entries(body.distances || {}).filter(([, d]) => d != null))
    const minDist = Math.min(...Object.values(distances))
    const viewportGaps = r.viewportGaps || null
    const viewportPass = viewportGaps != null && Object.values(viewportGaps).every((g) => g >= 1)
    const canvasPass = !r.verdict.clipped && body.bodyCutSides.length === 0 && minDist >= 1
    return {
      name,
      distances,
      boxVisible: r.boxVisible,
      longestBodyRun: body.longestEdgeRun,
      minDistancePx: minDist,
      straightCut: body.bodyCutSides.length > 0,
      viewportGaps,
      viewportPass,
      canvasPass,
      pass: viewportPass && canvasPass,
    }
  })
  const viewportFails = results.filter(
    (r) => r.viewportGaps == null || Object.values(r.viewportGaps).some((g) => g < 1),
  )
  const canvasFails = results.filter((r) => {
    const body = r.thresholds.body60
    const dists = Object.values(body.distances || {}).filter((d) => d != null)
    return r.verdict.clipped || body.bodyCutSides.length > 0 || dists.some((d) => d < 1)
  })

  log('box-edge straight-line check (body threshold maxRGB>60, glow lum>2)')
  for (const r of results) {
    const body = r.thresholds.body60
    const dark = r.thresholds.glow2
    log(
      `  ${r.name.padEnd(26)} box ${r.box.x0},${r.box.y0},${r.box.x1},${r.box.y1} ` +
        `bodyDist ${JSON.stringify(body.distances)} runs ${JSON.stringify(body.longestEdgeRun)} ` +
        `vpGaps ${JSON.stringify(r.viewportGaps)} ` +
        `darkDist ${JSON.stringify(dark.distances)} outside ${body.litOutsideBox}/${dark.litOutsideBox} ` +
        `clip=${r.verdict.clipped}`,
    )
  }
  for (const s of sizeRegression) log(`  size ${s.name}: skipped/informational (arm-pose noise, Lead decision)`)
  for (const t of targetChecks) {
    if (!t.pass) log(`  TARGET FAIL ${t.name}: minDist ${t.minDistancePx} run ${JSON.stringify(t.longestBodyRun)} vp ${JSON.stringify(t.viewportGaps)} straightCut ${t.straightCut}`)
  }
  log(`  max extent over all samples: ${extentMax}`)
  const out = {
    generatedAt: new Date().toISOString(),
    report: 'design/edge-report.json',
    criteria: {
      viewport: 'body bbox at least 1 px from each viewport edge',
      canvas: 'no body-threshold straight run at an exposed canvas edge; outermost body pixel >= 1 px from every exposed canvas edge',
      extent: 'max sampled extent <= 0.97 NDC (flag > 0.99)',
      sizeRegression: 'skipped: fixed-pose arm animation makes per-frame bbox a noisy size proxy (Lead decision)',
    },
    bodyThreshold: 'maxRGB>60',
    glowThreshold: 'luminance>2',
    frames: results,
    clippedFrames: clipped.map((r) => r.name),
    reachesEdgeFrames: reaches.map((r) => r.name),
    darkReachesEdgeFrames: darkReaches.map((r) => r.name),
    viewportFails: viewportFails.map((r) => r.name),
    canvasFails: canvasFails.map((r) => r.name),
    viewportNotClipped: viewportFails.length === 0,
    canvasNotClipped: clipped.length === 0 && canvasFails.length === 0,
    sizeRegression: {
      skipped: true,
      note: 'Lead decision: fixed-pose arm animation makes per-frame bbox a noisy apparent-size proxy; the FOV/box change is checked structurally (FOV_SCALE 1.25, base box 625).',
    },
    extentMax,
    extentWithin097: extentMax != null && extentMax <= 0.97,
    extentAbove099: extentMax != null && extentMax > 0.99,
    targetChecks,
    targetsPass: targetChecks.every((t) => t.pass),
  }
  out.conclusion =
    out.viewportNotClipped && out.canvasNotClipped && out.targetsPass
      ? `no clipping: body bbox stays >=1 px from every viewport edge, no body pixels reach an exposed canvas edge (all straight-run counts 0, min exposed distance ${Math.min(...targetChecks.map((t) => t.minDistancePx))} px), max extent ${extentMax}` +
        (out.extentAbove099 ? ' — WARNING extent > 0.99, FOV may need 1.35' : '')
      : `clipping still present: viewportFails [${out.viewportFails.join(', ')}], canvasFails [${out.canvasFails.join(', ')}]`
  const file = path.join(DESIGN, 'edge-clip-check.json')
  await fsp.writeFile(file, JSON.stringify(out, null, 2) + '\n')
  log(`wrote ${path.relative(REPO, file)}`)
  log(`conclusion: ${out.conclusion}`)
  return out
}

/* ------------------------------------------------------------------ */
/* coverage-only pass: several independent 90 s walks                  */
/* ------------------------------------------------------------------ */

async function runCoverageSessions(log, chrome, serverInfo, events, count = 2) {
  const viewport = { width: HARNESS_W, height: HARNESS_H }
  const session = await bootPage({
    url: `http://127.0.0.1:${serverInfo.port}/test/harness.html`,
    viewport,
    chrome,
    log,
    readyExpr: HARNESS_READY,
    consoleEvents: events,
    reducedMotion: false,
  })
  const hideUi = async (cdp) => {
    await evaluate(cdp, `(() => {
      const f = document.getElementById('fake-app'); if (f) f.style.display = 'none'
      document.documentElement.style.background = '#000'
      document.body.style.background = '#000'
      return true
    })()`)
  }
  try {
    const cdp = session.cdp
    const runs = []
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        await evaluate(cdp, `(() => { try { localStorage.removeItem('dsh-void-octopus:behavior-v1') } catch (e) {} return true })()`)
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverInfo.port}/test/harness.html` })
        let ready = false
        for (let k = 0; k < 160; k++) {
          ready = await evaluate(cdp, HARNESS_READY).catch(() => false)
          if (ready) break
          await sleep(250)
        }
        if (!ready) throw new Error('harness did not come back for coverage run ' + (i + 1))
      }
      await hideUi(cdp)
      await sleep(400)
      log(`  coverage walk ${i + 1}/${count} (90 s, fresh behavior state)`)
      runs.push(await runCoverage(cdp, log, 90))
    }
    const combinedMin = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity }
    for (const run of runs) {
      for (const [k, v] of Object.entries(run.reach.minGapPx)) {
        if (v != null && v < combinedMin[k]) combinedMin[k] = v
      }
    }
    const combinedReach = {
      runs: runs.length,
      secondsEach: 90,
      minGapPx: Object.fromEntries(Object.entries(combinedMin).map(([k, v]) => [k, round(v, 1)])),
      sidesWithin60px: Object.values(combinedMin).filter((v) => v <= 60).length,
      sidesWithin120px: Object.values(combinedMin).filter((v) => v <= 120).length,
    }
    log(`  combined: ${combinedReach.sidesWithin60px}/4 sides within 60 px, min gaps ${JSON.stringify(combinedReach.minGapPx)}`)
    return { runs, combinedReach }
  } finally {
    session.close()
  }
}

/* ------------------------------------------------------------------ */
/* gif composer page helper                                            */
/* ------------------------------------------------------------------ */

const GIF_COMPOSE_SOURCE = `(() => {
  const load = (url) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image failed: ' + url))
    img.src = url
  })
  window.__EDGE_GIF__ = {
    async compose(items, width, height) {
      const HEADER = 28
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height + HEADER
      const ctx = canvas.getContext('2d')
      const out = []
      for (const item of items) {
        const img = await load(item.url)
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height + HEADER)
        ctx.fillStyle = '#c8efff'
        ctx.font = '600 15px ui-sans-serif, "Segoe UI", sans-serif'
        ctx.textBaseline = 'top'
        ctx.fillText(item.label, 10, 7)
        ctx.drawImage(img, 0, HEADER, width, height)
        out.push(canvas.toDataURL('image/png'))
      }
      return out
    },
  }
})()`

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

let serverPortForGif = 0

function parseArgs(argv) {
  const opts = { mode: 'all', chrome: null }
  for (const arg of argv) {
    if (arg === 'projection' || arg === 'placement' || arg === 'coverage' || arg === 'clipcheck' || arg === 'all') opts.mode = arg
    else if (arg.startsWith('--chrome=')) opts.chrome = arg.slice(9)
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const USAGE = `Usage:
  node scripts/capture-edge.mjs all
  node scripts/capture-edge.mjs projection
  node scripts/capture-edge.mjs placement
  node scripts/capture-edge.mjs coverage

Requires demo/bundle.js and client.js to be rebuilt from the 0.9.29 src.
Writes design/edge-report.json, design/edge-coverage.gif, design/edge-projection-*.png
and full-size screenshots under .scratch-verify/edge-shots/.`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
  const started = Date.now()
  await fsp.mkdir(DESIGN, { recursive: true })
  await fsp.mkdir(SHOTS, { recursive: true })
  const chromeList = chromeCandidates(opts.chrome)
  if (!chromeList.length) throw new Error('no cached Chromium found; pass --chrome=<path>')
  const chrome = chromeList[0]
  const pkg = JSON.parse(await fsp.readFile(path.join(REPO, 'package.json'), 'utf8'))
  const demoBundle = path.join(REPO, 'demo', 'bundle.js')
  const clientBundle = path.join(REPO, 'client.js')
  const meta = {
    version: pkg.version,
    gitHead: (() => {
      try {
        return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      } catch {
        return null
      }
    })(),
    demoBundle: { file: 'demo/bundle.js', sha256: sha256(await fsp.readFile(demoBundle)), bytes: (await fsp.stat(demoBundle)).size },
    clientBundle: { file: 'client.js', sha256: sha256(await fsp.readFile(clientBundle)), bytes: (await fsp.stat(clientBundle)).size },
    chrome,
    generatedAt: new Date().toISOString(),
  }

  const { server, port } = await startServer(REPO)
  serverPortForGif = port
  const consoleEvents = []
  const report = { meta, mode: opts.mode, viewports: { demo: [DEMO_W, DEMO_H], harness: [HARNESS_W, HARNESS_H] } }
  if (opts.mode === 'clipcheck') {
    try {
      const clip = await runClipCheck(log)
      console.log('')
      console.log('=== CLIP CHECK SUMMARY ===')
      console.log(`frames ${clip.frames.length}, clippedFrames ${clip.clippedFrames.length}, viewportNotClipped ${clip.viewportNotClipped}, canvasNotClipped ${clip.canvasNotClipped}, targetsPass ${clip.targetsPass}`)
      console.log(`extentMax ${clip.extentMax} (<=0.97: ${clip.extentWithin097}, >0.99: ${clip.extentAbove099})`)
      console.log(`viewportFails [${clip.viewportFails.join(', ')}] canvasFails [${clip.canvasFails.join(', ')}]`)
      console.log(`conclusion: ${clip.conclusion}`)
      return
    } finally {
      server.close()
    }
  }
  if (opts.mode === 'coverage') {
    try {
      const reportPath = path.join(DESIGN, 'edge-report.json')
      const existing = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
      const coverage = await runCoverageSessions(log, chrome, { port }, consoleEvents, 2)
      existing.generatedAt = new Date().toISOString()
      existing.placement = existing.placement || {}
      existing.placement.coverage = coverage
      existing.console = classifyConsole(consoleEvents)
      await fsp.writeFile(reportPath, JSON.stringify(existing, null, 2) + '\n')
      log(`wrote ${path.relative(REPO, reportPath)} (coverage updated)`)
      log('')
      log('=== COVERAGE SUMMARY ===')
      for (let i = 0; i < coverage.runs.length; i++) {
        const r = coverage.runs[i]
        log(`  walk ${i + 1}: center x ${r.reach.centerX.join('..')}, y ${r.reach.centerY.join('..')}, ` +
            `${r.reach.sidesWithin60px}/4 sides within 60 px, min gaps ${JSON.stringify(r.reach.minGapPx)} (5 s subset ${r.reach5s.sidesWithin60px}/4)`)
      }
      log(`  combined: ${coverage.combinedReach.sidesWithin60px}/4 sides within 60 px, min gaps ${JSON.stringify(coverage.combinedReach.minGapPx)}`)
      return
    } finally {
      server.close()
    }
  }
  try {
    if (opts.mode === 'projection' || opts.mode === 'all') {
      log('=== item 1: demo extent probe vs measured bbox ===')
      report.projection = await runProjection(log, chrome, { port }, consoleEvents)
    }
    if (opts.mode === 'placement' || opts.mode === 'coverage' || opts.mode === 'all') {
      log('=== item 2/3: real plugin placement' + (opts.mode === 'placement' ? ' ===' : ' + 90 s coverage ==='))
      const harness = await runPlacement(
        log,
        chrome,
        { port },
        consoleEvents,
        opts.mode === 'coverage' || opts.mode === 'all',
      )
      report.placement = harness
    }
    report.console = classifyConsole(consoleEvents)
    const reportFile = path.join(DESIGN, 'edge-report.json')
    await fsp.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
    log(`wrote ${path.relative(REPO, reportFile)}`)
    log('')
    log('=== EDGE SUMMARY ===')
    if (report.projection) log(`projection: max ratio ${report.projection.maxRatio} (safe=${report.projection.safe})`)
    if (report.placement) {
      const passes = report.placement.wallPasses
      const gaps = passes.flatMap((w) => Object.values(w.gaps || {}))
      log(`placement: ${passes.length} wall/corner cases, wall-side gaps ${Math.min(...gaps)}..${Math.max(...gaps)} px, allPass=${report.placement.allWallsPass}`)
      log(`splay: inside=${report.placement.splay.insideViewport}, gaps ${JSON.stringify(report.placement.splay.screenshotGaps)}`)
      if (report.placement.coverage) {
        log(`coverage: ${report.placement.coverage.reach.sidesWithin60px}/4 sides within 60 px, min gaps ${JSON.stringify(report.placement.coverage.reach.minGapPx)}`)
      } else {
        log('coverage: skipped in placement mode')
      }
      log(`gif: ${report.placement.gif.file} (${(report.placement.gif.bytes / 1024).toFixed(0)} KB)`)
    }
    log(`console: ${report.console.errors.length} error group(s), ${report.console.warnings.length} warning group(s)`)
    for (const e of report.console.errors.slice(0, 8)) log(`  ERROR ${e.source}/${e.level} x${e.count}: ${e.text}`)
    for (const w of report.console.warnings.slice(0, 8)) log(`  WARN  ${w.source}/${w.level} x${w.count}: ${w.text}`)
    log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } finally {
    server.close()
  }
}

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

main().catch((err) => {
  console.error('capture-edge FAILED:', err?.stack || err)
  process.exitCode = 1
})

