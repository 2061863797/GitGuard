# GitGuard

[![CI](https://github.com/2061863797/GitGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/2061863797/GitGuard/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

GitGuard 是给 AI 编程 agent 用的**提交前检查**。agent 写完代码、准备提交时调用它，它检查 Git 仓库里的改动，给出 `PASS`、`WARN`、`REVIEW` 或 `BLOCK`，并列出带 ID 的问题（finding）。agent 修完后再用这些 ID 复验。

GitGuard 只负责检查：不改代码，不执行 `git add`、`commit`、`push`。

## 它检查什么

每次检查由三部分组成：

| 部分 | 内容 | 谁决定 |
|:---|:---|:---|
| **确定性检查** | 新增内容的密钥扫描（始终开启）；测试、lint、类型检查 | 测试、lint、类型检查的命令写在仓库的 `.gitguard.yml` 里，**没写就不执行** |
| **agent 的题** | 针对本次任务的是/否问题，例如“是否用浮点数计算金额？” | 调用时由 agent 根据当前项目临时出题 |
| **用户的题** | 每次都要问的是/否问题 | 写在 `.gitguard.yml` 的 `questions:` 里 |

agent 的题和用户的题会一起发给 [TypeSafe](https://typesafe.ai/) 的 System One（Jev）模型判断。题目都问成“问题是否存在”：回答“是”的概率 ≥ 0.5 时，按这道题的 `level` 记一个 finding。

**不出题时不需要 API 密钥**，只跑确定性检查。出题时必须设置 `TYPESAFE_API_KEY`；如果缺少密钥或请求失败，GitGuard 会直接报错，不会用本地猜测的结果代替。

## 安装

前提：已安装 [Node.js](https://nodejs.org/) 20 或更高版本，以及 Git。

### Claude Code

```text
/plugin marketplace add 2061863797/GitGuard
/plugin install gitguard
```

安装后会得到 `gitguard` MCP 服务和 `gitguard` skill。skill 告诉 agent 什么时候检查、怎么出题、怎么处理结果。

### Codex

```bash
codex plugin marketplace add 2061863797/GitGuard
```

重启 Codex，在插件列表里启用 `gitguard`。Codex 启动插件里的 MCP 服务时可能只保留少数环境变量，所以插件显式声明了转发 `TYPESAFE_API_KEY`。这个变量本身要能被 Codex 读到，见下文[设置 API 密钥](#设置-api-密钥)。

### 其他 agent

任何支持 stdio MCP 的客户端都可以直接使用打包好的服务。先克隆本仓库，然后在客户端的 MCP 配置里写入（路径换成实际位置；JSON 里的 Windows 反斜杠要写成 `\\`）：

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "node",
      "args": ["C:\\Tools\\GitGuard\\plugins\\gitguard\\server\\gitguard-mcp.mjs"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```

`env` 的写法因客户端而异，按客户端的说明转发环境变量即可。如果客户端支持 SKILL.md 格式的 skill，把 [`plugins/gitguard/skills/gitguard`](plugins/gitguard/skills/gitguard/SKILL.md) 整个目录拷进它的 skills 目录。不支持 skill 的客户端仍会通过 MCP 的 server instructions 和工具描述拿到核心规则。

## 设置 API 密钥

1. 登录 [TypeSafe 控制台](https://console.typesafe.ai/) 获取 API Key。
2. 在 PowerShell 中保存为当前 Windows 用户的环境变量（输入不会显示，也不会进入命令历史）：

   ```powershell
   $key = [System.Net.NetworkCredential]::new('', (Read-Host 'TypeSafe API Key' -AsSecureString)).Password
   [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $key, 'User')
   ```

3. 完全退出并重新打开 Claude Code 或 Codex，让它们读到新的环境变量。

macOS / Linux 把 `export TYPESAFE_API_KEY=...` 写进 shell 配置文件即可。**不要**把密钥写进 `.gitguard.yml` 或其他仓库文件，GitGuard 会拒绝这种配置。

## 配置 `.gitguard.yml`

把 `.gitguard.yml` 放在**被检查仓库**的根目录。没有这个文件时，只做密钥扫描。

```yaml
version: 1

# 确定性检查：写了 run 才会执行；超时单位为毫秒
deterministic:
  test:
    run: "npm test"
    timeout_ms: 120000
  lint:
    run: "npm run lint"
  typecheck:
    run: "npx tsc --noEmit"

# 用户的题：每次检查都会问
questions:
  - id: money_float                     # 小写字母、数字、下划线
    question: "Does this change calculate money with floating-point numbers?"
    level: block                        # warn | review | block
    files: ["src/billing/**"]           # 可选：改动没碰到这些文件就不问
    exclude: ["**/*.test.ts"]           # 可选
```

写题时注意：

- **问成“问题是否存在”**，回答“是”就表示有问题。例如问“是否缺少回滚路径？”，不要问“是否有回滚路径？”。
- `level` 是回答“是”时的结论：
  - `warn`：提示一下；
  - `review`：需要人判断；
  - `block`：不能提交。

其他可选配置：

| 配置段 | 用途 |
|:---|:---|
| `context` | 限制发给模型的 diff、周边代码、相关测试和仓库说明的大小 |
| `system_one` | 模型名（默认 `jev-latest`）和超时 |
| `deterministic.secret_scan` | 追加自定义密钥正则 `patterns`；`block_on_detection: false` 时发现密钥判为 REVIEW 而不是 BLOCK |
| `privacy` | 追加不发送给模型的路径 `exclude_paths`；不能关闭脱敏 |

完整示例见[本仓库自己的 `.gitguard.yml`](.gitguard.yml)。

> **从 0.2 升级**：`rules`、`custom_rules`、`gate`、`system_one.provider` 已经删除。配置里还有这些字段时，检查会报错并提示怎么迁移：把 `custom_rules` 的每一条改写成 `questions` 里的一道题，其余字段直接删掉。

## MCP 工具

### `check`

| 参数 | 说明 |
|:---|:---|
| `cwd` | **必填**，被检查仓库的绝对路径 |
| `scope` | `all`（默认，全部未提交改动）、`staged`、`working`、`commit`、`range` |
| `target` | 提交或范围，如 `HEAD`、`main...feature`；传了会自动推断 `scope` |
| `task` | 任务描述，作为背景信息发给模型 |
| `questions` | 最多 10 道题，格式同 `.gitguard.yml` 的 `questions`（不含 `source`） |

返回结果中的主要字段：

- `status`：检查结论。
- `canCommit`：结论不是 `BLOCK` 时为 `true`。
- `deterministic`：每项确定性检查的状态。
- `answers`：每道题的回答概率和理由。
- `findings`：每个问题的 `id`、来源题目和修复建议。
- `diffSummary`：改动统计。

### `verify`

| 参数 | 说明 |
|:---|:---|
| `cwd` | **必填**，仓库绝对路径 |
| `findingIds` | 之前 `check` 返回的 finding ID |
| `scope`、`target`、`task` | 同 `check` |

`verify` 会重新跑确定性检查，并重新提问当初产生这些 finding 的题目，不需要 agent 再传一遍。传入当前仓库不存在的 ID 时，会直接返回 `BLOCK` 和 `unknownFindings`，不执行任何命令，也不联网。

### 结论怎么看

| 结论 | 含义 |
|:---|:---|
| `PASS` | 没有发现问题。先确认 `diffSummary.filesChanged` 大于 0，否则说明检查范围是空的 |
| `WARN` | 有提示项，看一眼即可 |
| `REVIEW` | 需要人判断 |
| `BLOCK` | 不能提交，修复后用 `verify` 复验 |

工具调用出错（参数无效、缺少密钥、配置有误）时返回 `isError: true` 和错误原文。`BLOCK` 是正常的检查结论，不算错误。

## 安全

- 测试、lint、类型检查命令会在被检查仓库里执行，可能运行项目脚本、写入文件。只检查你信任的仓库。
- 发给模型的内容会排除敏感文件，并对已知格式的密钥脱敏；本地密钥扫描使用未脱敏的原始改动。脱敏基于规则，不能保证识别所有秘密。
- finding 记录保存在被检查仓库的 `.git/gitguard/` 下。

详细的威胁模型见 [SECURITY.md](SECURITY.md)。

## 开发

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # 会先执行 pnpm build
pnpm bundle        # 重新生成 plugins/gitguard/server/gitguard-mcp.mjs
pnpm test:bundle   # 从插件目录启动打包产物做冒烟测试
```

插件安装时不会执行 `npm install`，所以打包产物 `plugins/gitguard/server/gitguard-mcp.mjs` 需要提交进仓库。改了 `src/` 后要运行 `pnpm bundle`，CI 会检查产物是否最新。

发布新版本时，要同步更新这几处的版本号：`package.json`、`src/version.ts`、`plugins/gitguard/.claude-plugin/plugin.json`、`plugins/gitguard/.codex-plugin/plugin.json`。

```text
src/                     MCP 服务源码（引擎、Git 读取、上下文、检查、策略、finding）
plugins/gitguard/        插件本体：两份清单、Codex 的 MCP 配置、skill、打包产物
.claude-plugin/          Claude Code 插件市场
.agents/plugins/         Codex 插件市场
```

## 许可

[Apache-2.0](LICENSE)
