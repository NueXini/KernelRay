# 0012 — An import into a store with no applied node applies a node

Status: accepted (amends the import rule stated in `docs/state-schema.md`, `GLOSSARY.md` and
`docs/config-derivation.md`; leaves ADR 0007's selected/applied distinction untouched)

## Context

Every documented rule said an import only fills the node store: ADR 0007 made the tapped row the
switch gesture, `docs/state-schema.md` said import "never changes `selected`", and `GLOSSARY.md`
said importing never switches or applies. On a fresh install that leaves the user with a filled
list, no applied node and a dead core until they work out that a row must be tapped — even though
the first import is precisely the moment they intend to use the node they just pasted.

## Decision

If `runtime/applied` is absent or empty after a successful merge, the import also switches a node
through the same `switchTo` path a tapped row uses, so `selected`, `outbound.json` /
`outbound.meta` and `kernelray.sh apply <id>` happen in the documented order. The node it switches
is `selected` when that pointer still resolves to a node the list can show (a failed switch left
it there), else the first such node in `state.manual` order. With a node already applied, an
import still changes nothing but the store.

The rule belongs to the import path, not to the store: deleting the selected node still clears
`selected` without re-selecting anything.

## Consequences

- Applying never starts a stopped core (`kr_swap_config` only restarts one that was already
  running), so a first import writes `config.json` + `runtime/applied` and leaves the core down:
  the user still presses Start. With the tproxy switch on, that Start is the takeover start.
- A failed auto-apply leaves the ordinary failed-switch state (selected, not applied, row marked
  as such); the pointer is not rolled back, and tapping the row retries.
- The trigger is the applied node the page currently shows, so a transiently unreadable
  `runtime/applied` can make the UI apply over a running core's node. Accepted: `apply` is
  transactional (test the candidate → swap → roll back on failure), and the alternative — a
  second status read as a guard — buys little for the added branch.
- Partial imports behave the same: the merge happened, so the switch happens even while the
  dialog stays open over the failed lines.

## Rejected alternatives

- **Select without applying.** The store would point at a node the core never derived a config
  from, and the user would still have to tap.
- **Collapse `selected` into `runtime/applied`.** ADR 0007 keeps them separate so a failed switch
  can be shown as "wants B, runs A"; the import gesture does not need to change that.
- **Apply on every import, or re-point a dangling `selected`.** That would let a paste change
  which node carries traffic after the user had already chosen one.
