# 核心配置是如何推导出来的

`config.json` 是生成物。不要手改它：应用节点会重写它，模块也会在它缺失时重新生成。模板
才是扩展点。

本实现落实 [ADR 0005](adr/0005-core-config-is-derived.md)（UI 渲染数据，shell 掌握布局）、
[ADR 0006](adr/0006-dns-goes-through-the-core.md)（固定的 `direct` 出站携带 v0.7 旁路标记）
和 [ADR 0016](adr/0016-a-node-row-opens-a-detail-dialog.md)（点节点行打开详情弹窗；其 应用
按钮是切换手势）。

## 文件与写入者

| 路径 | 写入者 | 性质 |
| --- | --- | --- |
| `state.json` | WebUI | 用户意图：节点库与 `selected` |
| `outbound.json` | WebUI | 被应用节点渲染成的 **一条** Xray 出站；`unapply` 会移除它 |
| `outbound.meta` | WebUI | 该出站的 `id=<node-id>` 与 `host=<address>`；`unapply` 会移除它 |
| `config.example.json` | 仓库 | 配置模板（本身不可运行） |
| `config.json` | shell | 核心实际运行的配置 |
| `state.json` → 渲染 | WebUI 写、shell 读 | 入站端口（`settings.socksPort` / `settings.httpPort`），渲染时提取（ADR 0009） |
| `runtime/applied` | shell | `config.json` 由哪个节点 id 构建而来 |
| `runtime/config.tested` | shell | 通过了 `xray -test` 的那些字节的副本（ADR 0017） |
| `runtime/status.json` | shell | `state`、`phase`、`started`、`revision`、`node`、`route`、`boot`（写入它的那次开机；阅读方把别的开机的文件当 `idle`，docs/adr/0018） |
| `runtime/route` | shell | 持久化的 分流模式，按文件内容读取：`cn` 或 `cnadblock`，不存在 = 全局；未设时安装器写入 `cnadblock`（docs/adr/0014、docs/adr/0021） |
| `runtime/rules` | shell | 上一次真实规则存在性检查的开机范围缓存：状态轮询读它；安装/移除与缓存未命中写它；启动路径仍会问 iptables（docs/adr/0019） |
| `runtime/loglevel` | shell | 持久化的 日志等级；不存在 = 警告（docs/adr/0015） |
| `bin/` | 仓库 | 核心与其加载的 geo 数据：`xray`、`geosite.dat`、`geoip.dat`（docs/adr/0014） |

一文件一写入者：UI 绝不写 `config.json`、`runtime/applied` 或 `status.json`；shell 绝不写
`state.json`、`outbound.json` 或 `outbound.meta`。唯一的例外是 `unapply`，它把渲染出的出站
连同其余从已应用节点派生的东西一起移除
（[ADR 0013](adr/0013-deleting-the-last-node-while-stopped-unapplies-it.md)），但绝不重写。
这个划分不需要任何锁。

`outbound.json` 含凭据；它与 `outbound.meta` 都以 `0600` 权限原子写入，和 `state.json`
一样。`pack.sh` 把它们排除在外。

## 模板

`module/config.example.json` 是固定的骨架：本地 socks/http 入站（其端口是带引号的占位符
`"__KERNELRAY_SOCKS_PORT__"` / `"__KERNELRAY_HTTP_PORT__"`，渲染时替换成 `state.json` 的
`settings` 里的端口，默认 10808/10809），以及四条出站 —

```json
"outbounds": [
  "__KERNELRAY_OUTBOUND__",
  { "tag": "direct", "protocol": "freedom", "streamSettings": { "sockopt": { "mark": 19283 } } },
  { "tag": "block", "protocol": "blackhole", "settings": {} }
  ,"__KERNELRAY_DNS_OUTBOUND__"
]
,"dns": "__KERNELRAY_DNS__"
,"routing": "__KERNELRAY_ROUTING__"
```

