# GitGuard 技术设计文档

**项目名称：** GitGuard  
**项目定位：** Repository-aware Change Verification & Quality Gate  
**文档版本：** v0.2  
**项目阶段：** Architecture / MVP Design  
**核心技术：** Git + System One + Policy Engine + MCP + CLI + CI  
**推荐实现语言：** TypeScript  
**主要使用者：** 开发者、Coding Agent、CI/CD 系统

---

# 1. 项目简介

GitGuard 是一个面向软件仓库的代码变更验证与质量门禁系统。

它的目标不是单纯检查：

```text
代码能不能编译
```

而是进一步判断：

```text
这次修改是否真的完成了任务？

修改范围是否偏离了原任务？

是否缺少必要测试？

是否违反仓库开发规则？

是否引入了高风险行为？

Agent 声称已经完成任务，这个声明是否可信？
```

GitGuard 可以运行在多个开发阶段：

```text
Coding Agent 完成任务
        ↓
     GitGuard

开发者准备 Commit
        ↓
     GitGuard

Pull Request
        ↓
     GitGuard

CI/CD Pipeline
        ↓
     GitGuard
```

因此 GitGuard 的本质不是：

```text
Git Hook
```

也不是：

```text
MCP Server
```

而是：

> **一个 Repository-aware Change Verification Engine。**

即：

> **仓库感知的代码变更验证引擎。**

---

# 2. 项目核心定位

GitGuard 的核心职责可以概括为：

```text
Inspect
   ↓
Judge
   ↓
Verify
```

具体来说：

```text
Task
+
Code Changes
+
Repository Context
+
Repository Policy
+
Deterministic Evidence

        ↓

GitGuard Verification Engine

        ↓

PASS
WARN
REVIEW
BLOCK
```

---

# 3. GitGuard 不是什么

GitGuard 不应该变成另外一个：

```text
AI Code Reviewer
```

也不应该变成：

```text
Autonomous Coding Agent
```

GitGuard 不负责：

```text
写代码
修改代码
设计功能
自主 Commit
自主 Push
完成用户任务
```

Coding Agent 负责：

```text
Think
Implement
Fix
```

GitGuard 负责：

```text
Inspect
Judge
Verify
```

两者形成：

```text
Agent
 ↓
实现
 ↓
GitGuard
 ↓
发现问题
 ↓
Agent 修复
 ↓
GitGuard 再验证
 ↓
PASS
```

---

# 4. 核心设计理念

GitGuard 遵循三个层次：

## 4.1 Deterministic Layer

负责确定性事实。

例如：

```text
测试是否失败
Lint 是否报错
Type Check 是否通过
是否存在 Secret
文件是否超过限制
```

典型工具：

```text
ESLint
Ruff
TypeScript
mypy
cargo clippy
Vitest
pytest
Gitleaks
```

---

## 4.2 Semantic Decision Layer

负责传统规则难以表达的语义判断。

例如：

```text
这个修改真的完成了任务吗？

是否混入了无关修改？

修改行为后是否需要新增测试？

这个修改是否属于安全敏感变更？

是否可能造成较大回归？

是否违反仓库约定？
```

第一阶段由 TypeSafe System One / Jev 提供。

---

## 4.3 Policy Layer

模型只给：

```text
概率
分类
风险等级
```

真正决定：

```text
PASS
WARN
REVIEW
BLOCK
```

的是 GitGuard Policy Engine。

因此：

```text
System One ≠ 决策系统

System One = 信号来源

Policy Engine = 最终规则执行者
```

---

# 5. 为什么采用 System One

普通 Generative LLM 通常适合：

```text
解释
生成
推理
修改代码
写 Review
```

但 GitGuard 更需要：

```text
这个情况存在吗？

属于哪个类别？

风险有多高？
```

例如：

```text
tests_required = 0.84

unrelated_changes = 0.12

security_sensitive = 0.77
```

这种输出非常适合程序直接使用。

GitGuard 因此不会向 System One 提问：

```text
Please review this commit and explain all problems.
```

而是拆成多个小判断：

```text
Does this change complete the task?

Does this diff contain unrelated changes?

Does this behavior change require tests?

Does this change affect security-sensitive logic?

Does this change create significant regression risk?
```

---

# 6. 产品形态

GitGuard Core 作为唯一核心。

在它外面提供多个 Adapter：

```text
                 GitGuard

                   Core
                    │
        ┌───────────┼───────────┐
        │           │           │
       CLI       Git Hook      MCP
        │                       │
        │                       │
 Developer                Coding Agent
        │
        └────────────┬───────────┘
                     │
                GitGuard Core
                     │
                 CI Adapter
                     │
               GitHub Action
```

因此项目结构应该是：

