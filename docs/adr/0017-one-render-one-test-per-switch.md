# 0017 — One render and one test per switch

Status: accepted

## Context

v0.9 turned a node switch into three config loads of the same bytes. `kr_apply` rendered a
candidate and tested it; `kr_start_locked` then engaged takeover, which re-rendered and
re-tested the config (`kr_tp_swap_config`); and the start tested the same file once more before
forking. Measured on the emulator, a switch from a running core was 3.21 s, of which ~0.2 s was
`xray -test` and the rest was script overhead that grew with the process count.

The duplication was not one function called twice — it was six places that each did a slightly
different subset of "render, test, swap":

| Caller | Renders | Tests | Swaps |
| --- | --- | --- | --- |
| `kr_apply` | yes | yes | yes |
| `kr_apply_ports` | yes | yes | yes |
| `kr_route_set` | yes | yes | yes |
| `kr_tp_engage` | yes | yes | yes |
| `kr_ensure_config` | yes | **no** | yes |
| `kr_start_locked` (drift repair) | yes | yes | yes |

They had already drifted: `kr_ensure_config` moved an untested config into place and relied on
the start to test it afterwards. The start's "drift detector" decided which form the on-disk
config had by grepping the rendered JSON for `"tag":"tp-in"` and `geosite:cn`, and the log level
by a third grep — JSON read back with text tools, which ADR 0003 rejected for the node store.

The pin (`kr_tp_pin_node`) sat inside `kr_tp_engage`, i.e. *after* the core had been stopped and
*while* the rules were still up: the DoH query went into a capture that led to a dead core, so
it timed out (`--max-time 4`) and the pin was lost — on every switch with takeover on.

## Decision

**One module decides what config.json should be, and it is idempotent.**

- `kr_render_config` is a pure function of the template, the outbound and an explicit
  `KR_TAKEOVER=0|1`. It no longer reads the live rules to guess the form.
- `kr_config_form` is the single place that answers "which form do these rules need":
  takeover while the switch says so *and* the rules are up. It is read by
  `kr_config_candidate`, never by the renderer.
