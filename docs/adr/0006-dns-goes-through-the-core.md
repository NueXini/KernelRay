# 0006 — DNS is taken over through the core's DNS module

Status: accepted

## Context

TPROXY captures TCP/UDP 53, and DNS is where "just route everything to the node" stops working:

- Android sends DNS through `netd`, not from the app's socket, so a UID or socket-mark bypass
  cannot distinguish "the core resolving its own server" from an app's lookup.
- The resolver a phone receives from the network is usually the LAN router (`192.168.x.1`).
  Forwarding that packet to a remote node asks the node to reach a private address on *its* LAN;
  it cannot work.
- Leaving 53 out of takeover leaks every lookup, and the answers are geo-located for the device,
  not the node, which defeats half the point of proxying.
- DNAT-ing 53 to a public resolver keeps the leak out but still needs UDP on the node and
  overrides the app's resolver.

Xray's DNS module can answer captured queries itself, and its upstream queries can be routed
(`dns.tag` + `inboundTag` routing), which makes the lookup follow the proxy without depending on
the node's UDP support.

## Decision

- TCP and UDP 53 arriving on the tproxy inbound are routed to a `dns` outbound. The DNS module
  answers them.
- The module's upstream is fixed to `https://1.1.1.1/dns-query` — an IP literal, so the upstream
  never needs a lookup of its own. Its queries carry the DNS module's tag and are routed through
  the proxy, so the resolver sees the node's egress, not the device's.
- The **applied node's own hostname is resolved through the `direct` outbound** (a routing rule
  built from the node meta). This breaks the bootstrap cycle "connect to the node → resolve the
  node → needs the node". The `direct` outbound carries the bypass mark; the node outbound
  deliberately does not in v0.6 (see ADR 0005). The exception is one domain, not all DNS.
- Apps that speak DoH/DoT themselves (TCP 443/853) are ordinary proxied traffic and are not
  intercepted. The hijack applies to port 53 only.
- No fake-ip, no DNAT to a public resolver, no DNS bypass.

## Consequences

- DNS works even when the node has no UDP relay, and the answers are resolved from the node's
  point of view.
- v1 has one fixed upstream. A user who wants a different resolver cannot change it yet; the
  README must say so instead of implying configurability.
- Because Android's queries are answered by the module, a local/private resolver configured on
  the device stops being used for plain DNS. DoH/DoT still work because they are not port 53.
- The generated config depends on the applied node's host (the meta file in ADR 0005); an IP
  node simply produces no direct exception.
- If direct access to the fixed DoH endpoint is blocked on the underlying network, the bootstrap
  lookup fails and the node cannot be reached. Using an IP address for the node avoids this;
  it is a documented bootstrap limitation, not a per-app setting.

## Rejected alternatives

- **Send 53 to the node like any other UDP.** Breaks on the LAN-resolver case, which is the
  common case.
- **Let DNS go direct.** Simple and fast, but leaks lookups and returns device-located answers.
- **DNAT 53 to a public DNS and route it through the node.** Still needs node UDP and overrides
  the resolver the app chose.
- **fake-ip.** Only pays off when routing decisions need domains; this version has one proxy
  outbound, so it adds a subsystem without changing where traffic goes.
