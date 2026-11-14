# 0005 — 核心配置是派生的；UI 渲染节点，shell 拼装

状态：已接受（扩展 ADR 0003；`config.json` 不再归用户所有；UI 的"先选中后应用"规则被
[ADR 0007](0007-one-tap-switches-the-node.md) 修订；下文的渲染/测试/换入机制被
[ADR 0017](0017-one-render-one-test-per-switch.md) 修订）。文件表中的 `runtime/tproxy` 一行
已移除，渲染只有一种形态而非两种——见
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)。

## 背景

v0 把 `config.example.json` 复制成 `config.json` 一次，此后该文件归用户所有。应用节点与
启用 TPROXY 改变了这一点：核心配置现在必须携带已应用节点的出站、tproxy 入站、DNS 与路由
规则、以及 socket mark。手改它会静默作废接管的各条不变量。

显而易见的划分——shell 写派生产物、UI 写意图——撞上一个硬事实：`state.json` 是嵌套 JSON
而设备上没有 `jq`。用 `awk`/`sed` 解析它，就是 ADR 0003 对分享链接已经拒绝过的同一个
负担。

## 决策

**`config.example.json` 变成配置模板，`config.json` 变成绝不手改的生成物。** 生成沿双方
实际知道的东西切分：

| 写入者 | 文件 | 性质 |
| --- | --- | --- |
| WebUI | `state.json` | 用户意图：节点库、已选中节点 |
| WebUI | `outbound.meta` + `outbound.json` | 已选中节点渲染成的一条 Xray 出站，及其 id/host |
| shell | `config.json` | 派生：模板 + 出站 + 接管状态 |
| shell | `runtime/tproxy`、`runtime/applied` | 接管开关、已应用节点 id |
| shell | `runtime/status.json`、`runtime/xray.pid`、`logs/` | 运行时事实 |

维持诚实性的规则：

- **一文件一写入者。** UI 绝不写 `config.json`、`status.json` 或开关；shell 绝不写
  `state.json`、`outbound.json` 或 `outbound.meta`。不需要锁。
- **UI 渲染数据，shell 掌握布局。** 协议知识（vless/vmess/trojan/ss、传输层、TLS/REALITY）
  留在经过测试的 JS 渲染器里；入站、路由、DNS、固定出站和接管规则留在 shell 的模板里。
  渲染器有意不给节点出站打 socket mark：在 Android 上，没有匹配 ip 规则的任意 `SO_MARK`
  会丢路由（v0.6 验证：去掉 mark 之前节点的 Reality 握手失败）。模板固定的 `direct` 出站
  携带 v0.7 旁路标记；v0.7 必须把节点 mark 与旁路规则作为同一次变更加入。
- **应用是一次 CLI 操作。** UI 写 `outbound.meta`、再写 `outbound.json`，然后调用
  `kernelray.sh apply <id>`。shell 写 `config.new.json`、跑 `xray -test`、原子换入、重启
  运行中的核心并记录已应用 id。测试失败则旧配置与运行中的核心原封不动。
- **开关同样重写配置。** 接管关闭时模板没有 tproxy 入站，直连状态的模块就不会监听一个
  局域网对端可达的 tproxy 端口。切换开关因此重启核心。
- **已选中不是已应用。** `state.selected` 是用户想要的；`runtime/applied` 是核心在跑的。
  UI 必须展示差异，而不是假装一次选择改变了流量。

## 后果

- 手写 Xray 配置不再受支持。README 和安装提示必须说明；模板是将来覆盖机制的扩展点。
- `outbound.json` 含凭据，享受与 `state.json` 相同的 `0600` 原子写入待遇；`pack.sh` 必须把
  它和 `outbound.meta` 排除，如同 `state.json` 与 `config.json`。
- 生成的配置依赖已应用节点的主机名作为 DNS 自举例外（ADR 0006），meta 文件因此携带它。
- 生成可以在两个独立部分里测试：JS 渲染器对固定节点，shell 拼装对固定出站。
- ADR 0003 的划分仍然成立：shell 写派生的 `config.json` 并重启运行中的核心；本 ADR 只是把
  UI 渲染的出站加为那一步的输入，因为 shell 解析不了 `state.json`。

## 被否决的替代方案

- **UI 写整份 `config.json`。** 文件更少，但把模块的配置布局（以及接管的各条不变量）搬进
  浏览器，而且开关变化时 CLI 将无法重新推导配置。
- **shell 用 `awk`/`sed` 解析 `state.json`。** 与 ADR 0003 同理否决。
- **随包带 `jq`（或其他 JSON 工具）。** 又一个二进制、又一个要验证架构的产物，而这次变换
  的输入已经由 UI 渲染好了。
- **保持 `config.json` 归用户所有、把模块的部分补进去。** 需要感知 JSON 的补丁而没有
  `jq`，招致 tag 冲突，而且让 tproxy 不变量变成可关闭的。
