/**
 * Smoke test: the plugin mounts, registers its routes and tools, and its
 * storage round-trips — all without a live homeserver.
 *
 * Run: node test/smoke.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-matrix-smoke-'))

/** A minimal Cordis-ish context: enough surface for `apply` to run. */
function makeContext() {
  const routes = []
  const tools = []
  const listeners = []
  const effects = []
  const services = {
    webServer: {
      register(definition) {
        routes.push(definition)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    sessionController: {
      async prompt() {},
      async inspect() {
        return { meta: { cwd: home } }
      },
    },
    attachments: { imageLimits: { maxImageBytes: 5 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg'] } },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    inject(deps, callback) {
      const scope = { ...ctx, webServer: services.webServer }
      callback(scope)
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  }
  return { ctx, routes, tools, listeners, effects }
}

const { apply } = await import('../index.js')
const { ctx, routes, tools, listeners } = makeContext()

apply(ctx, { home })

// --- routes ---------------------------------------------------------------
const paths = routes.map((route) => route.path)
for (const expected of [
  '/dsh-matrix-bridge/state',
  '/dsh-matrix-bridge/connection',
  '/dsh-matrix-bridge/login',
  '/dsh-matrix-bridge/bind',
  '/dsh-matrix-bridge/unbind',
  '/dsh-matrix-bridge/options',
  '/dsh-matrix-bridge/rooms',
  '/dsh-matrix-bridge/test',
  '/dsh-matrix-bridge/send',
  '/dsh-matrix-bridge/deps',
  '/dsh-matrix-bridge/deps/install',
]) {
  assert.ok(paths.includes(expected), `missing route ${expected}`)
}

// --- tools ----------------------------------------------------------------
const toolNames = tools.map((tool) => tool.name).sort()
assert.deepEqual(toolNames, ['matrix_rooms', 'matrix_send'])
for (const tool of tools) {
  assert.equal(tool.parameters.type, 'object')
  assert.equal(typeof tool.execute, 'function')
}

// --- reply capture listener ----------------------------------------------
assert.ok(
  listeners.some((entry) => entry.event === 'session/event'),
  'session/event listener not registered',
)

// --- state route answers without a connection ----------------------------
const stateRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/state')
const response = await callRoute(stateRoute, { method: 'GET', url: '/dsh-matrix-bridge/state?sessionId=abc' })
assert.equal(response.status, 200)
assert.equal(response.body.ok, true)
assert.equal(response.body.connection.connected, false)
assert.equal(response.body.binding, null)
assert.equal(response.body.canDeliver, true)

// --- bind / unbind round-trip --------------------------------------------
const bindRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/bind')
const bound = await callRoute(bindRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/bind',
  body: { sessionId: 'session-1', roomId: '!room:example.org', roomName: '测试房间' },
})
assert.equal(bound.status, 200, `bind failed: ${JSON.stringify(bound.body)}`)
assert.equal(bound.body.binding.roomId, '!room:example.org')

const afterBind = await callRoute(stateRoute, { method: 'GET', url: '/dsh-matrix-bridge/state?sessionId=session-1' })
assert.equal(afterBind.body.binding.roomName, '测试房间')

const optionsRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/options')
const toggled = await callRoute(optionsRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/options',
  body: { sessionId: 'session-1', mentionOnly: true },
})
assert.equal(toggled.body.binding.mentionOnly, true)

const unbindRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/unbind')
const unbound = await callRoute(unbindRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/unbind',
  body: { sessionId: 'session-1' },
})
assert.equal(unbound.body.binding, null)

// --- persistence ----------------------------------------------------------
const stored = JSON.parse(fs.readFileSync(path.join(home, 'matrix-bridge', 'bindings.json'), 'utf8'))
assert.deepEqual(stored, {}, 'unbind should leave an empty binding map on disk')

// --- deps route reports the installed crypto stack -----------------------
const depsRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/deps')
const deps = await callRoute(depsRoute, { method: 'GET', url: '/dsh-matrix-bridge/deps' })
assert.equal(deps.body.ok, true)
assert.equal(deps.body.deps.installed, true, 'matrix-bot-sdk should be installed')
assert.equal(deps.body.deps.loadable, true, 'matrix-bot-sdk should load')
assert.equal(deps.body.deps.nativeInstalled, true, 'native crypto module should be present')

fs.rmSync(home, { recursive: true, force: true })
console.log('smoke: ok — routes, tools, listener, bind round-trip, deps all pass')

/* ------------------------------------------------------------ helpers */

async function callRoute(route, { method, url, body }) {
  const req = {
    method,
    url,
    headers: { host: 'localhost' },
    on(event, handler) {
      // Drive the real data/end handlers so `readBody` sees actual bytes.
      if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
      return req
    },
  }
  const captured = { status: 0, body: null }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(text) {
      captured.body = text === undefined ? null : JSON.parse(text)
    },
  }
  await route.handler(req, res)
  return captured
}
