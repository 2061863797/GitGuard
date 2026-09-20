/**
 * src/interfaces/cli/inspect.ts
 * Command handler for `gitguard inspect`.
 */

import type { GitGuardEngine, InspectOptions, InspectResult } from '../../types/engine.js';
import type { ChangeScope } from '../../types/git.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { formatInspectText } from './formatters.js';

export interface InspectCliOptions {
  scope?: string;
  target?: string;
  format?: string;
  json?: boolean;
  task?: string;
  checkDeterministic?: boolean;
  config?: string;
  cwd?: string;
  silent?: boolean;
}

export async function inspectCommand(
  options: InspectCliOptions = {},
  engine: GitGuardEngine = new DefaultGitGuardEngine()
): Promise<{ exitCode: number; output: string; result?: InspectResult }> {
  try {
    let scope: ChangeScope = (options.scope as ChangeScope) ?? 'all';
    if (options.scope === 'working') {
      scope = 'working-tree';
    } else if ((!options.scope || options.scope === 'all') && options.target) {
      scope = options.target.includes('..') ? 'range' : 'commit';
    }
    const inspectOpts: InspectOptions = {
      scope,
      target: options.target,
      cwd: options.cwd,
      task: options.task,
      checkDeterministic: options.checkDeterministic,
      configPath: options.config,
    };

    const result = await engine.inspect(inspectOpts);

    const isJson = options.json === true || options.format === 'json';
    const output = isJson
      ? JSON.stringify(result, null, 2)
      : formatInspectText(result, scope);

    if (!options.silent) {
      console.log(output);
    }

    return { exitCode: 0, output, result };
  } catch (err: any) {
    const errorMsg = `Error executing inspect: ${err.message || String(err)}`;
    if (!options.silent) {
      console.error(errorMsg);
    }
    const exitCode = err.exitCode ?? 1;
    return { exitCode, output: errorMsg };
  }
}
