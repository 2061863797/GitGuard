# Security Policy & Threat Model

GitGuard takes software security, data privacy, and agent verification integrity seriously. This document outlines our security architecture, threat model, boundaries, and disclosure process.

---

## 1. Threat Model & Security Boundaries

GitGuard operates as a repository-aware verification engine that interacts with local git repositories, local tools/subprocesses, and optional remote AI decision providers (TypeSafe / Jev).

### Architectural Boundaries

```text
┌────────────────────────────────────────────────────────┐
│                   Untrusted Environment                │
│    (Git Diff, Working Tree, Untracked Files, .env)     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                   GitGuard Core Engine                 │
│                                                        │
│  [Dual Context Separation]                             │
│  ├── RawRepositoryContext                              │
│  │   └── Local Deterministic Secret Scanner            │
│  │       (Unredacted diff, flags hardcoded secrets)   │
│  │                                                     │
│  └── SemanticEvaluationContext                         │
│      └── Context Privacy Sanitizer                     │
│          (Redacts API keys, passwords, tokens, env)    │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌────────────────────────┐      ┌────────────────────────┐
│  Local Subprocesses    │      │  External AI Provider  │
│  (npm test, tsc, etc.) │      │  (TypeSafe Jev API)    │
│  * Strictly controlled │      │  * Sanitized payload   │
│  * Repo-local only     │      │  * TLS HTTPS only      │
└────────────────────────┘      └────────────────────────┘
```

### Key Security Assurances

1. **Dual Context Architecture**:
   - **Local Scanning**: The built-in deterministic secret scanner analyzes unredacted diffs to detect committed or staged secrets (such as `.env`, AWS tokens, SSH private keys, GitHub PATs).
   - **Remote AI Calls**: Context passed to external semantic providers (e.g. TypeSafe System One) is strictly sanitized. Secret keys, high-entropy tokens, password patterns, and configured sensitive files (`.env*`, `*.pem`, `*.key`) are redacted before any outbound payload is serialized.

2. **Read-Only Git Inspection**:
   - The Git adapter rejects mutating Git commands and output redirection options, and disables optional Git index locks during inspection. It does not run `git commit`, `git checkout`, `git reset`, or `git push`.
   - GitGuard's own findings and evaluation cache are stored under `.git/gitguard/`. Configured test, lint and typecheck subprocesses run in the repository and may write files according to their scripts; run checks only for repositories whose commands you trust.

3. **Subprocess Isolation**:
   - Deterministic commands (tests, linters, typecheckers) configured in `.gitguard.yml` or default presets run within the local repository working directory with timeouts to prevent hanging or unbounded execution.
   - Configured commands run without shell interpolation, but can execute repository scripts or installed tools. Treat repository command configuration as executable code.

4. **Prompt Injection & Adversarial Diff Mitigation**:
   - Code diffs and commit messages could contain adversarial text attempting to trick AI evaluators. GitGuard structures evaluation questions with strict schemas (`noul`, `choice`, `score`) and typed criteria, rather than free-form unconstrained prompts, minimizing prompt injection attack surface.

5. **Trust Boundary, Verification Integrity & Secret Exfiltration Defense**:
   - Repository configuration (`.gitguard.yml`) cannot set a custom `system_one.baseUrl` without explicit `--allow-custom-provider` opt-in, including loopback addresses. A user-supplied `TYPESAFE_BASE_URL` environment variable remains an explicit override. Repository configuration also cannot disable secret redaction or include full files in semantic context.
   - Cache directory paths (`gate.cache.directory`) are strictly confined to `.git/gitguard/cache/` namespaces with path traversal protections to prevent writes outside repository boundaries. Live semantic caches are isolated by provider and bypassed when `--offline` is active.
   - Finding store files and caches utilize fail-closed cross-process atomic file locking (`O_CREAT | O_EXCL`) with unique owner tokens and process liveness detection (`process.kill(pid, 0)`) to guarantee state integrity under concurrent multi-agent environments.
   - **Baseline Drift Detection**: The verification engine tracks finding provenance (commit SHA, scope, diff hashes) and verifies file contents at `HEAD`. If an agent commits a policy violation into repository history instead of remediating it, GitGuard detects the committed violation, refuses false resolution, revives the finding, and maintains `BLOCK`.

---

## 2. Supported Versions

Security updates are applied to the active release stream:

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2.0 | :x:                |

---

## 3. Reporting a Vulnerability

If you discover a security vulnerability or security-sensitive defect in GitGuard:

1. **Do NOT file a public GitHub issue.**
2. Send a detailed vulnerability report privately to the maintainers via GitHub Security Advisories or by contacting the repository maintainer directly.
3. Include:
   - Description of the vulnerability.
   - Steps to reproduce or proof-of-concept diff.
   - Potential impact.
   - Any suggested mitigations.

We will acknowledge receipt within 48 hours and work with you to analyze, patch, and coordinate responsible disclosure.
