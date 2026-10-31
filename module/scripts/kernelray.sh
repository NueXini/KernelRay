# shellcheck shell=ash
# KernelRay shared helpers. Sourced by customize.sh / service.sh / action.sh / uninstall.sh.
#
# Layout contract:
#   everything lives in the module dir (/data/adb/modules/kernelray): mechanism, core,
#   user config, node store, logs and runtime state. Nothing is written outside it, so
#   uninstalling the module leaves no residue — and a module update replaces the whole
#   directory, which resets config/state (see docs/adr/0002).
#
# Override KR_MODDIR during install: customize.sh sets it to $MODPATH.

KR_ID=kernelray
KR_MODDIR=${KR_MODDIR:-/data/adb/modules/kernelray}
KR_CONF=$KR_MODDIR/config.json
KR_LOGDIR=$KR_MODDIR/logs
KR_RUNDIR=$KR_MODDIR/runtime
KR_LOG=$KR_LOGDIR/xray.log
KR_PIDFILE=$KR_RUNDIR/xray.pid
KR_STARTED=$KR_RUNDIR/started
KR_STATUS=$KR_RUNDIR/status.json
KR_VERFILE=$KR_RUNDIR/version
KR_TMPL=$KR_MODDIR/config.example.json
KR_STATE=$KR_MODDIR/state.json
KR_OUTBOUND=$KR_MODDIR/outbound.json
KR_OUTBOUND_META=$KR_MODDIR/outbound.meta
KR_APPLIED=$KR_RUNDIR/applied
KR_LOGLEVEL=$KR_RUNDIR/loglevel

# Geo data (docs/adr/0014): geosite.dat and geoip.dat ship inside the module ZIP, and the core
# finds them only because we say so -- Xray's own fallback search starts at the process cwd,
# which is not ours. Exported once, so every `xray -test` and `xray run` inherits it.
KR_GEODATA=$KR_MODDIR/geodata
XRAY_LOCATION_ASSET=$KR_GEODATA
export XRAY_LOCATION_ASSET

# Takeover support (v0.7). Sourced so every entry point -- CLI, service, action,
# uninstall -- sees the same switch and rule helpers. Missing file (an older layout)
# only disables the takeover functions; the rest of the module keeps working.
# shellcheck disable=SC1090,SC1091
[ -f "$KR_MODDIR/scripts/tproxy.sh" ] && . "$KR_MODDIR/scripts/tproxy.sh"

kr_now() { date +%s; }

# The console line goes to the caller (KernelSU log, CLI); the same line lands in the
# module's own log, which is the one the WebUI's takeover card reads from. A missing
# log dir (before kr_dirs) is tolerated silently.
kr_log() {
  printf '%s kernelray[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*"
  kr_log_file "$@"
}

# The module log without the console copy: for lines written from inside a render, whose
# stdout is the config itself.
kr_log_file() {
  # A log line creates its own directory: the first line can be written by a render, before
  # any entry point called kr_dirs.
  [ -d "$KR_LOGDIR" ] || mkdir -p "$KR_LOGDIR" 2>/dev/null
  # 2>/dev/null first: a missing log dir (before kr_dirs) must not print redirection errors.
  printf '%s kernelray[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*" 2>/dev/null \
    >>"$KR_LOGDIR/kernelray.log"
}

kr_dirs() {
  mkdir -p "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  # The module dir itself keeps its installed mode; only our own subdirs are tightened.
  chmod 700 "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  chmod 600 "$KR_CONF" "$KR_MODDIR/state.json" \
    "$KR_OUTBOUND" "$KR_OUTBOUND_META" "$KR_APPLIED" "$KR_LOGLEVEL" 2>/dev/null
  [ -n "${KR_TP_SWITCH:-}" ] && chmod 600 "$KR_TP_SWITCH" 2>/dev/null
  [ -n "${KR_ROUTE:-}" ] && chmod 600 "$KR_ROUTE" 2>/dev/null
}

# There is exactly one core: bin/xray. A core is usable only if it executes here.
# Neither $ARCH nor `uname -m` can be trusted (emulators report a foreign kernel
# arch), so usability is decided by running the binary, never by its name.
kr_core() { echo "$KR_MODDIR/bin/xray"; }

kr_core_works() {
  _bin=$(kr_core)
  [ -x "$_bin" ] || return 1
  "$_bin" -version >/dev/null 2>&1
}

kr_core_version() {
  timeout 15 "$(kr_core)" -version 2>/dev/null | head -1
}

# The version string is cached: running `xray -version` costs a process (and under
# ARM translation a few hundred ms), which is too much for a 2s WebUI poll.
kr_version_refresh() {
  _v=$(kr_core_version)
  if [ -n "$_v" ]; then
    kr_dirs
    printf '%s\n' "$_v" >"$KR_VERFILE" 2>/dev/null
  fi
}

kr_version_cached() {
  if [ -s "$KR_VERFILE" ]; then
    cat "$KR_VERFILE"
    return 0
  fi
  kr_version_refresh
  [ -s "$KR_VERFILE" ] && cat "$KR_VERFILE"
}

kr_pid() {
  [ -s "$KR_PIDFILE" ] || return 1
  _p=$(cat "$KR_PIDFILE" 2>/dev/null)
  case "$_p" in '' | *[!0-9]*) return 1 ;; esac
  echo "$_p"
}