```text
GitGuard
│
├── Core Engine
│
├── Interfaces
│   ├── CLI
│   ├── MCP
│   ├── Git Hook
│   └── CI / GitHub Action
│
└── Providers
    ├── TypeSafe
    └── Future Providers
```

MCP 只是：

```text
interfaces/mcp
```

而不是 GitGuard 本身。

---

# 7. 总体架构

```text
┌─────────────────────────────────────────┐
│              External Clients           │
├─────────────────────────────────────────┤
│                                         │
│ Developer     Coding Agent       CI      │
│                                         │
│ CLI/Hook      MCP Client      GH Action │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│                GitGuard                 │
├─────────────────────────────────────────┤
│                                         │
│             Interface Layer             │
│                                         │
│ CLI   MCP   Git Hook   CI Adapter       │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│               Core Engine               │
│                                         │
│ Git Adapter                             │
│ Context Builder                         │
│ Verification Engine                     │
│ Policy Engine                           │
│ Finding Manager                         │
│ Cache                                   │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│             Analysis Layer              │
│                                         │
│ Deterministic Engine                    │
│ System One Provider                     │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│               Providers                 │
│                                         │
│ TypeSafe / Jev                          │
│ Test/Lint Tools                         │
│ Secret Scanner                          │
│                                         │
└─────────────────────────────────────────┘
```

---

# 8. GitGuard Core

所有入口：

```text
CLI
Git Hook
MCP
CI
GitHub Action
```

最终都必须调用：

```text
GitGuard Core
```

不允许每个入口单独实现检查逻辑。

核心接口：

```ts
interface GitGuardEngine {

  inspect(
    input: InspectionInput
  ): Promise<InspectionResult>;

  verify(
    input: VerificationInput
  ): Promise<VerificationResult>;

}
```

这样：

```text
MCP
```

只是调用：

```text
engine.inspect()
```

CLI 也是：

```text
engine.inspect()
```

GitHub Action 同样如此。

---

# 9. Git Adapter

Git Adapter 负责读取 Repository 状态。

第一原则：

> **Read-only by default**

允许：

```text
git status
git diff
git diff --cached
git show
git log
git ls-files
git rev-parse
```

默认禁止：

```text
git add
git commit
git checkout
git reset
git clean
git push
```

接口：

```ts
interface GitAdapter {

  getRepositoryRoot(): Promise<string>;

  getStatus(): Promise<GitStatus>;

  getStagedDiff(): Promise<string>;

  getWorkingTreeDiff(): Promise<string>;

  getChangedFiles(): Promise<ChangedFile[]>;

  getCurrentBranch(): Promise<string>;

  getHeadSha(): Promise<string>;

}
```

---

# 10. Git Change Scope

GitGuard 应支持多种分析范围：

```text
staged
working-tree
all
commit
range
pull-request
```

例如：

```bash
gitguard check --staged
```

或者：

```bash
gitguard check HEAD~1..HEAD
```

后续 CI：

```text
base branch
    ↓
diff
    ↓
HEAD
```

---

# 11. Context Builder

Context Builder 是 GitGuard 最重要的模块之一。

因为：

```text
Diff ≠ 完整语义
```

单纯发送：

```text
git diff
```

很容易导致错误判断。

但发送整个 Repository：

```text
成本高
速度慢
噪声大
可能泄露无关代码
```

所以 GitGuard 需要构建：

> **Minimal Relevant Context**

即：

> 最小必要上下文。

---

# 12. Context 输入结构

完整 Context：

```text
Task

+

Git Diff

+

Changed File Context

+

Repository Instructions

+

Related Tests

+

Repository Metadata

+

Deterministic Evidence
```

最终形成：

```ts
interface EvaluationContext {

  task?: TaskContext;

  diff: DiffContext;

  files: FileContext[];

  instructions: InstructionContext[];

  relatedTests: TestContext[];

  repository: RepositoryMetadata;

  evidence: DeterministicEvidence[];

}
```

---

# 13. Task Context

Task 是 GitGuard 面向 Coding Agent 时非常重要的输入。

例如：

```text
Fix expired JWT token handling in login flow.
```

GitGuard 可以判断：

```text
task_completed

task_scope_match

unrelated_changes
```

这也是 GitGuard 相比普通 Git Hook 最大的差异之一。

---

# 14. Task 来源

Task 可以来自：

### CLI

```bash
gitguard check \
  --task "Fix expired token handling"
```

### MCP

Agent 调用：

```json
{
  "task": "Fix expired token handling"
}
```

### GitHub

未来可以来自：

```text
Issue
PR Description
Commit Metadata
```

### Coding Agent Session

MCP Client 可以直接传入当前用户任务。

---

