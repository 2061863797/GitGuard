# GitGuard

[![CI](https://github.com/2061863797/GitGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/2061863797/GitGuard/actions/workflows/ci.yml)
[![Windows EXE](https://github.com/2061863797/GitGuard/actions/workflows/windows-exe.yml/badge.svg)](https://github.com/2061863797/GitGuard/actions/workflows/windows-exe.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

GitGuard 检查 Git 仓库中的代码改动，提供本地图形界面、命令行工具和 stdio MCP 服务。它汇总改动、扫描新增内容中的疑似密钥，按目标仓库配置运行测试、lint、类型检查和规则评估，最后给出 `PASS`、`WARN`、`REVIEW` 或 `BLOCK`。GitGuard 不会替你编写代码或创建提交。

**Windows x64 用户建议先用 [GitHub Releases](https://github.com/2061863797/GitGuard/releases/latest) 中的 `GitGuard.exe`。** 同一个 EXE 可以运行 CLI 和 MCP，不需要安装 Node.js 或 pnpm 来启动 GitGuard；电脑仍需安装 Git。要从源码运行或开发本项目，再准备 Node.js 20+ 和 pnpm 9+。

## 目录

- [Windows EXE：下载与第一次检查](#windows-exe下载与第一次检查)
- [源码运行](#源码运行)
- [图形界面](#图形界面)
- [CLI：命令、范围与结果](#cli命令范围与结果)
- [MCP Server Setup](#mcp-server-setup)
- [Configuration Reference](#configuration-reference-gitguardyml)
- [CI 与开发验证](#ci-与开发验证)
- [安全边界与许可](#安全边界与许可)

## Windows EXE：下载与第一次检查

1. 从 [最新 Release](https://github.com/2061863797/GitGuard/releases/latest) 下载 `GitGuard.exe`，放在固定位置，例如 `C:\Tools\GitGuard\GitGuard.exe`。也可以下载 `GitGuard-Windows-x64.zip`，其中包含 EXE、使用说明和校验文件。
2. 确认 Git 已安装，并能在 PowerShell 中运行 `git --version`。
3. 把下面的 EXE 路径和目标仓库路径换成你自己的：

```powershell
$gitguard = 'C:\Tools\GitGuard\GitGuard.exe'
& $gitguard --version
& $gitguard inspect --cwd 'C:\work\my-project'
```

`inspect` 只查看选中范围的改动，不运行测试。要检查提交前**已经暂存**的改动：

```powershell
& $gitguard check --offline --staged --task '修复登录超时' --cwd 'C:\work\my-project'
```

`--offline` 让语义判断使用本地模拟提供方，不需要 API 密钥；它**不会跳过**测试、lint 或类型检查。`check` 会在目标仓库执行其 `.gitguard.yml` 中配置的命令；如果目标项目需要 Node.js、pnpm、Python 等工具链，这些工具仍须在运行环境中可用。第一次检查其他项目之前，请先看[配置说明](#configuration-reference-gitguardyml)。

当前源码构建的 EXE 可运行 `& $gitguard ui --cwd 'C:\work\my-project'`，在本机浏览器打开图形界面；直接双击 EXE 不会自动打开。GitHub Release 中已有的 EXE 是否包含此命令，以该文件的 `--help` 输出为准。它目前未签名，Windows 可能显示安全提示；Release 提供的 `SHA256SUMS.txt` 可用于核对下载文件。更详细的操作步骤见 [Windows EXE 使用说明](docs/windows-exe.zh-CN.md)。

## 源码运行

源码方式适用于非 Windows x64 系统，以及希望开发或修改 GitGuard 的用户。准备 Node.js 20+、Git 2.30+、pnpm 9+，然后在 **GitGuard 源码目录**运行：

```powershell
git clone https://github.com/2061863797/GitGuard.git
cd GitGuard
pnpm install --frozen-lockfile
pnpm gitguard --help
pnpm gitguard inspect --cwd 'C:\work\my-project'
```

`pnpm gitguard` 通过 `tsx` 直接运行源码，不需要先构建。要运行 `node bin/gitguard.js` 或让 MCP 客户端启动源码版本，先执行 `pnpm build`。Linux 和 macOS 用户把示例中的 Windows 路径换成自己的项目路径。

本仓库的 npm 包名是 `gitguard-verify`，CLI 命令名仍是 `gitguard`。该 npm 包尚未发布；[npm 上的 `gitguard`](https://www.npmjs.com/package/gitguard) 是另一个项目。源码操作细节见 [中文版快速上手](docs/quickstart.zh-CN.md)。

## 图形界面

从 EXE 启动：

```powershell
& $gitguard ui --cwd 'C:\work\my-project'
```

从源码启动：`pnpm gitguard ui --cwd 'C:\work\my-project'`。`--cwd` 是初始仓库路径，也可在页面里输入其他 Git 仓库的**绝对路径**。界面只监听本机 `127.0.0.1`，会自动打开浏览器；无法自动打开时，复制终端显示的地址。关闭启动它的终端即可结束界面服务。

页面右上角可切换中文和英文。点「选择目录」可浏览文件夹，也可点「用系统文件管理器选择」打开 Windows 文件夹选择器；列表将 Git 仓库分为已配置和未配置两组。还可直接填写仓库的绝对路径。未配置仓库可点「创建配置」生成 `.gitguard.yml`，测试、代码规范和类型检查命令可选，留空即禁用对应检查；密钥扫描始终开启，已有配置不会被覆盖。

界面提供改动查看、完整检查、问题记录、复验以及 MCP 启动命令；结果可查看可视化、文本和原始 JSON。完整检查和复验仅使用官方 TypeSafe 在线语义判断，每次获取新结果，不使用本地模拟或语义缓存；启动前请按[在线密钥配置教程](docs/quickstart.zh-CN.md#在线检查配置-typesafe-api-key)设置 `TYPESAFE_API_KEY`。**完整检查和复验会执行目标仓库 `.gitguard.yml` 中配置的测试、lint 和类型检查命令**。快速查看只读取改动，不代表质量门禁通过。界面不会执行 Git add、commit、push 等写入命令。

## CLI：命令、范围与结果

以下示例延续上面的 PowerShell 变量 `$gitguard`。源码用户可以把 `& $gitguard` 换成 `pnpm gitguard`，并从 GitGuard 源码目录运行。

| 命令 | 用途 |
|:---|:---|
| `inspect` | 查看改动文件、diff 统计和初步发现；默认不运行项目检查命令。 |
| `check` | 对改动执行配置的测试、lint、类型检查、密钥扫描和规则评估。 |
| `findings` | 查看已记录的 finding。 |
| `verify` | 修改代码后重新验证指定 finding。 |
| `ui` | 在本机浏览器打开图形操作界面。 |
| `mcp` | 通过 stdio 启动 MCP 服务，供 MCP 客户端连接。 |

常用范围：

- 不指定范围时，`inspect` 和 CLI `check` 默认检查全部未提交改动。
- `--staged` 只检查已 `git add` 的改动；`--working` 只检查未暂存改动。
- `inspect --target HEAD` 查看指定提交；`inspect --target 'HEAD~1..HEAD'` 查看提交范围。
- `--cwd` 指向**要检查的 Git 仓库**，不是 EXE 所在目录。路径含空格时加引号。

```powershell
& $gitguard inspect --staged --cwd 'C:\work\my-project'
& $gitguard inspect --target HEAD --cwd 'C:\work\my-project'
& $gitguard check --offline --working --task '修复登录超时' --cwd 'C:\work\my-project'
& $gitguard findings --cwd 'C:\work\my-project'
& $gitguard verify --offline --findings '从 findings 输出复制的实际 ID' --cwd 'C:\work\my-project'
```

`check` 可加 `--json` 输出结构化结果；`--strict` 让 `WARN` 和 `REVIEW` 返回非零退出码。需要在线 TypeSafe/Jev 语义判断时，在运行环境中设置 `TYPESAFE_API_KEY`，去掉 `--offline`；`--require-semantic` 会在在线提供方不可用或回退时返回退出码 `2`。没有密钥时会使用本地模拟评估，不能把模拟结果当成在线模型结论。

| 结果 | 默认退出码 | 应如何理解 |
|:---|:---:|:---|
| `PASS` | 0 | 当前**选中范围**未发现阻断项。先确认范围内确实有预期改动。 |
| `WARN` | 0 | 有提示项，需要阅读具体 finding。 |
| `REVIEW` | 0 | 有需要人工复核的风险；`--strict` 会使其返回非零退出码。 |
| `BLOCK` | 1 | 有阻断项，修复后重新运行检查。 |

若输出显示 `Files: 0` 或 `No changed files`，`PASS` 只表示选中的范围为空，并不代表目标项目的测试已经运行。检查 `git status`、`--cwd` 和 `--staged`/`--working` 是否选对；配置或 Git 错误也可能返回非零退出码。

## MCP Server Setup

`GitGuard.exe mcp` 会启动 stdio MCP 服务。**MCP 也只需要同一个 EXE**；MCP 客户端负责启动它，无需另开一个终端长期运行，也无需为 EXE 安装 Node.js 或 pnpm。客户端与 EXE 必须运行在能访问该 Windows 路径的同一环境，Git 也必须对客户端进程可用。

### Codex 本地配置

在本机 Codex 的 `~/.codex/config.toml` 中加入以下内容（Windows 通常位于 `%USERPROFILE%\.codex\config.toml`），将两条路径替换为实际存在的绝对路径。`cwd` 是 MCP 进程的默认工作目录，适合固定检查一个仓库；检查其他仓库时，在工具调用中传入目标仓库的 `cwd`。Codex 的 stdio MCP 配置字段见 [OpenAI Docs 的 MCP 指南](https://developers.openai.com/codex/mcp)。

```toml
[mcp_servers.gitguard]
command = 'C:\Tools\GitGuard\GitGuard.exe'
args = ["mcp"]
cwd = 'C:\work\my-project'
env_vars = ["TYPESAFE_API_KEY"]
```

先按[在线密钥配置教程](docs/quickstart.zh-CN.md#在线检查配置-typesafe-api-key)设置 `TYPESAFE_API_KEY`；`env_vars` 只转发环境变量名，不包含密钥值。保存后重启客户端；Codex CLI 可运行 `codex mcp list` 确认服务器已配置。实际连接成功还应能看到下面列出的四个工具。

### 使用 `mcpServers` JSON 的客户端

有些客户端使用 JSON 格式；把示例放进该客户端自己的 MCP 配置文件。JSON 中的 Windows 反斜杠需要写成 `\\`：

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "C:\\Tools\\GitGuard\\GitGuard.exe",
      "args": ["mcp"]
    }
  }
}
```

不同客户端的配置字段和重启方式可能不同，按该客户端的说明放置配置。这个 JSON 示例**不是** Codex 的 `config.toml` 格式。

### 从源码启动 MCP

已经按[源码运行](#源码运行)安装依赖并执行 `pnpm build` 后，客户端也可以用 Node.js 启动 `bin/gitguard.js`：

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "node",
      "args": ["C:\\path\\to\\GitGuard\\bin\\gitguard.js", "mcp"]
    }
  }
}
```

### MCP 工具与使用

| 工具 | 主要参数 | 作用 |
|:---|:---|:---|
| `inspect_changes` | `scope`、`target`、`task`、`cwd` | 查看指定仓库的改动，默认范围 `all`。 |
| `check_task_completion` | 必填 `task`；可选 `scope`、`repoPath`、`cwd` | 评估改动与任务要求是否匹配，默认范围 `all`。 |
| `check_before_commit` | `task`、`scope`、`repoPath`、`cwd` | 运行质量门禁，默认范围 **`staged`**。 |
| `verify_findings` | 必填 `findingIds`；可选 `task`、`scope`、`cwd` | 修复后复查 finding，默认范围 `all`。 |

例如，让客户端调用 `inspect_changes` 并传入 `cwd = C:\work\my-project`，可以先确认目标仓库和改动范围；再调用 `check_before_commit`，传入任务描述与同一仓库路径。`check_before_commit` 会运行目标仓库配置的检查命令。MCP 的 `check_task_completion`、`check_before_commit` 和 `verify_findings` 每次都要求真实的 TypeSafe 在线语义结果，不使用本地模拟或语义缓存。请确保启动 MCP 的客户端进程能读取 `TYPESAFE_API_KEY`（某些客户端需要在服务环境变量中显式传递）；缺少密钥或在线服务失败时，工具返回错误，不给出模拟结论。`inspect_changes` 只做本地只读改动检查，不调用语义提供方。

`mcp` 是协议服务，不会像普通命令一样打印交互菜单；手动运行后等待输入是正常现象。`--debug` 的诊断写到 stderr，不占用 MCP 协议的 stdout。

## Configuration Reference (`.gitguard.yml`)

把 `.gitguard.yml` 放在**目标仓库根目录**。没有配置文件时使用 GitGuard 默认值；配置项会与默认值合并。首次运行其他项目的 `check` 前，先根据该项目技术栈确认命令：

| 默认检查 | 默认命令 | 说明 |
|:---|:---|:---|
| 测试 | `pnpm test` | 目标项目需有对应脚本。 |
| Lint | `pnpm lint` | 目标项目需有对应脚本。 |
| 类型检查 | `pnpm tsc --noEmit` | 适用于相应的 TypeScript 项目。 |
| 新增内容密钥扫描 | 启用 | 不依赖目标项目的包管理器。 |

例如，一个用 npm 测试、暂时没有 lint 与类型检查命令的项目，可以先在**该项目**的 `.gitguard.yml` 中写入：

```yaml
version: 1
deterministic:
  test:
    run: "npm test"
  lint:
    enabled: false
  typecheck:
    enabled: false
```

关闭检查会减少覆盖范围；有对应工具时，应把 `run` 调整为项目实际可运行的命令。配置的测试、lint、类型检查会在目标仓库执行，可能按该项目脚本写入文件。只对信任的仓库运行质量门禁。

其他配置按用途分为：

| 配置段 | 用途 |
|:---|:---|
| `context` | 限制 diff、周边代码、测试和仓库说明的上下文大小。 |
| `system_one` | 选择 TypeSafe 或本地模拟提供方、模型及超时。 |
| `deterministic` | 启停测试、lint、类型检查和密钥扫描，设置命令与超时。 |
| `rules`、`custom_rules` | 设置内置规则阈值和项目自定义规则。 |
| `privacy` | 设置敏感信息遮盖和排除路径。 |
| `gate` | 设置阻断等级和缓存。 |

完整字段与可复制的样例见[本仓库的 `.gitguard.yml`](.gitguard.yml)；逐步说明见[中文版快速上手](docs/quickstart.zh-CN.md)。不要在 `.gitguard.yml` 中写 API 密钥，应使用运行环境的 `TYPESAFE_API_KEY`。

## CI 与开发验证

本仓库的 [CI 工作流](.github/workflows/ci.yml)运行 lint、类型检查、构建、测试及安装包检查。[Windows EXE 工作流](.github/workflows/windows-exe.yml)在 Windows 上运行测试和独立 EXE 检查；手动触发会上传 Actions 产物，推送与 `package.json` 版本匹配的 `v*` 标签会创建 GitHub Release。使用者请从 [Releases](https://github.com/2061863797/GitGuard/releases/latest) 下载正式版。

从源码开发时，在 GitGuard 仓库运行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:pack
```

Windows x64 上如需自己构建 EXE，使用 Node.js 24+ 和 `pnpm run build:exe`；构建后运行 `pnpm run test:exe`。输出位于 `dist-exe/GitGuard.exe`。普通源码 CLI 不要求 Node.js 24。

## 安全边界与许可

GitGuard 的 Git 读取不会修改暂存区或创建提交；`check` 和相应 MCP 工具会执行目标仓库配置的检查命令，这些命令可能修改文件。在线语义评估涉及向配置的服务发送经过处理的仓库上下文；敏感项目应先检查 [SECURITY.md](SECURITY.md) 和 `.gitguard.yml` 中的隐私配置。

GitGuard 使用 [Apache-2.0 许可](LICENSE)。
