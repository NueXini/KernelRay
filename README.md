# KernelRay

一个在 Android 设备上运行 [Xray-core](https://github.com/XTLS/Xray-core) 的
[KernelSU](https://kernelsu.org) 模块。

**v0.7 — 透明代理（TPROXY 接管）。** 核心在 `127.0.0.1` 上暴露本地 `socks` / `http`
入站。WebUI 维护节点列表；点按某行打开详情对话框，其中的 **接管** 按钮把核心切到该节点。
接管不是可选项：**每次核心启动** 都会安装 iptables TPROXY 规则和策略路由，让设备的全部流量
（TCP/UDP、IPv4/IPv6、所有 UID）进入核心，DNS 由核心的 DNS 模块经节点应答。一次无法落实
接管的启动——另一个 VPN 占着流量、规则安装失败、核心拒绝配置——会被 **拒绝**：不装规则、
不起核心，设备保持直连而不是断网。反过来同样是 fail-closed：规则在位期间，核心死了就意味着
没有流量，而不是流量直连泄漏
（[ADR 0011](docs/adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）。

**v0.9 — 分流模式 (routing modes)。** 状态页有一个分流模式：**全局**（已接管节点承载所有
目的地——默认值，也是之前每个版本的行为）或 **大陆直连**（大陆域名和地址走 `direct` 出站，
其余仍走节点，DNS 同步分流，让大陆域名由国内解析器解析）。这些规则引用的 geo 数据
（`geosite.dat`、`geoip.dat`）随模块 ZIP 内置。切换模式会重新渲染配置并重启运行中的核心；
缺 geo 文件时降级为 全局，而不是留下一个起不来的核心
（[ADR 0014](docs/adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)）。

## 它做什么

| | |
| --- | --- |
| 启动时机 | 只在用户要求时：WebUI 的 启动 按钮（或 `kernelray.sh start`）。开机不自启，没有已接管节点时启动保持被拒绝 |
| 状态保存在 | `/data/adb/modules/KernelRay/` — 模块目录，也是我们 *唯一* 写入的地方 |
| 监听 | `127.0.0.1:10808`（socks5+socks5h）、`127.0.0.1:10809`（http）— 端口可在 WebUI 设置页配置（state.json 的 `settings`）；通配 `:10810`（tproxy，核心运行时） |
| 出站 | 已接管节点，或 分流规则 命中的目的地走 `direct`；没有已接管节点就什么都不会启动 |
| 切换节点 | 在某行详情对话框里按 **接管** 写入 `state.json` + 渲染出的出站；shell 渲染/测试/换入 `config.json` 并重启运行中的核心 — 一次渲染一次测试，字节没变则完全不重启（[ADR 0017](docs/adr/0017-one-render-one-test-per-switch.md)） |
| 接管设备流量 | 每次核心启动安装模块自己的 mangle/filter 链，捕获 fwmark 19283、旁路 fwmark 19282、表 19283/19282、规则 pref 9500/9400；绝不碰其他模块的规则，装不上规则的启动会被拒绝 |
| 应答 DNS | 端口 53 被捕获进核心的 DNS 模块；全局 模式下上游是经节点走的 DoH `https://1.1.1.1/dns-query`，大陆直连 模式下大陆域名直连询问 `223.5.5.5` / `119.29.29.29`，其余仍走 DoH；已接管节点自身的主机名直连解析 |
| 路由 | 状态页上的 分流模式：全局（默认）或 大陆直连（`geosite:cn` / `geoip:cn` → `direct`，`geosite:private` / `geoip:private` 保持本地）；geo 数据与核心一起放在 `bin/` |
| WebUI | 唯一的手动操作面：启动 / 停止、冲突 / 失败提示 + 重试、日志、导入节点、从节点列表切换已接管节点；分流模式 在状态页，日志等级 在设置页。模块不带 `action.sh`，所以管理器的模块卡片没有 ▶ 按钮（[ADR 0018](docs/adr/0018-no-action-button-and-no-boot-start.md)） |
| 配置 | `config.json`，由 `config.example.json` 生成；绝不手改 |
| 日志 | `logs/xray.log`（核心，详细程度来自设置页的 日志等级；启动时超过 1MB 轮转为 `xray.log.1`）和 `logs/kernelray.log`（模块：规则、冲突、启动） |

> **一切都在模块目录里。** 目录之外什么都不写，卸载不留残余。代价是：模块更新会整体替换该
> 目录，所以升级时 `config.json`、`state.json`、`outbound.json`、`outbound.meta`、`runtime/`
> 和日志都会被重置（见
> [`docs/adr/0002`](docs/adr/0002-everything-lives-in-the-module-dir.md)）。

把任意应用、Termux 命令或 adb 转发的客户端指向 socks 端口，验证核心确实在转发流量——
一个活着的 pid 什么都证明不了。没有已接管节点核心不会启动，所以一个能通的 socks 请求
必然从已接管节点出去。

## 透明代理（接管）

没有开关：接管就是核心启动的 *本体*
（[ADR 0011](docs/adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）。

- **每次启动都接管。** 没有已接管节点的启动会被闸门拒绝（没有可代理的东西），其余每次
  启动都装规则并跑那一份接管配置。没有"仅本地"模式：这个模块就是透明代理。
- **没有接管就没有核心。** 启动是有顺序的：先做冲突检查和节点钉死（趁网络还是直连），
  再渲染配置并跑 `xray -test`，再装规则，最后起核心。任何一步失败，核心都不启动，设备
  回到直连，状态报告 `failed/conflict`、`failed/rules`、`failed/config-invalid` 或
  `failed/no-config`；WebUI 提供重试，跑的是同一次启动。被核心拒绝的配置因此永远不会
  留下活的捕获规则。
- **Fail-closed。** 规则一旦装上就独立于核心的生死：之后核心崩溃，规则仍在，流量被丢弃
  而不是直连出去。
- **捕获什么。** 设备本地的 TCP 和 UDP、IPv4 和 IPv6、所有 UID——包括 DNS，即使查询
  发往局域网解析器。旁路：环回、私网/链路本地/组播段、DHCP，以及核心自身的连接（经旁路
  mark）。ICMP 保持直连：`ping` 不走代理，这是文档化的行为，不是 bug。
- **冲突时拒绝硬碰。** UP 状态的 `tun*`/`wg*` 接口、始终开启的 VPN 设置、或外来的
  `-j TPROXY` 规则，都会让启动以 `failed/conflict` 拒绝接管。检测是启发式的；经验法则
  仍然成立：同一时刻只能有一个透明代理。这种状态下核心不启动——冲突就是诚实的报告，
  解决冲突或卸载模块是仅有的两条出路。
- **监听端口不是开放代理。** tproxy 入站绑定通配地址；一条 filter 规则丢弃来自环回之外
  的、对 10810 端口的直接访问。

故障恢复速查。设备断网而状态是 running 的核心已经死了，意味着规则比核心活得久
（fail-closed）。四条出路，全都不需要网络：再按一次 **启动**（规则已在位，启动会复用
它们并重新拉起核心）；`kernelray.sh unapply`（忘掉节点并撤掉捕获）；重启（netfilter
活不过一次重启，见 [ADR 0018](docs/adr/0018-no-action-button-and-no-boot-start.md)）；
或卸载模块。不再有"把它关掉"这个选项。
核心自己死掉会在状态页显示为 **failed · core exited**——pidfile 比进程活得久——所以
死掉的核心不会被误认成已停止。`failed/rules` 表示安装失败且已回滚（看
`logs/kernelray.log`）；`failed/conflict` 表示另一个 VPN 占着流量。旁路路由在启动时
复制当时的默认路由；接管期间网络变了，重启核心（先停后启）以重建它。

机制细节——命名空间的取值和规则集——钉死在
[`docs/adr/0008`](docs/adr/0008-takeover-namespace-boot-and-toggle-semantics.md)，
建立在 [`docs/adr/0004`](docs/adr/0004-tproxy-takeover-is-module-owned-and-fail-closed.md)
和 [`docs/adr/0006`](docs/adr/0006-dns-goes-through-the-core.md) 之上。

## 分流模式 (routing mode)

状态页有一个分流模式，它决定流量 *去哪里*，而不是是否被捕获
（[ADR 0014](docs/adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)）。

- **全局（默认）。** 已接管节点承载一切；只有模块的固定策略（DNS、节点自身域名的解析、
  旁路）会把某些流量引向别处。之前每个版本都是这个行为，所以升级后什么都不会变，直到
  用户主动选择别的模式。
- **大陆直连。** 大陆域名（`geosite:cn`）和地址（`geoip:cn`）走 `direct` 出站；私网目的地
  （`geosite:private`、`geoip:private`）同样保持本地。其余一切仍然从节点出去。
  `domainStrategy` 变为 `IPIfNonMatch`，这样任何 geosite 分类都不认识的域名，解析后仍可
  匹配 `geoip:cn`。
- **DNS 跟着分流。** 固定的 DoH 上游会用海外 CDN 地址应答大陆域名，那样 `geoip:cn` 就
  永远匹配不上。大陆直连 模式下这些域名询问 `223.5.5.5` 和 `119.29.29.29`（以
  `expectIPs: ["geoip:cn"]` 过滤，海外 CDN 的应答会漏下去），且只有这些查询走直连；
  其余查询仍走经节点的 DoH。
- **切换立即生效。** 改模式会重新渲染配置、测试并重启运行中的核心——新配置起不来则回滚
  模式。路由不需要启动时接管那样的顺序保证。
- **本地入站同样生效。** geo 规则的编写不区分流量来自被接管的应用还是本地 socks 客户端，
  所以指向 `127.0.0.1:10808` 的应用得到同样的分流。
- **geo 数据随模块内置。** `bin/geosite.dat` + `geoip.dat` 与核心一起放进 ZIP，安装时和
  启动时都不联网拉取，数据的年龄就是发布版的年龄。每版钉死哪一套数据是逐发布决定、记录
  在发布说明里：发布版钉 Loyalsoldier 的（压缩后约 7.4MB），为了它额外的分类；测试构建
  用核心自带 ZIP 里的那份（约 3.3MB）。两套都有 `cn` 和 `private`，而 XTLS 那套的
  `geoip:cn` 是两者中更大的，所以钉哪套不影响 大陆直连 是否可用。文件自身不带版本戳——
  设置页只显示"存在"，不显示是哪一套。模块更新会把这份数据连同模块目录一起重置。
- **缺数据永远不弄死核心。** 文件缺失时 `routing cn` 拒绝切换，启动发现文件不在则渲染
  全局 并记日志：安全的方向是"全部走节点"，绝不是一份加载不了的配置。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `module/` | 模块本体；其 **内容** 就是发布 ZIP 的根 |
| `module/module.prop` | id、version 和 **versionCode** — 版本信息的唯一来源 |
| `module/scripts/kernelray.sh` | 共享助手：路径、核心探测、启动/停止、接管、状态；也是 WebUI 调用的 CLI |
| `module/scripts/tproxy.sh` | 接管：规则安装/移除、冲突检测、启动时的 prepare/engage 对；也是 分流 的各块（DNS 和路由）与 `tproxy status` / `routing` CLI；由 `kernelray.sh` source |
| `module/webroot/index.html` | WebUI 标记：纯 HTML，无构建步骤，无依赖 |
| `module/webroot/app.css` | WebUI 样式；两套配色都在这里，以 `data-theme` 属性区分 |
| `module/webroot/theme.js` | 主题偏好：合法取值、`auto` 的解析、以及在首次绘制前写入 `data-theme` 的 `<head>` 段 |
| `module/webroot/app.js` | WebUI 逻辑：读 `state.json`、导入节点、渲染节点列表和详情对话框、把已接管节点渲染成 Xray 出站、驱动 CLI |
| `docs/state-schema.md` | `state.json` 里有什么 — UI 写入所依据的权威 |
| `docs/config-derivation.md` | `config.json` 如何生成、接管与回滚 |
| `docs/dev-workflow.md` | 我们实际在用的 adb 安装 / 验证 / 驱动 UI 循环，以及其中的坑 |
| `docs/xray-guide.md` | 把 Xray 官方文档映射到本模块实际渲染的东西 — 每个配置块来自哪里、我们用到的每个协议/链接、以及官方教程哪些地方不适用于我们 |
| `tests/parse.test.js` | 分享链接解析器测试，对随包 `app.js` 里的解析器块运行 |
| `tests/outbound.test.js` | 节点 → Xray 出站渲染器测试，对随包块运行 |
| `tests/nodelist.test.js` | 节点存储 → 列表行（已接管/已选中/已变更标记）与详情对话框按钮状态测试，对随包块运行 |
| `tests/link.test.js` | 节点 → 分享链接与订阅 Base64 测试，经随包解析器做往返 |
| `tests/prefs.test.js` | 设置页偏好（主题、语言、日志缓冲）的规范化/加载/保存测试，对随包块运行 |
| `tests/theme.test.js` | 主题偏好 → `data-theme` 解析、跟随系统的订阅与头部写入测试，对随包 `theme.js` 运行 |
| `tests/config.test.js` | 模板组装、一次渲染形态、接管失败路径、清空日志 CLI、启动回滚与 日志等级 的启动时修补，对随包 shell + 假核心运行 |
| `tests/tproxy.test.js` | 规则安装/移除、冲突检测、启动顺序（先测配置后装规则，没有接管就没有核心）与"不存在开关"的断言，对假的 iptables/ip 二进制运行 |
| `tests/routing.test.js` | 分流模式 渲染矩阵（全局/大陆直连）、geo 数据降级与 `routing` CLI 的失败路径，对随包 shell 运行 |
| `docs/webui.png` | WebUI 截图 |
| `module/config.example.json` | 用于生成 `config.json` 的配置模板（占位、不可直接运行） |
| `module/bin/` | arm64 核心与其加载的 geo 数据（`geosite.dat`、`geoip.dat`），**不入库** — 见 `module/bin/README.md` |
| `module.yaml` | KernelSU Modules 展示元数据（名称、简介、图标、标签等） |
| `scripts/pack.sh` | 从 `module/` 构建 `build/KernelRay-<versionCode>-<version>.zip` |
| `GLOSSARY.md` | 我们所说的 节点 / 订阅 / 已选中节点 / 模块目录 / 接管 是什么意思 |
| `docs/adr/` | 值得记住的决策 |

## 安装

```sh
# 1. 放置核心与 geo 数据（见 module/bin/README.md）
#     module/bin/xray                    <- Xray-android-arm64-v8a.zip
#     module/bin/{geosite,geoip}.dat     <- 测试：同一个 ZIP；发布：Loyalsoldier 的
#     三件一条命令，指定文件名以免把 ZIP 自带的 README.md 解压覆盖到
#     module/bin/README.md 上：
#       unzip -j Xray-android-arm64-v8a.zip xray geosite.dat geoip.dat -d module/bin/

# 2. 构建并刷入
scripts/pack.sh
adb push build/KernelRay-*.zip //data/local/tmp/ && adb shell su -c 'ksud module install /data/local/tmp/KernelRay-*.zip'
```

两者缺一 `scripts/pack.sh` 就拒绝构建，因为 `xray -test` 会加载 geo 数据：没有它的 ZIP
根本跑不了 大陆直连。

安装在下一次重启前只是暂存——KernelSU 解包到 `/data/adb/modules_update/` 并在开机时换入。
完整循环（等开机、验证、打开 WebUI、模拟更新或卸载）以及随之而来的坑，见
[`docs/dev-workflow.md`](docs/dev-workflow.md)。

模块仅支持 arm64，内置一个核心 `bin/xray`。该二进制缺失或无法在设备上执行时安装会大声
失败；x86_64 模拟器经 ARM 转译运行它。

## 验证

```sh
# 核心活着，且只有一个实例
ps -A -o PID,ARGS | grep 'xray run'
cat /data/adb/modules/KernelRay/runtime/status.json     # {"state":"running","node":"…"}
cat /data/adb/modules/KernelRay/runtime/applied         # 未接管节点时为空，之后是节点 id

# 核心确实在转发流量
adb forward tcp:11080 tcp:10808
curl -sS -o /dev/null -w '%{http_code}\n' --socks5-hostname 127.0.0.1:11080 https://www.gstatic.com/generate_204
```

在 WebUI 接管某节点后，同样的 `curl` 从该节点出去。没有已接管节点核心完全不启动，所以
一个成功的 socks 请求必然意味着已接管节点承载了它；想知道是哪个节点，看 `runtime/applied`。

验证设备流量——而不只是 socks 客户端——也走代理：

```sh
adb shell su -c 'iptables -t mangle -S KR_TP_OUTPUT | head'   # 模块自己的规则
adb shell su -c '/data/adb/modules/KernelRay/scripts/kernelray.sh tproxy status'   # rules=present
adb shell su -c 'cat /data/adb/modules/KernelRay/logs/kernelray.log'
# 设备上的普通（非 socks）请求必须从节点出去：
adb shell su -c 'curl -sS -o /dev/null -w "%{http_code} %{remote_ip}\n" https://www.gstatic.com/generate_204'
```

`%{remote_ip}` 是节点的出口，不是设备的 WAN IP。DNS 用同样的方式查：
`adb shell su -c 'ping -c1 -W2 host.example'` 证明不了 DNS（ICMP 走直连），要用
`adb shell su -c 'nslookup www.google.com'`，并把应答与节点所在地区应返回的结果对比。

选了 大陆直连 时，同样的请求访问大陆站点必须 *不* 从节点出去：

```sh
adb shell su -c 'cat /data/adb/modules/KernelRay/runtime/route'        # 选了则输出 "cn"
adb shell su -c 'grep -o "geosite:cn" /data/adb/modules/KernelRay/config.json'
adb shell su -c 'curl -sS -o /dev/null -w "%{remote_ip}\n" https://www.baidu.com'
# 与非大陆站点对比：那个仍显示节点的出口
grep -i "geo data missing" /data/adb/modules/KernelRay/logs/kernelray.log   # 必须为空
```

## WebUI

<p align="center"><img src="docs/webui.png" width="300" alt="KernelRay WebUI"></p>

*截图早于节点列表和节点详情对话框；节点页现在是一个列表，点行打开详情对话框。*

在 KernelSU 管理器打开模块卡片，点 **WebUI**。页面有四个标签页 — **状态**、**节点**、
**日志** 和 **设置** — 标题和运行状态徽章固定在它们上方：

- **状态** — 启动 / 停止核心，分流模式（其所需 geo 数据缺失时给警告），冲突 / 失败提示
  与重试，以及 pid、运行时长、端口、核心版本和配置路径。
- **节点** — 节点列表（点行打开详情对话框；其中的 **接管** 完成切换）、每行的已接管/已变更
  标记、行内删除、编辑模式的复选 + 全选 + 批量删除，以及导入卡片。
- **日志** — 最后 N 行（N 是设置页偏好，默认 200），带跟随开关、核心日志 / 模块日志 两个
  标签页，视图下方一个 **清空日志** 按钮：一键截断当前显示的日志，不重启核心。
- **设置** — 一张 **通用** 卡片：主题（自动 / 日间 / 夜间）、UI 语言（自动 / 中文 / English）、
  日志缓冲大小和 日志等级（关闭 / 错误 / 警告 / 信息 / 调试），以及入站端口。主题、语言和
  日志缓冲是 WebView 偏好；端口存在 `state.json`，分流模式存在 `runtime/route`，日志等级
  存在 `runtime/loglevel`，所以没有一个能熬过更新或卸载。日志等级在下一次核心启动时生效，
  不是立即；调试 会写很多日志，诊断完记得切回 警告。

标签页是 hash 路由（`#/status`、`#/nodes`、`#/log`、`#/settings`）：刷新或深链接落在同一个
标签页，其他值回退到 `#/status`。只轮询可见的标签页外加状态徽章；切换标签页保留每个标签页
的滚动位置和没导入完的半截输入。

节点列表用 `runtime/applied` 来渲染 `state.manual` — `runtime/applied` 就是当前 `config.json`
由哪个 id 构建而来。已接管的行显示 **已接管**；重新导入后内容变过的节点（同 id）显示
**已变更**，其对话框提供 **重新接管**；一次失败的切换会让被尝试的行处于已选中但未接管状态，
旧行保持已接管。本版本列表不渲染订阅节点。

**节点详情对话框。** 非编辑模式下点一行打开只读对话框：节点各字段（包括凭据，这是有意
的）、已接管/已选中/已变更 徽章，以及一个分体的 **复制链接** 按钮，其折叠菜单还能把整条
链接以 **Base64** 形式复制（单行订阅形式；vmess 的链接本身就是 Base64 JSON，所以那种形式
是有意的双重编码）。链接由节点字段推导而来、不落盘，所以它描述的是模块将会运行的东西。
打开对话框不写任何东西、绝不碰核心。**复制链接** 失败时从异步 Clipboard API 回退到
textarea + `execCommand`
（[ADR 0016](docs/adr/0016-a-node-row-opens-a-detail-dialog.md)）。

**切换节点。** 在对话框里按 **接管** 先写 `state.selected`，把节点渲染到 `outbound.json` +
`outbound.meta`，然后跑 `kernelray.sh apply <id>`。shell 在旧节点还能用的时候先钉住节点的
地址，检查 `outbound.meta` 指向该 id，按活规则要求的形态从模板渲染候选配置，跑 `xray -test`
后原子换入，并重启运行中的核心。测试失败则旧配置和运行中的核心原封不动；候选配置测试通过
却起不来，则回滚到上一个配置。每次切换一次渲染一次测试，磁盘上的字节已经是该节点的就什么
都不做
（[ADR 0017](docs/adr/0017-one-render-one-test-per-switch.md)）：重新接管已接管节点，或保存
配置里已有的端口 / 分流模式，都不会重启核心。失败的切换从被尝试节点的对话框重试。见
[`docs/config-derivation.md`](docs/config-derivation.md)。

**添加节点。** 在导入卡片里每行粘贴一条链接（或整段 base64 订阅内容），点 *解析*：每行
单独报告结果，解析出的节点待导入，被拒的说明原因（`hysteria2` 不支持，带 SIP003 插件的
`ss://` 链接不支持，等等）。支持：`vless`、`vmess`（base64 JSON）、`trojan`、`ss`
（SIP002 和旧形式）。*导入* 合并进 `state.json` — 重导同一节点原地更新并保留其 id，
改名不会产生重复。

导入通常只填充节点列表、不动选择；之后打开某行的对话框按 **接管**。例外是往一个没有已
接管节点的存储里导入：`selected` 仍能解析就接管它，否则接管列表显示的第一个节点，让模块
不必多点一下就能用——它绝不启动已停止的核心，而且这是唯一不经详情对话框的接管路径
（[ADR 0012](docs/adr/0012-import-applies-the-first-node-when-nothing-is-applied.md)）。
删除节点需要点两下；删除已选中的节点会清掉选择。核心运行中或列表里还有别的节点时，拒绝
删除已接管节点。只有当它是最后一个节点且核心已停止时才能删除，而且那次删除就是一次
unapply：核心配置、`runtime/applied`、渲染出的出站和 tproxy 规则一并清除，直到再次接管
节点前核心都无法启动
（[ADR 0013](docs/adr/0013-deleting-the-last-node-while-stopped-unapplies-it.md)）。

**批量删除。** *编辑* 把列表变成复选界面：每行一个复选框，点行切换勾选，工具条提供全选和
带勾选数量的删除。勾选集合只存在内存里 — 退出编辑模式或离开页面就丢弃，绝不碰
`state.json`。已接管行的复选框遵循与其 ✕ 相同的闸门（只有当它是最后一个节点且核心已停止时
才参与），删除走的路与单个删除相同，所以已选中指针和渲染出的出站以同样的方式被清理。

解析器、节点列表模型、节点链接生成器、出站渲染器和 UI 偏好都不用浏览器测试：
`node tests/parse.test.js`、`node tests/nodelist.test.js`、`node tests/link.test.js`、
`node tests/outbound.test.js` 和 `node tests/prefs.test.js` 从随包 `app.js` 里抽取打了标记
的块；`node tests/theme.test.js` 以 `window`/`document` 打桩的方式求值随包 `theme.js`，
就像 `<head>` 运行它那样。
`node tests/config.test.js` 对着假核心 source 随包 shell，检查模板组装、转义、一次渲染
形态、接管的失败路径和启动回滚路径。`node tests/tproxy.test.js` 对记录参数的假
`iptables`/`ip` 二进制运行规则安装器、冲突检测和启动顺序（配置在规则进去之前先测试，
无法接管的启动被拒绝）。

页面是个哑客户端：每个核心动作都跑 shell 用的同一个 CLI，所以两个入口的行为不可能分叉。

```sh
/data/adb/modules/KernelRay/scripts/kernelray.sh status   # key=value，供 WebUI 消费
/data/adb/modules/KernelRay/scripts/kernelray.sh log 50
/data/adb/modules/KernelRay/scripts/kernelray.sh log clear    # 原地截断 logs/xray.log
/data/adb/modules/KernelRay/scripts/kernelray.sh mlog clear   # 同上，作用于 logs/kernelray.log
/data/adb/modules/KernelRay/scripts/kernelray.sh start
/data/adb/modules/KernelRay/scripts/kernelray.sh stop
/data/adb/modules/KernelRay/scripts/kernelray.sh apply <node-id>
/data/adb/modules/KernelRay/scripts/kernelray.sh unapply    # 忘掉已接管节点：规则、配置、applied id、出站
/data/adb/modules/KernelRay/scripts/kernelray.sh tproxy status   # 只读：rules=present|absent
```

`apply` 是 WebUI 流程的最后一步：它期望 `outbound.json` 和 `outbound.meta` 已由 UI 为该
id 写好。WebUI 的节点列表是选择器；`apply` 只执行它要求的切换。

没有构建步骤也没有 `npm install`：`webroot/index.html`、`app.css` 和 `app.js` 原样入库，
页面经注入的 `ksu.exec` 桥与管理器通信。在管理器之外打开时它会明说，而不是装作能用。

## 有意不做的事

用户可编辑的规则列表（规则模型、排序语义、校验 UI）、基于 `geosite:` 的广告拦截
（`block` 出站在模板里但未使用）、分应用代理/旁路、拉取订阅 URL（页面没有校验 TLS 的
fetcher，而订阅 URL *本身就是凭据*）、手改 `config.json`、热点/转发流量、TUN、看门狗/
自动重启、多核心支持（sing-box/mihomo/…）——都是搁置，不是否决；见 `docs/adr/`。

## 发布新版本

1. 开启 **设置 → 通用 → Releases → Enable release immutability**（一次即可）。
2. 提升 `module/module.prop` 里的 `version` 和 `versionCode`（versionCode 必须增大）。
3. 提交，然后打 tag 并推送：

   ```sh
   git tag v0.6.0 && git push origin v0.6.0
   ```

4. 工作流打包 `module/`，用 KernelSU Modules 校验器预检并发布
   `KernelRay-<versionCode>-<version>.zip`。

> 注意：核心不入库，所以 CI 目前发布的是 **不带** 核心的 ZIP。在工作流扩展为拉取钉死版本
> 的核心之前，发布构建得在本地产出。

## 许可

[MIT](LICENSE)