# 15. Diff Context

核心数据：

```text
git diff
```

包含：

```text
changed files
added lines
deleted lines
rename
delete
new file
```

建议先解析成：

```ts
interface DiffContext {

  raw: string;

  files: DiffFile[];

  insertions: number;

  deletions: number;

}
```

---

# 16. Changed File Context

仅有 patch 有时无法理解原代码。

因此：

```text
修改代码前后 N 行
```

也应该加入 Context。

默认：

```yaml
context:

  surrounding_lines: 40
```

例如：

```text
src/auth/token.ts

修改：

Line 80-90

Context：

Line 40-130
```

---

# 17. Repository Instructions

自动寻找：

```text
AGENTS.md

CLAUDE.md

CONTRIBUTING.md

.gitguard.yml
```

未来可以支持：

```text
README Developer Rules
CODEOWNERS
SECURITY.md
```

---

# 18. 层级 Repository Rules

Monorepo 示例：

```text
repo/
│
├── AGENTS.md
│
├── apps/
│   ├── web/
│   │   ├── AGENTS.md
│   │   └── src/
│
└── server/
    ├── AGENTS.md
```

如果修改：

```text
apps/web/src/auth.ts
```

规则继承：

```text
repo/AGENTS.md
        ↓
apps/web/AGENTS.md
```

更接近文件的 Policy 优先级更高。

---

# 19. Related Test Discovery

Context Builder 应寻找：

```text
auth.ts
auth.test.ts
auth.spec.ts
tests/auth/*
```

以及语言生态约定。

第一版可以简单使用：

```text
文件名匹配
目录匹配
Import Relationship
```

后期再考虑：

```text
AST
Code Graph
Dependency Graph
```

---

# 20. Context Budget

必须限制 Context。

例如：

```yaml
context:

  max_diff_chars: 50000

  max_total_chars: 100000

  surrounding_lines: 40

  related_tests:
    max_files: 5

  instructions:
    max_chars: 15000
```

Context 优先级：

```text
Task
>
Diff
>
GitGuard Policy
>
Repository Instructions
>
Changed Code Context
>
Tests
>
Metadata
```

---

# 21. Verification Engine

这是 GitGuard 核心执行器。

负责协调：

```text
Context Builder

Deterministic Checks

System One

Policy Engine
```

流程：

```text
Repository State
       ↓
Context Builder
       ↓
┌──────┴──────┐
↓             ↓
Deterministic System One
↓             ↓
└──────┬──────┘
       ↓
 Policy Engine
       ↓
   Findings
       ↓
Final Decision
```

---

# 22. Deterministic Engine

确定性问题不应该交给 AI。

例如：

```text
测试是否通过

Lint 是否报错

类型检查是否通过

Secret 是否存在
```

建议支持用户配置命令：

```yaml
commands:

  test:
    run: "pnpm test"

  lint:
    run: "pnpm lint"

  typecheck:
    run: "pnpm tsc --noEmit"
```

---

# 23. Command Safety

不能给 Agent：

```json
{
  "command": "任意 shell"
}
```

否则 MCP 就变成远程 Shell。

必须：

```text
配置者提前定义 Command
```

Agent 只能请求：

```text
test
lint
typecheck
```

例如：

```ts
runCheck("test")
```

而不能：

```ts
runCommand("rm -rf ...")
```

---

# 24. Deterministic Result

```ts
interface DeterministicResult {

  id: string;

  status:
    | "passed"
    | "failed"
    | "skipped";

  exitCode?: number;

  durationMs: number;

  stdout?: string;

  stderr?: string;

}
```

---

# 25. Semantic Verification

第一版 System One Provider 使用：

```text
TypeSafe / Jev
```

但 GitGuard Core 不应该直接绑定 Jev。

需要 Provider 抽象：

```ts
interface DecisionProvider {

  evaluate(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticResult>;

}
```

实现：

```text
TypeSafeProvider

MockProvider

FutureLocalProvider
```

以后可以支持：

```text
其他 System One Model

本地 Classification Model

企业内部模型
```

---

# 26. 默认 Semantic Checks

MVP 推荐：

```text
task_completed

task_scope_match

unrelated_changes

tests_required

tests_present

behavior_change

security_sensitive_change

breaking_change

debug_leftovers

regression_risk
```

---

# 27. Question 设计原则

错误：

```text
Is this commit good?
```

因为太宽泛。

正确：

```text
Does this diff contain meaningful changes
unrelated to the stated task?
```

正确：

```text
Does this change modify runtime behavior?
```

正确：

```text
Does this behavioral change reasonably
require additional regression tests?
```

每个问题：

```text
单一
明确
可判定
```

---

# 28. 判断类型

GitGuard 主要需要三类结果。

