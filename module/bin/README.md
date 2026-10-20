# Core

`module/bin/xray` is the Xray core the module runs. It is **not** committed to this
repository — put it here before packaging:

```sh
curl -LO https://github.com/XTLS/Xray-core/releases/latest/download/Xray-android-arm64-v8a.zip
unzip -j Xray-android-arm64-v8a.zip xray -d module/bin/
```

One core, one path, arm64 only. x86_64 emulators still run it through the platform's ARM
translation, which is fine for testing but slow — that is not a reason to reintroduce a
per-arch layout.

At install time the module only checks that the binary executes (`xray -version`); there is
no architecture guesswork, because `$ARCH` and `uname -m` lie on emulators.
