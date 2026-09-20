/**
 * src/interfaces/cli/verify.ts
 * Command handler for `gitguard verify`.
 */

import type { GitGuardEngine, VerifyOptions } from '../../types/engine.js';
import type { VerificationReport } from '../../types/finding.js';
import type { ChangeScope } from '../../types/git.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { formatVerifyText } from './formatters.js';

export interface VerifyCliOptions {
  findings?: string;
  findingIds?: string[];
  task?: string;
  scope?: string;
  config?: string;
  format?: string;
  json?: boolean;
  offline?: boolean;
  cwd?: string;
  silent?: boolean;
}

export async function verifyCommand(
  options: VerifyCliOptions = {},
  engine: GitGuardEngine = new DefaultGitGuardEngine()
): Promise<{ exitCode: number; output: string; report?: VerificationReport }> {
  try {
    let findingIds = options.findingIds;
    if (!findingIds && options.findings) {
      findingIds = options.findings
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const verifyOpts: VerifyOptions = {
      findingIds,
      task: options.task,
      scope: (options.scope as ChangeScope) ?? 'all',
      configPath: options.config,
      offline: options.offline,
      cwd: options.cwd,
    };

    const report = await engine.verify(verifyOpts);

    const isJson = options.json === true || options.format === 'json';
    const output = isJson
      ? JSON.stringify(report, null, 2)
      : formatVerifyText(report);

    if (!options.silent) {
      console.log(output);
    }

    const exitCode = report.status === 'PASS' ? 0 : 1;
    return { exitCode, output, report };
  } catch (err: any) {
    const errorMsg = `Error executing verify: ${err.message || String(err)}`;
    if (!options.silent) {
      console.error(errorMsg);
    }
    const exitCode = err.exitCode ?? 1;
    return { exitCode, output: errorMsg };
  }
}
