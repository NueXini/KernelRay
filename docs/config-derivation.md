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
| `runtime/status.json` | shell | `state`, `phase`, `started`, `revision`, `node`, `tproxy`, `route` |
| `runtime/tproxy` | shell | the persisted tproxy switch, a preference written at start (docs/adr/0011) |
| `runtime/route` | shell | the persisted 分流模式, `cn` when present, absent = 全局 (docs/adr/0014) |
| `runtime/loglevel` | shell | the persisted 日志等级; absent = 警告 (docs/adr/0015) |
| `geodata/` | repo | `geosite.dat`, `geoip.dat` and the `VERSION` the 分流规则 name categories from (docs/adr/0014) |

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
  keys whose values are quoted placeholders. With takeover on the line is replaced by the
  real block (authored in `tproxy.sh`); with takeover off the line disappears — except
  `routing`, which exists in both forms since ADR 0014 (spliced in 大陆直连, dropped in 全局)
  and is handled by the renderer before the form branch. Both results are valid JSON, and so
  is the template itself — every placeholder is a quoted string.
- `config.json` never contains a placeholder. `kr_render_config` refuses a template without
  the outbound one.

The shell does not parse the outbound. It reads `outbound.json` as an opaque JSON fragment (the
UI writes one line; newlines are only whitespace if a human pretty-prints it), so protocol
knowledge stays in the tested JS renderer (`tests/outbound.test.js`).

## The no-takeover form

Every render decides between the no-takeover form (the 空转 form: the applied node's config
without takeover) and the takeover form ([ADR 0008](adr/0008-takeover-namespace-boot-and-toggle-semantics.md)):

takeover is rendered when the persisted switch (`runtime/tproxy`) is on **and** the rules are
actually present (`kr_tp_rules_present`, checked against iptables — switch on without rules is
the failed-start state, and a mark without its ip rule loses routing). Callers can force
either form with `KR_TAKEOVER=1|0`; the start-time engagement forces the form it is about to
enforce.

The takeover form adds: the dokodemo-door tproxy inbound on wildcard `::`, port 10810; the
`dns-out` outbound; the `dns` module (upstream depends on the 分流模式, below); and the routing
rules — the applied node's hostname resolves through `direct` (skipped when the host is an IP
literal), the DNS module's upstream queries go through `proxy`, and port 53 tcp/udp goes to
`dns-out`. The node outbound's `"__KERNELRAY_MARK__"` placeholder becomes the bypass mark
19283; in the no-takeover form it becomes `0` (no mark). The placeholder itself is written by
the UI renderer, which cannot know the switch state.

The 空转 form keeps the 分流 rules when the mode is 大陆直连 (there is no `dns` inbound, so only
the geo rules are authored); in 全局 it has no `routing` key at all.

Applying a node while the rules are up renders the takeover form — a no-takeover config
would lose routing for the node outbound. Since ADR 0011 the switch (`kernelray.sh tproxy
on|off`) only writes the preference; the render → `-test` → swap machinery runs at the core
start: `kr_start_locked` engages takeover (conflict check → rules → takeover config, the
fail-closed order) when the switch is on, and tears stale rules down when it is off.

## Start and the switch

`kr_start_locked` consults the switch before rendering the config ([ADR 0011](adr/0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)):
with the switch on it runs `kr_tp_engage`, which re-renders the config to match (the on-disk
config may be stale), installs the rules before the core starts (fail-closed), and on a
conflict or a rule failure writes the no-takeover config plus the `failed/conflict` /
`failed/rules` phase while leaving the switch file untouched — the switch is a preference and
is never silently rewritten; the WebUI offers a retry. With no applied node the start gate
refuses first: the core stays down and the rules go nowhere, so a default-on switch cannot
take a nodeless device over. With the switch off, any stale rules come down and the start is
an idle run.

A config that cannot work for this start is repaired before the `-test`: one that is *more*
takeover-y than the switch allows (the switch went off while a takeover config was on disk — the
documented "turn it off and start again" recovery, which would otherwise leave the node's
outbound carrying a bypass mark with no ip rule), one that is *less* takeover-y than the rules
that are up (a capture into a core with no tproxy inbound blackholes traffic), and a 大陆直连
config whose geo data has gone (ADR 0014). A global config while the preference says `cn` is
left alone: that is what a failed switch's rollback deliberately leaves behind.

## The 日志等级

The log level is a render input and a deferred preference, like the tproxy switch (ADR 0015). The UI
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

1. checks the id and that `outbound.meta`'s `id` equals the argument;
2. renders the template + outbound into `runtime/config.new.json`;
3. runs `xray run -test -c runtime/config.new.json` into `logs/xray.log`;
4. remembers whether the core is running, saves the old config to `runtime/config.json.prev`,
   and stops the core if it was running;
