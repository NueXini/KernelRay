# 0020 — The version is the pack date

Status: accepted

## Context

The module used semver (`version=v0.10.0`) plus a hand-bumped counter (`versionCode=74`).
Both lived in `module/module.prop` and both were edited by hand before every
`scripts/pack.sh` run. That had two failure modes: forgetting to bump (the installer then
silently treats the new ZIP as the same version) and forgetting what the bump meant (the
counter carries no information about when a build shipped). Meanwhile the release cadence
never followed semver discipline anyway — there is no API surface, and breaking changes
were already communicated in release notes rather than in the version string.

## Decision

- **`version` is the pack date, `YY.MM.DD`** (e.g. `26.11.08`), and **`versionCode` is the
  same date as `YYMMDD`** (e.g. `261108`). The counter jumps from 74 to 261108, which is
  still monotonic, so installer-side upgrade detection (it compares `versionCode`) keeps
  working unchanged.
- **`pack.sh` stamps both into `module.prop` at pack time** with `date -u` (UTC). Nobody
  edits them by hand, the version always matches the build, and — because the number is a
  pure function of absolute time rather than the packing machine's local timezone — the
  same moment packs to the same version from anywhere, and `versionCode` can never go
  backwards across machines.
- **The ZIP is named `<id>-<version>.zip`** (`KernelRay-26.11.08.zip`). Under the date
  scheme `versionCode` and `version` carry the same information, so the old
  `<id>-<code>-<version>` name spelled the date twice.
- **Same-day releases**: one pack per UTC day; the ZIP is overwritten. If same-day
  re-releases ever become real, the escape hatch is an 8-digit `versionCode` (`YYMMDDNN`)
  — not implemented until then.
- **Breaking changes are signalled in release notes**, not in the version string. Calver
  buys "when did this ship", not "what changed shape"; the trade-off was accepted
  deliberately.

## Consequences

- Reading a version answers "how old is this build", not "how big is the change". That is
  the right question for a single-user module with notes-per-release.
- `versionCode` grows by ~1 per calendar day; overflow is not a concern (it fits in int32
  past the year 2033).
