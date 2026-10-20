# 0003 — The WebUI writes `state.json`

Status: accepted

## Context

Until now the UI was strictly read-only: the shell owned every file the module touched, and the
WebUI rendered what it found. Node import breaks that. Import has to parse share links
(base64-in-JSON for `vmess`, two different `ss://` layouts, percent-encoded credentials) and
merge the result into a JSON document — and the device has no `jq`, while doing URI parsing in
`awk`/`sed` would be a liability we would carry forever.

So there is a real fork: parse in the shell and keep the UI read-only, or let the UI write.

## Decision

The UI parses and writes `state.json`. The split is now:

| Writer | File | Kind |
| --- | --- | --- |
| shell | `runtime/status.json`, `runtime/xray.pid`, `config.json`, `logs/` | runtime facts, derived |
| WebUI | `state.json` | user intent |

Rules that keep this honest:

- **One writer per file.** The shell never writes `state.json`; the UI never writes
  `status.json`. No lock is needed because there is nothing to race on.
- **Writes are atomic.** The JSON is base64'd into `state.json.tmp`, `chmod 600`'d, then
  `mv`'d over `state.json`. A kill mid-write cannot leave a truncated node store, and the
  credentials in it are never world-readable even for an instant.
- **The UI mutates what it read.** It parses the existing file, merges into that object and
  serialises it back, so fields it does not understand survive a write from an older build.
- **The parser is tested against the shipped file.** `tests/parse.test.js` extracts the marked
  block out of `module/webroot/app.js` and runs it; there is no second copy of the parser
  to drift. This is why the WebUI can stay hand-written HTML/CSS/JS with no build step.

## Consequences

- The schema needs a written authority, otherwise "what the UI writes" is only knowable by
  reading JS: see `docs/state-schema.md`.
- Import can only be as good as the page's JS runtime. That is acceptable — the alternative was
  writing a URI/JSON parser in shell for a device that has neither `jq` nor `python`.
- Applying a node (turning `state.json` into `config.json` and restarting the core) stays shell
  work: it is a derived artifact, and the UI must not pretend the core changed.
