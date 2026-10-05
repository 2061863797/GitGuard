# Security Policy & Threat Model

This document describes the current source behavior. An existing package or EXE must be updated to a build containing the relevant fixes; editing source does not update an installed executable.

## Trust boundaries

GitGuard reads Git repositories, runs configured local tools, and can send repository context to TypeSafe / Jev. Repository contents and model responses are untrusted input. Project check commands are executable code and require trust in the repository.

```text
Repository content
  ├─ Raw context → local deterministic checks and secret scan
  └─ Semantic context → privacy filtering → optional online provider
Finding records → current repository store → verification and state updates
```

### Context and privacy

The deterministic scanner receives unredacted changes so privacy filtering does not hide secrets from local scanning. Semantic context omits sensitive-file hunks and code spans, and applies pattern-based redaction to task text, derived keywords, diffs, surrounding code, instructions and related test snippets.

Known patterns include private-key blocks, several provider token formats, bearer tokens and named password/API-key assignments. Quoted assignments and unquoted `:` / `=` forms are covered. Redaction is heuristic: it can miss unknown formats, short values and secrets without recognizable labels. It does not provide general high-entropy detection or guarantee that every secret is removed.

Online payloads can include task intent and keywords, file names and statistics, branch/commit metadata, diffs, surrounding code, related tests and repository instructions. Sensitive-file names and other metadata may still identify the project. Review the selected scope and privacy settings before using online checks for confidential projects.

MCP results and error messages apply the same known-secret redaction while preserving valid structured JSON. Stdout is reserved for MCP JSON-RPC; diagnostics go to stderr. This filtering does not make arbitrary project output safe to share.

### Git reads and project commands

The Git adapter uses an allowlist, rejects mutating commands and output-file options, and disables optional index locks. Diff, show and log calls disable external diff helpers and text conversion, including no-index diffs for untracked files. External blob filter options are rejected. GitGuard does not create Git commits or push changes.

Configured test, lint and typecheck commands run in the repository with timeouts and without shell interpolation. Those commands can run repository scripts and write files. They are not an operating-system sandbox. Read their configuration and scripts before checking an unfamiliar repository.

GitGuard can write finding and cache data under `.git/gitguard/`. An inspection summary does not run project checks or secret scanning by default. The MCP task-completion tool performs online semantic evaluation and may persist findings; it does not run local project checks.

### Provider and configuration authority

Repository `.gitguard.yml` cannot disable secret redaction, include full files in semantic context, or select a custom `system_one.baseUrl` without explicit custom-provider opt-in. CLI users can opt in with `--allow-custom-provider`. Environment variables such as `TYPESAFE_BASE_URL` and programmatic SDK options are trusted caller controls, so repository-file restrictions do not automatically apply to them.

The provider uses HTTPS for remote endpoints and permits explicitly configured HTTP loopback endpoints for local use. The default endpoint is TypeSafe. Keep API keys in the caller's environment or secret manager, not in repository configuration. A trusted endpoint override determines where the API key and context are sent.

MCP semantic tools require fresh TypeSafe responses and bypass semantic caching. Missing keys, failed requests, empty or invalid answers and mock/fallback decisions produce errors instead of invented success scores. Verification of unknown finding IDs stops before commands and online evaluation.

### Finding state and verification integrity

Disk records are loaded from the current repository. New finding provenance includes its repository root; shared in-memory fallback is accepted only when that root matches. Existing records without this field remain compatible when read from the current repository's own store.

Corrupt or unreadable stores stop verification. Writes use a temporary file in the destination directory and atomic replacement while holding the store lock; failed replacement does not overwrite existing records and is reported as a write error. Verification that cannot persist its state returns `BLOCK`, `allResolved: false` and `metadata.persistenceOk: false`. A successful in-memory assessment is not evidence of durable storage.

The verifier also checks tracked finding content at `HEAD` to avoid resolving supported violations merely because the offending changes were committed. Finding IDs and fingerprints are not globally scoped identifiers for unrelated repositories. Reports apply to the selected targets and Git scope.

### Model limitations

Typed semantic questions and response validation constrain answer shape and make provider failures visible. They do not prove model judgments correct or eliminate prompt injection in repository content. Online probabilities complement deterministic checks and human review.

## Supported versions

Security work targets the active release stream:

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| < 0.2.0 | No |

Source tests with simulated provider responses do not establish live service availability, real-model quality, installed-EXE acceptance or current remote CI status.

## Reporting a vulnerability

Avoid publishing credentials or an exploit in a public issue. Send a private report through GitHub Security Advisories or contact the repository maintainer privately. Include the affected version, reproduction steps, impact and any suggested mitigation. Maintainers can then coordinate validation, remediation and disclosure.
