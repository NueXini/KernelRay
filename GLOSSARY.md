# KernelRay

A KernelSU module that runs an Xray core on Android. The vocabulary below is what the code,
the scripts and the issues mean by these words.

## Language

**模块 (Module)**:
The KernelSU module as the manager installs and enables it, identified by `kernelray`.
_Avoid_: mod, addon, plugin

**核心 (Core)**:
The Xray executable itself, taken from an upstream `Xray-android-<arch>` release.
_Avoid_: binary, engine, xray-core (that is the upstream project, not our file)

**模块目录 (Module directory)**:
`/data/adb/modules/kernelray` — the one root: mechanism, core binary, config template, generated
core config, node store, logs and runtime state. It is also all we ever write to, so removing
the module leaves nothing behind. Replaced wholesale on update, which resets the user data
inside it; that cost is deliberate (see `docs/adr/0002`).
_Avoid_: install dir, app dir, data dir, storage, work dir

**空转 (Idle run)**:
The core is running the applied node's config with the tproxy switch off: it listens on its
local inbounds and no device traffic is redirected into it. Requires an applied node — the
core never runs a config that was not derived from one.
_Avoid_: running, normal mode, passive mode, direct run (that is the abolished no-node state)

**直连运行 (Direct run)**:
The core running the freedom (direct) outbound because no node was ever applied. A state the
module has abolished: without an applied node the core does not start. The word survives only
in old logs and issues.
_Avoid_: idle run, direct mode, freedom mode

**失败规则 (failed/rules)**:
The status phase meaning 接管规则 installation failed and was rolled back — the one takeover
failure that can leak traffic. It is written, never inferred by callers, and it never refers to
the 分流规则, which are refused before the core ever runs them.
_Avoid_: rules error, install failed, 分流规则失败

**失败冲突 (failed/conflict)**:
The status phase meaning takeover was refused because a foreign VPN/TUN or TPROXY setup owns
the traffic (see 冲突). The device keeps its network; only the takeover is not enforced.
_Avoid_: blocked, busy

**透明代理 (Transparent proxy)**:
Device traffic entering the core without any app being configured with a proxy address. It is a
behaviour the user can observe, not a mechanism. The settings-page switch combines the two on
purpose — its title is tproxy透明代理 — but alone, the behaviour is still not called tproxy.
_Avoid_: tproxy (alone, for the behaviour), hijack, redirection

**旁路标记 (Bypass mark)**:
The socket mark every core-owned outbound socket carries while takeover is on, which the policy
routing uses to exempt the core's own connections from capture. It only ever exists together
with the rules that read it: a mark without its matching rule loses routing.
_Avoid_: fwmark, SO_MARK (those name the mechanism, not the role)

**TPROXY**:
The Linux netfilter and policy-routing mechanism the module uses to reach transparent proxying.
_Avoid_: transparent proxy (that is the behaviour), tproxy mode

**本地入站 (Local inbound)**:
The socks and HTTP listeners the core opens on 127.0.0.1 for apps that are configured with a
proxy address. Traffic reaches them by choice, unlike the tproxy inbound that takeover owns.
_Avoid_: local proxy, manual inbound, app inbound

**入站端口 (Inbound port)**:
The port a local inbound listens on; the user picks it in the settings, with socks and http
kept distinct. Defaults to 10808 (socks) and 10809 (http).
_Avoid_: proxy port, local port

**接管 (Takeover)**:
The module's act of making device traffic enter the core instead of going out directly. An idle
run is the absence of takeover.
_Avoid_: hijack, capture, redirect

**接管规则 (Takeover rules)**:
The module's own iptables chains, marks and policy routing that put device traffic into the
core. They decide *whether* traffic is captured; the 分流规则 decide where it leaves once it is.
_Avoid_: iptables 规则, TPROXY 规则, 路由规则

**旁路 (Bypass)**:
Traffic the module deliberately leaves outside takeover: loopback, the local network ranges, and
the core's own connections. Bypass traffic never enters the core; a destination the 分流规则
sends `direct` did enter it and left again by another outbound, so that is 分流, not 旁路.
_Avoid_: whitelist, exception list (a per-app list is a different, later feature), 分流直连

**分流 (Split routing)**:
The core's own choice, taken from the 分流规则, that a destination leaves by the `direct`
outbound instead of the applied node. It happens to traffic the core already has — taken over
or handed to a 本地入站 — and it is a routing decision, not a capture one.
_Avoid_: 绕过 (as a noun), split tunnel, 白名单模式 (that names a mode, not the mechanism)