# True only if the recorded pid is alive *and* is our core (guards against pid reuse).
kr_running() {
  _p=$(kr_pid) || return 1
  kill -0 "$_p" 2>/dev/null || return 1
  case "$(cat /proc/"$_p"/cmdline 2>/dev/null | tr '\0' ' ')" in
    *xray*) return 0 ;;
  esac
  return 1
}

# Every pid currently running the core with our config, including instances we do
# not track. KernelSU may invoke service.sh more than once per boot, and a core
# started twice binds the same ports twice (Go sets SO_REUSEPORT).
kr_core_pids() {
  for _d in /proc/[0-9]*; do
    case "$(cat "$_d/cmdline" 2>/dev/null | tr '\0' ' ')" in
      *xray*run*-c*"$KR_CONF"*) echo "${_d#/proc/}" ;;
    esac
  done
}

kr_kill_strays() { # <pid to keep, may be empty>
  for _p in $(kr_core_pids); do
    [ -n "$1" ] && [ "$_p" = "$1" ] && continue
    kr_log "killing stray core pid $_p"
    kill "$_p" 2>/dev/null
  done
}

# Serialise concurrent starts. mkdir is atomic; a lock older than ~10s is stale.
kr_lock() {
  _i=0
  while ! mkdir "$KR_RUNDIR/start.lock" 2>/dev/null; do
    _i=$((_i + 1))
    if [ "$_i" -eq 50 ]; then
      kr_log "start lock stuck, clearing it"
      rm -rf "$KR_RUNDIR/start.lock"
    fi
    [ "$_i" -ge 60 ] && return 1
    sleep 0.2
  done
  trap 'rmdir "$KR_RUNDIR/start.lock" 2>/dev/null' EXIT
  return 0
}

kr_cleanup_legacy() {
  # leftovers from earlier layouts; nothing reads them anymore
  rm -f "$KR_RUNDIR/arch" "$KR_RUNDIR/watch.lock" 2>/dev/null
}

# Applied node id: the node the current config was built from. Empty when nothing has
# been applied, in which case nothing may start (ADR 0010). Only hex/alphanumeric ids
# (plus _ and -) are accepted, so the value is safe to splice into paths, status JSON
# and the UI.
kr_applied_id() {
  [ -s "$KR_APPLIED" ] || return 1
  _a=$(sed -n '1p' "$KR_APPLIED" 2>/dev/null)
  case "$_a" in '' | *[!0-9A-Za-z_-]*) return 1 ;; esac
  printf '%s\n' "$_a"
}

kr_meta_get() { # <key: id|host>
  [ -f "$KR_OUTBOUND_META" ] || return 1
  sed -n "s/^$1=//p" "$KR_OUTBOUND_META" 2>/dev/null | head -n 1
}

# One inbound port from state.json's settings. The UI serialises state.json so every key
# sits on its own line inside the settings object; this reads exactly the two flat integer
# fields it owns (ADR 0009) and falls back per field, so a missing, hand-pretty-printed or
# half-broken state.json can never knock an inbound off its default port.
kr_setting_port() { # <key> <default>
  _v=""
  if [ -s "$KR_STATE" ]; then
    _v=$(sed -n '/"settings"/,/^[[:space:]]*}/ {
      s/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p
    }' "$KR_STATE" 2>/dev/null | head -n 1)
  fi
  case "$_v" in
    '' | 0 | *[!0-9]*) echo "$2"; return ;;
  esac
  [ "$_v" -ge 1 ] && [ "$_v" -le 65535 ] && echo "$_v" || echo "$2"
}

# The 日志等级 (docs/adr/0015): the shell's preference, like the tproxy switch and the
# 分流模式. An absent file is the default 警告, so a module update (which replaces runtime/)
# resets it, and an unknown value falls back to 警告 rather than baking a bad level into a
# config the core would reject.
KR_LOGLEVEL_DEFAULT=warning

kr_loglevel_get() {
  _lv=""
  [ -s "$KR_LOGLEVEL" ] && _lv=$(sed -n '1p' "$KR_LOGLEVEL" 2>/dev/null)
  case "$_lv" in
    none | error | warning | info | debug) echo "$_lv" ;;
    *) echo "$KR_LOGLEVEL_DEFAULT" ;;
  esac
}

# The level config.json actually carries; returns 1 when the config or the field is absent.
# The start drift check and the status kv use it to tell "saved" from "already running".
kr_loglevel_config() {
  [ -s "$KR_CONF" ] || return 1
  _lvc=$(awk -F'"' '/^[[:space:]]*"loglevel"/ { print $4; exit }' "$KR_CONF" 2>/dev/null)
  [ -n "$_lvc" ] || return 1
  echo "$_lvc"
}

