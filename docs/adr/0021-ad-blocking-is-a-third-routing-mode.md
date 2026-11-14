# 0021 — 去广告是第三种分流模式

状态：已接受（它放进 DNS 模块的广告沉没端现在是无条件的：它对比的 空转 形态已不存在，
它借鉴安装时默认先例的 `kr_tp_default_on` 也随开关一起移除——见
[ADR 0011](0011-tproxy-switch-defaults-on-and-follows-the-core-start.md)）

## 背景

ADR 0014 买下的 地理数据 本就带着广告列表：`category-ads-all` 是 EasyList、EasyListChina、
AdGuard DNS Filter、Peter Lowe 和 Dan Pollock 的并集——钉死的那套里有 905 条——钉死的
Loyalsoldier 集与核心 ZIP 里的 XTLS 集都带它。数据从来不是缺的那块。0014 拒绝的是把
`geosite:category-ads-all` → `block` 捆进 大陆直连，理由是模式的名字承诺"大陆走直连"，
不是"广告被拦"；模板的 `block` 出站留在原地、未使用，"等那个编辑器"。用户想要 去广告，
而且要它作为 **再加一种 分流模式** 而不是第二个独立开关：`大陆直连去广告` /
`Direct-CN-Adblock`，持久化为 `runtime/route` 里的 `cnadblock`。

机制不是免费的。`tp-in` 没有 `sniffing`，所以对被接管的流量，核心只见 IP:port——
`domain` 和 `geosite` 规则永远匹配不上它，这正是设备上的 大陆直连 只按 `geoip` 匹配的
原因。DNS 模块则总是看到域名。本决策对照过的两份参考都用了 **两半**：v2fly 的 DNS 文档
示例 `"hosts": {"geosite:category-ads-all": [...]}`，Loyalsoldier 的 README（钉死那套的
上游）在路由里给 `{"outboundTag": "Reject", "domain": ["geosite:category-ads-all"]}` *同时*
在 DNS 里给同一个 `hosts` 条目。Xray 自己的文档两者都没示例——它只记载原语（带 `geosite:`
键的 `hosts`、`#<rcode>`、`blackhole`）——所以本 ADR 记录的是一个组合，不是抄来的配方。

## 决策

- **第三种 分流模式，不是正交开关。** `runtime/route` 装 `cn` 或 `cnadblock`（不存在 =
  全局）：文件不再是存在标志，而成为值。大陆直连去广告 的路由与 大陆直连 完全一致、额外
  拦截广告。
- **两个广告部分，各放在它能存在的地方**：`dns.hosts` 拒绝 `geosite:category-ads-all` 点名
  的域名（仅接管形态——空转 形态没有 dns 模块），`{"domain": ["geosite:category-ads-all"],
  "outboundTag": "block"}` 进两种形态的路由块。路由规则放在 dns/端口-53 组 **之后**、geo
  直连规则 **之前**：先命中先赢，所以大陆广告域名绝不能落进 `geosite:cn` → `direct`，
  解析器查询也绝不能被 block 规则吞掉。
- **`category-ads-all` 固定**，不是列表间的选择，也没有逐列表选择器。
- **没有 全局 + 去广告 的格子。** 枚举四格中三格是有意可达的；将来的 `globaladblock` 是
  第四个值，不是新模型。
- **Fail-closed，不同于 `cn`。** `cnadblock` 永不降级：`bin/*.dat` 缺失、或数据集里没有
  `CATEGORY-ADS-ALL`，拒绝启动（`failed config-invalid`），`kernelray.log` 里一行
  `Routing`、stderr 上一短句让 WebUI 弹 toast——缺文件在启动前被拦下，缺分类由核心自己的
  `-test` 拦下。文件缺失时 `routing cnadblock` 提前拒绝。理由是把 0014 自己的教训反着读：
  一个名叫 去广告 的模式静默渲染成 大陆直连，就是一个名字在撒谎的模式。
