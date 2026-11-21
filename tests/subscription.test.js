// 订阅抓取测试。
//
// `kernelray.sh sub fetch` 是 WebUI「从订阅导入」的取回步骤：URL 经
// runtime/subfetch.url 传入，正文原样写到 stdout。这套测试对着一个假
// busybox 跑真正的 CLI，覆盖成功、HTTP 错误、超时、空/超大正文以及
// URL 缺失或协议不支持——无需 Android 设备或网络。
//
//   node --test tests/subscription.test.js
//
// 需要 bash（Windows 上是 Git Bash）。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const script = path.join(root, "module", "scripts", "kernelray.sh");

// 带令牌的订阅地址：日志与错误输出里都不许出现它（包括域名）。
const URL = "https://sub.example.com/api/v1/client/subscribe?token=SECRET123";
const SECRET = "SECRET123";
const HOST = "sub.example.com";
const MAX = 1048576;

// 假 busybox。`timeout N busybox wget ...` 被拆成直接执行内部命令；
// `wc -c` 交给测试机的真实 wc。假 wget 记录 argv，按 FAKE_SUB_MODE
// 返回不同结果，并断言 URL 文件在抓取开始前已经消失。
const fakeBusybox = [
  "#!/bin/sh",
  'if [ "$1" = "timeout" ]; then',
  "  shift 2",
  '  [ "${1##*/}" = "busybox" ] && shift',
  '  if [ "$FAKE_SUB_MODE" = "timeout" ]; then',
  '    echo "timeout: sending signal TERM to command" >&2',
  "    exit 124",
  "  fi",
  '  exec "$0" "$@"',
  "fi",
  'if [ "$1" = "wget" ]; then',
  '  printf "wget %s\\n" "$*" >>"$FAKE_LOG"',
  '  if [ -n "$FAKE_SUB_URL" ] && [ -e "$FAKE_SUB_URL" ]; then',
  '    echo "wget: the secret url file still exists" >&2',
  "    exit 99",
  "  fi",
  '  out=""',
  '  prev=""',
  '  for a in "$@"; do',
  '    [ "$prev" = "-O" ] && out=$a',
  "    prev=$a",
  "  done",
  '  case "$FAKE_SUB_MODE" in',
  "    ok|empty|large)",
  '      [ -n "$out" ] || { echo "wget: no -O target" >&2; exit 2; }',
  '      cat "$FAKE_SUB_BODY_FILE" >"$out" || exit 1',
  "      exit 0",
  "      ;;",
  "    http404)",
  '      echo "wget: server returned error: HTTP/1.1 404 Not Found" >&2',
  "      exit 1",
  "      ;;",
  "    http500)",
  '      echo "wget: server returned error: HTTP/1.0 500 Internal Server Error" >&2',
  "      exit 1",
  "      ;;",
  "    killed)",
  "      exit 143",
  "      ;;",
  "    nofile)",
  "      exit 0",
  "      ;;",
  "    *)",
  '      echo "wget: bad address" >&2',
  "      exit 1",
  "      ;;",
  "  esac",
  "fi",
  'if [ "$1" = "wc" ] && [ "$2" = "-c" ]; then',
  "  exec wc -c",
  "fi",
  "exit 127",
  ""
].join("\n");

const dirs = [];
let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(name + "\n    " + e.message.replace(/\n/g, "\n    "));
  }
}

function eq(actual, expected, what) {
  try {
    assert.deepStrictEqual(actual, expected);
  } catch (e) {
    throw new Error((what || "value") + "\n" + e.message);
  }
}

function ok(cond, what) {
  if (!cond) { throw new Error(what); }
}

// 在 Git Bash 里路径是 /c/Users/...，而 Node 看到的是 C:\Users\...
function shPath(p) {
  if (process.platform !== "win32") { return p; }
  return "/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
}

function posixPathEnv(extraDir) {
  return process.platform === "win32"
    ? extraDir + ";" + process.env.PATH
    : extraDir + ":" + process.env.PATH;
}

function makeModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernelray-sub-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "config", "runtime"), { recursive: true });
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  fs.writeFileSync(path.join(stubs, "busybox"), fakeBusybox, "utf8");
  fs.chmodSync(path.join(stubs, "busybox"), 0o755);
  return {
    dir: dir,
    stubs: stubs,
    url: path.join(dir, "config", "runtime", "subfetch.url"),
    raw: path.join(dir, "config", "runtime", "subfetch.raw"),
    log: path.join(dir, "logs", "kernelray.log"),
    fetchLog: path.join(dir, "fetch.log")
  };
}

// 跑真正的 CLI（而不是 source 后直接调函数），顺带守住子命令分派。
function run(m, extraEnv) {
  try {
    const stdout = execFileSync("bash", [shPath(script), "sub", "fetch"], {
      cwd: root,
      env: Object.assign({}, process.env, {
        KR_MODDIR: shPath(m.dir),
        KR_BUSYBOX: shPath(path.join(m.stubs, "busybox")),
        FAKE_LOG: shPath(m.fetchLog),
        FAKE_SUB_URL: shPath(m.url),
        PATH: posixPathEnv(m.stubs)
      }, extraEnv || {}),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout: stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

function readLog(m) {
  try { return fs.readFileSync(m.log, "utf8"); } catch (e) { return ""; }
}

function readFetchLog(m) {
  try { return fs.readFileSync(m.fetchLog, "utf8"); } catch (e) { return ""; }
}

function gone(p, what) {
  if (fs.existsSync(p)) { throw new Error(what + " must be gone"); }
}

function writeUrl(m, url) {
  fs.writeFileSync(m.url, url + "\n");
}

function bodyFile(m, body) {
  const p = path.join(m.dir, "body.txt");
  fs.writeFileSync(p, body);
  return shPath(p);
}

function noUrlIn(text, what) {
  ok(!text.includes(HOST), what + " must not contain the host");
  ok(!text.includes(SECRET), what + " must not contain the token");
}

// ---- 成功 --------------------------------------------------------------------------------

check("success: stdout is exactly the body, both files are removed, one log line", () => {
  const m = makeModule();
  const body = "vless://id@example.com:443?type=ws#one\nvmess://eyJhZGQiOiJleGFtcGxlIn0=\n";
  const file = bodyFile(m, body);
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "ok", FAKE_SUB_BODY_FILE: file });
  eq(r.status, 0, "exit status");
  eq(r.stdout, body, "stdout must be exactly the body");
  eq(r.stderr, "", "stderr must be empty");
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  const log = readLog(m);
  ok(log.includes("[Sub] subscription fetch: " + Buffer.byteLength(body) + " bytes"),
    "the byte count is not logged: " + log);
  noUrlIn(log, "the module log");
  const fetch = readFetchLog(m);
  ok(fetch.includes("-U v2rayN/6.0"), "the user agent was not passed: " + fetch);
  ok(fetch.includes("--no-check-certificate"), "certificate checking was not disabled: " + fetch);
  ok(fetch.includes(URL), "the URL was not passed to wget: " + fetch);
});

check("success: exactly 1 MiB is still accepted", () => {
  const m = makeModule();
  const body = "a".repeat(MAX);
  const file = bodyFile(m, body);
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "large", FAKE_SUB_BODY_FILE: file });
  eq(r.status, 0, "exit status");
  eq(r.stdout.length, MAX, "stdout length");
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch: " + MAX + " bytes"),
    "the byte count is not logged");
});

// ---- 抓取失败 ----------------------------------------------------------------------------

check("http 404: reason=http http=404, raw removed, no URL in log or stderr", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "http404" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=http"), "stderr lacks reason=http: " + r.stderr);
  ok(r.stderr.includes("http=404"), "stderr lacks http=404: " + r.stderr);
  noUrlIn(r.stderr, "stderr");
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  const log = readLog(m);
  ok(log.includes("[Sub] subscription fetch failed: http 404"), "log line: " + log);
  noUrlIn(log, "the module log");
});

check("http 500 on HTTP/1.0 is classified as http", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "http500" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=http http=500"), "stderr: " + r.stderr);
  gone(m.raw, "subfetch.raw");
});

