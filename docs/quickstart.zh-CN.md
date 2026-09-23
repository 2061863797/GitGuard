# GitGuard 快速上手

这份说明适用于本仓库的源码版本。第一次使用只需准备 Node.js 20+、Git 2.30+ 和 pnpm 9+。所有命令都在 **GitGuard 源码目录**执行；`--cwd` 指向要检查的 Git 仓库。

> [npm 上同名的 `gitguard` 包](https://www.npmjs.com/package/gitguard)目前是另一个提交信息检查工具。不要用 `pnpm add -D gitguard` 或 `pnpm add -g gitguard` 来获取本仓库版本。

## 1. 启动并确认 CLI 可用

如果还没有本仓库源码，先获取源码：

```powershell
git clone https://github.com/2061863797/GitGuard.git
cd GitGuard
```

已经在 GitGuard 源码目录时，直接运行：

```powershell
pnpm install --frozen-lockfile
pnpm gitguard --help
pnpm gitguard inspect --cwd .
```

最后一条会检查 GitGuard 仓库自身。若显示 `No changed files` 或 `Files: 0`，表示当前范围没有待检查的改动，并不表示历史提交已经全部审核。

`pnpm gitguard` 通过仓库中的 `tsx` 脚本运行源码，不需要先构建。若要运行 `node bin/gitguard.js` 或把它接入 MCP 客户端，请先执行 `pnpm build`。

## 2. 检查另一个 Git 仓库

把下面的路径换成自己的项目路径；路径有空格时保留引号。`--cwd` 可以使用绝对路径，也可以使用相对于 GitGuard 源码目录的路径。

```powershell
pnpm gitguard inspect --cwd "C:\work\my-project"
pnpm gitguard inspect --staged --cwd "C:\work\my-project"
```

`inspect` 只汇总变更，默认不会执行测试、lint 或类型检查。`--staged` 只看已 `git add` 的改动；`--working` 看未暂存的改动；不带范围参数时检查所有未提交改动。要检查某个提交或范围：

```powershell
pnpm gitguard inspect --target HEAD --cwd "C:\work\my-project"
pnpm gitguard inspect --target "HEAD~1..HEAD" --cwd "C:\work\my-project"
```

## 3. 运行质量门禁

先在你信任的项目中运行以下命令：

```powershell
pnpm gitguard check --offline --staged --task "修复登录超时" --cwd "C:\work\my-project"
```

`--offline` 只让语义判断使用本地模拟提供方，不需要 API 密钥；选中范围有改动时，测试、lint 和类型检查仍会按目标仓库的配置运行；范围为空时会跳过这些检查。`check` 默认检查所有未提交改动，`--staged` 适合提交前检查。仓库里没有选中范围的改动时，结果可能是 `PASS` 且 `Files: 0`，此时请确认 `--cwd` 和范围。

首次给其他项目运行 `check` 前，请确认其 `.gitguard.yml` 中的检查命令可信。没有配置时，默认命令是 `pnpm test`、`pnpm lint` 和 `pnpm tsc --noEmit`。这些命令是为 pnpm/TypeScript 项目准备的；其他项目应按实际工具调整。例如，一个只使用 npm 测试、暂时没有 lint 与类型检查脚本的项目，可在**目标仓库根目录**创建：

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

关闭检查会减少覆盖范围；有相应工具时，优先把 `run` 改成项目真实可运行的命令。`.gitguard.yml` 中配置的命令会在目标仓库执行，所以只对信任的仓库运行 `check`。

需要真实的 TypeSafe/Jev 语义判断时，先在运行环境中配置 `TYPESAFE_API_KEY`，然后去掉 `--offline`；加上 `--require-semantic` 可要求服务不可用时明确报错，而不是自动回退。

## 4. 看结果并复查修复

| 结果 | 默认退出码 | 如何处理 |
|:---|:---:|:---|
| `PASS` | 0 | 当前选中范围没有阻断项；先确认检查范围确实包含预期改动。 |
| `WARN` | 0 | 查看提示后自行判断。 |
| `REVIEW` | 0 | 建议人工复核；`--strict` 会将其视为非零退出。 |
| `BLOCK` | 1 | 按 finding 的位置和建议修复后重新检查。 |

```powershell
pnpm gitguard findings --cwd "C:\work\my-project"
pnpm gitguard verify --offline --findings "GG-001" --cwd "C:\work\my-project"
```

第二条中的 `GG-001` 仅为示例，请替换为上一条实际输出的 finding ID。`verify` 会重新判断已有 finding 是否已解决；也可以重新运行 `check` 检查当前改动。CLI 发生配置或 Git 错误时也会返回非零退出码。

## 常见问题

- **提示不是 Git 仓库**：检查 `--cwd` 是否指向含有 `.git` 的项目目录。
- **检查结果显示 0 个文件**：检查 `git status`，以及是否误选了 `--staged` 或 `--working`。已提交的内容可用 `--target HEAD` 检查。
- **提示找不到 pnpm、lint 或 tsc**：在目标仓库配置实际可运行的 `deterministic.test/lint/typecheck.run`，或仅关闭不适用的检查。
- **没有 API 密钥**：先用 `check --offline`；这不会跳过本地确定性检查。
- **想在 MCP 客户端使用**：先 `pnpm build`，再让客户端用 Node.js 启动本仓库的绝对路径 `bin/gitguard.js mcp`。具体配置见 [README 的 MCP 部分](../README.md#mcp-server-setup)。

完整配置项见 [README 配置参考](../README.md#configuration-reference-gitguardyml)。
