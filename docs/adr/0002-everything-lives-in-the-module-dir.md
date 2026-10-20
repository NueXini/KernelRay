# 0002 — Everything lives in the module directory

Status: accepted (supersedes the module-dir / data-dir split)

## Context

The first layout kept two roots: mechanism in `/data/adb/modules/kernelray`, and user data
(`config.json`, logs, runtime state) in `/data/adb/kernelray`. That is the pattern most modules
follow, and its motivation is real — KernelSU **replaces the module directory wholesale on
update**, so anything the user put there is destroyed by upgrading.

We measured it rather than assuming it. A marker file written into the module dir disappeared
after a `ksud module install` + reboot, while the same file in the data dir survived.

The requirement that drove this ADR is the opposite of that convenience: *nothing may be stored
outside the module directory*. Everything the module needs at runtime — core, config, node
store, logs, status — lives under one root, and the module leaves no residue when removed.

## Decision

One root: `/data/adb/modules/kernelray`. The module writes only there.

Consequences we accept:

- **A module update resets `config.json`, `state.json` and the logs.** Upgrading is destructive
  to user data by design. `customize.sh` warns about it at install time and the README says so
  in the feature table, because an unannounced data loss is a bug.
- **Uninstall leaves nothing behind.** No orphaned directory to clean up, no state outliving the
  module.
- The scripts carry a single path variable, `KR_MODDIR`, and no notion of a data dir. Fewer
  paths is fewer places to be wrong.

## Alternatives rejected

- **Module dir + data dir (the previous layout).** Survives updates, but violates the storage
  constraint: state would live somewhere other than the module directory.
- **Module dir plus an install-time copy from the previous module dir.** KernelSU keeps the old
  directory at `/data/adb/modules/kernelray` while unpacking the new one into
  `/data/adb/modules_update/`, so `customize.sh` *could* migrate user data forward and keep the
  same path constraint. Rejected: it is a hand-rolled update protocol that silently decides
  which of two copies wins, and it still loses edits made between install and reboot.
- **`ksud module config`.** Also outside the module dir, and it stores strings, not a JSON
  document with a schema.

## Notes

Because the core binary sits in the same directory, `scripts/pack.sh` must never ship user data:
it excludes `config.json`, `state.json`, `logs/` and `runtime/`.
