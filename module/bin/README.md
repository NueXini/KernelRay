# The core and its geo data

`module/bin/` holds the three files the module runs with, and nothing else: the core and the two
category files the 分流规则 name. None of them is committed to this repository — put them here
before packaging (docs/adr/0014).

## Core

`module/bin/xray` is the Xray core the module runs:

```sh
curl -LO https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm64-v8a.zip
unzip -j Xray-android-arm64-v8a.zip xray -d module/bin/
```

One core, one path, arm64 only. x86_64 emulators still run it through the platform's ARM
translation, which is fine for testing but slow — that is not a reason to reintroduce a
per-arch layout.

At install time the module only checks that the binary executes (`xray -version`); there is
no architecture guesswork, because `$ARCH` and `uname -m` lie on emulators.

## Geo data

`module/bin/geosite.dat` and `geoip.dat` are the category files the 分流规则 name —
`geosite:cn`, `geosite:private`, `geoip:cn`, `geoip:private`. They sit **beside the core**,
because that is where the core looks for them: with `XRAY_LOCATION_ASSET` unset it resolves
them from its own executable's directory, not from the cwd (26.10.29). One unpack puts the core
and its data in place together, and no path has to be configured or kept in sync.

### Default for a release: Loyalsoldier/v2ray-rules-dat

Bigger (7.4MB compressed, 27.9MB installed) and it carries 260 `geoip` categories plus the
richer ad/reject lists a later rule editor will want:

```sh
curl -LO https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat
curl -LO https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat
mv geosite.dat geoip.dat module/bin/
```

Pin the release tag rather than following `latest` when preparing a release, and check the
`.sha256sum` files the same release publishes. Record the pinned set and tag in the release
notes: the module ships the files without a version stamp, so the release is the only place
that says which set this build carries.

### While testing: the core's own geodata

The ZIP the core comes from already contains both files, so a test build needs nothing extra —
one command fills the whole directory:

```sh
curl -LO https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm64-v8a.zip
unzip -j Xray-android-arm64-v8a.zip xray geosite.dat geoip.dat -d module/bin/
```

Name the three files explicitly: a bare `-j` would also extract the ZIP's own `README.md` and
`LICENSE` over this file. That is the XTLS set (18 `geoip` categories, ~3.3MB compressed). It
carries every category this version names, and its `geoip:cn` is *larger* than Loyalsoldier's —
25,466 prefixes vs 10,012 (7,049 vs 6,516 IPv4) — so testing with it says nothing different
about 大陆直连. What it does not carry is the extra categories, which is exactly what a release
pays the 4.1MB for.

### What the module does with them

Both files are needed together: `xray -test` loads them, so a config naming `geosite:cn`
without `geosite.dat` fails the test and the module refuses to switch to 大陆直连
(`routing cn`). A start that finds the files missing degrades to 全局 and says so in
`logs/kernelray.log` — it never leaves the core unable to start. `scripts/pack.sh` refuses to
build a ZIP without them.

The data's age is the release's age: a module update replaces the whole module directory
(docs/adr/0002), so these files are refreshed exactly when the module is.
