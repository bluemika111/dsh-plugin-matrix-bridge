/**
 * Matrix ⇄ DeepSeek Harness bridge — Client half.
 *
 * A quiet strip below the composer shows which Matrix room THIS conversation is
 * wired to, and opens into the panel that sets it up: the homeserver, the
 * credential, the room, the "@ me" rule, and the encryption state.
 *
 * WHY THE HOST IS REACHED OVER HTTP
 *
 * A profile plugin has no host-call bridge, so everything below is a fetch
 * against `/dsh-matrix-bridge/*`, which the Host half registers on the Harness
 * web server. Every call is same-origin, and the Host checks that.
 *
 * WHY THE SWITCHES LOOK LIKE HOST SWITCHES
 *
 * The panel is part of the Harness UI, so it uses `--dsw-alias-*` tokens only
 * and carries the accessibility contract a real switch needs (`role="switch"`,
 * `aria-checked`, keyboard operation) rather than importing a Harness client
 * package.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-matrix-bridge",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = "/dsh-matrix-bridge";

    const token = {
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-l2)",
      surface: "var(--dsw-alias-bg-layer-1)",
      surface2: "var(--dsw-alias-bg-layer-2)",
      overlay: "var(--dsw-alias-bg-overlay)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    };

    /** Room kinds the host classifies: server notices, direct message, group. */
    const KIND_LABEL = { notice: "通知", dm: "私聊", room: "群聊" };
    const KIND_COLOR = { notice: token.warn, dm: token.ok, room: token.dim };

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, options);
      const payload = await response.json().catch(() => null);
      if (payload === null || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      }
      return payload;
    }

    function post(path, body) {
      return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    /* ------------------------------------------------------------- controls */

    function Switch(props) {
      const { checked, onChange, label, hint, disabled } = props;
      const on = checked === true;
      const toggle = () => {
        if (disabled !== true) onChange(!on);
      };
      return h(
        "div",
        { style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0" } },
        h(
          "button",
          {
            type: "button",
            role: "switch",
            "aria-checked": on,
            "aria-label": label,
            disabled: disabled === true,
            onClick: toggle,
            onKeyDown: (event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                toggle();
              }
            },
            style: {
              flex: "0 0 auto",
              marginTop: 2,
              width: 34,
              height: 18,
              padding: 0,
              borderRadius: 999,
              border: `1px solid ${on ? "transparent" : token.borderStrong}`,
              background: on ? token.brand : token.surface2,
              cursor: disabled === true ? "not-allowed" : "pointer",
              opacity: disabled === true ? 0.55 : 1,
              position: "relative",
              transition: "background 120ms ease",
            },
          },
          h("span", {
            style: {
              position: "absolute",
              top: 2,
              left: on ? 18 : 2,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#ffffff",
              boxShadow: "0 1px 2px rgba(0,0,0,0.28)",
              transition: "left 120ms ease",
            },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
          h("span", { style: { fontSize: 12.5, color: token.text } }, label),
          hint
            ? h("span", { style: { fontSize: 11, color: token.dim, lineHeight: 1.5 } }, hint)
            : null,
        ),
      );
    }

    function Button(props) {
      const { onClick, disabled, primary, children } = props;
      return h(
        "button",
        {
          type: "button",
          disabled: disabled === true,
          onClick,
          style: {
            padding: "5px 12px",
            fontSize: 12,
            borderRadius: 7,
            border: `1px solid ${primary ? "transparent" : token.borderStrong}`,
            background: primary ? token.brand : token.surface2,
            color: primary ? "#ffffff" : token.text,
            cursor: disabled === true ? "not-allowed" : "pointer",
            opacity: disabled === true ? 0.55 : 1,
            whiteSpace: "nowrap",
          },
        },
        children,
      );
    }

    function Field(props) {
      const { label, value, onChange, placeholder, type, hint, disabled } = props;
      return h(
        "label",
        { style: { display: "flex", flexDirection: "column", gap: 4, padding: "5px 0" } },
        h("span", { style: { fontSize: 12, color: token.text } }, label),
        h("input", {
          type: type || "text",
          value: value,
          disabled: disabled === true,
          placeholder,
          onChange: (event) => onChange(event.target.value),
          style: {
            padding: "6px 9px",
            fontSize: 12,
            borderRadius: 7,
            border: `1px solid ${token.borderStrong}`,
            background: token.surface2,
            color: token.text,
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          },
        }),
        hint ? h("span", { style: { fontSize: 11, color: token.dim, lineHeight: 1.5 } }, hint) : null,
      );
    }

    function Section(props) {
      const { title, children } = props;
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 2, padding: "10px 0" } },
        h(
          "div",
          {
            style: {
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: token.dim,
              textTransform: "uppercase",
              paddingBottom: 4,
            },
          },
          title,
        ),
        children,
      );
    }

    function Pill(props) {
      const { tone, children } = props;
      const color = tone === "ok" ? token.ok : tone === "warn" ? token.warn : tone === "error" ? token.error : token.dim;
      return h(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            color,
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${color}`,
            opacity: 0.95,
          },
        },
        h("span", {
          style: { width: 6, height: 6, borderRadius: "50%", background: color, flex: "0 0 auto" },
        }),
        children,
      );
    }

    /* ---------------------------------------------------------------- panel */

    function MatrixBridgePanel(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : "";
      const onClose = props && props.onClose;
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");
      const [homeserver, setHomeserver] = useState("");
      const [accessToken, setAccessToken] = useState("");
      const [user, setUser] = useState("");
      const [password, setPassword] = useState("");
      const [roomId, setRoomId] = useState("");
      const [roomName, setRoomName] = useState("");
      const [depsOutput, setDepsOutput] = useState("");
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const refresh = useCallback(async () => {
        try {
          const payload = await api(`/state?sessionId=${encodeURIComponent(sessionId)}`);
          if (!alive.current) return;
          setState(payload);
          setError("");
          const conn = payload.connection || {};
          setHomeserver((current) => (current === "" ? conn.homeserver || "" : current));
        } catch (err) {
          if (alive.current) setError(String(err && err.message ? err.message : err));
        }
      }, [sessionId]);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 2500);
        return () => clearInterval(timer);
      }, [refresh]);

      const run = async (action, message) => {
        setBusy(true);
        setNotice("");
        try {
          await action();
          if (message) setNotice(message);
          await refresh();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      };

      const connection = (state && state.connection) || {};
      // One Session may hold several bindings (DM + group + server notices).
      const bindings = state && Array.isArray(state.binding) ? state.binding : [];
      const rooms = (state && state.rooms) || [];
      const deps = (state && state.deps) || {};
      const connected = connection.connected === true;
      const cryptoState = connection.cryptoState || "off";

      const cryptoLabel =
        cryptoState === "ready"
          ? `E2EE 已就绪（${connection.deviceId || "设备未知"}）`
          : cryptoState === "starting"
            ? "E2EE 正在启动…"
            : cryptoState === "missing"
              ? "E2EE 不可用：没装 matrix-bot-sdk"
              : cryptoState === "failed"
                ? `E2EE 启动失败：${connection.cryptoError || "原因未知"}`
                : connection.encryption === "off"
                  ? "E2EE 已关闭（配置）"
                  : "E2EE 未启用";

      const cryptoTone =
        cryptoState === "ready" ? "ok" : cryptoState === "failed" || cryptoState === "missing" ? "error" : "warn";

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 2,
          },
        },

        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 6 } },
          h("span", { style: { fontSize: 13, fontWeight: 600, color: token.text, flex: "1 1 auto" } }, "Matrix 桥接"),
          h(Pill, { tone: connected ? "ok" : "idle" }, connected ? "已连接" : "未连接"),
          h(Pill, { tone: cryptoTone }, cryptoLabel),
        ),

        error ? h("div", { style: { fontSize: 11.5, color: token.error, padding: "4px 0" } }, error) : null,
        notice ? h("div", { style: { fontSize: 11.5, color: token.ok, padding: "4px 0" } }, notice) : null,

        h(
          Section,
          { title: "连接" },
          h(Field, {
            label: "服务器地址",
            value: homeserver,
            onChange: setHomeserver,
            placeholder: "https://matrix.example.com",
            hint: "客户端-服务器 API 的根地址，不带 /_matrix。",
          }),
          h(Field, {
            label: "访问令牌",
            value: accessToken,
            onChange: setAccessToken,
            placeholder: "syt_…（留空则沿用已保存的）",
            type: "password",
            hint: "长期令牌最省事；也可以下面用账号密码换一个属于本机的设备令牌。",
          }),
          h(
            "div",
            { style: { display: "flex", gap: 8, padding: "4px 0" } },
            h(
              Button,
              {
                primary: true,
                disabled: busy,
                onClick: () =>
                  run(
                    () =>
                      post("/connection", {
                        homeserver: homeserver.trim(),
                        ...(accessToken.trim() === "" ? {} : { accessToken: accessToken.trim() }),
                        autoConnect: true,
                      }),
                    "已保存并开始连接",
                  ),
              },
              "保存并连接",
            ),
            h(
              Button,
              {
                disabled: busy,
                onClick: () =>
                  run(() => post("/connection", { autoConnect: false }), "已断开"),
              },
              "断开",
            ),
          ),
        ),

        h(
          Section,
          { title: "账号密码登录（可选）" },
          h(Field, { label: "用户名", value: user, onChange: setUser, placeholder: "alice 或 @alice:example.com" }),
          h(Field, { label: "密码", value: password, onChange: setPassword, type: "password" }),
          h(
            "div",
            { style: { padding: "4px 0" } },
            h(
              Button,
              {
                disabled: busy || user.trim() === "" || password === "",
                onClick: () =>
                  run(
                    () =>
                      post("/login", {
                        homeserver: homeserver.trim(),
                        user: user.trim(),
                        password,
                      }),
                    "登录成功，已开始连接",
                  ),
              },
              "登录并连接",
            ),
          ),
          h(
            "div",
            { style: { fontSize: 11, color: token.dim, lineHeight: 1.5 } },
            "每次登录都会新建一个设备，加密库按设备分开存——多台机器各登各的，不要共用同一个令牌。",
          ),
        ),

        h(
          Section,
          { title: "房间" },
          bindings.length === 0
            ? h("div", { style: { fontSize: 12, color: token.dim, padding: "4px 0" } }, "本会话还没有关联房间")
            : h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" } },
                bindings.map((item) =>
                  h(
                    "div",
                    {
                      key: item.roomId,
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        padding: "6px 8px",
                        borderRadius: 8,
                        border: `1px solid ${token.border}`,
                        background: token.surface2,
                      },
                    },
                    h(
                      "div",
                      { style: { display: "flex", alignItems: "center", gap: 8 } },
                      h(
                        "span",
                        {
                          style: {
                            fontSize: 10,
                            lineHeight: "16px",
                            padding: "0 6px",
                            borderRadius: 999,
                            border: `1px solid ${KIND_COLOR[item.kind] || token.dim}`,
                            color: KIND_COLOR[item.kind] || token.dim,
                            flex: "0 0 auto",
                          },
                        },
                        KIND_LABEL[item.kind] || "群聊",
                      ),
                      h(
                        "span",
                        {
                          style: {
                            fontSize: 12,
                            color: token.text,
                            flex: "1 1 auto",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          },
                          title: item.roomId,
                        },
                        item.roomName || item.roomId,
                      ),
                      h(
                        Button,
                        {
                          disabled: busy,
                          onClick: () =>
                            run(() => post("/unbind", { sessionId, roomId: item.roomId }), "已解除"),
                        },
                        "解除",
                      ),
                    ),
                    h(Switch, {
                      checked: item.mentionOnly,
                      disabled: busy,
                      label: "仅被@时才回复",
                      onChange: (value) =>
                        run(() => post("/options", { sessionId, roomId: item.roomId, mentionOnly: value })),
                    }),
                    h(Switch, {
                      checked: item.enabled,
                      disabled: busy,
                      label: "启用这个关联",
                      onChange: (value) =>
                        run(() => post("/options", { sessionId, roomId: item.roomId, enabled: value })),
                    }),
                    h(Switch, {
                      checked: item.reply !== false,
                      disabled: busy,
                      label: "自动回复",
                      hint: "关掉后消息照常投递进会话，但不会把回复发回这个房间（服务器通知通常不需要回）。",
                      onChange: (value) =>
                        run(() => post("/options", { sessionId, roomId: item.roomId, reply: value })),
                    }),
                    h(Switch, {
                      checked: item.authoritative,
                      disabled: busy,
                      label: "作为用户权威输入",
                      hint: "关闭时正文前加来源说明与「输入不可信」提示；打开则原样转发。",
                      onChange: (value) =>
                        run(() => post("/options", { sessionId, roomId: item.roomId, authoritative: value })),
                    }),
                  ),
                ),
              ),
          h(
            "div",
            { style: { display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", paddingTop: 6 } },
            h(
              "div",
              { style: { flex: "1 1 220px", minWidth: 180 } },
              h(Field, {
                label: "再关联一个房间",
                value: roomId ?? "",
                onChange: (value) => {
                  setRoomId(value);
                  const hit = rooms.find((item) => item.roomId === value || item.name === value);
                  setRoomName(hit ? hit.name : "");
                },
                placeholder: "!room:server 或 #alias:server",
                hint:
                  rooms.length > 0
                    ? `已加入 ${rooms.length} 个房间，可填 id、别名或下面点选。`
                    : "连接后这里会列出已加入的房间。",
              }),
            ),
            h(
              Button,
              {
                primary: true,
                disabled: busy || String(roomId ?? "").trim() === "",
                onClick: () =>
                  run(
                    () =>
                      post("/bind", {
                        sessionId,
                        roomId: String(roomId ?? "").trim(),
                        roomName,
                      }),
                    "已关联",
                  ),
              },
              "关联到本会话",
            ),
          ),
          rooms.length > 0
            ? h(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 0" } },
                rooms.slice(0, 40).map((room) =>
                  h(
                    "button",
                    {
                      key: room.roomId || room.key,
                      type: "button",
                      onClick: () => {
                        // The host sends `roomId` (server spelling) and `key`
                        // (opaque part); older payloads only had `key`.
                        setRoomId(room.roomId || room.key || "");
                        setRoomName(room.name || "");
                      },
                      style: {
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 999,
                        border: `1px solid ${room.encrypted ? token.warn : token.borderStrong}`,
                        background: token.surface2,
                        color: token.text,
                        cursor: "pointer",
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                      title: room.roomId || room.key,
                    },
                    `${room.kind === "notice" ? "🔔 " : room.encrypted ? "🔒 " : ""}${room.name}`,
                  ),
                ),
              )
            : null,
        ),

        h(
          Section,
          { title: "高级" },
          h(Switch, {
            checked: connection.encryption !== "off",
            disabled: busy,
            label: "启用端到端加密",
            hint: "需要 matrix-bot-sdk 与它的原生模块；没装时加密房间读不到，但明文房间照常。",
            onChange: (value) =>
              run(() => post("/connection", { encryption: value ? "auto" : "off" }), value ? "已启用 E2EE" : "已关闭 E2EE"),
          }),
          h(Switch, {
            checked: connection.acceptInvites !== false,
            disabled: busy,
            label: "自动接受房间邀请",
            hint: "打开时，别人邀请机器人进房间会自动加入。",
            onChange: (value) => run(() => post("/connection", { acceptInvites: value })),
          }),
          h(Switch, {
            checked: connection.noticeSessionId === sessionId,
            disabled: busy,
            label: "自动绑定服务器通知房间",
            hint: "打开后，服务器通知房间（Admin Room / Server Notices）会自动关联到本会话，只收不回。",
            onChange: (value) =>
              run(
                () => post("/connection", { noticeSessionId: value ? sessionId : "" }),
                value ? "已设为通知房间的目标会话" : "已关闭自动绑定",
              ),
          }),
        ),

        h(
          Section,
          { title: "加密依赖" },
          h(
            "div",
            { style: { fontSize: 11.5, color: deps.installed ? token.ok : token.warn, padding: "2px 0" } },
            deps.installed
              ? `matrix-bot-sdk 已安装${deps.version ? `（${deps.version}）` : ""}`
              : "matrix-bot-sdk 未安装——加密房间读不到",
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, padding: "4px 0" } },
            h(
              Button,
              {
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    const result = await post("/deps/install", {});
                    setDepsOutput(result.output || "");
                  }, "依赖安装结束"),
              },
              "安装 / 修复加密依赖",
            ),
            h(
              Button,
              {
                disabled: busy || !connected,
                onClick: () => run(() => post("/test", {}), "自检完成"),
              },
              "自检",
            ),
          ),
          depsOutput
            ? h(
                "pre",
                {
                  style: {
                    fontSize: 10.5,
                    color: token.dim,
                    background: token.surface2,
                    borderRadius: 8,
                    padding: 8,
                    maxHeight: 160,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    margin: 0,
                  },
                },
                depsOutput,
              )
            : null,
        ),

        state && Array.isArray(state.log) && state.log.length > 0
          ? h(
              Section,
              { title: "最近动态" },
              h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 3, maxHeight: 140, overflowY: "auto" } },
                state.log
                  .slice()
                  .reverse()
                  .map((entry, index) =>
                    h(
                      "div",
                      {
                        key: `${entry.at}-${index}`,
                        style: {
                          fontSize: 11,
                          color:
                            entry.kind === "error"
                              ? token.error
                              : entry.kind === "warn"
                                ? token.warn
                                : token.dim,
                          lineHeight: 1.5,
                        },
                      },
                      `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`,
                    ),
                  ),
              ),
            )
          : null,
      );
    }

    /* ---------------------------------------------------------------- dock */

    /**
     * Keeps a crash inside the panel from taking the whole strip with it.
     *
     * The dock is the only thing that tells the user this bridge exists; if a
     * render error unmounts it, the row silently disappears and there is no way
     * back in short of a reload.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error("[dsh-matrix-bridge] panel crashed", error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    function MatrixBridgeDock(props) {
      // `props` itself can arrive undefined while the host is swapping
      // sessions; reading through it unguarded throws and unmounts the row.
      const sessionId =
        props && props.sessionId
          ? String(props.sessionId)
          : props && props.session && props.session.id
            ? String(props.session.id)
            : "";
      const [open, setOpen] = useState(false);
      const [state, setState] = useState(null);

      const refresh = useCallback(async () => {
        if (sessionId === "") return;
        try {
          const payload = await api(`/state?sessionId=${encodeURIComponent(sessionId)}`);
          setState(payload);
        } catch {
          /* the strip stays quiet when the host is unreachable */
        }
      }, [sessionId]);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      if (sessionId === "") return null;

      const connection = (state && state.connection) || {};
      const bindings = state && Array.isArray(state.binding) ? state.binding : [];
      const connected = connection.connected === true;
      const cryptoState = connection.cryptoState || "off";

      // The binding may still carry the room id it was created with (before the
      // host learned the room's name). Prefer the live room table, so the strip
      // shows「懒懒小星鱼」instead of `!u8NT…`.
      const roomKeyOf = (value) => {
        const text = String(value ?? "").trim();
        if (!text.startsWith("!")) return text;
        const body = text.slice(1);
        const colon = body.indexOf(":");
        return colon > 0 ? body.slice(0, colon) : body;
      };
      const rooms = (state && state.rooms) || [];
      const labelOf = (item) => {
        const live = rooms.find((room) => roomKeyOf(room.roomId) === roomKeyOf(item.roomId));
        return live && live.name ? live.name : item.roomName || item.roomId;
      };

      const noticeCount = bindings.filter((item) => item.kind === "notice").length;
      const summary =
        bindings.length === 0
          ? "未关联房间"
          : bindings.length === 1
            ? `${labelOf(bindings[0])}${bindings[0].mentionOnly ? " · 仅@" : ""}`
            : `${bindings.length} 个房间${noticeCount > 0 ? `（${noticeCount} 通知）` : ""}`;

      const tone = !connected ? "idle" : cryptoState === "ready" ? "ok" : "warn";
      const dotColor = tone === "ok" ? token.ok : tone === "warn" ? token.warn : token.idle;

      const statusDot = h("span", {
        style: { width: 6, height: 6, borderRadius: "50%", background: dotColor, flex: "0 0 auto" },
      });

      /**
       * Collapsed: a compact chip that sits inline with the host's own ambient
       * entries. It has to stay transparent and fit-content — a full-width
       * block with a surface fill reads as a stray panel sitting in that row.
       */
      const chipStyle = {
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        // The dock row is a flex container: without an explicit basis the chip
        // is a shrinkable item, and a long room name squeezes it down to a
        // sliver. `flex: 0 0 auto` keeps it at its content width.
        flex: "0 0 auto",
        maxWidth: 210,
        minWidth: 0,
        minHeight: 22,
        margin: 0,
        padding: "2px 6px",
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: token.dim,
        fontSize: 11.5,
        lineHeight: "18px",
        cursor: "pointer",
        fontFamily: "inherit",
      };

      if (!open) {
        return h(
          "button",
          {
            type: "button",
            title: "展开 Matrix 桥接设置",
            onClick: () => setOpen(true),
            style: chipStyle,
          },
          statusDot,
          h("span", { style: { flex: "0 0 auto" } }, "Matrix"),
          h(
            "span",
            { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "0 1 auto" } },
            summary,
          ),
        );
      }

      /** Expanded: the same row, now serving as the popover's anchor. */
      const panelHeader = h(
        "button",
        {
          type: "button",
          "aria-expanded": true,
          onClick: () => setOpen(false),
          title: "收起 Matrix 桥接设置",
          style: chipStyle,
        },
        statusDot,
        h("span", { style: { flex: "0 0 auto" } }, "Matrix"),
        h(
          "span",
          { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          summary,
        ),
        h("span", { style: { flex: "0 0 auto", opacity: 0.7 } }, "· 收起"),
      );

      return h(
        "div",
        {
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            flex: "0 0 auto",
            minWidth: 0,
          },
        },
        panelHeader,
        // A popover anchored above the row. It overlays the conversation the
        // way the host's own stats card does, so opening it never pushes the
        // composer up or reflows the transcript.
        h(
          "div",
          {
            style: {
              position: "absolute",
              bottom: "100%",
              right: 0,
              marginBottom: 8,
              zIndex: 40,
              width: 440,
              maxWidth: "min(92vw, 440px)",
              maxHeight: "min(68vh, 560px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
              boxSizing: "border-box",
              background: token.overlay,
              // The theme's surfaces are translucent; a popover must be
              // readable over the transcript, so blur what shows through.
              backdropFilter: "blur(16px) saturate(140%)",
              WebkitBackdropFilter: "blur(16px) saturate(140%)",
              border: `1px solid ${token.border}`,
              borderRadius: 12,
              boxShadow: "0 10px 30px rgba(0, 0, 0, 0.22)",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              fontSize: 12,
              color: token.text,
            },
          },
          h(PanelBoundary, null, h(MatrixBridgePanel, { sessionId, onClose: () => setOpen(false) })),
        ),
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            { name: "conversation.composer.dock", id: "dsh-matrix-bridge", order: 21 },
            MatrixBridgeDock,
          ),
        );
      },
    };
  },
});