check("timeout: exit 124 becomes reason=timeout", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "timeout" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=timeout"), "stderr: " + r.stderr);
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch failed: timeout"), "log line");
});

check("timeout: exit 143 also becomes reason=timeout", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "killed" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=timeout"), "stderr: " + r.stderr);
  gone(m.raw, "subfetch.raw");
});

check("network: any other non-zero exit becomes reason=network", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "network" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=network"), "stderr: " + r.stderr);
  noUrlIn(r.stderr, "stderr");
  gone(m.raw, "subfetch.raw");
  const log = readLog(m);
  ok(log.includes("[Sub] subscription fetch failed: network"), "log line");
  noUrlIn(log, "the module log");
});

check("empty: a zero-byte body is reason=empty", () => {
  const m = makeModule();
  const file = bodyFile(m, "");
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "empty", FAKE_SUB_BODY_FILE: file });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=empty"), "stderr: " + r.stderr);
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch failed: empty"), "log line");
});

check("empty: a successful wget that leaves no body file is still empty", () => {
  const m = makeModule();
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "nofile" });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=empty"), "stderr: " + r.stderr);
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch failed: empty"), "log line");
});

check("too-large: more than 1 MiB is reason=too-large", () => {
  const m = makeModule();
  const file = bodyFile(m, "a".repeat(MAX + 1));
  writeUrl(m, URL);
  const r = run(m, { FAKE_SUB_MODE: "large", FAKE_SUB_BODY_FILE: file });
  eq(r.status, 1, "exit status");
  ok(r.stderr.includes("reason=too-large"), "stderr: " + r.stderr);
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch failed: too-large"), "log line");
});

// ---- URL 输入错误 ------------------------------------------------------------------------

check("missing URL: exit 2, no fetch, the secret file stays gone", () => {
  const m = makeModule();
  const r = run(m, { FAKE_SUB_MODE: "ok" });
  eq(r.status, 2, "exit status");
  ok(r.stderr.includes("kernelray: no subscription URL"), "stderr: " + r.stderr);
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  ok(readLog(m).includes("[Sub] subscription fetch failed: no url"), "log line");
  eq(readFetchLog(m), "", "wget must not run without a URL");
});

check("empty URL file: exit 2 and the file is removed", () => {
  const m = makeModule();
  writeUrl(m, "");
  const r = run(m, { FAKE_SUB_MODE: "ok" });
  eq(r.status, 2, "exit status");
  ok(r.stderr.includes("kernelray: no subscription URL"), "stderr: " + r.stderr);
  gone(m.url, "subfetch.url");
  ok(readLog(m).includes("[Sub] subscription fetch failed: no url"), "log line");
});

check("unsupported URL: exit 2, never echoed, no fetch", () => {
  const m = makeModule();
  writeUrl(m, "ftp://" + HOST + "/" + SECRET);
  const r = run(m, { FAKE_SUB_MODE: "ok" });
  eq(r.status, 2, "exit status");
  ok(r.stderr.includes("kernelray: unsupported subscription URL"), "stderr: " + r.stderr);
  noUrlIn(r.stderr, "stderr");
  gone(m.url, "subfetch.url");
  gone(m.raw, "subfetch.raw");
  const log = readLog(m);
  ok(log.includes("[Sub] subscription fetch failed: bad url"), "log line: " + log);
  noUrlIn(log, "the module log");
  eq(readFetchLog(m), "", "wget must not run for an unsupported URL");
});

check("URL error: a stale raw body from an earlier run is removed", () => {
  const m = makeModule();
  fs.writeFileSync(m.raw, "stale body from a previous attempt");
  const r = run(m, { FAKE_SUB_MODE: "ok" });
  eq(r.status, 2, "exit status");
  gone(m.raw, "subfetch.raw");
});

// ---- 结果报告 ----------------------------------------------------------------------------

dirs.forEach((d) => {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* Windows 可能占用文件 */ }
});

if (failures.length) {
  console.error("\n" + failures.length + " failing, " + pass + " passing\n");
  failures.forEach((f) => console.error("FAIL " + f + "\n"));
  process.exit(1);
}
console.log(pass + " subscription tests passing");
