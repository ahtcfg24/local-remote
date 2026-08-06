# Local Remote

[English](README.md) · [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

一款开源、移动优先的 macOS 局域网远程控制工具。手机无需安装 App，使用 Safari、Chrome 等现代浏览器即可查看并控制 Mac。

> Local Remote 只面向可信局域网，不提供 TLS 或账号系统。请勿把服务端口暴露到公网。

## 为什么选择 Local Remote？

- **为手机操控设计：** 触控板和直触模式、拖拽、右键、惯性滚动、捏合缩放、横屏与全屏。
- **实用的键盘能力：** 支持中文等输入法文本、修饰键、方向键、长文本和常用 macOS 快捷键。
- **低延迟原生采集：** ScreenCaptureKit 仅在画面变化时推流，CGEvent 按顺序处理鼠标与键盘输入。
- **控制端零安装：** 扫描终端二维码，直接使用手机已有浏览器。
- **本地、透明：** 无云端中继、无统计分析、无账号、无第三方运行时服务。
- **macOS 服务托管：** 一条命令安装用户级 launchd 服务，支持登录自启与崩溃恢复。

## 系统要求

- macOS 13 或更高版本
- Node.js 20 或更高版本
- 同一可信局域网内的手机或电脑
- Mac 上的屏幕录制和辅助功能权限

## 快速开始

```bash
git clone https://github.com/ahtcfg24/local-remote.git
cd local-remote
./start.sh
```

脚本会安装依赖、构建原生组件、启动 launchd 用户服务并打印访问地址。扫描日志中的二维码，或打开类似下面的地址：

```text
http://192.168.1.8:8787/?token=<自动生成的密钥>
```

随机生成的 256 位 token 会以仅当前用户可读的权限保存在 `.run/token`。页面加载后，浏览器会把 token 保存在当前会话并从可见地址栏移除。需要主动分享完整访问地址时，请使用页面中的「复制地址」。

### macOS 权限

Local Remote 需要：

- **屏幕录制：** 采集主显示器画面。
- **辅助功能：** 注入鼠标和键盘事件。

在网页中选择「授权引导」，或运行：

```bash
./remote.sh guide
```

系统设置中的两项权限都应授予 **Local Remote Agent**；launchd 以该 App 作为顶层服务进程，再由它托管 Node 和控制 worker，因此授权引导、状态检测和实际控制使用同一个 TCC 责任主体。辅助功能授权会被运行中的进程自动识别。授权屏幕录制后，如果采集没有自动开始，请重启服务。

源码构建默认使用本机 ad-hoc 签名，因此修改并重新编译 Swift agent 后，macOS 可能要求重新授权。如有持久的 Apple 开发者签名身份，可在构建时设置 `LOCAL_REMOTE_CODESIGN_IDENTITY`，使权限在 agent 更新后继续匹配：

```bash
LOCAL_REMOTE_CODESIGN_IDENTITY="Apple Development: ..." npm run build:native
```

## 服务命令

```bash
./start.sh             # 安装或更新，然后启动
./start.sh status      # 查看服务状态和本机访问地址
./start.sh restart     # 更新配置并重启
./start.sh stop        # 停止服务，但保留登录自启配置
./start.sh logs        # 持续查看服务日志
./start.sh doctor      # 检查 macOS、工具、构建和 token 状态
./start.sh uninstall   # 移除 launchd 服务，保留 token 和日志
```

`./remote.sh` 继续作为这些命令的兼容入口。前台开发可使用 `npm start`。

## 手机端手势

| 手势 | 触控板模式 | 直触模式 |
| --- | --- | --- |
| 单指移动 | 带加速度地移动光标 | 光标移动到触点位置 |
| 轻点 / 双击 | 单击 / 双击 | 在触点位置单击 / 双击 |
| 双击后按住移动 | 拖拽 | — |
| 按住后移动 | — | 0.3 秒后开始拖拽 |
| 长按 | 右键 | 右键 |
| 两指移动 | 惯性滚动 | 惯性滚动 |
| 两指轻点 | 右键 | 右键 |
| 捏合 | 缩放远程画面 | 缩放远程画面 |

手机首次访问会显示内置手势引导。底部快捷栏可切换模式、打开键盘、右键、锁定拖拽和调整视图。

## 配置

复制 `.env.example` 为 `.env`，或在启动前导出环境变量：

```bash
cp .env.example .env
./start.sh restart
```

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | 监听地址；使用 `127.0.0.1` 可关闭局域网访问。 |
| `PORT` | `8787` | HTTP/WebSocket 端口。 |
| `FPS` | `15` | 采集帧率，限制在 1–30。 |
| `QUALITY` | `0.6` | JPEG 质量，限制在 0.2–0.95。 |
| `MAX_WIDTH` | `1920` | 最大采集宽度，限制在 640–3840。 |
| `MAX_CLIENTS` | `4` | 同时连接的浏览器数量，限制在 1–32。 |
| `REMOTE_TOKEN` | 自动生成 | 可选固定密钥；对大多数用户，随机 token 更安全。 |

## 架构

```text
手机或电脑浏览器
  ↕ HTTP + 鉴权 WebSocket（JPEG 帧 / JSON 输入）
Local Remote Agent service launcher（稳定的 TCC 责任主体）
  ↳ Node.js 服务（鉴权、背压、生命周期、静态控制端）
  ↕ stdout 帧协议 + stdin 换行 JSON
Swift agent（ScreenCaptureKit + VideoToolbox + CGEvent）
```

服务端会为慢速客户端丢弃旧帧，避免延迟持续累积；浏览器断开时会释放未抬起的鼠标按键；原生 agent 崩溃后按退避策略重启；同时校验浏览器 WebSocket 来源并限制并发客户端数量。

## 开发

```bash
npm ci
npm test
npm run build:native
npm start
```

CI 会在 macOS 上运行 JavaScript 测试并构建 Swift 原生组件。较大的改动请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全边界与限制

- 仅在可信局域网使用；持有 token 即拥有完整的查看和控制权限。
- 不提供 TLS、账号系统、审计日志、剪贴板同步、文件传输、NAT 穿透或云端中继。
- 当前只支持主显示器。
- 被控端只支持 macOS，不支持 Linux 和 Windows。
- 浏览器能力存在差异；屏幕保活和全屏可能需要用户手势，在 iOS 上的行为也可能不同。

信任边界和私密漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
