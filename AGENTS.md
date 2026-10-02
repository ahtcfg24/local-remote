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

### Windows 启动

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 start -InstallFirewall
.\start.ps1 status
.\start.ps1 restart
.\start.ps1 stop
.\start.ps1 logs
.\start.ps1 doctor
.\start.ps1 uninstall
```

首次安装防火墙规则或卸载该规则需要管理员 PowerShell。计划任务默认使用已登录桌面用户的 Interactive 身份和 Limited 权限，登录自启；Node 退出后重试。SSH 位于 Session 0，不能直接作为桌面采集进程的入口。`start.ps1 run` 是计划任务内部入口。

`start/restart -RunElevated` 可明确选择 Highest，`-RunLimited` 恢复 Limited；模式保存在 `.run/windows-service.json`，后续启动和重启保留选择。切换权限模式前检查当前管理员身份，不自动请求提权；`status/doctor` 显示任务实际运行级别。首次将既有远程服务切换为 Highest 前，需要用户明确授权；不能根据输入受阻诊断自动提升服务权限。

固定局域网地址须通过路由器地址预留或持久的静态 IPv4 配置实现，再将 `.env` 的 `HOST` 设为该地址，`PORT` 默认固定为 `8787`。`-FirewallRemoteAddress` 可指定可信局域网 CIDR，默认是 `LocalSubnet`；规则仅允许配置的 Node 程序和 TCP 端口，使用 Private/Domain 配置文件。启动器不修改网络配置。

## 架构要点

- `native/agent.swift`：构建为 `.build/Local Remote Agent.app`；launchd 先启动它的 service-launcher 模式，再由它托管 Node，Node 以子进程方式管理负责 ScreenCaptureKit 推流与 CGEvent 输入注入的 agent worker。这样 TCC 的 responsible process 始终是 Agent App。通信协议见 agent.swift 头部注释。
- `REMOTE_TOKEN` 未设置时 `server.js` 自动生成 256 位随机 token 并持久化到 `.run/token`。
- 构建原生二进制：`npm run build:native`（产物在 `.build/`）。
- `native/windows/Agent.cs`：Windows 桌面采集、JPEG 推流和 SendInput 输入；构建为 `.build/local-remote-agent.exe`。普通任务不能控制锁屏、登录界面、UAC 安全桌面或高权限应用。
- `start.ps1`：以交互式计划任务托管 Node；`.run/windows-service.json` 保存非敏感运行配置，`.run/windows-service-token` 保存任务当前使用的固定 token。`.run` 和 `.env` 通过 Windows 访问控制列表限定为服务用户和 SYSTEM 可读写。停止时先写 `.run/windows-stop`，Node 关闭连接并释放输入，超时后才终止已核验身份的本仓库进程。
