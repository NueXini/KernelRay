# 0010 — The core only runs an applied node's config

Status: accepted

## Context

Until v0.7 the module had a "direct run" fallback: with no node applied, the core still
started at boot and rendered a freedom outbound into the config, listening on its local
inbounds and doing nothing. The same fallback existed in five places — the boot path, the
renderer, `kr_ensure_config`, the ports path and the swap rollback — and every one of them
could silently replace the honest "nothing applied" state with a running core that proxies
nothing.

That state has no user value: the local inbounds are useless without a node behind them, and
it makes "running" mean two opposite things (proxying and not proxying) depending on
bookkeeping the user cannot see.

## Decision

**The core never runs a config that is not derived from an applied node.** "Applied" means
self-consistent: `runtime/applied` names an id, `outbound.meta` names the same id, and
`outbound.json` is non-empty.

- **One gate, at the start.** `kr_start` refuses when no applied node exists and records
  `stopped/no-node`. Manual starts (CLI, Action button, WebUI) hit the same gate and refuse
  with a message; the WebUI disables the Start button while no node is applied.
- **No freedom fallback anywhere.** `kr_render_config` requires an outbound;
  `kr_ensure_config` refuses to build a config it cannot derive from the applied node
  (`failed/no-config`); the ports path refuses instead of re-rendering as direct; a swap
  rollback with no previous config leaves the core down rather than running a placeholder.
- **Boot with the switch on and no node stays fail-closed** (ADR 0004): the rules go in
  anyway, so the device has no network until a node is applied from the local WebUI, which
  works without one. Skipping the rules would leak direct traffic while the persisted switch
  says "take over".
- **The no-takeover form still exists.** An applied node with the switch off (空转) is
  untouched; only the freedom/no-node state is abolished.

## Consequences

- A fresh install does nothing at boot until the user taps a node. The WebUI says so
  (`stopped/no-node` and the Start button's hint), instead of a core "running" pointlessly.
- Boot with the takeover switch on and no applied node means no network until a node is
  applied. That is the price of the persisted switch; the WebUI is local and always reachable.
- Every fallback that used to clear `runtime/applied` and render direct is gone: applied
  bookkeeping is only repaired by applying a node again, never silently by the shell.
- Upgrading installs refuse to start (the update reset the node store) instead of coming up
  direct — the same visible outcome as a fresh install.

## Rejected alternatives

- **Keep the direct run as a "module is alive" signal.** A core listening on unused inbounds
  is not a signal worth a state that makes "running" ambiguous.
- **Gate on the node store instead of the applied id.** Nodes in `state.json` are intent; the
  core config is derived from the applied node (ADR 0005). A store full of nodes with none
  applied still has nothing to run.
- **Skip the TPROXY rules at boot when no node is applied.** Cheaper for the user, but it is
  fail-open: the persisted switch says "take over" and the device would go out directly —
  exactly the leak ADR 0004 exists to prevent.
