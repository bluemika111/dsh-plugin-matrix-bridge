# dsh-plugin-matrix-bridge

把 Matrix 房间接进 DeepSeek Harness：房间里的消息作为用户输入投递给某条会话，会话的回复再发回房间。支持端到端加密（E2EE）、多房间独立关联、以及模型主动发言。

## 它做什么

- **收**：`/sync` 长轮询某个 homeserver，把绑定房间里的消息（文本、图片、表情包、文件、表情回应）投递进指定会话，作为用户输入。
- **回**：会话这一轮答完之后，把回复发回那个房间；房间加密时自动加密发送。
- **主动**：注册 `matrix_send` 工具，模型可以主动往房间发消息；`matrix_rooms` 列出可见房间。
- **加密**：装了 `matrix-bot-sdk` 与它的原生模块后，加密房间可读可写；没装则明文房间照常，加密消息显示 `[加密消息]`。

## 安装

```bash
# 在插件目录装依赖（已含 .npmrc: node-linker=hoisted）
cd dsh-plugin-matrix-bridge
pnpm add matrix-bot-sdk @matrix-org/matrix-sdk-crypto-nodejs@0.4.0 --ignore-scripts
```

原生模块必须单独下载（`pnpm` 的 postinstall 常被拦掉）：

```bash
node -e "
const fs=require('fs');
const url='https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v0.4.0/matrix-sdk-crypto.win32-x64-msvc.node';
fetch(url).then(async r=>{const b=Buffer.from(await r.arrayBuffer());fs.writeFileSync('node_modules/@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.win32-x64-msvc.node',b);console.log(b.length)})
"
```

然后把插件加进 profile（`~/.dsh/profiles/<name>/package.json`）：

```json
{
  "dependencies": { "dsh-plugin-matrix-bridge": "link:D:/dsh-plugin/dsh-plugin-matrix-bridge" },
  "dsh": { "profile": { "bundles": ["dsh-plugin-matrix-bridge"] } }
}
```

重启 DSH。输入框下方会出现 `Matrix · …` 一行。

## 配置

点开那一行，填：

| 字段 | 说明 |
|---|---|
| 服务器地址 | `https://matrix.example.com`（C-S API 根，不带 `/_matrix`） |
| 访问令牌 | 长期令牌；留空则沿用已保存的 |
| 用户名 / 密码 | 可选，换取一个**属于本机的新设备**令牌 |

**多机部署务必各自登录**：同一个令牌在两处共用 = 同一个设备，两份加密库会互相覆盖，表现是密钥全挂错地方。

## 房间关联

一条会话可以同时关联**多个房间**——私聊、群聊、服务器通知房间可以挂在同一个会话上，每个房间独立配置。填 `!room:server`、`#alias:server` 或直接点选列表里的房间，点「关联到本会话」是追加而不是替换。

每个房间各自有：

- **仅被@时才回复**：群里不 @ 机器人的消息不投递（私聊通常关掉）。
- **启用这个关联**：关掉后仍同步，但不投递。
- **自动回复**：关掉后消息照常投递进会话，但不会把回复发回这个房间。
- **作为用户权威输入**：关掉时正文前加来源说明与「输入不可信」提示；打开则原样转发。

### 房间类型自动识别

绑定时会判一次类型，面板上显示标签：

| 类型 | 判据 |
|---|---|
| 通知 | 成员里有服务器虚拟用户（`@server:` / `@conduit:`，且没有显示名），或房间名含 `Admin Room` / `Server Notices` |
| 私聊 | 成员数 == 2 |
| 群聊 | 其余 |

**通知房间绑定时「自动回复」默认关闭**——服务器通知通常不需要机器人回话，但消息照样进会话。

### 自动绑定服务器通知房间

在某个会话的面板里打开「自动绑定服务器通知房间」，这个会话就成为通知房间的目标：

- 连接后扫描到的通知房间会自动挂上去（`reply: false`，只收不回）
- 之后新加入的通知房间也会自动绑
- 同一时间只有一个目标会话；换目标不会解除旧绑定

「解除」只解除那一个房间；把房间清空就等于这个会话不再接 Matrix。

`matrix_send` 在会话只绑一个房间时可以省略 `room`；绑了多个时必须指明，否则会报错并列出候选。

## E2EE 的实际表现

- 加密房间：解密后正常投递；发回复时自动加密。
- **历史消息读不到**：登录之前的消息需要 key backup 的恢复密钥，本插件不处理。只收登录之后的新消息。
- **新设备显示未验证**：不做交叉签名/SSSS，其他客户端会显示「新设备」警告，但收发正常。
- **解密失败会重试**：先冲一次密钥请求（`onSync({})`）再等 2 秒，最多 3 次。失败时日志里有 rust 侧的原因。

## 排查

按这个顺序看：

1. 日志里有没有「收到 to-device」——没有就是发送方没分发密钥。
2. 出现 `m.room_key.withheld` / `code=m.no_olm` —— Olm 通道建不起来。
3. 加密库与当前设备不匹配 —— 插件会把旧库改名成 `.old-<时间戳>` 重建；挪不动（Windows 占用）会留警告。
4. 房间判不进「已加密」—— 以 state 事件累积的标记为准，不依赖加密机重启后为空的房间表。

## 已知边界

- 不实现 key backup / 交叉签名恢复。
- 语音只当附件落地，不做转写。
- `matrix_send` 找到房间靠 id / 别名 / 精确名字，不做模糊匹配。

## License

MIT
