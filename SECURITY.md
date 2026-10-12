# Security Policy & Threat Model

This document describes the current source behavior. Installed plugins run the committed bundle `plugins/gitguard/server/gitguard-mcp.mjs`; update the plugin to pick up fixes.

## Trust boundaries

GitGuard is an MCP server. It reads Git repositories, runs configured local tools, and sends repository context to TypeSafe / Jev when rules are checked. Repository contents, agent-supplied rules and model responses are untrusted input. Project check commands are executable code and require trust in the repository; they come only from the repository `.gitguard.yml`, never from the calling agent.

```text
Repository content
  ├─ Raw context → local deterministic checks and secret scan
  └─ Semantic context → privacy filtering → TypeSafe (only when rules are checked)
Finding records → current repository store → verification and state updates
```

### Context and privacy

The deterministic scanner receives unredacted changes so privacy filtering does not hide secrets from local scanning. Semantic context omits sensitive-file hunks and code spans, and applies pattern-based redaction to task text, derived keywords, diffs, surrounding code, instructions and related test snippets.

Known patterns include private-key blocks, GitHub tokens (including fine-grained PATs), Stripe keys, AWS access and labeled secret keys, bearer tokens and named password/API-key assignments. Redaction also reuses every built-in deterministic scanner pattern to prevent the two format lists from diverging. Quoted assignments and unquoted `:` / `=` forms are covered. Custom scanner patterns are not automatically redaction rules. Redaction is heuristic: it can miss unknown formats, short values and secrets without recognizable labels. It does not provide general high-entropy detection or guarantee that every secret is removed.

Online payloads can include task intent and keywords, file names and statistics, branch/commit metadata, diffs, surrounding code, related tests and repository instructions. Sensitive-file names and other metadata may still identify the project. Review the selected scope and privacy settings before using online checks for confidential projects.

MCP results and error messages apply the same known-secret redaction while preserving valid structured JSON. Stdout is reserved for MCP JSON-RPC; diagnostics go to stderr. This filtering does not make arbitrary project output safe to share.

### Git reads and project commands

The Git adapter uses an allowlist, rejects mutating commands and output-file options, and disables optional index locks and repository-configured fsmonitor helpers for every Git call. Diff, show and log calls disable external diff helpers and text conversion, including no-index diffs for untracked files. External blob filter options are rejected. Status paths use NUL-delimited porcelain records so Unicode and special filenames are preserved. Unreadable or truncated untracked diffs fail the operation instead of silently dropping files or treating partial output as a complete diff. GitGuard does not create Git commits or push changes.

Surrounding code and optional full-file context use the diff's new-side snapshot: the index for staged changes, the selected commit for commit checks, and the right endpoint for range or pull-request checks. Working and all scopes use current working-tree content. Repository instructions and related-test discovery still use the current workspace.

Configured test, lint and typecheck commands run in the repository with timeouts and without shell interpolation. Those commands can run repository scripts and write files. They are not an operating-system sandbox. Read their configuration and scripts before checking an unfamiliar repository.

GitGuard writes finding records, the last-check record and the command cache under `.git/gitguard/`, and installs `.git/hooks/pre-commit` in repositories that opted in. Without a `.gitguard.yml`, only the secret scan runs; test, lint and typecheck commands run only when the repository configures them.

### Commit gate

In repositories with a GitGuard config file (in the working tree or in HEAD), `check` installs `.git/hooks/pre-commit`. Git runs it for every commit form, with the index that will actually be committed; it rejects the commit unless the last check covered those exact blob ids, HEAD is unchanged and the last verdict was not `BLOCK`. It never overwrites a pre-commit hook it did not install and does not write into a `core.hooksPath` outside the Git directory. Hook errors reject the commit; `git commit --no-verify` skips it, and merges, cherry-picks and reverts do not run it.

The plugin's PreToolUse hook blocks agent shell commands that skip or tamper with the hook (`--no-verify`, `commit -n`, `core.hooksPath`, `.git/hooks`, `.git/gitguard`). This is a guard against forgetting the check, not a security boundary: a process that can run arbitrary commands can still bypass it. Agent rules whose findings are still active at the current HEAD are re-checked by later checks and cannot be reworded or downgraded until resolved.

Passing test/lint/typecheck results are cached under `.git/gitguard/` keyed by HEAD, the content of every uncommitted file and the commands; ignored files are not part of the key.

### Provider and configuration authority

Repository `.gitguard.yml` accepts only project commands, rules and extra secret patterns; unknown keys are rejected. Context budgets, the model, the endpoint, secret redaction and sensitive-path exclusion are built in and cannot be changed from a repository, and API keys are never read from it. Environment variables such as `TYPESAFE_BASE_URL` and programmatic SDK options are trusted caller controls, so repository-file restrictions do not automatically apply to them.

The provider uses HTTPS for remote endpoints and permits explicitly configured HTTP loopback endpoints for local use. The default endpoint is TypeSafe. Keep API keys in the caller's environment or secret manager, not in repository configuration. A trusted endpoint override determines where the API key and context are sent.

There is no offline, mock or cached semantic mode. Every checked rule needs a fresh TypeSafe judgment; missing keys, failed requests and missing or invalid answers produce errors instead of invented success scores. Checks without rules make no online request. Verification of unknown finding IDs stops before commands and online evaluation.

### Finding state and verification integrity

Disk records are loaded from the current repository. New finding provenance includes its repository root; shared in-memory fallback is accepted only when that root matches. Existing records without this field remain compatible when read from the current repository's own store.

Corrupt or unreadable stores stop verification. Writes use a temporary file in the destination directory and atomic replacement while holding the store lock; failed replacement does not overwrite existing records and is reported as a write error. Verification that cannot persist its state returns `BLOCK`, `allResolved: false` and `metadata.persistenceOk: false`. A successful in-memory assessment is not evidence of durable storage.

The verifier also checks tracked finding content at `HEAD` to avoid resolving supported violations merely because the offending changes were committed. Finding IDs and fingerprints are not globally scoped identifiers for unrelated repositories. Reports apply to the selected targets and Git scope.

An empty diff checks no rules. Rules whose `files` filter matches no changed file are not sent. Verification re-checks the stored rule of each targeted finding; a finding resolves only when the fresh judgment is no violation (probability below 0.5) and deterministic checks no longer report it.

### Model limitations

Rule judgments and response validation constrain answer shape and make provider failures visible. They do not prove model judgments correct or eliminate prompt injection in repository content or agent-written rules. Online probabilities complement deterministic checks and human review.

## Supported versions

Security work targets the active release stream:

| Version | Supported |
| --- | --- |
| 0.3.x | Yes |
| < 0.3.0 | No |

Source tests with simulated provider responses do not establish live service availability, real-model quality, installed-plugin acceptance or current remote CI status.

## Reporting a vulnerability

Avoid publishing credentials or an exploit in a public issue. Send a private report through GitHub Security Advisories or contact the repository maintainer privately. Include the affected version, reproduction steps, impact and any suggested mitigation. Maintainers can then coordinate validation, remediation and disclosure.
