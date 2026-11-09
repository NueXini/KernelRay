# 0021 — Ad blocking is a third routing mode

Status: accepted

## Context

ADR 0014 bought 地理数据 that already carries the ad lists: `category-ads-all` is the union of
EasyList, EasyListChina, AdGuard DNS Filter, Peter Lowe and Dan Pollock — 905 entries in
the pinned set — and both the pinned Loyalsoldier set and the XTLS set inside the core's ZIP
carry it. The data was never the missing part. What 0014 refused was bundling
`geosite:category-ads-all` → `block` into 大陆直连, on the grounds that the mode's name promises
"mainland goes direct", not "ads are blocked"; the template's `block` outbound stayed there,
unused, "waiting for that editor". The user wants 去广告, and wants it as **one more 分流模式**
rather than a second, independent switch: `大陆直连去广告` / `Direct-CN-Adblock`, persisted as
`cnadblock` in `runtime/route`.

The mechanism is not free. `tp-in` has no `sniffing`, so for taken-over traffic the core only
ever sees IP:port — `domain` and `geosite` rules never match it, which is why 大陆直连 on a device
matches by `geoip` alone. The DNS module always sees the domain. Both references this decision
was checked against use **both** halves: v2fly's DNS documentation exemplifies
`"hosts": {"geosite:category-ads-all": [...]}`, and Loyalsoldier's README (the upstream of the
pinned set) gives `{"outboundTag": "Reject", "domain": ["geosite:category-ads-all"]}` in routing
*and* the same `hosts` entry in DNS. Xray's own documentation exemplifies neither — it documents
only the primitives (`hosts` with `geosite:` keys, `#<rcode>`, `blackhole`) — so this ADR records
a composition, not a copied recipe.

## Decision

- **A third 分流模式, not an orthogonal switch.** `runtime/route` holds `cn` or `cnadblock`
  (absent = 全局): the file stops being a presence flag and becomes a value. 大陆直连去广告 routes
  exactly as 大陆直连 does and additionally blocks ads.
- **Two ad parts, each where it can exist**: `dns.hosts` refuses the domains
  `geosite:category-ads-all` names (takeover form only — the 空转 form has no dns module), and
  `{"domain": ["geosite:category-ads-all"], "outboundTag": "block"}` goes into both forms' routing
  block. The routing rule sits **after** the dns/port-53 group and **before** the geo direct
  rules: first match wins, so a mainland ad domain must not fall into `geosite:cn` → `direct`,
  and a resolver query must not be swallowed by the block rule.
- **`category-ads-all` is fixed**, not a choice among lists, and there is no per-list picker.
- **No 全局 + 去广告 cell.** Three of the enum's four cells are reachable on purpose; a future
  `globaladblock` is a fourth value, not a new model.
- **Fail-closed, unlike `cn`.** `cnadblock` never degrades: missing `bin/*.dat`, or a set without
  `CATEGORY-ADS-ALL`, refuses the start (`failed config-invalid`) with a `Routing` line in
  `kernelray.log` and one short line on stderr so the WebUI toasts it — the missing files are
  caught before the start, the missing category by the core's own `-test`. `routing cnadblock`
  refuses up front when the files are absent. The reason
  is 0014's own lesson read the other way: a mode named 去广告 that silently renders as 大陆直连 is
  a mode whose name lies.
- **`block` keeps `settings: {}`**: blackhole closes the connection at once (`type: "none"` is the
  default), which is a fast failure; Loyalsoldier's `response: http` is not needed here.
- **The preference lifecycle is `routing`'s**, not the tproxy switch's: render → `-test` → write
  `runtime/route` → swap, restoring the old value when the new config does not start.
- **`大陆直连去广告` is the install-time default.** The installer writes `runtime/route` =
  `cnadblock` when the preference is still unset — the `kr_tp_default_on` pattern of ADR 0011 —
  so a fresh install splits mainland traffic out and blocks ads without the user picking
  anything, and 全局 becomes a choice rather than the absence of one. With the geo data missing
  the installer skips the default and leaves 全局: a default the core refuses to start with is
  worse than one that does less. A start after the `.dat` files disappear therefore refuses for
  a fresh install too — the fail-closed clause above, now reached by default rather than by
  choice.

## Considered options

- **An orthogonal 去广告 switch** (`runtime/adblock`, rendered into either mode): the shape the
  glossary would have preferred, since 分流模式 would keep meaning "where does the rest leave",
  and 全局 + 去广告 would be expressible. Rejected because the user asked for one mode; the cost
  is the missing cell above and the escape is a fourth enum value.
- **Routing-only** (Loyalsoldier's first half): blocks nothing on a device, because `tp-in` sees
  IPs, not domains. It would look implemented and do nothing.
- **DNS-only** (v2fly's example): leaves 空转 and domain-carrying socks/http clients unblocked.
- **`sniffing` on `tp-in`** so IP-only connections can match by SNI: stronger — it would also
  catch apps that bring their own DoH — but it changes 大陆直连's existing behaviour for device
  traffic (`geosite:cn` would start matching taken-over connections), so it is a decision of its
  own, not a detail of this one.
- **Degrading like `cn`** (render the global form, log it): the safe direction 0014 chose, and
  the reason the fail-closed clause above needed its own argument.
- **`category-ads` (845) or `category-ads-and-telemetry` (877)**: narrower and broader
  respectively; `-all` is what 0014 named and what the data's own README documents as the union.

## Consequences

- 全局 and 大陆直连 render byte for byte as before; only a `cnadblock` render carries the ad parts.
- The install default is a preference, not a constant: a user who picks 全局 gets an absent file,
  and the next install or update recreates `cnadblock` — the tproxy switch's behaviour, and the
  same trade ADR 0002/0011 already accept (an update resets the preferences it owns).
- The render stops comparing `= cn` in strings: `kr_route_effective` sets `KR_ROUTE_CN` and
  `KR_ROUTE_BLOCK_ADS`, and the DNS/routing builders read those flags, so a fourth value later
  cannot silently miss a branch.
- A device whose `.dat` files disappear while the mode is `cnadblock` **loses its network at the
  next start**: the takeover rules go in before the config is tested (ADR 0011), the test fails,
  and the core never runs — fail-closed drops the traffic until the user picks another mode in
  the WebUI. Accepted, and the reason the switch refuses up front.
- Ads become failed connections rather than blocked ones, and three classes stay out of reach: ads
  served from the content's own domain (YouTube in-app), apps with their own DoH/DoT, and
  hardcoded IPs. No category can name them.
- The WebUI select and its hints, `routing`'s usage and status, `status`'s `route=`/`routing=`,
  `docs/config-derivation.md`, `docs/state-schema.md`, `docs/xray-guide.md` and
  `bin/README.md`'s category list all grow a third value; `tests/adblock.test.js` carries the new
  render matrix. `README.md` and `module.prop` still describe two modes: left untouched by this
  change on purpose, so their wording is now narrower than the code.
