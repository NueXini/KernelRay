# 0005 — The core config is derived; the UI renders the node, the shell assembles

Status: accepted (extends ADR 0003; `config.json` is no longer user-owned)

## Context

v0 copies `config.example.json` to `config.json` once, after which the user owns that file.
Applying a node and enabling TPROXY changes that: the core config now has to carry the applied
node's outbound, a tproxy inbound, DNS and routing rules, and socket marks. Hand-editing it
would silently invalidate the takeover invariants.

The obvious split — shell writes derived artifacts, UI writes intent — collides with a hard
fact: `state.json` is nested JSON and the device has no `jq`. Parsing it in `awk`/`sed` is the
same liability ADR 0003 already rejected for share links.

## Decision

**`config.example.json` becomes a config template, and `config.json` becomes a generated
artifact that is never hand-edited.** Generation is split along what each side actually knows:

| Writer | File | Kind |
| --- | --- | --- |
| WebUI | `state.json` | user intent: node store, selected node |
| WebUI | `outbound.meta` + `outbound.json` | the selected node rendered as one Xray outbound, plus its id/host |
| shell | `config.json` | derived: template + outbound + takeover state |
| shell | `runtime/tproxy`, `runtime/applied` | takeover switch, applied node id |
| shell | `runtime/status.json`, `runtime/xray.pid`, `logs/` | runtime facts |

Rules that keep this honest:

- **One writer per file.** The UI never writes `config.json`, `status.json` or the switch; the
  shell never writes `state.json`, `outbound.json` or `outbound.meta`. No locks.
- **The UI renders data, the shell owns the layout.** Protocol knowledge (vless/vmess/trojan/ss,
  transports, TLS/REALITY) stays in the tested JS renderer; inbounds, routing, DNS, the fixed
  outbounds and the takeover rules stay in the shell template. The renderer deliberately does
  not stamp a socket mark on the node outbound: on Android an arbitrary `SO_MARK` with no
  matching ip rule loses routing (v0.6 verification: the node's Reality handshake failed until
  the mark was removed). The template's fixed `direct` outbound carries the v0.7 bypass mark;
  v0.7 must add the node mark and the bypass rule as one change.
- **Apply is a CLI operation.** The UI writes `outbound.meta`, then `outbound.json`, and calls
  `kernelray.sh apply <id>`. The shell writes `config.new.json`, runs `xray -test`, swaps it in
  atomically, restarts a running core and records the applied id. A failed test leaves the old
  config and the running core untouched.
- **The switch rewrites the config too.** When takeover is off the template has no tproxy
  inbound, so an idle module does not listen on a tproxy port that a LAN peer could reach.
  Toggling the switch therefore restarts the core.
- **Selected is not applied.** `state.selected` is what the user wants; `runtime/applied` is
  what the core runs. The UI must show the difference instead of pretending a selection
  changed the traffic.

## Consequences

- Hand-written Xray configs are no longer supported. The README and the installed message must
  say so; the template is the extension point for a future override mechanism.
- `outbound.json` contains credentials and gets the same `0600` atomic-write treatment as
  `state.json`; `pack.sh` must exclude it and `outbound.meta`, like `state.json` and
  `config.json`.
- The generated config depends on the applied node's host for the DNS bootstrap exception
  (ADR 0006), which is why the meta file carries it.
- Generation is testable in two independent pieces: the JS renderer against fixture nodes, and
  the shell assembly against a fixture outbound.
- ADR 0003's split still holds: the shell writes the derived `config.json` and restarts a
  running core; this ADR only adds the UI-rendered outbound as input to that step, because the
  shell cannot parse `state.json`.

## Rejected alternatives

- **The UI writes the whole `config.json`.** Fewer files, but moves the module's config layout
  (and the takeover invariants) into the browser, and leaves the CLI unable to re-derive the
  config when the switch changes.
- **Shell parses `state.json` with `awk`/`sed`.** Rejected for the same reason as in ADR 0003.
- **Ship `jq` (or another JSON tool).** Another binary and another architecture-specific thing
  to verify for a transformation whose input is already rendered by the UI.
- **Keep `config.json` user-owned and patch the module parts into it.** Requires JSON-aware
  patching without `jq`, invites tag collisions, and makes the tproxy invariants opt-out.
