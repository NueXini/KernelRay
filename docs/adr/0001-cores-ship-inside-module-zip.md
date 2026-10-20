# One core at `bin/xray`, verified by running it

The module ships a single arm64 core at `module/bin/xray`. There is no per-architecture
layout and nothing is downloaded at install time: the installer only checks that the binary
executes (`xray -version`) before accepting the module.

Rejected alternatives:

- **Download the core on install** (what Xray4Magisk does) — a network failure at install
  time is unrecoverable, and the core version becomes whatever the device happened to fetch.
- **`bin/<arch>/xray` with a runtime probe** — the first version did this, then `AMD64` and
  `arm64` were both loaded into every ZIP, doubling size for a device class we do not target.
  Probing also invited the illusion that `$ARCH`/`uname -m` was trustworthy; both lie on
  emulators (an x86_64 emulator here reports `aarch64` and `ARCH=x64`).

**Consequences:** x86_64 devices/emulators rely on ARM translation. The release workflow must
inject the pinned core into `module/bin/` before packaging, since the binary is gitignored; a
ZIP built without it installs and then refuses to start (`status.json` → `failed/no-core`).
