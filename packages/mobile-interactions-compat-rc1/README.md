# 移动端待处理交互兼容桥

通过官方认证后的 `$events` 流接收审批、提问及撤销，通过官方 `$events/result` 回答；不调用 Gateway（接口网关）私有方法，不从历史日志推断当前待处理状态。

`InteractionBridge` 提供 `snapshot()` 与 `subscribe(listener)`；旧移动流用准确的请求 ID 发布 `approval/requested|resolved`、`question/requested|resolved`。电脑处理第一轮问题不会撤销第二轮；断线撤销旧可操作项，重连等待官方重新下发仍待处理项。

`POST /api/respond` 保留旧 Android 请求与回执形状，并校验所属会话及重复发送。官方回执成功后撤销本端项；无法确认时返回 `response_not_confirmed`，不自动重发。

官方 waterfall（交互请求分发）没有持久事件顺序号，因此此模块不伪造 `originSeq`。通知基线还需由组合同步层明确处理；仅本模块单元测试通过不等于全链路通知验收完成。