# loglevel <level>: persist the preference only. The running core and config.json are left
# alone; the next core start re-renders the config to match (docs/adr/0015). Writing the
# default removes the file, so absence stays the one representation of 警告.
kr_loglevel_set() { # <none|error|warning|info|debug>
  case "$1" in
    none | error | warning | info | debug) ;;
    *)
      echo "usage: kernelray.sh loglevel {none|error|warning|info|debug|status}" >&2
      return 2
      ;;
  esac
  kr_dirs
  _old=$(kr_loglevel_get)
  if [ "$1" = "$KR_LOGLEVEL_DEFAULT" ]; then
    rm -f "$KR_LOGLEVEL"
  else
    printf '%s\n' "$1" >"$KR_LOGLEVEL" 2>/dev/null || {
      echo "could not write $KR_LOGLEVEL" >&2
      return 1
    }
    chmod 600 "$KR_LOGLEVEL" 2>/dev/null
  fi
  if [ "$_old" = "$1" ]; then
    kr_log "log level: $_old (unchanged)"
  else
    kr_log "log level: $_old -> $1 (takes effect at the next core start)"
  fi
  return 0
}

kr_loglevel_status() {
  _lv=$(kr_loglevel_get)
  _lvc=$(kr_loglevel_config) || _lvc="-"
  echo "level=$_lv"
  echo "active=$_lvc"
  if kr_running && [ "$_lvc" != "$_lv" ]; then
    echo "pending=1"
  else
    echo "pending=0"
  fi
  return 0
}

kr_status_write() { # <state> <phase>
  _s=$(cat "$KR_STARTED" 2>/dev/null)
  case "$_s" in '' | *[!0-9]*) _s=0 ;; esac
  _n=$(kr_applied_id) || _n=""
  _tp=off
  command -v kr_tp_switch_on >/dev/null 2>&1 && kr_tp_switch_on && _tp=on
  _rt=global
  command -v kr_route_mode >/dev/null 2>&1 && _rt=$(kr_route_mode)
  kr_dirs
  printf '{"state":"%s","phase":"%s","started":%s,"revision":0,"node":"%s","tproxy":"%s","route":"%s"}\n' \
    "$1" "$2" "$_s" "$_n" "$_tp" "$_rt" >"$KR_STATUS" 2>/dev/null
}

