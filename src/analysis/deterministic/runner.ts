/**
 * src/analysis/deterministic/runner.ts
 * Deterministic status checker runner executing test, lint, typecheck, and secret scanning.
 * Provides safe subprocess execution, timeout guards, and robust error isolation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvaluationContext } from '../../types/context.js';
import type {
  DeterministicChecker,
  DeterministicConfig,
  DeterministicResult,
  DeterministicViolation,
  DeterministicCheckId,
} from '../../types/provider.js';
import { SecurityViolationError } from '../../types/errors.js';
import { scanDiffForSecrets } from './secrets.js';

const execFileAsync = promisify(execFile);

/**
 * Checks for unquoted dangerous shell metacharacters to prevent command injection
 * while permitting safe characters inside quoted argument strings.
 * On Windows/cmd.exe, single quotes do NOT suppress metacharacter detection.
 * Also detects unclosed quotes and properly handles escaped quotes.
 */
export function detectDangerousShellTokens(
  command: string,
  isWindows: boolean = process.platform === 'win32'
): string | null {
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    // Check if quote character is escaped by preceding odd number of backslashes
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && command[j] === '\\'; j--) {
      slashCount++;
    }
    const isEscaped = slashCount % 2 === 1;

    if (char === '"' && !isEscaped && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !isEscaped && !inDouble) {
      // On Windows / cmd.exe, single quotes do NOT possess quotation semantics.
      // Therefore, single quotes must not suppress metacharacter detection on Windows.
      if (!isWindows) {
        inSingle = !inSingle;
      }
    } else if (!inDouble && !inSingle) {
      if (
        char === ';' ||
        char === '|' ||
        char === '&' ||
        char === '>' ||
        char === '<' ||
        char === '`'
      ) {
        return char;
      }
      if (char === '$' && i + 1 < command.length && command[i + 1] === '(') {
        return '$(';
      }
      if (char === '\r' || char === '\n') {
        return 'newline';
      }
    }
  }

  // Detect unclosed quotes: if quotes remain open at the end of command string
  if (inDouble || inSingle) {
    return 'unclosed_quote';
  }

  return null;
}

/**
 * Resolves an executable binary or batch script against PATH or relative paths.
 */
export function resolveExecutable(executable: string, cwd?: string): string | null {
  // If executable includes path separator, check relative/absolute path directly
  if (executable.includes('/') || executable.includes('\\')) {
    const fullPath = path.resolve(cwd || process.cwd(), executable);
    if (fs.existsSync(fullPath)) return fullPath;
    if (process.platform === 'win32') {
      for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
        if (fs.existsSync(`${fullPath}${ext}`)) return `${fullPath}${ext}`;
      }
    }
    return null;
  }

  // Check PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const extensions =
    process.platform === 'win32'
      ? process.env.PATHEXT
        ? process.env.PATHEXT.split(';')
        : ['.COM', '.EXE', '.BAT', '.CMD']
      : [''];

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${executable}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore file system / permission errors
      }
    }
  }

  return null;
}

/**
 * Safely tokenizes a command line string into an executable and arguments array,
 * properly handling quoted strings.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    let slashCount = 0;
    for (let j = i - 1; j >= 0 && command[j] === '\\'; j--) {
      slashCount++;
    }
    const isEscaped = slashCount % 2 === 1;

    if (char === '"' && !isEscaped && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !isEscaped && !inDouble) {
      inSingle = !inSingle;
    } else if ((char === ' ' || char === '\t') && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Options for configuring DeterministicRunner.
 */
export interface DeterministicRunnerOptions {
  defaultTimeoutMs?: number;
  maxBuffer?: number;
}

/**
 * Deterministic status checker runner implementing DeterministicChecker.
 */
export class DeterministicRunner implements DeterministicChecker {
  private defaultTimeoutMs: number;
  private maxBuffer: number;

