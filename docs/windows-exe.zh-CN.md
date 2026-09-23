# GitGuard Windows EXE 使用说明

这是 Windows x64 命令行版，不是图形界面。下载后无需安装 Node.js 或 pnpm 来启动 GitGuard；仍需安装 Git 2.30+。执行目标项目配置的测试、lint 或类型检查时，还需要该项目自身的工具链。

## 下载

- 正式版本：打开 [GitHub Releases](https://github.com/2061863797/GitGuard/releases)，下载 `GitGuard.exe`，或下载含说明文档的 `GitGuard-Windows-x64.zip`。
- 临时构建：在 [Windows EXE 工作流](https://github.com/2061863797/GitGuard/actions/workflows/windows-exe.yml)中打开成功的运行，从 Artifacts 下载 `GitGuard-Windows-x64`。Actions 构建产物可能过期；工作流尚未运行时不会有下载项。

正式版本另附 `SHA256SUMS.txt`。需要核对文件时，在 PowerShell 中运行 `Get-FileHash .\GitGuard.exe -Algorithm SHA256`，与其中的哈希比较。目前 EXE 没有代码签名，Windows 可能显示安全提示。

## 直接运行

在 EXE 所在目录打开 PowerShell，把示例路径换成要检查的 Git 仓库：

```powershell
.\GitGuard.exe --help
.\GitGuard.exe inspect --cwd "C:\work\my-project"
.\GitGuard.exe inspect --staged --cwd "C:\work\my-project"
```

`inspect` 只查看改动。要检查已暂存改动：

```powershell
.\GitGuard.exe check --offline --staged --task "修复登录超时" --cwd "C:\work\my-project"
```

`--offline` 只让语义判断使用本地提供方。目标仓库的测试、lint 和类型检查仍按其 `.gitguard.yml` 配置执行；默认命令是 `pnpm test`、`pnpm lint` 和 `pnpm tsc --noEmit`。请先确认这些命令适用于你的项目，其他技术栈的配置示例见[快速上手](https://github.com/2061863797/GitGuard/blob/main/docs/quickstart.zh-CN.md#3-运行质量门禁)。如果选中范围没有改动，`PASS` 不代表测试已经运行。

这个 EXE 也支持 `findings`、`verify` 和 `mcp` 子命令，可用 `.\GitGuard.exe <子命令> --help` 查看参数。双击 EXE 不会打开图形界面，请在终端中运行。
