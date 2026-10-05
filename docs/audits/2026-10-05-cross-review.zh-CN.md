# GitGuard 交叉审核与修复记录（2026-10-05）

## 范围与验收

审核当前 GitGuard 0.2.5 源码的仓库隔离、复验记录、隐私过滤、Git 读取边界、MCP 参数和返回契约，以及安装包中的入口和说明文件。版本号保持 0.2.5，本次不执行提交、推送、发布或正式目录安装，不重新生成或替换已有 EXE。

验收依据为问题复现、受影响的回归测试、严格 lint、类型检查、构建，以及在隔离临时目录中安装 tarball 后的 CLI / ESM / stdio MCP 验证。真实 TypeSafe 服务、已有 EXE、远端 CI 和桌面客户端的人工操作不在已验证结果中。

## 交叉审核过程

Antigravity 首轮只读审核已成功完成，任务 `task_1791170635279_ce47d63f`，会话 `1475bd0f-4d48-476c-b827-73effef919d0`。父代理复核其发现，并独立构造了跨仓库、分支范围、外部 Git helper、隐私字段和只读 finding 存储的复现。

后续受限代码委派任务 `task_1791171406341_00143332` 因持续无进展而取消，不能算作成功交付。边界审计涉及运行中的 CodeGraph 缓存文件；停止本次启动的仓库索引守护进程后，第二次恢复确认 `CANCELLED`、`recovery: VERIFIED`、`rollback.verified: true`。最终源码由父代理重新落实并验证，未混入取消任务中的未验证变更。

最终摘录复核任务 `task_1791192574025_7a6fac27`、会话 `3b442c82-4c42-4ffb-b707-b9098905b7f1` 已返回 `SUCCESS`，使用 `gemini-3.8-flash-high` / high，约 143 秒。该轮仅分析提供的源码与 diff，不运行命令；机器文件审计完成、实际改动为空，验证状态为 `NOT_RUN`。返回数据同时有 `consistencyCheck.valid: false` 的“报告修改而未发现改动”提示；审查文本包含修正建议，未声称已写入源码，因此将这一轮作为审核意见，不能作为实现或运行验证证据。

## 已确认并修复的问题

