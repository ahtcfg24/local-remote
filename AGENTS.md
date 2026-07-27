## 启动方式

### 一键 service 启动（推荐）

```bash
./start.sh          # 安装/启动 launchd service，自动处理依赖和构建
./start.sh status   # 查看运行状态
./start.sh stop     # 停止服务
./start.sh restart  # 重启服务
./start.sh logs     # 查看日志（tail -f .run/local-remote.log）
./start.sh doctor   # 检查环境与安装状态
./start.sh uninstall # 卸载 launchd service（保留 token 与日志）
```

启动后自动通过 launchd 管理进程，用户登录即自启，崩溃自动重启。

## 架构要点

- `native/agent.swift`：常驻守护进程（ScreenCaptureKit 推流 + CGEvent 输入注入），由 `server.js` 以子进程方式管理，通信协议见 agent.swift 头部注释。
- `REMOTE_TOKEN` 未设置时 `server.js` 自动生成 256 位随机 token 并持久化到 `.run/token`。
- 构建原生二进制：`npm run build:native`（产物在 `.build/`）。
