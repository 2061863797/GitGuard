/**
 * src/interfaces/cli/findings.ts
 * Command handler for `gitguard findings`.
 */

import type { GitGuardEngine } from '../../types/engine.js';
import type {
  Finding,
  FindingFilter,
  FindingSeverity,
  FindingStatus,
  FindingLifecycleState,
} from '../../types/finding.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { FileFindingStore } from '../../findings/store.js';
import { formatFindingsText } from './formatters.js';

export interface FindingsCliOptions {
  status?: string;
  severity?: string;
  file?: string;
  rule?: string;
  lifecycle?: string;
  format?: string;
  json?: boolean;
  cwd?: string;
  silent?: boolean;
}

export async function findingsCommand(
  options: FindingsCliOptions = {},
  engine: GitGuardEngine = new DefaultGitGuardEngine()
): Promise<{ exitCode: number; output: string; findings: Finding[] }> {
  try {
    const filter: FindingFilter = {
      status: options.status?.toLowerCase() as FindingStatus,
      severity: options.severity?.toUpperCase() as FindingSeverity,
      file: options.file,
      ruleId: options.rule,
      lifecycle: options.lifecycle?.toLowerCase() as FindingLifecycleState,
    };

    let findings = engine.getFindings ? await engine.getFindings(filter) : [];
    if (findings.length === 0) {
      const store = new FileFindingStore(options.cwd ?? process.cwd());
      findings = await store.list(filter);
    }

    const isJson = options.json === true || options.format === 'json';
    const output = isJson
      ? JSON.stringify(findings, null, 2)
      : formatFindingsText(findings);

    if (!options.silent) {
      console.log(output);
    }

    return { exitCode: 0, output, findings };
  } catch (err: any) {
    const errorMsg = `Error retrieving findings: ${err.message || String(err)}`;
    if (!options.silent) {
      console.error(errorMsg);
    }
    const exitCode = err.exitCode ?? 1;
    return { exitCode, output: errorMsg, findings: [] };
  }
}