- `kr_config_candidate <applied-id> [route]` renders the config this start would run, compares
  it byte for byte with `config.json`, and **tests only when the bytes differ**. It hands back
  either a tested candidate (`KR_CANDIDATE`) or nothing at all. Nothing is touched before the
  test passes (ADR 0007's promise), and "nothing at all" is a first-class answer: no test, no
  write, no restart.
- `kr_ensure_config` is `kr_config_candidate` plus the install: the start's whole config step.
- `kr_apply`, `kr_apply_ports` and `kr_route_set` are "candidate + install + start". Saving the
  ports that are already rendered, re-applying the applied node, or setting the 分流模式 it
  already has now costs one render and one `cmp`, and restarts nothing.
- **A start does not test.** `kr_ensure_config` guarantees that `config.json` is the bytes that
  passed `-test`, so the start forks on them directly. The three tests of a switch become one.

**The test result travels with the bytes.** `runtime/config.tested` is a copy of the exact file
that passed `xray -test`; a config whose bytes match it needs no second test. This rests on two
facts, both checked:

- the render is a pure function of the intent (template, outbound, ports, preferences, pin,
  form) — the reason the form had to become an input;
- `xray -test` does not bind the inbound ports, so it is a pure function of the config file and
  the geo data. (Measured: `-test` succeeds while a core holds the same ports.)

`runtime/config.form` records the form those bytes were rendered in. It is the one derived fact
the config cannot be asked about without re-rendering it, and it is needed by exactly one
reader: the start that finds `outbound.json` describing another node (see below). It is written
by the one place that installs a config, not grepped back out of the JSON.

**The pin happens before the render, once per invocation.** `kr_apply` pins the node host while
the old node still works, then renders. `kr_tp_pin_node` is memoized per process, so the start
that follows does not resolve again. At boot the pin still happens inside engage — before the
rules go up, which is the same requirement (a working network).

**Engage owns the rules, not the config.** `kr_tp_engage` keeps its conflict check, its pin and
its install; the config form follows from whether the rules ended up installed. On a conflict or
a failed install the rules are down, `kr_config_form` answers "idle", and `kr_ensure_config`
renders that — which is what the two `kr_tp_swap_config` calls used to do by hand.

**The rollback restores the intent, then the config.** Because a start re-derives the config
from the current intent, rolling back the bytes alone is not enough: a routing switch whose
start failed would be re-rendered from the *new* mode by the rollback's own start. So the swap
is split into `kr_swap_install` (back up, stop, install, record), `kr_swap_start` (start) and
`kr_swap_rollback` (restore, start again), and `kr_route_set` restores the preference between
install and rollback. `kr_swap_config` is the composition for callers with no intent of their
own (apply, ports, ensure).

**A failed switch keeps running the applied node.** After a failed switch `outbound.json` and
`outbound.meta` describe the node the user *tried*, while `runtime/applied` and the restored
config describe the node that runs (ADR 0007's "wants B, runs A"). Nothing can be re-rendered
from that outbound, so the start takes the config on disk as it is — through the same test gate,
which only bites when the bytes are unknown — but only while its recorded form still agrees with
the live rules. Anything else refuses with "re-tap the node in the WebUI": running a marked
outbound with no ip rule loses routing, and an idle config under installed rules blackholes
traffic (ADR 0008, 0011). Before this ADR the drift detector would have silently rendered the
*tried* node's outbound into the config while `runtime/applied` still named the old node.

## Consequences

Measured on the emulator (tproxy on, 192 processes, native core):

| Gesture | before | after |
| --- | --- | --- |
| switch to another node (core running) | 3.21 s | **1.06 s** |
| re-apply the same node | 3.21 s | **0.28 s** |
| save the ports already rendered | 3.21 s | **0.23 s** |
| `xray -test` calls per switch | 3 | **1** |

- The start's drift block, the two `kr_tp_swap_config` calls and the `kr_ensure_config`
  special case are gone; the renderer is a pure function and the form is decided once.
- A config that the core rejects now fails at the *install* gesture (apply, ports, routing) or
  at the start's ensure — never after the running core has been stopped.
- The rollback's start re-renders from the restored intent, so `config.json.prev` is a
  convenience (it keeps the bytes identical, so the marker makes the re-render free), not the
  source of truth.
- `runtime/config.tested` and `runtime/config.form` contain the same secrets as `config.json`
  and get the same `0600`; `unapply` and the failed-start cleanup remove them, and `pack.sh`
  already excludes `runtime/`.
- A hand-written `config.json` is still not supported (ADR 0005), but it is now *tested* before
  it is trusted: unknown bytes are tested once and then marked.

## Rejected alternatives

- **Keep the drift detector and only skip the duplicate tests.** Cheaper, but it keeps three
  copies of "what form is this config" — a grep of the rendered JSON, `kr_tp_engage`'s forced
  render, and the start's test — and the two of them already disagreed.
- **Skip `xray -test` entirely on the switch.** The test is what makes "a bad node never stops
  the running core" true (ADR 0007); one test per switch is the price.
- **Hot-swap through the core's API instead of restarting.** The shipped build has
  `xray api ado/rmo/adrules/rmrules`, so a switch *could* add an outbound and re-point a routing
  rule without a restart. It would make `config.json` "what the core would run on restart"
  rather than what it runs, lose the `-test` gate at switch time, and add a local API port any
  app on the device can call. Not worth it for a 0.5 s traffic gap; it would need its own ADR.
- **Roll back the config without the intent.** Simpler, but the rollback's own start re-renders
  from the preference, so a failed 分流模式 switch would install the failing mode again.
- **Accept any on-disk config after a failed switch.** The form would then be unverifiable, and
  the two documented recovery paths ("switch off and start again", "turn takeover on") could
  leave the device with no working routing.
