# 运行时接口层维护约定

本轮目标是把实际修改的接口完整迁入边界层，稳定未涉及接口保留精确例外。
功能实现、契约测试通过和正式安装版验收分别记录，本文不代表升级已经交付。

## 固定依赖方向

官方请求、调用结果和事件先由 `dsh-runtime-interface` 转为插件稳定数据，业务层只处理
清单、调度、去重、缓存与通知资格。业务发起官方调用时也通过接口层。
接口层不能返回官方控制器、完整上下文或允许任意原始调用的句柄。

Browser 输出按当前页面实际官方版本编码；Android 输出使用既有移动协议。
每台主机的输入版本独立选择，不能因为本机升级而把旧 Ubuntu 载荷当作新格式。
旧格式的范围端点与序号要按契约转换，不能靠字段改名宣称语义等价。

## 术语

| 标识或术语 | 约定 |
| --- | --- |
| canonical event（内部稳定事件） | 经版本适配后供业务处理的数据，不暴露官方压缩历史块 |
| historyEpoch（历史世代） | 与持久数据集及历史格式世代绑定，普通进程重启不改变 |
| connection generation（连接代次） | 仅用于拒绝旧连接迟到帧，不能代替历史世代 |
| cursor（游标） | 已完成持久化的相应历史位置，必须与历史世代共同解释 |
| baseline（基线） | 换代后新建的一致历史起点；建立成功前旧缓存只读可用 |
| 工具摘要 | 名称、简短操作说明、状态、耗时和安全错误摘要 |
| 工具详情 | 完整参数、输出、命令、结果及差异；点击后逐页加载 |
| 审批必要内容 | 保持旧行为，自动提供作出决定所需内容，不受工具详情折叠限制 |

## 维护顺序

1. 确定接口此次是否实际修改，列出普通请求、历史、实时事件、恢复等所有相关入口。
2. 先写两个受支持官方版本共享的业务契约，补各自官方输入及 Browser 输出样例。
3. 在接口层转换并关闭对应旧直连；业务测试只依赖内部端口和稳定数据。
4. 运行 `node tools/check-interface-boundary.mjs`，检查迁入路径是否留下旁路。
5. 只对未涉及稳定调用保留 `docs/interface-exceptions.json` 的精确例外；接口修改时删除例外。
6. 构建产物核对官方输入、插件依赖闭包及哈希，再做混合版本和真实体验验收。

静态守卫用于发现常见直连、私有导入和版本字段解释，不能证明任意动态代码都无法绕过。
新增动态调用也必须人工复核，不以静态检查通过替代完整路径评审。

## 历史与同步门禁

- 每主机一次全局监听，不为所有冷会话启动历史 follow。
- 用户打开会话或存在真实游标缺口才读取历史，主机最多两路、每会话最多一路。
- 相同范围共享在途读取；一个等待者取消不取消其他等待者，最后一个离开才释放底层。
- 子代理目录失败局部记录和退避，不能扩大为整主机历史恢复。
- 超时、断线、部分清单不代表删除；不能自动重放结果不明的写操作。
- 新协议协商后必须有世代，覆盖快照、历史、增量、详情、实时首帧及缓存。
- 旧协议使用明确兼容模式；新协议缺字段报告兼容错误，不悄悄降级。
- Android 先持久化新基线与必要正文，再原子切换权威指针，保留草稿、附件及旧只读缓存。

## 当前版本矩阵与发布限制

### 本轮迁移入口索引