# Render the template with one outbound. The outbound is passed through the
# environment, not interpolated into awk's program or a shell string: JSON contains
# backslashes, quotes and `$`, all of which an awk -v value or a double-quoted shell
# expansion would reinterpret. The placeholder is a quoted string so the template stays
# valid JSON for tooling, but replacing the whole string leaves a runnable config only
# after the module renders it.
kr_render_config() { # <outbound-file> [route-mode override]
  _ob=${1:-}
  if [ ! -f "$KR_TMPL" ]; then
    kr_log "missing config template $KR_TMPL"
    return 1
  fi
  if ! grep -q '__KERNELRAY_OUTBOUND__' "$KR_TMPL"; then
    kr_log "config template $KR_TMPL has no outbound placeholder"
    return 1
  fi
  if ! grep -q '__KERNELRAY_SOCKS_PORT__' "$KR_TMPL" || ! grep -q '__KERNELRAY_HTTP_PORT__' "$KR_TMPL"; then
    kr_log "config template $KR_TMPL has no inbound port placeholders"
    return 1
  fi
  if ! grep -q '__KERNELRAY_LOGLEVEL__' "$KR_TMPL"; then
    kr_log "config template $KR_TMPL has no loglevel placeholder"
    return 1
  fi
  # No outbound, no config: the core only ever runs a config derived from an applied
  # node (ADR 0010). There is no freedom fallback to fall back to.
  if [ -z "$_ob" ] || [ ! -s "$_ob" ]; then
    kr_log "no node outbound to render; apply a node first"
    return 1
  fi
  _line=$(cat "$_ob") || return 1
  _route=${2:-}

  # The config form follows the switch unless the caller forces one: toggle and boot
  # render the exact form they are about to enforce. Switch on without rules (a boot
  # conflict) renders idle-form: a mark without its ip rule loses routing.
  _takeover=${KR_TAKEOVER:-}
  if [ -z "$_takeover" ]; then
    if command -v kr_tp_switch_on >/dev/null 2>&1 && kr_tp_switch_on && kr_tp_rules_present; then
      _takeover=1
    else
      _takeover=0
    fi
  fi
  _tp_in=""
  _dns_out=""
  _dns=""
  _routing=""
  _mark=0
  if [ "$_takeover" = 1 ]; then
    if ! kr_tp_render_blocks "$_route"; then
      kr_log "could not build the takeover blocks"
      return 1
    fi
    _tp_in=$KR_TP_INBOUND
    _dns_out=$KR_DNS_OUTBOUND
    _dns=$KR_DNS_BLOCK
    _routing=$KR_ROUTING
    _mark=$KR_BYPASS
  elif command -v kr_route_effective >/dev/null 2>&1; then
    # The 空转 form keeps the 分流 -- a local socks client gets it too -- but has no dns
    # inbound, so only the geo rules are authored (docs/adr/0014). 全局 renders no routing.
    kr_route_effective "$_route"
    if [ "$KR_ROUTE_EFFECTIVE" = cn ]; then
      kr_tp_routing_block 0 "" ""
      _routing=$KR_ROUTING
    fi
  fi
  if [ "${KR_ROUTE_DEGRADED:-0}" = 1 ]; then
    # The preference asked for cn and the geo data is gone: the safe direction is everything
    # through the node, never a dead core. Log file only -- this function's stdout is the
    # config.
    kr_log_file "geo data missing under $KR_GEODATA; rendered the global routing form"
  fi
  # The outbound and the takeover blocks pass through the environment, not interpolated
  # into awk's program or a shell string: JSON contains backslashes, quotes and `` $ ``, all
  # of which an awk -v value or a double-quoted shell expansion would reinterpret.
  # The takeover placeholder lines carry their leading comma in the template so that
  # both the replaced (block spliced in) and the removed (line dropped) result stay
  # valid JSON; the template itself parses because every placeholder is a quoted string.
  # A takeover config whose node outbound lost its bypass mark would let the OUTPUT
  # rules capture the core's own connection back into the core: a routing loop. An
  # outbound without the placeholder (a stale renderer) is refused, not shipped.
  KR_OUT_LINE=$_line KR_TP_TAKEOVER=$_takeover KR_TP_MARK=$_mark \
    KR_SOCKS_PORT=$(kr_setting_port socksPort 10808) \
    KR_HTTP_PORT=$(kr_setting_port httpPort 10809) \
    KR_LOGLEVEL_VAL=$(kr_loglevel_get) \
    KR_TP_INBOUND_BLOCK=$_tp_in KR_DNS_OUTBOUND_BLOCK=$_dns_out \
    KR_DNS_BLOCK=$_dns KR_ROUTING_BLOCK=$_routing awk '
    BEGIN {
      out = ENVIRON["KR_OUT_LINE"]
      gsub(/"__KERNELRAY_MARK__"/, ENVIRON["KR_TP_MARK"], out)
      tp = ENVIRON["KR_TP_TAKEOVER"]
      if (tp == 1 && index(out, "\"mark\":" ENVIRON["KR_TP_MARK"]) == 0) {
        print "kernelray: the node outbound carries no bypass mark; refusing a takeover config" > "/dev/stderr"
        exit 3
      }
    }
    {
      line = $0
      ph = "\"__KERNELRAY_OUTBOUND__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) out substr(line, p + length(ph))
      ph = "\"__KERNELRAY_SOCKS_PORT__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_SOCKS_PORT"] substr(line, p + length(ph))
      ph = "\"__KERNELRAY_HTTP_PORT__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_HTTP_PORT"] substr(line, p + length(ph))
      ph = "\"__KERNELRAY_LOGLEVEL__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) "\"" ENVIRON["KR_LOGLEVEL_VAL"] "\"" substr(line, p + length(ph))
      # The routing block exists in both forms since ADR 0014: spliced when the mode authored
      # one, dropped when it did not.
      ph = "\"__KERNELRAY_ROUTING__\""
      p = index(line, ph)
      if (p > 0) {
        if (ENVIRON["KR_ROUTING_BLOCK"] == "") next
        print substr(line, 1, p - 1) ENVIRON["KR_ROUTING_BLOCK"] substr(line, p + length(ph))
        next
      }
      if (!tp) {
        if (line ~ /^[ \t]*,"__(KERNELRAY_TPROXY_INBOUND|KERNELRAY_DNS_OUTBOUND)__"[ \t]*$/) next
        if (line ~ /^[ \t]*,"dns": "__KERNELRAY_DNS__"[ \t]*$/) next
        print line
        next
      }
      ph = "\"__KERNELRAY_TPROXY_INBOUND__\""
      p = index(line, ph)
      if (p > 0) { print "," ENVIRON["KR_TP_INBOUND_BLOCK"]; next }
      ph = "\"__KERNELRAY_DNS_OUTBOUND__\""
      p = index(line, ph)
      if (p > 0) { print "," ENVIRON["KR_DNS_OUTBOUND_BLOCK"]; next }
      ph = "\"__KERNELRAY_DNS__\""
      p = index(line, ph)
      if (p > 0) line = substr(line, 1, p - 1) ENVIRON["KR_DNS_BLOCK"] substr(line, p + length(ph))
      print line
    }
  ' "$KR_TMPL"
}

# Generate config.json only when it is absent. The normal boot path never calls this:
# apply already wrote the config. It exists so a deleted config falls back to the
# applied node when it can still be reconstructed; when it cannot, the caller starts
# nothing -- the core only ever runs a config derived from an applied node (ADR 0010).
kr_ensure_config() {
  if [ -f "$KR_CONF" ]; then return 0; fi
  kr_dirs
  _n=$(kr_applied_id) || _n=""
  if [ -z "$_n" ]; then
    kr_log "no applied node; not creating a config"
    return 1
  fi
  if [ "$(kr_meta_get id 2>/dev/null)" != "$_n" ] || [ ! -s "$KR_OUTBOUND" ]; then
    kr_log "applied id $_n has no matching outbound; not creating a config"
    return 1
  fi
  _ob=$KR_OUTBOUND
  # Keep the .json suffix: xray -test picks the format from the file name.
  _tmp=$KR_RUNDIR/config.new.json
  if ! kr_render_config "$_ob" >"$_tmp"; then
    rm -f "$_tmp"
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! mv -f "$_tmp" "$KR_CONF"; then
    rm -f "$_tmp"
    return 1
  fi
  kr_log "created config $KR_CONF from applied node $_n"
}