## Boolean-like

例如：

```text
tests_required
```

输出：

```text
0.84
```

---

## Choice

例如：

```text
change_type
```

候选：

```text
feature

bug_fix

refactor

test

documentation

configuration

security

mixed
```

---

## Risk Level

例如：

```text
regression_risk
```

输出：

```text
negligible

low

medium

high

critical
```

---

# 29. Semantic Result

统一结构：

```ts
interface SemanticDecision {

  id: string;

  probability?: number;

  value?: string;

  confidence?: number;

  provider: string;

}
```

---

# 30. Policy Engine

Policy Engine 是整个项目的真正决策中心。

例如：

```text
tests_required = 0.84
```

它只是模型输出。

Policy：

```text
0.00 - 0.55 PASS

0.55 - 0.75 WARN

0.75 - 0.90 REVIEW

> 0.90 BLOCK
```

最终才产生：

```text
REVIEW
```

---

# 31. GitGuard 状态体系

统一使用：

```text
PASS

WARN

REVIEW

BLOCK
```

### PASS

正常继续。

### WARN

存在风险，但不阻断。

### REVIEW

需要 Agent 或开发者处理。

### BLOCK

当前变更不应该进入下一阶段。

---

# 32. 默认策略建议

初期：

> **Semantic AI 不应轻易直接 BLOCK。**

推荐：

```text
AI Semantic Finding
→ WARN / REVIEW
```

真正的：

```text
BLOCK
```

优先来自：

```text
Tests Failed

Lint Failed

Secret Found

Explicit Repository Policy
```

这样可以降低误报造成的用户反感。

---

# 33. Policy Rule

```ts
interface PolicyRule {

  id: string;

  enabled: boolean;

  description?: string;

  files?: string[];

  exclude?: string[];

  thresholds?: {

    warn?: number;

    review?: number;

    block?: number;

  };

}
```

---

# 34. `.gitguard.yml`

建议作为 Repository 的 GitGuard 配置入口。

```yaml
version: 1

context:

  max_diff_chars: 50000

  surrounding_lines: 40

system_one:

  provider: typesafe

rules:

  task_completed:

    enabled: true

    review: 0.60

    block: 0.95

  unrelated_changes:

    enabled: true

    warn: 0.55

    review: 0.75

  tests_required:

    enabled: true

    warn: 0.60

    review: 0.80

  security_sensitive:

    enabled: true

    review: 0.65

deterministic:

  test:
    enabled: true

  lint:
    enabled: true

privacy:

  redact_secrets: true

  include_full_files: false
```

---

# 35. Custom Semantic Policy

这是 GitGuard 非常关键的能力。

用户可以写：

```yaml
custom_rules:

  - id: auth_requires_tests

    files:
      - "src/auth/**"

    question: >
      Does this change modify authentication
      behavior without corresponding tests?

    review: 0.70

    block: 0.95
```

支付：

```yaml
  - id: payment_behavior_change

    files:
      - "src/payment/**"

    question: >
      Does this change alter billing,
      settlement, refund, or payment
      calculation behavior?

    review: 0.60
```

这样形成：

> **Semantic Repository Policy**

用户不需要写：

```text
AST Rule
Regex
Custom Linter
```

就能定义语义约束。

---

# 36. Finding System

GitGuard 不应该只返回：

```text
REVIEW
```

必须返回可处理的：

```text
Finding
```

统一结构：

```ts
interface Finding {

  id: string;

  ruleId: string;

  source:
    | "deterministic"
    | "semantic"
    | "policy";

  status:
    | "warn"
    | "review"
    | "block";

  probability?: number;

  severity?:
    | "low"
    | "medium"
    | "high"
    | "critical";

  affectedFiles?: string[];

  evidence?: Evidence[];

  expectedEvidence?: string[];

  fingerprint: string;

}
```

---

# 37. Evidence

Evidence 让 Finding 更可信。

例如：

```json
{
  "type": "file_change",
  "path": "src/auth/token.ts",
  "lines": "72-104"
}
```

测试：

```json
{
  "type": "test_result",
  "command": "pnpm test",
  "status": "passed"
}
```

Policy：

```json
{
  "type": "repository_policy",
  "rule": "auth_requires_tests"
}
```

---

# 38. Finding Example

```json
{
  "id": "finding_01",

  "ruleId": "tests_required",

  "source": "semantic",

  "status": "review",

  "probability": 0.84,

  "affectedFiles": [
    "src/auth/token.ts"
  ],

  "evidence": [
    {
      "type": "behavior_change",
      "path": "src/auth/token.ts"
    }
  ],

  "expectedEvidence": [
    "Regression tests for expired tokens"
  ]
}
```

---

