/**
 * Matrix 标识符与路径片段。
 *
 * roomId 是 `!opaque:server`，userId 是 `@local:server`。两者放进 URL 路径时必须整段编码：
 * `!` 不会被 encodeURIComponent 转义，而服务端按路径分段匹配，编码不完整会回 404 或把
 * 标识符切错。这里把 RFC 3986 允许但 Matrix 不用的字符一并转掉。
 */

/** encodeURIComponent 放过、但 Matrix 标识符里会出现或不该原样留下的字符。 */
const STRICT_EXTRA = /[!'()*]/g

/** 把 Matrix 标识符编成能放进路径的一段。 */
export function encodeSegment(value) {
  return encodeURIComponent(value).replace(STRICT_EXTRA, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `!opaque:server`。 */
export function isRoomId(value) {
  return value.startsWith('!') && value.includes(':')
}

/** `#alias:server`。 */
export function isRoomAlias(value) {
  return value.startsWith('#') && value.includes(':')
}

/** `@local:server`。 */
export function isUserId(value) {
  return value.startsWith('@') && value.includes(':')
}

/** 标识符里冒号之后的那一段；没有冒号时返回空串。 */
export function serverOf(value) {
  const index = value.indexOf(':')
  return index >= 0 ? value.slice(index + 1) : ''
}

/** `@coo:host` → `coo`；不是 userId 时原样返回。 */
export function localpart(value) {
  if (!isUserId(value)) return value
  const index = value.indexOf(':')
  return value.slice(1, index > 0 ? index : undefined)
}

/** `mxc://server/mediaId`。 */
export function parseMxc(uri) {
  if (!uri.startsWith('mxc://')) return null
  const rest = uri.slice('mxc://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { server: rest.slice(0, slash), mediaId: rest.slice(slash + 1) }
}

/** 从 mxc 地址里取一个能当文件名用的尾巴。 */
export function mediaNameOf(uri) {
  const parsed = parseMxc(uri)
  return parsed ? parsed.mediaId : uri
}

/**
 * 房间号的规范化比较键。
 *
 * 有些服务端（实测 tuwunel 2.0）的 `/joined_rooms` 只回 `!opaque`，不带 `:server`，
 * 而我们手上可能是完整号，或者反过来。按 `!` 后面那段对齐，两种写法才认得出是同一个房间。
 */
export function roomKey(value) {
  const trimmed = String(value ?? '').trim().replace(/[\u200b-\u200f\ufeff\u00a0]/g, '')
  if (!trimmed.startsWith('!')) return trimmed
  const body = trimmed.slice(1)
  const colon = body.indexOf(':')
  return colon > 0 ? body.slice(0, colon) : body
}
