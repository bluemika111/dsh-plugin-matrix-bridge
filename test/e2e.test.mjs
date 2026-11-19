/**
 * End-to-end test against a mock homeserver.
 *
 * Verifies the whole path a real deployment takes: `/sync` arrives, the message
 * is admitted to a Session as user input, the turn ends, and the answer is PUT
 * back to the room. Encryption is off here on purpose — E2EE needs a real
 * homeserver to hand out keys, so the crypto layer has its own checks.
 *
 * Run: node test/e2e.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-matrix-e2e-'))
const ROOM = '!room:test'
const SECRET = '!secret:test'

/* ---------------------------------------------------------- mock homeserver */

const sent = []
const syncRequests = []

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = decodeURIComponent(url.pathname)
  const reply = (status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  }

  // whoami / profile / rooms
  if (route === '/_matrix/client/v3/account/whoami') {
    reply(200, { user_id: '@bot:test', device_id: 'DEV1' })
    return
  }
  if (route.startsWith('/_matrix/client/v3/profile/')) {
    reply(200, { displayname: 'Bot' })
    return
  }
  if (route === '/_matrix/client/v3/joined_rooms') {
    reply(200, { joined_rooms: [ROOM, SECRET] })
    return
  }
  if (route === `/_matrix/client/v3/rooms/${ROOM}/state/m.room.name`) {
    reply(200, { name: '测试房间' })
    return
  }
  if (route === `/_matrix/client/v3/rooms/${ROOM}/state/m.room.encryption`) {
    reply(404, { errcode: 'M_NOT_FOUND', error: 'not found' })
    return
  }
  if (route === `/_matrix/client/v3/rooms/${SECRET}/state/m.room.name`) {
    reply(404, { errcode: 'M_NOT_FOUND', error: 'not found' })
    return
  }
  if (route === `/_matrix/client/v3/rooms/${SECRET}/state/m.room.encryption`) {
    reply(200, { algorithm: 'm.megolm.v1.aes-sha2' })
    return
  }
  if (route === `/_matrix/client/v3/rooms/${ROOM}/joined_members`) {
    reply(200, { joined: { '@alice:test': { display_name: 'Alice' } } })
    return
  }

  // sync: first call bootstraps, second delivers one message, then park.
  if (route === '/_matrix/client/v3/sync') {
    const since = url.searchParams.get('since')
    syncRequests.push(since)
    if (since === null) {
      reply(200, {
        next_batch: 'A',
        rooms: {
          join: {
            [ROOM]: {
              state: { events: [{ type: 'm.room.name', state_key: '', content: { name: '测试房间' } }] },
              timeline: { events: [] },
            },
            [SECRET]: {
              state: {
                events: [
                  {
                    type: 'm.room.encryption',
                    state_key: '',
                    content: { algorithm: 'm.megolm.v1.aes-sha2' },
                  },
                ],
              },
              timeline: { events: [] },
            },
          },
        },
      })
      return
    }
    if (since === 'A') {
      reply(200, {
        next_batch: 'B',
        rooms: {
          join: {
            [ROOM]: {
              timeline: {
                events: [
                  {
                    type: 'm.room.message',
                    event_id: '$e1',
                    sender: '@alice:test',
                    origin_server_ts: Date.now(),
                    content: { msgtype: 'm.text', body: '你好 bot' },
                  },
                ],
              },
            },
            [SECRET]: {
              timeline: {
                events: [
                  {
                    type: 'm.room.message',
                    event_id: '$e2',
                    sender: '@alice:test',
                    origin_server_ts: Date.now(),
                    content: { msgtype: 'm.text', body: '机密消息' },
                  },
                ],
              },
            },
          },
        },
      })
      return
    }
    // Park the long poll so the loop does not spin.
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    reply(200, { next_batch: since })
    return
  }

  // send
  const sendMatch = /^\/_matrix\/client\/v3\/rooms\/(.+)\/send\/(.+)\/(.+)$/.exec(route)
  if (sendMatch !== null && req.method === 'PUT') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    sent.push({
      roomId: sendMatch[1],
      eventType: sendMatch[2],
      txnId: sendMatch[3],
      content: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    reply(200, { event_id: `$sent-${sent.length}` })
    return
  }

  reply(404, { errcode: 'M_NOT_FOUND', error: `mock has no route ${route}` })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/* ------------------------------------------------------------ seed config */

fs.mkdirSync(path.join(home, 'matrix-bridge'), { recursive: true })
fs.writeFileSync(
  path.join(home, 'matrix-bridge', 'connection.json'),
  JSON.stringify({
    homeserver: `http://127.0.0.1:${port}`,
    accessToken: 'test-token',
    encryption: 'off',
    autoConnect: true,
    acceptInvites: false,
    syncTimeoutMs: 5_000,
  }),
)
fs.writeFileSync(
  path.join(home, 'matrix-bridge', 'bindings.json'),
  JSON.stringify({
    'session-1': {
      roomId: ROOM,
      roomName: '测试房间',
      mentionOnly: false,
      enabled: true,
      authoritative: false,
      updatedAt: 1,
    },
    'session-2': {
      roomId: SECRET,
      roomName: '机密房间',
      mentionOnly: false,
      enabled: true,
      authoritative: false,
      updatedAt: 1,
    },
  }),
)

/* ------------------------------------------------------------ fake context */

const prompts = []
const listeners = []

const ctx = {
  get(name) {
    if (name === 'sessionController') {
      return {
        async prompt(request) {
          prompts.push(request)
        },
        async inspect() {
          return { meta: { cwd: home } }
        },
      }
    }
    if (name === 'attachments') return { imageLimits: { maxImageBytes: 5 * 1024 * 1024 } }
    return undefined
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject() {},
  logger: { info() {}, warn() {}, debug() {}, error() {} },
}

const { apply } = await import('../index.js')
apply(ctx, { home })

/* ------------------------------------------------------------ wait for inbound */

const deadline = Date.now() + 10_000
while (prompts.length < 2 && Date.now() < deadline) await sleep(50)

assert.equal(prompts.length, 2, 'both bound rooms should admit exactly one message each')
const plain = prompts.find((entry) => entry.sessionId === 'session-1')
const secret = prompts.find((entry) => entry.sessionId === 'session-2')
assert.ok(plain !== undefined && secret !== undefined, 'both sessions should receive their own room')
assert.equal(plain.mode, 'queue')
const textPart = plain.content.find((part) => part.type === 'text')
assert.ok(textPart !== undefined, 'admission should carry a text part')
assert.match(textPart.text, /你好 bot/, 'the message body should survive rendering')
assert.match(textPart.text, /Matrix 房间/, 'the untrusted-input header should name the source')
assert.match(
  secret.content.find((part) => part.type === 'text').text,
  /机密消息/,
  'the encrypted room still delivers its plaintext-shaped body in this mock',
)

/* ------------------------------------------------------------ reply back */

const sessionEvent = listeners.find((entry) => entry.event === 'session/event')
assert.ok(sessionEvent !== undefined, 'session/event listener should be registered')

// (1) 用户自己在这个会话里打字：这个 turn 不是 Matrix 投递开启的，不能被发出去。
sessionEvent.handler({ id: 'session-1' }, {
  type: 'user/message',
  data: { source: { kind: 'user', rpcId: 'user-typed-1' } },
})
sessionEvent.handler({ id: 'session-1' }, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '用户自己的对话' }] } },
})
sessionEvent.handler({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
await sleep(300)
assert.equal(sent.length, 0, 'a turn opened by the user must not be sent to Matrix')

// (2) Matrix 投递的那条被宿主接收（requestId 以 source.rpcId 回显），这一轮结束。
sessionEvent.handler({ id: 'session-1' }, {
  type: 'user/message',
  data: { source: { kind: 'user', rpcId: plain.requestId } },
})
sessionEvent.handler({ id: 'session-1' }, {
  type: 'assistant/message',
  data: { turn: 2, message: { content: [{ type: 'text', text: '收到，我在。' }] } },
})
sessionEvent.handler({ id: 'session-1' }, { type: 'turn/end', data: { turn: 2 } })

// (3) 加密房间同样走完配对，但加密层不在：必须拒绝发明文。
sessionEvent.handler({ id: 'session-2' }, {
  type: 'user/message',
  data: { source: { kind: 'user', rpcId: secret.requestId } },
})
sessionEvent.handler({ id: 'session-2' }, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '这段不该发出去' }] } },
})
sessionEvent.handler({ id: 'session-2' }, { type: 'turn/end', data: { turn: 1 } })

