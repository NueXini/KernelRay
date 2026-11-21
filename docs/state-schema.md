# `state.json` — 用户意图

位置：`/data/adb/modules/KernelRay/config/state.json`，权限 `0600`，属主 `root`；`config/`
目录本身 `0700`，其中的文件一律 `0600`。

`state.json` 是 **意图**：用户选的是哪一个节点、要哪些本地端口。`config.json` 是核心实际
运行的 **派生产物**。两者不是同一个文件，UI 绝不能把一个当成另一个来呈现。

用户意图不再集中在 `state.json` 一个文件里：这次重组把节点库拆成每节点、每订阅一个文件，
全部住在 `config/` 下，一文件一写入者 —

| 文件 | 内容 |
| --- | --- |
| `config/state.json` | 本文档的主角：`selected` 与端口设置（见下） |
| `config/nodes/<id>.json` | 一个手工节点一个文件：裸节点对象，`id` 包含在内（见下文 Node） |
| `config/subscriptions/<id>.json` | 一条订阅一个文件：`{id,name,url,nodes[],lastFetched?,lastError?}`，节点内嵌（见 订阅动作） |
| `config/webui/preferences.json` | UI 偏好：主题、语言、日志行数（见下文） |

`manual` 与 `subscriptions` 数组从 `state.json` 移除；旧布局（模块根下的 `state.json`、
渲染出站等）没有迁移 — 升级到这次重组之后的版本时按新布局从零开始，旧文件有意废弃。

在 WebUI 节点列表点一行会打开只读的 节点详情弹窗；按下其中的 应用 按钮会写 `selected`、
把节点渲染到 `config/outbound.json`/`config/outbound.meta`，然后调用
`kernelray.sh apply <id>`（见 [`config-derivation.md`](config-derivation.md)）。`selected`
先写，所以切换失败时意图仍指向被尝试的节点，而 `config/runtime/applied` 仍指向核心正在
运行的节点。

写入方：WebUI 导入器与节点列表的删除（`config/nodes/<id>.json`）、订阅的添加/刷新/改名/
删除（`config/subscriptions/<id>.json`）、节点详情弹窗 的应用路径、以及成功应用路径
（清除节点的 `dirty` 标记时写回节点文件）。读取方：WebUI 节点列表和节点详情弹窗。
所有权说明：shell 写运行时事实（`config/runtime/status.json`、`config/runtime/applied`、
pid），UI 写意图和渲染出的出站（`config/outbound.json` + `config/outbound.meta`）；
`config/config.json` 由 shell 写。

