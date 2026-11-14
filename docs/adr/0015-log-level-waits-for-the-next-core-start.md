# 0015 — 日志等级是 shell 的偏好，在下一次核心启动时生效

状态：已接受（下文"下次启动"规则中的"或重启"不再适用：开机不自启——见
[ADR 0018](0018-no-action-button-and-no-boot-start.md)。日志等级 现在是唯一的延迟偏好：
曾与它对比的 tproxy 开关已移除，见
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）

## 背景

核心的日志级别（`log.loglevel`）在配置模板里固定为 `warning`，设置页的通用卡片只装
WebView 偏好（主题、语言、日志缓冲）。用户想要那里有一个 日志等级 选择器。与那三者不同，
级别是 `config.json` 的一部分：Xray 在核心启动时读它，所以 WebView 的 localStorage 存
不了——shell 必须能在每次渲染时读到它（apply、ports、routing、开机）。

## 决策

- **五个 Xray 级别**：关闭（`none`）、错误、警告（默认）、信息、调试。偏好是
  `runtime/loglevel`；文件不存在、读不出、值未知都意味着 警告。
  `kernelray.sh loglevel <level>` 写入（写 警告 会移除文件），`loglevel status` 报告
  级别、`config.json` 里带的级别以及是否 pending。
- **它是下次启动偏好**，如同 tproxy 开关、不同于即时的 ports/routing：命令只写文件，绝不
  碰 `config.json` 或运行中的核心。`kr_start_locked` 把偏好与 `config.json` 里的级别
  比较，不同时在核心运行之前重渲染并 `-test` 配置——所以下一次启动或重启生效它。应用、
  保存端口或切换分流模式也会带上它，因为每次渲染都读偏好。
- **占位符归模板所有。** `config.example.json` 带 `"loglevel": "__KERNELRAY_LOGLEVEL__"`；
  渲染器用校验过的偏好替换它，并拒绝没有它的模板，与入站端口完全一样（ADR 0009）。
- **UI 读 shell，不读 localStorage。** `status` 增加 `loglevel=` 和 `loglevelpending=`；
  下拉框跟随偏好。运行中的核心仍带着旧级别时，该行显示"已保存；停止再启动核心后生效。"；
  已停止的核心不需要提示，因为它下一次启动就会应用已保存的级别。
- **其他一切不动。** `log.access` 保持 `none`，`log.dnsLog` 保持 `false`，模块自己的日志
  （`logs/kernelray.log`）没有级别、不受影响。

## 后果

- 级别变化是设置页唯一要等一次启动的偏好。这是有意的：改详细程度是诊断动作，静默重启
  运行中的核心（断掉每条连接，接管之下还会短暂 fail-closed）比等一下更糟。
- 运行中的核心需要 停止 → 启动，即 tproxy 开关的手势；带已应用节点的已停止核心在下一次
  启动拿到级别；重启同样应用它。
- 模块更新把级别重置为 警告，连同 `runtime/` 其余部分（ADR 0002）。
- 调试 写得很多，而本版本没有任何东西轮转 `xray.log`。README 有说明；轮转或大小上限是
  另一个功能，不属于这个旋钮。

## 考虑过的选项

- **立即生效（渲染 + 测试 + 重启），ports/routing 模式** — 不用等，但一个诊断旋钮会断掉
  每条连接。否决，取 tproxy 开关的承诺：改配置的偏好等下一次启动。
- **Xray 的 `api restartlogger` 热重载** — 需要在生成的配置里放 `api` 入站及其服务：新的
  本地监听与攻击面，外加停止核心情形的第二条代码路径。为日志详细程度不值得。
- **`state.json` 的 `settings`** — shell 能读它（ADR 0009），但那个例外明确止步于两个整数，
  而且那样 shell 会往 UI 的文件里写字符串字段（或 UI 得拥有一次配置变更）。`runtime/`
  是 shell 偏好已经住着的地方（ADR 0011、0014）。
- **只存 localStorage** — WebView 够不到 `config.json`，级别永远变不了；否决。
- **调试 时顺带打开 `dnsLog` 或访问日志** — 是有不同隐私与体量代价的不同开关；一个下拉框
  只控制一件事。
