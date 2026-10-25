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
The status phase meaning rule installation failed and was rolled back — the one takeover
failure that can leak traffic. It is written, never inferred by callers.
_Avoid_: rules error, install failed

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

**旁路 (Bypass)**:
Traffic the module deliberately leaves outside takeover: loopback, the local network ranges, and
the core's own connections.
_Avoid_: whitelist, exception list (a per-app list is a different, later feature)

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
it. Until a node is applied, the node store records only what the user wants, not what the core
runs. From the node list the user triggers it by tapping a row (see 切换节点).
_Avoid_: select (that only moves the pointer)

**已应用节点 (Applied node)**:
The node the current core config was derived from. It can differ from the selected node when a
switch failed, or lag behind that node's fields when a re-import kept the id; the UI marks the
latter as changed until it is applied again.
_Avoid_: active node, running node

**切换节点 (Switch node)**:
Tapping a node in the node list: it becomes the selected node and is applied, so the core runs
it, restarting a running core. The one gesture that changes which node carries traffic.
_Avoid_: select, choose (those move the pointer, not the traffic)

**节点出站 (Node outbound)**:
The applied node rendered as one Xray outbound: data the WebUI writes and the module assembles
into the core config.
_Avoid_: node config, proxy JSON

**配置模板 (Config template)**:
`config.example.json`, the fixed Xray config skeleton — inbounds, the fixed outbounds and, from
v0.7, routing and DNS — from which the core config is generated.
_Avoid_: default config, preset, profile

**核心配置 (Core config)**:
`config.json`, the config the core actually runs, generated from the template, the applied node
and (from v0.7) the takeover switch. Never hand-edited.
_Avoid_: user config, settings

**运行状态 (Runtime status)**:
The files a reader consults to answer "what is the module doing": `runtime/status.json`
(state/phase/node), `runtime/xray.pid`, `runtime/applied`, `logs/xray.log` and (from v0.7)
`logs/kernelray.log`, the module's own log. Status is written, never inferred by callers.
_Avoid_: health, heartbeat

**节点 (Node)**:
One proxy endpoint with everything needed to reach it: address, port, protocol and its
transport/security parameters.
_Avoid_: server, proxy (that is the role, not the thing), config

**节点库 (Node store)**:
The user's whole set of nodes — the ones added by hand plus the ones a subscription supplied.
_Avoid_: pool, node list (that is its form on the Nodes page; see 节点列表)

**节点列表 (Node list)**:
The Nodes page's rendering of the node store: one entry per node, with the applied node marked
and a selected-but-unapplied node marked too. This version renders the manually added nodes;
subscription nodes await a subscription feature.
_Avoid_: node store (that is the data), pool

**勾选 (Check)**:
The edit-mode mark a user puts on node rows to say which ones a batch delete would remove.
It is a temporary intent held only while edit mode lasts, and it never moves the selected
pointer or touches the core. The applied node cannot be checked, because it cannot be deleted.
_Avoid_: select (that names the 当前节点 pointer), pick, mark

**添加弹窗 (Add-node dialog)**:
The dialog the node list's + entry opens: share links are pasted and imported there, and
parsing is the first half of that one import gesture, not a separate step. Success closes
the dialog with a toast; failed lines stay in the dialog for fixing and retrying. Opening
it or importing from it never switches or applies a node.
_Avoid_: add page, import page, subscription page (that is the 订阅 feature), parse step

**订阅 (Subscription)**:
A URL that yields nodes. Its nodes join the node store, but the store does not own them: a
refresh replaces them wholesale, while manually added nodes are never touched.
_Avoid_: feed, provider, source

**当前节点 (Selected node)**:
The node the user last chose to use: the pointer `state.json` records. It normally equals the
applied node; a failed switch leaves it on the attempted node. It is a pointer, not a copy, so
a node that disappears from the store without being deleted (a subscription refresh) leaves the
selection dangling rather than stale; deleting the selected node clears it.
_Avoid_: active node, current proxy, main node