const replyDeadline = Date.now() + 5_000
while (sent.length === 0 && Date.now() < replyDeadline) await sleep(50)
await sleep(300)

assert.equal(sent.length, 1, `exactly one message may leave (got ${JSON.stringify(sent)})`)
assert.deepEqual(sent[0].roomId, ROOM)
assert.equal(sent[0].eventType, 'm.room.message', 'a plaintext room gets m.room.message')
assert.equal(sent[0].content.msgtype, 'm.text')
assert.equal(sent[0].content.body, '收到，我在。')
assert.ok(
  sent.every((item) => item.roomId !== SECRET),
  'an encrypted room must never receive plaintext when the crypto layer is missing',
)

/* ------------------------------------------------------------ unrelated turn */

// A turn nobody asked for must not be answered.
sessionEvent.handler({ id: 'session-1' }, {
  type: 'assistant/message',
  data: { turn: 99, message: { content: [{ type: 'text', text: '不该发出去' }] } },
})
sessionEvent.handler({ id: 'session-1' }, { type: 'turn/end', data: { turn: 99 } })
await sleep(300)
assert.equal(sent.length, 1, 'an unrelated turn must not produce a second message')

/* ------------------------------------------------------------ teardown */

server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

console.log(
  `e2e: ok — inbound rendered, reply delivered, encrypted room refused plaintext, unrelated turn ignored (sync calls: ${syncRequests.length})`,
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
