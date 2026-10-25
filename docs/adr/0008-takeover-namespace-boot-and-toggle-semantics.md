# 0008 — Takeover namespace, boot and toggle semantics

Status: accepted (implements the rule-level details left open by
[ADR 0004](0004-tproxy-takeover-is-module-owned-and-fail-closed.md); refines the DNS
bypass of [ADR 0006](0006-dns-goes-through-the-core.md)). The switch semantics — default
off, immediate toggle, boot-time rules without a node — are superseded by
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md): the switch is
default-on, start-coupled, and only ever a preference write.

## Context

ADR 0004 fixed *who* owns the rules and *what* happens when the core dies, but the
implementation still had to pick the actual numbers, the boot-time conflict behaviour,
the toggle gesture's exact sequence, and where the node outbound's socket mark comes
from. Each choice is device-visible; some are effectively permanent once users have
the rules installed.

## Decision

**Exclusive namespace — one set of literal numbers:**

| Thing | Value |
| --- | --- |
| capture fwmark | `19283` (0x4B53; set by the OUTPUT chain, read by the capture rule) |
| bypass fwmark | `19282` (0x4B52; carried by every core-owned socket: node, direct, tproxy listener) |
| routing tables | `19283` (local-table capture), `19282` (bypass: a copy of the current default route) |
| `ip rule` preferences | `9500` (capture), `9400` (bypass) |
| tproxy listener port | `10810` |
| chains | `KR_TP_PREROUTING`, `KR_TP_OUTPUT` (mangle), `KR_TP_INPUT` (filter) |

All literals; Android has no `/etc/iproute2`, so nothing depends on name resolution.

**Two marks, not one.** The capture mark reroutes captured packets into the listener
(`fwmark 19283 → table 19283 = local`). The core's own sockets must never enter that
table — the first bypass attempt reused 19283 for both and looped every core connection
back into the core (measured on-device: DNS DoH timeouts, zero outbound sockets). So the
bypass mark is distinct and has its own rule, `9400: fwmark 19282 lookup 19282`, whose
table carries a **copy of the current default route** (parsed from `ip route show table
all` at install time). Copying is required because Android keeps the default route in a
per-network table selected by netd's own marks, and rule 32000 is `unreachable` — an
arbitrary mark with no rule of its own is dead (the v0.6 lesson). A network switch after
takeover is on invalidates the copy; a core restart rebuilds it.

