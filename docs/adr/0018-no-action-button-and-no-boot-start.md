# 0018 — No action button and no boot start: the core starts only when the user asks

Status: accepted (removes the two automatic paths to a running core; the boot semantics of
[ADR 0008](0008-takeover-namespace-boot-and-toggle-semantics.md) and the "every start (boot or
the status page's Start)" wording of
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md) no longer apply, and
the `action.sh` in ADR 0004's recovery path no longer ships)

## Context

Two paths started the core without the WebUI: the manager's ▶ button (`module/action.sh`) and
boot (`module/service.sh`). By v0.10 both were duplicates. The WebUI had carried start, stop,
the status poll, the failure cards and the retry for several versions, so `action.sh` was a
second implementation of the same two gestures plus a human-readable report (`kr_report`) whose
only consumer it was. `service.sh` was three lines: a `disable` check, `kr_dirs` and `kr_start`.

The duplication was not free. Anything that changed about a start had to be true in two places,
and the two had drifted in exactly the way that matters: `action.sh` explained the fail-closed
consequence of stopping under the tproxy switch ("the rules stay up, the device has no network")
and the WebUI did not. The button was also the only surface that could start the core without
opening the manager's WebUI page — the reason the docs kept it, not the reason users needed it.

Boot start was a different kind of decision: v0.7's whole promise was that a reboot comes back
under takeover. That is convenience bought with an action the user did not ask for in that
moment — and with the tproxy switch defaulting on, a freshly rebooted device is captured before
anyone has looked at it.

## Decision

**The core starts only when the user asks, and there is exactly one place to ask.**

- `module/action.sh` is deleted, and `kr_report` with it: the manager renders no ▶ for a module
  without the file, so the module card keeps its WebUI entry and nothing else.
- `module/service.sh` is deleted. Nothing starts at boot.
- The WebUI's 启动/停止 is the only manual surface; `kernelray.sh start|stop` stays as the
  terminal fallback, the same code path the buttons run, so there is one start and not two.
- The one behaviour that existed only in `action.sh` moves into the WebUI: while the tproxy
  switch is on, a stopped core means the device is going direct, and the status hint now says
  so (`stoppedHintTp`) instead of the neutral "takes effect on the next start".
- `runtime/status.json` records the boot that wrote it (`boot`, from
  `/proc/sys/kernel/random/boot_id`). With no boot hook left to rewrite the file, a status from
  an earlier boot is the normal case after a reboot, not an edge case: `kr_status_kv` reads such
  a file as `stopped/idle` — "nothing has run since boot" — instead of repeating a `failed/rules`
  or `crashed` phase the current boot never had. The comparison needs no clock, unlike the
  `started`-against-`/proc/uptime` arithmetic it replaces, which is wrong until NTP syncs.

## Consequences

- **A reboot leaves the device direct** until the user presses 启动. That is the largest
  user-visible change here, and the reason the status hint had to stop being neutral: with the
  switch on and a node applied, "stopped" now means "not proxied", not "about to be".
- **A reboot becomes the escape from fail-closed.** The rules live in netfilter, which is
  volatile: rebooting clears them, so a device left with no network by a dead core under the
  switch can be recovered without adb — a recovery path ADR 0004 did not have.
- **"Next start" now means a start the user performs.** Every "stop → start (or reboot)" in the
  README, the glossary, the installer output and the Settings hints loses the "or reboot" half:
  a reboot no longer applies the tproxy switch, it only stops the core.
- **The pin is unaffected.** `kr_apply` pins the node host while the network is still direct
  (ADR 0017), not the start, so nothing about boot was load-bearing for it. `kr_cleanup_legacy`
  now runs at the first start instead of at boot; it deletes two stale files and reads nothing.
- **The status file is no longer self-healing.** A reader must distrust a `boot` that is not the
  current one; the glossary's "status is written, never inferred by callers" now names that
  exception rather than pretending the file is always current.
- **Uninstall is unchanged.** KernelSU still runs `uninstall.sh` at removal, which stops the core
  and removes the module's own rules.
- The module ships one fewer boot script and one fewer entry point, and the installer no longer
  chmods either of them.

## Rejected alternatives

- **Keep the ▶ button as a shortcut.** It is a second implementation of two gestures that
  already exist one page away, and the drift it caused (the fail-closed warning living only
  there) is the argument against keeping it, not for it.
- **Keep boot start behind a Settings switch.** It reintroduces the boot hook, a preference and
  a UI row to preserve a behaviour this ADR removes on purpose, and the first thing it would do
  on a fresh install is capture a device nobody has configured yet.
- **Start the core when the WebUI opens.** Convenient, and wrong: opening a page is not asking
  for takeover. The 启动 button is one tap and it is an explicit one.
- **Keep a trimmed `service.sh` that only writes `stopped/idle` at boot.** A boot hook whose sole
  job is to refresh a cache. Recording the boot id in the file makes the reader honest instead,
  with no hook at all.
- **Delete `status.json` at boot to force freshness.** There is nothing left to run at boot, and
  a file that must be deleted to be correct is worse than one that says which boot wrote it.
