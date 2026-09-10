# browser-host-hub-rc1


浏览器侧的 rc1 多 Host wire 聚合核心。它接收已认证的 `perHost`（按 Host 分组的
carrier 映射），只转发明确列出的官方 `/api` RPC。服务端 `apply` 注册精确的
认证 BFF 路由，并通过受保护的
`/__dsh/browser-host-hub-rc1-bootstrap.js`（预置于 official boot-ready 之前）提供
自包含的 `globalThis.__DSH_TRANSPORT__`（官方浏览器传输 hook）
`fetch` / `openStream`；这不会覆盖官方 `connection` 服务。
浏览器仍向官方 `/api/<endpoint>` 发起请求；默认服务端 BFF 精确路由使用独立的
`/api/browser-host-hub-rc1/<endpoint>` 前缀，避免与官方路由冲突并防止 carrier 回调递归。
四个持久流 `workspace/follow`、`session/control`、`session/follow` 和 `$events` 在新页面中
复用同源的 `/api/browser-host-hub-rc1/streams` WebSocket；普通 RPC 继续走 HTTP，旧的
HTTP/SSE 路由继续保留给旧资源包。WebSocket upgrade 复用 `connection.requestRejection`
认证并强制校验 Origin，不把认证 token 写入 URL 或启动脚本。
`BrowserHostHub` 可通过 `options.codec` 注入 `runtime-host-hub-rc1` 的严格 rh1 编解码器；
未注入时使用同等严格的内置实现，不依赖部署后不存在的相对路径。

每个 `BrowserHostHub` 实例拥有独立的 `selectedHost`（当前浏览器实例选中的 Host）；
原生 UI 可调用 `setSelectedHost(hostId)`，不会修改旧 UI，也不会在实例之间共享
currentHost。
在浏览器页面中默认使用当前页面 origin；非同源测试或嵌入场景应显式传入 `baseUrl`。
workspace/control 以官方 baseline/increment 合并，`$events` 只发布一个 synthetic
`ready/clientId`。Host 掉线只触发该 Host 的重连，重连成功后先消费新 baseline/ready，
不会结束全局 stream。

WebSocket 帧默认上限与 BFF 响应上限相同，均为 16 MiB。服务端按逻辑流轮转发送，默认
单流排队不超过帧上限的 2 倍，单个物理连接总排队不超过 4 倍；Node 侧可用
`maxFrameBytes`、`maxStreamQueuedBytes` 和 `maxSocketQueuedBytes` 覆盖，浏览器 UI 不暴露这些
运行参数。单流取消只释放对应迭代器，物理连接断开则让现有上层恢复流程重新订阅，传输层
不自动重放请求。

本包不负责 SSH、认证、服务启动、事件审批/respond、token bootstrap，也不覆盖官方
包或 iframe。Root 必须注入已认证的 Node `perHost` carrier Map；本包不提供 SSH/auth
carrier，也不实现 dsh-file-upload 的 raw `/api/upload/v2` 或 `/api/file-browser/v1`
旁路。未列入 allowlist 的 URL/RPC 明确拒绝；model catalog 和 directory picker
没有可编码 Host ID 时必须通过页面的
`globalThis.__DSH_BROWSER_HOST_HUB__.setSelectedHost(hostId)` 先选择 Host。

正式 rc1 组合配置由 mobile-controller-compat-rc1 注册共享目录服务和目录 UI；本包仅注册自身，避免两个 bundle 重复插入相同 loader 标识。发布验收必须使用完整打包后的组合配置。