  constructor(options?: DeterministicRunnerOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 60000;
    this.maxBuffer = options?.maxBuffer ?? 20 * 1024 * 1024;
  }

  /**
   * Run all configured deterministic checks against the given EvaluationContext.
   */
  public async run(
    context: EvaluationContext,
    config: DeterministicConfig = {}
  ): Promise<DeterministicResult[]> {
    const results: DeterministicResult[] = [];

    // 1. Secret Scanning Check
    const secretScanConfig = config.checks?.secret_scan;
    if (secretScanConfig?.enabled !== false) {
      results.push(this.runSecretScan(context));
    } else {
      results.push({
        id: 'secret_scan',
        status: 'skipped',
        durationMs: 0,
        summary: 'Secret scan is explicitly disabled',
        violations: [],
      });
    }

    // 2. Command Checks: test, lint, typecheck
    const commandCheckIds: DeterministicCheckId[] = ['test', 'lint', 'typecheck'];

    for (const checkId of commandCheckIds) {
      const checkSetting = config.checks?.[checkId];
      const commandSetting = config.commands?.[checkId];

      // Explicitly disabled
      if (checkSetting?.enabled === false) {
        results.push({
          id: checkId,
          status: 'skipped',
          durationMs: 0,
          summary: `${checkId} check is explicitly disabled in configuration`,
        });
        continue;
      }

      // Determine command string and timeout
      const commandStr = checkSetting?.command || commandSetting?.run;
      const timeoutMs =
        checkSetting?.timeoutMs ??
        commandSetting?.timeoutMs ??
        this.defaultTimeoutMs;
      const cwd =
        commandSetting?.cwd ??
        context.repository?.rootPath ??
        process.cwd();

      // If no command is configured, check is skipped
      if (!commandStr || commandStr.trim() === '') {
        results.push({
          id: checkId,
          status: 'skipped',
          durationMs: 0,
          summary: `No command configured for ${checkId}`,
        });
        continue;
      }

      // Execute configured command
      const cmdResult = await this.executeSubprocessCheck(
        checkId,
        commandStr.trim(),
        cwd,
        timeoutMs
      );
      results.push(cmdResult);
    }

    return results;
  }

  /**
   * Runs the in-memory diff secret scanner.
   */
  private runSecretScan(context: EvaluationContext): DeterministicResult {
    const startTime = Date.now();
    const violations = scanDiffForSecrets(context.diff);
    const durationMs = Date.now() - startTime;

    if (violations.length > 0) {
      return {
        id: 'secret_scan',
        status: 'failed',
        exitCode: 1,
        durationMs,
        summary: `Secret scan found ${violations.length} high-risk secret credential(s) in diff`,
        violations,
      };
    }

    return {
      id: 'secret_scan',
      status: 'passed',
      exitCode: 0,
      durationMs,
      summary: 'Secret scan passed (no credentials or tokens detected in diff)',
      violations: [],
    };
  }

