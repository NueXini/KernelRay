# shellcheck shell=ash
# KernelRay shared helpers. Sourced by customize.sh / service.sh / action.sh / uninstall.sh.
#
# Layout contract:
#   module dir  (/data/adb/modules/kernelray)  mechanism + cores, replaced on module update
#   data dir    (/data/adb/kernelray)          user config, logs, runtime state, survives updates
#
# Override KR_MODDIR during install: customize.sh sets it to $MODPATH.

KR_ID=kernelray
KR_MODDIR=${KR_MODDIR:-/data/adb/modules/kernelray}
KR_DATA=${KR_DATA:-/data/adb/kernelray}
KR_CONF=$KR_DATA/config.json
KR_LOGDIR=$KR_DATA/logs
KR_RUNDIR=$KR_DATA/runtime
KR_LOG=$KR_LOGDIR/xray.log
KR_PIDFILE=$KR_RUNDIR/xray.pid
KR_STARTED=$KR_RUNDIR/started
KR_STATUS=$KR_RUNDIR/status.json
KR_VERFILE=$KR_RUNDIR/version

kr_now() { date +%s; }

kr_log() { printf '%s kernelray[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*"; }

kr_dirs() {
  mkdir -p "$KR_DATA" "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
  chmod 700 "$KR_DATA" "$KR_LOGDIR" "$KR_RUNDIR" 2>/dev/null
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

# Serialise concurrent starts. mkdir is atomic; a lock older than 30s is stale.
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

kr_status_write() { # <state> <phase>
  _s=$(cat "$KR_STARTED" 2>/dev/null)
  case "$_s" in '' | *[!0-9]*) _s=0 ;; esac
  kr_dirs
  printf '{"state":"%s","phase":"%s","started":%s,"revision":0,"node":""}\n' \
    "$1" "$2" "$_s" >"$KR_STATUS" 2>/dev/null
}

kr_ensure_config() {
  if [ -f "$KR_CONF" ]; then return 0; fi
  if [ ! -f "$KR_MODDIR/config.example.json" ]; then
    kr_log "missing $KR_MODDIR/config.example.json"
    return 1
  fi
  kr_dirs
  cp "$KR_MODDIR/config.example.json" "$KR_CONF" || return 1
  chmod 600 "$KR_CONF" 2>/dev/null
  kr_log "created default config $KR_CONF"
}

kr_start() {
  kr_dirs
  kr_cleanup_legacy
  kr_lock || { kr_log "could not acquire start lock"; return 1; }
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
    status) kr_status_kv ;;
    log) kr_tail "${1:-200}" ;;
    *)
      echo "usage: kernelray.sh {start|stop|status|log [lines]}" >&2
      return 2
      ;;
  esac
}

# Executed directly (WebUI, shell) -> act as a CLI. Sourced (service.sh,
# action.sh, customize.sh) -> only definitions above, no side effects.
case "${0##*/}" in
  kernelray.sh) kr_cli "$@" ;;
esac