- **`block` 保持 `settings: {}`**：blackhole 立即关闭连接（`type: "none"` 是默认），那是一
  次快速失败；Loyalsoldier 的 `response: http` 在这里不需要。
- **偏好的生命周期是 `routing` 的**，不是 tproxy 开关的：渲染 → `-test` → 写
  `runtime/route` → 换入，新配置起不来时恢复旧值。
- **`大陆直连去广告` 是安装时默认。** 偏好未设时安装器写 `runtime/route` = `cnadblock`
  ——ADR 0011 的 `kr_tp_default_on` 模式——所以全新安装不挑任何东西就完成大陆分流和广告
  拦截，全局 成为选项而不是选项的缺席。geo 数据缺失时安装器跳过默认、留下 全局：核心
  拒绝以其启动的默认值，比一个少做事的默认值更糟。因此 `.dat` 文件消失后的一次启动对全新
  安装同样拒绝——上面的 fail-closed 条款，如今经默认而非经选择到达。

## 考虑过的选项

- **正交的 去广告 开关**（`runtime/adblock`，渲染进任一模式）：词汇表本来会偏好的形状，
  因为 分流模式 可以继续只指"其余流量从哪出去"，全局 + 去广告 也可表达。否决，因为用户
  要的是一个模式；代价是上面缺的那个格子，逃生门是第四个枚举值。
- **只走路由**（Loyalsoldier 的前一半）：在设备上什么都拦不住，因为 `tp-in` 看到 IP，不是
  域名。它会看起来实现了、实则什么都没做。
- **只走 DNS**（v2fly 的示例）：留下 空转 和自带域名的 socks/http 客户端不拦。
- **给 `tp-in` 开 `sniffing`** 让纯 IP 连接能按 SNI 匹配：更强——它还能抓住自带 DoH 的
  应用——但它改变 大陆直连 对设备流量的既有行为（`geosite:cn` 将开始匹配被接管的连接），
  所以那是它自己的决策，不是本决策的细节。
- **像 `cn` 那样降级**（渲染全局形态、记日志）：0014 选的安全方向，也是上文 fail-closed
  条款需要自己论证的原因。
- **`category-ads`（845）或 `category-ads-and-telemetry`（877）**：分别更窄和更广；`-all`
  是 0014 点名的、也是数据自带 README 记载的并集。

## 后果

- 全局 和 大陆直连 逐字节照旧渲染；只有 `cnadblock` 渲染带广告部分。
- 安装默认是偏好，不是常量：挑了 全局 的用户得到文件不存在，而下一次安装或更新会重建
  `cnadblock`——tproxy 开关的行为，ADR 0002/0011 已接受的同一取舍（更新重置它拥有的
  偏好）。
- 渲染不再用字符串比较 `= cn`：`kr_route_effective` 设置 `KR_ROUTE_CN` 和
  `KR_ROUTE_BLOCK_ADS`，DNS/路由构建器读这些标志，所以日后第四个值不可能静默漏掉分支。
- 模式为 `cnadblock` 时 `.dat` 文件消失的设备 **在下一次启动失去网络**：接管规则在配置
  测试之前装入（ADR 0011），测试失败，核心永不运行——fail-closed 丢弃流量，直到用户在
  WebUI 挑另一个模式。接受，而且这正是 CLI 提前拒绝的原因。
- 广告变成失败的连接而不是被拦的连接，三类始终拦不到：广告出自内容自己的域名（YouTube
  应用内）、自带 DoH/DoT 的应用、硬编码 IP。没有任何分类能点名它们。
- WebUI 的下拉框及其提示、`routing` 的用法与状态、`status` 的 `route=`/`routing=`、
  `docs/config-derivation.md`、`docs/state-schema.md`、`docs/xray-guide.md` 和
  `bin/README.md` 的分类列表都增加第三个值；`tests/adblock.test.js` 承载新的渲染矩阵。
  `README.md` 和 `module.prop` 仍描述两个模式：本次变更有意不碰它们，所以它们的措辞如今
  比代码窄。
