# Xray 官方指南（对照本模块读）

本模块生成的 `config.json` 就是 [Xray-core](https://github.com/XTLS/Xray-core) 的标准配置文件
——`xray -test` 能过，是因为它就是一份合规的 Xray 配置，只是由脚本渲染、模块固定了其中
一部分。想深入理解某个字段为什么这么写，去读官方文档：

- **官方站点**：<https://xtls.github.io/>（中文为主，英文 / 俄文翻译在 `/en` `/ru` 路径下）
- **配置文档入口**：<https://xtls.github.io/config/>
- **使用手册入口**：<https://xtls.github.io/document/>

下面的链接都核对过是官方站点的真实页面。

## 想系统学，按这个顺序读

| 阶段 | 页面 | 内容 |
| --- | --- | --- |
| 入门 | [使用手册](https://xtls.github.io/document/) | 手册总目录，从零搭起一套服务端 + 客户端 |
| 入门 | [Level-0 新手教程](https://xtls.github.io/document/level-0/) | 买 VPS、SSH、证书、装 Xray，完全零基础 |
| 进阶 | [路由 + DNS 分流](https://xtls.github.io/document/level-1/routing-with-dns.html) | `geosite`/`geoip` 分流与 DNS 拆分的原理——大陆直连模式就是这套思路 |
| 进阶 | [透明代理（TPROXY）](https://xtls.github.io/document/level-2/tproxy.html) | TPROXY 接管的机制本身；本模块的 iptables 规则是它的模块化封装 |

## 配置文件五大块 × 本模块谁在生成

Xray 配置由 `log` / `inbounds` / `outbounds` / `dns` / `routing` 五大块组成
（[总览](https://xtls.github.io/config/)）。本模块里，模板是
[`module/config.example.json`](../module/config.example.json)（`__KERNELRAY_*__` 占位符），
拼装逻辑在 shell 里，推导规则见 [`config-derivation.md`](config-derivation.md)：

| 配置块 | 官方文档 | 本模块的使用 |
| --- | --- | --- |
| `log` | [log.md](https://xtls.github.io/config/log.html) | 错误日志写 `logs/xray.log`；WebUI 设置里的日志等级就是这里的 `loglevel`（[ADR 0015](adr/0015-log-level-waits-for-the-next-core-start.md)） |
| `inbounds` | [总览](https://xtls.github.io/config/inbound.html) | 三个入站：socks / http 本地入站 + tproxy 接管入站（见下） |
| `outbounds` | [总览](https://xtls.github.io/config/outbound.html) | 节点出站（由 WebUI 渲染）+ `direct`（freedom）+ `block`（blackhole）+ `dns-out` |
| `dns` | [dns.md](https://xtls.github.io/config/dns.html) | DNS 模块，大陆直连模式里做国内外分流解析（[ADR 0006](adr/0006-dns-goes-through-the-core.md)） |
| `routing` | [routing.md](https://xtls.github.io/config/routing.html) | 全局 vs 大陆直连的规则块，也是模块固定布局（[ADR 0005](adr/0005-core-config-is-derived.md)） |

## 本模块用到的每个组件 → 官方文档

### 入站（inbounds）

| 本模块的入站 | 协议文档 | 说明 |
| --- | --- | --- |
| `socks-in`（127.0.0.1:10808） | [socks.md](https://xtls.github.io/config/inbounds/socks.html) | 本地 socks5 入站，`udp: true`；无认证 |
| `http-in`（127.0.0.1:10809） | [http.md](https://xtls.github.io/config/inbounds/http.html) | 本地 http 代理入站 |
| `tp-in`（:10810，仅接管时） | [dokodemo-door.md](https://xtls.github.io/config/inbounds/dokodemo-door.html) | 透明代理入站：`followRedirect: true` 接收 iptables TPROXY 转来的流量，`sockopt.tproxy: "tproxy"` 是接收端套接字选项（见 [sockopt.md](https://xtls.github.io/config/transports/sockopt.html)） |

### 出站（outbounds）

| 本模块的出站 | 协议文档 | 说明 |
| --- | --- | --- |
| 节点出站（WebUI 渲染） | [vless](https://xtls.github.io/config/outbounds/vless.html) / [vmess](https://xtls.github.io/config/outbounds/vmess.html) / [trojan](https://xtls.github.io/config/outbounds/trojan.html) / [shadowsocks](https://xtls.github.io/config/outbounds/shadowsocks.html) / [socks](https://xtls.github.io/config/outbounds/socks.html) / [http](https://xtls.github.io/config/outbounds/http.html) | 分享链接解析后渲染成哪个协议，出站就是哪个 |
| `direct` | [freedom.md](https://xtls.github.io/config/outbounds/freedom.html) | 直连出站；带 `sockopt.mark: 19282` 打旁路标记，避免核心自己的连接被 TPROXY 规则再次捕获 |
| `block` | [blackhole.md](https://xtls.github.io/config/outbounds/blackhole.html) | 黑洞，拦截不想放行的目标 |
| `dns-out` | [dns 出站](https://xtls.github.io/config/outbounds/dns.html) | 把被路由规则指过来的 DNS 流量交给 DNS 模块处理 |

节点出站的 `streamSettings`（TLS / REALITY / WebSocket / gRPC / XHTTP 等传输层）官方文档在
[transports/](https://xtls.github.io/config/transports/)，其中
[TLS](https://xtls.github.io/config/transports/tls.html) 与
[REALITY](https://xtls.github.io/config/transports/reality.html) 最常遇到。

### DNS 与分流

- **DNS 模块**：[dns.md](https://xtls.github.io/config/dns.html)。本模块固定 DoH
  `https://1.1.1.1/dns-query` 走节点；大陆直连模式里大陆域名改问 `223.5.5.5` /
  `119.29.29.29` 并用 `expectIPs: ["geoip:cn"]` 过滤——`expectIPs` 的语义见官方文档的
  DNS 服务器条目。
- **路由规则**：[routing.md](https://xtls.github.io/config/routing.html)。大陆直连的
  规则就是官方的 `geosite:cn` / `geoip:cn` 用法；`domainStrategy: "IPIfNonMatch"` 的含义
  （域名查不到分类就先解析再按 IP 匹配）也在这一页。
- **geo 数据**：[geodata.md](https://xtls.github.io/config/geodata.html)。`geosite.dat`
  里有哪些类别、`geoip` 怎么写。本模块发布版固定
  [Loyalsoldier](https://github.com/Loyalsoldier/v2ray-rules-dat) 的数据，因为它额外带
  更多类别。

## 命令行

本模块只用两个命令，完整说明见 [command.md](https://xtls.github.io/document/command.html)：

| 命令 | 本模块哪里在用 |
| --- | --- |
| `xray run -c config.json` | `service.sh` 启动核心、切节点后重启 |
| `xray -test -c config.json` | 应用节点 / 切换分流模式前先验证配置，失败即回滚 |

环境变量（如 `XRAY_LOCATION_ASSET` 改 geo 数据路径）见
[env.md](https://xtls.github.io/config/env.html)——本模块用工作目录默认值，没设这些变量。

## 读官方文档时的注意点

官方文档默认你在**自己控制的服务器**上跑 Xray，而本模块把核心装在 Android 设备上、
接管整机流量。对照阅读时注意三处差异：

1. **固定布局 vs 可自由设计**。官方教程让你自己设计 inbound/outbound/dns/routing 的组合；
   本模块的 `tp-in`、`dns-out`、bypass 标记和路由块是模块固定布局，WebUI 只渲染节点出站
   和分流模式。想改布局属于改模块（见 [ADR 0005](adr/0005-core-config-is-derived.md)），
   不是改配置。
2. **官方 TPROXY 教程的 iptables 规则不要手抄到设备上**。本模块自带规则安装与冲突检测，
   外来的 `-j TPROXY` 规则会被判为冲突、接管拒绝启动。读
   [Level-2 tproxy](https://xtls.github.io/document/level-2/tproxy.html) 是为了理解机制，
   实际规则以 [`module/scripts/tproxy.sh`](../module/scripts/tproxy.sh) 为准。
3. **服务器端内容（证书、fallbacks、VLESS 入站）与本模块无关**。本模块只做客户端；
   Level-0/1 里搭服务器的章节可以跳过，除非你在自建节点。
