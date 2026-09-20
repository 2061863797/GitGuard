/**
 * src/interfaces/cli/check.ts
 * Command handler for `gitguard check`.
 */

import type { GitGuardEngine, CheckOptions, CheckResult } from '../../types/engine.js';
import type { ChangeScope } from '../../types/git.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { formatCheckText } from './formatters.js';

export interface CheckCliOptions {
  staged?: boolean;
  working?: boolean;
  all?: boolean;
  scope?: string;
  target?: string;
  task?: string;
  config?: string;
  format?: string;
  json?: boolean;
  strict?: boolean;
  failOnWarn?: boolean;
  offline?: boolean;
  mock?: boolean;
  requireSemantic?: boolean;
  noCache?: boolean;
  findingIds?: string[];
  findings?: string;
  cwd?: string;
  silent?: boolean;
}

export async function checkCommand(
  targetOrRange?: string,
  options: CheckCliOptions = {},
  engine: GitGuardEngine = new DefaultGitGuardEngine()
): Promise<{ exitCode: number; output: string; result?: CheckResult }> {
  try {
    const target = targetOrRange || options.target;

    let scope: ChangeScope = 'all';
    if (options.staged) {
      scope = 'staged';
    } else if (options.working) {
      scope = 'working-tree';
    } else if (options.scope) {
      scope = (options.scope === 'working' ? 'working-tree' : options.scope) as ChangeScope;
    } else if (target) {
      scope = target.includes('..') ? 'range' : 'commit';
    }

    let findingIds: string[] | undefined = options.findingIds;
    if (!findingIds && options.findings) {
      findingIds = options.findings
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const checkOpts: CheckOptions = {
      scope,
      target,
      cwd: options.cwd,
      task: options.task,
      configPath: options.config,
      strict: options.strict,
      failOnWarn: options.failOnWarn,
      offline: options.offline || options.mock,
      requireSemantic: options.requireSemantic,
      noCache: options.noCache,
      findingIds,
    };

    const result = await engine.check(checkOpts);

    const isJson = options.json === true || options.format === 'json';
    const output = isJson
      ? JSON.stringify(result, null, 2)
      : formatCheckText(result);

    if (!options.silent) {
      // Print explicit warning or error if semantic fallback occurred
      const decisionsList = Object.values(result.semanticDecisions || {});
      const hasFallback = decisionsList.some((d) => d.metadata?.fallback === true);
      if (hasFallback && !isJson) {
        if (options.requireSemantic) {
          console.error('\n❌  ERROR: --require-semantic specified, but TypeSafe Jev was unavailable.');
        } else {
          console.warn('\n⚠️  WARNING: TypeSafe Jev unavailable. Evaluated using offline fallback provider.');
        }
      }
      console.log(output);
    }

    const exitCode = result.exitCode ?? (result.status === 'BLOCK' ? 1 : 0);
    return { exitCode, output, result };
  } catch (err: any) {
    const errorMsg = `Error executing check: ${err.message || String(err)}`;
    if (!options.silent) {
      console.error(errorMsg);
    }
    const exitCode = err.exitCode ?? 1;
    return { exitCode, output: errorMsg };
  }
}
