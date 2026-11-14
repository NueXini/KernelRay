# 0009 — shell 从 state.json 的 settings 里读入站端口

状态：已接受（收窄 [ADR 0005](0005-core-config-is-derived.md) 的"shell 不读 `state.json`"
规则，而 0005 又扩展自 [ADR 0003](0003-webui-writes-state-json.md)）

## 背景

本地 socks/http 入站在配置模板里固定为 10808/10809。让它们可由用户配置，等于把核心意图的
另外两个字段交到 UI 手里：用户的选择必须抵达 shell 的渲染，而渲染会在 WebUI 不参与的路径
上被调用（开机、接管开关、`kr_ensure_config`）。

显而易见的桥——UI 为 shell 写一个扁平文件，镜像 `outbound.meta`——可行，但同一事实有了
第二份存储：state.json 的 `settings` 持有意图、镜像文件才是 shell 实际读的东西，两者可能
漂移。

## 决策

**`kr_render_config` 直接从 `state.json` 的 `settings` 里读这两个端口，用行级 `sed` 提取
`settings` 对象内的 `socksPort` / `httpPort`。** 模板的端口变成带引号的占位符
（`"__KERNELRAY_SOCKS_PORT__"`、`"__KERNELRAY_HTTP_PORT__"`），模板保持合法 JSON，shell 把
每个整段带引号的字符串替换为数字。

这是"shell 绝不解析 `state.json`"规则的一次有意的、狭窄的例外：

- 提取恰好读两个扁平整数键，其形状由 UI 拥有（UI 把 `state.json` 序列化为美化输出、每个键
  独占一行）。这不是通用 JSON 解析，也不再增长：路由/DNS 设置将来若加入，需要重审本 ADR
  或换真正的解析器。
- 缺失、解析失败或超范围的值 **逐字段** 回退到 10808/10809，所以一份手改美化的
  `state.json` 永远无法把入站踢下端口；最多只能把它重置为默认。
- 除此之外不从文件读任何东西。"设备上没有 `jq`"的负担被限制在两行 `sed` 里，
  `tests/config.test.js` 对其演练。

保存端口走的机制与节点应用相同：UI 写 `state.json`（意图先行），然后调 `kernelray.sh
ports`，它以已应用节点原样渲染候选、跑 `xray -test`，经相同的 备份 → 停止 → 换入 → 重启
→ 回滚 路径换入。已应用 id 不动：端口改的是本地入站，从不改出站。

## 后果

- UI 对 `state.json` 的写入形状现在对 shell 是承重的，不只是序列化细节：改 `writeState`
  美化输出的任何人必须让 `settings` 键独占一行。
- 与 tproxy 入站端口（10810）的冲突在 UI 拒绝，不在 shell；手改 `state.json` 声称占用它
  能通过 `xray -test`、在启动时失败，回滚路径能从中恢复。
- `state.json` 的 `settings` 对象不再是"保留、不解释"：`socksPort` 和 `httpPort` 被解释；
  其余字段原样保留。

## 被否决的替代方案

- **UI 在 `state.json` 旁边写一个扁平镜像文件（如 `inbound.meta`）。** 完全没有解析风险，
  但一个事实两份存储：shell 会从一个可能静默落后于 UI 所示意图的文件渲染。用户只挑了
  一个存储。
- **随包带 `jq`** 正经解析 `state.json`。又一个二进制、又一个要验证的架构，就为两个整数。
- **端口留在模板里、手改模板。** 模板在模块更新时被替换（ADR 0002），手改活不过更新；而
  ADR 0005 把 `config.json` 变成派生物，正是为了排除手改。