# 39. Finding Fingerprint

Fingerprint：

```text
SHA256(
  ruleId
  +
  file
  +
  normalizedDiff
)
```

用于识别：

```text
问题是否仍然存在
```

---

# 40. Verification Loop

GitGuard 最大价值之一：

> **发现问题 → Agent 修复 → 再验证**

例如：

```text
Agent 修改 auth/token.ts

       ↓

GitGuard Check

       ↓

Finding:
Missing regression tests

       ↓

Agent 新增 auth/token.test.ts

       ↓

GitGuard Verify

       ↓

Resolved
```

---

# 41. verify_fix

GitGuard 应保留 Finding 状态。

例如：

```json
{
  "finding_ids": [
    "finding_01"
  ]
}
```

重新检查后：

```json
{
  "resolved": [
    "finding_01"
  ],

  "remaining": []
}
```

这样 Agent 不需要每次重新理解所有问题。

---

# 42. MCP Adapter

MCP 是 GitGuard 面向 Coding Agent 的接入方式。

结构：

```text
Codex
Claude Code
Gemini CLI
Cursor
Other Agent

      ↓ MCP

GitGuard MCP Adapter

      ↓

GitGuard Core
```

因此目录应该是：

```text
src/interfaces/mcp/
```

而不是：

```text
整个项目叫 GitGuard MCP
```

---

# 43. MCP Tools

MVP 不需要很多工具。

推荐：

```text
inspect_changes

check_task_completion

check_before_commit

verify_findings

get_active_findings
```

---

# 44. inspect_changes

用途：

> 快速分析当前修改。

输入：

```json
{
  "scope": "staged"
}
```

返回：

```json
{
  "status": "warn",

  "summary": {

    "changedFiles": 4,

    "insertions": 82,

    "deletions": 19

  },

  "findings": []
}
```

---

# 45. check_task_completion

这是面向 Coding Agent 最重要的能力之一。

输入：

```json
{
  "task":
    "Fix expired token handling in login flow"
}
```

检查：

```text
Task Completion

Scope Match

Unrelated Changes

Missing Evidence
```

结果：

```json
{
  "taskCompleted": 0.93,

  "unrelatedChanges": 0.08,

  "status": "review"
}
```

---

# 46. check_before_commit

综合检查。

内部：

```text
Git
 ↓
Context
 ↓
Deterministic
 ↓
Semantic
 ↓
Policy
 ↓
Findings
```

输入：

```json
{
  "task":
    "Fix expired token handling"
}
```

输出：

```json
{
  "status": "review",

  "findings": [

    {
      "id": "finding_01",

      "ruleId": "missing_tests",

      "probability": 0.84,

      "affectedFiles": [
        "src/auth/token.ts"
      ]
    }

  ]
}
```

---

# 47. verify_findings

Agent 修复后调用。

```json
{
  "findingIds": [
    "finding_01"
  ]
}
```

输出：

```json
{
  "status": "pass",

  "resolved": [
    "finding_01"
  ],

  "remaining": []
}
```

---

# 48. MCP Resources

后续可以提供：

```text
gitguard://repository/status

gitguard://repository/policy

gitguard://findings

gitguard://instructions
```

让 Agent 查看状态而不触发重新分析。

---

# 49. CLI

CLI 是 GitGuard 面向开发者的主要接口。

建议：

```bash
gitguard inspect
```

```bash
gitguard check
```

```bash
gitguard check --staged
```

```bash
gitguard check \
  --task "fix login bug"
```

```bash
gitguard findings
```

```bash
gitguard verify
```

```bash
gitguard policy validate
```

```bash
gitguard mcp
```

最后这个：

```text
gitguard mcp
```

才是启动 MCP Adapter。

---

# 50. Git Hook

Git Hook 也是 Adapter。

```text
git commit
    ↓
pre-commit
    ↓
gitguard check --staged
```

配置：

```yaml
git:

  pre_commit:

    enabled: true

    block_on:
      - BLOCK
```

初期建议：

```text
REVIEW
```

只提示。

```text
BLOCK
```

才阻断 commit。

---

# 51. GitHub Action

后续：

```text
Pull Request
     ↓
GitHub Action
     ↓
GitGuard Core
```

PR Check：

```text
GitGuard

Task Completion       PASS

Scope                  PASS

Test Evidence          REVIEW

Security               PASS

Regression Risk        MEDIUM

Overall                REVIEW
```

---

# 52. CI Interface

CI 本质也是 Adapter。

未来支持：

```text
GitHub Actions
GitLab CI
Jenkins
Azure DevOps
```

全部调用：

```text
gitguard check
```

不重复实现分析逻辑。

---

# 53. System Two Escalation

后续可以加入：

