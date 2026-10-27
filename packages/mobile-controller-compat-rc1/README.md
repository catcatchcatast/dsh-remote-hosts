# dsh-mobile-controller-compat-rc1

这是 Android 旧业务 RPC 到 DSH 0.1.2-rc.1 官方 `sessionController`、
`workspaceController` 和 `agentPresets` 的窄兼容桥。每个 HTTP 请求先经过
官方 `ctx.connection.requestRejection(req)` 鉴权，随后按 Android 的
`client-request`/`server-response` 信封调用真实 controller API。

## 已映射路由

`commands/execute`、`goal.create/pause/resume/clear`、
`host.describe/listDirectory/createDirectory`、`workspace.list/create/rename/delete/insertBefore/insertSessionBefore/archiveSession`、
`session.list/create/rename/search/fork/history/prompt/cancel/models/selectModel/updateQueue/attachment`、
`agentPreset.list/select` 均保留 Android 旧路径和数据语义。Workspace 列表使用官方
`workspaceController.follow()` 的首个 baseline；历史使用一次官方
`sessionController.follow()` 固定 cursor，带 `beforeSeq` 时再调用官方 `page()`。

`commands/execute` 通过 `dsh-runtime-interface` 的 Agent 操作契约执行。它兼容 Android
旧 envelope 中的 `images` 字段，也接受官方 rc2 的 `submittedAttachments`（image/file）字段；
接口层按官方 rc1/rc2 运行时转换为对应的附件形状。rc1 运行时不支持 file 附件时返回明确
兼容错误，不静默丢弃附件。

`mapHistoryRecords(records, options?)` 是公开的官方 `SessionHistoryRecord` 解包函数，
会把官方压缩 chunk rows 映射成 Android 需要的 `{ event }` 项；
`decodeHistoryRecords` 是同一函数的兼容别名。它不重写序号，不维护事件状态机。

## 明确未支持

本包不注册事件流、`tokenbootstrap`、子代理、skills、file references、
workspace-path opener 或 v3 同步路由；这些能力由其他官方或专用包负责。若已列出的
controller/preset/Agent 操作服务未组合，相关请求返回
`gateway/capability-unavailable`，不会伪造空能力。官方 rc1 roster 没有 Android
旧 `hasDocument` 字段，因此 `agentPreset.list` 只在真实字段存在时使用它，否则返回
明确的 `false`（表示该旧文档能力未提供）。

安装时使用本包的 `cordis.patch.yml`，入口无需构建。


服务依赖必须显式注入，不使用对未声明 `ctx` 属性的可选链探测。模型当前值从官方有界 follow 快照的 modelSelection 投影读取，完成后关闭订阅，不读取控制器私有字段。
