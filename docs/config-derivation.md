# How the core config is derived

`config.json` is a generated artifact. Do not hand-edit it: applying a node rewrites it, and
the module may regenerate it when it is missing. The template is the extension point.

This implements [ADR 0005](adr/0005-core-config-is-derived.md) (the UI renders data, the shell
owns the layout), [ADR 0006](adr/0006-dns-goes-through-the-core.md) (the fixed `direct`
outbound carries the v0.7 bypass mark) and [ADR 0007](adr/0007-one-tap-switches-the-node.md)
(tapping a node row is the switch gesture).

## Files and owners

| Path | Writer | Kind |
| --- | --- | --- |
| `state.json` | WebUI | user intent: the node store and `selected` |
| `outbound.json` | WebUI | the node being applied rendered as **one** Xray outbound |
| `outbound.meta` | WebUI | `id=<node-id>` and `host=<address>` for that outbound |
| `config.example.json` | repo | the config template (not runnable on its own) |
| `config.json` | shell | the config the core actually runs |
| `runtime/applied` | shell | id of the node `config.json` was built from |
| `runtime/status.json` | shell | `state`, `phase`, `started`, `revision`, `node` |
| `runtime/tproxy` | shell | persisted takeover switch (v0.7) |

One writer per file: the UI never writes `config.json`, `runtime/applied` or `status.json`; the
shell never writes `state.json`, `outbound.json` or `outbound.meta`. No locks are needed for
that split.

`outbound.json` contains credentials; both it and `outbound.meta` are written atomically with
mode `0600`, like `state.json`. `pack.sh` excludes them.

## The template

`module/config.example.json` is the fixed skeleton: local socks/http inbounds, and three
outbounds —

```json
"outbounds": [
  "__KERNELRAY_OUTBOUND__",
  { "tag": "direct", "protocol": "freedom", "streamSettings": { "sockopt": { "mark": 19283 } } },
  { "tag": "block", "protocol": "blackhole", "settings": {} }
]
```

- `"__KERNELRAY_OUTBOUND__"` is a quoted placeholder; the whole string is replaced. The file
  stays valid JSON for tooling, but it is **not** a runnable Xray config, so it cannot be used
  by accident.
- The first outbound is Xray's default when no routing rule matches. Idle fills it with
  `{"tag":"proxy","protocol":"freedom","settings":{}}`; apply fills it with the node outbound
  (tag `proxy`). No routing rules are needed for v0.6.
- `direct` is unused in v0.6; it already carries the bypass mark because v0.7 uses it for the
  DNS bootstrap connection (ADR 0006).
- `config.json` never contains the placeholder. `kr_render_config` refuses a template without
  it.

The shell does not parse the outbound. It reads `outbound.json` as an opaque JSON fragment (the
UI writes one line; newlines are only whitespace if a human pretty-prints it), so protocol
knowledge stays in the tested JS renderer (`tests/outbound.test.js`).

## Applying a node

Tapping a node row in the UI is one gesture: it writes `state.selected`, renders that node,
writes `outbound.meta` and then `outbound.json`, and calls:

```sh
scripts/kernelray.sh apply <node-id>
```

`selected` goes first so a crash between writes leaves the honest "wants this node, runs the
old one" state instead of a config newer than the pointer. `outbound.meta` goes before
`outbound.json` so a crash between those two leaves an id mismatch (boot falls back to idle)
rather than a new outbound paired with an old id.

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

A failed `-test` does **not** write a failed `phase`: the old core is still running and healthy.
The CLI returns the error; the WebUI shows it in a toast. Only a failed **start** makes the
status failed, and the restore path clears it if the old config starts.

Applying always restarts a running core. The node list marks the applied node and, after a
failed switch, the selected-but-unapplied node. Tapping the applied node with no changes does
nothing to the core; tapping it after a re-import kept its id and marked it `dirty` re-applies
it, and the `dirty` flag clears on success. Importing a node changes nothing until a row is
tapped.

## Why the shell does not read `state.json`

`state.json` is nested JSON and the device has no `jq`. Parsing it with `awk`/`sed` is the same
liability ADR 0003 rejected for share links. The UI already has the node; rendering it there
and handing the shell one flat outbound keeps the transformation testable and the shell simple.

## Escaping

JSON is not safe to paste into a shell string or an `awk -v` value: `$`, backticks, quotes and
backslashes all have meaning somewhere. `kr_render_config` therefore passes the outbound line
through an **environment variable** (`ENVIRON["KR_OUT_LINE"]`), and `awk` only locates the
placeholder and prints the pieces. Nothing is re-expanded. `tests/config.test.js` exercises a
password containing quotes, backslashes, `$`, backticks, `&`, `<>` and a newline escape.

## Boot and self-healing

`service.sh` calls `kr_start`, which uses `config.json` when it exists. `kr_ensure_config` only
runs when the file is missing:

- if `runtime/applied` exists, `outbound.meta` names the same id, and `outbound.json` is
  present, the config is rebuilt from that outbound. The UI writes the meta before the outbound,
  so a crash between its writes leaves a different id and falls through to idle; a same-id
  settings edit can rebuild the older outbound, which is why the node is marked `dirty`;
- otherwise the config is rebuilt as idle and `runtime/applied` is cleared, so the UI never
  claims a node is applied when the config is direct.

The normal boot path never rewrites the config. An upgrade replaces the whole module directory
(ADR 0002), so config, outbound and applied id are reset together.

## Invariants

- `state.selected` is intent; `runtime/applied` is fact. The UI shows both and never equates
  them.
- The node outbound is always tagged `proxy` and carries no socket mark in v0.6. On Android an
  arbitrary `SO_MARK` with no matching ip rule loses routing (verified: the node's Reality
  handshake failed until the mark was removed). Only the template's fixed `direct` outbound
  carries the v0.7 bypass mark; the node mark must ship together with the v0.7 rules.
- `config.json` is never hand-edited and never shipped in the ZIP.
- `xray -test` precedes every swap; a candidate that fails never replaces a working config.
