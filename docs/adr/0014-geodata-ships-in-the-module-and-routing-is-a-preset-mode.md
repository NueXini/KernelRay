# Geo data ships with the module, and routing is a preset mode

Routing needs `geosite.dat` and `geoip.dat`: `geosite:cn` / `geoip:cn` only resolve if the
files sit next to the core. They ship inside the release ZIP in `bin/`, the directory the core
itself lives in, because a device-side download would make a start depend on the network and
because the WebUI has no TLS-validating fetcher: ADR 0001's reasoning, one file class further.

Status: accepted (the preference-file pattern it borrows from `runtime/tproxy` is now
`runtime/route`'s alone, and the 空转 form it mentions no longer exists — see
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md))
No asset path is configured: with `XRAY_LOCATION_ASSET` unset the core resolves the files from
its own executable's directory — 26.10.29 searches there, not the cwd — so the location inside
the ZIP is the only thing that has to be right.

Which set is in the ZIP is a **per-release pin, not a code constant**: the release notes and
`bin/README.md` name it, and the shipped files carry no version stamp of their own. The reference
release pins **Loyalsoldier/v2ray-rules-dat** — 260 `geoip` categories and the richer ad/reject
lists a later rule editor will want — while testing uses the geo data that comes inside the
core's own ZIP (XTLS/Xray-rules-dat) unchanged, because it is already in the file the core is
extracted from. Both carry every category this version names (`cn`, `private`), and `geoip:cn`
is no smaller in the XTLS set (25,466 prefixes vs 10,012; 7,049 vs 6,516 IPv4), so the pin changes
what a release costs (3.3MB compressed / 11.5MB installed vs 7.4MB / 27.9MB) and which extra
categories exist — never whether 大陆直连 works.

The user picks a **分流模式** instead of authoring rules: `全局` (the applied node carries
everything — the default, and what every earlier version did) or `大陆直连` (mainland domains
and addresses leave by `direct`). The preference is the shell's, in `runtime/route`, written by
`kernelray.sh routing global|cn` — the `runtime/tproxy` pattern, not `state.json`'s settings,
whose ADR 0009 `sed` exception stays at two integers. Unlike the tproxy switch it re-derives
the config immediately (render → `-test` → restart, the `ports` path) and rolls the preference
back when the new config does not start: nothing about routing needs the start-time ordering
that makes the tproxy switch a next-start preference.

`大陆直连` is not two rules and a DNS that stays as it was. The fixed DoH upstream answers
mainland domains with overseas CDN addresses, so `geoip:cn` would never match and the split
would be half a feature: mainland domains are resolved by domestic resolvers (`223.5.5.5`,
`119.29.29.29`, filtered by `expectIPs: ["geoip:cn"]`) whose queries leave `direct`, everything
else keeps the DoH through the node, and `domainStrategy` becomes `IPIfNonMatch` so a domain no
geosite category knows can still match `geoip:cn`. The same rule set is rendered into the 空转
form too — without the DNS rules, which only exist where the dns inbound does — so a local
socks client gets the same 分流 as the device.

Consequences we accept: the ZIP grows by 3.3–7.4MB (11.5–27.9MB installed) depending on the
pinned set, and a module update resets the data with the rest of the module dir, so the data's
age is the release's age. Missing or unreadable geo data never bricks the core: a `cn` render
degrades to the global form and says so in `kernelray.log`, and `routing cn` refuses to switch
while the files are absent — the safe direction is always "everything through the node".

## Considered options

- **One dataset hard-coded in the module** — the extra 4.1MB a release spends on Loyalsoldier's
  categories would then be spent on every test build too, and swapping sets would be a code
  change instead of a file swap plus one line in the release notes.
- **Downloading the data on the device** at install or first start — network at install time
  and an unrecoverable failure, the same trade ADR 0001 rejected for the core.
- **Xray's own `app/geodata` downloader** (https URL + cron, hot-reloaded) — a start-time
  network dependency, and a cache outside the module dir, which ADR 0002 forbids.
- **A user-editable rule list** — needs a rule model, ordering semantics, validation and a new
  UI. This ADR buys the data and the first two modes; the editor is a later version.
- **`geosite:category-ads-all` → `block` bundled into 大陆直连** — the mode's name promises
  "mainland goes direct", not "ads are blocked". The template's `block` outbound stays unused,
  waiting for that editor.
- **Keeping the fixed DNS** — a 分流 whose IP half can never match. See above.

## Amendment

The files were moved from `geodata/` into `bin/`, beside the core, and `geodata/VERSION` was
dropped. One unpack of the core's own ZIP now fills the whole directory, and the data needs no
path of its own in the code: with `XRAY_LOCATION_ASSET` unset the core reads them from its own
directory, so the two cannot drift apart — and the module stopped exporting the variable once
that was verified on device. The decision above is otherwise unchanged — the data still ships
inside the ZIP and the set is still pinned per release — but the device no longer names the
pinned set: the release notes do, and the Status page reports presence rather than a version line.

## Amendment — 0021

分流模式 is no longer two values: 大陆直连去广告 (`cnadblock`) renders 大陆直连's rules plus the
`geosite:category-ads-all` parts, as a mode of its own rather than a switch (docs/adr/0021). The
option rejected above — "`geosite:category-ads-all` → `block` bundled into 大陆直连" — stays
rejected as written: 大陆直连 itself is unchanged and blocking lives in a mode whose name says so.
The template's `block` outbound is no longer unused, and `category-ads-all` is now a category
this version names. 大陆直连去广告 is also the default the installer creates, so the "全局 is the
default" sentence above describes an earlier version: 全局 is now a choice, and the absent file
only means it.
