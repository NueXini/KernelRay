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
KR_OUTBOUND=$KR_MODDIR/outbound.json
KR_OUTBOUND_META=$KR_MODDIR/outbound.meta
KR_APPLIED=$KR_RUNDIR/applied

kr_now() { date +%s; }

kr_log() { printf '%s kernelray[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*"; }

kr_dirs() {
  mkdir -p "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  # The module dir itself keeps its installed mode; only our own subdirs are tightened.
  chmod 700 "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  chmod 600 "$KR_CONF" "$KR_MODDIR/state.json" \
    "$KR_OUTBOUND" "$KR_OUTBOUND_META" "$KR_APPLIED" 2>/dev/null
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

# Applied node id: the node the current config was built from. Empty when the core
# runs the idle (freedom) config. Only hex/alphanumeric ids (plus _ and -) are
# accepted, so the value is safe to splice into paths, status JSON and the UI.
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

kr_status_write() { # <state> <phase>
  _s=$(cat "$KR_STARTED" 2>/dev/null)
  case "$_s" in '' | *[!0-9]*) _s=0 ;; esac
  _n=$(kr_applied_id) || _n=""
  kr_dirs
  printf '{"state":"%s","phase":"%s","started":%s,"revision":0,"node":"%s"}\n' \
    "$1" "$2" "$_s" "$_n" >"$KR_STATUS" 2>/dev/null
}

# Render the template with one outbound. The outbound is passed through the
# environment, not interpolated into awk's program or a shell string: JSON contains
# backslashes, quotes and `$`, all of which an awk -v value or a double-quoted shell
# expansion would reinterpret. The placeholder is a quoted string so the template stays
# valid JSON for tooling, but replacing the whole string leaves a runnable config only
# after the module renders it.
kr_render_config() { # <outbound-file|"" for idle>
  _ob=${1:-}
  if [ ! -f "$KR_TMPL" ]; then
    kr_log "missing config template $KR_TMPL"
    return 1
  fi
  if ! grep -q '__KERNELRAY_OUTBOUND__' "$KR_TMPL"; then
    kr_log "config template $KR_TMPL has no outbound placeholder"
    return 1
  fi
  if [ -n "$_ob" ] && [ -s "$_ob" ]; then
    _line=$(cat "$_ob") || return 1
  else
    _line='{"tag":"proxy","protocol":"freedom","settings":{}}'
  fi
  KR_OUT_LINE=$_line awk -v ph='"__KERNELRAY_OUTBOUND__"' '
    BEGIN { out = ENVIRON["KR_OUT_LINE"] }
    {
      p = index($0, ph)
      if (p > 0) print substr($0, 1, p - 1) out substr($0, p + length(ph))
      else print
    }
  ' "$KR_TMPL"
}

# Generate config.json only when it is absent. The normal boot path never calls this:
# apply already wrote the config. It exists so a deleted config falls back to the
# applied node when it can still be reconstructed, and to idle (clearing the applied
# id) when it cannot -- claiming a node is applied when the config is direct would be
# worse than admitting the fallback.
kr_ensure_config() {
  if [ -f "$KR_CONF" ]; then return 0; fi
  kr_dirs
  _ob=""
  _n=$(kr_applied_id) || _n=""
  if [ -n "$_n" ]; then
    if [ "$(kr_meta_get id 2>/dev/null)" = "$_n" ] && [ -s "$KR_OUTBOUND" ]; then
      _ob=$KR_OUTBOUND
    else
      kr_log "applied id $_n has no matching outbound; falling back to idle"
      rm -f "$KR_APPLIED"
    fi
  fi
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
  if [ -n "$_ob" ]; then
    kr_log "created config $KR_CONF from applied node $_n"
  else
    kr_log "created idle config $KR_CONF"
  fi
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

  _was=0
  kr_running && _was=1
  _old=$(kr_applied_id) || _old=""
  _prev=$KR_RUNDIR/config.json.prev
  if [ -f "$KR_CONF" ]; then
    if ! cp -f "$KR_CONF" "$_prev" 2>/dev/null; then
      rm -f "$_prev" "$_tmp"
      kr_log "apply $_id: could not back up the current config"
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

  if ! mv -f "$_tmp" "$KR_CONF"; then
    rm -f "$_tmp"
    [ "$_was" = 1 ] && kr_start
    kr_log "apply $_id: could not replace config"
    echo "could not replace config" >&2
    return 1
  fi
  chmod 600 "$KR_CONF" 2>/dev/null
  printf '%s\n' "$_id" >"$KR_APPLIED"
  chmod 600 "$KR_APPLIED" 2>/dev/null

  if [ "$_was" = 1 ]; then
    if ! kr_start; then
      kr_log "apply $_id: new config did not start; restoring previous config"
      if [ -f "$_prev" ]; then
        mv -f "$_prev" "$KR_CONF"
        chmod 600 "$KR_CONF" 2>/dev/null
      else
        # The old config disappeared while the core was running. Removing the failed
        # candidate lets kr_start fall back to idle (and clear the applied id) instead
        # of starting a config that just failed.
        rm -f "$KR_CONF"
      fi
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
      return 1
    fi
  else
    kr_status_write stopped idle
  fi
  rm -f "$_prev"
  kr_log "applied node $_id"
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
    kr_status_write running idle
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
    kr_status_write running idle
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
  echo "log:   $KR_LOG"
  if kr_running; then
    echo "pid:   $(kr_pid)"
    echo "ports: 10808 socks / 10809 http (127.0.0.1)"
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
  _node=$(kr_applied_id) || _node=""
  _ver=-
  [ -x "$(kr_core)" ] && _ver=$(kr_version_cached)
  [ -n "$_ver" ] || _ver=-
  echo "state=$_state"
  echo "phase=$_phase"
  echo "pid=$_pid"
  echo "started=$_started"
  echo "version=$_ver"
  echo "core=$(kr_core)"
  echo "conf=$KR_CONF"
  echo "log=$KR_LOG"
  echo "node=$_node"
  echo "socks=10808"
  echo "http=10809"
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
    status) kr_status_kv ;;
    log) kr_tail "${1:-200}" ;;
    *)
      echo "usage: kernelray.sh {start|stop|apply <node-id>|status|log [lines]}" >&2
      return 2
      ;;
  esac
}

# Executed directly (WebUI, shell) -> act as a CLI. Sourced (service.sh,
# action.sh, customize.sh) -> only definitions above, no side effects.
case "${0##*/}" in
  kernelray.sh) kr_cli "$@" ;;
esac
