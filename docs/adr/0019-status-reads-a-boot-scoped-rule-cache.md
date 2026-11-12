# 0019 — The status poll reads a boot-scoped rule cache; the start path asks the kernel

Status: accepted (the one detail it names that changed: `kr_tp_form` no longer exists, so
`kr_tp_rules_present`'s callers are the start path and `kr_conf_accept_ondisk` only — see
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md))

## Context

The WebUI polls `kernelray.sh status` every 2 s while the page is visible. `kr_status_kv`
answered "are the takeover rules installed?" with `kr_tp_rules_present`, which runs
`iptables -t mangle -nL KR_TP_OUTPUT` and `ip6tables -t mangle -nL KR_TP_OUTPUT`. The same
function also read the pid, applied id, start time, version, log level and both inbound ports
through a dozen `cat`/`sed`/`head` calls. A stopped-core poll was roughly 15–20 external
processes, two of them `iptables`; a running-core poll added the pid and start-time reads.
None of those facts changes between two polls unless the user acts.

The rules themselves change only at three moments: `kr_tp_install` (a start with the switch
on), `kr_tp_remove` (a start with the switch off, `unapply`, or a failed install), and an
external actor (another module, a manual `iptables -F`). The status value is **advisory**: it
feeds the status badge and the takeover hint. The safety-critical readers — `kr_tp_form`,
`kr_conf_accept_ondisk` and the start path — must keep asking the kernel, because a config
whose form disagrees with the live rules loses routing or blackholes traffic
([ADR 0008](0008-takeover-namespace-boot-and-toggle-semantics.md),
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)).

## Decision

**`runtime/rules` is a read-through cache of the last real kernel answer, not a second source
of truth.**

- The file carries `boot=<boot_id>` and `present=<0|1>`. The boot id is the one
  `/proc/sys/kernel/random/boot_id` mints per boot, already used by `runtime/status.json`
  ([ADR 0018](0018-no-action-button-and-no-boot-start.md)). No clock is involved.
- `kr_tp_install` writes `present=1`, including the "rules already present" early return;
  `kr_tp_remove` writes `present=0`. Both write the current boot id. A start with the switch
  off that finds no rules writes `present=0` as well, so a cache left stale by an external
  flush is repaired by the same start that already asked the kernel.
- `kr_status_kv` reads the cache. A usable cache (file present, boot id matches, value `0|1`)
  answers without touching iptables. A missing or stale cache is answered by one real
  `kr_tp_rules_present` and normally written back (the write is skipped if another writer
  changed the cache while the kernel was being asked). That is the same shape as the version
  cache: `kr_version_cached` already refreshes `runtime/version` on a miss.
- The cache is boot-scoped because netfilter is volatile: after a reboot the old boot id no
  longer matches, so the first poll checks the kernel again instead of trusting a file from a
  boot whose rules are gone. `runtime/` is also wiped by a module update
  ([ADR 0002](0002-everything-lives-in-the-module-dir.md)), so a miss after an update is a
  normal path, not an error.
- `kr_tp_rules_present` stays the authoritative check and is still called by `kr_tp_form`,
  `kr_conf_accept_ondisk`, `kr_tp_install` and the `tproxy status` CLI. The cache is never
  read by them.
- The status output keeps `rules=present|absent`; the UI does not learn about the cache.
- The cache is `0600` (it carries only a boot id and a flag, but it lives beside the other
  runtime state and `kr_dirs` tightens it with them).

**The status path also stops forking for facts it already has.**

- `kr_pid`, `kr_applied_id`, `kr_loglevel_get` and the version cache gained variable-setting
  readers (`kr_pid_read`, `kr_applied_read`, `kr_loglevel_read`, `kr_version_read`), and
  `kr_boot_id` now uses `read` instead of `sed`, so the status poll reads instead of forking a
  `cat`/`sed` per field. The echo-style functions stay for the other callers and for the tests
  that override them.
- `kr_status_kv` reads `runtime/status.json` once (one `awk`) instead of one `sed` per field.
- `kr_settings_ports` parses both inbound ports in one `awk`; `kr_setting_port` remains the
  one-field interface for the other callers. The render uses the combined reader too.

## Consequences

- **Steady state: zero iptables and roughly ten forks per poll** (four applets — `tr` and
  three `awk`s — plus the command substitutions around them), down from roughly thirty with
  two iptables. The 2 s poll stops being a measurable background cost.
- **After a boot, a module update, or a cache write failure, the first poll pays one real
  check** (one `iptables` if the IPv4 chain is missing, two if both families answer). That is
  the old behaviour for one tick, not for every tick.
- **An external flush is invisible until the next install/remove/start.** If another actor
  deletes the chains, the cache still says `present=1` and the UI keeps its "takeover is on"
  hint. The start path is unaffected: it asks the kernel and repairs the cache. This is the
  accepted cost of an advisory status; a manual-refresh check can close the window later
  without putting iptables back into the 2 s loop.
- **No boot id means the old behaviour.** On a kernel without
  `/proc/sys/kernel/random/boot_id`, the cache cannot be validated, so every poll falls back
  to the kernel check. Android exposes it; the fallback exists for completeness.
- **Fail-closed is unchanged.** The rules, their install order and the config form are still
  decided by the kernel check at start time. The cache only decides what the status card says.

## Alternatives

- **Keep the iptables pair in the poll.** Correct, but it is the dominant cost of a 2 s loop
  and asks a question whose answer cannot change between user actions.
- **Drop `rules=` from status.** The UI loses the difference between "running with takeover"
  and "running idle" — exactly the distinction the status hint exists for.
- **Presence-only marker.** A marker that only exists while the rules do cannot cache the
  "absent" answer: every poll with the switch off would miss and check. `present=0` is needed.
- **TTL instead of a boot id.** A TTL needs the wall clock, which is wrong until NTP syncs and
  can jump; the boot id is the signal the module already trusts for `status.json`
  ([ADR 0018](0018-no-action-button-and-no-boot-start.md)).
- **Let `kr_tp_form` read the cache too.** That would make an advisory file load-bearing for
  routing: a stale `present=1` with the rules gone is a blackhole. The safety-critical readers
  keep the kernel.
