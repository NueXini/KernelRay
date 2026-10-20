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
`/data/adb/modules/kernelray` — the one root: mechanism, core binary, default config template,
user config, node store, logs and runtime state. It is also all we ever write to, so removing
the module leaves nothing behind. Replaced wholesale on update, which resets the user data
inside it; that cost is deliberate (see `docs/adr/0002`).
_Avoid_: install dir, app dir, data dir, storage, work dir

**空转 (Idle run)**:
The core is up and listening on its own local inbounds, and no device traffic is redirected
into it. The opposite of transparent proxying.
_Avoid_: running, normal mode, passive mode

**默认配置 (Default config)**:
`module/config.example.json` as copied to `config.json` in the module directory when that file
is absent. It is a plain Xray config with no KernelRay-specific keys; after the copy the user
owns that file.
_Avoid_: template, preset, profile

**运行状态 (Runtime status)**:
The three files a reader consults to answer "what is the module doing": `runtime/status.json`
(state/phase), `runtime/xray.pid`, `logs/xray.log`. Status is written, never inferred by callers.
_Avoid_: health, heartbeat

**节点 (Node)**:
One proxy endpoint with everything needed to reach it: address, port, protocol and its
transport/security parameters.
_Avoid_: server, proxy (that is the role, not the thing), config

**节点库 (Node store)**:
The user's whole set of nodes — the ones added by hand plus the ones a subscription supplied.
_Avoid_: list, pool, node list

**订阅 (Subscription)**:
A URL that yields nodes. Its nodes join the node store, but the store does not own them: a
refresh replaces them wholesale, while manually added nodes are never touched.
_Avoid_: feed, provider, source

**当前节点 (Selected node)**:
The one node in the store marked as in use. It is a pointer into the store, not a copy, so a
node that disappears from the store leaves the selection dangling rather than stale.
_Avoid_: active node, current proxy, main node