  /**
   * Executes a configured subprocess command with sandbox validation and error isolation.
   */
  private async executeSubprocessCheck(
    checkId: DeterministicCheckId,
    commandStr: string,
    cwd: string,
    timeoutMs: number
  ): Promise<DeterministicResult> {
    // 1. Command Safety Sandbox: validate against shell injection outside quotes
    const dangerousToken = detectDangerousShellTokens(commandStr);
    if (dangerousToken) {
      throw new SecurityViolationError(
        `Disallowed shell metacharacters ('${dangerousToken}') detected in ${checkId} command: "${commandStr}". Shell chaining and redirection are strictly forbidden.`
      );
    }

    const tokens = tokenizeCommand(commandStr);
    if (tokens.length === 0) {
      return {
        id: checkId,
        status: 'skipped',
        durationMs: 0,
        summary: `Empty command string provided for ${checkId}`,
      };
    }

    const executable = tokens[0];
    const args = tokens.slice(1);

    // 2. Resolve executable binary
    const resolvedPath = resolveExecutable(executable, cwd);
    if (!resolvedPath) {
      return {
        id: checkId,
        status: 'failed',
        exitCode: 127,
        durationMs: 0,
        stdout: '',
        stderr: `Command not found: ${executable}`,
        summary: `Command not found: ${executable}`,
        violations: [
          {
            rule: `${checkId}_not_found`,
            message: `Command executable not found: ${executable}`,
            severity: 'block',
          },
        ],
      };
    }

    const startTime = Date.now();

    try {
      let stdout = '';
      let stderr = '';

      // On Windows, .cmd or .bat files require execution through cmd.exe
      const isWindowsBatch =
        process.platform === 'win32' &&
        (resolvedPath.toLowerCase().endsWith('.cmd') ||
          resolvedPath.toLowerCase().endsWith('.bat'));

      if (isWindowsBatch) {
        const comSpec = process.env.ComSpec || 'cmd.exe';
        const result = await execFileAsync(comSpec, ['/d', '/s', '/c', commandStr], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: this.maxBuffer,
          windowsHide: true,
          env: {
            ...process.env,
            LC_ALL: 'C',
          },
        });
        stdout = result.stdout?.toString() ?? '';
        stderr = result.stderr?.toString() ?? '';
      } else {
        const result = await execFileAsync(resolvedPath, args, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: this.maxBuffer,
          windowsHide: true,
          env: {
            ...process.env,
            LC_ALL: 'C',
          },
        });
        stdout = result.stdout?.toString() ?? '';
        stderr = result.stderr?.toString() ?? '';
      }

      const durationMs = Date.now() - startTime;

      return {
        id: checkId,
        status: 'passed',
        exitCode: 0,
        durationMs,
        stdout,
        stderr,
        summary: `${checkId} checks passed successfully`,
        violations: [],
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const execErr = err as {
        code?: number | string;
        signal?: string;
        killed?: boolean;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };

      const stdoutStr = execErr.stdout ? execErr.stdout.toString() : '';
      const stderrStr = execErr.stderr ? execErr.stderr.toString() : execErr.message || '';
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

      // Handle Timeout
      if (execErr.killed || execErr.signal === 'SIGTERM' || execErr.code === 'ETIMEDOUT') {
        const violations: DeterministicViolation[] = [
          {
            rule: `${checkId}_timeout`,
            message: `Command exceeded maximum execution limit of ${timeoutMs}ms`,
            severity: 'block',
          },
        ];

        return {
          id: checkId,
          status: 'failed',
          exitCode: 124,
          durationMs,
          stdout: stdoutStr,
          stderr: stderrStr || `Command timed out after ${timeoutMs}ms`,
          summary: `${checkId} command timed out after ${timeoutMs}ms`,
          violations,
        };
      }

      // Handle ENOENT (command not found)
      if (
        execErr.code === 'ENOENT' ||
        stderrStr.includes('is not recognized as an internal or external command') ||
        stderrStr.includes('command not found') ||
        stderrStr.includes('not found')
      ) {
        const violations: DeterministicViolation[] = [
          {
            rule: `${checkId}_not_found`,
            message: `Command executable not found: ${executable}`,
            severity: 'block',
          },
        ];

        return {
          id: checkId,
          status: 'failed',
          exitCode: 127,
          durationMs,
          stdout: stdoutStr,
          stderr: stderrStr || `Command not found: ${executable}`,
          summary: `Command not found: ${executable}`,
          violations,
        };
      }

      // General command failure with non-zero exit code
      const violations: DeterministicViolation[] = [
        {
          rule: `${checkId}_failure`,
          message: `${checkId} check command failed with exit code ${exitCode}`,
          severity: 'block',
        },
      ];

      return {
        id: checkId,
        status: 'failed',
        exitCode,
        durationMs,
        stdout: stdoutStr,
        stderr: stderrStr,
        summary: `${checkId} checks failed with exit code ${exitCode}`,
        violations,
      };
    }
  }
}