| 入口及恢复路径 | 接口层所有者 | 业务调用者 | 契约入口 |
| --- | --- | --- | --- |
| Browser 普通请求、fetch 流请求与共享 WebSocket 的 open/cancel 帧 | `src/browser.js` 的三个解码/编码函数；`wrapHostCarrier` | `browser-host-hub-rc1`、`rc1-host-carriers` | `browser-host-hub-rc1`、`browser-host-stream-mux-rc1`、`runtime-interface` 测试 |
| 会话清单、历史 follow 首帧/后续帧、page、control 恢复 | `canonicalSessionPort`、`upstreamToCanonicalWire`、`canonicalToBrowserWire` | Mobile 控制器、同步与流模块；Browser Hub | `runtime-interface`、`mobile-stream-compat-rc1`、`mobile-session-sync-rc1` 测试 |
| 工作区清单与归档协调、迟到清单 | `canonicalWorkspacePort`、`wrapHostCarrier` | Mobile 清单协调、Browser Hub | `browser-host-hub-rc1`、`mobile-session-sync-rc1` 测试 |
| 全局 session/event、session/created 与状态事件 | `canonicalEventSource`；官方 Session 的实时后缀在此读取并转换 | `MobileSessionSyncState` 的全局监听 | `runtime-interface-global-events` 测试 |
| 新版无持久序号的 assistant stream、打开会话基线、重连内存基线 | `browser-stream.js`、`mobile-assistant-stream.js`、`canonicalEventSource` | Browser 格式输出；Mobile mux 独立控制帧 | `runtime-interface-browser-stream`、`runtime-interface-mobile-assistant`、`mobile-assistant-stream-integration` 测试 |
| Mobile 协商、快照、历史、增量、正文/工具详情及 SSE 起始世代 | `decodeMobileIngress`、`historyEpochMetadata`、`assertHistoryEpoch` | Mobile HTTP 路由及详情加载器 | `runtime-interface`、`mobile-stream-compat-rc1`、`mobile-tool-details-lazy` 测试 |
| 子代理注册的历史、增量及全局实时事件 | `subagent-events.js`、`canonicalToMobileHistoryEvent`；Browser 保留官方 catalog | Mobile 共用转换仅接受稳定 `subagent/update` 身份；Android 区分父 envelope 与子身份 | `runtime-interface-subagent-catalog`、`mobile-subagent-compat-rc1` 测试 |
| 上述路径经过的审批、提问、模型选择与终态 | 统一事件转换、移动交互输入解码 | 移动交互状态机与 Android 渲染/通知 | `mobile-controller-compat-rc1`、`mobile-auxiliary-rc1`、`mobile-stream-compat-rc1` 测试 |
| 本轮涉及的 Agent 命令、Goal 与预设 | `agent-operations.js`，完整 Agent 仅留在接口层 | Mobile auxiliary dispatch | `agent-operations-interface` 测试 |
| 已有未提交远程主机设置界面及管理 RPC | `createRemoteHostsClient`、`createManagementRpcIngress`、`managementRpcRegistrar` | `remote-hosts-settings-rc1` UI/dispatch | `runtime-interface-client`、`management-interface-contract`、`remote-hosts-settings-rc1` 测试 |
| 本机重启请求、状态与受控进程退出 | `localRuntime.status/restart`、`local-runtime-restart.js`、`managed-runtime-launcher.mjs` | 主机卡片及管理 dispatch；正式启动脚本共用同一 launcher | `local-runtime-restart`、`remote-hosts-settings-rc1` 测试 |
| 本机受保护的 SSH 认证信息发布与后台重试 | `localBootstrapEndpoint()` 将官方认证/网页服务转为窄端点 | `mobile-bootstrap-rc1` 的 worker 发布器 | `runtime-interface`、`bootstrap-publisher` 测试 |

表中 `src/` 以 `packages/runtime-interface/` 为根；测试名称位于 `tests/` 并带 `.test.mjs`。
迁入路径不得新增原始控制器注入或旁路；存量例外逐表达式固定在 `docs/interface-exceptions.json`，不是整文件豁免。
流式正文只用于临时显示，不进入权威历史、同步游标或完成通知。工具参数及 replay state（供应商重放状态）在移动接口内去除，完成后的详情仍通过原有引用按需读取。

管理接口的官方连接作用域绑定集中在 `management-binding.js`。使用 Cordis 公开导出的 `symbols.original` 与 `withProps` 生成调用方绑定，官方 Connection 继续负责认证、Origin 校验和释放；业务侧只接窄注册函数。升级 Cordis 或 Connection 时必须运行 `management-owner-binding.test.mjs` 的两版本真实构造测试，不能只用普通对象替身验收。

