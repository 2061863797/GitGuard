/**
 * src/analysis/deterministic/secrets.ts
 * Diff secret scanner for GitGuard.
 * Scans newly added lines in diffs for credentials, tokens, API keys, private keys, and passwords.
 */

import type { DiffContext } from '../../types/diff.js';
import type { DeterministicViolation } from '../../types/provider.js';
import { parseHunkLines } from '../../git/diff-parser.js';

/**
 * Secret pattern rule definition.
 */
export interface SecretPattern {
  rule: string;
  description: string;
  regex: RegExp;
  extractGroup?: number;
}

/**
 * Redacts a detected secret substring to prevent leaking credentials into logs,
 * findings, and terminal output.
 */
export function redactSecret(secret: string): string {
  if (!secret || typeof secret !== 'string') {
    return '***[REDACTED]***';
  }
  const clean = secret.trim();
  if (clean.length <= 6) {
    return '***[REDACTED]***';
  }
  const prefix = clean.slice(0, 3);
  const suffix = clean.slice(-2);
  return `${prefix}...[REDACTED]...${suffix}`;
}

/**
 * Default standard secret patterns recognized by GitGuard.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    rule: 'aws_access_key',
    description: 'AWS Access Key ID',
    regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
  },
  {
    rule: 'aws_secret_key',
    description: 'AWS Secret Access Key',
    regex: /(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["'`]?([A-Za-z0-9/+=]{40})["'`]?/i,
    extractGroup: 1,
  },
  {
    rule: 'github_token',
    description: 'GitHub Personal Access Token',
    regex: /(?:gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{82})/,
  },
  {
    rule: 'openai_secret',
    description: 'OpenAI / API Secret Key',
    regex: /(?:sk-[a-zA-Z0-9]{32,}|sk-proj-[a-zA-Z0-9_-]{32,})/,
  },
  {
    rule: 'private_key',
    description: 'Private Key Header',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    rule: 'jwt_token',
    description: 'JSON Web Token (JWT)',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    rule: 'slack_token',
    description: 'Slack API Token',
    regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/,
  },
  {
    rule: 'stripe_key',
    description: 'Stripe API Key',
    regex: /sk_(?:live|test)_[0-9a-zA-Z]{24}/,
  },
  {
    rule: 'hardcoded_secret',
    description: 'Hardcoded Credential / Secret',
    regex: /(?:password|passwd|api_key|apikey|secret_key|auth_token)\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i,
    extractGroup: 1,
  },
  {
    rule: 'unquoted_config_secret',
    description: 'Unquoted configuration credential',
    regex: /\b(?:password|passwd|api_key|apikey|secret_key|auth_token|access_token|private_key)\s*[:=]\s*([^\s"'`#,]{16,})/i,
    extractGroup: 1,
  },
];

/** Restricts user-defined patterns to a bounded, non-backtracking regex subset. */
export function validateCustomSecretPattern(source: string): string | null {
  if (!source.trim() || source.length > 500) {
    return 'pattern must contain 1-500 characters';
  }

  let inClass = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      if (!inClass && /[1-9]/.test(char)) return 'backreferences are not allowed';
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[' && !inClass) {
      inClass = true;
      continue;
    }
    if (char === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === '{') {
      const end = source.indexOf('}', i + 1);
      const count = end < 0 ? '' : source.slice(i + 1, end);
      if (!/^\d+$/.test(count) || Number(count) > 128) {
        return 'only exact repetitions up to {128} are allowed';
      }
      i = end;
      continue;
    }
    if (char === '}' || char === '(' || char === ')' || char === '|' ||
        char === '*' || char === '+' || char === '?') {
      return 'groups, alternation, and variable repetitions are not allowed';
    }
  }

  try {
    new RegExp(source);
  } catch {
    return 'invalid regular expression';
  }
  return null;
}

/**
 * Scans consecutive addition lines (multiline declarations) for secrets that span lines.
 */
function scanConsecutiveAdditionLines(
  run: Array<{ content: string; newLineNumber?: number }>,
  filePath: string,
  patterns: SecretPattern[],
  reportedLineRule: Set<string>,
  violations: DeterministicViolation[]
): void {
  const maxWindow = 5;
  for (let i = 0; i < run.length; i++) {
    const end = Math.min(run.length, i + maxWindow);
    for (let j = i + 2; j <= end; j++) {
      const slice = run.slice(i, j);
      const combinedText = slice.map((l) => l.content).join('\n');
      const startLineNumber = slice[0].newLineNumber;

      for (const pattern of patterns) {
        const match = combinedText.match(pattern.regex);
        if (!match) continue;

        const matchedSecret =
          pattern.extractGroup !== undefined && match[pattern.extractGroup]
            ? match[pattern.extractGroup]
            : match[0];

        const lowerMatch = matchedSecret.toLowerCase();
        if (
          lowerMatch === 'placeholder' ||
          lowerMatch === 'changeme' ||
          lowerMatch === 'your_secret_here'
        ) {
          continue;
        }

        // If any line in this window has already been reported for this rule, skip duplicate
        const alreadyReported = slice.some(
          (l) =>
            l.newLineNumber !== undefined &&
            reportedLineRule.has(`${filePath}:${pattern.rule}:${l.newLineNumber}`)
        );
        if (alreadyReported) continue;

        // Mark all lines in window as reported for this rule
        for (const l of slice) {
          if (l.newLineNumber !== undefined) {
            reportedLineRule.add(`${filePath}:${pattern.rule}:${l.newLineNumber}`);
          }
        }

        const redactedSnippet = redactSecret(matchedSecret);
        violations.push({
          file: filePath,
          line: startLineNumber,
          rule: pattern.rule,
          message: `Potential ${pattern.description} detected in added line: ${redactedSnippet}`,
          severity: 'block',
        });
      }
    }
  }
}

