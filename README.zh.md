# DSH Remote Hosts

> **DSH 0.1.2 预览版**：兼容 DeepSeek Harness `0.1.2-rc.1`。
> DSH 0.1.5 正在适配，目前尚未支持，也没有发布日期承诺。

这是不修改 `dsh-core` 的 DSH 多主机外置插件集合。rc.1 兼容层沿用原有 Web
和 Desktop 界面，通过带主机范围的资源标识路由工作区、会话、交互、文件和终端
请求；DSH 凭据始终留在控制端。

## 兼容性

| DSH 运行时 | 状态 | 说明 |
| --- | --- | --- |
| `0.1.2-rc.1` | 预览 | 当前兼容目标。 |
| 其他 `0.1.2` 预发布版 | 不承诺 | 包结构和协议接口可能不同。 |
| `0.1.5` | 适配中 | 尚未支持，不承诺发布日期。 |

包职责和协议要求见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 仓库结构

- `packages/browser-host-hub-rc1`：浏览器侧路由和流复用。
- `packages/runtime-host-hub-rc1`：rc.1 契约的运行时聚合。
- `packages/rc1-host-carriers`：本机与远程主机载体。
- `packages/ui-directory-picker-browse`：本机/远程共用的项目目录选择。
- `packages/mobile-*-rc1`：Android 兼容接口。
- `packages/subscriptions-compat-rc1`：本机订阅和模型供应商路由。
- `packages/model-menu-filter`：模型目录筛选。
- `packages/ui-workspace-menu-compat-rc1`：工作区菜单和排序补丁。
- `compat/android-bootstrap-mobile-session-sync`：旧主机使用的 Android 引导兼容包源码。
- `tests`：使用合成主机与凭据的单元和集成测试。
- `config`：不含秘密的配置模板。

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

## 支持、发布与检索

配套手机端见 [DSH T-remote Android](https://github.com/catcatchcatast/dsh-t-remote-android)。
普通问题请使用 [Issues](https://github.com/catcatchcatast/dsh-remote-hosts/issues)，
支持与安全报告方式见 [SUPPORT.md](SUPPORT.md) 和 [SECURITY.md](SECURITY.md)。
下载见 [Releases](https://github.com/catcatchcatast/dsh-remote-hosts/releases)。

检索关键词：DeepSeek Harness、DSH、remote hosts、remote plugin、multi-host、SSH、
Tailscale、DSH 远程插件、DeepSeek Harness 远程主机。

项目采用 Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
