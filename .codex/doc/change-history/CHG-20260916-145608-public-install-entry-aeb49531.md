# 变更追溯 CHG-20260916-145608-public-install-entry-aeb49531

- change_id: `CHG-20260916-145608-public-install-entry-aeb49531`
- created_at: `2026-09-16T14:56:10.045902+08:00`
- baseline_ref: `refs/codex-trace/CHG-20260916-145608-public-install-entry-aeb49531/baseline`
- explore_branch: `codex/20260916-public-install-entry-aeb49531-explore`
- final_branch: `codex/20260916-public-install-entry-aeb49531`
- session_id: `not-exposed`
- runtime: `codex`
- host: `sanitized-publication-builder`

## 用户需求

为 DSH `0.1.5-rc.2` 配置可公开下载的单一安装入口，在完全独立的 DSH home/profile 中安装并启动验证；Android 只作为配套项目链接展示。入口不得依赖未发布的内部包名，不修改 `dsh-core`，保留独立 Workspace UI 转换包的上游许可证和安装边界。

## 决策相关尝试

- A：直接把既有 Hub TGZ 当入口。安装时访问 npm 上不存在的 `dsh-runtime-interface@0.1.0-rc.1` 并返回 E404，因此不能作为公开入口。
- B：新建元包并把内部依赖写成 GitHub URL。pnpm 进入子包后仍按子包的精确内部依赖名访问 npm，继续 E404，未采用。
- C：把 12 个项目自有依赖作为 `bundledDependencies` 内嵌。归档与 npm/pnpm 安装成功，但 DSH loader 从 profile 目录解析裸包名，看不到元包内部的嵌套依赖；实际启动失败，说明仅打成 fat TGZ 仍不够。
- D：在入口包公开 12 个子路径 bridge，并让 Cordis patch 使用 `dsh-remote-hosts/<subpath>`。loader 先从 profile 找到入口包，再由 bridge 从包内解析依赖，实际启动通过。
- E：首次无 `historyEpoch` 启动被运行时接口按设计拒绝。没有硬编码或临时生成数据世代；改为随包提供持久化配置模板，并在安装说明中要求每台主机使用稳定且独立的数据集标识。

## 最终方案

新增 `dsh-remote-hosts` 自包含入口包。发布构建器按 release profile 的既定顺序先生成 12 个依赖 TGZ，再在临时目录安装并打入入口归档；入口用显式子路径 bridge 解决 DSH profile loader 的解析边界。公开安装命令只添加这一个 TGZ。首次启动前合并无密钥的 `historyEpoch` 模板，远程主机、SSH 凭据和模型账号继续位于仓库外。卸载入口包即可撤销 bundle 激活。

## 被剔除的失败路径遗留

未保留 Hub 单包、GitHub URL 依赖元包或依赖裸名称的 fat TGZ。未把官方 Workspace UI 变成入口包的隐式替换项；它继续作为单独、精确版本且保留上游许可证的附件。未把测试用数据集标识、临时目录、认证 URL 或本机配置写入源码和报告。

## 最小补丁复核

- 状态：已完成
- 复核说明：已从独立 baseline 重新应用最小补丁；无探索提交 merge/cherry-pick，无额外运行功能或 UI。
- 需求映射：一个公开 URL 安装 12 个项目自有运行包；独立 profile 验证；明确首次配置和回滚；Android 仓库双向链接；无运行时新 UI 或 `dsh-core` 修改。

## 验证流水

- 验证结论：通过
- 结论说明：最终实现已通过源码门禁；本地候选已通过 npm 安装、DSH/pnpm profile 安装、bridge 导入、配置合成和真实 Web 启停。提交后仍从最终提交重建附件，并以公开 GitHub URL 再做一次全新安装。
- `2026-09-16 15:16 +08:00`：`node --test tests/public-install-entry.test.mjs`，退出码 0，2/2 通过。
- `2026-09-16 15:16 +08:00`：`node tools/rc1-package-release.mjs --runtime 0.1.5-rc.2`，退出码 0，生成 14 个包；入口归档包含 12 个项目包及各自 LICENSE/NOTICE。
- `2026-09-16 15:18 +08:00`：在新建官方运行时候选中执行 npm 安装，退出码 0；存在官方依赖的 peer override 警告，未将其描述为零警告。
- `2026-09-16 15:20 +08:00`：通过真实 `dsh plugin --profile web add <local-tgz>` 安装到新建 profile，退出码 0；pnpm 只新增入口包，内嵌依赖没有回退到 npm 查询未发布名称。
- `2026-09-16 15:21 +08:00`：使用合成但持久的历史世代配置启动 DSH Web，入口的 12 个 bridge 均完成加载；未认证 HTTP 请求返回 401，停止后随机回环端口关闭。
- `2026-09-16 15:23 +08:00`：`pnpm install --frozen-lockfile && pnpm run check`，退出码 0；接口边界检查通过，307 项通过、12 项按缺少精确官方输入跳过，构建通过并保留现有 tsdown 警告。
- `2026-09-16 15:27 +08:00`：最终基线重建后的首次 `pnpm run check` 退出码 1；唯一失败为新增 bridge 测试只接受 LF，而 Windows 工作树按 Git 配置检出 CRLF。测试改为明确接受 `CRLF/LF`，业务实现未作规避性修改。
- `2026-09-16 15:29 +08:00`：修正换行断言后重跑 `pnpm run check`，退出码 0；接口边界检查通过，307 项通过、12 项跳过，构建通过并保留现有 tsdown 警告。
- `2026-09-16 15:30 +08:00`：从最终工作树生成 14 个候选包，退出码 0；发布前还需在最终提交后重建以冻结来源定位。
- `2026-09-16 15:31 +08:00`：公开内容模式扫描未发现个人目录、已知设备标识、已知个人 IP、GitHub token 或私钥块。既有测试中的通用主机标签和保留测试地址继续作为无密钥夹具。
- 仓库证据：`packages/public-install-rc2/`、`tests/public-install-entry.test.mjs`、`tools/rc1-package-release.mjs`、`INSTALL-PLAN.md`。

## 提交定位

```text
git log --all --fixed-strings --grep="Change-Trace: CHG-20260916-145608-public-install-entry-aeb49531" --format="%H|%cI|%s"
```

权威解析请运行 `trace.py resolve`。
