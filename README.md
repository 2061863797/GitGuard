# GitGuard

[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-684%20passed-success.svg)](https://vitest.dev/)
[![Semantic Engine](https://img.shields.io/badge/Semantic%20Engine-TypeSafe%20%2F%20Jev-FF6B6B.svg)](https://typesafe.ai/)
[![Protocol](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Repository-aware change verification and quality gate powered by TypeSafe / Jev System One semantic intelligence & deterministic checks.**

GitGuard verifies code changes **before** they are committed, merged, or accepted into a software repository. Combining deterministic toolchains with **TypeSafe / Jev System One** semantic decision models, repository context extraction, and a configurable policy engine, GitGuard acts as an autonomous, high-precision verification infrastructure for both human developers and AI coding agents.

### 🌟 Powered by TypeSafe / Jev (System One AI)

At the core of GitGuard's semantic gate is **[TypeSafe](https://typesafe.ai/) and its System One foundation model, Jev**. 

Unlike conversational LLMs that produce verbose, unstructured code review opinions prone to hallucinations, **TypeSafe / Jev** turns complex code diffs, task intents, and repository contexts into **typed, calibrated judgments and mathematical probabilities**:

- 🎯 **Task Fulfillment (`task_completed`)**: Calibrates whether the diff genuinely accomplishes the declared goal or merely wrote superficial, hallucinated code.
- 🛡️ **Scope Creep & Boundary Drift (`unrelated_changes`)**: Mathematically detects modifications that deviate from the user's intent or touch files outside the task scope.
- 🧪 **Test Adequacy Guarantee (`tests_required`)**: Programmatically assesses whether new logic or edge paths demand corresponding unit or integration tests.
- 🔒 **Security Sensitivity Assessment (`security_sensitive`)**: Evaluates whether auth flows, cryptographic primitives, or credential paths have been altered.
- ⚠️ **Regression Risk Forecasting (`regression_risk`)**: Quantifies blast radius and categorizes regression likelihood into discrete risk levels (`low`, `medium`, `high`, `critical`).
- ⚡ **Zero-Dependency Offline Fallback**: Features an embedded deterministic heuristic mock provider, ensuring continuous local & CI enforcement without external API keys.

---

## Table of Contents

- [Why GitGuard?](#why-gitguard)
- [Architecture & Overview](#architecture--overview)
- [Core Concepts](#core-concepts)
- [Prerequisites & Installation](#prerequisites--installation)
- [Developer Quickstart (CLI)](#developer-quickstart-cli)
- [Coding Agent Autonomous Workflow](#coding-agent-autonomous-workflow)
- [MCP Server Setup](#mcp-server-setup)
- [CI/CD Integration (GitHub Actions)](#cicd-integration-github-actions)
- [Configuration Reference (`.gitguard.yml`)](#configuration-reference-gitguardyml)
- [Security & Privacy Model](#security--privacy-model)
- [Development & Verification](#development--verification)
- [License](#license)

---

## Why GitGuard?

Traditional linters, typecheckers, and test runners answer only basic deterministic questions:
- *Does the code compile without syntax errors?*
- *Do existing regression tests pass?*

However, in modern workflows driven by autonomous coding agents (Claude Code, Cursor Composer, Windsurf, Aider, Antigravity), code changes often introduce subtle, high-impact defects that pass static analysis:
- **Did the agent actually fulfill the requested task**, or did it write superficial code?
- **Did the agent introduce unintended scope creep**, refactoring unrelated files or modifying configurations outside its charter?
- **Are critical behavioral changes missing automated tests?**
- **Were security-sensitive boundaries silently altered?**
- **Were API keys or private credentials accidentally committed into diff hunks?**

GitGuard bridges this gap. It does not write or generate code. Instead, it provides a read-only, deterministic, and semantic **verification loop**:

$$\text{Agent / Developer} \longrightarrow \text{Modify Code} \longrightarrow \text{GitGuard Inspect \& Check} \longrightarrow \text{Structured Findings} \longrightarrow \text{Remediate} \longrightarrow \text{GitGuard Verify} \longrightarrow \text{PASS}$$

---

## Architecture & Overview

GitGuard decouples interface adapters from the central verification engine. All clients—whether human developers running CLI commands, AI agents connected via the Model Context Protocol (MCP), Git pre-commit hooks, or CI pipelines—execute the exact same verification pipeline.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL CLIENTS                              │
├──────────────────┬─────────────────────────┬───────────────────────────┤
│ Human Developer  │  Autonomous AI Agent    │  Continuous Integration   │
│  (Terminal / CLI)│   (Claude / Cursor MCP) │   (GitHub Actions / CI)   │
└─────────┬────────┴────────────┬────────────┴─────────────┬─────────────┘
          │                     │                          │
          ▼                     ▼                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          INTERFACE LAYER                               │
├──────────────────┬─────────────────────────┬───────────────────────────┤
│ gitguard CLI     │  GitGuard MCP Server    │  CI Exit Code & Reporter  │
│ (inspect/check)  │  (stdio JSON-RPC tools) │  (0 = PASS/WARN, 1 = BLOCK)
└─────────┬────────┴────────────┬────────────┴─────────────┬─────────────┘
          │                     │                          │
          └─────────────────────┼──────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        GITGUARD CORE ENGINE                            │
├────────────────────────────────────────────────────────────────────────┤
│ • Git Read Adapter: Safe, read-only extraction of working/staged state │
│ • Context Builder: Diff parsing, Hunk-adjacent source context, test discovery │
│ • Policy Engine: Rule evaluation, threshold matching, gate synthesis   │
│ • Finding Manager: SHA-256 fingerprinting, evidence requirements       │
│ • Gate Verifier: Closed-loop resolution confirmation                   │
└──────────────────┬─────────────────────────┬───────────────────────────┘
                   │                         │
                   ▼                         ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│       DETERMINISTIC LAYER        │  │     SEMANTIC DECISION LAYER      │
├──────────────────────────────────┤  ├──────────────────────────────────┤
│ • Safe Subprocess Runner (No Sh) │  │ • TypeSafe / Jev System One      │
│ • pnpm test / vitest runner      │  │ • Calibrated Probability Output  │
│ • pnpm lint / ESLint / tsc       │  │ • 5 Standard Quality Questions   │
│ • Real-time Diff Secret Scanner  │  │ • Custom Repository Rules        │
│ • Exit Code Verification         │  │ • Offline / Mock Graceful Fallback│
└──────────────────────────────────┘  └──────────────────────────────────┘
```

---

## Core Concepts

### 1. Changeset
A normalized representation of git modifications. GitGuard inspects multiple scopes without mutating the repository:
- `staged`: Only changes staged in the git index (`git add`).
- `working`: Only unstaged modifications in the working tree.
- `all` (default): Combined staged and unstaged working modifications.
- `commit`: Changes introduced by a specific commit ref (e.g. `HEAD`).
- `range`: Diff between two commit references or branches (e.g. `main..feature`).

### 2. EvaluationContext
The structured payload compiled by the Context Builder containing:
- Unified diff hunks with per-file additions and deletions.
- **Surrounding source lines** (default 40 lines) providing context around changed blocks.
- **Discovered related tests** co-located in the repository.
- **Repository instructions** detected in root/monorepo documentation (e.g., `AGENTS.md`, `CONTRIBUTING.md`).
- Declared **task intent statement**.

### 3. Deterministic Layer
Executes concrete, verifiable tools directly in the workspace:
- Command sandbox preventing shell metacharacter injection.
- Zero-tolerance diff secret scanner detecting AWS keys, GitHub tokens, OpenAI secrets, private keys, and JWTs.
- Automatic credential redaction (`***[REDACTED]***`) in logs, findings, and context.

### 4. Semantic Decision Layer
Unlike generative LLMs that write unstructured code reviews, GitGuard utilizes **System One decisions** (via TypeSafe / Jev):
- Discrete, programmatic questions evaluated into calibrated probabilities $[0.0, 1.0]$ or categorical risk levels (`low`, `medium`, `high`, `critical`).
- Zero hallucination: decisions map directly to numerical thresholds configured in `.gitguard.yml`.
- Robust offline fallback (`--offline` or mock provider) guarantees deterministic execution when external model credentials are unavailable.

### 5. Policy Engine & Gate Verdicts
The Policy Engine evaluates deterministic violations and semantic signals against `.gitguard.yml` rules. Verdicts adhere to the worst-case hierarchy:

$$\text{BLOCK} > \text{REVIEW} > \text{WARN} > \text{PASS}$$

| Verdict | Meaning | Default Exit Code | Agent Action |
|:---|:---|:---:|:---|
| **`PASS`** | Clean changeset. All tests, rules, and semantic checks satisfied. | `0` | Proceed to commit / merge. |
| **`WARN`** | Minor advisory signals detected (e.g., small diff drift). | `0` | Review advisory, commit permitted. |
| **`REVIEW`** | Meaningful risk detected (e.g., missing tests, auth changes). | `0` (or `1` with `--strict`) | Agent or human review recommended. |
| **`BLOCK`** | Hard failure (failing test, compilation error, hardcoded secret). | `1` | **Blocked.** Commit/merge rejected until fixed. |

### 6. Structured Finding System
Every rule violation produces a structured `Finding`:
- **Finding ID**: Human-readable identifier (e.g., `F-DETERMINISTIC-SECRET-4A7B`).
- **Fingerprint**: Stable SHA-256 hash derived from rule ID and normalized affected file paths. Survives line edits.
- **Severity**: `INFO`, `WARN`, `ERROR`, `CRITICAL`.
- **Expected Evidence**: Explicit remediation instructions enabling autonomous agents to know *exactly* what action is required to resolve the finding.
- **Lifecycle**: Transitions from `ACTIVE` $\rightarrow$ `RESOLVED` (confirmed by `verify`) or `SUPPRESSED`.

---

## Prerequisites & Installation

### Prerequisites
- **Node.js**: `v20.0.0` or higher
- **Git**: `2.30.0` or higher
- **pnpm**: `9.0.0` or higher (recommended) or `npm` / `yarn`

### Installation

#### As a Project Dependency (Recommended)
Add GitGuard to your project development dependencies:

```bash
pnpm add -D gitguard
# or
npm install --save-dev gitguard
```

#### Global Installation
Install globally to use `gitguard` across any repository on your workstation:

```bash
pnpm add -g gitguard
```

#### Clone and Build from Source
```bash
git clone https://github.com/example/gitguard.git
cd GitGuard
pnpm install
pnpm build
pnpm test
```

---

## Developer Quickstart (CLI)

The GitGuard CLI provides four primary subcommands plus the MCP server daemon:

```bash
gitguard --help
```

### 1. `gitguard inspect`
Inspects repository changes, diffs, statistics, and preliminary findings without evaluating full policy gates:

```bash
# Inspect all uncommitted modifications (staged + working tree)
gitguard inspect

# Inspect only staged changes formatted as JSON
gitguard inspect --staged --json

# Inspect a specific commit or branch range
gitguard inspect --target origin/main..HEAD

# Inspect with task context
gitguard inspect --task "Refactor user authentication middleware"
```

### 2. `gitguard check`
Runs full quality gate evaluation (deterministic checks + semantic decisions + policy rules):

```bash
# Check uncommitted changes against declared task
gitguard check --task "Add rate limiting to payment endpoints"

# Check only staged changes (ideal for Git pre-commit hooks)
gitguard check --staged

# Strict mode: treat WARN and REVIEW as blockers (exits with code 1 on non-PASS)
gitguard check --strict

# Offline mode: evaluate using deterministic fallback provider (no API key needed)
gitguard check --offline

# JSON output for tooling integration
gitguard check --json
```

### 3. `gitguard findings`
Lists, inspects, and filters active or resolved findings in the repository:

```bash
# List all active findings
gitguard findings

# Filter findings by status or severity
gitguard findings --status block
gitguard findings --severity critical

# Filter by affected file or policy rule
gitguard findings --file src/auth/token.ts
gitguard findings --rule auth_requires_tests
```

### 4. `gitguard verify`
Executes closed-loop verification to confirm whether previously detected findings have been successfully remediated:

```bash
# Verify resolution of specific finding IDs
gitguard verify --findings F-DETERMINISTIC-TEST-FAIL-1,F-TESTS-REQUIRED-2

# Verify in offline mode
gitguard verify --findings F-SECRET-DETECTED-0 --offline
```

### 5. `gitguard mcp`
Launches the Model Context Protocol (MCP) server over standard input/output (`stdio`) for AI coding agents:

```bash
# Start MCP server over stdio
gitguard mcp

# Start with diagnostic logging routed strictly to stderr
gitguard mcp --debug
```

---

## Coding Agent Autonomous Workflow

GitGuard is engineered specifically as a verification harness for autonomous AI coding agents. Agents execute an iterative **Inspect → Fix → Verify** loop:

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as Coding Agent
    participant Engine as GitGuard Engine
    participant Repo as Workspace

    User->>Agent: "Fix login token expiration bug"
    Agent->>Repo: Edit src/auth/token.ts
    Agent->>Engine: inspect_changes(task="Fix token expiration")
    Engine-->>Agent: Diff statistics & preliminary status
    Agent->>Engine: check_before_commit(task="Fix token expiration")
    Note over Engine: Tests PASS, but tests_required triggers REVIEW
    Engine-->>Agent: Status: REVIEW, Finding: F-TESTS-REQUIRED (Missing unit tests)
    Agent->>Repo: Create tests/auth/token.test.ts with assertions
    Agent->>Engine: verify_findings(findingIds=["F-TESTS-REQUIRED"])
    Note over Engine: Re-evaluates tests & diff context
    Engine-->>Agent: Status: PASS, Finding F-TESTS-REQUIRED resolved!
    Agent->>Repo: git commit -m "fix(auth): handle token expiration with unit tests"
    Agent-->>User: "Task completed verified clean by GitGuard."
```

### Step-by-Step Agent Implementation Guide
1. **Receive Prompt**: The agent parses user requirements into a concise `task` string.
2. **Execute Edits**: The agent modifies or creates code files.
3. **Inspect Changes**: Call `inspect_changes` to review diff hunks, affected files, and catch accidental secret leakage immediately.
4. **Pre-Commit Verification**: Call `check_before_commit` with the `task` description.
5. **Inspect Findings**: If verdict is `WARN`, `REVIEW`, or `BLOCK`, the agent reads `finding.expectedEvidence` to understand required fixes.
6. **Remediate**: The agent applies fixes (e.g. adding missing tests, reverting extraneous refactors, removing sensitive tokens).
7. **Verify**: Call `verify_findings` with the finding IDs.
8. **Clean Commit**: Once verdict reaches `PASS`, the agent commits or creates a PR with complete confidence.

---

## MCP Server Setup

GitGuard provides a native MCP server implementing the [Model Context Protocol](https://modelcontextprotocol.io/) specification over standard I/O (`stdio`).

### Registered MCP Tools

| Tool Name | Parameters | Description |
|:---|:---|:---|
| **`inspect_changes`** | `scope`, `target`, `task`, `cwd` | Read-only inspection of diffs, modified files, line counts, and preliminary findings. |
| **`check_task_completion`** | `task` (required), `scope`, `cwd` | Evaluates task fulfillment probability and flags unrelated diff drift. |
| **`check_before_commit`** | `task`, `scope`, `cwd` | Full quality gate check combining tests, linting, secrets, and policy rules. |
| **`verify_findings`** | `findingIds` (required), `task`, `cwd` | Closed-loop verification confirming remediation of reported finding IDs. |

### Protocol Hygiene Notice
GitGuard strictly preserves the MCP stdio protocol. **Zero diagnostic messages are ever printed to `stdout`**. All diagnostic or debug output is routed strictly to `stderr` via `--debug`.

### 1. Claude Desktop Configuration
Add GitGuard to your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "node",
      "args": [
        "/absolute/path/to/GitGuard/bin/gitguard.js",
        "mcp"
      ],
      "env": {
        "TYPESAFE_API_KEY": "your-typesafe-api-key-here"
      }
    }
  }
}
```

*Tip (Development mode with `tsx`):*
```json
{
  "mcpServers": {
    "gitguard": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/GitGuard", "gitguard", "mcp"],
      "env": {
        "TYPESAFE_API_KEY": "your-typesafe-api-key-here"
      }
    }
  }
}
```

### 2. Cursor IDE Configuration
Create or update `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "node",
      "args": ["bin/gitguard.js", "mcp"],
      "env": {
        "TYPESAFE_API_KEY": "your-typesafe-api-key-here"
      }
    }
  }
}
```

### 3. Google Antigravity Configuration
In your Antigravity MCP configuration settings (`mcp.json`):

```json
{
  "mcpServers": {
    "gitguard": {
      "command": "node",
      "args": ["bin/gitguard.js", "mcp"]
    }
  }
}
```

---

## CI/CD Integration (GitHub Actions)

GitGuard integrates seamlessly into GitHub Actions workflows to protect pull requests and main branches.

### Workflow Example: `.github/workflows/gitguard.yml`

```yaml
name: GitGuard Verification Gate

on:
  pull_request:
    branches: [ main, master, develop ]
  push:
    branches: [ main, master ]

jobs:
  verify:
    name: Repository Change Verification
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history required for diff analysis

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Install pnpm
        uses: pnpm/action-setup@v3
        with:
          version: 9

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run GitGuard Quality Gate
        id: gitguard
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
        run: |
          # In PR context, check changes between base branch and HEAD
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            pnpm gitguard check origin/${{ github.base_ref }}..HEAD --json > gitguard-report.json
          else
            pnpm gitguard check HEAD~1..HEAD --json > gitguard-report.json
          fi

      - name: Post Verification Summary to Pull Request
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            if (!fs.existsSync('gitguard-report.json')) return;
            
            const report = JSON.parse(fs.readFileSync('gitguard-report.json', 'utf8'));
            const verdictIcon = report.status === 'PASS' ? '✅' : (report.status === 'WARN' ? '⚠️' : '❌');
            
            let body = `### ${verdictIcon} GitGuard Verification Gate: **${report.status}**\n\n`;
            body += `${report.summary}\n\n`;
            
            if (report.findings && report.findings.length > 0) {
              body += `| Finding ID | Severity | Status | Message |\n`;
              body += `|:---|:---:|:---:|:---|\n`;
              for (const f of report.findings) {
                body += `| \`${f.id}\` | **${f.severity}** | ${f.status} | ${f.message} |\n`;
              }
            } else {
              body += `*Zero violations detected. Changeset is clean and verified.*`;
            }
            
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body
            });
```

---

## Configuration Reference (`.gitguard.yml`)

The complete reference schema for `.gitguard.yml`:

```yaml
version: 1
```

### `context` (Object)
Controls the extraction budget and AST context parameters for diff analysis:

| Key | Type | Default | Description |
|:---|:---|:---:|:---|
| `max_diff_chars` | `number` | `50000` | Character limit for unified diffs before intelligent truncation. |
| `max_total_chars` | `number` | `100000` | Absolute upper bound on character size for the synthesized evaluation context. |
| `surrounding_lines` | `number` | `40` | Number of surrounding lines of source code included around diff hunks. |
| `related_tests.max_files` | `number` | `5` | Maximum number of co-located test files discovered and attached to context. |
| `instructions.max_chars` | `number` | `15000` | Character budget for repository guideline documents (`AGENTS.md`, etc.). |

### `system_one` (Object)
Configures the semantic judgment provider:

| Key | Type | Default | Description |
|:---|:---|:---:|:---|
| `provider` | `string` | `'typesafe'` | Provider name: `'typesafe'` (live System One) or `'mock'` (offline simulation). |
| `model` | `string` | `'jev'` | Identifier of the underlying semantic evaluator model. |
| `timeout_ms` | `number` | `10000` | Maximum network wait time (ms) for model responses. |
| `apiKey` | `string` | `undefined` | Optional explicit API key (defaults to `TYPESAFE_API_KEY` environment variable). |

### `deterministic` (Object)
Configures concrete tool checks executed as isolated subprocesses:

| Key | Type | Default | Description |
|:---|:---|:---:|:---|
| `test.enabled` | `boolean` | `true` | Enables or disables automated test execution. |
| `test.run` | `string` | `'pnpm test'` | Test execution command. |
| `test.block_on_failure` | `boolean` | `true` | When `true`, test failure immediately sets gate status to `BLOCK`. |
| `test.timeout_ms` | `number` | `60000` | Maximum execution time in milliseconds before terminating the test runner. |
| `lint.enabled` | `boolean` | `true` | Enables or disables the static linter. |
| `lint.run` | `string` | `'pnpm lint'` | Linter execution command. |
| `typecheck.enabled` | `boolean` | `true` | Enables or disables static type checking. |
| `typecheck.run` | `string` | `'pnpm tsc --noEmit'` | Typecheck compiler command. |
| `secret_scan.enabled` | `boolean` | `true` | Enables real-time regex secret detection on added diff lines. |
| `secret_scan.block_on_detection` | `boolean` | `true` | Immediate `BLOCK` verdict when unredacted credentials are discovered. |

### `rules` (Object)
Configures standard built-in semantic decision rules and thresholds:

| Rule Key | Threshold Properties | Default | Rationale |
|:---|:---|:---:|:---|
| `task_completed` | `review_below`, `block_below` | `< 0.60` (REVIEW), `< 0.20` (BLOCK) | Inverted: triggers violation if completion confidence is *lower* than threshold. |
| `unrelated_changes` | `warn`, `review`, `block` | `0.55`, `0.75`, `0.95` | Triggers when changes diverge from declared task intent. |
| `tests_required` | `warn`, `review` | `0.60`, `0.80` | Triggers when functional modifications lack automated tests. |
| `security_sensitive` | `warn`, `review`, `block` | `0.50`, `0.65`, `0.90` | Triggers on modifications touching security-critical code paths. |
| `regression_risk` | `warn_on`, `review_on`, `block_on` | `['medium']`, `['high']`, `['critical']` | Evaluates blast radius and likelihood of introducing bugs. |

### `custom_rules` (Array of Objects)
Defines project-specific semantic rules evaluated against matching files:

| Property | Type | Description |
|:---|:---|:---:|
| `id` | `string` | Unique identifier (e.g., `auth_requires_tests`). |
| `description` | `string` | Human-readable explanation of rule purpose. |
| `files` | `string[]` | Array of glob patterns defining target file scope (e.g., `["src/auth/**"]`). |
| `exclude` | `string[]` | Array of glob patterns excluded from evaluation (e.g., `["**/*.test.ts"]`). |
| `question` | `string` | Precise natural language prompt evaluated by System One. |
| `primitive` | `string` | Primitive evaluation type: `'noul'` (probability), `'boolean'`, `'choice'`, or `'score'`. |
| `warn`, `review`, `block` | `number` | Probability thresholds triggering respective verdicts. |

### `privacy` (Object)
Data sanitization and privacy controls:

| Key | Type | Default | Description |
|:---|:---|:---:|:---|
| `redact_secrets` | `boolean` | `true` | Replaces detected credentials with `***[REDACTED]***` before logging or model calls. |
| `include_full_files` | `boolean` | `false` | Restricts context to diff hunks and surrounding spans rather than whole files. |
| `exclude_paths` | `string[]` | `['.env*', '*.pem', '*.key', ...]` | File patterns entirely excluded from diff extraction and context. |

### `gate` (Object)
Operational gate behavior:

| Key | Type | Default | Description |
|:---|:---|:---:|:---|
| `block_on` | `string[]` | `['BLOCK']` | Verdict levels producing a non-zero exit code. Add `'REVIEW'` or `'WARN'` for strict enforcement. |
| `cache.enabled` | `boolean` | `true` | Enables diff-hash verification caching to accelerate repeat runs. |
| `cache.directory` | `string` | `'.git/gitguard/cache'` | Directory where verification cache entries are stored. |

---

## Security & Privacy Model

GitGuard is built with defense-in-depth principles:

1. **Read-Only Git Operations**: All git inspections execute non-mutating commands (`git diff`, `git status`, `git show`). GitGuard will never mutate staging, alter commits, or modify your working tree.
2. **Dual Evaluation Contexts**: Complete separation between `RawRepositoryContext` (used by local deterministic checks to catch hardcoded secrets in `.env` and diffs) and `SemanticEvaluationContext` (sanitized and redacted before sending to external AI models).
3. **Command Sandbox**: Subprocesses run through `execFile` without shell interpolation (`shell: false`), disallowing command chaining (`&&`, `;`, `|`), redirection, or shell metacharacter injection.
4. **Prompt Injection Mitigation**: Evaluation questions use typed primitives (`noul`, `choice`, `score`) with explicit instructions rather than free-form unconstrained prompts, preventing diff contents from hijacking verification results.

For complete details on our threat model and security boundaries, see [SECURITY.md](SECURITY.md).

---

## Development & Verification

### Running the Test Suite
The repository includes a comprehensive test suite covering unit tests, stress suites, adversarial edge cases, and CLI/MCP integration:

```bash
# Run full Vitest suite (684+ tests)
pnpm test

# Run unit tests only
pnpm test:unit

# Run end-to-end tests
pnpm test:e2e

# Run with test coverage reporting
pnpm test:coverage
```

### TypeScript Compilation & Typecheck
```bash
# Typecheck with zero errors
pnpm typecheck

# Full production build to dist/
pnpm build
```

---

## License

GitGuard is licensed under the [Apache-2.0 License](LICENSE).
