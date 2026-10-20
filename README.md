# KernelRay

A [KernelSU](https://kernelsu.org) module that runs an [Xray-core](https://github.com/XTLS/Xray-core)
on an Android device.

**v0 scope — idle run.** The core starts on boot and exposes local `socks` / `http` inbounds
on `127.0.0.1`. Nothing else happens: no transparent proxy, no DNS hijacking, no TUN, no
routing rules, no UI. If you are looking for "install it and all apps are proxied", that is
the next version, not this one.

## What it does

| | |
| --- | --- |
| starts on boot | `service.sh` (late_start service) launches the core and records pid + status |
| keeps state in | `/data/adb/kernelray/` — survives module updates |
| listens on | `127.0.0.1:10808` (socks5+socks5h), `127.0.0.1:10809` (http) |
| outbound | `freedom` — direct, i.e. a plain tunnel you can point clients at |
| action button | toggles start/stop and prints status (`action.sh`) |
| WebUI | start / stop the core and watch its log from the KernelSU manager (`module/webroot/`) |
| config | `/data/adb/kernelray/config.json`, plain Xray JSON, created once and never overwritten |
| log | `/data/adb/kernelray/logs/xray.log` |

Point any app, Termux command or adb-forwarded client at the socks port to check that the
core really is forwarding traffic — a live pid alone proves nothing.

## Layout

| Path | Purpose |
| --- | --- |
| `module/` | The module itself; its **contents** become the root of the release ZIP |
| `module/module.prop` | id, version and **versionCode** — the only source of version information |
| `module/scripts/kernelray.sh` | shared helpers: paths, core probing, start/stop, status; also the CLI used by the WebUI |
| `module/webroot/index.html` | the WebUI: plain HTML/CSS/JS, no build step, no dependencies |
| `docs/webui.png` | screenshot of the WebUI |
| `module/config.example.json` | default config, copied to the data dir on first install |
| `module/bin/xray` | the arm64 core, **not committed** — see `module/bin/README.md` |
| `module.yaml` | KernelSU Modules display metadata (name, summary, icon, tags, …) |
| `scripts/pack.sh` | builds `build/kernelray-<versionCode>-<version>.zip` from `module/` |
| `GLOSSARY.md` | what we mean by core / module dir / data dir / idle run |
| `docs/adr/` | decisions worth remembering |

## Install

```sh
# 1. put the core in place (see module/bin/README.md)
#     module/bin/xray   <- Xray-android-arm64-v8a.zip

# 2. build and flash
scripts/pack.sh
adb push build/kernelray-*.zip //data/local/tmp/ && adb shell su -c 'ksud module install /data/local/tmp/kernelray-*.zip'
```

The module is arm64-only and ships one core at `bin/xray`. Install fails loudly if that
binary is missing or cannot execute on the device; x86_64 emulators run it via ARM
translation.

## Verify

```sh
# core alive, one instance only
ps -A -o PID,ARGS | grep 'xray run'
cat /data/adb/kernelray/runtime/status.json     # {"state":"running",...}

# the core really forwards traffic
adb forward tcp:11080 tcp:10808
curl -sS -o /dev/null -w '%{http_code}\n' --socks5-hostname 127.0.0.1:11080 https://www.gstatic.com/generate_204
```

## WebUI

<p align="center"><img src="docs/webui.png" width="300" alt="KernelRay WebUI"></p>

Open the module card in the KernelSU manager and tap **WebUI**. The page shows the state
(running / stopped / failed), pid, uptime, core version and the last 200 log lines, with
**Start** / **Stop** buttons.

The page is a dumb client: every button runs the same CLI the shell uses, so behaviour cannot
diverge between the two entry points.

```sh
/data/adb/modules/kernelray/scripts/kernelray.sh status   # key=value, consumed by the WebUI
/data/adb/modules/kernelray/scripts/kernelray.sh log 50
/data/adb/modules/kernelray/scripts/kernelray.sh start
/data/adb/modules/kernelray/scripts/kernelray.sh stop
```

No build step and no `npm install`: `webroot/index.html` is committed as-is and talks to the
manager through the injected `ksu.exec` bridge. Opened outside the manager it says so instead
of pretending to work.

## Deliberately out of scope (v0)

Transparent proxy (TPROXY/iptables), DNS hijacking, routing/geo rules, subscription and
share-link import, per-app proxying, WebUI, TUN, watchdog/auto-restart, multi-core support
(sing-box/mihomo/…). They are parked, not rejected — see `docs/adr/`.

## Releasing a new version

1. Enable **Settings → General → Releases → Enable release immutability** (once).
2. Bump `version` and `versionCode` in `module/module.prop` (versionCode must increase).
3. Commit, then tag and push:

   ```sh
   git tag v0.1.1 && git push origin v0.1.1
   ```

4. The workflow zips `module/`, prechecks it with the KernelSU Modules validator and publishes
   `kernelray-<versionCode>-<version>.zip`.

> Note: cores are gitignored, so CI currently publishes a ZIP **without** cores. Until the
> workflow is extended to fetch pinned cores, release builds have to be produced locally.

## License

[MIT](LICENSE)
