## 启动方式

### 一键 service 启动（推荐）

```bash
./start.sh          # 安装/启动 launchd service，自动处理依赖和构建
./start.sh status   # 查看运行状态
./start.sh stop     # 停止服务
./start.sh restart  # 重启服务
./start.sh logs     # 查看日志（tail -f .run/local-remote.log）
```

启动后自动通过 launchd 管理进程，用户登录即自启，崩溃自动重启。