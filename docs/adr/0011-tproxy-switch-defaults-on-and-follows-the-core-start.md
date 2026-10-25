# 0011 — The tproxy switch defaults to on, lives in Settings and couples to the core's start

Status: accepted (supersedes parts of
[ADR 0004](0004-tproxy-takeover-is-module-owned-and-fail-closed.md) and
[ADR 0008](0008-takeover-namespace-boot-and-toggle-semantics.md) listed below)

## Context

The takeover switch lived on the status page, defaulted to off, and `tproxy on|off`
immediately installed or removed the rules and restarted the core. The user wants the
control in Settings under the title tproxy透明代理, on from the moment the module is
installed, and — decisively — a settings change must never interrupt a running core.

## Decision

- **The switch is a pure preference.** `kernelray.sh tproxy on|off` only writes or removes
  `runtime/tproxy`; it never touches the core or the rules. It takes effect at the next
  core start: on, every start (boot or the status page's Start) installs the rules and
  swaps in the takeover config before the core runs (the fail-closed ordering of ADR 0004
  is unchanged); off, any stale rules come down and the start is an idle run.
- **On from install.** The installer creates the switch file, and every module update
  recreates it (ADR 0002: the module dir is replaced wholesale). This deliberately reverses
  ADR 0004's default-off decision and its "auto-enable after upgrade" rejection: the
  default is safe because a switch without an applied node has no effect, and applying a
  node is always an explicit user gesture.
- **No node, no rules.** A start without an applied node never installs the rules, even
  with the switch on. This supersedes ADR 0008's boot-time rule install for the nodeless
  case: with the switch defaulting on, that path would take a freshly installed device's
  traffic hostage until a node was applied, which reads as "the module broke my phone".
  The start gate (ADR 0010) already keeps the core down; the rules wait with it.
- **The switch is never silently rewritten.** A conflict (`failed/conflict`), a rule
  install failure (`failed/rules`) or a takeover config that fails to test leaves the
  switch as the user set it; the failure is reported and the core starts idle. ADR 0008's
  "rollback clears the switch" is gone with the immediate toggle.
- **UI.** The switch moves to the Settings page (below language, above log buffer) titled
  「tproxy透明代理」; the status page keeps only the failure hints and a retry that runs the
  same start. The glossary renames 接管开关 to tproxy透明代理开关.

## Consequences

- Applying a node or changing ports while the switch is on brings takeover up with the
  restart those gestures already perform — no second tap.
- A running idle core becomes a takeover core only via stop → start (or reboot): the
  Start button is disabled while running, and the settings hint says the change lands at
  the next start.
- Recovery from the fail-closed "dead core, rules up" state is: start the core again, or
  switch off (a preference write) and start — a start with the switch off removes the
  rules. `kernelray.sh tproxy off` alone no longer restores the network; it never touches
  the rules.
- The bypass routing table's copy of the default route is rebuilt by any restart while
  the switch is on (it used to be "toggle the switch").
