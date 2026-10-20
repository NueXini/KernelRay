# 开发循环：用 adb 装模块、验证、看 UI

这份文档记录的是**实际跑通过**的流程（Android 15 模拟器 + KernelSU 3.2.5），不是从文档里抄的。
所有命令都在 Git Bash / MSYS 下执行，`D` 是设备序列号：

```sh
D=127.0.0.1:5555          # 模拟器；真机换成 adb devices 里的序列号
```

## 0. 前提

| 需要 | 说明 |
| --- | --- |
| 主机工具 | `bash`、`zip`（或 `7z`）、`node` ≥ 18（跑单测） |
| 设备 | 已 root（KernelSU），`ksud` 可用，busybox 在 `/data/adb/ksu/bin/busybox` |
| 核心 | `module/bin/xray`（arm64）已就位，否则打包会失败 |
| 管理器 | 只有要看 WebUI 时才需要；装/卸/验证全都能在 adb 里完成 |

## 1. 先跑单测（改了解析器就一定要跑）

```sh
node tests/parse.test.js      # 24 parser tests passing
```

测试是从 `module/webroot/index.html` 里抽出解析器跑的，测的就是要发布的那个文件。

## 2. 打包

```sh
bash scripts/pack.sh          # → build/kernelray-<versionCode>-<version>.zip
ls -l build/                  # 确认时间戳是刚才的，别推了旧包
```

有核心时约 12 MB。ZIP 内容是 `module/` 的**根**，并排除 `config.json`/`state.json`/`logs/`/`runtime/`。

## 3. 推包到设备

```sh
adb -s $D push build/kernelray-50-v0.5.0.zip //data/local/tmp/kernelray.zip
```

> **Windows/MSYS 坑**：`/data/...` 会被改写成 `C:/Users/.../data/...`。两种写法都行：
> `MSYS_NO_PATHCONV=1 adb -s $D push ...`，或路径写 `//data/local/tmp/...`（双斜杠）。
> 同理 `adb shell uiautomator dump //sdcard/ui.xml`。

## 4. 安装（必须 root，必须给设备端路径）

```sh
adb -s $D shell 'su -c "ksud module install /data/local/tmp/kernelray.zip"'
```

输出里三行是有意义的：

```
  core: Xray 26.3.27 (... android/arm64)     ← customize.sh 探测核心成功
- Installing to /data/adb/modules_update/kernelray
- Module installed successfully!
```

注意路径里的 **`modules_update`**：KernelSU 只是暂存，**还没生效**。

## 5. 生效 = 重启 + 等 boot_completed + 再等一会儿

```sh
adb -s $D reboot
adb -s $D wait-for-device
for i in $(seq 1 30); do
  [ "$(adb -s $D shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
sleep 10    # service.sh 在 late_start 阶段才跑；模拟器上核心还要经 ARM 翻译起来
```

- **为什么要重启**：KernelSU 把新包解到 `/data/adb/modules_update/<id>`，开机时才替换
  `/data/adb/modules/<id>`。所以“装成功了但版本没变”= 没重启。
- **为什么还要 sleep**：`sys.boot_completed=1` 时 `service.sh` 通常还没执行完，太早 `ps` 会误判“核心没起来”。

## 6. 验证（四条，缺一条都不算装好）

```sh
# 1) 进程只应有一个，且指向模块目录里的二进制
adb -s $D shell 'ps -A -o PID,ARGS | grep "[x]ray run"'
#  houdini64 /data/adb/modules/kernelray/bin/xray ... run -c /data/adb/modules/kernelray/config.json

# 2) 模块自报状态
adb -s $D shell 'su -c /data/adb/modules/kernelray/scripts/kernelray.sh status'
#  state=running  phase=idle  pid=...  conf=...  log=...

# 3) 文件都在模块目录里，权限正确
adb -s $D shell 'ls -l /data/adb/modules/kernelray/{state.json,logs,runtime}'

# 4) 真的在转发（不是只看进程活着）
adb -s $D forward tcp:11080 tcp:10808
curl -sS -o /dev/null -w '%{http_code}\n' \
  --socks5-hostname 127.0.0.1:11080 https://www.gstatic.com/generate_204   # → 204
```

`grep "[x]ray"` 里的方括号是为了不让 `grep` 匹配到自己那条进程，否则永远数出 2 个。

## 7. 打开 WebUI / 点按钮

