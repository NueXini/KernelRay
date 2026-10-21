# 0004 — TPROXY takeover is module-owned, opt-in and fail-closed

Status: accepted

## Context

v0 is an idle run: the core listens on local socks/http inbounds and nothing redirects device
traffic into it. Transparent proxying was parked. The user now wants TPROXY.

That leaves three forks that are expensive to reverse: who installs the rules (the module, or
the user/another module around a bare tproxy inbound), whether takeover is opt-in, and what
happens to traffic when the core is not running. A fourth fork is reachability: a partial
capture (some UIDs, one address family, TCP only) is a silent leak, not a smaller feature.

## Decision

**The module owns the whole mechanism.** It installs and removes `iptables`/`ip6tables` mangle
rules plus the policy routing that steers packets into the core's tproxy inbound. The user gets
a switch, not a rule-writing tutorial.

- **Scope:** device-local traffic from all UIDs (root and system included); TCP and UDP; IPv4
  and IPv6. Forwarded/tethered traffic is *not* taken over — this module proxies the device, it
  is not a router.
- **Fixed bypass:** loopback, private/LAN and link-local/multicast ranges, and the core's own
  outbound sockets. The core bypasses through a dedicated socket mark and an `ip rule` that
  outranks the capture rule; it is never excluded by UID, which would also exempt every other
  root process.
- **Opt-in, default off.** The takeover switch is persisted and restored at boot. With no
  applied node the switch cannot be turned on: capture without an outbound is worse than an
  idle run.
- **Fail-closed.** While the switch is on, the rules exist independently of the core's health:
  at boot they are installed before the core starts, and a core that crashes later leaves them
  in place, so traffic is dropped instead of going out directly. A failed *rule install* is the
  one path that rolls back and can leak; it must be reported as `failed/rules`.
- **Exclusive namespace.** Dedicated chain names, fwmark, routing table and `ip rule`
  preference; only those are cleaned up, never another module's rules. Enabling refuses with
  `failed/conflict` when a TUN/WireGuard interface is up or a foreign `-j TPROXY` rule is
  present. Detection is heuristic; the documentation still says only one transparent proxy may
  be active.
- **The listener is not an open proxy.** TPROXY requires the inbound to bind a wildcard address;
  an INPUT rule drops direct connections to that port from anything but loopback.

## Consequences

- A dead core looks like "no network". Recovery is turning the switch off (WebUI or
  `action.sh`), which does not require network access. Status and the module log must say why.
- ICMP is not captured: `ping` stays direct. That is a documented limitation, not a bug.
- Per-app bypass, TUN mode and tethering are explicitly not supported in this version.
- An update still resets the switch, config and node store (ADR 0002), so a fresh install after
  an update is idle until the user applies a node and turns takeover on again.

## Rejected alternatives

- **Expose a tproxy inbound and let the user write rules.** That is an inbound, not support for
  transparent proxying; every user would get the fail-open/leak semantics wrong differently.
- **TUN / VpnService.** Another device to manage and a different permission model; the core
  already supports tproxy.
- **REDIRECT.** TCP-only, and UDP is half the reason to use TPROXY.
- **Fail-open with a supervisor.** A core crash would silently restore direct traffic, which is
  the privacy failure this feature exists to prevent. A watchdog was also explicitly parked.
- **Auto-enable at boot / after upgrade.** An update must never take over a device's network
  without the user asking again.
- **Flush foreign rules to win the conflict.** Destructive and unannounced; refusing is honest.
