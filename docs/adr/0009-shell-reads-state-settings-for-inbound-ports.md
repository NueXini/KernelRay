# 0009 — The shell reads the inbound ports from state.json's settings

Status: accepted (narrows the "the shell does not read `state.json`" rule from
[ADR 0005](0005-core-config-is-derived.md), which itself extended [ADR 0003](0003-webui-writes-state-json.md))

## Context

The local socks/http inbounds were fixed at 10808/10809 in the config template. Making them
user-configurable puts two more fields of core intent in the UI's hands: the user's choice
must reach the shell's render, and the render is invoked from paths where the WebUI is not
involved (boot, the takeover toggle, `kr_ensure_config`).

The obvious bridge — a flat file the UI writes for the shell, mirroring `outbound.meta` —
works, but adds a second store of the same fact: state.json's `settings` would hold the
intent and the mirror file would be what the shell actually reads, and the two can drift.

## Decision

**`kr_render_config` reads the two ports directly from `state.json`'s `settings`, via a
line-level `sed` extraction of `socksPort` / `httpPort` inside the `settings` object.** The
template's ports become quoted placeholders (`"__KERNELRAY_SOCKS_PORT__"`,
`"__KERNELRAY_HTTP_PORT__"`), so the template stays valid JSON, and the shell replaces each
whole quoted string with the number.

This is a deliberate, narrow exception to the rule that the shell never parses `state.json`:

- The extraction reads exactly two flat integer keys whose shape the UI owns (the UI
  serialises `state.json` pretty-printed, every key on its own line). It is not general
  JSON parsing, and it does not grow: routing/DNS settings, when they come, will need this
  ADR revisited or a real parser.
- A missing, unparseable or out-of-range value falls back **per field** to 10808/10809,
  so a hand-pretty-printed `state.json` can never knock an inbound off its port; it can
  only reset it to the default.
- Nothing else is read from the file. The "no `jq` on the device" liability stays contained
  to two `sed` lines that `tests/config.test.js` exercises.

Saving a port goes through the same machinery as a node apply: the UI writes `state.json`
(intent first), then calls `kernelray.sh ports`, which renders the candidate with the
applied node as-is, runs `xray -test`, and swaps it in via the same
backup → stop → move → restart → rollback path. The applied id is untouched: the ports
change the local inbounds, never the outbound.

## Consequences

- The UI's write shape of `state.json` is now load-bearing for the shell, not just a
  serialisation detail: whoever changes `writeState`'s pretty-printing must keep the
  `settings` keys on their own lines.
- A collision with the tproxy inbound's port (10810) is refused in the UI, not the shell;
  a hand-edited `state.json` that claims it would pass `xray -test` and fail at start,
  which the rollback path recovers from.
- `state.json`'s `settings` object is no longer "reserved, not interpreted": `socksPort`
  and `httpPort` are interpreted; every other field stays verbatim.

## Rejected alternatives

- **A flat mirror file (e.g. `inbound.meta`) written by the UI next to `state.json`.**
  No parsing risk at all, but two stores of one fact: the shell would render from a file
  that can silently lag the intent the UI shows. The user picked one store.
- **Ship `jq`** to parse `state.json` properly. Another binary and another architecture to
  verify, for two integers.
- **Keep the ports in the template and hand-edit it.** The template is replaced on module
  update (ADR 0002), so hand edits do not survive; and ADR 0005 made `config.json` derived
  precisely to keep hand-editing out.
