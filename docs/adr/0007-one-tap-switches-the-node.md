# 0007 — One tap on a node switches it

Status: accepted (amends ADR 0005's rule that the UI never applies a selection implicitly)

## Context

v0.6 exposed exactly one node: the selected one, rendered as a single card with an **Apply**
button. ADR 0005 made "selected is not applied" a UI rule — selecting only wrote `state.json`,
and Apply derived the core config and restarted a running core. That is a safe two-step, but it
was designed around a page that could only show one node.

The store has always held many nodes (`state.json`'s `manual` array plus a `selected` pointer);
only the page did not show them. Turning the Nodes tab into a list makes the two-step awkward:
in a list, "select a row, find Apply, confirm" is three actions for the one thing a proxy user
does most often, and a selection left waiting for Apply is easy to miss.

## Decision

Tapping a node row selects **and** applies it: the UI writes `state.selected`, renders the node
to `outbound.json` + `outbound.meta`, and calls `kernelray.sh apply <id>`.

`selected` is written first. A crash or a failure between the steps therefore leaves the honest
"wants B, runs A" state, never a config newer than the pointer.

The facts stay separate: `state.selected` is the wish, `runtime/applied` is what the core runs.
They are normally equal and diverge only when a switch fails. The list marks the applied row and,
after a failed switch, the selected-but-unapplied row.

Two rules keep the one tap from doing pointless work:

- tapping the applied node whose fields have not changed does nothing to the core (the pointer
  is merely re-synced if a failed switch left it elsewhere);
- tapping the applied node after a re-import changed it (`dirty`) re-applies it, because the
  running config predates the node's fields.

Switching to another node restarts a running core through the existing atomic
`xray -test` / swap / rollback path. The shell is unchanged; the UI is the selector.

## Consequences

- The Nodes page has no Apply button. `docs/state-schema.md`, the README and `GLOSSARY.md`
  describe tapping a row as the switch gesture (`切换节点`).
- A failed switch leaves `selected` on the attempted node. Tapping it again retries; tapping the
  still-applied node re-syncs the pointer without restarting the core.
- The shell still refuses an outbound whose `outbound.meta` id does not match the requested id,
  so the write order (selected → meta → outbound → CLI) remains part of the contract.
- Deleting the applied node is refused; a delete that succeeded clears `selected` when it named
  that node and removes the rendered outbound when it belonged to it.
- Subscriptions stay out of scope: the list renders `state.manual` only and preserves
  `subscriptions` untouched.

## Rejected alternatives

- **Keep the two-step Apply button.** Safer against mis-taps, but it makes the list a selection
  UI with a separate commit — the thing the list was meant to remove. The rollback path already
  covers a bad switch.
- **Apply on tap and hide the selected/applied distinction.** Then a failed switch would show a
  node as current while the core still runs the old one. The distinction stays as fact, even
  though the UI no longer creates it deliberately.
- **Delete the applied node and fall back to direct.** A mis-tap would silently change traffic
  (and, once takeover lands, expose it). Deleting the applied node is refused instead.