/**
 * Scans newly added lines in a DiffContext for secrets and credentials.
 * Returns structured DeterministicViolation array.
 */
export function scanDiffForSecrets(
  diff: DiffContext,
  patterns: SecretPattern[] = SECRET_PATTERNS
): DeterministicViolation[] {
  const violations: DeterministicViolation[] = [];

  if (!diff || !diff.files || diff.files.length === 0) {
    return violations;
  }

  for (const file of diff.files) {
    // Skip binary files as they contain no textual hunks
    if (file.binary || !file.hunks) {
      continue;
    }

    const reportedLineRule = new Set<string>();

    for (const hunk of file.hunks) {
      const parsedLines = parseHunkLines(hunk);

      // 1. Single line scanning
      for (const line of parsedLines) {
        // Only inspect additions (newly introduced lines)
        if (line.type !== 'addition' || !line.content) {
          continue;
        }

        const lineText = line.content;

        for (const pattern of patterns) {
          const match = lineText.match(pattern.regex);
          if (!match) {
            continue;
          }

          const matchedSecret =
            pattern.extractGroup !== undefined && match[pattern.extractGroup]
              ? match[pattern.extractGroup]
              : match[0];

          // Filter out obvious false positives like empty strings or generic placeholder words
          const lowerMatch = matchedSecret.toLowerCase();
          if (
            lowerMatch === 'placeholder' ||
            lowerMatch === 'changeme' ||
            lowerMatch === 'your_secret_here'
          ) {
            continue;
          }

          const key = `${file.newPath}:${pattern.rule}:${line.newLineNumber}`;
          if (reportedLineRule.has(key)) {
            continue;
          }
          reportedLineRule.add(key);

          const redactedSnippet = redactSecret(matchedSecret);

          violations.push({
            file: file.newPath,
            line: line.newLineNumber,
            rule: pattern.rule,
            message: `Potential ${pattern.description} detected in added line: ${redactedSnippet}`,
            severity: 'block',
          });
        }
      }

      // 2. Multiline / consecutive additions scanning
      let currentRun: typeof parsedLines = [];
      for (const line of parsedLines) {
        if (line.type === 'addition') {
          currentRun.push(line);
        } else if (currentRun.length > 0) {
          if (currentRun.length > 1) {
            scanConsecutiveAdditionLines(
              currentRun,
              file.newPath,
              patterns,
              reportedLineRule,
              violations
            );
          }
          currentRun = [];
        }
      }
      if (currentRun.length > 1) {
        scanConsecutiveAdditionLines(
          currentRun,
          file.newPath,
          patterns,
          reportedLineRule,
          violations
        );
      }
    }
  }

  return violations;
}

/**
 * Scans full textual content of a file for secrets and credentials.
 * Used during verification to prevent resolving secret findings when credentials
 * were committed into repository history or remain present in working tree files.
 */
export function scanContentForSecrets(
  content: string,
  filePath: string,
  patterns: SecretPattern[] = SECRET_PATTERNS
): DeterministicViolation[] {
  const violations: DeterministicViolation[] = [];
  if (!content || typeof content !== 'string') {
    return violations;
  }

  const rawLines = content.split(/\r?\n/);
  const reportedLineRule = new Set<string>();

  // 1. Single line scanning
  for (let i = 0; i < rawLines.length; i++) {
    const lineText = rawLines[i];
    const lineNumber = i + 1;

    for (const pattern of patterns) {
      const match = lineText.match(pattern.regex);
      if (!match) {
        continue;
      }

      const matchedSecret =
        pattern.extractGroup !== undefined && match[pattern.extractGroup]
          ? match[pattern.extractGroup]
          : match[0];

      const lowerMatch = matchedSecret.toLowerCase();
      if (
        lowerMatch === 'placeholder' ||
        lowerMatch === 'changeme' ||
        lowerMatch === 'your_secret_here'
      ) {
        continue;
      }

      const key = `${filePath}:${pattern.rule}:${lineNumber}`;
      if (reportedLineRule.has(key)) {
        continue;
      }
      reportedLineRule.add(key);

      const redactedSnippet = redactSecret(matchedSecret);

      violations.push({
        file: filePath,
        line: lineNumber,
        rule: pattern.rule,
        message: `Potential ${pattern.description} detected in file content: ${redactedSnippet}`,
        severity: 'block',
      });
    }
  }

  // 2. Multiline scanning
  const run = rawLines.map((line, idx) => ({ content: line, newLineNumber: idx + 1 }));
  scanConsecutiveAdditionLines(run, filePath, patterns, reportedLineRule, violations);

  return violations;
}