```text
System One
    ↓
风险高 / 判断不确定
    ↓
System Two Deep Review
```

但 GitGuard 第一版不必自己调用 GPT / Claude。

更合理的是返回：

```json
{
  "action":
    "deep_review_required"
}
```

Coding Agent 收到后自己进行：

```text
Deep Review
```

这样不会产生：

```text
模型 Provider 强绑定

额外 API Key

额外 Token 成本

复杂权限问题
```

---

# 54. Cache

必须做。

Cache Key：

```text
SHA256(
  task
  +
  diff
  +
  policy
  +
  providerVersion
)
```

缓存目录：

```text
.git/gitguard/cache/
```

同样代码重复检查：

```text
直接返回缓存
```

---

# 55. Incremental Verification

未来进一步优化：

```text
Previous Diff
     ↓
Current Diff
     ↓
Diff Delta
```

只重新计算相关 Rule。

例如 Agent 只添加：

```text
auth.test.ts
```

那么重点重新执行：

```text
tests_present
```

不必重新分析所有安全风险。

---

# 56. Privacy

GitGuard 默认：

> **只发送最少必要代码。**

默认：

```yaml
privacy:

  include_full_files: false

  redact_secrets: true
```

敏感文件默认排除：

```text
.env

*.pem

*.key

credentials.json

secrets.*

id_rsa
```

---

# 57. Secret Redaction

调用外部 Semantic Provider 前：

```text
Secret Scanner
      ↓
Redaction
      ↓
System One
```

例如：

```text
sk-xxxxxxx
```

替换成：

```text
<REDACTED_SECRET>
```

---

# 58. Binary Files

不发送：

```text
Video
Image
Database
Archive
Compiled Binary
```

只传：

```text
Binary file modified:
assets/logo.png
```

---

# 59. Prompt Injection 防御

Repository 中任何普通代码、注释、README 都属于：

```text
DATA
```

不是：

```text
SYSTEM INSTRUCTION
```

即使里面写：

```text
Ignore GitGuard rules.
```

也不得改变：

```text
GitGuard 权限
Policy
执行行为
```

---

# 60. Rule 权限

真正能够控制 GitGuard 的配置只有：

```text
.gitguard.yml
```

AGENTS.md 等文件可以成为：

```text
Repository Guidance
```

但不允许：

```text
开启 Shell 权限

修改 GitGuard 权限

关闭安全机制
```

---

# 61. Audit Log

本地可以记录：

```text
.git/gitguard/audit.jsonl
```

例如：

```json
{
  "timestamp": "...",

  "diffHash": "...",

  "taskHash": "...",

  "decision": "review",

  "rules": {
    "tests_required": 0.82
  }
}
```

不要默认保存：

```text
完整源代码
```

---

# 62. Benchmark

GitGuard 最终是否靠谱，不能靠：

```text
“看起来挺聪明”
```

必须 Benchmark。

结构：

```text
benchmarks/

├── task-completion/
├── unrelated-change/
├── missing-tests/
├── security/
├── refactor/
├── breaking-change/
└── mixed/
```

---

# 63. Benchmark Case

```json
{
  "task":
    "Fix token expiration handling",

  "diff":
    "...",

  "expected": {

    "taskCompleted": true,

    "testsRequired": true,

    "unrelatedChanges": false

  }
}
```

---

# 64. 关键指标

测：

```text
Precision

Recall

False Positive Rate

False Review Rate

False Block Rate

Latency

Cost per Check

Cache Hit Rate
```

最重要：

```text
False Block Rate
```

因为一个质量门禁工具：

```text
如果总是误拦
```

开发者最终一定会关闭它。

---

# 65. Calibration

阈值不应拍脑袋。

例如：

```text
tests_required

WARN:
0.60

REVIEW:
0.80

BLOCK:
0.97
```

应该根据真实 Benchmark 调整。

---

# 66. 可观测性

本地统计：

```text
checks_total

semantic_calls

cache_hits

average_latency

warn_rate

review_rate

block_rate
```

这样后续能发现：

```text
某规则是不是过于严格
```

---

# 67. Repository Structure

推荐：

