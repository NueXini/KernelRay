# 0015 — The 日志等级 is a shell preference applied at the next core start

Status: accepted

## Context

The core's log level (`log.loglevel`) was fixed at `warning` in the config template, and the
General card in Settings held only WebView preferences (theme, language, log buffer). The
user wants a 日志等级 selector there. Unlike those three, the level is part of `config.json`:
Xray reads it when the core starts, so the WebView's localStorage cannot hold it — the shell
must be able to read it on every render (apply, ports, routing, boot).

## Decision

- **Five Xray levels**: 关闭 (`none`), 错误, 警告 (the default), 信息, 调试. The preference is
  `runtime/loglevel`; absence, an unreadable file and an unknown value all mean 警告.
  `kernelray.sh loglevel <level>` writes it (writing 警告 removes the file), and `loglevel
  status` reports the level, the level `config.json` carries and whether it is pending.
- **It is a next-start preference**, like the tproxy switch and unlike the immediate
  ports/routing: the command only writes the file and never touches `config.json` or a
  running core. `kr_start_locked` compares the preference with the level in `config.json`
  and, when they differ, re-renders and `-test`s the config before the core runs — so the
  next Start or reboot applies it. An apply, a ports save or a routing switch also carries
  it, because every render reads the preference.
- **The template owns the placeholder.** `config.example.json` carries `"loglevel":
  "__KERNELRAY_LOGLEVEL__"`; the renderer replaces it with the validated preference and
  refuses a template without it, exactly like the inbound ports (ADR 0009).
- **The UI reads the shell, not localStorage.** `status` gains `loglevel=` and
  `loglevelpending=`; the select follows the preference. While a running core still carries
  the old level, the row shows "已保存；停止再启动核心后生效。"; a stopped core needs no
  hint, because its next Start applies the saved level.
- **Nothing else moves.** `log.access` stays `none`, `log.dnsLog` stays `false`, and the
  module's own log (`logs/kernelray.log`) has no levels and is unaffected.

## Consequences

- A level change is the one Settings preference that waits for a start. That is deliberate:
  changing verbosity is diagnostic, and silently restarting a running core (dropping every
  connection, and under takeover briefly failing closed) is worse than waiting.
- A running core needs stop → start, the tproxy switch's gesture; a stopped core with an
  applied node gets the level on the next Start; a reboot applies it too.
- A module update resets the level to 警告 with the rest of `runtime/` (ADR 0002).
- 调试 writes a lot and nothing rotates `xray.log` in this version. The README says so; a
  rotation or size cap is a separate feature, not part of this knob.

## Considered options

- **Apply at once (render + test + restart), the ports/routing pattern** — no waiting, but a
  diagnostic knob would drop every connection. Rejected in favour of the tproxy switch's
  promise: a preference that changes the config waits for the next start.
- **Xray's `api restartlogger` hot reload** — needs an `api` inbound and its services in the
  generated config: a new local listener and attack surface, plus a second code path for the
  stopped-core case. Not worth it for log verbosity.
- **`state.json`'s `settings`** — the shell can read it (ADR 0009), but that exception is
  explicitly two integers, and the shell would then write a string field into the UI's file
  (or the UI would own a config change). `runtime/` is where the shell's preferences already
  live (ADR 0011, 0014).
- **localStorage only** — the WebView cannot reach `config.json`, so the level would never
  change; rejected.
- **Turning on `dnsLog` or the access log with 调试** — different switches with different
  privacy and volume costs; one select controls one thing.
