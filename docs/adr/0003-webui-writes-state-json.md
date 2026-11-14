# 0003 — WebUI 写 `state.json`

状态：已接受

## 背景

此前 UI 是严格只读的：shell 拥有模块碰的每一个文件，WebUI 只渲染它看到的。节点导入打破
了这一点。导入必须解析分享链接（`vmess` 的 JSON 套 base64、两种不同的 `ss://` 形态、
百分号编码的凭据）并把结果合并进一份 JSON 文档——设备上没有 `jq`，而用 `awk`/`sed` 做
URI 解析是一个我们会永远背着的负担。

所以这里有一个真实的分叉：在 shell 里解析、保持 UI 只读，或者让 UI 写。

## 决策

UI 解析并写 `state.json`。划分变成：

| 写入者 | 文件 | 性质 |
| --- | --- | --- |
| shell | `runtime/status.json`、`runtime/xray.pid`、`config.json`、`logs/` | 运行时事实，派生 |
| WebUI | `state.json` | 用户意图 |

维持这一划分诚实性的规则：

- **一文件一写入者。** shell 绝不写 `state.json`；UI 绝不写 `status.json`。不需要锁，
  因为没有可竞争的东西。
- **写入是原子的。** JSON 被 base64 后写进 `state.json.tmp`，`chmod 600`，然后 `mv` 盖到
  `state.json` 上。写入中途被杀不会留下截断的节点库，其中的凭据也不会有一瞬间对世界可读。
- **UI 修改它读到的。** 它解析现有文件、合并进那个对象、再序列化回去，所以它不认识的
  字段能在旧构建的写入后幸存。
- **解析器对着随包文件测试。** `tests/parse.test.js` 从 `module/webroot/app.js` 里抽取打了
  标记的块来跑；没有会漂移的第二份解析器。这也是 WebUI 能保持手写 HTML/CSS/JS、没有构建
  步骤的原因。

## 后果

- schema 需要一份成文的权威，否则"UI 写什么"只能靠读 JS 才知道：见
  `docs/state-schema.md`。
- 导入的质量上限是页面的 JS 运行时。可以接受——否则就要在一台既没有 `jq` 也没有
  `python` 的设备上用 shell 写 URI/JSON 解析器。
- 应用节点（把 `state.json` 变成 `config.json` 并重启核心）仍是 shell 的活：那是派生产物，
  UI 绝不能假装核心已经变了。