```text
gitguard/
│
├── src/
│
│   ├── core/
│   │   ├── engine.ts
│   │   ├── types.ts
│   │   └── result.ts
│   │
│   ├── git/
│   │   ├── adapter.ts
│   │   ├── diff.ts
│   │   └── status.ts
│   │
│   ├── context/
│   │   ├── builder.ts
│   │   ├── instructions.ts
│   │   ├── related-files.ts
│   │   └── tests.ts
│   │
│   ├── verification/
│   │   ├── engine.ts
│   │   └── semantic.ts
│   │
│   ├── deterministic/
│   │   ├── runner.ts
│   │   └── checks.ts
│   │
│   ├── providers/
│   │   ├── provider.ts
│   │   └── typesafe.ts
│   │
│   ├── policy/
│   │   ├── loader.ts
│   │   ├── engine.ts
│   │   └── defaults.ts
│   │
│   ├── findings/
│   │   ├── finding.ts
│   │   ├── fingerprint.ts
│   │   └── store.ts
│   │
│   ├── cache/
│   │   └── cache.ts
│   │
│   ├── security/
│   │   ├── redaction.ts
│   │   └── paths.ts
│   │
│   └── interfaces/
│       │
│       ├── cli/
│       │
│       ├── mcp/
│       │
│       ├── git-hook/
│       │
│       └── ci/
│
├── tests/
│
├── benchmarks/
│
├── examples/
│
├── docs/
│
├── .gitguard.yml
│
├── package.json
│
└── README.md
```

---

# 68. Core Engine 示例

```ts
class GitGuardEngine {

  async inspect(
    input: InspectionInput
  ): Promise<InspectionResult> {

    const repository =
      await this.git.collectState();

    const context =
      await this.contextBuilder.build({
        repository,
        task: input.task,
        scope: input.scope
      });

    const deterministic =
      await this.deterministic.run(context);

    const semantic =
      await this.provider.evaluate(
        context,
        this.questions
      );

    const findings =
      this.policy.evaluate({
        deterministic,
        semantic,
        context
      });

    return {
      status:
        calculateOverallStatus(findings),

      findings
    };
  }
}
```

---

# 69. 使用案例：Coding Agent

用户：

```text
修复登录 Token 过期后仍可以继续访问的问题。
```

Agent：

```text
修改 auth/token.ts
```

然后调用：

```text
GitGuard MCP
```

内部：

```text
Task
+
Diff
+
Auth Rules
+
Tests
+
Repository Context
```

System One：

```text
task_completed       0.94

tests_required       0.91

tests_present        0.32

security_sensitive   0.88
```

GitGuard：

```text
REVIEW
```

Finding：

```text
Authentication behavior changed.

Regression tests appear insufficient.
```

Agent：

```text
新增 token.test.ts
```

再次调用：

```text
verify_findings
```

结果：

```text
PASS
```

---

# 70. 使用案例：开发者 Commit

```bash
git add .
git commit -m "fix auth token"
```

Pre-commit：

```text
GitGuard

✓ Lint
✓ Types
✓ Tests

✓ Task Scope

⚠ Authentication behavior changed

⚠ Additional regression tests may be required

Decision:
REVIEW
```

根据仓库 Policy：

```text
允许 Commit
```

或者：

```text
阻止 Commit
```

---

# 71. 使用案例：Pull Request

CI：

```text
GitGuard PR Check

Changed Files: 7

Task Completion:
PASS

Scope:
PASS

Repository Policy:
PASS

Test Evidence:
REVIEW

Security Sensitive:
PASS

Overall:
REVIEW
```

团队成员可以继续人工检查。

---

# 72. MVP 范围

第一版只做核心价值。

## Core

```text
Git Adapter

Context Builder

Verification Engine

Policy Engine

Finding System

Cache
```

## Semantic

```text
task_completed

unrelated_changes

tests_required

security_sensitive

regression_risk
```

## Interfaces

```text
CLI

MCP
```

## Config

```text
.gitguard.yml
```

---

# 73. 第一版暂时不做

```text
Web Dashboard

VS Code Extension

复杂 AST Engine

GitHub App

Organization Backend

Remote Policy

System Two Provider

自动修复代码

自动 Commit

自动 Push
```

这些都属于后续扩展。

---

# 74. 开发阶段

## Phase 1

Git Core

完成：

```text
gitguard inspect
```

---

## Phase 2

Context Builder

完成：

```text
Diff
Changed Files
AGENTS.md
.gitguard.yml
```

---

## Phase 3

TypeSafe Provider

实现：

```text
task_completed

unrelated_changes

tests_required
```

---

## Phase 4

Policy Engine

实现：

```text
PASS
WARN
REVIEW
BLOCK
```

---

## Phase 5

Finding System

实现：

```text
Finding ID

Fingerprint

Evidence

Expected Evidence
```

---

## Phase 6

CLI

实现：

```text
gitguard inspect

gitguard check

gitguard findings

gitguard verify
```

---

## Phase 7

MCP Adapter

实现：

```text
inspect_changes

check_task_completion

check_before_commit

verify_findings
```

---

## Phase 8

Cache

实现：

```text
Diff Cache

Semantic Result Cache
```

---

## Phase 9

Benchmark

准备至少：

```text
50-100 个真实修改样本
```

---