# Swap an already-tested candidate into config.json: back up the current config, stop a
# running core, move the candidate in, start again. A candidate that tests but does not
# start rolls back to the previous config and applied id. Pass the applied id to record
# (the apply path), or "" to leave runtime/applied alone (the ports path re-renders the
# same node). Returns 1 with a message on every failure; the core is left running the
# old config whenever one could be restored.
kr_swap_config() { # <candidate> <applied-id|"">
  _cand=$1
  _newid=$2
  _was=0
  kr_running && _was=1
  _old=$(kr_applied_id) || _old=""
  _prev=$KR_RUNDIR/config.json.prev
  if [ -f "$KR_CONF" ]; then
    if ! cp -f "$KR_CONF" "$_prev" 2>/dev/null; then
      rm -f "$_prev" "$_cand"
      kr_log "could not back up the current config"
      echo "could not back up the current config" >&2
      return 1
    fi
  else
    rm -f "$_prev"
  fi
  if [ "$_was" = 1 ]; then
    kr_stop
  else
    # A core we do not track may still hold the old config (duplicate service.sh).
    # Stop it rather than leaving it running while status says stopped.
    kr_kill_strays ""
  fi

  if ! mv -f "$_cand" "$KR_CONF"; then
    rm -f "$_cand"
    [ "$_was" = 1 ] && kr_start
    kr_log "could not replace config"
    echo "could not replace config" >&2
    return 1
  fi
  chmod 600 "$KR_CONF" 2>/dev/null
  if [ -n "$_newid" ]; then
    printf '%s\n' "$_newid" >"$KR_APPLIED"
    chmod 600 "$KR_APPLIED" 2>/dev/null
  fi

  if [ "$_was" = 1 ]; then
    if ! kr_start; then
      kr_log "new config did not start; restoring previous config"
      if [ -f "$_prev" ]; then
        mv -f "$_prev" "$KR_CONF"
        chmod 600 "$KR_CONF" 2>/dev/null
        if [ -n "$_old" ]; then
          printf '%s\n' "$_old" >"$KR_APPLIED"
        else
          rm -f "$KR_APPLIED"
        fi
        if kr_start; then
          echo "new config failed to start; previous config restored" >&2
        else
          echo "new config failed to start; previous config restored but the core did not start" >&2
        fi
      else
        # Nothing to restore: without a config the applied id is void, and the core
        # stays down rather than running anything not derived from an applied node.
        rm -f "$KR_CONF" "$KR_APPLIED"
        kr_status_write stopped no-node
        echo "new config failed to start; no previous config, the core stays stopped" >&2
      fi
      return 1
    fi
  else
    kr_status_write stopped idle
  fi
  rm -f "$_prev"
  return 0
}

# apply <id>: the UI has already rendered outbound.json + outbound.meta. Verify they
# belong to this id, render a candidate config, let the core validate it, then swap.
# The candidate is tested before the running core is touched; a test failure never
# stops it and never replaces config.json.
kr_apply() { # <node id>
  _id=${1:-}
  case "$_id" in
    '')
      echo "usage: kernelray.sh apply <node-id>" >&2
      return 2
      ;;
    *[!0-9A-Za-z_-]*)
      echo "invalid node id: $_id" >&2
      return 2
      ;;
  esac
  kr_dirs
  if ! kr_core_works; then
    kr_log "apply $_id: core missing or not executable"
    echo "core missing or not executable" >&2
    return 1
  fi
  if [ ! -s "$KR_OUTBOUND" ]; then
    kr_log "apply $_id: no outbound.json"
    echo "no rendered outbound (apply from the WebUI first)" >&2
    return 1
  fi
  _meta=$(kr_meta_get id) || _meta=""
  if [ "$_meta" != "$_id" ]; then
    kr_log "apply $_id: outbound.meta belongs to '$_meta'"
    echo "outbound.json does not belong to node $_id" >&2
    return 1
  fi

  # Keep the .json suffix: xray -test picks the format from the file name.
  _tmp=$KR_RUNDIR/config.new.json
  if ! kr_render_config "$KR_OUTBOUND" >"$_tmp"; then
    rm -f "$_tmp"
    echo "could not render config" >&2
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! "$(kr_core)" run -test -c "$_tmp" >>"$KR_LOG" 2>&1; then
    rm -f "$_tmp"
    kr_log "apply $_id: xray -test rejected the generated config"
    echo "config test failed (see $KR_LOG)" >&2
    return 1
  fi

  kr_swap_config "$_tmp" "$_id" || return 1
  kr_log "applied node $_id"
  return 0
}

# ports: re-render config.json with the inbound ports from state.json's settings. The UI
# writes state.json first (intent), then calls this; the candidate is tested and swapped
# exactly like a node apply, and the applied node is rendered as-is -- the ports change
# the local inbounds, never the outbound.
kr_apply_ports() {
  kr_dirs
  if ! kr_core_works; then
    kr_log "ports: core missing or not executable"
    echo "core missing or not executable" >&2
    return 1
  fi
  # Same rule as kr_ensure_config: the applied node's outbound, or a refusal when the
  # bookkeeping is broken -- claiming direct while a node is applied would be worse
  # than refusing the ports change.
  _n=$(kr_applied_id) || {
    kr_log "ports: no applied node"
    echo "no applied node; apply a node first" >&2
    return 1
  }
  if [ "$(kr_meta_get id 2>/dev/null)" != "$_n" ] || [ ! -s "$KR_OUTBOUND" ]; then
    kr_log "ports: applied id $_n has no matching outbound"
    echo "outbound.json does not match the applied node; re-tap the node in the WebUI" >&2
    return 1
  fi
  _ob=$KR_OUTBOUND
  # Keep the .json suffix: xray -test picks the format from the file name.
  _tmp=$KR_RUNDIR/config.new.json
  if ! kr_render_config "$_ob" >"$_tmp"; then
    rm -f "$_tmp"
    echo "could not render config" >&2
    return 1
  fi
  chmod 600 "$_tmp" 2>/dev/null
  if ! "$(kr_core)" run -test -c "$_tmp" >>"$KR_LOG" 2>&1; then
    rm -f "$_tmp"
    kr_log "ports: xray -test rejected the generated config"
    echo "config test failed (see $KR_LOG)" >&2
    return 1
  fi
  kr_swap_config "$_tmp" "" || return 1
  kr_log "ports applied: $(kr_setting_port socksPort 10808) socks / $(kr_setting_port httpPort 10809) http"
  return 0
}

