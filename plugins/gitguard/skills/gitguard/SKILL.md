---
name: gitguard
description: 提交代码前用 GitGuard 检查改动：密钥扫描、项目配置的测试/lint/类型检查，以及你针对本次任务出的是/否问题（由 TypeSafe System One 判断）。完成编码任务准备提交、用户要求检查改动、或修复 GitGuard finding 后复验时使用。
---

# GitGuard

GitGuard 是一个 MCP 服务，提供两个工具：

- `check`：检查 `cwd` 仓库里的改动，返回 `PASS` / `WARN` / `REVIEW` / `BLOCK`、`canCommit`，以及带 ID 的 finding。
- `verify`：修复之后，按 finding ID 复验。

每次 `check` 包含三部分：

1. **确定性检查**：密钥扫描默认开启；测试、lint、类型检查只有在仓库的 `.gitguard.yml` 里配置了命令才会执行。
2. **你出的题**：通过 `questions` 参数传入。
3. **用户写的题**：仓库 `.gitguard.yml` 的 `questions:`，每次自动带上，你不需要重复。

第 2、3 部分由 TypeSafe System One 判断，需要环境变量 `TYPESAFE_API_KEY`。不传题、yml 里也没有题时，只跑确定性检查，不需要 Key。

## 什么时候调用

- 完成一个编码任务、准备提交之前，调用 `check`。
- 用户让你检查改动时，调用 `check`。
- 修完 finding 后，用这些 finding 的 ID 调用 `verify`，不要重新从头 `check`。
- `cwd` 必须传仓库的**绝对路径**。
- 范围默认是全部未提交改动（`all`）。只想检查已暂存内容时传 `scope: "staged"`。
- 把任务描述放进 `task`，System One 会用它理解改动。

## 怎么出题

每道题的格式如下：

```json
{
  "id": "float_money",
  "question": "Does this change calculate monetary amounts with floating-point arithmetic?",
  "level": "block",
  "files": ["src/billing/**"]
}
```

- **问成“问题是否存在”**：回答“是”就表示有问题。例如问“是否缺少回滚路径？”，不要问“是否有回滚路径？”。
- **针对本次任务和这个项目出题**，不要出泛泛而谈的题。先看 diff、任务要求和项目约定（AGENTS.md、CLAUDE.md、README），再判断最可能出错的地方。
- **一题只问一件事**，一般 3~6 道，最多 10 道。
- 可以覆盖这些方向：任务要求是否漏做、是否改了任务范围之外的东西、行为改动是否缺测试、是否触及鉴权/权限/加密/输入校验、是否破坏公开接口或数据格式、是否遗留调试代码。
- `id` 只能用小写字母、数字、下划线，不能和 `.gitguard.yml` 里的题重名。
- `files` 可选：只和部分文件有关的题加上它，改动没碰到这些文件时这道题会被跳过。
- **`level` 怎么选**：
  - `block`：答“是”就绝对不能提交，比如泄露数据、破坏核心功能、漏掉任务的核心要求。
  - `review`：需要用户判断，比如改了公开接口、行为变化较大。
  - `warn`：值得一提但不影响提交，比如遗留调试日志。

## 怎么处理结果

- **`BLOCK`**：修复导致问题的代码，然后用对应 finding ID 调用 `verify`，直到通过。不要提交。
- **`REVIEW`**：把 finding 原样告诉用户，由用户决定是否继续。
- **`WARN`**：在回复里简要提一下。
- **`PASS`**：先确认 `diffSummary.filesChanged` 大于 0。如果是 0，说明检查范围是空的，`PASS` 没有意义，要检查 `cwd` 和 `scope`。
- 工具报错时（例如缺少 `TYPESAFE_API_KEY`、配置无效），把错误原文告诉用户，不要假装检查通过。

## 禁止事项

- 不能为了通过检查而删题、改弱题目、降低 `level`。
- 不能修改 `.gitguard.yml`，例如删掉题目或关掉检查命令，除非用户明确要求。
- 不能在 `BLOCK` 未解决时提交，也不能跳过检查直接提交。