**Rule shape.** `KR_TP_OUTPUT` returns core sockets (bypass mark) first, marks DNS (tcp/udp
53) *before* the bypass ranges so a LAN resolver is captured too (ADR 0006's leak argument
wins over the LAN bypass for this one port), bypasses DHCP (udp 67:68) — a proxied DHCP reply
never assigns an address — the device's own addresses (a tproxy reply goes back to the device
itself, which is not in any fixed range on a public-IP device), and the fixed bypass ranges
(loopback, RFC1918, CGNAT, link-local, multicast, limited broadcast; `::1/128`, `fe80::/10`,
`fc00::/7`, `ff00::/8` for v6); everything else is marked with the capture mark and
policy-routed to the local table, where `KR_TP_PREROUTING` (reached over `lo` only —
physical interfaces RETURN) TPROXYs it into port 10810. `KR_TP_PREROUTING` matches on
**source, not destination or mark**: every captured packet originates from a local client
(the device's own addresses or 127/8), while the core's own transparent replies — SYN-ACKs
and DNS answers, which inherit the captured SYN's tproxy mark via `inet_request_sock` and
whose destination is the local client — must flow to normal local delivery. Mark-based or
destination-based matching loops every answer back into the core (measured: all handshakes
stuck in SYN-SENT/SYN-RECV). `KR_TP_INPUT` drops direct LAN access to the wildcard listener.
The listener is one dokodemo-door inbound on `::` carrying `sockopt.tproxy`.

**The mark placeholder.** The UI's node renderer writes `"sockopt":{"mark":"__KERNELRAY_MARK__"}` —
never a real mark, because the renderer cannot know the switch state and a mark without
its ip rule loses routing (verified on v0.6). The shell replaces the placeholder with
the bypass mark 19282 while takeover is on and `0` while it is off (Xray treats mark 0
as unset), so mark and rules always ship together from one place. The template's direct
outbound keeps its literal 19282: an unused outbound creates no socket.

**Boot with the switch on** (superseded by ADR 0011: the engagement now lives inside
`kr_start_locked` as `kr_tp_engage`, and a start without an applied node installs no rules).
The on-start path re-renders the config to match the switch — a takeover-form config without
rules loses routing, and rules without a tproxy listener blackhole traffic, so the stale
combination is never started.
Then: conflict → rules are skipped, the idle-form config is written, status is
`failed/conflict`, and the switch file stays on (intent is never silently rewritten);
the WebUI shows the reason and a retry button. Rule install failure → idle-form config,
`failed/rules`, switch stays on. No conflict and a clean install → the node address is
pinned (below), rules first, core second (the fail-closed ordering), phase `idle`.

**The pinned node address.** The bootstrap chain "connect to the node → resolve the
node" must not depend on an upstream resolver: on networks where the fixed DoH
endpoint or the node's own resolution is unreachable, a domain-based node can never
bootstrap. So `tproxy on` and the boot path resolve the node host with the **system
resolver while the network is still direct** (rules not yet installed) and write the
answer to `runtime/nodeip`; the takeover render puts it into the DNS module's `hosts`,
so the core answers the node domain locally. Resolution failure is not fatal — the
direct-DoH routing rule remains as the fallback, and the log says so. A stale pin
(node IP changed, or the device changed network) is rebuilt by toggling the switch.

**A records only.** The DNS module runs with `queryStrategy: UseIPv4`. When the device
has any IPv6 connectivity, AAAA answers make apps prefer v6 — and that traffic either
leaks direct (the enumeration of the device's own v6 addresses can never keep up with
privacy-extension temporary addresses) or dangles. Without AAAA, every app connection
is IPv4 and captured. Sites reachable only over IPv6 are unreachable during takeover;
that is a documented limitation, not a bug.

**Toggle semantics** (`kernelray.sh tproxy on|off`) — superseded by
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md): the command now
only writes the preference, applied at the next core start. The v0.7 immediate-toggle
semantics were:

- `on` requires an applied node with a matching outbound and a clean conflict check.
  Order: render + `xray -test` the takeover candidate → install rules (a failure
  removes everything and reports `failed/rules`) → write the switch → swap the config →
  start the core, whatever it was doing before. A core that fails to start on the
  takeover config rolls back completely — previous config, rules removed, switch
  cleared — because restoring a marked config with no rules breaks the node outbound,
  and an offline device is a worse default than a reported leak.
- `off` removes the rules first (the core's marked sockets lose routing the moment
  they are gone anyway), clears the switch, then re-renders the config in idle form,
  restarting the core if it was running. A candidate that fails `-test` falls back to
  idle rather than keeping a takeover-form config.

**Status vocabulary.** `status.json` gains `tproxy` (`on`/`off`, from the switch file)
and the phases `failed/rules` and `failed/conflict`; `logs/kernelray.log` records every
rule install, removal and conflict verdict.

## Consequences

- The namespace values are a compatibility contract: a future version must keep
  matching and removing exactly these names, or devices accumulate orphaned rules.
- While the switch is on, `action.sh` stopping the core leaves the rules up
  (fail-closed): the device is offline until the core starts again or `tproxy off` runs.
  The action output says so.
- Boot never auto-enables anything: the switch survives the reboot only because the
  user set it; a switch without a usable outbound is cleared, not honoured.
- DNS to LAN resolvers enters the core; a local Pi-hole-style resolver on the LAN is
  bypassed for everything except port 53. That is ADR 0006 applied consistently, and
  the README says so.

## Rejected alternatives

- **Different marks per outbound** (node vs direct). Two marks, two rules, no benefit;
  every core-owned socket must bypass, so they share one mark.
- **Shell-side JSON surgery to inject the mark.** The placeholder keeps the shell's
  "outbound is an opaque line" property (ADR 0003/0005).
- **Separate v4/v6 listeners.** One dual-stack wildcard listener; a second inbound is
  another port for the INPUT guard to protect.
- **Leave the config as-is on boot conflict.** The on-disk config is takeover-form;
  starting it without rules breaks the node outbound's routing for the whole session.
- **Honour a switch with no applied node.** Capture without an outbound drops all
  traffic; the switch is cleared instead.
