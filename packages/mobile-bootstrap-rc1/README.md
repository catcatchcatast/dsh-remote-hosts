# 官方认证启动材料交接

插件调用公开的 `ctx.connection.authenticatedUrl()`，将进程内可重复兑换的启动令牌保存在当前用户 `.dsh-mobile/bootstrap-<port>.json`。这不是一次性令牌，不是签名密钥。

- 仅监听回环地址时启用；不提供未鉴权 HTTP 读取入口。
- Linux 目录 0700、文件 0600；Windows 创建目录时设置仅当前用户及 SYSTEM 的受保护 ACL，文件从创建时继承该私有目录的权限。
- 写入使用同目录独占临时文件、刷盘及原子替换。
- 固定 helper（辅助程序）`read-bootstrap.cjs <port>` 检查文件身份、权限、端口及进程启动标记，拒绝 PID 复用后的旧记录。
- 退出清理只删除本进程随机实例标识对应的记录，不删除替代实例的新记录。
- Android 经已有 SSH 执行 helper，启动材料与 Cookie 只放内存；仍需对真实转发端口做官方根路径认证。

不受限 SSH 账户本来就具有该用户权限，本插件不宣称把它变成一个受限账户。客户端不得从日志、浏览器或 `.credentials.yaml` 获取认证材料。

