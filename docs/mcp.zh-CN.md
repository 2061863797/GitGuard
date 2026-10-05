# GitGuard MCP 调用指南

本指南描述当前源码的四个 stdio MCP 工具。先按 [README](../README.md#mcp-server-setup)配置客户端；源码启动前运行 `pnpm build`。EXE 的功能取决于该文件的实际版本，源码更新不会自动更新已有 EXE。

## 调用顺序与执行范围

| 步骤 | 工具 | 判断内容 | 执行与副作用 |
| --- | --- | --- | --- |
| 1 | `inspect_changes` | 文件与 diff 统计，确认目标仓库和选中范围 | 本地读取；不扫描密钥、不运行检查、不联网、不保存 finding |
| 2 | `check_task_completion` | 任务完成度、范围匹配、无关改动 | 在线语义评估；不运行本地项目检查，可保存 finding |
| 3 | `check_before_commit` | 提交前质量门禁 | 默认 `staged`；运行配置的检查和密钥扫描，在线评估并保存 finding |
| 4 | `verify_findings` | 已有 finding 是否修复、当前范围是否仍有阻断 | 已知 ID 会执行检查、在线评估并更新记录；未知 ID 提前阻断 |

步骤 2 按需要使用，不能代替步骤 3。所有检查结论均限定在选中范围；`filesChanged: 0` 不证明任务完成或测试已运行。质量门禁会运行目标仓库的检查命令，这些命令可能写入文件。

三个语义工具要求新的 TypeSafe 在线响应，不使用本地模拟或语义缓存。缺少密钥、服务失败或无效响应会返回工具错误。未知 finding ID 的复验提前返回 `BLOCK`，此时不会联网或运行项目检查。

## 参数约定

- `cwd` 和 `repoPath` 是同义参数，四个工具都支持。建议传入目标仓库的绝对路径；省略时使用 MCP 服务的工作目录。同时提供时，必须解析为同一路径。相对路径以服务工作目录为基准。
- `scope` 可选 `staged`、`working`、`all`、`commit`、`range`；`check_before_commit` 只接受前三种，默认 `staged`。其他工具默认 `all`。
- `target` 用于定位提交，`inspect_changes`、`check_task_completion` 和 `verify_findings` 支持它。传入单个引用时推断 `commit`；传入完整 `base..head` 或 `base...head` 时推断 `range`。显式选择 `commit` / `range` 时必须提供匹配的 `target`，不能与 `staged` 等范围同时使用。
- `base..head` 比较端点，`base...head` 比较共同祖先到 `head` 的改动。空端点、多重范围分隔符、选项形式或带空白/控制字符的引用会被拒绝。
- `check_task_completion.task` 必须是非空文本。其他工具的 `task` 可选，提供时也必须非空。
- `verify_findings.findingIds` 必须是当前仓库中已有 ID 的非空字符串数组。空元素、数字等错误类型会被拒绝，重复 ID 会去重。
- 为兼容既有客户端，运行时仍接受逗号分隔的 `findingIds` 字符串及 `findings` 别名。新调用统一使用数组；同时提供两种字段时，规范化后的 ID 列表必须一致。
- 未声明的参数会被拒绝，错误类型不会传入引擎。MCP 不开放 `offline`、`onlineOnly`、`noCache` 或配置覆盖参数。

Git 的两种范围定义见 [Git diff 官方说明](https://git-scm.com/docs/git-diff)。

## 可复制的工具调用

以下是 `tools/call` 的 `params` 对象；客户端通常只需选择工具并填入 `arguments`，无需手工构造完整 JSON-RPC 消息。

先看所有未提交改动：

```json
{
  "name": "inspect_changes",
  "arguments": {
    "cwd": "C:\\work\\my-project",
    "scope": "all"
  }
}
```

检查分支引入的改动与任务是否一致：

```json
{
  "name": "check_task_completion",
  "arguments": {
    "cwd": "C:\\work\\my-project",
    "task": "修复登录超时，并补充超时重试测试",
    "target": "main...HEAD"
  }
}
```

检查已经暂存、准备提交的改动：

```json
{
  "name": "check_before_commit",
  "arguments": {
    "cwd": "C:\\work\\my-project",
    "task": "修复登录超时，并补充超时重试测试",
    "scope": "staged"
  }
}
```

修复后复验：请将示例 ID 替换为上一轮在**同一仓库**中实际返回的 ID。

```json
{
  "name": "verify_findings",
  "arguments": {
    "cwd": "C:\\work\\my-project",
    "findingIds": ["finding_from_previous_result"],
    "task": "修复登录超时，并补充超时重试测试",
    "scope": "all"
  }
}
```

## 结果与错误

成功执行同时返回 `structuredContent` 与 JSON 文本，二者内容一致，客户端可以优先读取结构化结果。使用 JSON 文本的既有客户端仍可解析。工具注解会标明本地只读、联网和可能写入文件的行为；注解用于客户端提示，不能替代实际授权与检查。[MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

| 字段 | 含义 |
| --- | --- |
| `status` / `verdict` | `PASS`、`WARN`、`REVIEW`、`BLOCK`；表示本次范围的检查结论 |
| `isError: true` | 参数或执行出错，不能按正常门禁结果处理 |
| `canCommit` | 本次门禁允许继续的判断，不执行 Git 提交，也不代表用户已授权提交 |
| `taskCompleted` 等概率 | 在线响应中的任务判断；不是确定性证明 |
| `semantic` | 实际 provider、模型及 fallback 信息；不伪造缺失概率或模型名 |
| `diffSummary` | 检查范围的文件与行数统计，需与预期变更一致 |
| `resolved` / `remaining` | 本次复验中已解决 / 仍存在的目标 ID |
| `unknownFindings` | 当前仓库中找不到的 ID，非空时提前 `BLOCK` |
| `targetsResolved` | 指定 finding 在本次评估中是否修复 |
| `allResolved` | 指定目标已修复且本次门禁无阻断；不代表其他范围或所有历史记录均已清除 |
| `metadata.persistenceOk` | 本轮涉及记录写入时的保存状态；`false` 表示记录未可靠保存 |

`BLOCK` 是有效评估结果，通常不设置 `isError`。finding 存储读取损坏会返回执行错误；复验记录保存失败会返回 `BLOCK`、`allResolved: false` 和 `persistenceOk: false`。这时应先处理存储访问问题，再重试。

参数和执行错误提供 `structuredContent.error.code` 与 `message`：

| 错误码 | 处理 |
| --- | --- |
| `INVALID_ARGUMENTS` | 修正参数类型、空值、路径冲突或范围冲突后重新调用 |
| `TOOL_EXECUTION_FAILED` | 根据错误检查 Git、目标配置、检查工具链、存储访问或在线服务；修复原因后重试 |
| `UNKNOWN_TOOL` | 仅直接调用执行辅助函数时返回；协议上的未知工具使用 `-32602` 参数错误 |

已知密钥格式会在结果与错误文本中脱敏；这不保证覆盖所有秘密。日志和 JSON 仍可能包含仓库路径或其他项目内容，请按项目的保密要求处理。

## 超时与排查

Codex 的 stdio 服务器可设置：

```toml
[mcp_servers.gitguard]
command = 'C:\Tools\GitGuard\GitGuard.exe'
args = ["mcp"]
cwd = 'C:\work\my-project'
env_vars = ["TYPESAFE_API_KEY"]
tool_timeout_sec = 180
```

`tool_timeout_sec` 控制客户端等待时长。项目检查、在线请求和重试各有自己的超时，应按总耗时设置客户端上限；上面的 180 秒只是示例。[Codex MCP 官方配置说明](https://developers.openai.com/codex/mcp)

- 工具未出现：核对启动命令、路径、Git 可用性；源码版本先构建，使用 `node bin/gitguard.js --help` 验证入口。
- 显示零文件：核对仓库路径、暂存状态、工作区改动和提交范围。
- 缺少密钥：确认启动客户端的进程继承了 `TYPESAFE_API_KEY`，而不只是另一个终端拥有它。
- 未知 ID：回到同一仓库查询实际记录，不应自动换仓库或将未知 ID 当作已解决。
- 客户端超时：查看 stderr 和进程状态，确认原调用已结束再重试；语义工具可能保存 finding 状态，门禁和复验还可能运行项目脚本。
- 协议内容异常：stdout 应只有 JSON-RPC；诊断位于 stderr，`--debug` 也遵循这一约定。

MCP 服务不执行 `git add`、`commit` 或 `push`。检查结束后的代码修改与 Git 操作由使用者或调用它的代理自行安排。
