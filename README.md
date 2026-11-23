# DSH Remote Hosts

在官方 DeepSeek Harness 界面中管理多台电脑的工作区、会话和文件。本次公开候选面向 **DSH 0.2.2-rc.5**，提供两个安装包。

| 安装包 | 功能 |
| --- | --- |
| `dsh-remote-hosts` 0.2.0-rc.2 | 电脑选择、SSH 连接与动态桌面端口发现、远程工作区和会话路由、文件预览、现有移动协议 |
| `dsh-runtime-interface` 0.1.0-rc.2 | 官方服务接口适配、事件与身份转换，以及远程插件所需的公共能力 |

## 本次更新

- 支持官方计划侧栏读取远端计划，保留分页和取消行为。
- 支持官方智能体团队协作的远程路由。
- 恢复连接后同步工作区、会话和当前状态。
- 复用官方添加工作区界面，支持选择目标电脑。
- 支持远端音视频、HTML、Word、Excel 和较大文档的预览。临时预览文件按既有七天清理策略回收。
- 修正桌面预览准备过程、标签卸载时的取消与资源释放。

## 安装

使用官方 DSH 0.2.2-rc.5 的插件管理入口，将两个归档一起添加到目标配置。需要 CLI 时，可在两个归档所在目录运行官方命令。

```powershell
dsh plugin --profile desktop add ./dsh-runtime-interface-0.1.0-rc.2.tgz ./dsh-remote-hosts-0.2.0-rc.2.tgz --ignore-scripts --node-linker=hoisted
```

Linux Web 服务将 `desktop` 替换为实际配置名称。接口包是远程包的精确配套依赖，两个归档应在同一次安装操作中提供。插件管理器允许时热加载插件，然后刷新客户端界面以加载新前端模块。

新配置首次启动前，为接口层设置一次持久历史标识。运行 `node -e "console.log(require('node:crypto').randomUUID())"`，将生成值填入该配置的 `cordis.patch.yml`。

```yaml
- id: runtime-interface
  config:
    historyEpoch:
      datasetId: "生成的 UUID"
      sequenceFormatGeneration: 4
      generation: 1
```

升级现有配置时沿用原 `historyEpoch`（历史数据标识）。在设置的“远程主机”页面添加自己的 SSH 别名。连接目标也需要安装配套插件并运行 DSH。官方桌面端使用当次运行发布的后端端口。

MKV 按浏览器可解码格式生成临时预览副本，依赖目标电脑可用的 FFmpeg。Office 转换使用官方提供的 LibreOffice 能力。文件地址继续标识所属电脑及原路径。

## 开发与验证

使用 Node.js 24.21 或更新的 24.x、pnpm 11.19.0。

```sh
pnpm install
pnpm build
```

契约测试使用官方安装提供的 SDK。将 `DSH_OFFICIAL_021_ROOT` 设置为包含 `node_modules/@deepseek-ai/dsh/package.json` 的安装根目录，然后运行 `pnpm test`。该环境变量沿用现有接口层命名，本次测试目标为 0.2.2-rc.5。

`packages/remote-hosts/module-sources.json` 列出九个内嵌源码模块，由远程插件的构建脚本统一生成。公开目录含完整手写源码、前端构建产物和相对路径源码映射。

本次准备已通过构建和指定 SDK 下的契约验证。正式桌面窗口显示仍以使用环境的实际验收为准。源码与安装归档分别管理。

## 许可

自有代码沿用 Apache-2.0。第三方 MIT、Apache-2.0 和 BSD-2-Clause 原文与归属说明随源码和安装包保留。详见 LICENSE、NOTICE、THIRD-PARTY-NOTICES.md，以及远程包内的专项声明。

公开整理记录见 [docs/PUBLIC-CHANGES.md](docs/PUBLIC-CHANGES.md)。