# unapply: forget the applied node -- the inverse of apply. Everything derived from it
# goes: the takeover rules (they capture into a core that no longer has a node to run),
# config.json, runtime/applied, the rendered outbound and the pinned node address, and the
# status says stopped/no-node so the start gate (ADR 0010) keeps the core down until a node
# is applied again. state.json and the tproxy switch belong to the caller and are left alone
# (ADR 0013). Idempotent: with nothing applied it still lands on stopped/no-node.
kr_unapply() {
  kr_dirs
  # Never pull the config out from under a live core: that would be a stop, and a stop is
  # a different gesture with a different consequence (fail-closed rules stay up).
  if kr_running; then
    kr_log "unapply: the core is running; stop it first"
    echo "core is running; stop it first" >&2
    return 1
  fi
  if command -v kr_tp_remove >/dev/null 2>&1; then
    kr_tp_remove
  fi
  rm -f "$KR_CONF" "$KR_APPLIED" "$KR_OUTBOUND" "$KR_OUTBOUND_META" \
    "$KR_PIDFILE" "$KR_STARTED" "$KR_RUNDIR/nodeip"
  kr_log "unapplied: config, applied id, rendered outbound and takeover rules removed"
  kr_status_write stopped no-node
  return 0
}

kr_start() {
  kr_dirs
  kr_cleanup_legacy
  kr_lock || { kr_log "could not acquire start lock"; return 1; }
  kr_start_locked
  _rc=$?
  # Release on return, not only via the EXIT trap: apply can start twice (new config,
  # then a rollback) and a lock held until process exit would make the second start
  # wait for the stale-lock timeout.
  rmdir "$KR_RUNDIR/start.lock" 2>/dev/null
  return "$_rc"
}

kr_start_locked() {
  if kr_running; then
    kr_kill_strays "$(kr_pid)"
    kr_log "already running (pid $(kr_pid))"
    kr_status_write running "${KR_TP_PHASE:-idle}"
    return 0
  fi
  rm -f "$KR_PIDFILE"
  kr_kill_strays ""

  _core=$(kr_core)
  if ! kr_core_works; then
    kr_log "core missing or not executable: $_core"
    kr_status_write failed no-core
    return 1
  fi
  kr_version_refresh
  # The gate: the core never runs a config that is not derived from an applied node
  # (ADR 0010). Without one there is nothing to start; the honest status is a stop,
  # not a direct run.
  if ! kr_applied_id >/dev/null; then
    kr_log "no applied node; the core stays stopped"
    echo "no applied node; tap a node in the node list to apply one first" >&2
    kr_status_write stopped no-node
    return 1
  fi
  # The switch couples takeover to the core's start (ADR 0011): on, the rules go in
  # and the takeover config is swapped in before the core runs (fail-closed); off,
  # any stale rules from a crash under the old switch state come down and the core
  # starts idle. The gate above already refused a start without an applied node, so
  # a default-on switch can never take a nodeless device over.
  if command -v kr_tp_engage >/dev/null 2>&1; then
    if kr_tp_switch_on; then
      kr_tp_engage
    elif kr_tp_rules_present; then
      kr_tp_log "start: the tproxy switch is off; removing stale rules"
      kr_tp_remove
    fi
  fi
  # The config on disk must match the form this start will run. Two ways it can drift:
  #   * the switch moved -- off with a takeover config left on disk means the node outbound
  #     still carries the bypass mark while no ip rule exists, and a mark without its rule
  #     loses routing (docs/adr/0008). This is the documented "switch off, start again"
  #     recovery path, so it must actually re-render.
  #   * 大陆直连's geo data went missing (docs/adr/0014).
  # Both are repaired the same way, before the -test below. A config that cannot be re-rendered
  # (no outbound) is left to the start gate, which refuses it.
  if [ -f "$KR_CONF" ] && command -v kr_route_effective >/dev/null 2>&1; then
    kr_route_effective
    _want_tp=0
    kr_tp_switch_on && kr_tp_rules_present && _want_tp=1
    _have_tp=0
    grep -q '"tag":"tp-in"' "$KR_CONF" 2>/dev/null && _have_tp=1
    _have_cn=global
    grep -q 'geosite:cn' "$KR_CONF" 2>/dev/null && _have_cn=cn
    # The 日志等级 promises to take effect at the next start (docs/adr/0015), so a mismatch
    # is always repaired here, not only the directions that cannot work.
    _want_lv=$(kr_loglevel_get)
    _have_lv=$(kr_loglevel_config) || _have_lv=""
    # Only the takeover/routing directions that cannot work are repaired: a config that is
    # *more* takeover-y than this start (the switch went off), one that is *less* takeover-y
    # than the rules that are up (capturing into a core with no tproxy inbound blackholes
    # traffic, docs/adr/0011), and a cn config whose geo data is gone (docs/adr/0014). A
    # global config while the preference says cn is left alone: that is what a failed
    # switch's rollback deliberately leaves behind.
    _drift=0
    [ "$_have_tp" != "$_want_tp" ] && _drift=1
    [ "$_have_cn" = cn ] && [ "$KR_ROUTE_EFFECTIVE" = global ] && _drift=1
    [ "$_have_lv" != "$_want_lv" ] && _drift=1
    if [ "$_drift" = 1 ]; then
      kr_tp_log "start: the config on disk does not match this start (takeover $_have_tp->$_want_tp, routing $_have_cn->$KR_ROUTE_EFFECTIVE, log $_have_lv->$_want_lv); re-rendering"
      if ! kr_tp_swap_config "$_want_tp" "$KR_OUTBOUND"; then
        kr_log "start: could not re-render the config for this start"
        kr_status_write failed no-config
        return 1
      fi
    fi
  fi
  kr_ensure_config || {
    kr_status_write failed no-config
    return 1
  }

  kr_status_write starting starting
  if ! "$_core" run -test -c "$KR_CONF" >>"$KR_LOG" 2>&1; then
    kr_log "config test failed, see $KR_LOG"
    kr_status_write failed config-invalid
    return 1
  fi

  nohup "$_core" run -c "$KR_CONF" >>"$KR_LOG" 2>&1 &
  echo "$!" >"$KR_PIDFILE"
  kr_now >"$KR_STARTED"
  sleep 1

  if kr_running; then
    kr_log "started pid $(kr_pid) core $_core"
    kr_status_write running "${KR_TP_PHASE:-idle}"
    return 0
  fi
  rm -f "$KR_PIDFILE"
  kr_log "core exited right after start, see $KR_LOG"
  kr_status_write failed crashed
  return 1
}

