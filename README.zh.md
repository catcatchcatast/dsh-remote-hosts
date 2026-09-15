# DSH Remote Hosts

[English](README.md)

> **当前版本：DSH 0.1.2 预览版**
>
> 兼容 DeepSeek Harness `0.1.2-rc.1`。DSH 0.1.5 正在适配，目前尚未支持，也没有发布日期承诺。

DSH Remote Hosts 是 DeepSeek Harness（DSH）的外置远程主机与手机兼容层。它让现有 DSH Web 和 Desktop 界面通过统一的主机感知链路使用本机及远程运行时，同时不修改 `dsh-core`。

[下载 v0.1.2-preview](https://github.com/catcatchcatast/dsh-remote-hosts/releases/tag/v0.1.2-preview) · [安装说明](INSTALL-PLAN.md) · [兼容性](COMPATIBILITY.md) · [Android 客户端](https://github.com/catcatchcatast/dsh-t-remote-android)

## 项目优点

- **保持原有 DSH 体验。** 本机和远程项目继续使用原有的项目、会话、模型、审批、提问、文件与终端流程，不增加升级专属界面。
- **不修改 `dsh-core`。** 版本相关逻辑隔离在外部包中，部署、验证和回滚边界清楚。
- **本机与远程共用主机感知链路。** 资源携带明确的主机身份，减少错路由和跨会话污染。
- **减少浏览器长连接。** 每个页面使用一条复用 WebSocket 承载受支持的逻辑订阅，普通请求仍使用 HTTP。
- **避免冷会话全量恢复。** 手机端每台主机只使用一次全局事件监听，仅在补齐游标缺口或用户打开会话时读取历史。
- **故障局部隔离。** 单条流、单个会话或单台主机失败时，不重置无关任务。
- **凭据不进入浏览器。** SSH 凭据和主机身份校验留在控制端，远端 DSH 只监听回环地址。

## 功能列表

| 功能 | 作用 | 0.1.2 预览版 |
| --- | --- | --- |
| 多主机工作区聚合 | 在同一 DSH 导航结构中显示本机和远程工作区，同时保留主机归属。 | 已提供 |
| 主机范围资源路由 | 使用复合主机/资源标识路由工作区、会话、终端、文件和交互请求。 | 已提供 |
| 本机与远程项目选择 | 在原有“新建项目”弹窗中选择主机、浏览目录、创建目录和切换目标。 | 已提供 |
| 浏览器流复用 | 每页一条 WebSocket 承载工作区、会话与全局事件等逻辑流。 | 已提供 |
| 会话生命周期操作 | 保持创建、打开、重命名、分支、归档、取消、干预、排队和重连行为。 | 已提供 |
| 审批与结构化提问 | 保持审批上下文、跨端撤销、逐题回答、跳过和自由文本回答。 | 已提供 |
| 手机全局事件监听 | 无需为每个非归档会话单独建立长期 follow 订阅即可接收新事件。 | 已提供 |
| 有界历史补齐 | 仅在打开会话或确认序列缺口时读取冷历史，全主机最多两路恢复任务。 | 已提供 |
| 工具详情按需加载 | 默认传输安全摘要，完整参数、输出和差异通过详情引用点击加载。 | 已提供 |
| 模型与订阅适配 | 适配本发布使用的 rc.1 模型目录、选择状态、供应商路由和本机订阅展示。 | 已提供 |
| 工作区菜单等价 | 统一项目/会话菜单，并按最近活动排序项目和项目内会话。 | 已提供 |
| 故障与连接代次隔离 | 丢弃旧连接迟到帧，避免单流或单主机故障污染其他资源。 | 已提供 |
| 发布打包 | 生成版本化 TGZ、SHA-256、来源清单、构建溯源、许可证和 NOTICE。 | 已提供 |

准确的接口与失败语义见 [COMPATIBILITY.md](COMPATIBILITY.md)，架构决策见 [`docs/adr`](docs/adr)。

## 工作方式

```text
DSH Web / Desktop
       |
       | HTTP 请求 + 一条复用 WebSocket
       v
Browser Host Hub（浏览器主机中枢）
       |
       +---- Local carrier（本机载体）------------> 本机 DSH Runtime
       +---- SSH carrier + 回环转发 --------------> 远程 DSH Runtime
       +---- 手机兼容接口 ------------------------> DSH Android 客户端
```

复合主机/会话/工作区标识优先于页面当前选择的主机。关闭页面或手机客户端只关闭客户端连接，不停止目标电脑上仍在执行的 DSH 任务。

## 当前发布状态

| 项目 | 内容 |
| --- | --- |
| Release | `v0.1.2-preview` |
| 兼容 DSH Runtime | `0.1.2-rc.1` |
| 状态 | Preview / Pre-release（预览版/预发布） |
| 项目许可证 | Apache-2.0 |
| 官方 workspace UI 转换包 | 保留上游许可证与声明 |
| 对核心的修改 | 无 |

其他 DSH 候选版本可能具有不同的包名、注入点或协议结构。在针对确切版本完成兼容测试和人工冒烟前，应视为不支持。

## 即将适配与计划发布

下一阶段公开版本聚焦 DSH 0.1.5 兼容：

- 根据确认后的 0.1.5 接口适配主机载体、流传输、手机接口、模型选择和交互协议；
- 保持现有项目、会话、审批、提问、取消和工具详情体验；
- 完成验证后发布新的兼容表、插件包、来源记录和回滚说明。

当前插件尚不支持 DSH 0.1.5。除上述兼容适配外，暂未公布其他新增功能或发布日期。

## 快速开始

1. 确认 DSH Runtime 恰好为 `0.1.2-rc.1`。
2. 修改配置前先阅读 [INSTALL-PLAN.md](INSTALL-PLAN.md)。
3. 下载当前 Release，并用随附的 `.sha256` 文件核对所需附件。
4. 从 [`config/host-profile.example.yml`](config/host-profile.example.yml) 开始配置。
5. 密码、私钥、口令、OAuth 材料、认证 URL 和真实主机信息不得写入仓库或配置模板。
6. 通过原有受控入口重启 DSH，然后验证本机/远程目录、消息流、取消、审批和重连。

当前预览版以独立兼容包发布，不提供一键安装器。Release 中的清单记录了包职责、输入、源码哈希和许可证。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `packages/browser-host-hub-rc1` | 浏览器路由与逻辑流复用。 |
| `packages/runtime-host-hub-rc1` | rc.1 运行时契约的主机聚合。 |
| `packages/rc1-host-carriers` | 本机及基于 SSH 的远程主机载体。 |
| `packages/ui-directory-picker-browse` | 主机感知的项目目录选择。 |
| `packages/mobile-*-rc1` | Android 引导、事件、历史、交互和详情兼容接口。 |
| `packages/subscriptions-compat-rc1` | 已发布配置使用的订阅与供应商路由。 |
| `packages/model-menu-filter` | 模型目录筛选。 |
| `packages/ui-workspace-menu-compat-rc1` | 工作区菜单行为与活动排序转换。 |
| `compat/android-bootstrap-mobile-session-sync` | Android 内嵌的旧主机引导兼容包。 |
| `config` | 不含秘密的配置模板。 |
| `tests` | 使用合成身份的协议、路由、恢复、打包和 UI 转换测试。 |
| `docs/adr` | 传输与手机详情加载的架构决策。 |

## 构建与测试

需要 Node.js 24、pnpm 11，以及并列放置的对应 DSH 源码：

```text
parent/
  dsh-core/
  dsh-remote-hosts/
```

该源码树仅提供根 `package.json` 引用的 DSH 工作区依赖，本项目不会修改它。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

官方 workspace UI 的可选回归测试还需要未经修改的 rc.1 UI 输入；两步转换方式和基线哈希见 [INSTALL-PLAN.md](INSTALL-PLAN.md)。

## 安全与隐私

- 远端 DSH 只监听 `127.0.0.1`，通过已认证 SSH 转发访问。
- SSH 主机指纹发生变化时直接失败。
- 浏览器代码不会接收 SSH 私钥或任意代理目标。
- 发送、审批、创建等写操作在断线后不会自动重放。
- 公开 Issue 不得包含令牌、密钥、授权 URL、真实 IP、主机名、设备标识、私人日志或会话正文。

普通问题使用 [GitHub Issues](https://github.com/catcatchcatast/dsh-remote-hosts/issues)。私人日志与安全报告发送至 `catcatchcatast@gmail.com`；详见 [SECURITY.md](SECURITY.md) 和 [SUPPORT.md](SUPPORT.md)。

## 发布、贡献与许可证

生成包统一放在 [GitHub Releases](https://github.com/catcatchcatast/dsh-remote-hosts/releases)，并附 SHA-256、来源记录、`LICENSE` 和 `NOTICE`。贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

项目原创代码采用 Apache-2.0，第三方组件继续使用原许可证。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

检索关键词：DeepSeek Harness、DSH、remote hosts、remote plugin、multi-host、SSH、Tailscale、DSH 远程插件、DeepSeek Harness 远程主机。