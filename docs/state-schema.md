# `state.json` — 用户意图

位置：`/data/adb/modules/KernelRay/state.json`，权限 `0600`，属主 `root`。

`state.json` 是 **意图**：用户有哪些节点、用户要的是哪一个。`config.json` 是核心实际运行的
**派生产物**。两者不是同一个文件，UI 绝不能把一个当成另一个来呈现。

在 WebUI 节点列表点一行会打开只读的 节点详情弹窗；按下其中的 应用 按钮会写 `selected`、
把节点渲染到 `outbound.json`/`outbound.meta`，然后调用 `kernelray.sh apply <id>`
（见 [`config-derivation.md`](config-derivation.md)）。`selected` 先写，所以切换失败时意图
仍指向被尝试的节点，而 `runtime/applied` 仍指向核心正在运行的节点。

写入方：WebUI 导入器、节点详情弹窗 的应用路径、节点列表（删除）、以及成功应用路径（清除
节点的 `dirty` 标记时）。读取方：WebUI 节点列表和 节点详情弹窗。
所有权说明：shell 写运行时事实（`runtime/status.json`、`runtime/applied`、pid），UI 写意图
和渲染出的出站（`outbound.json` + `outbound.meta`）。

## 顶层字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema` | int | Schema 版本。目前为 `1`；其他值 UI 一律拒绝解释。 |
| `revision` | int | 每次写入都递增，过期的阅读方由此察觉文件变了。 |
| `settings` | object | 用户选择的核心设置。目前两个字段：`socksPort` 和 `httpPort`，本地入站端口（见下）。未知字段原样保留。 |
| `manual` | `Node[]` | 手工添加（导入）的节点 — UI 唯一追加、渲染和删除的列表。 |
| `subscriptions` | `{name,url,nodes:Node[]}[]` | 来自订阅的节点。原样保留；本版本没有任何东西填充或渲染它们。 |
| `selected` | string | 用户最后选择的节点的 `id`。通常即已应用节点；切换失败时停在被尝试的节点上。未选中任何节点时为 `""`。 |
| `group` | string | 自由文本标签；不挂任何行为。 |

`selected` 是愿望。当前核心配置实际由哪个节点构建，看的是 `runtime/applied`，由
`kernelray.sh apply <id>` 写入；节点列表把两者都标记出来，并在不一致时说明（切换失败）。
`outbound.json` / `outbound.meta` 存的是最后一次渲染的候选；只有 `runtime/applied` 能说明
换入是否真的成功了。

## 节点列表动作

节点页只渲染 `manual`。它写 `state.json`；绝不写 `config.json` 或 `runtime/applied`。

- **导入** 追加新节点、原地更新已有节点（保留 id）。若尚未应用任何节点（`runtime/applied`
  不存在或为空），导入还会切换到 `selected` 仍能解析到的节点，否则切换到列表显示的第一个
  节点：它写 `selected` 并按与 应用 按钮相同的写入序列应用它（见 切换节点 和
  [ADR 0012](adr/0012-import-applies-the-first-node-when-nothing-is-applied.md)）。已有已
  应用节点时它不动任何指针；用户之后打开某行的对话框并应用。这是唯一不经 节点详情弹窗 的
  应用路径。
- **点按节点** 打开只读的 节点详情弹窗；它不写任何东西、绝不碰核心。弹窗里的 **应用** 写
  `selected`、把节点渲染到 `outbound.json` + `outbound.meta`、然后调用 `apply <id>`。应用
  字段未变的 **已应用** 节点对核心不做任何事（只有失败的切换把 `selected` 留在别处时才重新
  同步它）。应用重导入后变过的已应用节点（`dirty`）则重新应用。
- **删除** 对已应用节点在核心运行中或列表里还有其他节点时被拒绝。允许的情形是已应用节点
  是最后一个节点且核心已停止：此时 UI 在写 `state.json` 之前先调 `kernelray.sh unapply`，
  它移除接管规则、`config.json`、`runtime/applied`、`outbound.json` 和 `outbound.meta`，并
  写 `stopped`/`no-node` — 模块回到从未应用过的状态
  （[ADR 0013](adr/0013-deleting-the-last-node-while-stopped-unapplies-it.md)）。已应用 id
  已经悬空时，一次清空列表的删除同样触发 unapply。删除已选中节点会清掉 `selected`；删除
  渲染出站还在磁盘上的节点（其 id 在 `outbound.meta` 里）还会移除 `outbound.json` 和
  `outbound.meta`，让凭据不比节点活得久。删除需要点两下确认。
- **切换失败** 会把 `selected` 留在被尝试的节点上。列表把它标记为未应用、旧节点保持已应用
  标记；打开被尝试节点的对话框按 应用 即可重试。

弹窗的 复制链接 和 订阅 Base64 动作是从节点字段 **推导** 的；`state.json` 不存原始分享
链接。因此生成的链接描述的是模块将会运行的那个节点，未必是导入时粘贴的原文。

未知顶层字段被保留：写入方解析整个文件、修改对象、再序列化回去，所以旧 UI 不会丢字段。

`settings.socksPort` 和 `settings.httpPort` 是 **入站端口**（默认 10808 和 10809）：shell
的渲染直接读它们，用行级 `sed` 提取
（[ADR 0009](adr/0009-shell-reads-state-settings-for-inbound-ports.md)），某字段缺失、非数字
或超范围时逐字段回退到默认值。UI 写入前校验这对值（1–65535、互不相同、绝不许是 10810 —
tproxy 入站的端口），并调 `kernelray.sh ports` 应用，其行为如节点应用一样重渲染并重启 —
配置已带保存的端口时两者都不做
（[ADR 0017](adr/0017-one-render-one-test-per-switch.md)）。`settings` 里其余字段原样保留、
暂不解释。

