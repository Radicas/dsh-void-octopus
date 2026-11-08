/**
 * Release gate for the generated client bundle: catches the two mistakes that
 * actually break a DSH client plugin — a missing loader wrapper, and React or
 * three accidentally externalized/bundled into the wrong side.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const read = (file) => readFileSync(resolve(root, file), 'utf8')

const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.name, 'dsh-void-octopus')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web')
assert.equal(pkg.dsh?.client?.immediately, true)

const patch = read('cordis.patch.yml')
assert.match(patch, /id: dsh-void-octopus/)
assert.match(patch, /name: 'dsh-void-octopus'/)

const client = read('client.js')
const size = statSync(resolve(root, 'client.js')).size
assert.ok(size > 100_000, `client.js is suspiciously small: ${size} bytes`)
assert.ok(size < 1_600_000, `client.js is suspiciously large: ${size} bytes`)
assert.match(client, /__ModuleLoader__\.load/)
assert.match(client, /id: 'dsh-void-octopus'/)
assert.match(client, /require\("react"\)/, 'React must stay external to share the host instance')
assert.doesNotMatch(client, /require\("three"\)/, 'three must be bundled into the client, not externalized')
assert.match(client, /dsh-void-ambient/)
assert.match(client, /mix-blend-mode: screen/)

const demoExists = statSync(resolve(root, 'demo/index.html')).isFile()
assert.ok(demoExists, 'demo/index.html missing')

console.log(`ok: client ${(size / 1024).toFixed(1)} KiB, bundle patch, manifest, demo`)
