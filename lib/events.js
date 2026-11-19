/**
 * 入站事件的渲染。
 *
 * 只做一件事：把一条 Matrix 事件变成模型能读的一行正文，并挑出要不要下载的媒体。
 * 加密事件本身不解析——解密在 crypto.js 里做，解完再走这里。
 */
import { localpart } from './ids.js'

function str(value) {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 一条事件的关系字段：回复、编辑、线程。 */
export function relatesOf(content) {
  const relates = obj(content['m.relates_to'])
  const out = {}
  const relType = str(relates.rel_type)
  if (relType === 'm.replace') out.editOf = str(relates.event_id) || undefined
  if (relType === 'm.thread') out.threadOf = str(relates.event_id) || undefined
  const reply = obj(relates['m.in_reply_to'])
  const replyId = str(reply.event_id)
  if (replyId) out.replyToId = replyId
  return out
}

/** 内容里的 `m.mentions.user_ids` 是否点了这些人。 */
export function mentionsUser(content, userId) {
  if (!userId) return false
  const mentions = obj(content['m.mentions'])
  const ids = Array.isArray(mentions.user_ids) ? mentions.user_ids : []
  return ids.some((id) => String(id) === userId)
}

/**
 * 正文里有没有写到自己。Matrix 的提及有两种表示：新客户端写 `m.mentions`，
 * 老客户端只写 `@localpart`。两种都要认，否则被 @ 了却不叫醒。
 */
export function bodyMentions(body, selfUserId, selfName) {
  if (!body) return false
  const needles = [`@${localpart(selfUserId)}`]
  if (selfName && selfName.trim()) needles.push(`@${selfName.trim()}`)
  const lower = body.toLowerCase()
  return needles.some((needle) => needle.length > 1 && lower.includes(needle.toLowerCase()))
}

function mimetypeOf(content) {
  const info = obj(content.info)
  const mime = str(info.mimetype) || undefined
  const size = Number(info.size)
  return { mime, size: Number.isFinite(size) && size > 0 ? size : undefined }
}

/** 编辑事件保留外层的关系字段，新内容里不一定有。 */
function relatesToOf(content) {
  const relates = content['m.relates_to']
  return relates ? { 'm.relates_to': relates } : {}
}

/** 一条 `m.room.message` 或 `m.sticker` 能不能渲染成正文；不能时返回 null。 */
export function renderEvent(event, opts) {
  const content = obj(event.content)
  // 编辑事件把新内容放在 m.new_content 里，外层 body 只是给老客户端的降级文本。
  const relates = relatesOf(content)
  const effective = relates.editOf ? { ...obj(content['m.new_content']), ...relatesToOf(content) } : content

  if (event.type === 'm.room.encrypted') {
    return {
      text: '[加密消息]',
      mentionedSelf: false,
      images: [],
      audio: [],
      files: [],
      stickers: [],
      msgtype: 'm.room.encrypted',
    }
  }

  // 撤回过的消息在 /messages 里内容已经被服务端抹掉，只剩一个标记。
  if (event.unsigned?.redacted_because) {
    return {
      text: '[已撤回]',
      mentionedSelf: false,
      images: [],
      audio: [],
      files: [],
      stickers: [],
      msgtype: 'm.room.message',
    }
  }

  if (event.type === 'm.sticker') {
    const mime = mimetypeOf(effective)
    const name = str(effective.body) || '表情包'
    const file = obj(effective.file)
    const encrypted = str(file.url) ? file : undefined
    const url = encrypted ? str(file.url) : str(effective.url)
    const sticker = { mxc: url, name, mimetype: mime.mime, size: mime.size, sticker: true, file: encrypted }
    return {
      text: `[表情包:${name}]`,
      mentionedSelf: false,
      images: url ? [sticker] : [],
      audio: [],
      files: [],
      stickers: url ? [sticker] : [],
      msgtype: 'm.sticker',
    }
  }

  if (event.type !== 'm.room.message') return null

  const msgtype = str(effective.msgtype) || 'm.unknown'
  const body = str(effective.body)
  const mentionedSelf = mentionsUser(effective, opts.selfUserId) || bodyMentions(body, opts.selfUserId, opts.selfName)
  const base = {
    text: '',
    mentionedSelf,
    replyToId: relates.replyToId,
    editOf: relates.editOf,
    threadOf: relates.threadOf,
    images: [],
    audio: [],
    files: [],
    stickers: [],
    msgtype,
  }

  const media = (kind) => {
    const mime = mimetypeOf(effective)
    // 加密附件把地址与解密参数放在 `file` 里，顶层没有 url。
    const file = obj(effective.file)
    const encrypted = str(file.url) ? file : undefined
    const mxc = encrypted ? str(file.url) : str(effective.url)
    return {
      mxc,
      name: body || kind,
      mimetype: mime.mime,
      size: mime.size,
      sticker: false,
      file: encrypted,
    }
  }

  switch (msgtype) {
    case 'm.text':
      base.text = body
      break
    case 'm.emote':
      base.text = body ? `* ${body}` : '*'
      break
    case 'm.notice':
      base.text = body
      break
    case 'm.image': {
      const ref = media('image')
      if (ref.mxc) base.images.push(ref)
      // 文件名多是 image.png 这种，写进正文只是噪声；图片本身会作为附件给出去。
      base.text = '[图片]'
      break
    }
    case 'm.audio': {
      const ref = media('audio')
      if (ref.mxc) base.audio.push(ref)
      base.text = '[语音]'
      break
    }
    case 'm.video': {
      const ref = media('video')
      if (ref.mxc) base.files.push(ref)
      base.text = '[视频]'
      break
    }
    case 'm.file': {
      const ref = media('file')
      if (ref.mxc) base.files.push(ref)
      base.text = body ? `[文件:${body}]` : '[文件]'
      break
    }
    case 'm.location': {
      const geo = str(effective.geo_uri)
      base.text = geo ? `[位置:${body || geo}]` : '[位置]'
      break
    }
    default:
      base.text = body || `[${msgtype}]`
      break
  }
  return base
}

/** 一条事件里带的全部媒体引用，按类别摊平。 */
export function mediaRefsOf(rendered) {
  return [...rendered.images, ...rendered.audio, ...rendered.files]
}