5. atomically `mv`s the candidate to `config.json`, chmods it `0600`, and writes
   `runtime/applied`;
6. starts the core if it was running before. If the new config does not start, it restores
   `config.json.prev` and the old applied id, then starts the old config again;
7. if the core was stopped, writes `status.json` as `stopped/idle` with the new node id.

Failure semantics:

| Failure | Result |
| --- | --- |
| render error, meta mismatch, missing outbound | nothing is stopped or replaced; CLI exits non-zero |
| `xray -test` rejects the candidate | same: old config and running core untouched |
| candidate starts | applied id and `status.json` name the new node |
| candidate does not start | old config + old applied id restored, old config started; CLI exits non-zero |
| the restored old config also fails to start | files and applied id are the old ones, but the core is down (`failed/crashed`) |
| candidate does not start and no previous config exists | the derived config and the applied id are dropped, the core stays down (`stopped/no-node`); CLI exits non-zero |

A failed `-test` does **not** write a failed `phase`: the old core is still running and healthy.
The CLI returns the error; the WebUI shows it in a toast. Only a failed **start** makes the
status failed, and the restore path clears it if the old config starts.

Applying always restarts a running core. The node list marks the applied node and, after a
failed switch, the selected-but-unapplied node. Applying the applied node with no changes does
nothing to the core; applying it after a re-import kept its id and marked it `dirty` re-applies
it, and the `dirty` flag clears on success. Importing a node changes nothing until the dialog's
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
like the tproxy switch, so the `sed` still reads two integers. The 日志等级 is the same kind of
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

## Boot and self-healing

`service.sh` calls `kr_start`, which uses `config.json` when it exists. Before anything else,
the start gate demands an applied node: without one, nothing starts and status.json records
`stopped/no-node` ([ADR 0010](adr/0010-the-core-only-runs-an-applied-nodes-config.md)).
`kr_ensure_config` only runs when the file is missing:

- if `runtime/applied` exists, `outbound.meta` names the same id, and `outbound.json` is
  present, the config is rebuilt from that outbound. The UI writes the meta before the
  outbound, so a crash between its writes leaves a different id and the rebuild refuses; a
  same-id settings edit can rebuild the older outbound, which is why the node is marked
  `dirty`;
- otherwise the rebuild refuses and the start fails with `failed/no-config`: claiming a node
  is applied while the core ran something else would be worse than staying down.

The normal boot path never rewrites the config. An upgrade replaces the whole module directory
(ADR 0002), so config, outbound and applied id are reset together.

## 分流模式 (routing mode)

`kernelray.sh routing global|cn` writes the preference and re-derives the config at once
([ADR 0014](adr/0014-geodata-ships-in-the-module-and-routing-is-a-preset-mode.md)): render the
new form → `xray -test` → write `runtime/route` → swap (the `ports` path, including its stop,
restart and rollback). `global` is the absent file; `cn` writes `cn\n`, mode `0600`.

- **Refusals.** `routing cn` exits non-zero, changing nothing, when the geo data is missing
  or when `-test` rejects the candidate. A swap that fails restores the preference to the old
  mode, so it never claims a form the core does not run.
- **No applied node.** There is nothing to re-render: the preference is written and the next
  apply renders it.
- **Degradation.** `kr_route_effective` is what the render may use: `cn` only while
  `geodata/geosite.dat` and `geodata/geoip.dat` both exist and are non-empty, else `global`
  plus a line in `kernelray.log`. The preference is never rewritten — a start that finds the
  data gone runs everything through the node rather than a config that cannot load.
- **The blocks.** 大陆直连 adds to the takeover form: two domestic resolvers
  (`223.5.5.5`, `119.29.29.29`) filtered by `expectIPs: ["geoip:cn"]` for `domains:
  ["geosite:cn"]`, with the DoH kept as the fallback for everything else; a routing rule that
  sends those resolvers' own queries `direct`; `domainStrategy: IPIfNonMatch`; and
  `geoip:private`, `geosite:private`, `geosite:cn`, `geoip:cn` → `direct`. The 空转 form gets
  the last four only. 全局 keeps the pre-0014 blocks byte for byte (`AsIs`, one DoH, three
  rules).
- **The asset path.** `kernelray.sh` exports `XRAY_LOCATION_ASSET=$KR_GEODATA` once, so every
  `xray -test` and `xray run` reads the data from the module dir; Xray's own fallback search
  starts at the process cwd, which is not ours.

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
- `config.json` is generated from files inside the module dir only: the template, the outbound,
  `state.json`'s ports, the two preference files and `geodata/`. Nothing is fetched at run
  time, and `XRAY_LOCATION_ASSET` is exported by `kernelray.sh` so the core agrees.
