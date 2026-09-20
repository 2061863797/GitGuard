/**
 * src/policy/rules.ts
 * Standard policy rule definitions, condition evaluators, and gate verdict synthesizers.
 * Supports deterministic checks, standard System One semantic rules, custom repository rules,
 * standard thresholds, and inverted thresholds (review_below / block_below).
 */

import type {
  GateVerdict,
  PolicyRule,
  CustomPolicyRule,
  ThresholdConfig,
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
 * Canonical default standard rules configuration.
 */
export const DEFAULT_BUILTIN_RULES: Record<string, PolicyRule> = {
  task_completed: {
    id: 'task_completed',
    enabled: true,
    description: 'Task requirement fulfillment evaluator',
    thresholds: {
      review_below: 0.6,
      block_below: 0.2,
    },
  },
  unrelated_changes: {
    id: 'unrelated_changes',
    enabled: true,
    description: 'Unrelated and extraneous changes evaluator',
    thresholds: {
      warn: 0.55,
      review: 0.75,
      block: 0.95,
    },
  },
  tests_required: {
    id: 'tests_required',
    enabled: true,
    description: 'Automated regression tests requirement evaluator',
    thresholds: {
      warn: 0.6,
      review: 0.8,
    },
  },
  security_sensitive: {
    id: 'security_sensitive',
    enabled: true,
    description: 'Security-sensitive code modification evaluator',
    thresholds: {
      review: 0.65,
      block: 0.9,
    },
  },
  regression_risk: {
    id: 'regression_risk',
    enabled: true,
    description: 'Regression risk and blast radius evaluator',
    thresholds: {
      warn_on: ['medium'],
      review_on: ['high'],
      block_on: ['critical'],
    },
  },
};

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

export interface ThresholdEvaluationResult {
  triggered: boolean;
  status?: FindingStatus;
  severity?: FindingSeverity;
  message?: string;
}

/**
 * Evaluates a numerical probability against standard and inverted thresholds.
 */
export function evaluateNumericalThreshold(
  probability: number,
  thresholds: ThresholdConfig
): ThresholdEvaluationResult {
  // 1. Inverted thresholds: lower probability indicates failure (e.g. task_completed)
  if (thresholds.block_below !== undefined && probability < thresholds.block_below) {
    return {
      triggered: true,
      status: 'block',
      severity: 'CRITICAL',
      message: `Probability ${probability.toFixed(2)} is below critical block threshold of ${thresholds.block_below.toFixed(2)}`,
    };
  }

  if (thresholds.review_below !== undefined && probability < thresholds.review_below) {
    return {
      triggered: true,
      status: 'review',
      severity: 'ERROR',
      message: `Probability ${probability.toFixed(2)} is below review threshold of ${thresholds.review_below.toFixed(2)}`,
    };
  }

  // 2. Standard thresholds: higher probability indicates risk/violation
  if (thresholds.block !== undefined && probability >= thresholds.block) {
    return {
      triggered: true,
      status: 'block',
      severity: 'CRITICAL',
      message: `Probability ${probability.toFixed(2)} met or exceeded block threshold of ${thresholds.block.toFixed(2)}`,
    };
  }

  if (thresholds.review !== undefined && probability >= thresholds.review) {
    return {
      triggered: true,
      status: 'review',
      severity: 'ERROR',
      message: `Probability ${probability.toFixed(2)} met or exceeded review threshold of ${thresholds.review.toFixed(2)}`,
    };
  }

  if (thresholds.warn !== undefined && probability >= thresholds.warn) {
    return {
      triggered: true,
      status: 'warn',
      severity: 'WARN',
      message: `Probability ${probability.toFixed(2)} met or exceeded warn threshold of ${thresholds.warn.toFixed(2)}`,
    };
  }

  return { triggered: false };
}

/**
 * Evaluates a categorical value or numeric score against score thresholds.
 */
export function evaluateScoreThreshold(
  valueOrScore: string | number,
  thresholds: ThresholdConfig
): ThresholdEvaluationResult {
  if (typeof valueOrScore === 'string') {
    const val = valueOrScore.trim().toLowerCase();

    if (thresholds.block_on && thresholds.block_on.map((s) => s.toLowerCase()).includes(val)) {
      return {
        triggered: true,
        status: 'block',
        severity: 'CRITICAL',
        message: `Score level '${valueOrScore}' matches block level [${thresholds.block_on.join(', ')}]`,
      };
    }

    if (thresholds.review_on && thresholds.review_on.map((s) => s.toLowerCase()).includes(val)) {
      return {
        triggered: true,
        status: 'review',
        severity: 'ERROR',
        message: `Score level '${valueOrScore}' matches review level [${thresholds.review_on.join(', ')}]`,
      };
    }

    if (thresholds.warn_on && thresholds.warn_on.map((s) => s.toLowerCase()).includes(val)) {
      return {
        triggered: true,
        status: 'warn',
        severity: 'WARN',
        message: `Score level '${valueOrScore}' matches warn level [${thresholds.warn_on.join(', ')}]`,
      };
    }

    return { triggered: false };
  }

  if (typeof valueOrScore === 'number') {
    // If numeric score supplied, evaluate against numerical thresholds if present
    const numericResult = evaluateNumericalThreshold(valueOrScore, thresholds);
    if (numericResult.triggered) return numericResult;

    // Normalize raw score expectations (e.g. 0..4 index score where 1.05 represents low)
    const norm = valueOrScore > 1.0 ? Math.min(1.0, valueOrScore / 4.0) : valueOrScore;

    // Map normalized numeric score to conventional levels if categorical lists exist
    let level = 'low';
    if (norm >= 0.9) level = 'critical';
    else if (norm >= 0.7) level = 'high';
    else if (norm >= 0.4) level = 'medium';
    else if (norm >= 0.2) level = 'low';
    else level = 'negligible';

    return evaluateScoreThreshold(level, thresholds);
  }

  return { triggered: false };
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
 * Resolves effective thresholds for a standard built-in rule by merging user overrides.
 */
export function getEffectiveBuiltinRule(
  ruleId: string,
  policy: PolicyConfig
): PolicyRule | null {
  const defaultDef = DEFAULT_BUILTIN_RULES[ruleId];
  if (!defaultDef) {
    return null;
  }

  const userRuleConfig = policy.rules
    ? (policy.rules as Record<string, any>)[ruleId]
    : undefined;

  if (userRuleConfig && userRuleConfig.enabled === false) {
    return null;
  }

  const mergedThresholds: ThresholdConfig = {
    ...defaultDef.thresholds,
    ...(userRuleConfig || {}),
  };

  return {
    ...defaultDef,
    enabled: true,
    thresholds: mergedThresholds,
  };
}

/**
 * Evaluates a semantic decision against a policy rule.
 */
export function evaluateSemanticRuleMatch(
  decision: SemanticDecision,
  rule: PolicyRule | CustomPolicyRule,
  context: EvaluationContext,
  matchedFiles?: string[]
): RuleMatch | null {
  if (rule.enabled === false) {
    return null;
  }

  const thresholds: ThresholdConfig =
    'thresholds' in rule && rule.thresholds
      ? rule.thresholds
      : {
          warn: (rule as CustomPolicyRule).warn,
          review: (rule as CustomPolicyRule).review,
          block: (rule as CustomPolicyRule).block,
          warn_on: (rule as CustomPolicyRule).warn_on,
          review_on: (rule as CustomPolicyRule).review_on,
          block_on: (rule as CustomPolicyRule).block_on,
          review_below: (rule as CustomPolicyRule).review_below,
          block_below: (rule as CustomPolicyRule).block_below,
        };

  let evalResult: ThresholdEvaluationResult = { triggered: false };

  // 1. If probability is provided (noul / boolean)
  if (decision.probability !== undefined) {
    evalResult = evaluateNumericalThreshold(decision.probability, thresholds);
  } else if (decision.value !== undefined || decision.score !== undefined) {
    // 2. If categorical value or numeric score is provided
    const val = decision.value ?? decision.score!;
    evalResult = evaluateScoreThreshold(val, thresholds);
  }

  if (!evalResult.triggered || !evalResult.status || !evalResult.severity) {
    return null;
  }

  const affectedFiles =
    matchedFiles && matchedFiles.length > 0
      ? matchedFiles
      : (context.diff?.files || []).map((f) => f.newPath || f.oldPath || '');

  const evidence: Evidence[] = [
    {
      type: 'behavior_change',
      ruleName: rule.id,
      message: decision.rationale || evalResult.message || `Semantic evaluation of '${rule.id}' triggered ${evalResult.status.toUpperCase()}`,
      details: {
        probability: decision.probability,
        value: decision.value,
        score: decision.score,
        confidence: decision.confidence,
        provider: decision.provider,
      },
    },
  ];

  return {
    ruleId: rule.id,
    source: 'semantic',
    status: evalResult.status,
    severity: evalResult.severity,
    message:
      decision.rationale ||
      `${rule.description || rule.id}: ${evalResult.message || 'threshold triggered'}`,
    probability: decision.probability,
    score: decision.value ?? decision.score,
    affectedFiles,
    evidence,
    expectedEvidence: [],
    rule,
  };
}