分流模式 有意 **不在** 这里：它是 shell 自己的偏好 — `runtime/route`，由
`kernelray.sh routing global|cn|cnadblock` 写入
（[ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)、
[ADR 0021](adr/0021-ad-blocking-is-a-third-routing-mode.md)）— 因为 shell 必须能不经 UI
就改变它，也因为一次 `cn` 渲染必须先检查 geo 数据才能承诺什么。文件里存的是模式自己的名字
（`cn`、`cnadblock`）而不是存在标志；缺省即 `global`，偏好未设时安装器写入 `cnadblock`
（docs/adr/0021）。`state.json` 保持为 UI 的文件。

WebUI 设置页其余条目 — 通用 卡片里的语言和日志缓冲大小 — 有意 **不在** 这里：那些是 UI
偏好，不是核心意图，留在 WebView 自己的 localStorage 里。日志等级 也不是 UI 偏好，但它
同样不是 `state.json` 意图：它改变 `config.json`，所以归 shell 自己的文件
`runtime/loglevel`
（[ADR 0015](adr/0015-log-level-waits-for-the-next-core-start.md)），在下一次核心启动时
生效。

## Node

公共字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | **不透明** 的 16 位十六进制 id，由节点的身份（下文）推导而来。绝不解析它、绝不手改它。 |
| `name` | string | 显示名，来自链接的 `#fragment`（若有），否则 `host:port`。不参与身份。 |
| `protocol` | string | `vless` \| `vmess` \| `trojan` \| `ss`。 |
| `address` | string | 主机名或 IP，IPv6 **不带** 方括号。 |
| `port` | int | 1–65535。 |
| `transport` | string | `tcp` \| `ws` \| `grpc` \| `h2` \| `httpupgrade` \| …（按链接原样保留）。 |
| `security` | string | `none` \| `tls` \| `reality` \| …（按链接原样保留）。 |
| `sni` | string? | TLS 服务器名。 |
| `alpn` | string[]? | 例如 `["h2","http/1.1"]`。 |
| `fingerprint` | string? | uTLS 指纹（`fp`），例如 `edge`、`chrome`。 |
| `allowInsecure` | bool? | 仅当链接要求时才出现。 |
| `path`, `host`, `serviceName` | string? | 传输参数（`ws` path、`Host` 头、`grpc` service name）。 |
| `dirty` | bool? | 仅 UI：导入/更新改变了同 `id` 节点时置位；成功应用后清除。含义是"运行中的配置可能早于这些字段"，不是"未应用"。点按带 dirty 的已应用节点会重新应用它。shell 忽略它。 |

各协议专有字段：

| 协议 | 字段 |
| --- | --- |
| `vless` | `uuid`、`encryption`（`none`）、`flow`（`xtls-rprx-vision`）、`publicKey`（`pbk`）、`shortId`（`sid`） |
| `vmess` | `uuid`、`alterId`（int）、`cipher`（`auto`） |
| `trojan` | `password` |
| `ss` | `method`、`password` |

## 身份与去重

身份是下面这个元组，主机部分小写：

```
protocol | address | port | credential… | sni | host
```

其中凭据对 vless/vmess 是 `uuid`，对 trojan 是 `password`，对 ss 是 `method` + `password`；
`sni` 和 `host`（传输的 host 头）小写后并入，缺省为空。`name`、`transport`、`security`、
`fingerprint`、`alpn` 和其余传输参数 **不是** 身份的一部分。

`sni` 和 `host` 属于身份，因为 CDN 前置的地址按它们路由：地址和端口只指明边缘节点，流量
真正到达的服务器由 SNI（对 TLS）和 host 头（对 ws/http）挑选。两条链接共享地址、端口和
凭据、但在这两处不同，它们就是不同的节点，而不是同一节点的两种描述。

推论，全部是有意的：

- 重导同一节点原地替换并保留原 `id`；给节点改名再导入不会产生第二条。
- 在 URI 里改节点的 transport、fingerprint 或 path 得到相同的身份，所以 *那类* 修改会落到
  已有条目上而不是新建一条。条目被标记 `dirty`，否则仅凭 id 会让已应用配置看起来仍然是最
  新的。改 `sni` 或 `host` 不同：那是另一个节点，会追加新条目。
- 旧构建写出的 `id`（md5 风格）在按身份匹配节点时原样保留 — 起决定作用的是身份，不是
  哈希。

## 接受的输入

每行一条链接，或一段解码后是这种行的 base64 文本。

- `vless://uuid@host:port?type=…&security=…&sni=…&fp=…&pbk=…&sid=…&flow=…#name`
- `vmess://` + v2rayN JSON 对象（`add`、`port`、`id`、`aid`、`scy`、`net`、`tls`、…）的 base64
- `trojan://password@host:port?type=…&sni=…#name`
- `ss://` SIP002（`ss://base64(method:password)@host:port#name`）与旧形式
  `ss://base64(method:password@host:port)#name`

逐行大声拒绝并说明原因：未知的 scheme（`hysteria2://`、`tuic://` 等）、带 SIP003
`plugin=` 的 `ss://` 链接、以及任何 base64 或 JSON 解不开的东西。
