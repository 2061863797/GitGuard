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
| **agent 的规则** | 针对本次任务的规则，例如“所有外部输入都必须经过校验” | 调用时由 agent 根据当前项目临时写 |
| **用户的规则** | 每次都要遵守的规则，例如“金额计算不能使用浮点数” | 写在 `.gitguard.yml` 的 `rules:` 里 |

规则直接写成要求，不用写成问句。agent 的规则和用户的规则会一起发给 [TypeSafe](https://typesafe.ai/) 的 System One（Jev）模型，由它判断这次改动是否违反每条规则。判定违反的概率 ≥ 0.5 时，按这条规则的 `level` 记一个 finding。

**没有规则时不需要 API 密钥**，只跑确定性检查。有规则时必须设置 `TYPESAFE_API_KEY`；如果缺少密钥或请求失败，GitGuard 会直接报错，不会用本地猜测的结果代替。

**提交前强制检查**：仓库里有 `.gitguard.yml` 时，插件自带的 hook 会在 agent 执行 `git commit` 之前做确认。最近一次检查必须覆盖了这次要提交的内容，并且结论不是 `BLOCK`，否则提交会被拦截。这只约束 agent，你自己在终端里提交不受影响。详见[提交拦截](#提交拦截)。

## 安装

前提：已安装 [Node.js](https://nodejs.org/) 20 或更高版本，以及 Git。

### Claude Code

```text
/plugin marketplace add 2061863797/GitGuard
/plugin install gitguard
```

安装后会得到 `gitguard` MCP 服务、两个 skill 和提交拦截 hook：
- `gitguard` skill 告诉 agent 什么时候检查、怎么写规则、怎么处理结果；
- `gitguard-setup` skill 引导 agent 帮你创建 `.gitguard.yml`。

检查最长等待 15 分钟（插件里已经设置好）。

### Codex

```bash
codex plugin marketplace add 2061863797/GitGuard
```

重启 Codex，在插件列表里启用 `gitguard`。Codex 会要求你确认插件自带的 hook 后才运行它，提交拦截要在确认后才生效。插件已经把 Codex 调用 GitGuard 的等待上限设成 15 分钟，避免项目命令跑得久时超时。Codex 启动插件里的 MCP 服务时可能只保留少数环境变量，所以插件显式声明了转发 `TYPESAFE_API_KEY`。这个变量本身要能被 Codex 读到，见下文[设置 API 密钥](#设置-api-密钥)。

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

`env` 的写法因客户端而异，按客户端的说明转发环境变量即可。如果客户端支持 SKILL.md 格式的 skill，把 [`plugins/gitguard/skills`](plugins/gitguard/skills) 下的两个目录拷进它的 skills 目录。如果项目命令跑得比较久，记得把客户端对 MCP 工具调用的等待上限调大。不支持 skill 的客户端仍会通过 MCP 的 server instructions 和工具描述拿到核心规则。

提交拦截依赖客户端的 PreToolUse hook。如果客户端支持同样格式的 hook（命令从 stdin 读事件 JSON，退出码 2 表示拦截），可以参照 [`plugins/gitguard/hooks/hooks.json`](plugins/gitguard/hooks/hooks.json) 配置；不支持的客户端只能靠 skill 提醒 agent 自觉检查。

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

把 `.gitguard.yml` 放在**被检查仓库**的根目录。这个文件是可选的：没有它时，GitGuard 仍会做密钥扫描，并判断 agent 传入的规则；有了它，才会跑项目命令、带上项目规则，并开启[提交拦截](#提交拦截)。

**最简单的方式是让 agent 帮你创建**：对它说“帮我给这个项目配置 GitGuard”。插件里的 `gitguard-setup` skill 会引导它完成这些事：
1. 从 `package.json`、`pyproject.toml`、`Makefile`、CI 配置等文件里找出项目实际在用的命令；
2. 和你一起确定规则；
3. 让你确认后再写入；
4. 跑一次检查，确认配置能用。

文件只有三部分，都是可选的：

```yaml
version: 1

# 项目命令：每次检查都会在本机执行，失败即 BLOCK
deterministic:
  test: "npm test"              # 简写
  lint: "npm run lint"
  typecheck:                    # 完整写法，需要调整超时时用（毫秒，默认 60000）
    run: "npx tsc --noEmit"
    timeout_ms: 120000

# 项目规则：每次检查都会判断改动是否违反
rules:
  - id: no_float_money          # 小写字母、数字、下划线
    rule: "金额计算不能使用浮点数"
    level: block                # warn | review | block
    files: ["src/billing/**"]   # 可选：改动没碰到这些文件就跳过
    exclude: ["**/*.test.ts"]   # 可选

# 可选：在内置密钥规则之外再扫描的正则
secret_scan:
  patterns: ["ACME_[A-Z0-9]{32}"]
```

只接受这几个字段，写了其他字段（包括拼错的）会直接报错，避免配置没生效却没人发现。发给模型的上下文大小、模型名称、脱敏和敏感文件排除都使用内置的默认值，不能在仓库里修改。

**项目命令**
- 只能写一行命令；
- 不能用 `&&`、`|`、`;`、重定向等 shell 连接符，需要组合多步时改用项目里现成的脚本；
- 只检查你信任的仓库，因为这些命令会在本机执行。

**写规则时注意**：

- **直接写要求**，说清代码必须做什么或不能做什么。例如“数据库迁移必须提供回滚脚本”，不用写成问句。
- **要具体到能从改动里判断“违反/没违反”**。例如“函数不得超过 50 行”“新增的 HTTP 接口必须校验登录态”是好规则；“代码要写得简洁”“注意安全”没有判断标准，模型只能凭感觉回答，结果不稳定。
- 一条规则只管一件事。
- `level` 是违反规则时的结论：
  - `warn`：提示一下；
  - `review`：需要人判断；
  - `block`：不能提交。

完整示例见[本仓库自己的 `.gitguard.yml`](.gitguard.yml)。

## MCP 工具

### `check`

| 参数 | 说明 |
|:---|:---|
| `cwd` | **必填**，被检查仓库的绝对路径 |
| `scope` | `all`（默认，全部未提交改动）、`staged`、`working`、`commit`、`range` |
| `target` | 提交或范围，如 `HEAD`、`main...feature`；传了会自动推断 `scope` |
| `task` | 任务描述，作为背景信息发给模型 |
| `rules` | 最多 10 条规则，格式同 `.gitguard.yml` 的 `rules` |

返回结果中的主要字段：

- `status`：检查结论。
- `canCommit`：结论不是 `BLOCK` 时为 `true`。
- `deterministic`：每项确定性检查的状态。
- `ruleResults`：每条规则是否被违反（`violated`）、概率和理由。
- `findings`：每个问题的 `id`、对应规则（`rule`、`ruleSource`）和修复建议。
- `diffSummary`：改动统计。

### `verify`

| 参数 | 说明 |
|:---|:---|
| `cwd` | **必填**，仓库绝对路径 |
| `findingIds` | 之前 `check` 返回的 finding ID |
| `scope`、`target`、`task` | 同 `check` |

`verify` 会重新跑确定性检查，并重新判断当初产生这些 finding 的规则，不需要 agent 再传一遍。传入当前仓库不存在的 ID 时，会直接返回 `BLOCK` 和 `unknownFindings`，不执行任何命令，也不联网。

### 开 PR 前检查整个分支

`check` 传 `target: "main...HEAD"`（把 `main` 换成你的基准分支），就会检查这个分支相对基准分支的全部改动。单次提交看不出的问题，比如几次提交累积起来的范围蔓延、前后不一致，要在这一步发现。这种按提交范围的检查不会影响提交拦截的记录。

### 结论怎么看

| 结论 | 含义 |
|:---|:---|
| `PASS` | 没有发现问题。先确认 `diffSummary.filesChanged` 大于 0，否则说明检查范围是空的 |
| `WARN` | 有提示项，看一眼即可 |
| `REVIEW` | 需要人判断 |
| `BLOCK` | 不能提交，修复后用 `verify` 复验 |

工具调用出错（参数无效、缺少密钥、配置有误）时返回 `isError: true` 和错误原文。`BLOCK` 是正常的检查结论，不算错误。

## 提交拦截

只在仓库根目录有 `.gitguard.yml` 时生效；没有这个文件的仓库不受任何影响。

1. 每次 `check` 或 `verify`（范围是 `all`、`staged` 或 `working`）结束时，GitGuard 把这次检查覆盖的每个文件的内容指纹、当时的 HEAD 和检查结论，记到 `.git/gitguard/last-check.json`。指纹用的是 Git 的 blob ID，所以 Windows 下的换行符差异不会造成误判。
2. agent 通过 Bash 或 PowerShell 工具执行包含 `git commit` 的命令前，hook 会算出这次要提交的内容，并检查下面四项，任何一项不满足都会拦截（退出码 2），同时告诉 agent 该怎么做：
   - 有检查记录；
   - HEAD 没变；
   - 每个要提交的文件都和检查时的内容一致；
   - 结论不是 `BLOCK`。
3. `REVIEW` 和 `WARN` 不拦截，交给 agent 转告你。

几种写法的处理：
- `git commit -a`：未暂存的已跟踪改动也会提交，所以这些改动也要被检查过。
- 同一条命令里先 `git add` / `git rm` / `git mv` 再提交：因为 hook 在整条命令执行前运行，所以要求**所有**未提交的改动都被检查过。
- `cd 目录 && git commit`、`Set-Location 目录; git commit`、`git -C 目录 commit`：按实际仓库判断。
- 不在 Git 仓库里、或者 Git 出错时：hook 直接放行，不影响无关命令。

这个拦截只针对 agent 通过 shell 工具发起的提交，挡的是“忘了检查”，不是安全边界：你自己在终端里提交不受影响，agent 也能通过修改 hook 配置等方式绕过（skill 里已明确禁止）。

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

插件安装时不会执行 `npm install`，所以打包产物 `plugins/gitguard/server/gitguard-mcp.mjs`（MCP 服务）和 `gitguard-hook.mjs`（提交拦截）需要提交进仓库。改了 `src/` 后要运行 `pnpm bundle`，CI 会检查产物是否最新。

发布新版本时，要同步更新这几处的版本号：`package.json`、`src/version.ts`、`plugins/gitguard/.claude-plugin/plugin.json`、`plugins/gitguard/.codex-plugin/plugin.json`。

```text
src/                     MCP 服务源码（引擎、Git 读取、上下文、检查、策略、finding）
plugins/gitguard/        插件本体：两份清单、Codex 的 MCP 配置、两个 skill、hook、打包产物
.claude-plugin/          Claude Code 插件市场
.agents/plugins/         Codex 插件市场
```

## 许可

[Apache-2.0](LICENSE)