## state.json 字段

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema` | int | Schema 版本。目前为 `1`；其他值 UI 一律拒绝解释。 |
| `revision` | int | 每次写入都递增，过期的阅读方由此察觉文件变了。 |
| `settings` | object | 用户选择的核心设置。目前两个字段：`socksPort` 和 `httpPort`，本地入站端口（见下）。未知字段原样保留。 |
| `selected` | string | 用户最后选择的节点的 `id`。通常即已应用节点；切换失败时停在被尝试的节点上。未选中任何节点时为 `""`。 |

未知顶层字段被保留：写入方解析整个文件、修改对象、再序列化回去，所以旧 UI 不会丢字段。

`selected` 是愿望。当前核心配置实际由哪个节点构建，看的是 `config/runtime/applied`，由
`kernelray.sh apply <id>` 写入；节点列表把两者都标记出来，并在不一致时说明（切换失败）。
`config/outbound.json` / `config/outbound.meta` 存的是最后一次渲染的候选；只有
`config/runtime/applied` 能说明换入是否真的成功了。

## 节点列表动作

节点页把 `config/nodes/` 下的手工节点与每条订阅的 `nodes` 一起渲染成分组列表：手工在前，
之后每条订阅一组，同身份的手工节点优先（订阅那条不渲染）。下面这些动作只作用于手工节点
文件（`config/nodes/`）；订阅自己的动作见下一节。它们绝不写 `config/config.json` 或
`config/runtime/applied`。

- **导入** 写一个新的 `config/nodes/<id>.json`、原地更新已有文件（保留 id）。若尚未应用
  任何节点（`config/runtime/applied` 不存在或为空），导入还会切换到 `selected` 仍能解析到
  的节点，否则切换到列表显示的第一个节点：它写 `selected` 并按与 应用 按钮相同的写入序列
  应用它（见 切换节点 和
  [ADR 0012](adr/0012-import-applies-the-first-node-when-nothing-is-applied.md)）。已有已
  应用节点时它不动任何指针；用户之后打开某行的对话框并应用。这是唯一不经 节点详情弹窗 的
  应用路径。
- **点按节点** 打开只读的 节点详情弹窗；它不写任何东西、绝不碰核心。弹窗里的 **应用** 写
  `selected`、把节点渲染到 `config/outbound.json` + `config/outbound.meta`、然后调用
  `apply <id>`。应用字段未变的 **已应用** 节点对核心不做任何事（只有失败的切换把
  `selected` 留在别处时才重新同步它）。应用重导入后变过的已应用节点（`dirty`）则重新应用。
- **删除** 对已应用节点在核心运行中或列表里还有其他节点时被拒绝。允许的情形是已应用节点
  是最后一个节点且核心已停止：此时 UI 在删节点文件之前先调 `kernelray.sh unapply`，它移除
  接管规则、`config/config.json`、`config/runtime/applied`、`config/outbound.json` 和
  `config/outbound.meta`，并写 `stopped`/`no-node` — 模块回到从未应用过的状态
  （[ADR 0013](adr/0013-deleting-the-last-node-while-stopped-unapplies-it.md)）。已应用 id
  已经悬空时，一次清空列表的删除同样触发 unapply。删除已选中节点会清掉 `selected`；删除
  渲染出站还在磁盘上的节点（其 id 在 `config/outbound.meta` 里）还会移除
  `config/outbound.json` 和 `config/outbound.meta`，让凭据不比节点活得久。删除需要点两下
  确认。
- **切换失败** 会把 `selected` 留在被尝试的节点上。列表把它标记为未应用、旧节点保持已应用
  标记；打开被尝试节点的对话框按 应用 即可重试。

弹窗的 复制链接 和 订阅 Base64 动作是从节点字段 **推导** 的；节点文件里不存原始分享
链接。因此生成的链接描述的是模块将会运行的那个节点，未必是导入时粘贴的原文。

## 订阅动作

订阅的节点与手工节点共用同一张列表，但归订阅所有：刷新整体替换，删除只能整条删。一条
订阅就是 `config/subscriptions/` 下的一个文件，节点内嵌其中。

- **添加**（添加弹窗的 订阅页签）先写一条 `config/subscriptions/<id>.json`
  （`{id,name,url,nodes:[],lastFetched:0}`）再抓取：抓取或解析失败时这条订阅仍留在列表里，
  原因写进 `lastError`，用户点刷新重试。成功则把解析出的节点写进 `nodes`、记
  `lastFetched`、清 `lastError`；若尚未应用任何节点，还会切换到 `selected` 仍能解析到的
  节点，否则列表显示的第一个节点（同 导入 的规则）。
- **刷新**只写这条订阅的文件：`nodes` 整体替换成这次抓到的节点，同身份的旧条目保留原 id，
  字段真的变了才标 `dirty`（与导入同一条规则）。它绝不渲染、绝不重启核心；已应用节点因此
  可能落后于节点库，若它在刷新后消失，`config/runtime/applied` 会悬空，列表按
  `appliedMissing` 说明。抓取失败（含 0 个节点）保留旧节点，只写 `lastError`。
- **改名**只改 `name`，URL 与 `id` 不动（换 URL 是删除后重加）。
- **删除**删掉整条订阅及其全部节点 — 移除 `config/subscriptions/<id>.json`，内嵌的节点
  随之消失 — 门槛与删除单个节点相同：含已应用节点时核心必须已停止、且删完列表为空，此时
  先 `unapply`（ADR 0013）；其余情况拒绝。
- 订阅节点不能单条删除：编辑模式的 勾选 只作用于手工节点。

`settings.socksPort` 和 `settings.httpPort` 是 **入站端口**（默认 10808 和 10809）：shell
的渲染直接读它们，用行级 `sed` 提取
（[ADR 0009](adr/0009-shell-reads-state-settings-for-inbound-ports.md)），某字段缺失、非数字
或超范围时逐字段回退到默认值。UI 写入前校验这对值（1–65535、互不相同、绝不许是 10810 —
tproxy 入站的端口），并调 `kernelray.sh ports` 应用，其行为如节点应用一样重渲染并重启 —
配置已带保存的端口时两者都不做
（[ADR 0017](adr/0017-one-render-one-test-per-switch.md)）。`settings` 里其余字段原样保留、
暂不解释。

分流模式 有意 **不在** 这里：它是 shell 自己的偏好 — `config/runtime/route`，由
`kernelray.sh routing global|cn|cnadblock` 写入
（[ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)、
[ADR 0021](adr/0021-ad-blocking-is-a-third-routing-mode.md)）— 因为 shell 必须能不经 UI
就改变它，也因为一次 `cn` 渲染必须先检查 geo 数据才能承诺什么。文件里存的是模式自己的名字
（`cn`、`cnadblock`）而不是存在标志；缺省即 `global`，偏好未设时安装器写入 `cnadblock`
（docs/adr/0021）。`state.json` 保持为 UI 的文件。

WebUI 设置页其余条目 — 通用 卡片里的主题、语言和日志缓冲大小 — 有意 **不在** 这里：那些是
UI 偏好，不是核心意图，持久化在 `config/webui/preferences.json`（`{v,theme,lang,logLines}`）。
它随 `config/` 一起活过模块更新（见 模块更新与卸载）；升级后文件缺失时，WebView 把旧的
localStorage 值一次性种进该文件，此后 localStorage 不再是事实来源。日志等级 也不是 UI
偏好，但它同样不是 `state.json` 意图：它改变 `config.json`，所以归 shell 自己的文件
`config/runtime/loglevel`
（[ADR 0015](adr/0015-log-level-waits-for-the-next-core-start.md)），在下一次核心启动时
生效。

## Node

一个手工节点就是 `config/nodes/<id>.json` 里的一份裸对象 — 没有任何包装，字段如下；订阅
节点是订阅文件 `nodes` 数组里的同一份对象。公共字段：

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
| `dirty` | bool? | 仅 UI：导入、订阅刷新改变了同 `id` 节点时置位；成功应用后清除。含义是"运行中的配置可能早于这些字段"，不是"未应用"。点按带 dirty 的已应用节点会重新应用它。shell 忽略它。 |

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

- 重导同一节点原地替换并保留原 `id`（文件还是 `config/nodes/<id>.json` 那一份）；给节点
  改名再导入不会产生第二条。
- 在 URI 里改节点的 transport、fingerprint 或 path 得到相同的身份，所以 *那类* 修改会落到
  已有条目上而不是新建一条。条目被标记 `dirty`，否则仅凭 id 会让已应用配置看起来仍然是最
  新的。改 `sni` 或 `host` 不同：那是另一个节点，会追加新文件。
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

## 模块更新与卸载

模块更新 **不再重置用户配置**。KernelSU/Magisk 把更新暂存在 `modules_update/<id>`，旧目录
`/data/adb/modules/KernelRay` 在重启换包前原封不动；`customize.sh` 在此期间把旧安装的
`config/` 整树复制进新安装，然后删掉其中的启动期临时文件：`config/runtime/status.json`、
`xray.pid`、`started`、`rules`、`nodeip`、`watch.lock`、`subfetch.url`，以及
`config/runtime/config.tested`（新核心必须在下一次启动重新通过 `xray -test`）。其余一切 —
节点库、订阅、`selected`、端口、UI 偏好、上一次的 `config.json` 与渲染出站、`config/runtime`
里其余文件 — 都活过更新。

卸载不变：KernelSU 删除整个模块目录，`config/` 与 `logs/` 随之消失。