Web 组合依赖由接口层的 `cordis.patch.yml` 一并固定：Connection（连接服务）须同时注入 `webRuntime`（启动运行上下文）和 `webServer`（网页服务）。新版官方将网页挂载移入子作用域后，旧订阅插件通过 `ctx.get('connection').rpc.handle()` 注册独立通道会因原作用域缺少网页服务而失败，表现为顶层插件 active、接口却返回 405。显式组合依赖恢复原有注册能力；订阅处理器、官方认证和来源校验不变，也不修改官方包。

此项由 `runtime-interface-connection-composition.test.mjs` 在两个真实官方版本上验证，测试必须使用各版本实际 `inject` 声明，不能预先给所有替身作用域注入 `webServer` 而掩盖问题。配置生成、升级和部署均须加载本接口层 bundle，不再单独维护一份现场修补配置。

### 本机重启与认证发布

本机卡片只传主机身份，不接受命令、路径或端口覆盖。接口层读取管理员预置的固定启动描述，核对当前进程参数、目录、数据目录及端口后，通过共享启动器完成单次重启；管理响应确认后才调用官方退出入口。Desktop 冷启动与卡片重启共用启动描述和互斥机制。

`birthStamp（操作系统进程创建标记）` 与进程号一起用于判断原进程是否仍存在，不能用端口空闲代替退出证明。身份未知、记录损坏和未知端口占用均拒绝拉起；不结束其他进程。它不同于历史世代，正常重启不会因此更换历史世代。

`localBootstrapEndpoint（本机认证端点接口）` 只返回经过校验的本机端口和 `authenticatedRootUrl（仅供受保护发布器使用的认证根地址）`，禁止任意参数和跨源地址。移动发布器仅依赖此接口，不直接接触官方 Connection 或完整上下文，对应的两个存量例外已删除。认证地址不得出现在界面启动清单、普通日志或报告中。

原同步文件权限、进程创建时间和实例身份校验仍在独立 worker 中执行；启动主线程不等待 PowerShell。发布失败只记录受控错误码并有限退避；取消后停止重试，清理仍按原实例身份判断。读取端继续使用原受保护助手格式及校验，不能以后台发布为由降低权限检查。

### 当前可复核范围

候选包在隔离的官方运行依赖中安装，并核对全部官方依赖的实际版本；工作树原始输入与每次候选内容哈希分别留存。
此前内置浏览器的候选入口限制已解除；实际 Browser/Desktop、手机与协议结果分别记录，HTTP 成功仍不能代替界面可用证明。
源码未完成最终基线重建前，候选标记 `sourceCommitFrozen=false`，不得作为正式发布产物。

| 组合 | 目标 | 当前状态 |
| --- | --- | --- |
| 旧本机 → 旧 Browser | 原体验与新接口层可共存 | 本轮实现、组合验收中 |
| 旧 Ubuntu → 新 Browser | 旧历史及控制事件转为新页面格式 | 旧版适配器已正式部署，继续与本机切换组合验收 |
| 新本机 → 新 Browser | 官方新格式有限完成读取 | 最新 156 个保留会话迁移及三方合并 179 个会话回读通过，正式切换前重启门禁验证中 |
| 两种主机 → Android | 手机按世代区分历史，正文及工具语义不变 | 华为已安装兼容包；Ubuntu 新事件及完成通知实测通过，其余结果分项记录 |

官方 `0.1.5-rc.2` 最初对 283 个会话副本中 128 个拒绝迁移。用户已明确确认这 128 个完整会话不再需要，固定名单后将其排除新版导入，原文件仍保留。刷新后源会话数增加到 284，保留 156 个；用户另行接受一条中断事件的额外错误堆栈字段移到保留原件中，活动迁移副本仅移除此字段，未删正文或轮次。156 个官方迁移通过，三方合并保留候选新增 23 个，共 179 个官方回读通过。此结果不表示官方已兼容被排除的历史，也不得自动排除新增失败项。
正式环境暂保留 `0.1.2-rc.1`、`web-remote` 和 `3080`，继续完成配置及实际体验门禁。候选只用隔离数据与 `3180`。
首次新版本真实写入后，禁止恢复旧快照丢弃新增内容；若无经验证的逆向迁移，必须前向修复。
进程退出、Desktop 重拉起等未闭环问题独立记录，不据存储探针推断已解决。
