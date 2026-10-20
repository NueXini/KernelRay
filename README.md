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
| keeps state in | `/data/adb/modules/kernelray/` — the module dir, and the *only* place we write |
| listens on | `127.0.0.1:10808` (socks5+socks5h), `127.0.0.1:10809` (http) |
| outbound | `freedom` — direct, i.e. a plain tunnel you can point clients at |
| action button | toggles start/stop and prints status (`action.sh`) |
| WebUI | start / stop the core, watch its log, see the currently selected node, import nodes |
| config | `config.json` in the module dir, plain Xray JSON, created from `config.example.json` when absent |
| log | `logs/xray.log` in the module dir |

> **Everything lives in the module dir.** Nothing is written outside it, so uninstalling leaves no
> residue. The flip side: a module update replaces that directory wholesale, so `config.json`,
> `state.json` and the logs are reset when you upgrade (see
> [`docs/adr/0002`](docs/adr/0002-everything-lives-in-the-module-dir.md)).

Point any app, Termux command or adb-forwarded client at the socks port to check that the
core really is forwarding traffic — a live pid alone proves nothing.

## Layout

| Path | Purpose |
| --- | --- |
| `module/` | The module itself; its **contents** become the root of the release ZIP |
| `module/module.prop` | id, version and **versionCode** — the only source of version information |
| `module/scripts/kernelray.sh` | shared helpers: paths, core probing, start/stop, status; also the CLI used by the WebUI |
| `module/webroot/index.html` | the WebUI: plain HTML/CSS/JS, no build step, no dependencies; reads `state.json`, imports nodes |
| `docs/state-schema.md` | what `state.json` contains — the authority the UI writes against |
| `tests/parse.test.js` | share-link parser tests, run against the parser block inside the shipped HTML |
| `docs/webui.png` | screenshot of the WebUI |
| `module/config.example.json` | default config, copied to `config.json` when absent |
| `module/bin/xray` | the arm64 core, **not committed** — see `module/bin/README.md` |
| `module.yaml` | KernelSU Modules display metadata (name, summary, icon, tags, …) |
| `scripts/pack.sh` | builds `build/kernelray-<versionCode>-<version>.zip` from `module/` |
| `GLOSSARY.md` | what we mean by node / subscription / selected node / module dir / idle run |
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
cat /data/adb/modules/kernelray/runtime/status.json     # {"state":"running",...}

# the core really forwards traffic
adb forward tcp:11080 tcp:10808
curl -sS -o /dev/null -w '%{http_code}\n' --socks5-hostname 127.0.0.1:11080 https://www.gstatic.com/generate_204
```

## WebUI

<p align="center"><img src="docs/webui.png" width="300" alt="KernelRay WebUI"></p>

Open the module card in the KernelSU manager and tap **WebUI**. The page shows the state
(running / stopped / failed), pid, uptime, core version, the selected node and the last 200
log lines, with **Start** / **Stop** buttons.

The node card is a read-only view of `state.json`: it resolves `selected` against the manual
list and any subscription node lists, then says whether `config.json` actually carries a proxy
outbound. It cannot switch nodes or apply anything — that is v1 work, so the wording never
claims a node is in use when the config is still `freedom`.

**Adding nodes.** Paste one link per line (or a whole base64 subscription blob) into the import
card and hit *Parse*: every line is reported back individually, with parsed nodes ready to
import and rejects showing why (`hysteria2` is not supported, an `ss://` link carrying a SIP003
plugin is not supported, and so on). Supported: `vless`, `vmess` (base64 JSON), `trojan`, `ss`
(SIP002 and the legacy form). *Import* merges into `state.json` — re-importing the same node
updates it in place and keeps its id, so a rename does not create a duplicate.

Import only fills the node list; it does not change how traffic flows. The node card keeps
saying so until applying a node exists.

The parser is tested without a browser: `node tests/parse.test.js` extracts the marked block
from this very file and runs 22 cases against it.

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

Transparent proxy (TPROXY/iptables), DNS hijacking, routing/geo rules, fetching a subscription
URL (the page has no TLS-validating fetcher, and a subscription URL *is* a credential),
switching or applying a node (the WebUI only *shows* and *imports* them), per-app proxying,
TUN, watchdog/auto-restart, multi-core support (sing-box/mihomo/…).
They are parked, not rejected — see `docs/adr/`.

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
