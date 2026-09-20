/**
 * src/context/filter.ts
 * Privacy and Secret Redaction Filter for GitGuard.
 * Excludes sensitive files and replaces high-risk credentials with <REDACTED_SECRET>.
 */

import type { EvaluationContext, PrivacyOptions } from '../types/context.js';

export const REDACTION_TOKEN = '<REDACTED_SECRET>';

/**
 * Standard sensitive file patterns that should be excluded from full context.
 */
export const DEFAULT_SENSITIVE_FILE_PATTERNS: string[] = [
  '**/.env',
  '**/.env.*',
  '*.env',
  '*.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.pkcs12',
  '**/*.pfx',
  '**/*.p12',
  '**/credentials.json',
  '**/client_secret*.json',
  '**/secrets.*',
  '**/*.secret',
  '**/id_rsa',
  '**/id_rsa.*',
  '**/id_ed25519',
  '**/id_ed25519.*',
  '**/id_ecdsa*',
  '**/id_dsa*',
  '**/*.keystore',
  '**/*.jks',
  '**/token.txt',
  '**/jwt.txt',
];

/**
 * Known secret and token patterns for redaction.
 */
const SECRET_REGEX_LIST: Array<{ pattern: RegExp; replacer: (match: string, ...args: string[]) => string }> = [
  // 1. Private Key Blocks
  {
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gs,
    replacer: () => `-----BEGIN PRIVATE KEY-----\n${REDACTION_TOKEN}\n-----END PRIVATE KEY-----`,
  },
  // 2. AWS Access Key IDs
  {
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    replacer: () => REDACTION_TOKEN,
  },
  // 3. GitHub Personal / OAuth / App Tokens
  {
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
    replacer: () => REDACTION_TOKEN,
  },
  // 4. OpenAI / Anthropic API Keys (sk-..., sk-proj-...)
  {
    pattern: /(?:sk-proj-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,})/g,
    replacer: () => REDACTION_TOKEN,
  },
  // 5. Slack Bot / User Tokens
  {
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}/g,
    replacer: () => REDACTION_TOKEN,
  },
  // 6. JSON Web Tokens (JWT)
  {
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacer: () => REDACTION_TOKEN,
  },
  // 7. Authorization: Bearer <token>
  {
    pattern: /(Bearer\s+)[a-zA-Z0-9_\-\.]{20,}/gi,
    replacer: (_m, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
  // 8. Key / Password variable assignments with quotes
  {
    pattern: /((?:password|passwd|secret|api_key|apikey|access_token|private_key|auth_token)\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi,
    replacer: (_m, p1: string, _val: string, p3: string) => `${p1}${REDACTION_TOKEN}${p3}`,
  },
];

/**
 * Converts a simple glob pattern (with *, **) into a RegExp.
 */
function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let regexStr = '^';
  let i = 0;

  while (i < normalized.length) {
    const c = normalized[i];
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if (['.', '(', ')', '+', '|', '^', '$', '[', ']', '{', '}'].includes(c)) {
      regexStr += '\\' + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

/**
 * Determines whether a file path matches any sensitive file patterns.
 */
export function isSensitiveFile(filePath: string, customPatterns?: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = normalized.split('/').pop() || normalized;
  const patterns = [...DEFAULT_SENSITIVE_FILE_PATTERNS, ...(customPatterns || [])];

  for (const pattern of patterns) {
    const re = globToRegex(pattern);
    if (re.test(normalized) || re.test(basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Redacts detected secrets and API keys from a text string.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let result = text;
  for (const { pattern, replacer } of SECRET_REGEX_LIST) {
    result = result.replace(pattern, replacer as unknown as string);
  }
  return result;
}

/**
 * Strips Git diff path prefixes ('a/' or 'b/') and unescapes quotes.
 */
function stripGitDiffPrefix(pathStr: string): string {
  let cleaned = pathStr.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.substring(1, cleaned.length - 1);
  }
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) {
    return cleaned.substring(2);
  }
  return cleaned;
}

/**
 * Extracts oldPath and newPath from a `diff --git ` line.
 */
function extractDiffGitPaths(line: string): { oldPath?: string; newPath?: string } {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return {};
  const rest = line.substring(prefix.length).trim();

  if (rest.startsWith('"')) {
    const secondQuoteIndex = rest.indexOf('"', 1);
    if (secondQuoteIndex !== -1) {
      const firstQuoted = rest.substring(1, secondQuoteIndex);
      let secondPath = rest.substring(secondQuoteIndex + 1).trim();
      if (secondPath.startsWith('"') && secondPath.endsWith('"')) {
        secondPath = secondPath.substring(1, secondPath.length - 1);
      }
      return {
        oldPath: stripGitDiffPrefix(firstQuoted),
        newPath: stripGitDiffPrefix(secondPath),
      };
    }
  }

  const splitIdx = rest.lastIndexOf(' b/');
  if (splitIdx !== -1) {
    return {
      oldPath: stripGitDiffPrefix(rest.substring(0, splitIdx)),
      newPath: stripGitDiffPrefix(rest.substring(splitIdx + 1)),
    };
  }

  const parts = rest.split(/\s+/);
  if (parts.length >= 2) {
    return {
      oldPath: stripGitDiffPrefix(parts[0]),
      newPath: stripGitDiffPrefix(parts[parts.length - 1]),
    };
  }

  return {};
}

/**
 * Redacts or omits diff hunks for sensitive files in a raw unified diff text.
 * Replaces hunk lines of sensitive files with `[Diff omitted for sensitive file: <filename>]`.
 */
export function omitSensitiveDiffHunks(
  rawDiff: string,
  excludePatterns?: string[],
  diffFiles?: Array<{ oldPath?: string; newPath: string }>
): string {
  if (!rawDiff || typeof rawDiff !== 'string') return rawDiff;

  const isSensitive = (p?: string) =>
    p ? isSensitiveFile(p, excludePatterns) : false;

  const sensitivePathSet = new Set<string>();
  if (diffFiles) {
    for (const file of diffFiles) {
      if (isSensitive(file.newPath) || isSensitive(file.oldPath)) {
        if (file.newPath && file.newPath !== '/dev/null') sensitivePathSet.add(file.newPath);
        if (file.oldPath && file.oldPath !== '/dev/null') sensitivePathSet.add(file.oldPath);
      }
    }
  }

  const lines = rawDiff.split(/\r?\n/);
  const outputLines: string[] = [];

  let currentFileIsSensitive = false;
  let currentFileName = '';
  let hunkOmittedForCurrentHunk = false;

  const headerPrefixes = [
    'index ',
    'new file mode ',
    'deleted file mode ',
    'similarity index ',
    'rename from ',
    'rename to ',
    'copy from ',
    'copy to ',
    '--- ',
    '+++ ',
    'Binary files ',
    'GIT binary patch ',
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const paths = extractDiffGitPaths(line);
      const fileIsSens =
        (paths.newPath && sensitivePathSet.has(paths.newPath)) ||
        (paths.oldPath && sensitivePathSet.has(paths.oldPath)) ||
        isSensitive(paths.newPath) ||
        isSensitive(paths.oldPath);

      currentFileIsSensitive = fileIsSens;
      currentFileName =
        paths.newPath && paths.newPath !== '/dev/null'
          ? paths.newPath
          : paths.oldPath || paths.newPath || 'sensitive_file';
      hunkOmittedForCurrentHunk = false;

      outputLines.push(line);
      continue;
    }

    // If before any `diff --git ` line or in a single file diff
    if (outputLines.length === 0 && !line.startsWith('diff --git ')) {
      if (diffFiles && diffFiles.length > 0) {
        const firstFile = diffFiles[0];
        if (isSensitive(firstFile.newPath) || isSensitive(firstFile.oldPath)) {
          currentFileIsSensitive = true;
          currentFileName =
            firstFile.newPath && firstFile.newPath !== '/dev/null'
              ? firstFile.newPath
              : firstFile.oldPath || firstFile.newPath || 'sensitive_file';
        }
      }
    }

    if (!currentFileIsSensitive) {
      outputLines.push(line);
      continue;
    }

    // In a sensitive file diff:
    // Check if line is a file metadata / header line
    const isHeader = headerPrefixes.some((prefix) => line.startsWith(prefix));
    if (isHeader) {
      outputLines.push(line);
      continue;
    }

    // Line is part of a hunk (either @@ hunk header or content line)
    const omittedMessage = `[Diff omitted for sensitive file: ${currentFileName}]`;

    if (line.startsWith('@@')) {
      if (outputLines[outputLines.length - 1] !== omittedMessage) {
        outputLines.push(omittedMessage);
      }
      hunkOmittedForCurrentHunk = true;
      continue;
    }

    // Hunk content line (+, -, space, \, or raw lines)
    if (!hunkOmittedForCurrentHunk) {
      if (outputLines[outputLines.length - 1] !== omittedMessage) {
        outputLines.push(omittedMessage);
      }
      hunkOmittedForCurrentHunk = true;
    }
    // Suppress sensitive hunk content line
  }

  return outputLines.join('\n');
}

/**
 * Sanitizes an entire EvaluationContext according to PrivacyOptions.
 */
export function sanitizeEvaluationContext(
  context: EvaluationContext,
  options?: PrivacyOptions
): EvaluationContext {
  const shouldRedact = options?.redactSecrets !== false;
  const includeFullFiles = options?.includeFullFiles === true;
  const excludePatterns = options?.excludePatterns;

  const rawWithOmissions = omitSensitiveDiffHunks(
    context.diff.raw,
    excludePatterns,
    context.diff.files
  );

  const sanitized: EvaluationContext = {
    ...context,
    task: context.task
      ? {
          ...context.task,
          task: shouldRedact ? redactSecrets(context.task.task) : context.task.task,
        }
      : undefined,
    diff: {
      ...context.diff,
      raw: shouldRedact ? redactSecrets(rawWithOmissions) : rawWithOmissions,
      files: context.diff.files.map((file) => {
        const isSensitive =
          isSensitiveFile(file.newPath, excludePatterns) ||
          (file.oldPath ? isSensitiveFile(file.oldPath, excludePatterns) : false);
        return {
          ...file,
          hunks: isSensitive
            ? []
            : file.hunks.map((hunk) => ({
                ...hunk,
                lines: hunk.lines,
              })),
        };
      }),
    },
    files: context.files.map((fc) => {
      const isSensitive = isSensitiveFile(fc.path, excludePatterns);
      if (isSensitive) {
        return {
          ...fc,
          spans: [],
          content: undefined,
        };
      }
      return {
        ...fc,
        spans: fc.spans.map((span) => ({
          ...span,
          code: shouldRedact ? redactSecrets(span.code) : span.code,
        })),
        content: includeFullFiles && fc.content
          ? shouldRedact
            ? redactSecrets(fc.content)
            : fc.content
          : undefined,
      };
    }),
    instructions: context.instructions.map((inst) => ({
      ...inst,
      content: shouldRedact ? redactSecrets(inst.content) : inst.content,
    })),
    relatedTests: context.relatedTests.map((t) => ({
      ...t,
      contentSnippet:
        t.contentSnippet && shouldRedact
          ? redactSecrets(t.contentSnippet)
          : t.contentSnippet,
    })),
  };

  return sanitized;
}

/**
 * Privacy and secret filter helper class.
 */
export class PrivacyFilter {
  constructor(private readonly options?: PrivacyOptions) {}

  public isSensitive(filePath: string): boolean {
    return isSensitiveFile(filePath, this.options?.excludePatterns);
  }

  public redact(text: string): string {
    return redactSecrets(text);
  }

  public omitSensitiveDiff(rawDiff: string, diffFiles?: Array<{ oldPath?: string; newPath: string }>): string {
    return omitSensitiveDiffHunks(rawDiff, this.options?.excludePatterns, diffFiles);
  }

  public sanitize(context: EvaluationContext): EvaluationContext {
    return sanitizeEvaluationContext(context, this.options);
  }
}

