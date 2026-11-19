/**
 * Matrix 客户端-服务器 API 的最小客户端。
 *
 * 只实现这个插件用到的部分：sync、收发消息、上传与下载媒体、房间状态与成员。
 * 这里不含端到端加密——加密由 crypto.js 用 matrix-bot-sdk 的加密机接进来。
 * 凭据是长期访问令牌，不走登录流程（登录只是换取令牌的一个可选入口）。
 */
import { encodeSegment, isRoomAlias, parseMxc } from './ids.js'

/** 服务端拒绝了一次请求；`errcode` 是 Matrix 的错误码。 */
export class MatrixError extends Error {
  constructor(message, errcode, status) {
    super(message)
    this.name = 'MatrixError'
    this.errcode = errcode
    this.status = status
  }

  /** 令牌失效：再重试也没用，停在错误状态比反复 401 好。 */
  get unauthorized() {
    return this.status === 401 || this.errcode === 'M_UNKNOWN_TOKEN' || this.errcode === 'M_MISSING_TOKEN'
  }

  /** 从 `since` 续不上：丢掉 next_batch 重新开始。 */
  get stalePosition() {
    return this.errcode === 'M_UNKNOWN_POS' || this.errcode === 'M_INVALID_PARAM'
  }
}

const DEFAULT_TIMEOUT_MS = 20_000

/** 去掉末尾斜杠；地址为空时返回空串。 */
export function normalizeBase(url) {
  return url.trim().replace(/\/+$/, '')
}

export class MatrixClient {
  constructor(options) {
    this.opts = options
    this.base = normalizeBase(options.homeserver)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.abortController = new AbortController()
    this.txn = 0
  }

  get homeserver() {
    return this.base
  }

  get configured() {
    return Boolean(this.base && this.opts.accessToken)
  }

  /** 停掉挂在服务端上的长轮询：插件停止时调用，不必等满一个 timeout。 */
  abort() {
    this.abortController.abort()
  }

  // ---- 账号 ----

  async whoami() {
    const data = await this.get('/_matrix/client/v3/account/whoami')
    const userId = String(data.user_id ?? '')
    if (!userId) throw new MatrixError('whoami 没有返回 user_id', 'M_BAD_RESPONSE', 200)
    return { userId, deviceId: data.device_id }
  }

  async versions() {
    const data = await this.get('/_matrix/client/versions', { auth: false })
    return Array.isArray(data.versions) ? data.versions.map(String) : []
  }

  /** 显示名与头像；取不到时返回空对象。 */
  async profile(userId) {
    const data = await this.get(`/_matrix/client/v3/profile/${encodeSegment(userId)}`, { auth: false })
    return { displayname: data.displayname, avatarUrl: data.avatar_url }
  }

  // ---- 房间 ----

  async joinedRooms() {
    const data = await this.get('/_matrix/client/v3/joined_rooms')
    return Array.isArray(data.joined_rooms) ? data.joined_rooms.map(String) : []
  }

  /** 房间状态事件的内容；不存在时返回 null。 */
  async roomState(roomId, eventType) {
    try {
      return await this.get(
        `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/state/${encodeSegment(eventType)}`,
      )
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return null
      throw error
    }
  }

  async roomName(roomId) {
    const state = await this.roomState(roomId, 'm.room.name')
    const name = state ? String(state.name ?? '').trim() : ''
    return name || null
  }

  async roomAlias(roomId) {
    const state = await this.roomState(roomId, 'm.room.canonical_alias')
    const alias = state ? String(state.alias ?? '').trim() : ''
    return alias || null
  }

  async joinedMembers(roomId) {
    const data = await this.get(`/_matrix/client/v3/rooms/${encodeSegment(roomId)}/joined_members`)
    return data.joined ?? {}
  }

  /** `#alias:server` 或 `!id:server` 解成 room id。 */
  async resolveRoom(target) {
    if (!isRoomAlias(target)) return target
    const data = await this.get(`/_matrix/client/v3/directory/room/${encodeSegment(target)}`, { auth: false })
    const roomId = String(data.room_id ?? '')
    if (!roomId) throw new MatrixError(`别名 ${target} 没有对应的房间`, 'M_NOT_FOUND', 404)
    return roomId
  }

  async joinRoom(roomIdOrAlias) {
    const data = await this.post(`/_matrix/client/v3/join/${encodeSegment(roomIdOrAlias)}`, {})
    return String(data.room_id ?? roomIdOrAlias)
  }

  /** 最近若干条事件，按时间升序返回。 */
  async messages(roomId, limit) {
    const query = new URLSearchParams({ dir: 'b', limit: String(Math.max(1, Math.min(1000, limit))) })
    const data = await this.get(`/_matrix/client/v3/rooms/${encodeSegment(roomId)}/messages?${query.toString()}`)
    const chunk = Array.isArray(data.chunk) ? data.chunk : []
    return [...chunk].reverse()
  }

