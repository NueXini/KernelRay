# 0019 — 状态轮询读开机范围规则缓存；启动路径询问内核

状态：已接受（其中点名的一个细节已变化：`kr_tp_form` 不复存在，`kr_tp_rules_present` 的
调用方只剩启动路径和 `kr_conf_accept_ondisk`——见
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）

## 背景

页面可见时 WebUI 每 2 s 轮询一次 `kernelray.sh status`。`kr_status_kv` 用
`kr_tp_rules_present` 回答"接管规则装了吗？"，后者运行 `iptables -t mangle -nL KR_TP_OUTPUT`
和 `ip6tables -t mangle -nL KR_TP_OUTPUT`。同一函数还经十几个 `cat`/`sed`/`head` 调用读
pid、已应用 id、启动时间、版本、日志级别和两个入站端口。停止核心的一次轮询大约 15–20 个
外部进程，其中两个是 `iptables`；运行中核心的轮询再加上 pid 和启动时间读取。这些事实没有
一个会在两次轮询之间变化，除非用户有所动作。

规则本身只在三个时刻变化：`kr_tp_install`（开关开着的一次启动）、`kr_tp_remove`（开关
关闭的一次启动、`unapply`、或失败的安装），以及外部行为者（另一个模块、手动
`iptables -F`）。状态值是 **建议性的**：它喂给状态徽章和接管提示。安全攸关的读者——
`kr_tp_form`、`kr_conf_accept_ondisk` 与启动路径——必须继续询问内核，因为形态与活规则
不一致的配置会丢路由或黑洞流量
（[ADR 0008](0008-takeover-namespace-boot-and-toggle-semantics.md)、
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）。

## 决策

**`runtime/rules` 是最后一次真实内核应答的读穿缓存，不是第二事实来源。**

- 文件携带 `boot=<boot_id>` 和 `present=<0|1>`。boot id 是
  `/proc/sys/kernel/random/boot_id` 每次开机铸造的那个，`runtime/status.json` 已在用
  （[ADR 0018](0018-no-action-button-and-no-boot-start.md)）。不涉及时钟。
- `kr_tp_install` 写 `present=1`，包括"规则已在位"的提前返回；`kr_tp_remove` 写
  `present=0`。两者都写当前 boot id。开关关闭、发现无规则的启动同样写 `present=0`，所以
  被外部 flush 弄陈旧的缓存由本就询问过内核的同一次启动修复。
- `kr_status_kv` 读缓存。可用的缓存（文件存在、boot id 匹配、值为 `0|1`）不碰 iptables 就
  作答。缺失或陈旧的缓存由一次真实的 `kr_tp_rules_present` 回答并通常写回（若询问内核期间
  有别的写入者改了缓存则跳过写回）。与版本缓存同一形状：`kr_version_cached` 未命中时本来
  就会刷新 `runtime/version`。
- 缓存按开机划界，因为 netfilter 是易失的：重启后旧 boot id 不再匹配，第一次轮询会重新
  检查内核，而不是信任一份出自规则已消失的开机的文件。`runtime/` 也会被模块更新清空
  （[ADR 0002](0002-everything-lives-in-the-module-dir.md)），所以更新后的未命中是正常
  路径，不是错误。
- `kr_tp_rules_present` 仍是权威检查，仍被 `kr_tp_form`、`kr_conf_accept_ondisk`、
  `kr_tp_install` 和 `tproxy status` CLI 调用。缓存绝不被它们读取。
- 状态输出保持 `rules=present|absent`；UI 无从得知缓存的存在。
- 缓存为 `0600`（它只带一个 boot id 和一个标志，但它与其他运行时状态同住，`kr_dirs` 会
  一并收紧权限）。

**状态路径同样不再为已有的事实 fork。**

- `kr_pid`、`kr_applied_id`、`kr_loglevel_get` 和版本缓存获得了设变量型读者
  （`kr_pid_read`、`kr_applied_read`、`kr_loglevel_read`、`kr_version_read`），
  `kr_boot_id` 改用 `read` 而不是 `sed`，所以状态轮询用读取代替每字段 fork 一个
  `cat`/`sed`。echo 风格的函数保留给其他调用方和覆盖它们的测试。
- `kr_status_kv` 一次读 `runtime/status.json`（一个 `awk`），而不是每字段一个 `sed`。
- `kr_settings_ports` 用一个 `awk` 解析两个入站端口；`kr_setting_port` 保留为其他调用方的
  单字段接口。渲染也用合并读者。

## 后果

- **稳态：每轮询零次 iptables、约十次 fork**（四个 applet——`tr` 和三个 `awk`——外加
  环绕它们的命令替换），从约三十次（含两次 iptables）降下来。2 s 轮询不再是可测量的后台
  开销。
- **开机、模块更新或缓存写入失败之后，第一次轮询付一次真实检查**（IPv4 链缺失则一次
  `iptables`，两族都应答则两次）。那是一个 tick 的旧行为，不是每个 tick。
- **外部 flush 在下一次安装/移除/启动之前不可见。** 若别的行为者删除链，缓存仍说
  `present=1`，UI 保留"接管已开启"提示。启动路径不受影响：它询问内核并修复缓存。这是
  建议性状态被接受的代价；手动刷新检查可以日后收窄这个窗口，而不必把 iptables 放回 2 s
  循环。
- **没有 boot id 即旧行为。** 在没有 `/proc/sys/kernel/random/boot_id` 的内核上，缓存无法
  校验，每次轮询都回退到内核检查。Android 暴露它；回退为完整性而存在。
- **Fail-closed 不变。** 规则、安装顺序和配置形态仍由启动时的内核检查决定。缓存只决定
  状态卡片说什么。

## 备选项

- **轮询里保留 iptables 对。** 正确，但它是 2 s 循环的主要开销，而问题在两次用户动作之间
  不可能有变化的答案。
- **从状态里去掉 `rules=`。** UI 失去"带接管运行"与"直连运行"的差别——恰是状态提示存在
  的理由。
- **仅存在的标记。** 只在规则存在时才存在的标记无法缓存"不存在"的答案：开关关闭时每次
  轮询都会未命中并检查。需要 `present=0`。
- **TTL 而不是 boot id。** TTL 需要墙钟，NTP 同步之前是错的、还会跳变；boot id 是模块为
  `status.json` 已经信任的信号
  （[ADR 0018](0018-no-action-button-and-no-boot-start.md)）。
- **让 `kr_tp_form` 也读缓存。** 那会让一份建议性文件对路由承重：规则已消失时的陈旧
  `present=1` 是黑洞。安全攸关的读者保留内核。
