# 0011 — 启动即接管: every core start takes over, and there is no switch

Status: accepted. Supersedes [ADR 0004](0004-tproxy-takeover-is-module-owned-and-fail-closed.md)'s
opt-in decision and the switch that
[ADR 0008](0008-takeover-namespace-boot-and-toggle-semantics.md) gave toggle semantics, and it
replaces this ADR's own first form (a default-on preference in Settings) wholesale: the switch
is gone. The ordering it records is amended by
[ADR 0017](0017-one-render-one-test-per-switch.md), which no longer describes the start path.
"Every start" still means a start the user asks for — nothing starts at boot, see
[ADR 0018](0018-no-action-button-and-no-boot-start.md).

*The file name is the old decision's name, kept so every link to it still resolves; it is a
historical artefact, not a description of the decision below.*

## Context

ADR 0011 first shipped a switch: a persisted preference in Settings, on from install, that
decided whether the next core start installed the TPROXY rules and ran the takeover config. It
was "start-coupled" — flipping it never touched a running core — but it was still a mode, and
that mode was the source of everything awkward about the feature:

- Two config forms existed. The renderer had to be told which one to build, so
  `runtime/config.form` recorded the form the bytes on disk were rendered in, `kr_tp_form`
  decided the form from the switch *and* the live rules, and `kr_conf_accept_ondisk` refused a
  config whose recorded form disagreed. Three places encoded one question.
- The switch had a second, unintended meaning: it was the only way out of the fail-closed
  "rules up, core dead, no network" state. Recovery advice was "switch it off and start again",
  which meant the switch doubled as an emergency stop for the whole feature.
- An off switch produced 空转 — a core that proxies nothing for the device. The glossary had a
  word for it, the UI had hints for it, and it was a mode nobody actually wanted: a user who
  wants only the local socks/http inbounds is not using this module's reason to exist.

The user's decision is that takeover is not optional. The core exists on this device to carry
device traffic; a start that does not take over is a start that does nothing.

## Decision

**启动即接管 — every core start takes over, unconditionally.**

- **No preference, no file, no command.** `runtime/tproxy` is gone; `kr_tp_switch_on`,
  `kr_tp_default_on`, `kr_tproxy_set` and `kr_tp_form` are gone; `kernelray.sh tproxy` accepts
  only `status`, and `status` reports the rules, not a preference. `status.json` and the
  `status` key/value output no longer carry a `tproxy` field. A leftover `runtime/tproxy` from
  an older version is deleted by `kr_cleanup_legacy`, never read.
- **No core without takeover.** The start has two takeover halves and the config sits between
  them:
  1. `kr_tp_prepare` — the conflict check and the node pin, while the network is still direct.
     The pin's DoH ask must not enter a capture that leads into a core that is not up, and the
     render needs its answer (the DNS module's hosts entry).
  2. `kr_ensure_config` — render the one form, then `xray -test` it.
  3. `kr_tp_engage` — install the rules, still before the core runs (fail-closed, ADR 0004).

  Any half that fails refuses the start: `failed/conflict`, `failed/rules`,
  `failed/config-invalid` or `failed/no-config`, with the core down and the device direct. The
  WebUI's Retry runs the same start again.
- **Test before rules, not after.** The rules go in only once `xray -test` accepted the config.
  A config the core rejects therefore leaves the device direct instead of offline — the failure
  direction the old order got wrong, where a rule install that succeeded and a test that failed
  produced a capture into a core that never started. Fail-closed is unchanged where it belongs:
  the rules are still installed before the core runs, and a core that dies afterwards leaves
  them up.
- **One form.** The renderer always splices the tproxy inbound, the `dns-out` outbound, the DNS
  module, the routing block and the bypass mark. `KR_TAKEOVER`, `kr_config_form`,
  `runtime/config.form`, `config.form.prev` and `KR_CANDIDATE_FORM` are gone with the second
  form; `kr_tp_install`'s existing "rules already present" check and the status poll's
  `rules=present|absent` are the only remaining readers of rule presence.
- **Every restart is a start.** `apply`, `ports` and `routing` restart a running core through
  `kr_swap_*`, which does not re-run `kr_tp_prepare`; the start it triggers does. A swap whose
  start does not come back removes the rules it brought up, so a failed swap cannot leave a
  device with no core and a live capture.
- **No replacement mode.** A user who wants only the local socks/http inbounds has no mode for
  it. That is deliberate: the module is a transparent proxy. An update from a version where the
  switch was off takes the device over at the next start, and the release notes say so.
- **UI.** The Settings row titled 「tproxy透明代理」 is removed. The status page keeps the
  failure card and its Retry; the `runningHint` ("the core does not intercept system traffic
  yet") is unreachable and deleted, and the conflict/rule messages now say the core did not
  start rather than telling the user to switch something off.
- **Vocabulary.** `空转` is deleted from `GLOSSARY.md`: no state it names can exist.
  `接管` says every start is a takeover, and `核心配置` says there is one form.

## Consequences

- Recovery from "rules up, core dead" is: start the core again, `kernelray.sh unapply`, a
  reboot (netfilter does not survive one), or an uninstall. The switch's emergency-stop role is
  gone; `unapply` is the gesture that both forgets the node and takes the capture down.
- A device with another VPN active cannot run this module at all — not even for its local
  socks/http inbounds. `failed/conflict` is the honest report of that, and the user resolves the
  conflict or uninstalls.
- `docs/config-derivation.md` loses its "Start and the switch" section and its two-form matrix;
  the derivation is one render path.
- Historical ADRs that describe the switch (0004, 0008, 0013, 0015, 0017, 0019) keep their text
  and gain a status note pointing here. Their narrative is the record of how the feature got
  here; rewriting it would lose why the switch looked like a good idea.
- The glossary's `空转` entry had back-references from `接管` and `全局`; those are cleaned up.
  The word survives in old logs and issues only, like `直连运行`.

## Rejected alternatives

- **Keep the switch but make it default-on and immutable.** A preference with one legal value is
  a file, a command, a status field and a UI control that exist to say nothing.
- **Bind the rules to the core's lifetime (tear them down on Stop).** It sounds like a stronger
  binding than "start-coupled", but nothing tears them down when the core *crashes*, so the
  equivalence would still not hold — and it would reintroduce a gesture that switches takeover
  off, which is the thing being removed.
- **Fall back to an idle run when takeover cannot be enforced.** That is the old behaviour, and
  it makes "the core is running" mean two different things. It also keeps the second config form
  alive.
- **Keep a hidden `tproxy off` for scripts.** It is the same switch with a smaller surface, and
  the first thing an emergency would reach for.
- **Install the rules before testing the config.** Then a rejected config leaves a live capture
  and no core — the device offline, which is strictly worse than direct.
