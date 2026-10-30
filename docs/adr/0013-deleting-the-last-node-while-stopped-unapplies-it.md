# 0013 — Deleting the last node while the core is stopped unapplies it

Status: accepted (amends ADR 0007's "deleting the applied node is refused"; adds the `unapply`
CLI verb and the 取消应用 vocabulary; leaves ADR 0010's start gate and ADR 0011's switch
untouched)

## Context

ADR 0007 refused deleting the applied node outright: a mis-tap would otherwise silently change
which node carries traffic, and once takeover landed, expose it. That rule holds everywhere
except one case, and that case is a dead end. With a single node in the store the user cannot
empty it: the applied node is the only row, so it cannot be deleted, and the advice the UI
gives — "switch to another node first" — needs a node the user may not have.

Deleting that node is not a switch, but it is not free either. Its outbound is in
`config.json`, `runtime/applied` names it, and the start gate (ADR 0010) only asks whether
`runtime/applied` is non-empty. A delete that removed the store entry alone would therefore
leave a config the core would happily run on the next Start: credentials outliving the node
they belong to, and a node list that shows nothing while the core runs something. The takeover
rules make it worse: `kr_stop` leaves them up on purpose (fail-closed), so a stopped core with
the switch on has the device offline, and with no node left nothing can start to restore it.

## Decision

The applied node is deletable only when the core is stopped **and** it is the last node in the
list. That delete is an unapply:

- `kernelray.sh unapply` refuses while the core runs (that would be a stop — a different
  gesture with a different consequence), removes the takeover rules, removes `config.json`,
  `runtime/applied`, `outbound.json`, `outbound.meta` and the pinned node address, and writes
  `stopped`/`no-node`.
- The UI calls it before writing `state.json`, the same order the delete's existing `rm` uses:
  a failure leaves the node in the store so the delete can be retried.
- `state.json` and the tproxy switch are left alone. The module is back to the never-applied
  state: Start is disabled, the status hint asks for a node, and the switch waits for one
  (ADR 0011's next-start semantics are unchanged).

The gate is one pure rule — `deleteGate(model, running)` — shared by the row's ✕, the row's
edit-mode checkbox and the batch confirm. "Stopped" means a status read that says `stopped`; an
unreadable or not-yet-read status counts as running, so a delete can never race a core that
just started.

The unapply trigger is the resulting state, not the deleted row: a delete that empties the list
while the core is stopped unapplies even when the applied id was already dangling (it named no
row). That is the only gesture that can clear such a leftover, and the start gate would
otherwise keep running a node the store no longer has.

## Consequences

- The node list's delete affordances now depend on the runtime: the applied row's checkbox and
  ✕ follow the gate, the list's render signature carries the running fact, and the status poll
  re-renders the list when that fact flips.
- With two or more nodes the applied one still cannot be deleted; the user deletes the others
  first, and the applied row becomes the last one.
- The unapply takes the device from "rules up, core down, no network" to direct. That is the
  only sane outcome, but it is a traffic change, so the applied row's confirm text says so.
- A running core with a dangling applied id and an empty list stays as it is: unapply is
  refused while the core runs, and no row is left to trigger it. The CLI verb is the way out.
  Nothing in the UI reaches that state today — only a hand-edited `state.json`, or a future
  subscription refresh, can orphan an applied id.
- `docs/state-schema.md`, the README, `GLOSSARY.md` (取消应用, 勾选) and the CLI usage string
  change with it.

## Rejected alternatives

- **Leave the derived files behind.** `config.json` would keep the deleted node's credentials,
  and the next Start would run a node the store no longer has; the list would show nothing
  applied while the core runs something.
- **Let the delete stop a running core.** One gesture would both change which node carries
  traffic and drop the capture — and with the switch on, that Stop is itself a network outage.
- **Allow deleting any applied node while the core is stopped.** It is not a dead end (switch,
  then delete), and it would produce a store with nodes and no applied node: a state no other
  gesture creates.
- **Auto-apply another node after the delete.** A delete would silently pick what carries
  traffic, which ADR 0007 refused.
- **Keep the last node deletable while the core runs.** The unapply would have to stop the core
  first, and the "stopped" precondition is what keeps a delete from racing a live core.