| 优先级 | 问题与影响 | 最终处理与证据 |
| --- | --- | --- |
| P1 | 同一引擎先检查仓库 A，再复验仓库 B 时，内存 finding 可被当作 B 的记录，错误判定已解决。 | finding 保存仓库根路径，内存回退按当前根路径过滤；未知 ID 提前阻断。覆盖顺序、并发、批量复验和同仓库回退。[引擎](../../src/core/engine.ts)、[回归](../../tests/unit/core/repository-isolation.test.ts) |
| P1 | 只脱敏原任务与 raw diff，派生 keywords 和结构化 hunk 仍可能保留同一密钥；无引号等号赋值和 JSON 键名存在漏匹配。 | 同时过滤派生关键词、hunk header / lines，并扩展已知字段赋值格式；验证实际送入 provider 的序列化内容。[隐私过滤](../../src/context/filter.ts)、[回归](../../tests/unit/context/privacy-contract.test.ts) |
| P1 | Git 读取入口可受继承的外部 diff 设置影响，读取操作可能启动外部程序。 | diff / show / log 强制禁用 ext-diff 和 textconv；拒绝 cat-file 的外部 filter 参数及无效子命令。用实际外部 helper 标记文件验证。[适配器](../../src/git/adapter.ts)、[回归](../../tests/unit/git/adapter.test.ts) |
| P1 | finding 文件不能写入时，内存回退可被误报为持久化成功；锁权限失败可绕过锁继续写入。 | 临时文件加原子 rename，失败抛出明确错误并清理临时文件；锁 EACCES / EROFS / EPERM 统一报错并立即失败。复验保存失败返回 BLOCK、allResolved=false、persistenceOk=false。[存储](../../src/findings/store.ts)、[回归](../../tests/unit/findings/store.test.ts) |
| P2 | base...head 被拆成端点比较，分叉分支可能包含另一侧的改动；inspect 的 target 未推断 scope。 | 完整保留双点 / 三点范围，target 推断 commit / range，verify 同样传递 target；验证分叉分支的实际 diff。[引擎回归](../../tests/unit/core/repository-isolation.test.ts) |
| P2 | Git 引号、八进制 UTF-8 和原始中文路径解析不一致，影响路径识别和敏感文件 hunk 排除。 | 共用路径解析器，正确处理转义引号、连续八进制字节、原始 Unicode 和混合引号路径。[解析器](../../src/git/diff-parser.ts)、[隐私回归](../../tests/unit/context/privacy-contract.test.ts) |
| P2 | MCP 声明与运行时参数检查不一致，别名冲突、错误类型和额外参数可进入引擎；返回结果和副作用提示不充分。 | 共用严格 schema，统一 cwd / repoPath、target 和 finding ID 校验；增加 structuredContent、稳定错误码、在线响应检查与真实副作用注解。[工具实现](../../src/interfaces/mcp/tools.ts)、[契约回归](../../tests/unit/mcp/contracts.test.ts) |
| P2 | 混合已知与未知 finding ID 的提前阻断结果丢失仍待复验的已知 ID；损坏的存储被读失败后继续运行。 | 保留已知 active finding 与 remaining ID；存储损坏在运行检查或调用 provider 前明确失败。[复验回归](../../tests/unit/core/repository-isolation.test.ts) |
| P3 | HTTP User-Agent 版本落后，重复 barrel 导入扩大依赖环，现有 lint 留有 99 个警告。 | CLI、MCP 和 provider 共用叶子版本模块；清理未使用导入和参数；lint 开启 deny-warnings。[版本](../../src/version.ts)、[lint 配置](../../package.json) |
| P3 | 安装包缺少 README 引用的 SECURITY.md；文档未准确区分工具用途、超时和存储失败；EXE 验证临时目录保护位置不准确。 | 补全包文件与 MCP 指南，调整临时目录保护，增加安装后 MCP 冒烟验证。[包验证](../../scripts/test-pack.mjs)、[EXE 验证脚本](../../scripts/test-windows-exe.mjs) |

## 规则与说明的取舍

- SDK 直接传入的配置和环境变量属于调用方的可信控制，不将其与目标仓库的不可信配置混为一谈；保留现有可信 SDK 隐私选项，并在 SECURITY.md 明确边界。
- 基线已存在对 Git 全局参数、symbolic-ref 写入、output 参数和仓库配置隐私降级的限制；这些历史问题没有重复记为本次新增修复。
- 保留四个 MCP 工具名称和旧 finding ID 字符串 / findings 别名的运行时兼容性，新文档统一推荐 findingIds 数组。别名冲突会失败。
- BLOCK 是有效检查结论；参数或执行错误使用 isError。targetsResolved 只说明目标的本次修复判断，记录保存失败仍阻断 allResolved。
- 正则脱敏只覆盖已知格式，不作全部秘密均已识别的保证。检查脚本来自目标仓库，可能写入文件；Git 读取限制不等于操作系统沙箱。

## 最终复核意见的独立核对

反重力提出两项 P1 和三项 P2 候选问题，父代理没有直接按标签接受，而是结合完整调用路径、既有约定和实际测试判断。

