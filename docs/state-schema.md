# `state.json` — user intent

Location: `/data/adb/modules/kernelray/state.json`, mode `0600`, owner `root`.

`state.json` is the **intent**: which nodes the user has, and which one the user asked for.
`config.json` is the **derived artifact** the core actually runs. They are not the same file and
the UI must never present one as the other.

In the WebUI's node list one gesture does both: tapping a row writes `selected`, renders the
node to `outbound.json`/`outbound.meta` and calls `kernelray.sh apply <id>` (see
[`config-derivation.md`](config-derivation.md)). `selected` is written first, so a failed switch
leaves the wish pointing at the attempted node while `runtime/applied` still names the node the
core runs.

Written by: the WebUI importer, the node list (switch and delete), and the apply success path
when it clears a node's `dirty` flag. Read by: the WebUI node list.
Ownership note: the shell writes runtime facts (`runtime/status.json`, `runtime/applied`, pid),
the UI writes intent and the rendered outbound (`outbound.json` + `outbound.meta`).

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | int | Schema version. Currently `1`; the UI refuses to interpret anything else. |
| `revision` | int | Bumped on every write, so a stale reader can notice it changed. |
| `settings` | object | Reserved for routing/DNS settings. Preserved verbatim, not interpreted yet. |
| `manual` | `Node[]` | Nodes added by hand (import) — the only list the UI appends to, renders and deletes from. |
| `subscriptions` | `{name,url,nodes:Node[]}[]` | Nodes that came from a subscription. Preserved verbatim; nothing fills or renders them in this version. |
| `selected` | string | `id` of the node the user last chose. Normally the applied node; a failed switch leaves it on the attempted node. `""` when nothing is selected. |
| `group` | string | Free-form label; no behaviour attached. |

`selected` is a wish. The node the current core config was actually built from is
`runtime/applied`, written by `kernelray.sh apply <id>`; the node list marks both and says when
they differ (a failed switch). `outbound.json` / `outbound.meta` hold the last rendered
candidate; only `runtime/applied` says whether the swap actually succeeded.

## Node list actions

The Nodes page renders `manual` only. It writes `state.json`; it never writes `config.json` or
`runtime/applied`.

- **Import** appends new identities and updates existing ones in place (keeping the id). It never
  changes `selected`; the user switches by tapping a row afterwards.
- **Tap a node** writes `selected`, renders the node to `outbound.json` + `outbound.meta`, and
  calls `apply <id>`. Tapping the **applied** node whose fields have not changed does nothing to
  the core (it only re-syncs `selected` if a failed switch left it elsewhere). Tapping the
  applied node after a re-import changed it (`dirty`) re-applies it.
- **Delete** is refused for the applied node. Deleting the selected node clears `selected`;
  deleting a node whose rendered outbound is on disk (its id is in `outbound.meta`) also removes
  `outbound.json` and `outbound.meta`, so credentials do not outlive the node. Deletion needs a
  second tap to confirm.
- A **failed switch** leaves `selected` on the attempted node. The list marks it `not applied`
  and keeps the old node marked `applied`; tapping the attempted node retries.

Unknown top-level fields are preserved: the writer parses the file, mutates the object and
serialises it back, so nothing is dropped by an older UI.

## Node

Common fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | **Opaque** 16-hex id, derived from the node's identity (below). Never parse it, never hand-edit it. |
| `name` | string | Display name, from the link's `#fragment` when present, else `host:port`. Not part of identity. |
| `protocol` | string | `vless` \| `vmess` \| `trojan` \| `ss`. |
| `address` | string | Hostname or IP, IPv6 **without** brackets. |
| `port` | int | 1–65535. |
| `transport` | string | `tcp` \| `ws` \| `grpc` \| `h2` \| `httpupgrade` \| … (left as written in the link). |
| `security` | string | `none` \| `tls` \| `reality` \| … (left as written in the link). |
| `sni` | string? | TLS server name. |
| `alpn` | string[]? | e.g. `["h2","http/1.1"]`. |
| `fingerprint` | string? | uTLS fingerprint (`fp`), e.g. `edge`, `chrome`. |
| `allowInsecure` | bool? | Present only when the link asked for it. |
| `path`, `host`, `serviceName` | string? | Transport parameters (`ws` path, `Host` header, `grpc` service name). |
| `dirty` | bool? | UI-only: set when an import/update changes a node with the same `id`; cleared after a successful apply. Means "the running config may predate these fields", not "not applied". Tapping the applied dirty node re-applies it. The shell ignores it. |

Protocol-specific fields:

| Protocol | Fields |
| --- | --- |
| `vless` | `uuid`, `encryption` (`none`), `flow` (`xtls-rprx-vision`), `publicKey` (`pbk`), `shortId` (`sid`) |
| `vmess` | `uuid`, `alterId` (int), `cipher` (`auto`) |
| `trojan` | `password` |
| `ss` | `method`, `password` |

## Identity and deduplication

Identity is the tuple, lowercased on the host:

```
protocol | address | port | credential…
```

where the credential is `uuid` for vless/vmess, `password` for trojan, `method` + `password` for
ss. `name`, `transport`, `security`, `sni` and the transport parameters are **not** part of it.

Consequences, all deliberate:

- Re-importing the same node replaces it in place and keeps the original `id`; renaming a node
  and importing it again does not create a second entry.
- Changing a node's SNI or transport in the URI produces the same identity, so *that* edit is
  applied to the existing entry rather than creating a new one. The entry is marked `dirty`,
  because the id alone would otherwise make the applied config look current.
- `id` values written by older builds (md5-style) are kept as-is when a node is matched by
  identity — the identity, not the hash, is what decides.

## Accepted input

One link per line, or a single base64 blob that decodes to such lines.

- `vless://uuid@host:port?type=…&security=…&sni=…&fp=…&pbk=…&sid=…&flow=…#name`
- `vmess://` + base64 of the v2rayN JSON object (`add`, `port`, `id`, `aid`, `scy`, `net`, `tls`, …)
- `trojan://password@host:port?type=…&sni=…#name`
- `ss://` SIP002 (`ss://base64(method:password)@host:port#name`) and the legacy
  `ss://base64(method:password@host:port)#name`

Rejected loudly, per line, with a reason: unknown schemes (`hysteria2://`, `tuic://`, …),
`ss://` links carrying a SIP003 `plugin=`, and anything whose base64 or JSON does not decode.
