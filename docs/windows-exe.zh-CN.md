# GitGuard Windows EXE 使用说明

当前源码构建的 Windows x64 单文件版同时提供命令行和本地浏览器图形界面。已发布的 EXE 是否包含 `ui` 命令，请以该文件的 `--help` 输出为准。下载后无需安装 Node.js 或 pnpm 来启动 GitGuard；仍需安装 Git 2.30+。执行目标项目配置的测试、lint 或类型检查时，还需要该项目自身的工具链。

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

## 图形界面

先按[在线密钥配置教程](quickstart.zh-CN.md#在线检查配置-typesafe-api-key)在 PowerShell 中设置 `TYPESAFE_API_KEY`，再在同一窗口运行：

```powershell
.\GitGuard.exe ui --cwd "C:\work\my-project"
```

GitGuard 会打开本机浏览器。页面可切换中文和英文，通过「选择目录」浏览已配置或未配置的 Git 仓库；Windows 下还可点「用系统文件管理器选择」打开文件夹选择器，也可直接输入仓库绝对路径。未配置的仓库可创建 `.gitguard.yml`；检查命令留空时不会启用对应检查，密钥扫描仍启用。页面提供改动查看、完整检查、问题记录、复验和 MCP 启动命令。完整检查、复验和 MCP 语义工具只使用在线 TypeSafe。完整检查与复验仍会执行目标仓库配置的检查命令。浏览器界面只监听 `127.0.0.1`，关闭启动它的终端即可结束服务。

这个 EXE 也支持 `findings`、`verify` 和 `mcp` 子命令，可用 `.\GitGuard.exe <子命令> --help` 查看参数。直接双击 EXE 不会打开界面，请在终端中使用 `ui` 子命令。
