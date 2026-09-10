# @deepseek-ai/dsh-client-ui-directory-picker-browse

[English](README.md) | 中文

应用内目录浏览界面：浏览式选取交互的浏览器半边。它通过 ui-workspace 的两个 directory-flow 洞（`conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`）装入「新建项目」对话框，经 rc1 的 `ctx.uiWorkspace` 驱动当前选中 Host 的目录列举与新建文件夹原语。Host 选择器只存在于该新建项目对话框内，选择结果交给 browser-host-hub 的页面级路由，不增加固定的全局入口。它的 node 对侧是 [`dsh-host-directory-picker-browse`](../../host/directory-picker-browse/README.md)；挂载本包即用一行 cordis.yml 把界面与该后端组合起来，因此没有任何客户端代码按能力种类分支。与 [`-native`](../ui-directory-picker-native/README.md) 界面不同，本对话框不需要本地操作系统选择框，因此也服务于进程内与远程浏览器部署。

对话框是一张限制在视口内的 644×735 Codex 式项目卡片。头部承载可选的 owner 控件、文件系统根快捷入口、源文件夹标签、上一级操作和始终可见且可切换为直接编辑的绝对路径。界面一次只显示一个可滚动目录层级：扫描选中的子目录时继续显示当前层级，完成后在同一帧替换为子目录。**新建文件夹**在选中目录下创建文件夹；**添加项目**采纳选中的文件夹，没有选中时回落到当前层级。Host 标记的隐藏条目默认不显示，直到页脚开关将其揭开——那只是客户端过滤。

确认一个目录即为选中的路径，关闭对话框即为取消。多 Host owner 可以覆盖列举与创建调用、提供项目与 Host 控件并传入稳定目标 key；该 key 改变时会重新挂载浏览器并中止旧扫描。同一目标 key 下的 owner 重新渲染会保留当前目录，即使 Host 状态轮询替换了回调对象也不会重置。浏览类失败——不可读的目标、创建冲突——都留在对话框自己的提示区内，因此本占位者从不驱动 owner 的 `onError` 分支；工作区创建的错误界面仍由 owner 持有。两处注册通过嵌套的 `slots.inject()` 安装，因为任一声明方条目都可能稍后激活或替换其声明；对话框文案注册在本包自己的 locale 命名空间下，两份字典作为一个单元落地，因此激活失败不会占住该命名空间的其中一种语言。

node 半边是一个空 `apply`：它的存在只为让插件出现在 host 的 cordis.yml 与 Loader 中，浏览器半边经 `exports["./client"]` 出货，并通过 `dsh.client` 清单声明被发现。

## 模型体验

无，因为目录浏览器属于浏览器界面；本包中的任何内容都不会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **无搜索、无多选、无重命名或删除** —— 对话框只负责列出与创建目录；到达目标靠导航、编辑路径，或用前缀过滤最后一栏。
- **隐藏条目的过滤在客户端** —— Host 始终列出隐藏条目并加标记，因此开关只改变对话框渲染什么。