**分流模式 (Routing mode)**:
The persisted user choice of how the core routes: 全局 sends every destination through the
applied node, 大陆直连 sends mainland destinations out `direct`. It is a preference of its own
and changing it re-derives the core config at once — unlike the tproxy switch, which waits for
the next core start.
_Avoid_: 路由模式 (that is Xray's word for the mechanism), 分流开关, 黑白名单

**全局 (Global)**:
The default 分流模式: the applied node carries every destination, and only the module's own
fixed policy (DNS, the node host's own lookup, 旁路) routes anything elsewhere.
_Avoid_: 全局代理, global mode, 直连模式 (that is 空转)

**大陆直连 (Direct-CN)**:
The 分流模式 where a destination the 地理数据 names as mainland goes out `direct` and
everything else still goes through the applied node. It answers "mainland sites should not
leave the country", not "these sites should be blocked".
_Avoid_: 绕过大陆, 大陆白名单, 智能分流

**分流规则 (Routing rules)**:
The core's ordered rules that decide 分流. The module authors them in this version; the user
only picks the 分流模式. Distinct from 接管规则, the iptables rules that put traffic into the
core in the first place.
_Avoid_: 路由规则, 规则 (alone: in this project that word means 接管规则)

**冲突 (Conflict)**:
A foreign VPN/TUN or TPROXY setup already running on the device. Takeover refuses to start
until it is gone, rather than fighting it for the same traffic.
_Avoid_: overlap, interference

**DNS 接管 (DNS takeover)**:
Answering device DNS through the module's own resolver and sending those lookups through the
proxy, instead of letting the network's resolver answer them.
_Avoid_: DNS hijack, fake DNS (that is a technique the module does not use)

**失败关闭 (Fail-closed)**:
While takeover is on, a core that dies leaves the rules in place, so traffic is dropped rather
than going out directly.
_Avoid_: kill switch, safe mode

**tproxy透明代理开关 (tproxy switch)**:
The persisted user choice that device traffic be taken over when the core starts: on, every
core start (boot or the status page's start) installs the rules and runs the takeover config;
off, every start is an idle run. It is created at install and defaults to on, and it is a pure
preference — changing it never touches a running core, only the next start (see
`docs/adr/0011`). An update resets it to on with the rest of the module dir.
_Avoid_: 接管开关 (the name before the settings-page move), enabled flag, mode, tproxy on/off
(that is the command)

**应用节点 (Apply a node)**:
Deriving the core's configuration from the selected node and, if the core is running, restarting
it — which only happens when the rendered config actually changes: re-applying the node that is
already applied is a no-op for the core. Until a node is applied, the node store records only
what the user wants, not what the core runs. From the 节点详情弹窗 the user triggers it with the
应用 button (see 切换节点).
_Avoid_: select (that only moves the pointer)

**已应用节点 (Applied node)**:
The node the current core config was derived from. It can differ from the selected node when a
switch failed, or lag behind that node's fields when a re-import kept the id; the UI marks the
latter as changed until it is applied again.
_Avoid_: active node, running node

**取消应用 (Unapply)**:
Forgetting the applied node: the core config, `runtime/applied`, the rendered outbound and the
takeover rules are all removed, so the module is back to the never-applied state and the core
cannot start until a node is applied again. The one trigger is a delete that empties the node
list while the core is stopped; the tproxy switch is a preference and stays as it is.
_Avoid_: reset, clear, wipe, uninstall

**切换节点 (Switch node)**:
Pressing 应用 in the 节点详情弹窗: it becomes the selected node and is applied, so the core runs
it, restarting a running core once for the new config. Opening the dialog is not 切换节点, and
normally this is the only gesture that changes which node carries traffic; the exception is an
import into a store with no applied node, which switches without the dialog (see 添加弹窗).
_Avoid_: select, choose (those move the pointer, not the traffic), tapping a row (that opens the dialog)

**节点出站 (Node outbound)**:
The applied node rendered as one Xray outbound: data the WebUI writes and the module assembles
into the core config.
_Avoid_: node config, proxy JSON

**节点地址钉死 (Node pin)**:
The applied node's domain resolved once over the still-direct network and fixed into the core
config, so bootstrapping the node connection never depends on any resolver.
_Avoid_: 预解析, pinned IP, nodeip (that is the runtime file holding it, not the concept)

**配置模板 (Config template)**:
`config.example.json`, the fixed Xray config skeleton — inbounds, the fixed outbounds and, from
v0.7, routing and DNS — from which the core config is generated.
_Avoid_: default config, preset, profile

**地理数据 (Geo data)**:
The `geosite.dat` and `geoip.dat` files the 分流规则 name categories from. They ship with the
核心 inside the module rather than being fetched on the device, so a category a release does not
carry is a config error, never an empty match.
_Avoid_: geo 文件, 规则库, 数据库, 订阅规则

**核心配置 (Core config)**:
`config.json`, the config the core actually runs, generated from the template, the applied node
and (from v0.7) the takeover switch. Never hand-edited.
_Avoid_: user config, settings

**运行状态 (Runtime status)**:
The files a reader consults to answer "what is the module doing": `runtime/status.json`
(state/phase/node), `runtime/xray.pid`, `runtime/applied`, `logs/xray.log` and (from v0.7)
`logs/kernelray.log`, the module's own log. Status is written, never inferred by callers.
_Avoid_: health, heartbeat

**核心日志 (Core log)**:
`logs/xray.log`, the log the 核心 itself writes: request lines and errors, at the chosen
日志等级. The Log page's default tab. The 日志等级 and 日志行数 preferences both concern it.
_Avoid_: xray log (that is the file, not the concept), access log, run log

**模块日志 (Module log)**:
`logs/kernelray.log`, the log the module's own scripts write: starts, renders, takeover
and failure lines. It has no levels and no preference of its own; the 日志行数 caps how
much of it the Log page shows. A module update wipes it with the rest of the module dir
(see `docs/adr/0002`).
_Avoid_: kernelray log (that is the file, not the concept), system log, service log

**日志等级 (Log level)**:
The verbosity of the 核心's own log (`logs/xray.log`): how much the core writes there. It is a
preference of its own, not the 日志行数 and not the module's own log (`kernelray.log`), which has
no levels.
_Avoid_: 日志级别, 调试模式

**日志行数 (Log buffer)**:
How many recent lines the Log page shows from whichever log is displayed, the 核心日志 or
the 模块日志. A display choice only: changing it never changes what either log writes.
_Avoid_: 日志大小, 日志上限

**节点 (Node)**:
One proxy endpoint with everything needed to reach it: address, port, protocol and its
transport/security parameters.
_Avoid_: server, proxy (that is the role, not the thing), config

**分享链接 (Share link)**:
A `vless://`, `vmess://`, `trojan://` or `ss://` URI pasted into the 添加弹窗; the parser turns
it into a 节点.
_Avoid_: 节点链接 (that is the derived link a stored node copies)

**节点库 (Node store)**:
The user's whole set of nodes — the ones added by hand plus the ones a subscription supplied.
_Avoid_: pool, node list (that is its form on the Nodes page; see 节点列表)

**节点列表 (Node list)**:
The Nodes page's rendering of the node store: one entry per node, with the applied node marked
and a selected-but-unapplied node marked too. Outside edit mode a row tap opens the
节点详情弹窗; edit mode turns the row into a 勾选. This version renders the manually added nodes;
subscription nodes await a subscription feature.
_Avoid_: node store (that is the data), pool

**节点详情弹窗 (Node detail dialog)**:
The read-only dialog a node row opens outside edit mode: it shows the node's fields, copies its
节点链接, and holds the 应用 button that performs 切换节点. Opening it never writes `selected` or
touches the core.
_Avoid_: 应用弹窗, 节点信息页

**节点链接 (Node link)**:
The share link derived from a stored 节点's fields, used by the 节点详情弹窗's copy actions. It
reflects the node store, not necessarily the 分享链接 originally pasted into the 添加弹窗.
_Avoid_: 原始链接, 分享链接 (that is the input to 添加弹窗)

**订阅 Base64 (Subscription Base64)**:
The Base64 encoding of a 节点链接 as one line of subscription content; for vmess the link is
already Base64 JSON, so the result is double-encoded on purpose. It is an encoding, not
encryption.
_Avoid_: Base64 加密, Base64 链接 (too vague)

**勾选 (Check)**:
The edit-mode mark a user puts on node rows to say which ones a batch delete would remove.
It is a temporary intent held only while edit mode lasts, and it never moves the selected
pointer or touches the core. The applied node can be checked only when it is the last node and
the core is stopped — the one case in which deleting it is allowed (see 取消应用).
_Avoid_: select (that names the 当前节点 pointer), pick, mark

**添加弹窗 (Add-node dialog)**:
The dialog the node list's + entry opens: share links are pasted and imported there, and
parsing is the first half of that one import gesture, not a separate step. Success closes
the dialog with a toast; failed lines stay in the dialog for fixing and retrying. Opening
it never switches or applies anything. Importing into a store with no applied node also
switches a node — the selected one when the pointer still resolves, else the first node the
list shows (see 切换节点); that is the one apply path that does not go through the
节点详情弹窗. Any other import only fills the store.
_Avoid_: add page, import page, subscription page (that is the 订阅 feature), parse step

**订阅 (Subscription)**:
A URL that yields nodes. Its nodes join the node store, but the store does not own them: a
refresh replaces them wholesale, while manually added nodes are never touched.
_Avoid_: feed, provider, source

**当前节点 (Selected node)**:
The node the user last chose to use: the pointer `state.json` records, written when 应用 is
pressed. It normally equals the applied node; a failed switch leaves it on the attempted node.
It is a pointer, not a copy, so a node that disappears from the store without being deleted (a
subscription refresh) leaves the selection dangling rather than stale; deleting the selected
node clears it, and an import into a store with no applied node sets it to the node it switches,
applying it in the same gesture.
_Avoid_: active node, current proxy, main node