| 复核意见 | 核对结果 |
| --- | --- |
| 空语义决策应允许通过；metadata.fallback 可能空引用。 | 不采用。MCP 已知 ID 的复验明确要求新的在线 TypeSafe 响应，engine.check 的 requireOnline 分支也拒绝空结果；即使零 diff，也不会走非在线快捷分支。metadata 缺失时，前一项 effectiveProvider 比较已让 OR 短路，不会访问 fallback。放行空结果反而破坏在线约束。[调用路径](../../src/core/engine.ts)、[MCP 契约测试](../../tests/unit/mcp/contracts.test.ts) |
| 损坏的 finding 存储应继续使用内存回退。 | 不采用。损坏与空记录不同；继续复验会在读取失败后给出误导结果或尝试更新损坏数据。当前约定是提前失败并保留文件，已有明确回归。[存储损坏与隔离测试](../../tests/unit/core/repository-isolation.test.ts) |
| 脱敏会丢失不在任务正文中的高阶分类关键词。 | 当前路径未复现。实际 builder 提取正文词项或中文片段，并未生成报告假设的分类器关键词。建议中的逐词正则过滤还会重新暴露被转为小写的 AWS 标识，因此保留当前过滤。[词项提取](../../src/context/builder.ts)、[隐私回归](../../tests/unit/context/privacy-contract.test.ts) |
| 记录写入失败时必须将 targetsResolved 置为 false。 | 不采用。targetsResolved 表示本次评估中的修复事实，allResolved 还要求无阻断；保存失败已经返回 BLOCK / allResolved=false / persistenceOk=false。两种状态在指南中已分别说明，保持这一语义。[MCP 结果说明](../mcp.zh-CN.md) |
| Windows EPERM 锁失败应封装为统一错误码。 | 采用。此前 EPERM 也会抛出错误，不存在绕锁成功，但错误码不一致；现统一为 FINDING_STORE_LOCK_ERROR，并增加 EPERM 测试病例。此处属于错误处理一致性改进。[锁错误测试](../../tests/unit/findings/store.test.ts) |

此外，父代理以安全的末尾 no-ext-diff / no-textconv 参数探测了 `--ext-di` 缩写，本机 Git 将其判为 invalid option；没有将这一未成立的外部 helper 绕过假设计入问题。

## 最终验证

| 验证 | 结果与覆盖 |
| --- | --- |
| pnpm test --reporter=dot | 58 个测试文件、793 个测试全部通过；包含构建、MCP 协议、CLI、跨仓库隔离、Windows 只读存储和新增 EPERM 锁错误回归。在线密钥置空，provider 使用可控替身。 |
| pnpm lint | 通过；oxlint --deny-warnings，零警告。 |
| pnpm typecheck | 通过；tsc --noEmit。 |
| pnpm test:pack | 通过；重新构建并生成 tarball，在隔离临时目录安装后验证版本 0.2.5、ESM 主导出与 types 子导出、说明文件，以及 stdio MCP 的四工具发现和 inspect_changes 调用。结构化内容与 JSON 文本一致。临时目录已由脚本清理。 |
| 文档检查 | README、SECURITY 和三份中文指南的 6 个 JSON 示例可解析，18 个本地文件链接目标存在；不含在线链接可用性或 Markdown 锚点的自动验证。 |
| git diff --check | 通过；Windows 的 LF / CRLF 提示属于现有 Git 换行转换设置，不是空白错误。 |

最终回归前发现的 CLI 提示兼容问题和混合 ID 返回问题均已修复，以上只记录修复后的最终结果。沙箱的临时 Git 写权限和 node_modules realpath EPERM 通过正常权限审批运行隔离测试 / 静态检查解决，没有更改工作仓库 Git 状态。曾有一次审批服务额度错误使测试未启动，用户继续后正常审批重试成功。

## 说明文件入口

- [MCP 调用指南](../mcp.zh-CN.md)：工具顺序、参数约束、可复制示例、结果与错误、超时和排查。
- [快速上手](../quickstart.zh-CN.md)：CLI、范围比较和复验路径。
- [Windows EXE 指南](../windows-exe.zh-CN.md)：路径、密钥继承和现有二进制版本边界。
- [SECURITY.md](../../SECURITY.md)：隐私与信任边界、Git helper 和持久化失败语义。
- [README](../../README.md)：入口、MCP 配置与开发验证命令。

## 待单独验收

未调用真实 TypeSafe 模型服务，未验证真实密钥配置、网络时延或费用；未重建、替换或执行已有 EXE 的人工验收；未推送代码或验证远端 CI。当前结果证明已测试源码与临时安装的 Node 分发包，不能直接外推到既有二进制或所有客户端。
