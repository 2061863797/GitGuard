/**
 * src/interfaces/cli/formatters.ts
 * Terminal output formatters for GitGuard CLI commands (inspect, check, findings, verify).
 * Supports clean structured text formatting and JSON output.
 */

import type { InspectResult, CheckResult } from '../../types/engine.js';
import type { Finding, VerificationReport } from '../../types/finding.js';

/**
 * Formats inspect result as human-friendly terminal text.
 */
export function formatInspectText(result: InspectResult, scope: string = 'all'): string {
  const lines: string[] = [];

  lines.push('GitGuard Inspect Summary');
  lines.push(`Scope: ${scope} | Files: ${result.changedFiles.length}`);
  lines.push(
    `Diff Stat: +${result.summary.insertions || 0} / -${result.summary.deletions || 0} lines`
  );
  lines.push('');

  if (result.changedFiles.length === 0) {
    lines.push('No changed files detected in current scope.');
  } else {
    lines.push('Files:');
    for (const f of result.changedFiles) {
      const statusSymbol =
        f.status === 'added'
          ? '[A]'
          : f.status === 'deleted'
          ? '[D]'
          : f.status === 'renamed'
          ? '[R]'
          : '[M]';
      const pathStr = f.path || f.oldPath || 'unknown';
      const stats = `(+${f.additions || 0}/-${f.deletions || 0})`;
      lines.push(`  ${statusSymbol} ${pathStr} ${stats}`);
    }
  }

  lines.push('');
  lines.push(`Status: ${result.status}`);

  if (result.findings && result.findings.length > 0) {
    lines.push('');
    lines.push(`Active Findings: ${result.findings.length}`);
    for (const f of result.findings) {
      lines.push(`  [${f.status.toUpperCase()}] ${f.id} (${f.ruleId}): ${f.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats check result as human-friendly terminal text.
 */
export function formatCheckText(result: CheckResult): string {
  const lines: string[] = [];
  const bar = '='.repeat(60);

  lines.push(bar);
  lines.push(`GitGuard Quality Gate: ${result.status}`);
  lines.push(bar);

  if (result.task && result.task.task) {
    lines.push(`Task: ${result.task.task}`);
  }

  lines.push(
    `Diff: ${result.diffSummary.filesChanged} file(s), +${result.diffSummary.insertions} / -${result.diffSummary.deletions} lines`
  );
  lines.push('');

  // 1. Deterministic Checks
  if (result.deterministicResults && result.deterministicResults.length > 0) {
    lines.push('[Deterministic Checks]');
    for (const res of result.deterministicResults) {
      const icon = res.status === 'passed' ? '✓' : res.status === 'failed' ? '✗' : '○';
      const statusStr = res.status.toUpperCase();
      const dur = res.durationMs > 0 ? ` (${res.durationMs}ms)` : '';
      lines.push(`  ${icon} ${res.id.padEnd(12)}: ${statusStr}${dur}`);
      if (res.violations && res.violations.length > 0) {
        for (const v of res.violations) {
          const loc = v.file ? ` [${v.file}${v.line ? `:${v.line}` : ''}]` : '';
          lines.push(`      - ${v.message}${loc}`);
        }
      }
    }
    lines.push('');
  }

  // 2. Semantic Signals
  const decisions = Object.values(result.semanticDecisions || {});
  if (decisions.length > 0) {
    lines.push('[Semantic Signals]');
    for (const d of decisions) {
      let scoreStr = '';
      if (d.probability !== undefined) {
        scoreStr = `${d.probability.toFixed(2)}`;
      } else if (d.score !== undefined) {
        scoreStr = `score: ${d.score}`;
      } else if (d.value !== undefined) {
        scoreStr = `choice: ${d.value}`;
      }
      lines.push(`  • ${d.id.padEnd(24)}: ${scoreStr}`);
    }
    lines.push('');
  }

  // 3. Active Findings
  if (result.findings && result.findings.length > 0) {
    lines.push(`[Active Findings] (${result.findings.length})`);
    for (const f of result.findings) {
      lines.push(`  [${f.status.toUpperCase()}] ${f.id} (${f.ruleId}): ${f.message}`);
      if (f.affectedFiles && f.affectedFiles.length > 0) {
        lines.push(`    Files: ${f.affectedFiles.join(', ')}`);
      }
      if (f.expectedEvidence && f.expectedEvidence.length > 0) {
        lines.push(`    Expected: ${f.expectedEvidence[0]}`);
      }
      lines.push(`    Fingerprint: ${f.fingerprint}`);
    }
    lines.push('');
  }

  lines.push(`Gate Verdict: ${result.status} (${result.verdictSummary})`);
  lines.push(bar);

  return lines.join('\n');
}

/**
 * Formats findings list as human-friendly terminal text.
 */
export function formatFindingsText(findings: Finding[]): string {
  const lines: string[] = [];

  lines.push(`GitGuard Active Findings (${findings.length})`);
  lines.push('-'.repeat(60));

  if (findings.length === 0) {
    lines.push('No active findings found.');
    return lines.join('\n');
  }

  for (const f of findings) {
    lines.push(
      `[${f.status.toUpperCase()}] ${f.id} (${f.ruleId}) - Severity: ${f.severity}`
    );
    lines.push(`  Message: ${f.message}`);
    if (f.affectedFiles && f.affectedFiles.length > 0) {
      lines.push(`  Affected Files: ${f.affectedFiles.join(', ')}`);
    }
    if (f.expectedEvidence && f.expectedEvidence.length > 0) {
      lines.push(`  Expected Evidence:`);
      for (const ev of f.expectedEvidence) {
        lines.push(`    - ${ev}`);
      }
    }
    lines.push(`  Fingerprint: ${f.fingerprint}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Formats verification report as human-friendly terminal text.
 */
export function formatVerifyText(report: VerificationReport): string {
  const lines: string[] = [];
  const bar = '='.repeat(60);

  lines.push(bar);
  lines.push(`GitGuard Verification Loop: ${report.status}`);
  lines.push(bar);

  lines.push(`Summary: ${report.verdictSummary}`);
  lines.push('');

  const resolved = report.resolved || report.resolvedFindings || [];
  lines.push(`Resolved Findings (${resolved.length}):`);
  if (resolved.length === 0) {
    lines.push('  (none)');
  } else {
    for (const id of resolved) {
      lines.push(`  ✓ ${id}`);
    }
  }

  lines.push('');
  const remaining = report.remaining || report.remainingFindings || [];
  lines.push(`Remaining Active Findings (${remaining.length}):`);
  if (remaining.length === 0) {
    lines.push('  (none)');
  } else {
    for (const id of remaining) {
      const f = (report.findings || []).find((x) => x.id === id);
      const msg = f ? ` - ${f.message}` : '';
      lines.push(`  ✗ ${id}${msg}`);
    }
  }

  if (report.unknownFindings && report.unknownFindings.length > 0) {
    lines.push('');
    lines.push(`Unknown Findings (${report.unknownFindings.length}):`);
    for (const id of report.unknownFindings) {
      lines.push(`  ? ${id} (not found in finding store or history)`);
    }
  }

  lines.push(bar);
  return lines.join('\n');
}
