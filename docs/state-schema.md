# `state.json` — user intent

Location: `/data/adb/modules/kernelray/state.json`, mode `0600`, owner `root`.

`state.json` is the **intent**: which nodes the user has, and which one they want in use.
`config.json` is the **derived artifact** the core actually runs. They are not the same file and
the UI must never present one as the other. (Today nothing derives `config.json` from
`state.json` yet — applying the selected node is still open work, see the README.)

Written by: the WebUI importer. Read by: the WebUI node card.
Ownership note: the shell writes runtime facts (`runtime/status.json`, pid), the UI writes intent.

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | int | Schema version. Currently `1`; the UI refuses to interpret anything else. |
| `revision` | int | Bumped on every write, so a stale reader can notice it changed. |
| `settings` | object | Reserved for routing/DNS settings. Preserved verbatim, not interpreted yet. |
| `manual` | `Node[]` | Nodes added by hand (import) — the only list the UI appends to. |
| `subscriptions` | `{name,url,nodes:Node[]}[]` | Nodes that came from a subscription. Nothing fills these yet. |
| `selected` | string | `id` of the node considered current. `""` when nothing is selected. |
| `group` | string | Free-form label; no behaviour attached. |

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
  applied to the existing entry rather than creating a new one.
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