- `"__KERNELRAY_OUTBOUND__"` 是带引号的占位符；整个字符串被替换。文件对工具来说仍是合法
  JSON，但它 **不是** 可运行的 Xray 配置，所以不会被误用。
- 第一条出站是没有路由规则命中时 Xray 的默认出站。它永远是已应用节点的出站（tag `proxy`）：
  没有它 `kr_render_config` 拒绝渲染 — 核心绝不运行不是从已应用节点推导出的配置
  （[ADR 0010](adr/0010-the-core-only-runs-an-applied-nodes-config.md)）。
- `"loglevel": "__KERNELRAY_LOGLEVEL__"` 在每次渲染时替换为 日志等级 偏好
  （`runtime/loglevel`，默认 警告）。值在拼入前经过校验，缺该占位符的模板与缺端口占位符的
  模板一样被拒绝。
- 接管占位符用同一手法，每行一个、各自带前置逗号：`inbounds` 里的
  `,"__KERNELRAY_TPROXY_INBOUND__"`、`outbounds` 里的 `,"__KERNELRAY_DNS_OUTBOUND__"`，加上
  顶层 `"dns"` 和 `"routing"` 键（值为带引号占位符）。每一个都总是被替换 — 只有一种形态
  （[ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）— 结果是
  合法 JSON，模板本身也是，因为每个占位符都是带引号的字符串。
- `config.json` 里绝不残留占位符。缺出站占位符的模板会被 `kr_render_config` 拒绝。

shell 不解析出站。它把 `outbound.json` 当作不透明的 JSON 片段读取（UI 写成一行；换行只在
人手工美化时才出现），所以协议知识留在经过测试的 JS 渲染器里
（`tests/outbound.test.js`）。

## 唯一的形态

每次渲染都是接管形态
（[ADR 0008](adr/0008-takeover-namespace-boot-and-toggle-semantics.md)）；不存在第二种，
因为每次核心启动都接管
（[ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）。渲染器是
模板、已应用出站和偏好的纯函数：它不向内核问任何东西。

接管各块是：通配 `::` 上端口 10810 的 dokodemo-door tproxy 入站；`dns-out` 出站；`dns`
模块（上游取决于 分流模式，大陆直连去广告 还加上它的 `hosts` 沉没端，见下）携带
`tag: "dns"` — 下面每条 DNS 路由规则都匹配这个名字，核心用它给模块自己的上游查询打标，
而不是内部的 `xray.system.<uuid>`；以及路由规则 — 已应用节点的主机名经 `direct` 解析
（主机是 IP 字面量时跳过）、DNS 模块的上游查询走 `proxy`、端口 53 的 tcp/udp 送往
`dns-out`。节点出站里的 `"__KERNELRAY_MARK__"` 占位符变成旁路标记 19282。占位符本身由 UI
渲染器写出；丢失它的渲染出站会被拒绝，因为在规则之下它的包会被捕获回核心。

分流 规则也总是编写。全局 带上 DNS 组和端口 53 捕获；大陆直连 和 大陆直连去广告 追加
geo 规则，大陆直连去广告 再给 DNS 模块加上广告沉没端。

应用节点先渲染并测试候选配置，之后才碰运行中的核心，所以坏节点永远不会弄停它
（ADR 0007）。启动只在字节不同时重渲染 — 一份按旧偏好写下的配置（geo 数据消失、等级变了）
就是这样被修补的，一份出自还有第二种形态的旧版本的配置也是这样被替换的。

## 启动路径

`kr_start_locked` 先跑闸门，然后跑接管的两个半程、配置夹在中间
（[ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）：

1. `kr_tp_prepare` — 冲突检查与节点钉死，趁网络还直连（钉死的那次 DoH 询问绝不能进入一条
   通向尚未运行的核心的捕获）。
2. `kr_ensure_config` — 渲染并 `xray -test`；只有磁盘字节与测过的不同才换入。
3. `kr_tp_engage` — 安装规则，仍在核心运行之前（fail-closed，ADR 0004）。
4. fork 核心，等待其入站就绪。

任何一步失败都拒绝这次启动：核心不起、设备回直连，状态记为 `failed/conflict`、
`failed/rules`、`failed/config-invalid` 或 `failed/no-config`。顺序就是重点：被核心拒绝的
配置不会留下活的捕获，失败方向是"直连"，绝不是"断网"。

`kr_tp_install` 是幂等的 — 规则已在就原样不动 — 这让重启廉价，也让一次核心没能回来的
换入得以修复（`kr_swap_tp_rollback` 移除换入拉起的规则）。

## 一次启动何时算完成

`kr_start_locked` fork 核心后等的是事实而不是睡觉：socks 入站在 127.0.0.1 上监听 — 是
`config.json` 里带的那个端口，不是 `state.json` 愿望的那个 — 这才是"运行中"的含义。因此
一次启动在核心实际需要的时间内返回（约 50-150 ms），退出的核心在第一次轮询时就报告为
`failed/crashed`，而不是固定的一秒之后。截止时限（1.5 s）时还活着的核心算启动成功：慢的
核心不是失败的核心，之后再死的核心仍会在下一次状态读取中被报告为 crashed——读取方把
pidfile 与活进程对比。

每此调用而非每此询问付出的两笔成本：核心探测（`xray -version`，"这个二进制能在这里执行"
由此判定）被记忆化；游离进程扫描是对 `/proc/*/cmdline` 的一次 `grep`、先收窄到候选，而不是
每个 pid 一次 `cat` — 后者每次 fork 约 5 ms，在几百个进程的手机上就是好几秒。

## 日志等级

日志等级既是渲染输入也是延迟生效的偏好（ADR 0015）。UI 通过 `kernelray.sh loglevel` 保存
它（警告 是默认值并移除偏好文件），下一次核心启动发现 `config.json` 里带的等级不同，就
重渲染，然后才 `-test` 并启动。等级变化不触发其他任何重渲染。因为 `kr_render_config`
总是读偏好，一次应用、一次保存端口或一次切换分流模式也会把已保存的等级烘进它们重写的
配置里。

`status` 同时报告两侧：`loglevel=` 是偏好，`loglevelpending=` 只在运行中的核心于
`config.json` 里还带着不同等级时为 `1`。

## 应用节点

点节点行打开只读的 节点详情弹窗；按其 应用 按钮就是应用手势：它写 `state.selected`、渲染
该节点、先写 `outbound.meta` 再写 `outbound.json`，然后调用：

```sh
scripts/kernelray.sh apply <node-id>
```

`selected` 先写，这样写入中途崩溃留下的是诚实的"想要这个节点、运行着旧的"状态，而不是
一份比指针还新的配置。`outbound.meta` 先于 `outbound.json`，这样两者之间崩溃留下的是 id
不匹配（启动拒绝渲染，`failed/no-config`），而不是一条新出站配着旧 id。

shell 这边：

1. 趁旧节点还能用时钉住节点的主机地址（`runtime/nodeip`，ADR 0008）— 解析需要能用的网络，
   渲染需要解析的结果；
2. 向 `kr_config_candidate <id>` 要这次切换将运行的配置。它检查 id、检查 `outbound.meta` 的
   `id` 与之相等，把模板 + 出站渲染进 `runtime/config.new.json`，并对其跑
   `xray run -test -c`，输出进 `logs/xray.log` — **仅当那些字节与 `config.json` 不同**。
   相同（重新应用同一节点）时整个步骤零成本，手势到此结束：不测试、不停止、不重启；
3. `kr_swap_install` 记住核心是否在运行，把旧配置存为 `runtime/config.json.prev`，若核心
   在运行则停止它，原子 `mv` 候选为 `config.json`，chmod `0600`，记录 tested 标记并写
   `runtime/applied`；
4. `kr_swap_start` 若之前核心在运行则启动它。新配置起不来时，`kr_swap_rollback` 恢复
   `config.json.prev` 和旧的已应用 id，再启动旧配置 — 若那次启动也没能回来，则移除换入
   拉起的规则，所以失败的换入绝不会留下一个没有核心、却带着活捕获的设备；
5. 核心原本停止时，写 `status.json` 为 `stopped/idle` 并带新节点 id。

失败语义：

| 失败 | 结果 |
| --- | --- |
| 渲染错误、meta 不匹配、出站缺失 | 什么都没停、什么都没换；CLI 以非零退出 |
| 磁盘字节已是该节点的配置 | 不测试、不停止、不重启；仅重新同步 `runtime/applied` |
| `xray -test` 拒绝候选 | 旧配置与运行中的核心原封不动；CLI 以非零退出 |
| 候选启动成功 | 已应用 id 与 `status.json` 指向新节点 |
| 候选启动失败 | 恢复旧配置 + 旧已应用 id，启动旧配置；CLI 以非零退出 |
| 恢复的旧配置也起不来 | 文件与已应用 id 是旧的，但核心已停（`failed/crashed`） |
| 候选启动失败且无旧配置 | 派生配置与已应用 id 一并丢弃，核心保持停止（`stopped/no-node`）；CLI 以非零退出 |

`-test` 失败 **不** 写失败的 `phase`：旧核心仍在运行、仍然健康。CLI 返回错误；WebUI 用
toast 显示。只有失败的 **启动** 才让状态失败，恢复路径在旧配置起得来时清掉它。

应用仅在 **字节变化时** 重启运行中的核心：同一节点应用两次是一次无操作，保存配置已带的
端口或 分流模式 同样如此（ADR 0017）。节点列表标记已应用节点，切换失败后还标记已选中未
应用的那个。应用无变化的已应用节点对核心不做任何事；应用重导入保留了 id 并标记 `dirty`
的已应用节点则重新应用，`dirty` 标记在成功后清除。导入节点在按下弹窗的 应用 之前不改变
任何东西 — 往没有已应用节点的存储里导入除外，那次导入自己就应用一个节点
（[ADR 0012](adr/0012-import-applies-the-first-node-when-nothing-is-applied.md)）。那次导入
是唯一不经 节点详情弹窗 的应用路径。

## 为什么 shell 几乎不从 `state.json` 读东西

`state.json` 是嵌套 JSON 而设备上没有 `jq`。用 `awk`/`sed` 解析它就是 ADR 0003 对分享链接
拒绝掉的同一个隐患，所以 UI 在那边渲染节点、交给 shell 一条扁平出站。唯一的例外是入站
端口（[ADR 0009](adr/0009-shell-reads-state-settings-for-inbound-ports.md)）：
`kr_render_config` 用 `sed` 从 `settings` 对象里恰好提取两个扁平整数键，任何异常时逐字段
回退到 10808/10809。分流模式 没有长出这个例外：它是 shell 自己的偏好文件
（[ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)），所以
`sed` 仍然只读两个整数。日志等级 是同一类 shell 偏好
（[ADR 0015](adr/0015-log-level-waits-for-the-next-core-start.md)）。

## 应用入站端口

在设置页保存端口是一个形如节点应用的手势：UI 校验这对值（1–65535、互不相同、绝不许是
tproxy 的 10810），写 `state.json` 的 `settings`（意图先行），然后调用 `kernelray.sh
ports`。shell 重渲染配置 — 用的是已应用节点的出站，账目对不上时拒绝 — 没有已应用 id、
或 `outbound.meta` 指向别的节点，而不是渲染别的什么。随后经与 `apply` 相同的 备份 → 停止
→ 换入 → 重启 → 回滚 路径测试并换入。已应用 id 不动：端口改的是本地入站，从不改出站。
`-test` 或启动失败的候选让旧配置和运行中的核心保持原样。

## 转义

JSON 粘进 shell 字符串或 `awk -v` 的值并不安全：`$`、反引号、引号和反斜杠在某处都有含义。
`kr_render_config` 因此让出站行走 **环境变量**（`ENVIRON["KR_OUT_LINE"]`），`awk` 只定位
占位符并拼印各段。没有任何东西被再展开。`tests/config.test.js` 用一个含引号、反斜杠、`$`、
反引号、`&`、`<>` 和换行转义的 password 演练它。

## 启动与自愈

开机不自启（[ADR 0018](adr/0018-no-action-button-and-no-boot-start.md)）：`kr_start` 只从
WebUI 的 启动 或 `kernelray.sh start` 运行。其他一切之前，启动闸门要求一个已应用节点：
没有它什么都不会启动，status.json 记 `stopped/no-node`
（[ADR 0010](adr/0010-the-core-only-runs-an-applied-nodes-config.md)）。

然后 `kr_ensure_config` 让 `config.json` 成为这次启动将运行的配置 — 模块把意图变成配置的
唯一地点（[ADR 0017](adr/0017-one-render-one-test-per-switch.md)）：

- 它从 `outbound.json` 渲染并与 `config.json` 比较字节。字节相同则原样不动（不测试、不
  写入）；不同则测试并换入。这就是全部的漂移修复：日志等级变化和 geo 数据消失都会改变
  渲染字节，所以谁都不需要自己的检测器；
- `outbound.meta` 指向与 `runtime/applied` 不同的节点时 — 一次失败的切换，UI 已经写好
  *下一个* 节点 — 磁盘上的配置是已应用节点唯一的描述，于是原样接受，走同一个
  `xray -test` 闸门。完全没有渲染出站时，磁盘配置不可能描述任何东西，于是改为拒绝启动
  （"在 WebUI 重新点按该节点"）；
- 拒绝（无已应用节点、无出站、无配置可回退）使启动以 `failed/no-config` 失败，被拒绝的
  `-test` 以 `failed/config-invalid` 失败：声称某节点已应用而核心跑的却是别的，比起不来
  更糟。

启动本身不再跑 `xray -test`：它 fork 的配置就是标记说测过的那份（ADR 0017）。

升级整体替换模块目录（ADR 0002），所以配置、出站和已应用 id 一起重置。

## 分流模式 (routing mode)

`kernelray.sh routing global|cn|cnadblock` 写偏好并立即重新推导配置
（[ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)、
[ADR 0021](adr/0021-ad-blocking-is-a-third-routing-mode.md)）：渲染新形态 → `xray -test`
→ 写 `runtime/route` → 换入（`ports` 路径，含其停止、重启和回滚）。`global` 就是文件不
存在；`cn` 和 `cnadblock` 写自己的名字加一个换行，权限 `0600` — 文件是值，不是存在标志。

- **拒绝。** geo 数据缺失或 `-test` 拒绝候选时，`routing cn` 和 `routing cnadblock` 以非零
  退出、什么都不改。失败的换入在回滚启动旧配置 *之前* 就把偏好恢复为旧模式，因为那次启动
  会从模式重新推导配置 — 只恢复字节不恢复偏好只会把失败的模式再渲染一遍（ADR 0017）。
- **没有已应用节点。** 没有可重渲染的东西：偏好照写，下一次应用时渲染它。
- **默认。** `runtime/route` 尚未设置时安装器写 `cnadblock`（`kr_route_default`），geo 数据
  缺失时跳过 — 此时 全局 保持为模式，因为一个核心拒绝以其启动的默认值，比一个少做事的
  默认值更糟（docs/adr/0021）。用户的 全局 是文件不存在，所以下一次安装或更新会重建默认。
- **降级。** 渲染可以用的由 `kr_route_effective` 决定：仅当 `bin/geosite.dat` 和
  `bin/geoip.dat` 都存在且非空时才 `cn`，否则 `global` 并在 `kernelray.log` 记一行。偏好
  绝不被重写 — 发现数据没了的启动让一切走节点，而不是一份加载不了的配置。
  **`cnadblock` 永不降级**：名字承诺拦截的模式绝不能渲染成 大陆直连，所以缺文件交给
  `xray -test` 并拒绝启动 — `failed config-invalid`，`kernelray.log` 一行 `Routing`，stderr
  上给 WebUI toast 的 `geo data missing`，routing CLI 也以同样方式提前拒绝。这是对 0014 的
  "永远不要死核心"唯一一次有意的偏离（ADR 0021）。同一函数设置 `KR_ROUTE_CN` 和
  `KR_ROUTE_BLOCK_ADS`，DNS 与路由构建器读它们而不是比较模式字符串。
- **各块。** 大陆直连 在接管形态上追加：两个国内解析器（`223.5.5.5`、`119.29.29.29`），
  以 `expectIPs: ["geoip:cn"]` 过滤、服务 `domains: ["geosite:cn"]`，DoH 保留为其余一切的
  回退；一条把这些解析器自身的查询送 `direct` 的路由规则；`domainStrategy: IPIfNonMatch`；
  以及 `geoip:private`、`geosite:private`、`geosite:cn`、`geoip:cn` → `direct`。全局 不渲染
  这四者中的任何一个。大陆直连去广告 在该渲染上再加两个：
  `dns.hosts["geosite:category-ads-all"] = "#3"` — DNS 模块以 rcode 3（NXDOMAIN）应答空
  响应而不是解析，广告域名永远拿不到地址（`#<n>` 需要核心 ≥ 25.7.23）— 以及
  `{"domain": ["geosite:category-ads-all"], "outboundTag": "block"}`，放在 dns/端口-53 组
  之后、geo 规则之前：先命中先赢，所以大陆广告域名绝不能落进 `geosite:cn` → `direct`，解析
  器查询也绝不能被 block 吞掉。全局 逐字节保留 0014 之前的各块（`AsIs`，一条 DoH，三条
  规则）。
- **资源路径。** 什么都不导出。`bin/` 放核心与其数据，`XRAY_LOCATION_ASSET` 未设时核心从
  自己可执行文件所在目录解析 `geosite.dat`/`geoip.dat` — 26.10.29 在那里找，不是 cwd
  （设备上验证过：放在没有这两个文件的目录里的核心以
  `stat <exe-dir>/geosite.dat` 失败）。一个位置，不存在会与它不一致的第二条路径。

## 不变量

- `state.selected` 是意图；`runtime/applied` 是事实。UI 两者都显示，绝不等同它们。
- 节点出站 tag 为 `proxy` 且只带 `__KERNELRAY_MARK__` 占位符。在 Android 上，没有匹配
  ip 规则的任意 `SO_MARK` 会丢路由（验证过：去掉 mark 之前节点的 Reality 握手失败）。
  shell 恰好在规则在位时把占位符变成旁路标记；只有模板里固定的 `direct` 出站带字面 mark，
  且核心未被接管时它不使用。
- `config.json` 绝不手改、绝不进 ZIP。
- 核心绝不运行不是从已应用节点推导出的配置：每次渲染需要 `outbound.json`，每次启动需要
  `runtime/applied`，过去会产出直连（freedom）配置的每一条回退都已移除（ADR 0010）。
- `xray -test` 先于每次换入；失败的候选绝不替换能用的配置。
- 每次切换一次渲染一次测试：配置只渲染一次，来自调用方声明的意图，启动复用换入已测试的
  字节（ADR 0017）。
- `config.json` 只从模块目录内的文件生成：模板、出站、`state.json` 的端口、两个偏好文件
  和 `bin/`。运行时不联网拉取任何东西，也不导出资源路径：核心从它所在的目录读数据。
