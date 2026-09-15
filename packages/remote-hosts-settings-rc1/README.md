# dsh-remote-hosts-settings-rc1


设置左栏「远程主机」页。浏览器半边注册 `settings.section`，`id: remote-hosts`，
`order: 80`。Host 半边在回环上挂 `/remote-hosts` RPC（`authority: loopback`）。

- 状态：本机与远端的连接阶段、alias、转发端口、helper 是否可读、公开失败码。
- 添加：从本机 OpenSSH config 的具体 alias 下拉，不提交主机名或密钥。
- 断开隧道 / 去掉登记：不停远端 DSH。
- 重启 DSH：远端仅 `launch: systemd-user`，确认后执行
  `systemctl --user restart dsh-web.service`；本机卡在官方公开 `ctx.appExit`
  可用且可信 descriptor 与当前进程身份、端口完全匹配时显示按钮。请求只接受
  `{ hostId: "local" }`，受控 broker 等原进程退出后调用共享 launcher；客户端不能
  传命令、路径、端口或 profile。
- 共享 launcher 位于 `dsh-runtime-interface/src/managed-runtime-launcher.mjs`。
  Windows wrapper 以 `node <launcher> --descriptor <固定 descriptor.json>` 启动，
  descriptor 的 `profileId`、`launcherId`、`port`、`mutexPath`、`instancePath` 和 `logPath`
  由部署文件固定；formal 3080 与 candidate 3180 使用不同 descriptor。launcher 发现未知端口
  占用或互斥冲突时拒绝，绝不 kill 进程或裸起另一套 profile。
- `dsh-runtime-interface` 的受信配置写作
  `localRestart: { descriptorPath: "<固定绝对 descriptor.json>" }`；也支持由宿主
  预先读取后注入 descriptor 对象。该配置不来自管理 RPC。
- descriptor 的 `environment` 只能声明既有隔离变量：`DSH_HOME`、`APPDATA`、
  `LOCALAPPDATA`、`PROJECT_PANORAMA_PYTHON`、`PROJECT_PANORAMA_PYTHON_SITE`、
  `NO_COLOR=1`、`PYTHONDONTWRITEBYTECODE=1`；接口在退出前按值核对。
- 持久化：`~/.dsh/plugins/remote-hosts/targets.json`，与
  `rc1-host-carriers` 的 patch 种子合并。
- 浏览器不接收 SSH 主机名、私钥或 bootstrap token。本页不包含 Tailscale。

在 web profile 中于 `dsh-rc1-host-carriers` 之后启用本包。正式 `web` profile
当前尚未加入该 bundle。
