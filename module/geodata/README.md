# Geo data

`module/geodata/geosite.dat` and `geoip.dat` are the category files the 分流规则 name —
`geosite:cn`, `geosite:private`, `geoip:cn`, `geoip:private`. They are **not** committed to
this repository; put them here before packaging (docs/adr/0014).

## Default for a release: Loyalsoldier/v2ray-rules-dat

Bigger (7.4MB compressed, 27.9MB installed) and it carries 260 `geoip` categories plus the
richer ad/reject lists a later rule editor will want:

```sh
curl -LO https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat
curl -LO https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat
mv geosite.dat geoip.dat module/geodata/
printf 'loyalsoldier %s\n' "<release tag>" > module/geodata/VERSION
```

Pin the release tag rather than following `latest` when preparing a release, and check the
`.sha256sum` files the same release publishes.

## While testing: the core's own geodata

The ZIP the core comes from already contains both files, so a test build needs nothing extra:

```sh
curl -LO https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm64-v8a.zip
unzip -j Xray-android-arm64-v8a.zip geosite.dat geoip.dat -d module/geodata/
printf 'xtls %s\n' "<release tag>" > module/geodata/VERSION
```

That is the XTLS set (18 `geoip` categories, ~3.3MB compressed). It carries every category this
version names, and its `geoip:cn` is *larger* than Loyalsoldier's — 25,466 prefixes vs 10,012
(7,049 vs 6,516 IPv4) — so testing with it says nothing different about 大陆直连. What it does
not carry is the extra categories, which is exactly what a release pays the 4.1MB for.

Either way `VERSION` is one display line — the WebUI's Settings page shows it, so "why did this
site not go direct?" has an answer.

## What the module does with them

Both files are needed together: `xray -test` loads them, so a config naming `geosite:cn`
without `geosite.dat` fails the test and the module refuses to switch to 大陆直连
(`routing cn`). A start that finds the files missing degrades to 全局 and says so in
`logs/kernelray.log` — it never leaves the core unable to start. `scripts/pack.sh` refuses to
build a ZIP without them.

The data's age is the release's age: a module update replaces the whole module directory
(docs/adr/0002), so these files are refreshed exactly when the module is.
