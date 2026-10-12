/**
 * src/policy/rules.ts
 * Condition evaluators and gate verdict synthesizers.
 * Supports deterministic checks and yes/no semantic questions with a fixed 0.5 threshold.
 */

import type {
  GateVerdict,
  QuestionLevel,
  QuestionSpec,
  RuleMatch,
  PolicyConfig,
} from '../types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../types/provider.js';
import type { Finding, FindingSeverity, FindingStatus, Evidence } from '../types/finding.js';
import type { EvaluationContext } from '../types/context.js';
import { normalizeAffectedFiles } from '../findings/fingerprint.js';

/**
 * Gate verdict hierarchy ordering:
 * BLOCK (highest) > REVIEW > WARN > PASS (lowest).
 */
export const VERDICT_ORDER: Record<GateVerdict, number> = {
  BLOCK: 4,
  REVIEW: 3,
  WARN: 2,
  PASS: 1,
};

/**
 * Synthesizes an overall GateVerdict from any collection of items with status/verdict.
 * Adheres strictly to the worst-case hierarchy: BLOCK > REVIEW > WARN > PASS.
 */
export function synthesizeGateVerdict(
  items: Array<RuleMatch | Finding | FindingStatus | GateVerdict | string>
): GateVerdict {
  if (!items || items.length === 0) {
    return 'PASS';
  }

  let hasWarn = false;
  let hasReview = false;
  let hasBlock = false;

  for (const item of items) {
    let statusStr = '';
    if (typeof item === 'string') {
      statusStr = item.toLowerCase();
    } else if (item && typeof item === 'object') {
      if ('status' in item && item.status) {
        statusStr = String(item.status).toLowerCase();
      } else if ('verdict' in item && (item as any).verdict) {
        statusStr = String((item as any).verdict).toLowerCase();
      }
    }

    if (statusStr === 'block') {
      hasBlock = true;
    } else if (statusStr === 'review') {
      hasReview = true;
    } else if (statusStr === 'warn') {
      hasWarn = true;
    }
  }

  if (hasBlock) return 'BLOCK';
  if (hasReview) return 'REVIEW';
  if (hasWarn) return 'WARN';
  return 'PASS';
}

/**
 * Converts a simple file glob pattern (*, **) into a RegExp.
 */
