---
name: gitguard-setup
description: 为当前仓库创建或修改 GitGuard 配置文件 .gitguard.yml：找出项目实际使用的测试、lint、类型检查命令，和用户一起确定项目规则，经用户确认后写入。用户说“配置 GitGuard”“给这个项目加 GitGuard”“修改 GitGuard 规则/命令”时使用。
---

# 配置 GitGuard

`.gitguard.yml` 放在仓库根目录，只有三部分，都是可选的：

```yaml
version: 1

deterministic:              # 每次检查都会在本机执行的项目命令
  test: "npm test"          # 简写：直接写命令
  lint: "npm run lint"
  typecheck:                # 完整写法：需要调整超时时用
    run: "npx tsc --noEmit"
    timeout_ms: 120000      # 默认 60000

rules:                      # 每次检查都会判断改动是否违反
  - id: no_float_money      # 小写字母、数字、下划线
    rule: "金额必须用整数（分）计算，不能用浮点数"
    level: block            # warn | review | block
    files: ["src/billing/**"]   # 可选
    exclude: ["**/*.test.ts"]   # 可选

secret_scan:                # 可选：在内置规则之外再扫描的密钥正则
  patterns: ["ACME_[A-Z0-9]{32}"]
```

只接受这几个字段，写了其他字段（包括拼错的字段）会报错。

**注意**：这个文件一旦存在，仓库就开启了**提交拦截**。agent 提交前必须先通过 GitGuard 检查，没检查过或者结论是 BLOCK 都会被拦下。

## 步骤

### 1. 先看现状

- 仓库根目录已经有 `.gitguard.yml` 的话，先读出来，在它的基础上修改，不要整个覆盖。
- 确认当前目录是 Git 仓库的根目录（`git rev-parse --show-toplevel`）。

### 2. 找出项目命令

从项目文件里找实际在用的命令，**不要凭技术栈猜测**：

| 去哪里找 | 看什么 |
|:---|:---|
| `package.json` 的 `scripts` | `test`、`lint`、`typecheck`、`check` 等脚本。用哪个包管理器，看锁文件：`pnpm-lock.yaml`、`yarn.lock`、`package-lock.json`、`bun.lockb` |
| `pyproject.toml`、`setup.cfg`、`tox.ini` | pytest、ruff、flake8、mypy、pyright 的配置 |
| `Makefile`、`justfile`、`Taskfile.yml` | `test`、`lint`、`check` 等目标 |
| `Cargo.toml`、`go.mod`、`pom.xml`、`build.gradle` | `cargo test` / `cargo clippy`、`go test ./...` / `go vet ./...`、`mvn test`、`gradle test` |
| `.github/workflows/`、其他 CI 配置 | CI 里真正执行的命令，最可靠 |

命令有以下限制：
- 只能是一行；
- 不能用 `&&`、`|`、`;`、重定向等 shell 连接符。GitGuard 会拒绝执行这类命令，需要组合多个步骤时，改用项目里现成的脚本。

找不到某一项的命令，就不写这一项，不要编造。

**超时**：如果测试跑得比较久，就设置 `timeout_ms`，可以参考 CI 里的耗时。检查是同步执行的，测试、lint、类型检查的总耗时最好控制在 10 分钟以内。

### 3. 和用户一起确定规则

规则写的是这个项目长期都要遵守的要求。agent 每次检查时临时写的规则不放在这里。

- 先从 AGENTS.md、CLAUDE.md、CONTRIBUTING.md、README 里找项目已经写明的约定，改写成规则。
- 再问用户：“这个项目有哪些绝对不能违反的要求？”
- 每条规则要具体到能从改动里判断“违反/没违反”：

  | 好的规则 | 差的规则 |
  |:---|:---|
  | 函数不得超过 50 行 | 代码要写得简洁 |
  | 新增的 HTTP 接口必须校验登录态 | 注意安全 |
  | 修改 `src/api/` 下的公开函数签名时，必须同时更新 `docs/api.md` | 保持文档同步 |

- 只和部分代码有关的规则，加上 `files` 限定范围。
- `level` 的含义：
  - `block`：违反就不能提交；
  - `review`：要用户判断；
  - `warn`：提示一下即可。

  不确定时用 `review`。
- 规则一般 3~8 条就够了。宁可少而准，不要多而泛。

### 4. 给用户确认，再写入

把完整的文件内容展示给用户，并说明三点：
- `deterministic` 里的命令会在每次检查时在本机执行；
- 有 `rules` 时需要设置环境变量 `TYPESAFE_API_KEY`；
- 文件写入后，这个仓库就开启了提交拦截。

用户确认后再写入 `.gitguard.yml`。

### 5. 验证

- 调用 GitGuard 的 `check` 工具（`cwd` 为仓库根目录），确认配置能被正确读取。
- 如果某个命令失败，判断是命令写错了，还是项目本身有问题：命令写错就改命令；项目本身的问题如实告诉用户。
- 提醒用户把 `.gitguard.yml` 提交进仓库，团队里的其他人和 agent 才会用同一套配置。
