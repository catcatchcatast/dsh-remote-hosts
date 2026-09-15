# DSH Remote Hosts

**DeepSeek Harness 远程插件 · 多主机 Web／Desktop · Android 接口适配**

[English](README.md) · [安装说明](INSTALL-PLAN.md) · [兼容性](COMPATIBILITY.md) · [发布下载](https://github.com/catcatchcatast/dsh-remote-hosts/releases) · [Android 客户端](https://github.com/catcatchcatast/dsh-t-remote-android)

在熟悉的 DSH 网页或 Desktop 中操作本机和远程电脑上的项目。DSH Remote Hosts 通过外部插件提供主机路由、浏览器连接复用和手机接口，**不修改 `dsh-core`**。

这是社区项目，并非 DeepSeek 官方产品。每台电脑仍需自行安装 DSH、登录并配置模型供应商；本项目不提供模型订阅或账号凭据。

## 版本状态：安装前先看

| 使用对象 | DSH 目标版本 | 状态 |
| --- | --- | --- |
| 当前源码快照 | `0.1.5-rc.2` | 已适配的预览源码；新版公开安装包待发布 |
| 已有 `v0.1.2-preview` 下载 | `0.1.2-rc.1` | 旧版预发布附件，不是 rc.2 安装包 |
| 源码保留的兼容路径 | `0.1.2-rc.1` | 需验证具体包与配置组合 |
| 其他版本，包括正式版 0.1.5 | — | 未声明兼容 |

**不要把旧版 `v0.1.2-preview` 附件当成 rc.2 升级包。** 目录名中的 `-rc1` 是历史命名；当前运行时目标和完整包集合由 [`release-profile.json`](release-profile.json) 定义。

## 可以用它做什么

- 项目保留在所属电脑，在同一个界面浏览本机和远程工作。
- 在新建项目的目录流程中选择目标主机，浏览目录、创建文件夹，并继续选择目录。
- 打开会话、跟随输出、干预运行中的任务，在多端处理审批和提问。
- 为原生 Android 客户端提供接口，避免启动时逐个订阅所有空闲会话的完整历史。

![DSH Remote Hosts 连接示意](docs/assets/readme/overview.drawio.svg)

*这是一张连接原理示意图，并非产品截图。图中仅有通用组件名称，不含账号、设备、主机地址或会话内容。*

## 界面截图

实际 Web／Desktop 界面截图，展示远程插件集成后的项目与会话主机归属。

| 按项目浏览 | 按时间浏览会话 |
| --- | --- |
| <img src="docs/assets/readme/ui-projects-multi-host.png" alt="按项目浏览本机和远程工作区，远程项目显示主机标签及状态" width="340"> | <img src="docs/assets/readme/ui-sessions-by-time.png" alt="按时间浏览会话，显示所属项目和远程主机标签" width="284"> |

远程项目和会话旁显示主机标签，帮助区分操作目标。通用主机标签保留，部分项目名称沿用原图遮盖；图中主机不是安装后预置的配置。

## 项目优点

| 设计 | 对使用者的意义 |
| --- | --- |
| 外部兼容包 | 版本适配留在官方核心之外，可随配置回滚。 |
| 统一主机路由 | 项目、会话、文件和终端保持明确归属，避免目标主机混淆。 |
| 单条浏览器共享连接 | 支持的逻辑订阅复用一条 WebSocket（双向长连接），普通请求继续使用 HTTP，减少长连接占用。 |
| 每主机一次手机全局监听 | 非归档会话的新事件仍能到达，不预先恢复所有冷会话。 |
| 历史按需且有界 | 用户打开会话或存在已确认游标缺口时读取历史，主机级重型读取最多两路。 |
| 工具摘要优先 | 手机默认不传输完整工具参数、输出和差异，点击后再读取所需详情页。 |

这些是当前实现策略，不代表固定延迟或永久无故障的承诺。

## 功能列表

下列能力已在预览源码中实现；具体可用性还取决于匹配的 DSH 运行时、配置和主机能力。

| 领域 | 功能 |
| --- | --- |
| 项目与主机 | 汇总本机／远程工作区，保留主机标签与归属；目录主机选择、浏览、新建文件夹和目标主机工作区创建。 |
| 会话操作 | 创建、打开、重命名、分叉、归档、消息排队、插话、中断及重连。 |
| 导航与排序 | 会话菜单内容一致；项目按最近更新的非归档会话排序，项目内较新的会话靠前。 |
| 实时输出 | 浏览器共享工作区／会话订阅及全局事件；手机流式正文与子代理事件适配。 |
| 审批和提问 | 自动提供决定所需上下文，批准／拒绝、多端撤销旧交互、逐题回答、跳过和自由文本。 |
| 模型与订阅 | 适配运行时模型目录和选择状态、可配置模型过滤、订阅插件兼容路由；账号由相应运行时和供应商管理。 |
| 手机同步 | 全局事件流、有序游标恢复、历史世代和有界冷历史读取；常规后台工作排除归档会话。 |
| 工具详情 | 历史与实时事件统一分离摘要和详情引用；所选完整字段通过有界详情接口读取。审批必要内容不被懒加载隐藏。 |
| 文件与终端 | 沿现有主机能力路由文件和终端操作；传输行为取决于主机实现。 |
| 运行时管理 | 统一窄接口、受控启动与重启，以及已有验证证据的 Windows 启动修复。 |
| 发布打包 | 按配置选择依赖闭包，生成 TGZ（插件归档）、来源哈希并包含项目 LICENSE／NOTICE。 |

深入说明：[兼容契约](COMPATIBILITY.md)、[运行时接口](docs/runtime-interface-maintenance.md)、[架构决策](docs/adr)。

## 开始使用

### 使用已有 0.1.2 预览下载

[`v0.1.2-preview`](https://github.com/catcatchcatast/dsh-remote-hosts/releases/tag/v0.1.2-preview) 只能按其清单搭配 `0.1.2-rc.1` 使用。先校验 SHA-256（文件内容哈希）；[INSTALL-PLAN.md](INSTALL-PLAN.md) 的旧版章节记录该套包。

### 使用当前 0.1.5-rc.2 源码

1. 确认目标 DSH 恰好为 `0.1.5-rc.2`，各远程电脑已具备可用且已登录的 DSH。
2. 配置 SSH（安全远程连接）并独立核对主机指纹。DSH 保持监听本机回环，通过 SSH 或 Tailscale 上的 SSH 连接。
3. 按下文构建当前包集合；参考 [INSTALL-PLAN.md](INSTALL-PLAN.md) 准备精确版本的官方输入和工作区 UI 转换。
4. 以 [`config/host-profile.example.yml`](config/host-profile.example.yml) 为模板，在仓库外提供实际主机和凭据；示例不是可直接运行的个人配置。
5. 安装 `release-profile.json` 选择的完整依赖集合及必要运行时／UI 输入，不混用不同版本清单的包。
6. 经现有受控服务入口重启，检查本机／远程项目、正文、中断、审批和重连，再扩大使用范围。

当前预览是插件包集合，不是一键安装器。远程插件和 Android 应作为匹配组合更新。

## 构建与验证

需要 Node.js 24 和 pnpm 11。当前工作区依赖锁定到注册表版本，不需要并列的私人 DSH 源码。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
```

官方集成与 UI 转换测试另需精确版本的未修改输入。缺少输入的测试明确跳过，不能算作官方运行时验收通过。隔离的旧手机引导包保留独立历史构建前提。

当前本地源码检查记录：构建、接口边界检查通过，测试 **305 项通过／12 项跳过**。这不替代完整公开安装包或多主机稳定负载验收。来源见 [SOURCE_SNAPSHOT.md](SOURCE_SNAPSHOT.md)。

## 接下来的发布工作

- 从最终 rc.2 发布提交重新构建并扫描公开插件附件。
- 提供匹配的安装清单、兼容证据、SHA-256 和回滚步骤。
- 验证 Android 与远程插件组合，再发布新版预览下载。

不承诺新增产品功能或发布日期。未验收的 Home 专属候选和可选性能工作不列为已发布功能，也不宣称手机 300ms 首屏保证。

## 仓库导航

| 路径 | 职责 |
| --- | --- |
| `packages/runtime-interface` | 官方运行时边界、正文／子代理适配与受控生命周期。 |
| `packages/browser-host-hub-rc1`、`packages/rc1-host-carriers` | 浏览器路由、共享流及本机／SSH 载体。 |
| `packages/remote-hosts-settings-rc1`、`packages/ui-directory-picker-browse` | 主机配置界面和目录流程。 |
| `packages/mobile-*-rc1` | 引导、事件、历史、交互和详情接口。 |
| `packages/subscriptions-compat-rc1`、`packages/model-menu-filter` | 订阅兼容与模型目录过滤。 |
| `packages/ui-workspace-menu-compat-rc1` | 菜单等价和最近活动排序转换。 |
| `compat/android-bootstrap-mobile-session-sync` | 隔离的旧主机兼容引导。 |
| `compatibility-patches`、`tools`、`tests` | 外部使用方适配、打包和合成回归测试。 |

## 支持、隐私和许可证

普通问题与兼容性反馈：[GitHub Issues](https://github.com/catcatchcatast/dsh-remote-hosts/issues)。私人日志与安全报告：[catcatchcatast@gmail.com](mailto:catcatchcatast@gmail.com)。

不要公开令牌、私钥、授权 URL、真实 IP／主机名、设备标识或会话正文，截图也须脱敏。SSH 凭据不进入浏览器载荷；自动重连不重放发送、审批或创建等写操作。

[贡献规范](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [支持渠道](SUPPORT.md) · [发布要求](RELEASES.md)

项目自有代码使用 **Apache-2.0**。第三方组件，包括官方 UI 转换内容，保留原许可证和归属。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

配套项目：[DSH T-remote 安卓客户端](https://github.com/catcatchcatast/dsh-t-remote-android)。检索关键词：DSH 远程插件、DeepSeek Harness 远程主机、多主机、remote hosts、remote plugin、SSH、Tailscale。
