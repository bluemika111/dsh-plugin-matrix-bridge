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
assert.deepEqual(response.body.binding, [], 'an unbound Session reports an empty binding list')
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
assert.equal(afterBind.body.binding.length, 1)
assert.equal(afterBind.body.binding[0].roomName, '测试房间')

// A second room on the same Session: DM + group must coexist.
const bound2 = await callRoute(bindRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/bind',
  body: { sessionId: 'session-1', roomId: '!room2:example.org', roomName: '第二个房间' },
})
assert.equal(bound2.status, 200)
assert.equal(bound2.body.bindings.length, 2, 'binding a second room must append, not replace')

const afterSecond = await callRoute(stateRoute, { method: 'GET', url: '/dsh-matrix-bridge/state?sessionId=session-1' })
assert.equal(afterSecond.body.binding.length, 2)

// Options are per room: toggling one must not touch the other.
const optionsRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/options')
const toggled = await callRoute(optionsRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/options',
  body: { sessionId: 'session-1', roomId: '!room2:example.org', mentionOnly: true },
})
assert.equal(toggled.body.binding.mentionOnly, true)
assert.equal(toggled.body.bindings.length, 2)
const untouched = toggled.body.bindings.find((item) => item.roomId === '!room:example.org')
assert.equal(untouched.mentionOnly, false, 'the other room keeps its own options')

// Unbind one room, then the rest.
const unbindRoute = routes.find((route) => route.path === '/dsh-matrix-bridge/unbind')
const unboundOne = await callRoute(unbindRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/unbind',
  body: { sessionId: 'session-1', roomId: '!room:example.org' },
})
assert.equal(unboundOne.body.binding.length, 1)
assert.equal(unboundOne.body.binding[0].roomId, '!room2:example.org')

const unbound = await callRoute(unbindRoute, {
  method: 'POST',
  url: '/dsh-matrix-bridge/unbind',
  body: { sessionId: 'session-1' },
})
assert.deepEqual(unbound.body.binding, [])

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