export function globToRegExp(glob: string): RegExp {
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
 * Checks whether a relative file path matches a glob pattern.
 */
export function matchesGlob(filePath: string, globPattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = normalizedPath.split('/').pop() || normalizedPath;
  const regex = globToRegExp(globPattern);

  return regex.test(normalizedPath) || regex.test(basename);
}

/**
 * Filters a list of file paths by include and exclude glob patterns.
 */
export function filterMatchingFiles(
  files: string[],
  includeGlobs: string[],
  excludeGlobs?: string[]
): string[] {
  if (!includeGlobs || includeGlobs.length === 0) {
    return [];
  }

  const normalizedFiles = normalizeAffectedFiles(files);
  const matched: string[] = [];

  for (const file of normalizedFiles) {
    const isIncluded = includeGlobs.some((pattern) => matchesGlob(file, pattern));
    if (!isIncluded) continue;

    const isExcluded = excludeGlobs && excludeGlobs.some((pattern) => matchesGlob(file, pattern));
    if (isExcluded) continue;

    matched.push(file);
  }

  return matched;
}

/**
 * Probability at or above which a question counts as answered "yes".
 */
export const QUESTION_YES_THRESHOLD = 0.5;

const LEVEL_SEVERITY: Record<QuestionLevel, FindingSeverity> = {
  warn: 'WARN',
  review: 'ERROR',
  block: 'CRITICAL',
};

/**
 * Returns the changed files a question applies to, or null when its file filter matches nothing.
 * Questions without `files` apply to every changed file.
 */
export function questionAppliesTo(question: QuestionSpec, changedFiles: string[]): string[] | null {
  if (!question.files || question.files.length === 0) {
    const normalized = normalizeAffectedFiles(changedFiles);
    const remaining = question.exclude?.length
      ? normalized.filter((file) => !question.exclude!.some((pattern) => matchesGlob(file, pattern)))
      : normalized;
    return remaining.length > 0 ? remaining : null;
  }
  const matched = filterMatchingFiles(changedFiles, question.files, question.exclude);
  return matched.length > 0 ? matched : null;
}

/**
 * Evaluates a single deterministic check result against policy configuration.
 */
export function evaluateDeterministicCheck(
  result: DeterministicResult,
  policy: PolicyConfig,
  context: EvaluationContext
): RuleMatch | null {
  const checkId = result.id;
  const changedFiles = (context.diff?.files || []).map((f) => f.newPath || f.oldPath || '');

  // 1. Secret scanning evaluation
  if (checkId === 'secret_scan') {
    const secretConfig = policy.deterministic?.secret_scan;
    if (secretConfig && secretConfig.enabled === false) {
      return null;
    }

    const hasViolations =
      result.status === 'failed' || (result.violations && result.violations.length > 0);

    if (hasViolations) {
      const blockOnDetection = secretConfig?.block_on_detection !== false;
      const status: FindingStatus = blockOnDetection ? 'block' : 'review';
      const severity: FindingSeverity = blockOnDetection ? 'CRITICAL' : 'ERROR';

      const evidenceList: Evidence[] = [];
      const affectedFilesSet = new Set<string>();

      if (result.violations && result.violations.length > 0) {
        for (const v of result.violations) {
          if (v.file) affectedFilesSet.add(v.file);
          evidenceList.push({
            type: 'secret_detected',
            path: v.file,
            lines: v.line !== undefined ? String(v.line) : undefined,
            ruleName: v.rule || 'secret_scan',
            message: v.message,
          });
        }
      } else {
        evidenceList.push({
          type: 'secret_detected',
          command: 'secret_scan',
          status: result.status,
          message: result.summary || 'Sensitive secret or credential detected in changeset diff',
        });
      }

      const affectedFiles =
        affectedFilesSet.size > 0
          ? Array.from(affectedFilesSet)
          : changedFiles.slice(0, 5);

      return {
        ruleId: 'deterministic.secret_scan',
        source: 'deterministic',
        status,
        severity,
        message:
          result.summary ||
          `Diff secret scanner detected ${evidenceList.length} secret(s) or exposed credential(s)`,
        affectedFiles,
        evidence: evidenceList,
        expectedEvidence: [
          'Remove hardcoded credentials, secret keys, or tokens from changeset diff.',
          'Store credentials in secure environment variables or vault systems.',
          'Rotate any secrets that were staged or committed.',
        ],
      };
    }

    return null;
  }

  // 2. Subprocess execution checks (test, lint, typecheck)
  const detConfig = policy.deterministic as Record<string, any> | undefined;
  const singleConfig = detConfig ? detConfig[checkId] : undefined;

  if (singleConfig && singleConfig.enabled === false) {
    return null;
  }

  const isFailed =
    result.status === 'failed' ||
    (result.exitCode !== undefined && result.exitCode !== 0);

  if (isFailed) {
    const blockOnFailure = singleConfig?.block_on_failure !== false;
    const status: FindingStatus = blockOnFailure ? 'block' : 'review';
    const severity: FindingSeverity = blockOnFailure ? 'CRITICAL' : 'ERROR';
    const effectiveCmd = singleConfig?.run || (result as any).command || checkId;

    const evidenceList: Evidence[] = [];
    const affectedFilesSet = new Set<string>();

    if (result.violations && result.violations.length > 0) {
      for (const v of result.violations) {
        if (v.file) affectedFilesSet.add(v.file);
        evidenceList.push({
          type: checkId === 'lint' ? 'lint_error' : 'test_result',
          path: v.file,
          lines: v.line !== undefined ? String(v.line) : undefined,
          command: effectiveCmd,
          exitCode: result.exitCode,
          message: v.message,
        });
      }
    } else {
      evidenceList.push({
        type: checkId === 'lint' ? 'lint_error' : 'test_result',
        command: effectiveCmd,
        status: result.status,
        exitCode: result.exitCode,
        message: result.stderr || result.stdout || result.summary || `Deterministic check '${checkId}' failed`,
        snippet: (result.stderr || result.stdout || '').slice(0, 1000),
      });
    }

    const affectedFiles =
      affectedFilesSet.size > 0
        ? Array.from(affectedFilesSet)
        : changedFiles;

    const summaryText =
      result.summary ||
      `Deterministic check '${effectiveCmd}' failed with exit code ${result.exitCode ?? 1}`;

    const expectedEvidence =
      checkId === 'test'
        ? [
            'Fix all failing tests reported in test runner execution.',
            `Ensure '${effectiveCmd}' completes with exit code 0.`,
          ]
        : checkId === 'lint'
        ? [
            'Fix all lint errors and formatting violations.',
            `Ensure '${effectiveCmd}' exits cleanly with code 0.`,
          ]
        : [
            'Resolve all compiler errors and type mismatches.',
            `Ensure '${effectiveCmd}' exits cleanly with code 0.`,
          ];

    return {
      ruleId: `deterministic.${checkId}`,
      source: 'deterministic',
      status,
      severity,
      message: summaryText,
      affectedFiles,
      evidence: evidenceList,
      expectedEvidence,
    };
  }

  return null;
}

/**
 * Evaluates System One's answer to a yes/no question. "Yes" (probability >= 0.5) yields the question's level.
 */
export function evaluateQuestion(
  decision: SemanticDecision,
  question: QuestionSpec,
  affectedFiles: string[]
): RuleMatch | null {
  if (decision.probability < QUESTION_YES_THRESHOLD) {
    return null;
  }

  const evidence: Evidence[] = [
    {
      type: 'semantic_answer',
      ruleName: question.id,
      message: decision.rationale || `System One answered yes to: ${question.question}`,
      details: {
        question: question.question,
        source: question.source,
        probability: decision.probability,
        confidence: decision.confidence,
        provider: decision.provider,
      },
    },
  ];

  return {
    ruleId: question.id,
    source: 'semantic',
    status: question.level,
    severity: LEVEL_SEVERITY[question.level],
    message: decision.rationale
      ? `${question.question} — ${decision.rationale}`
      : `${question.question} (yes, p=${decision.probability.toFixed(2)})`,
    probability: decision.probability,
    affectedFiles,
    evidence,
    expectedEvidence: [
      `Change the code so the answer to "${question.question}" becomes no, then run verify with this finding ID.`,
    ],
    question,
  };
}
