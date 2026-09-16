# 变更追溯 CHG-20260916-153733-sanitize-build-path-dc012afd

- change_id: `CHG-20260916-153733-sanitize-build-path-dc012afd`
- created_at: `2026-09-16T15:37:34.832407+08:00`
- baseline_ref: `refs/codex-trace/CHG-20260916-153733-sanitize-build-path-dc012afd/baseline`
- explore_branch: `codex/20260916-sanitize-build-path-dc012afd-explore`
- final_branch: `codex/20260916-sanitize-build-path-dc012afd`
- session_id: `01a094f6-54d0-70b2-9e21-f6d5bc4890a2`
- runtime: `codex`
- host: `sanitized-publication-builder`

## 用户需求

修复公开发布包中泄露本机绝对构建路径的问题，并从脱敏源码重建公开安装入口。

## 决策相关尝试

- A：在发布 TGZ 中执行递归隐私扫描，确认 CSS 虚拟模块标识嵌入了本机绝对构建路径，同时影响独立目录选择包和自包含公开入口包。
- B：评估发布后对字节做等长替换；该方案不能防止后续构建重现，已舍弃。
- C：将 CSS 虚拟模块标识改为包内 POSIX 相对路径，加入越界校验；重新构建后打包内容不再含构建机盘符路径。

## 最终方案

仅修改目录选择 UI 的 tsdown CSS 插件：解析阶段将真实文件转为相对于包根的稳定虚拟标识，加载阶段再在包边界内还原文件。发布测试直接解包并断言生成的 `client.js` 不含 Windows 绝对路径，且仍包含预期的稳定 CSS 标识。

## 被剔除的失败路径遗留

首次仅构建单个 UI 包时，发布测试因其他工作区包未生成 `lib` 而失败；完成发布配置全量构建后排除。初版测试正则会把 URL 中的 `s:/` 误认为盘符，收窄为仅匹配行首或空白/引号/左括号后的盘符路径。

## 最小补丁复核

- 状态：已完成
- 复核说明：已从受信 baseline 重建最小补丁，差异仅包含一个打包配置、一个回归测试和本追溯文档。
- 需求映射：生成代码的虚拟标识不再携带本机路径；无运行功能、配置或 UI 改变。

## 验证流水

- 验证结论：通过
- 结论说明：针对性发布测试、全套检查、构建及已知隐私标识扫描全部通过。
- 命令、时间、退出码与证据：`node --test tests/rc1-package-release.test.mjs` 于 2026-09-16 通过 3/3，退出 0；`pnpm run check` 通过 307、跳过 12、失败 0 并完成发布配置构建，退出 0；`packages/ui-directory-picker-browse/lib/client.js` 及 sourcemap 对已知本机路径、设备标识、公网 IP、令牌和私钥头扫描无命中；`git diff --check` 退出 0。

## 提交定位

```text
git log --all --fixed-strings --grep="Change-Trace: CHG-20260916-153733-sanitize-build-path-dc012afd" --format="%H|%cI|%s"
```

权威解析请运行 `trace.py resolve`。
