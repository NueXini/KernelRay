# How the core config is derived

`config.json` is a generated artifact. Do not hand-edit it: applying a node rewrites it, and
the module may regenerate it when it is missing. The template is the extension point.

This implements [ADR 0005](adr/0005-core-config-is-derived.md) (the UI renders data, the shell
owns the layout), [ADR 0006](adr/0006-dns-goes-through-the-core.md) (the fixed `direct`
outbound carries the v0.7 bypass mark) and
[ADR 0016](adr/0016-a-node-row-opens-a-detail-dialog.md) (a node row opens the detail dialog;
its Apply button is the switch gesture).

## Files and owners

| Path | Writer | Kind |
| --- | --- | --- |
| `state.json` | WebUI | user intent: the node store and `selected` |
| `outbound.json` | WebUI | the node being applied rendered as **one** Xray outbound; `unapply` removes it |
| `outbound.meta` | WebUI | `id=<node-id>` and `host=<address>` for that outbound; `unapply` removes it |
| `config.example.json` | repo | the config template (not runnable on its own) |
| `config.json` | shell | the config the core actually runs |
| `state.json` → render | WebUI writes, shell reads | the inbound ports (`settings.socksPort` / `settings.httpPort`), extracted at render time (ADR 0009) |
| `runtime/applied` | shell | id of the node `config.json` was built from |
| `runtime/config.tested` | shell | a copy of the exact bytes that passed `xray -test` (ADR 0017) |
| `runtime/status.json` | shell | `state`, `phase`, `started`, `revision`, `node`, `route`, `boot` (the boot that wrote it; a reader treats another boot's file as `idle`, docs/adr/0018) |
| `runtime/route` | shell | the persisted 分流模式, read from the file's content: `cn` or `cnadblock`, absent = 全局; the installer writes `cnadblock` when it is unset (docs/adr/0014, docs/adr/0021) |
| `runtime/rules` | shell | the boot-scoped cache of the last real rule-presence check: the status poll reads it; install/remove and a cache miss write it; the start path still asks iptables (docs/adr/0019) |
| `runtime/loglevel` | shell | the persisted 日志等级; absent = 警告 (docs/adr/0015) |
| `bin/` | repo | the core and the geo data it loads: `xray`, `geosite.dat`, `geoip.dat` (docs/adr/0014) |

One writer per file: the UI never writes `config.json`, `runtime/applied` or `status.json`; the
shell never writes `state.json`, `outbound.json` or `outbound.meta`. The one exception is
`unapply`, which removes the rendered outbound along with everything else derived from the
applied node ([ADR 0013](adr/0013-deleting-the-last-node-while-stopped-unapplies-it.md)) but
never rewrites it. No locks are needed for that split.

`outbound.json` contains credentials; both it and `outbound.meta` are written atomically with
mode `0600`, like `state.json`. `pack.sh` excludes them.

## The template

`module/config.example.json` is the fixed skeleton: local socks/http inbounds (whose ports
are the quoted placeholders `"__KERNELRAY_SOCKS_PORT__"` / `"__KERNELRAY_HTTP_PORT__"`,
replaced at render time with the ports from `state.json`'s `settings`, default 10808/10809),
and four outbounds —

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

- `"__KERNELRAY_OUTBOUND__"` is a quoted placeholder; the whole string is replaced. The file
  stays valid JSON for tooling, but it is **not** a runnable Xray config, so it cannot be used
  by accident.
- The first outbound is Xray's default when no routing rule matches. It is always the applied
  node's outbound (tag `proxy`): `kr_render_config` refuses to render without one — the core
  never runs a config that is not derived from an applied node ([ADR 0010](adr/0010-the-core-only-runs-an-applied-nodes-config.md)).
- `"loglevel": "__KERNELRAY_LOGLEVEL__"` is replaced by the 日志等级 preference
  (`runtime/loglevel`, default 警告) on every render. The value is validated before it is
  spliced in, and a template without the placeholder is refused like one without the ports.
- The takeover placeholders follow the same trick, one per line, each carrying its own
  leading comma: `,"__KERNELRAY_TPROXY_INBOUND__"` in `inbounds` and
  `,"__KERNELRAY_DNS_OUTBOUND__"` in `outbounds`, plus the top-level `"dns"` and `"routing"`
  keys whose values are quoted placeholders. Every one of them is always replaced — there is
  only one form ([ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md))
  — and the result is valid JSON, as is the template itself, because every placeholder is a
  quoted string.
- `config.json` never contains a placeholder. `kr_render_config` refuses a template without
  the outbound one.

The shell does not parse the outbound. It reads `outbound.json` as an opaque JSON fragment (the
UI writes one line; newlines are only whitespace if a human pretty-prints it), so protocol
knowledge stays in the tested JS renderer (`tests/outbound.test.js`).

## The one form

Every render is the takeover form ([ADR 0008](adr/0008-takeover-namespace-boot-and-toggle-semantics.md));
there is no second one, because every core start takes over
([ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)). The renderer is
a pure function of the template, the applied outbound and the preferences: it asks the kernel
nothing.

The takeover blocks are: the dokodemo-door tproxy inbound on wildcard `::`, port 10810; the
`dns-out` outbound; the `dns` module (upstream depends on the 分流模式, and 大陆直连去广告 adds
its `hosts` sink, below) carrying
`tag: "dns"` — the name every DNS routing rule below matches on, so the core stamps the
module's own upstream queries with it instead of its internal `xray.system.<uuid>`; and the
routing rules — the applied node's hostname resolves through `direct` (skipped when the host is an IP
literal), the DNS module's upstream queries go through `proxy`, and port 53 tcp/udp goes to
`dns-out`. The node outbound's `"__KERNELRAY_MARK__"` placeholder becomes the bypass mark
19282. The placeholder itself is written by the UI renderer; a rendered outbound that lost it
is refused, because under the rules its packets would be captured back into the core.

The 分流 rules are always authored too. 全局 carries the DNS group and the port-53 capture;
大陆直连 and 大陆直连去广告 add the geo rules, and 大陆直连去广告 adds the ad sink to the DNS
module.

Applying a node renders and tests the candidate before the running core is touched, so a bad
node never stops it (ADR 0007). The start re-renders only when the bytes differ — that is how a
config written under an older preference (the geo data went missing, the level changed) is
repaired, and how a config from a version that still had the second form is replaced.

## The start path

`kr_start_locked` runs the gate, then the two takeover halves with the config between them
([ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)):

1. `kr_tp_prepare` — the conflict check and the node pin, while the network is still direct
   (the pin's DoH ask must not enter a capture that leads into a core that is not up).
2. `kr_ensure_config` — render and `xray -test`; the bytes on disk are swapped in only when
   they differ from the tested ones.
3. `kr_tp_engage` — install the rules, still before the core runs (fail-closed, ADR 0004).
4. fork the core and wait for its inbound.

Any step that fails refuses the start: the core stays down, the device goes direct, and the
status records `failed/conflict`, `failed/rules`, `failed/config-invalid` or `failed/no-config`.
The ordering is the point: a config the core rejects leaves no live capture behind, so the
failure direction is "direct", never "offline".

`kr_tp_install` is idempotent — rules already present are left alone — which is what makes a
restart cheap and what repairs a swap whose core never came back (`kr_swap_tp_rollback` removes
the rules the swap brought up).

## When a start counts as done

`kr_start_locked` forks the core and then waits for the fact instead of sleeping: the socks
inbound listening on 127.0.0.1 — the port `config.json` carries, not the one `state.json`
wishes — is what "running" means. A start therefore returns in the time the core actually
needs (~50-150 ms), and a core that exits is reported as `failed/crashed` on the first poll
instead of after a fixed second. A core still alive at the deadline (1.5 s) counts as started:
a slow core is not a failed one, and a core that dies later is still reported as crashed by the
next status read, which compares the pidfile against the live process.

Two more costs are paid once per invocation rather than once per question: the core probe
(`xray -version`, which is how "this binary executes here" is decided) is memoized, and the
stray scan is a single `grep` over `/proc/*/cmdline` narrowed to the candidates instead of a
`cat` per pid — that fork cost ~5 ms each, i.e. seconds on a phone with several hundred
processes.

## The 日志等级

The log level is a render input and a deferred preference (ADR 0015). The UI
saves it through `kernelray.sh loglevel` (警告 is the default and removes the preference file),
and the next core start notices that `config.json` carries a different level, re-renders it and
only then runs `-test` and starts. Nothing else re-renders on a level change. Because
`kr_render_config` always reads the preference, an apply, a ports save or a routing switch also
bakes the saved level into the config they rewrite.

`status` reports both sides: `loglevel=` is the preference, and `loglevelpending=` is `1` only
while a running core still carries a different level in `config.json`.

## Applying a node

Tapping a node row opens the read-only 节点详情弹窗; pressing its 应用 button is the apply
gesture: it writes `state.selected`, renders that node, writes `outbound.meta` and then
`outbound.json`, and calls:

```sh
scripts/kernelray.sh apply <node-id>
```

`selected` goes first so a crash between writes leaves the honest "wants this node, runs the
old one" state instead of a config newer than the pointer. `outbound.meta` goes before
`outbound.json` so a crash between those two leaves an id mismatch (the start refuses to
render, `failed/no-config`) rather than a new outbound paired with an old id.

The shell:

1. pins the node's host address while the old node still works (`runtime/nodeip`, ADR 0008) —
   the resolve needs a working network and the render needs its answer;
2. asks `kr_config_candidate <id>` for the config this switch would run. It checks the id and
   that `outbound.meta`'s `id` equals it, renders the template + outbound into
   `runtime/config.new.json`, and runs
   `xray run -test -c` on it into `logs/xray.log` — **only when those bytes differ from
   `config.json`**. When they do not (re-applying the same node), the whole step costs nothing
   and the gesture ends here: no test, no stop, no restart;
3. `kr_swap_install` remembers whether the core is running, saves the old config to
   `runtime/config.json.prev`, stops the core if it
   was running, atomically `mv`s the candidate to `config.json`, chmods it `0600`, records the
   tested marker and writes `runtime/applied`;
4. `kr_swap_start` starts the core if it was running before. If the new config does not start,
   `kr_swap_rollback` restores `config.json.prev` and the old applied id, then starts
   the old config again — and if that start does not come back either, it removes the rules the
   swap brought up, so a failed swap never leaves a device with no core and a live capture;
5. if the core was stopped, writes `status.json` as `stopped/idle` with the new node id.

Failure semantics:

| Failure | Result |
| --- | --- |
| render error, meta mismatch, missing outbound | nothing is stopped or replaced; CLI exits non-zero |
| the bytes on disk are already this node's config | nothing is tested, stopped or restarted; only `runtime/applied` is re-synced |
| `xray -test` rejects the candidate | old config and running core untouched; CLI exits non-zero |
| candidate starts | applied id and `status.json` name the new node |
| candidate does not start | old config + old applied id restored, old config started; CLI exits non-zero |
| the restored old config also fails to start | files and applied id are the old ones, but the core is down (`failed/crashed`) |
| candidate does not start and no previous config exists | the derived config and the applied id are dropped, the core stays down (`stopped/no-node`); CLI exits non-zero |

A failed `-test` does **not** write a failed `phase`: the old core is still running and healthy.
The CLI returns the error; the WebUI shows it in a toast. Only a failed **start** makes the
status failed, and the restore path clears it if the old config starts.

Applying restarts a running core **only when the bytes change**: the same node applied twice
is one no-op, and so is saving the ports or the 分流模式 that the config already carries
(ADR 0017). The node list marks the applied node and, after a failed switch, the
selected-but-unapplied node. Applying the applied node with no changes does nothing to the
core; applying it after a re-import kept its id and marked it `dirty` re-applies it, and the
`dirty` flag clears on success. Importing a node changes nothing until the dialog's
应用 is pressed — except into a store with no applied node, where the import itself applies a
node ([ADR 0012](adr/0012-import-applies-the-first-node-when-nothing-is-applied.md)). That
import is the one apply path that does not go through the 节点详情弹窗.

## Why the shell reads (almost) nothing from `state.json`

`state.json` is nested JSON and the device has no `jq`. Parsing it with `awk`/`sed` is the same
liability ADR 0003 rejected for share links, so the UI renders the node there and hands the
shell one flat outbound. The one exception is the inbound ports
([ADR 0009](adr/0009-shell-reads-state-settings-for-inbound-ports.md)): `kr_render_config`
extracts exactly two flat integer keys from the `settings` object with `sed` and falls back
per field to 10808/10809 when anything is off. The 分流模式 did not grow that exception: it is
the shell's own preference file ([ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)),
so the `sed` still reads two integers. The 日志等级 is the same kind of
shell preference ([ADR 0015](adr/0015-log-level-waits-for-the-next-core-start.md)).

## Applying the inbound ports

Saving ports on the Settings page is one gesture shaped like a node apply: the UI validates
the pair (1–65535, distinct, never the tproxy port 10810), writes `state.json`'s `settings`
(intent first), and calls `kernelray.sh ports`. The shell re-renders the config — the applied
node's outbound and refuses when the bookkeeping is broken — no applied id, or an
`outbound.meta` that names another node — rather than rendering anything else. It then tests
and swaps via the same backup → stop → move → restart → rollback path as `apply`. The
applied id is untouched: the ports change the local inbounds, never the outbound. A candidate
that fails `-test` or start leaves the old config and running core as they were.

## Escaping

JSON is not safe to paste into a shell string or an `awk -v` value: `$`, backticks, quotes and
backslashes all have meaning somewhere. `kr_render_config` therefore passes the outbound line
through an **environment variable** (`ENVIRON["KR_OUT_LINE"]`), and `awk` only locates the
placeholder and prints the pieces. Nothing is re-expanded. `tests/config.test.js` exercises a
password containing quotes, backslashes, `$`, backticks, `&`, `<>` and a newline escape.

## The start and self-healing

Nothing starts at boot ([ADR 0018](adr/0018-no-action-button-and-no-boot-start.md)): `kr_start`
runs only from the WebUI's 启动 or `kernelray.sh start`. Before anything else, the start gate
demands an applied node: without one, nothing starts and status.json records `stopped/no-node`
([ADR 0010](adr/0010-the-core-only-runs-an-applied-nodes-config.md)).

`kr_ensure_config` then makes `config.json` the config this start would run — the single place
the module turns intent into a config
([ADR 0017](adr/0017-one-render-one-test-per-switch.md)):

- it renders from `outbound.json` and compares the bytes with
  `config.json`. Identical bytes are left alone (no test, no write); different bytes are tested
  and swapped in. That is the whole drift repair: the log level changing and
  the geo data disappearing both change the rendered bytes, so neither needs its own
  detector;
- when `outbound.meta` names a different node than `runtime/applied` — a switch that failed,
  where the UI has already written the *next* node — the config on disk is the only description
  of the applied node, so it is taken as it is, through the same `xray -test` gate. With no
  rendered outbound at all there is nothing the config on disk could describe, so the start is
  refused instead ("re-tap the node in the WebUI");
- a refusal (no applied node, no outbound, no config to fall back to) fails the start with
  `failed/no-config`, a rejected `-test` with `failed/config-invalid`: claiming a node is
  applied while the core ran something else would be worse than staying down.

The start itself no longer runs `xray -test`: the config it forks on is the one the marker says
was tested (ADR 0017).

An upgrade replaces the whole module directory (ADR 0002), so config, outbound and applied id
are reset together.

## 分流模式 (routing mode)

`kernelray.sh routing global|cn|cnadblock` writes the preference and re-derives the config at
once ([ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md),
[ADR 0021](adr/0021-ad-blocking-is-a-third-routing-mode.md)): render the new form → `xray -test`
→ write `runtime/route` → swap (the `ports` path, including its stop, restart and rollback).
`global` is the absent file; `cn` and `cnadblock` write their own name plus a newline, mode
`0600` — the file is a value, not a presence flag.

- **Refusals.** `routing cn` and `routing cnadblock` exit non-zero, changing nothing, when the
  geo data is missing or when `-test` rejects the candidate. A swap that fails restores the
  preference to the old mode *before* the rollback starts the old config, because that start
  re-derives the config from the mode — restoring the bytes without the preference would only
  render the failing mode again (ADR 0017).
- **No applied node.** There is nothing to re-render: the preference is written and the next
  apply renders it.
- **Default.** The installer writes `cnadblock` when `runtime/route` is still unset
  (`kr_route_default`), and skips it while the geo data is
  missing — then 全局 stays the mode, because a default the core refuses to start with is worse
  than one that does less (docs/adr/0021). A user's 全局 is an absent file, so the next install
  or update recreates the default.
- **Degradation.** `kr_route_effective` is what the render may use: `cn` only while
  `bin/geosite.dat` and `bin/geoip.dat` both exist and are non-empty, else `global`
  plus a line in `kernelray.log`. The preference is never rewritten — a start that finds the
  data gone runs everything through the node rather than a config that cannot load. **`cnadblock`
  never degrades**: a mode whose name promises blocking must not render as 大陆直连, so the
  missing file is left to `xray -test` and the start is refused instead — `failed
  config-invalid`, one `Routing` line in `kernelray.log`, `geo data missing` on stderr for the
  WebUI's toast, and the routing CLI refuses the same way up front. That is the one deliberate
  departure from 0014's "never a dead core" (ADR 0021). The same function sets `KR_ROUTE_CN`
  and `KR_ROUTE_BLOCK_ADS`, which the DNS and routing builders read instead of comparing mode
  strings.
- **The blocks.** 大陆直连 adds to the takeover form: two domestic resolvers
  (`223.5.5.5`, `119.29.29.29`) filtered by `expectIPs: ["geoip:cn"]` for `domains:
  ["geosite:cn"]`, with the DoH kept as the fallback for everything else; a routing rule that
  sends those resolvers' own queries `direct`; `domainStrategy: IPIfNonMatch`; and
  `geoip:private`, `geosite:private`, `geosite:cn`, `geoip:cn` → `direct`. 全局 renders none
  of those four. 大陆直连去广告 adds two more to that render: `dns.hosts["geosite:category-ads-all"]
  = "#3"` — the DNS module answers an empty response with rcode 3 (NXDOMAIN) instead of
  resolving, so an ad domain never gets an address (`#<n>` needs core ≥ 25.7.23) — and
  `{"domain": ["geosite:category-ads-all"], "outboundTag": "block"}`, placed after the
  dns/port-53 group and before the geo rules: first match wins, so a mainland ad domain must not
  fall into `geosite:cn` → `direct`, and a resolver query must not be swallowed by the block.
  全局 keeps the pre-0014
  blocks byte for byte (`AsIs`, one DoH, three rules).
- **The asset path.** Nothing is exported. `bin/` holds the core and its data, and with
  `XRAY_LOCATION_ASSET` unset the core resolves `geosite.dat`/`geoip.dat` from its own
  executable's directory — 26.10.29 searches there, not the cwd (verified on device: a core in
  a directory without the files fails with `stat <exe-dir>/geosite.dat`). One location, and no
  second path that could disagree with it.

## Invariants

- `state.selected` is intent; `runtime/applied` is fact. The UI shows both and never equates
  them.
- The node outbound is tagged `proxy` and carries only the `__KERNELRAY_MARK__` placeholder.
  On Android an arbitrary `SO_MARK` with no matching ip rule loses routing (verified: the
  node's Reality handshake failed until the mark was removed). The shell turns the placeholder
  into the bypass mark exactly while the rules are up; only the template's fixed `direct`
  outbound carries a literal mark, and it is unused while the core is not taken over.
- `config.json` is never hand-edited and never shipped in the ZIP.
- The core never runs a config that is not derived from an applied node: every render needs
  `outbound.json`, every start needs `runtime/applied`, and every fallback that used to
  produce a direct (freedom) config is gone (ADR 0010).
- `xray -test` precedes every swap; a candidate that fails never replaces a working config.
- One render and one test per switch: a config is rendered once, from the intent the caller
  states, and a start reuses the bytes the swap already tested (ADR 0017).
- `config.json` is generated from files inside the module dir only: the template, the outbound,
  `state.json`'s ports, the two preference files and `bin/`. Nothing is fetched at run
  time, and no asset path is exported: the core reads its data from the directory it sits in.
