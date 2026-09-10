# DSH Remote Hosts

这是不修改 `dsh-core` 的 DSH 多主机外置插件集合。rc.1 兼容层沿用原有 Web
和 Desktop 界面，通过带主机范围的资源标识路由工作区、会话、交互、文件和终端
请求；SSH 凭据始终留在控制端。

## 兼容性

| DSH 运行时 | 状态 | 说明 |
| --- | --- | --- |
| `0.1.2-rc.1` | 支持 | 当前主要兼容目标。 |
| 其他 `0.1.2` 预发布版 | 不承诺 | 包结构和协议接口可能不同。 |
| 更新版本 | 未测试 | 使用前应重新核对 UI 注入点和 RPC 契约。 |

包职责和协议要求见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 构建与测试

需要 Node.js 24、pnpm 11，以及与本仓库并列放置的对应 DSH 源码：

```text
parent/
  dsh-core/
  dsh-remote-hosts/
```

根 `package.json` 通过相对路径引用 DSH 工作区包，但不会修改该源码树。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

安装步骤见 [INSTALL-PLAN.md](INSTALL-PLAN.md)。主机配置从
[`config/host-profile.example.yml`](config/host-profile.example.yml) 复制；密码和
私钥口令使用系统凭据存储，私钥文件不进入仓库。

插件归档和日常构建产物不提交到源码历史。发布文件放在 GitHub Releases，并附
版本与 SHA-256，格式见 [RELEASES.md](RELEASES.md)。

许可证为 MIT，见 [LICENSE](LICENSE)。