```sh
adb -s $D shell 'monkey -p me.weishu.kernelsu -c android.intent.category.LAUNCHER 1'
adb -s $D shell input tap 675 1856     # 底部导航「模块」
adb -s $D shell input tap 262 1047     # 卡片上的 <> 图标 = WebUI（▶ 是 action.sh）
adb -s $D exec-out screencap -p > build/ui.png
```

坐标是 **1080×1920 这台模拟器**上的实测值，换个分辨率就不对。稳妥做法是先截图看，或：

```sh
adb -s $D shell uiautomator dump //sdcard/ui.xml
adb -s $D exec-out cat //sdcard/ui.xml > build/ui.xml   # 找 text="..." 的 bounds="[x1,y1][x2,y2]"
```

不用 UI 也能操作：

```sh
adb -s $D shell 'su -c "ksud module action kernelray"'   # = 点 ▶，跑 action.sh（启停切换）
```

## 8. 在 WebUI 里输入文字（最容易上当的一步）

- 先 `input tap` 点中输入框，**等 2–3 秒**，再用 `input keyboard text '<内容>'`。
- 只在**空输入框**上可靠。第二次调用是**插入到光标处**，不是替换 —— 想重来就清空：
  ```sh
  adb -s $D shell input keyevent 113 29 67    # CTRL+A, DEL
  ```
- `input text`（不带 `keyboard`）在这个 WebView 里经常完全不生效；`input keyevent 29`（A）这类单键注入也不稳定。
- WebView 会**恢复表单状态**：重装模块后旧内容可能又冒出来。要干净的页面：
  ```sh
  adb -s $D shell am force-stop me.weishu.kernelsu
  ```

## 9. 模拟升级 / 卸载

```sh
# 升级 = 提高 versionCode → 重打包 → 重复 2~6 步
#   注意：模块目录被整体替换，state.json / config.json / logs 会被清空（docs/adr/0002）

# 卸载（只是打标记，重启才真正删）
adb -s $D shell 'su -c "ksud module uninstall kernelray"'
adb -s $D reboot && sleep 30
adb -s $D shell 'ls -d /data/adb/modules/kernelray; ps -A -o PID,ARGS | grep -c "[x]ray run"'
#   期望：目录不存在、进程数 0、/data/adb 下没有残留（ksu/ksud/modules/modules_update 除外）
```

## 10. 排错表

| 症状 | 原因 / 做法 |
| --- | --- |
| 安装成功但版本没变 | 没重启，包还在 `modules_update` |
| `phase=no-core` / `failed` | `bin/xray` 缺失或不可执行（x86_64 模拟器靠 houdini64 翻译 ARM 二进制） |
| 出现两个 `xray run` | KernelSU 会重复执行 `service.sh`；现在靠 `mkdir` 原子锁 + 清理残留进程兜住 |
| 状态轮询卡顿 | `xray -version` 在 ARM 翻译下要 0.44s；已缓存到 `runtime/version`，正常一次 0.05s |
| `uname -m` 显示 aarch64 但设备是 x86_64 | 模拟器的 ARM 翻译；不要据此挑架构，只有一个 arm64 二进制 |
| `push` 报错、路径变成 `C:/...` | MSYS 路径改写，用 `//data/...` 或 `MSYS_NO_PATHCONV=1` |
| `logcat` 里搜不到 kernelray | `service.sh` 的 stdout 不进 logcat；看 `logs/xray.log` 或 `kernelray.sh log 50` |
| 端口测试 000/超时 | 忘了 `adb forward`，或没用 `--socks5-hostname`（域名解析也走代理才叫真通） |

## 11. 一条命令走完（复制粘贴用）

```sh
D=127.0.0.1:5555
node tests/parse.test.js || exit 1
bash scripts/pack.sh || exit 1
zip=$(ls -t build/kernelray-*.zip | head -1)
adb -s $D push "$zip" //data/local/tmp/kernelray.zip || exit 1
adb -s $D shell 'su -c "ksud module install /data/local/tmp/kernelray.zip"' | grep -E 'core:|successfully' || exit 1
adb -s $D reboot; adb -s $D wait-for-device
for i in $(seq 1 30); do
  [ "$(adb -s $D shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done
sleep 10
adb -s $D shell 'su -c /data/adb/modules/kernelray/scripts/kernelray.sh status'
adb -s $D forward tcp:11080 tcp:10808 >/dev/null
curl -sS -o /dev/null -w 'socks=%{http_code}\n' --socks5-hostname 127.0.0.1:11080 https://www.gstatic.com/generate_204
```
