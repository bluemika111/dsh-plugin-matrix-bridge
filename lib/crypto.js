/**
 * 端到端加密：把 matrix-bot-sdk 的加密机接到本插件自己的 sync 循环上。
 *
 * 依赖是可选的。没装 `matrix-bot-sdk` 时 `loadCrypto()` 返回 null，插件退回明文模式，
 * 加密房间里的消息只显示 `[加密消息]`。装了就用它解密收到的、加密发出的，明文房间照常。
 *
 * 加密机要三样东西才能工作：设备密钥上传（`prepare`）、每次 sync 的 to-device 与设备列表
 * 变化（`updateSyncData`）、房间事件（`onRoomEvent`，跟踪 megolm 会话轮换）。这三处都在
 * 主循环的 sync 里喂给它，所以不需要 SDK 自己的 sync 循环。
 */
import { existsSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** matrix-bot-sdk 是 CJS 包；动态 import() 在扩展的 loader 下会解析错，用 require。 */
const require = createRequire(import.meta.url)

/** rust-sdk 的存储类型；`StoreType.Sqlite` 是 0。 */
const STORE_SQLITE = 0

/** 把任意抛出物压成一行，日志里够用就行。 */
function reasonOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 账号名进目录前的规范化：邮箱式用户名里的 `@` 和 `:` 不能进路径。 */
export function cryptoAccountName(userId) {
  return userId.replace(/[^\w.-]/g, '_')
}

/** 加密库目录：一个账号一份。 */
export function cryptoStoreDir(dataDir, userId) {
  return join(dataDir, 'matrix', 'crypto', userId ? cryptoAccountName(userId) : 'default')
}

/**
 * 加密库属于哪个设备，记在库目录里的一个标记文件上。
 *
 * 换设备后必须换库：库里的身份是**旧设备**的，SDK 会拿它当自己，上传的密钥全挂
 * 在旧身份上，服务端那边的设备就永远对不上（表现是对方 claim 到坏签名、永远收不到
 * 会话密钥）。登录时那个目录通常正被进程占着，挪不动，所以改到启动时做——这时还没打开。
 */
export function ensureStoreMatchesDevice(dataDir, userId, deviceId, log) {
  const dir = cryptoStoreDir(dataDir, userId)
  if (!existsSync(dir) || !deviceId) return dir
  const marker = join(dir, 'device.txt')
  let recorded = ''
  try {
    recorded = readFileSync(marker, 'utf8').trim()
  } catch {
    recorded = ''
  }
  if (recorded === deviceId) return dir
  const target = `${dir}.old-${Date.now()}`
  try {
    renameSync(dir, target)
    log?.warn(`加密库属于 ${recorded || '旧设备'}，当前设备是 ${deviceId}；旧库已挪到 ${target}，按新设备重建`)
    return dir
  } catch (error) {
    log?.warn(
      `加密库与当前设备（${deviceId}）不匹配，但挪不动：${error instanceof Error ? error.message : String(error)}`,
    )
    return dir
  }
}

/** 初始化成功后把设备号写进库目录，下次启动用来判断要不要换库。 */
export function markStoreDevice(dir, deviceId) {
  if (!dir || !deviceId) return
  try {
    writeFileSync(join(dir, 'device.txt'), deviceId, 'utf8')
  } catch {
    // 写不进去最多让下次多换一次库，不影响本次。
  }
}

/**
 * 早期版本的正则写成了 `/[^\\w.-]/`，等于把所有字母数字都换成下划线，目录名成了一串下划线。
 * 这里把老目录改回正常名字；改不动（被进程占用）就继续用旧的。
 */
export function migrateLegacyStore(dataDir, userId, log) {
  if (!userId) return cryptoStoreDir(dataDir, userId)
  const legacy = join(dataDir, 'matrix', 'crypto', userId.replace(/[^\\w.-]/g, '_'))
  const current = cryptoStoreDir(dataDir, userId)
  if (legacy === current || !existsSync(legacy) || existsSync(current)) return current
  try {
    renameSync(legacy, current)
    log?.info(`加密库目录已从旧命名改到 ${current}`)
  } catch (error) {
    log?.warn(`加密库目录改名失败，继续用旧目录：${error instanceof Error ? error.message : String(error)}`)
    return legacy
  }
  return current
}

class SdkCryptoLayer {
  constructor(client, log, storeDir) {
    this.client = client
    this.log = log
    this.storeDir = storeDir
  }

  get deviceId() {
    return this.client.crypto.clientDeviceId
  }

  get ed25519() {
    return this.client.crypto.clientDeviceEd25519
  }

  async prepare(roomIds) {
    await this.client.crypto.prepare(roomIds)
    // 初始化成功才写标记：写早了会让下次启动误以为库能用。
    markStoreDevice(this.storeDir, this.client.crypto.clientDeviceId)
  }

  isRoomEncrypted(roomId) {
    return this.client.crypto.isRoomEncrypted(roomId)
  }

  /**
   * 解密一条 `m.room.encrypted`；解不开时返回 null。
   *
   * SDK 的 decryptRoomEvent 读的是 `event.raw`（它自己的 RoomEvent 包装），
   * 直接传裸事件会让 rust 那边收到 undefined。
   */
  async decryptEvent(roomId, event) {
    try {
      const decrypted = await this.client.crypto.decryptRoomEvent({ raw: event }, roomId)
      // 解密后的事件保留原来的 id、发送者与时间，只换类型与内容。
      return { ...event, type: decrypted.type, content: decrypted.content }
    } catch (error) {
      // rust 侧的原话是判断「缺会话 / 缺密钥 / 签名不对」的唯一线索，别丢。
      const reason = reasonOf(error)
      this.log?.info(`解密失败 event=${event.event_id} ${reason.length > 180 ? `${reason.slice(0, 180)}…` : reason}`)
      return null
    }
  }

  encryptEvent(roomId, eventType, content) {
    return this.client.crypto.encryptRoomEvent(roomId, eventType, content)
  }

  /** 加密附件，返回密文与要写进事件里的 `file` 字段。 */
  async encryptMedia(bytes) {
    const made = await this.client.crypto.encryptMedia(Buffer.from(bytes))
    return { bytes: new Uint8Array(made.buffer), file: made.file }
  }

  /** 解密附件；解不开时返回 null。 */
  async decryptMedia(file) {
    try {
      return new Uint8Array(await this.client.crypto.decryptMedia(file))
    } catch {
      return null
    }
  }

  /** 每次 sync 之后把 to-device 与设备列表变化喂进去。 */
  async onSync(response) {
    const inbox = response.to_device?.events ?? []
    const counts = response.device_one_time_keys_count ?? {}
    const unused =
      response.device_unused_fallback_key_types ??
      response['org.matrix.msc2732.device_unused_fallback_key_types'] ??
      []
    const changed = response.device_lists?.changed ?? []
    const left = response.device_lists?.left ?? []
    if (inbox.length > 0) {
      // megolm 会话是靠 to-device 送到手的；收没收到、收到的是什么类型，直接决定能不能解密。
      const types = inbox.map((event) => `${event.type}${event.sender ? `<${event.sender}>` : ''}`).join(' ')
      this.log?.info(`收到 to-device n=${inbox.length} otk=${JSON.stringify(counts)} ${types}`)
    }
    try {
      await this.client.crypto.updateSyncData(inbox, counts, unused, changed, left)
    } catch (error) {
      this.log?.warn('加密机处理 sync 失败', { error: reasonOf(error), toDevice: inbox.length, changed: changed.length })
      throw error
    }
  }

  /** 房间事件也要喂：加密机靠它跟踪会话轮换。 */
  onRoomEvent(roomId, event) {
    return this.client.crypto.onRoomEvent(roomId, event)
  }

  async stop() {
    // 加密机没有自己的循环；rust-sdk 的句柄由进程退出时回收。
  }
}

/**
 * 加载加密层。没装依赖、原生模块加载失败或初始化失败时返回 null，
 * 由调用方退回明文模式——加密是加分项，不该让整个插件起不来。
 */
export async function loadCrypto(options) {
  let sdk
  try {
    sdk = require('matrix-bot-sdk')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 包不在和包在但原生模块没下载，是两回事：后者要人跑一次 download-lib.js。
    if (/Cannot find (module|package) 'matrix-bot-sdk'/.test(reason)) {
      options.log?.info('没有装 matrix-bot-sdk，按明文模式运行；加密房间里的消息读不到')
      return null
    }
    throw new Error(`matrix-bot-sdk 加载失败（多半是原生模块没下载）：${reason}`)
  }
  try {
    sdk.LogService.setLevel(sdk.LogLevel.ERROR)
    // SDK 把「房间没有 m.room.encryption」也当错误打到控制台，太吵：转进调试日志。
    const quiet = (...args) => options.log?.debug?.('matrix-bot-sdk', { args })
    sdk.LogService.error = quiet
    sdk.LogService.warn = quiet
    // 加密库和账号绑定：同一个部署换账号时，旧库会让 SDK 报「account in the store doesn't match」。
    // 换设备同理：库里的身份是旧设备的，必须换库，否则上传的密钥全挂在旧身份上。
    // 先迁老命名的目录，再按设备校验——两步都要在打开库之前做完。
    migrateLegacyStore(options.dataDir, options.userId, options.log)
    const storeDir = ensureStoreMatchesDevice(options.dataDir, options.userId, options.deviceId ?? '', options.log)
    const store = new sdk.RustSdkCryptoStorageProvider(storeDir, STORE_SQLITE)
    const client = new sdk.MatrixClient(options.homeserver, options.accessToken, undefined, store)
    // to-device 解不开（olm 层就失败）时加密机不会抛错，只发这个事件；不接住就完全看不见。
    client.on?.('to_device.decrypted', (message) => {
      // 正常的 m.room_key 到达不需要记；只有解不开（m.no_olm 之类）才值得留痕，
      // 否则一条加密消息会往日志里灌一堆密文。
      const content = message?.content
      if (!content) return
      const code = content.code
      const failed = typeof code === 'string' || content.decryption_failure === true || typeof content.error === 'string'
      if (!failed) return
      const sender = message?.sender ?? '?'
      const reason = typeof content.reason === 'string' ? content.reason : String(content.error ?? '')
      options.log?.warn(`to-device 解不开 code=${String(code ?? '?')} from=${sender} ${reason}`.trim())
    })
    return new SdkCryptoLayer(client, options.log, storeDir)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.log?.warn('加密模块初始化失败', { error: reason })
    throw new Error(`加密模块初始化失败：${reason}`)
  }
}
