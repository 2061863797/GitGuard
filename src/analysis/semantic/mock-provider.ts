/**
 * src/analysis/semantic/mock-provider.ts
 * DeterministicMockProvider implementing 100% offline, reproducible semantic heuristics.
 * Simulates TypeSafe System One evaluations with predictable, stable outputs.
 */

import type { EvaluationContext } from '../../types/context.js';
import type {
  DecisionProvider,
  SemanticQuestion,
  SemanticDecision,
} from '../../types/provider.js';

/**
 * Security-sensitive keywords for heuristic detection.
 */
const SECURITY_KEYWORDS = [
  'auth',
  'token',
  'secret',
  'password',
  'crypto',
  'permission',
  'jwt',
  'session',
  'oauth',
  'payment',
  'credit',
  'sanitize',
  'admin',
  'credential',
  'role',
  'policy',
];

/**
 * Breaking change keywords for heuristic detection.
 */
const BREAKING_KEYWORDS = [
  'breaking',
  'deprecated',
  'migration',
  'schema.prisma',
  'proto',
  'major',
];

/**
 * Debug print and artifact detection regex.
 */
const DEBUG_REGEX = /(console\.(log|debug|trace|info)|debugger;|print\(|var_dump|System\.out\.println)/i;

/**
 * Offline deterministic mock semantic evaluation provider.
 */
export class DeterministicMockProvider implements DecisionProvider {
  public readonly name: string = 'mock';

  /**
   * The offline mock provider is always available without network or credentials.
   */
  public async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Evaluates a batch of semantic questions against an EvaluationContext
   * using 100% deterministic, offline heuristics.
   */
  public async evaluate(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticDecision[]> {
    const decisions: SemanticDecision[] = [];

    for (const q of questions) {
      switch (q.id) {
        case 'task_completed':
          decisions.push(this.evaluateTaskCompleted(context));
          break;
        case 'task_scope_match':
          decisions.push(this.evaluateTaskScopeMatch(context));
          break;
        case 'unrelated_changes':
          decisions.push(this.evaluateUnrelatedChanges(context));
          break;
        case 'tests_required':
          decisions.push(this.evaluateTestsRequired(context));
          break;
        case 'tests_present':
          decisions.push(this.evaluateTestsPresent(context));
          break;
        case 'behavior_change':
          decisions.push(this.evaluateBehaviorChange(context));
          break;
        case 'security_sensitive_change':
          decisions.push(this.evaluateSecuritySensitive(context));
          break;
        case 'breaking_change':
          decisions.push(this.evaluateBreakingChange(context));
          break;
        case 'debug_leftovers':
          decisions.push(this.evaluateDebugLeftovers(context));
          break;
        case 'regression_risk':
          decisions.push(this.evaluateRegressionRisk(context));
          break;
        case 'change_type':
          decisions.push(this.evaluateChangeType(context));
          break;
        default:
          decisions.push(this.evaluateFallbackQuestion(q));
          break;
      }
    }

    return decisions;
  }

  /**
   * 1. Task Completion heuristic.
   */
  private evaluateTaskCompleted(context: EvaluationContext): SemanticDecision {
    if (!context.task || !context.task.task || context.task.task.trim() === '') {
      return {
        id: 'task_completed',
        probability: 1.0,
        confidence: 1.0,
        provider: 'mock',
        rationale: 'No task description provided; defaulted to fully completed',
      };
    }

    let keywords = (context.task.keywords || []).filter((k) => k.length > 2);
    if (keywords.length === 0) {
      const extracted = context.task.task.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      keywords = Array.from(new Set(extracted));
    }

    if (keywords.length === 0) {
      return {
        id: 'task_completed',
        probability: 0.9,
        confidence: 0.8,
        provider: 'mock',
        rationale: 'Task keywords empty; high completion assumed',
      };
    }

    const diffText = (context.diff?.raw || '').toLowerCase();
    const fileNames = (context.diff?.files || []).map((f) => f.newPath.toLowerCase()).join(' ');
    const searchCorpus = `${diffText} ${fileNames}`;

    const matches = keywords.filter((k) => searchCorpus.includes(k.toLowerCase())).length;
    const ratio = matches / keywords.length;

    let prob = 0.35;
    if (ratio >= 0.5) {
      prob = 0.94;
    } else if (ratio > 0.1) {
      prob = 0.78;
    }

    return {
      id: 'task_completed',
      probability: prob,
      confidence: 0.9,
      provider: 'mock',
      rationale: `Task keyword match ratio: ${(ratio * 100).toFixed(1)}% (${matches}/${keywords.length})`,
    };
  }

  /**
   * 2. Task Scope Match heuristic.
   */
  private evaluateTaskScopeMatch(context: EvaluationContext): SemanticDecision {
    const fileCount = context.diff?.files?.length ?? 0;
    const prob = fileCount <= 3 ? 0.95 : fileCount <= 8 ? 0.8 : 0.6;

    return {
      id: 'task_scope_match',
      probability: prob,
      confidence: 0.85,
      provider: 'mock',
      rationale: `Scope evaluated across ${fileCount} changed file(s)`,
    };
  }

  /**
   * 3. Unrelated Changes heuristic.
   */
  private evaluateUnrelatedChanges(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const rootDirs = new Set(
      files.map((f) => {
        const parts = f.newPath.split('/');
        return parts.length > 1 ? parts[0] : '.';
      })
    );

    const prob = rootDirs.size >= 3 ? 0.72 : rootDirs.size >= 2 ? 0.35 : 0.08;

    return {
      id: 'unrelated_changes',
      probability: prob,
      confidence: 0.85,
      provider: 'mock',
      rationale: `Changes touch ${rootDirs.size} distinct root directory path(s)`,
    };
  }

  /**
   * 4. Tests Required heuristic.
   */
  private evaluateTestsRequired(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const logicFiles = files.filter(
      (f) =>
        !f.newPath.endsWith('.md') &&
        !f.newPath.endsWith('.json') &&
        !f.newPath.endsWith('.yml') &&
        !f.newPath.endsWith('.yaml') &&
        !f.newPath.includes('.test.') &&
        !f.newPath.includes('.spec.')
    );

    if (logicFiles.length === 0) {
      return {
        id: 'tests_required',
        probability: 0.05,
        confidence: 0.95,
        provider: 'mock',
        rationale: 'Documentation or configuration alterations do not require automated tests',
      };
    }

    const totalLines = (context.diff?.insertions ?? 0) + (context.diff?.deletions ?? 0);
    const prob = totalLines > 15 ? 0.88 : 0.45;

    return {
      id: 'tests_required',
      probability: prob,
      confidence: 0.9,
      provider: 'mock',
      rationale: `Logic alterations of ${totalLines} line(s) across ${logicFiles.length} file(s)`,
    };
  }

  /**
   * 5. Tests Present heuristic.
   */
  private evaluateTestsPresent(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const testFiles = files.filter(
      (f) =>
        f.newPath.includes('.test.') ||
        f.newPath.includes('.spec.') ||
        f.newPath.startsWith('tests/') ||
        f.newPath.startsWith('__tests__/')
    );

    const prob = testFiles.length > 0 ? 0.92 : 0.1;

    return {
      id: 'tests_present',
      probability: prob,
      confidence: 0.95,
      provider: 'mock',
      rationale:
        testFiles.length > 0
          ? `Found ${testFiles.length} test file(s) in changeset`
          : 'No test file modifications in changeset',
    };
  }

  /**
   * 6. Behavior Change heuristic.
   */
  private evaluateBehaviorChange(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const isDocOnly =
      files.length > 0 &&
      files.every(
        (f) =>
          f.newPath.endsWith('.md') ||
          f.newPath.endsWith('.txt') ||
          f.newPath.includes('docs/')
      );

    if (isDocOnly) {
      return {
        id: 'behavior_change',
        probability: 0.05,
        confidence: 0.95,
        provider: 'mock',
        rationale: 'Pure documentation changes do not alter runtime behavior',
      };
    }

    const isTestOnly =
      files.length > 0 &&
      files.every(
        (f) =>
          f.newPath.includes('.test.') ||
          f.newPath.includes('.spec.') ||
          f.newPath.startsWith('tests/')
      );

    if (isTestOnly) {
      return {
        id: 'behavior_change',
        probability: 0.15,
        confidence: 0.9,
        provider: 'mock',
        rationale: 'Test modifications only',
      };
    }

    const totalLines = (context.diff?.insertions ?? 0) + (context.diff?.deletions ?? 0);
    const prob = totalLines > 5 ? 0.85 : 0.4;

    return {
      id: 'behavior_change',
      probability: prob,
      confidence: 0.88,
      provider: 'mock',
      rationale: `Code changes of ${totalLines} line(s) introduce runtime behavioral modifications`,
    };
  }

  /**
   * 7. Security Sensitive Change heuristic.
   */
  private evaluateSecuritySensitive(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const diffRaw = (context.diff?.raw || '').toLowerCase();

    const hasSecurityMatch = SECURITY_KEYWORDS.some(
      (kw) =>
        files.some((f) => f.newPath.toLowerCase().includes(kw)) ||
        diffRaw.includes(kw)
    );

    const prob = hasSecurityMatch ? 0.86 : 0.06;

    return {
      id: 'security_sensitive_change',
      probability: prob,
      confidence: 0.92,
      provider: 'mock',
      rationale: hasSecurityMatch
        ? 'Security-related keywords detected in changed file paths or diff body'
        : 'No security-sensitive keywords detected',
    };
  }

  /**
   * 8. Breaking Change heuristic.
   */
  private evaluateBreakingChange(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];
    const diffRaw = (context.diff?.raw || '').toLowerCase();

    const hasBreaking = BREAKING_KEYWORDS.some(
      (kw) =>
        files.some((f) => f.newPath.toLowerCase().includes(kw)) ||
        diffRaw.includes(kw)
    );

    const prob = hasBreaking ? 0.82 : 0.05;

    return {
      id: 'breaking_change',
      probability: prob,
      confidence: 0.88,
      provider: 'mock',
      rationale: hasBreaking
        ? 'Breaking change patterns or schema alterations detected'
        : 'No breaking change markers detected',
    };
  }

  /**
   * 9. Debug Leftovers heuristic.
   */
  private evaluateDebugLeftovers(context: EvaluationContext): SemanticDecision {
    let found = false;
    const files = context.diff?.files || [];

    for (const f of files) {
      if (!f.hunks) continue;
      for (const h of f.hunks) {
        if (!h.lines) continue;
        for (const line of h.lines) {
          if (
            line.startsWith('+') &&
            !line.startsWith('+++') &&
            DEBUG_REGEX.test(line)
          ) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    const prob = found ? 0.95 : 0.02;

    return {
      id: 'debug_leftovers',
      probability: prob,
      confidence: 0.98,
      provider: 'mock',
      rationale: found
        ? 'Found debugging statement (console log/print/debugger) in diff additions'
        : 'No leftover debugging artifacts detected',
    };
  }

  /**
   * 10. Regression Risk score heuristic.
   */
  private evaluateRegressionRisk(context: EvaluationContext): SemanticDecision {
    const totalLines = (context.diff?.insertions ?? 0) + (context.diff?.deletions ?? 0);

    let risk = 'low';
    let score = 0.3;

    if (totalLines < 20) {
      risk = 'negligible';
      score = 0.1;
    } else if (totalLines <= 100) {
      risk = 'low';
      score = 0.3;
    } else if (totalLines <= 400) {
      risk = 'medium';
      score = 0.6;
    } else {
      risk = 'high';
      score = 0.85;
    }

    return {
      id: 'regression_risk',
      value: risk,
      score,
      confidence: 0.9,
      provider: 'mock',
      rationale: `Regression risk calculated from ${totalLines} changed line(s) (${risk})`,
    };
  }

  /**
   * 11. Change Type choice classification heuristic.
   */
  private evaluateChangeType(context: EvaluationContext): SemanticDecision {
    const files = context.diff?.files || [];

    if (files.length > 0 && files.every((f) => f.newPath.endsWith('.md'))) {
      return {
        id: 'change_type',
        value: 'documentation',
        confidence: 0.98,
        provider: 'mock',
        rationale: 'All modified files are documentation',
      };
    }

    if (
      files.length > 0 &&
      files.every((f) => f.newPath.includes('.test.') || f.newPath.includes('.spec.'))
    ) {
      return {
        id: 'change_type',
        value: 'test',
        confidence: 0.98,
        provider: 'mock',
        rationale: 'All modified files are test suites',
      };
    }

    const taskText = (context.task?.task || '').toLowerCase();
    let val = 'feature';

    if (taskText.includes('fix') || taskText.includes('bug') || taskText.includes('issue')) {
      val = 'bug_fix';
    } else if (taskText.includes('refactor') || taskText.includes('clean')) {
      val = 'refactor';
    } else if (
      taskText.includes('auth') ||
      taskText.includes('security') ||
      taskText.includes('token')
    ) {
      val = 'security';
    }

    return {
      id: 'change_type',
      value: val,
      confidence: 0.85,
      provider: 'mock',
      rationale: `Inferred change type: ${val}`,
    };
  }

  /**
   * Fallback evaluation for custom or unknown question IDs.
   */
  private evaluateFallbackQuestion(q: SemanticQuestion): SemanticDecision {
    if (q.type === 'score') {
      return {
        id: q.id,
        score: 0.5,
        confidence: 0.5,
        provider: 'mock',
        rationale: 'Custom score question offline fallback',
      };
    }

    if (q.type === 'choice') {
      const firstChoice = q.choices?.[0];
      const val = typeof firstChoice === 'string' ? firstChoice : firstChoice?.value || 'default';
      return {
        id: q.id,
        value: val,
        confidence: 0.5,
        provider: 'mock',
        rationale: 'Custom choice question offline fallback',
      };
    }

    return {
      id: q.id,
      probability: 0.5,
      confidence: 0.5,
      provider: 'mock',
      rationale: 'Custom boolean question offline fallback',
    };
  }
}