kr_stop() {
  if ! kr_running; then
    rm -f "$KR_PIDFILE" "$KR_STARTED"
    kr_log "not running"
    kr_status_write stopped idle
    return 0
  fi
  _p=$(kr_pid)
  kill "$_p" 2>/dev/null
  _i=0
  while [ "$_i" -lt 20 ] && kill -0 "$_p" 2>/dev/null; do
    sleep 0.2
    _i=$((_i + 1))
  done
  kill -9 "$_p" 2>/dev/null
  rm -f "$KR_PIDFILE" "$KR_STARTED"
  kr_log "stopped pid $_p"
  kr_status_write stopped idle
}

# Human-readable summary, used by action.sh.
kr_report() {
  _core=$(kr_core)
  echo "state: $(kr_running && echo running || echo stopped)"
  if [ -f "$KR_STATUS" ]; then
    echo "status: $(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$KR_STATUS")/$(sed -n 's/.*"phase":"\([^"]*\)".*/\1/p' "$KR_STATUS")"
  fi
  if kr_core_works 2>/dev/null; then
    echo "core:  $_core"
    echo "ver:   $(kr_version_cached)"
  else
    echo "core:  $_core (missing or not executable here)"
  fi
  echo "conf:  $KR_CONF"
  _node=$(kr_applied_id) || _node="(none)"
  echo "node:  $_node"
  if command -v kr_tp_switch_on >/dev/null 2>&1 && kr_tp_switch_on; then
    echo "tproxy: on (rules $(kr_tp_rules_present && echo present || echo absent), port $KR_TP_PORT)"
  else
    echo "tproxy: off"
  fi
  if command -v kr_route_mode >/dev/null 2>&1; then
    _rt=$(kr_route_mode)
    kr_route_effective
    if [ "$KR_ROUTE_DEGRADED" = 1 ]; then
      echo "route: $_rt (geo data missing: rendering $KR_ROUTE_EFFECTIVE)"
    else
      echo "route: $_rt"
    fi
  fi
  echo "level: $(kr_loglevel_get)"
  echo "log:   $KR_LOG"
  if kr_running; then
    echo "pid:   $(kr_pid)"
    echo "ports: $(kr_setting_port socksPort 10808) socks / $(kr_setting_port httpPort 10809) http (127.0.0.1)"
    kr_tp_rules_present 2>/dev/null && echo "       $KR_TP_PORT tproxy (wildcard; device traffic)"
  fi
}

