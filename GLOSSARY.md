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
`/data/adb/modules/kernelray` — mechanism, default config template and core binaries. Replaced
wholesale when the module is updated.
_Avoid_: install dir, app dir

**数据目录 (Data directory)**:
`/data/adb/kernelray` — user config, logs and runtime state. Belongs to the user and survives
module updates.
_Avoid_: cache, storage, work dir

**空转 (Idle run)**:
The core is up and listening on its own local inbounds, and no device traffic is redirected
into it. The opposite of transparent proxying.
_Avoid_: running, normal mode, passive mode

**默认配置 (Default config)**:
`module/config.example.json` as copied to the data directory on first install. It is a plain
Xray config with no KernelRay-specific keys; after the copy the user owns that file.
_Avoid_: template, preset, profile

**运行状态 (Runtime status)**:
The three files a reader consults to answer "what is the module doing": `runtime/status.json`
(state/phase), `runtime/xray.pid`, `logs/xray.log`. Status is written, never inferred by callers.
_Avoid_: health, heartbeat