  // ---- sync ----

  /**
   * 长轮询 sync。`since` 为空时是一次全量同步，只用来拿 next_batch，
   * 调用方不应该把它的时间线当成新消息。
   */
  async sync(since, timeoutMs) {
    const query = new URLSearchParams()
    query.set('timeout', String(Math.max(0, Math.floor(timeoutMs))))
    if (since) query.set('since', since)
    // 服务端会等到 timeout 才回，请求本身的时限要更宽。
    return this.get(`/_matrix/client/v3/sync?${query.toString()}`, {
      timeoutMs: Math.max(0, Math.floor(timeoutMs)) + 20_000,
    })
  }

  // ---- 发送 ----

  /**
   * 发一条房间事件。事件类型与内容由调用方给；返回 event_id。
   * txnId 是幂等键：同一条 txnId 重发不会产生第二条消息。
   */
  async sendEvent(roomId, eventType, content, txnId = this.nextTxn()) {
    const data = await this.put(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/send/${encodeSegment(eventType)}/${encodeSegment(txnId)}`,
      content,
    )
    const eventId = String(data.event_id ?? '')
    if (!eventId) throw new MatrixError('发送没有返回 event_id', 'M_BAD_RESPONSE', 200)
    return eventId
  }

  async redact(roomId, eventId, reason, txnId = this.nextTxn()) {
    const body = {}
    if (reason) body.reason = reason
    const data = await this.put(
      `/_matrix/client/v3/rooms/${encodeSegment(roomId)}/redact/${encodeSegment(eventId)}/${encodeSegment(txnId)}`,
      body,
    )
    return String(data.event_id ?? eventId)
  }

  async setTyping(roomId, userId, typing, timeoutMs = 5000) {
    await this.put(`/_matrix/client/v3/rooms/${encodeSegment(roomId)}/typing/${encodeSegment(userId)}`, {
      typing,
      timeout: Math.max(0, Math.floor(timeoutMs)),
    })
  }

  /** 表情回应：往一条事件上挂 `m.reaction`。 */
  async react(roomId, eventId, key) {
    return this.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
    })
  }

  /** 把一条事件标成已读。失败不影响收发。 */
  async sendReadReceipt(roomId, eventId) {
    await this.post(`/_matrix/client/v3/rooms/${encodeSegment(roomId)}/receipt/m.read/${encodeSegment(eventId)}`, {})
  }

  // ---- 媒体 ----

  /** 上传字节，返回 mxc 地址。 */
  async upload(bytes, mime, filename) {
    const query = new URLSearchParams({ filename })
    const data = await this.request('POST', `/_matrix/media/v3/upload?${query.toString()}`, {
      body: bytes,
      contentType: mime,
      timeoutMs: 120_000,
    })
    const uri = String(data.content_uri ?? '')
    if (!parseMxc(uri)) throw new MatrixError('上传没有返回 mxc 地址', 'M_BAD_RESPONSE', 200)
    return uri
  }

  /**
   * 下载一个 mxc。先问 v1.11 的客户端媒体端点，404 时退回 v3：
   * 老版本服务端只实现了后者。媒体过期（服务端按保留策略清掉）时抛 404。
   */
  async download(mxc) {
    const parsed = parseMxc(mxc)
    if (!parsed) throw new MatrixError(`不是 mxc 地址：${mxc.slice(0, 60)}`, 'M_BAD_MEDIA', 400)
    const server = encodeSegment(parsed.server)
    const mediaId = encodeSegment(parsed.mediaId)
    const paths = [
      `/_matrix/client/v1/media/download/${server}/${mediaId}`,
      `/_matrix/media/v3/download/${server}/${mediaId}`,
    ]
    let last = null
    for (const path of paths) {
      try {
        return await this.requestRaw('GET', path, { timeoutMs: 30_000 })
      } catch (error) {
        last = error
        if (error instanceof MatrixError && error.status !== 404) throw error
      }
    }
    throw last instanceof Error ? last : new MatrixError('媒体下载失败', 'M_UNKNOWN', 500)
  }

  // ---- 内部 ----

  nextTxn() {
    this.txn += 1
    return `mxb-${Date.now().toString(36)}-${this.txn}-${Math.random().toString(36).slice(2, 8)}`
  }

  get(path, opts = {}) {
    return this.request('GET', path, opts)
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, contentType: 'application/json', body: JSON.stringify(body) })
  }

  put(path, body, opts = {}) {
    return this.request('PUT', path, { ...opts, contentType: 'application/json', body: JSON.stringify(body) })
  }

  async request(method, path, opts = {}) {
    const raw = await this.requestRaw(method, path, opts)
    const text = new TextDecoder().decode(raw.bytes).trim()
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new MatrixError(`${method} ${path}: 响应不是 JSON（${text.slice(0, 120)}）`, 'M_BAD_RESPONSE', 200)
    }
  }

  /** 一次请求，最多对 429 重试一次。 */
  async requestRaw(method, path, opts = {}) {
    const url = `${this.base}${path}`
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      const signal = AbortSignal.any([controller.signal, this.abortController.signal])
      try {
        const headers = {}
        if (opts.auth !== false) headers.Authorization = `Bearer ${this.opts.accessToken}`
        if (opts.contentType) headers['Content-Type'] = opts.contentType
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body,
          signal,
          redirect: 'follow',
        })
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (response.ok) {
          return { bytes, mime: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '' }
        }
        const detail = this.describeFailure(bytes)
        if (response.status === 429 && attempt === 1) {
          const wait = this.retryAfterMs(detail, response.headers.get('retry-after'))
          this.opts.log?.warn('服务端限流，等一会儿再试', { path, waitMs: wait })
          await sleep(Math.min(wait, 30_000))
          continue
        }
        throw new MatrixError(
          `${method} ${path}: ${detail.message || `HTTP ${response.status}`}（${detail.errcode || response.status}）`,
          detail.errcode || `HTTP_${response.status}`,
          response.status,
        )
      } catch (error) {
        if (error instanceof MatrixError) throw error
        const reason = error instanceof Error ? error.message : String(error)
        if (this.abortController.signal.aborted) {
          throw new MatrixError(`${method} ${path}: 已取消`, 'M_ABORTED', 0)
        }
        const aborted = controller.signal.aborted
        throw new MatrixError(
          aborted ? `${method} ${path}: 超时（${timeoutMs}ms）` : `${method} ${path}: ${reason}`,
          aborted ? 'M_TIMEOUT' : 'M_NETWORK',
          0,
        )
      } finally {
        clearTimeout(timer)
      }
    }
    throw new MatrixError(`${method} ${path}: 重试之后仍然失败`, 'M_RATE_LIMITED', 429)
  }

  /** 从错误响应里读出 Matrix 的错误码与说明；读不出时退回状态文本。 */
  describeFailure(bytes) {
    const text = new TextDecoder().decode(bytes).trim()
    if (text) {
      try {
        const parsed = JSON.parse(text)
        const errcode = typeof parsed.errcode === 'string' ? parsed.errcode : ''
        const message = typeof parsed.error === 'string' ? parsed.error : ''
        const retryAfterMs = Number(parsed.retry_after_ms)
        if (errcode || message) {
          return { errcode, message: message || errcode, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0 }
        }
      } catch {
        // 不是 JSON：当纯文本用。
      }
      return { errcode: '', message: text.slice(0, 200), retryAfterMs: 0 }
    }
    return { errcode: '', message: '', retryAfterMs: 0 }
  }

  retryAfterMs(detail, header) {
    if (detail.retryAfterMs > 0) return detail.retryAfterMs
    const seconds = Number(header)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 用账号密码换一个属于「这一次登录」的设备令牌。
 *
 * 和手填令牌的关键差别：服务端会给一个新 device_id。同一个账号在多台机器上各登录一次，
 * 各拿各的设备，加密库互不覆盖；共用同一个令牌则会让两边的设备密钥互相顶掉。
 */
export async function loginWithPassword(homeserver, options) {
  const base = normalizeBase(homeserver)
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timer.unref?.()
  const body = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: options.user },
    password: options.password,
    ...(options.deviceName ? { initial_device_display_name: options.deviceName } : {}),
  }
  let response
  try {
    response = await fetchImpl(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw new MatrixError(`登录请求没发出去：${error instanceof Error ? error.message : String(error)}`, 'M_NETWORK', 0)
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    // 非 JSON（反代吐的 HTML 之类），下面按失败处理。
  }
  if (!response.ok) {
    const errcode = typeof payload.errcode === 'string' ? payload.errcode : 'M_UNKNOWN'
    const reason = typeof payload.error === 'string' ? payload.error : text.slice(0, 200)
    throw new MatrixError(`登录被拒绝：${reason || errcode}`, errcode, response.status)
  }
  const userId = payload.user_id
  const accessToken = payload.access_token
  const deviceId = payload.device_id
  if (typeof userId !== 'string' || typeof accessToken !== 'string' || typeof deviceId !== 'string') {
    throw new MatrixError('登录成功但返回里缺 user_id / access_token / device_id', 'M_UNKNOWN', 0)
  }
  return { userId, accessToken, deviceId }
}