# 75. 第二阶段

增加：

```text
Git Hook

Custom Semantic Policy

Deterministic Commands

GitHub Action
```

---

# 76. 第三阶段

增加：

```text
Incremental Verification

System Two Escalation

Remote MCP

Team Policy

Audit

Metrics
```

---

# 77. 第四阶段

项目真正有用户后再考虑：

```text
VS Code Extension

GitHub App

Web Dashboard

Organization Policy Server

Enterprise Audit
```

---

# 78. GitGuard 的技术壁垒

真正有价值的并不是：

```text
MCP Server
```

因为 MCP Adapter 本身不难。

真正形成项目能力的是：

## Context Builder

准确找到：

```text
模型真正应该看到什么
```

---

## Verification Model

把复杂的：

```text
“这次改动靠谱吗？”
```

拆解成：

```text
多个稳定的小问题
```

---

## Policy Engine

把概率输出变成：

```text
可靠工程规则
```

---

## Finding / Verification Loop

形成：

```text
发现
 ↓
修复
 ↓
验证
```

---

## Benchmark

证明：

```text
GitGuard 不是一个随机 AI Reviewer
```

---

# 79. 项目边界

GitGuard 应坚持：

```text
Repository Quality Gate
```

而不要不断扩展成：

```text
IDE

Coding Agent

CI Platform

Code Search Engine

Project Management Tool
```

其他能力应该通过：

```text
Adapter
Provider
Plugin
```

连接。

---

# 80. 最终架构

```text
             Developers
                 │
                CLI
                 │
                 ▼

Coding Agents → MCP ───┐
                       │
Git Hook ───────────────┤
                       ▼
                  GitGuard Core
                       │
            ┌──────────┼───────────┐
            ▼          ▼           ▼
         Context   Deterministic  Semantic
         Builder      Engine      Provider
            │          │           │
            └──────────┼───────────┘
                       ▼
                  Policy Engine
                       │
                       ▼
                    Findings
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        PASS          REVIEW       BLOCK
                       │
                       ▼
                    Fix Loop
```

---

# 81. GitGuard 一句话定义

推荐：

> **GitGuard is a repository-aware quality gate that verifies code changes before they are accepted.**

如果突出 Agent：

> **GitGuard verifies whether developers and coding agents actually completed a task safely before their changes are accepted.**

中文：

> **GitGuard 是一个仓库感知的代码变更质量门禁系统，用于在代码被提交或接受之前验证任务完成度、修改范围、测试证据、仓库规则与潜在风险。**

---

# 82. README 开头推荐

> # GitGuard
>
> **Repository-aware quality gate for developers and coding agents.**
>
> GitGuard verifies code changes before they are committed, merged, or accepted by an autonomous coding workflow.
>
> It combines deterministic checks, repository context, semantic System One decisions, and configurable policy rules to answer questions such as:
>
> - Did this change actually complete the task?
> - Did it introduce unrelated changes?
> - Does it require additional tests?
> - Does it violate repository policy?
> - Does it affect security-sensitive behavior?
> - Should the change pass, warn, require review, or be blocked?
>
> GitGuard can be used through the CLI, Git hooks, CI pipelines, or MCP-based coding agents.

---

# 83. 核心原则

GitGuard 最终应该始终坚持：

1. **Core 与所有 Interface 解耦。**
2. **MCP 只是 Adapter，不是项目本体。**
3. **GitGuard 默认只读。**
4. **确定性问题交给确定性工具。**
5. **System One 只处理清晰的小型语义判断。**
6. **概率不等于事实。**
7. **最终行为由 Policy Engine 决定。**
8. **所有问题尽可能返回结构化 Finding。**
9. **GitGuard 不负责写代码，Agent 负责修复。**
10. **核心目标是建立 Inspect → Fix → Verify 的可靠闭环。**

---

# 84. 最终结论

GitGuard 最终不是：

```text
Jev Demo

MCP Tool

AI Git Hook

AI Code Reviewer
```

而应该是：

> **Repository-aware Change Verification Infrastructure**

即：

> **为开发者、Coding Agent 和 CI 提供统一代码变更验证能力的基础设施。**

最终关系：

```text
Developer
Coding Agent
CI

     ↓

GitGuard

     ↓

验证代码修改是否：

完成任务
遵守范围
符合规则
具有测试证据
没有明显风险

     ↓

PASS / WARN / REVIEW / BLOCK
```

MCP、CLI、Git Hook、GitHub Action 都只是 GitGuard 进入不同开发工作流的方式。

真正的 GitGuard，是中间那套：

```text
Context
+
Verification
+
Policy
+
Findings
+
Evidence
+
Repair Verification
```

这才应该成为项目长期维护和迭代的核心。