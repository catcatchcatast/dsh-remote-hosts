# dsh-chat-import 0.11.0 兼容补丁

此补丁只改候选 `dsh-chat-import@0.11.0` 的入口、导入编排和所有 persistence 消费文件：
入口改为注入 `runtimeInterface`，增量决策使用稳定元数据，创建与续写使用同一稳定写端口；
导出、backfill、doctor、verify、retract、purge、sync 的读取也使用同一 detached reader。
候选安装目录作为只读 source，补丁只写目标副本。

源文件 SHA-256 白名单：

- `index.mjs`: `a8ec3c0aa2b06d79631b598e47ea5f3b2a18517727d2dc978a7477b1a0d11517`
- `lib/backfill.mjs`: `c3c9ded5e2d13e5e59b7efce7213f2fbd7cc94d18ee84e5ac283de9f9f538c82`
- `lib/doctor.mjs`: `9868317f3629f2bd50dde970ad801bd2cce3250924f3690f7cc3cc9f67b99042`
- `lib/export-tool.mjs`: `dfe56305530b941ad3be4bf6c6c967b6c3b6ef4769049f8795b09cf1b28f3853`
- `lib/imports.mjs`: `f052dc848bbb561036ef565e3b7fd89a5eb022dbd65d7ba8a766a1f8de1f8253`
- `lib/import-core.mjs`: `39da7cf316d70c1cb34158633d06c56ed0568a396d09c36f8efcec7d4d1c766d`
- `lib/purge.mjs`: `f29b9a1decdc42615dc273dcc642a1cde3deecf470992bdb5ae0be75dac9ba9b`
- `lib/retract.mjs`: `e065a6307b787bbce0621973e109513ae1bb650ea885ed0e451d611734631afd`
- `lib/sync-loop.mjs`: `7e66a85d85c45ce5d0223bf180e150fa7a111c41df94a2cdbb15d6931ee4f54a`
- `lib/verify.mjs`: `4b555e47eaebf2edc844bdece44c6e36c0ab61122addca33333996e74cc5b807`

补丁拒绝未知版本、未知源码和重复应用。应用命令：

```powershell
node compatibility-patches/dsh-chat-import/apply.mjs `
  --source ./node_modules/dsh-chat-import `
  --target <目标副本>/node_modules/dsh-chat-import
```

目标运行时先加载 `dsh-runtime-interface`，并把它的 Cordis patch 放在宿主组合中；再
加载已应用本补丁的 `dsh-chat-import`。应用脚本输出的 source、target 和 patched hash
应保存到迁移记录。回滚时销毁目标副本并从同一源包重新复制，禁止把补丁写回候选安装目录。

接口实现依据新官方公开契约：`SessionPersistence.create/open` 返回
`SessionHandle`，读写分别使用 `read/append/flush/close`；`stat/list` 只提供轻量快照，
其中 `eventCount` 可能缺省。因此接口层对新句柄按 256 条固定块读取，精确计算逻辑事件数，
只提取首个 `session/imported` 的 `sourcePath`，并在 `finally` 关闭句柄。旧版则适配
服务级 `inspect/create/append/list/readFrom`。`list()` 与 `readFrom()` 返回字段白名单内的
深拷贝快照，原始 header、句柄和 provider 内部对象不出边界；写入继续按会话排队，
append/flush/close 结果不确定时封锁后续重放。

本补丁覆盖标准单文件/多会话的创建、替换和增量续写，并把同一插件中的导出、反向回填、
校验、撤回、清理和同步读取统一接入该接口。当前官方公开面没有删除或路径定位能力，
因此 `purge/retract` 的删除/定位仍按原工具的 capability 检查和人工引导处理；补丁不
伪造删除，也不把物理路径暴露给业务。