# Machine-readable summary for the WebUI: one key=value per line, values may
# contain spaces (split on the first '='). State comes from the live process, not
# from status.json, so a stale status file cannot claim "running" for a dead core.
kr_status_kv() {
  if kr_running; then
    _state=running
    _pid=$(kr_pid)
    _started=$(cat "$KR_STARTED" 2>/dev/null)
    case "$_started" in '' | *[!0-9]*) _started=0 ;; esac
  else
    _state=stopped
    _pid=-
    _started=0
  fi
  _phase=$(sed -n 's/.*"phase":"\([^"]*\)".*/\1/p' "$KR_STATUS" 2>/dev/null)
  [ -n "$_phase" ] || _phase=unknown
  # A pidfile that outlived its process means the core died on its own: nothing ran to write
  # failed/crashed, so the status file still claims running. Report the fact instead of the
  # stale phase -- unless that status predates this boot, where "not started yet" is the
  # honest reading.
  if [ "$_state" = stopped ] && [ -s "$KR_PIDFILE" ] &&
    [ "$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$KR_STATUS" 2>/dev/null)" = running ]; then
    _up=$(cut -d. -f1 /proc/uptime 2>/dev/null)
    _since=$(cat "$KR_STARTED" 2>/dev/null)
    case "$_up" in
      '' | *[!0-9]*) _phase=crashed ;; # no uptime to compare: the pidfile is the evidence
      *)
        case "$_since" in
          '' | *[!0-9]*) _phase=crashed ;;
          *) [ "$_since" -ge $(( $(date +%s) - _up )) ] && _phase=crashed ;;
        esac
        ;;
    esac
  fi
  _node=$(kr_applied_id) || _node=""
  _ver=-
  [ -x "$(kr_core)" ] && _ver=$(kr_version_cached)
  [ -n "$_ver" ] || _ver=-
  _tp=off
  _rules=absent
  if command -v kr_tp_switch_on >/dev/null 2>&1; then
    kr_tp_switch_on && _tp=on
    kr_tp_rules_present && _rules=present
  fi
  # route is the preference, routing what the config may actually use (they differ only while
  # the geo data is missing, docs/adr/0014), geodata says which of the two it is.
  _rt=global
  _rte=global
  _geo=missing
  _geover=""
  if command -v kr_route_mode >/dev/null 2>&1; then
    _rt=$(kr_route_mode)
    kr_route_effective
    _rte=$KR_ROUTE_EFFECTIVE
    kr_geodata_ok && _geo=ok
    _geover=$(sed -n '1p' "$KR_GEODATA/VERSION" 2>/dev/null)
  fi
  # The 日志等级 preference and whether config.json already carries it: the UI shows the
  # pending hint only while a running core predates the change (docs/adr/0015). A stopped
  # core needs no hint: its next start re-renders the config.
  _lv=$(kr_loglevel_get)
  _lvc=$(kr_loglevel_config) || _lvc=""
  _lvp=0
  [ "$_state" = running ] && [ "$_lvc" != "$_lv" ] && _lvp=1
  echo "state=$_state"
  echo "phase=$_phase"
  echo "pid=$_pid"
  echo "started=$_started"
  echo "version=$_ver"
  echo "core=$(kr_core)"
  echo "conf=$KR_CONF"
  echo "log=$KR_LOG"
  echo "node=$_node"
  echo "tproxy=$_tp"
  echo "rules=$_rules"
  echo "route=$_rt"
  echo "routing=$_rte"
  echo "geodata=$_geo"
  echo "geodataver=$_geover"
  echo "socks=$(kr_setting_port socksPort 10808)"
  echo "http=$(kr_setting_port httpPort 10809)"
  echo "loglevel=$_lv"
  echo "loglevelpending=$_lvp"
}

kr_tail() {
  _n=${1:-200}
  case "$_n" in '' | *[!0-9]*) _n=200 ;; esac
  [ "$_n" -gt 2000 ] && _n=2000
  if [ ! -f "$KR_LOG" ]; then
    echo "(no log yet: $KR_LOG)"
    return 0
  fi
  tail -n "$_n" "$KR_LOG" 2>/dev/null || echo "(cannot read $KR_LOG)"
}

kr_cli() {
  _cmd=${1:-status}
  [ $# -gt 0 ] && shift
  case "$_cmd" in
    start) kr_start ;;
    stop) kr_stop ;;
    apply) kr_apply "${1:-}" ;;
    unapply) kr_unapply ;;
    ports) kr_apply_ports ;;
    routing)
      case "${1:-status}" in
        global|cn) kr_route_set "$1" ;;
        status) kr_route_status ;;
        *)
          echo "usage: kernelray.sh routing {global|cn|status}" >&2
          return 2
          ;;
      esac
      ;;
    loglevel)
      case "${1:-status}" in
        none | error | warning | info | debug) kr_loglevel_set "$1" ;;
        status) kr_loglevel_status ;;
        *)
          echo "usage: kernelray.sh loglevel {none|error|warning|info|debug|status}" >&2
          return 2
          ;;
      esac
      ;;
    status) kr_status_kv ;;
    log) kr_tail "${1:-200}" ;;
    tproxy)
      case "${1:-}" in
        on|off) kr_tproxy_set "$1" ;;
        status) kr_tproxy_status ;;
        *)
          echo "usage: kernelray.sh tproxy {on|off|status}" >&2
          return 2
          ;;
      esac
      ;;
    *)
      echo "usage: kernelray.sh {start|stop|apply <node-id>|unapply|ports|tproxy {on|off|status}|routing {global|cn|status}|loglevel {none|error|warning|info|debug|status}|status|log [lines]}" >&2
      return 2
      ;;
  esac
}

# Executed directly (WebUI, shell) -> act as a CLI. Sourced (service.sh,
# action.sh, customize.sh) -> only definitions above, no side effects.
case "${0##*/}" in
  kernelray.sh) kr_cli "$@" ;;
esac
