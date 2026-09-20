/**
 * src/core/engine.ts
 * DefaultGitGuardEngine implementing the central GitGuardEngine contract.
 * Coordinates Git context, deterministic status checkers, System One semantic evaluators,
 * policy engine rules, and structured finding lifecycle management.
 */

import type {
  GitGuardEngine,
  InspectOptions,
  InspectResult,
  CheckOptions,
  CheckResult,
  VerifyOptions,
} from '../types/engine.js';
import type { Finding, FindingFilter, VerificationReport } from '../types/finding.js';
import type { PolicyConfig, DeterministicPolicyConfig, GateVerdict } from '../types/policy.js';
import type {
  DecisionProvider,
  DeterministicConfig,
  DeterministicResult,
  SemanticDecision,
  SemanticQuestion,
} from '../types/provider.js';
import type { GitAdapter, ChangeScope, DiffOptions } from '../types/git.js';
import type { DiffSummary } from '../types/diff.js';
import type { ContextBuilder, EvaluationContext } from '../types/context.js';
import type { PolicyEngine } from '../types/policy.js';
import type { FindingManager } from '../types/finding.js';
import { GitCLIAdapter } from '../git/adapter.js';
import { parseDiff } from '../git/diff-parser.js';
import { DefaultContextBuilder } from '../context/builder.js';
import { DeterministicRunner } from '../analysis/deterministic/runner.js';
import { DeterministicMockProvider } from '../analysis/semantic/mock-provider.js';
import { TypeSafeSystemOneProvider } from '../analysis/semantic/typesafe-provider.js';
import { STANDARD_QUESTIONS_MAP } from '../analysis/semantic/questions.js';
import { DefaultPolicyEngine } from '../policy/engine.js';
import { DefaultFindingManager } from '../findings/manager.js';
import { loadConfig } from '../policy/config.js';
import { NotAGitRepositoryError } from '../types/errors.js';

/**
 * Dependency injection options for DefaultGitGuardEngine.
 */
export interface GitGuardEngineDependencies {
  gitAdapter?: GitAdapter;
  contextBuilder?: ContextBuilder;
  deterministicRunner?: DeterministicRunner;
  mockProvider?: DecisionProvider;
  typesafeProvider?: DecisionProvider;
  policyEngine?: PolicyEngine;
  findingManager?: FindingManager;
}

/**
 * Converts .gitguard.yml deterministic policy config to DeterministicRunner configuration.
 */
export function toDeterministicRunnerConfig(
  policyDeterministic?: DeterministicPolicyConfig
): DeterministicConfig {
  const cfg: DeterministicConfig = {
    commands: {},
    checks: {},
  };

  if (!policyDeterministic) {
    return cfg;
  }

  if (policyDeterministic.test) {
    cfg.checks!.test = {
      enabled: policyDeterministic.test.enabled,
      command: policyDeterministic.test.run,
      timeoutMs: policyDeterministic.test.timeout_ms,
    };
    if (policyDeterministic.test.run) {
      cfg.commands!.test = {
        run: policyDeterministic.test.run,
        timeoutMs: policyDeterministic.test.timeout_ms,
      };
    }
  }

  if (policyDeterministic.lint) {
    cfg.checks!.lint = {
      enabled: policyDeterministic.lint.enabled,
      command: policyDeterministic.lint.run,
      timeoutMs: policyDeterministic.lint.timeout_ms,
    };
    if (policyDeterministic.lint.run) {
      cfg.commands!.lint = {
        run: policyDeterministic.lint.run,
        timeoutMs: policyDeterministic.lint.timeout_ms,
      };
    }
  }

  if (policyDeterministic.typecheck) {
    cfg.checks!.typecheck = {
      enabled: policyDeterministic.typecheck.enabled,
      command: policyDeterministic.typecheck.run,
      timeoutMs: policyDeterministic.typecheck.timeout_ms,
    };
    if (policyDeterministic.typecheck.run) {
      cfg.commands!.typecheck = {
        run: policyDeterministic.typecheck.run,
        timeoutMs: policyDeterministic.typecheck.timeout_ms,
      };
    }
  }

  if (policyDeterministic.secret_scan) {
    cfg.checks!.secret_scan = {
      enabled: policyDeterministic.secret_scan.enabled,
    };
  }

  return cfg;
}

/**
 * Helper to construct DiffOptions from target string and cwd.
 */
function buildDiffOptions(target?: string, cwd?: string): DiffOptions {
  const opts: DiffOptions = { cwd };
  if (!target) return opts;

  if (target.includes('...')) {
    const [base, head] = target.split('...');
    opts.baseRef = base;
    opts.headRef = head;
  } else if (target.includes('..')) {
    const [base, head] = target.split('..');
    opts.baseRef = base;
    opts.headRef = head;
  } else {
    opts.commitSha = target;
  }
  return opts;
}

/**
 * Central GitGuard Verification Engine implementation.
 */
export class DefaultGitGuardEngine implements GitGuardEngine {
  public readonly gitAdapter: GitAdapter;
  public readonly contextBuilder: ContextBuilder;
  public readonly deterministicRunner: DeterministicRunner;
  public readonly mockProvider: DecisionProvider;
  public readonly typesafeProvider: DecisionProvider;
  public readonly policyEngine: PolicyEngine;
  public readonly findingManager: FindingManager;

  constructor(deps?: GitGuardEngineDependencies) {
    this.gitAdapter = deps?.gitAdapter ?? new GitCLIAdapter();
    this.contextBuilder = deps?.contextBuilder ?? new DefaultContextBuilder(this.gitAdapter);
    this.deterministicRunner = deps?.deterministicRunner ?? new DeterministicRunner();
    this.mockProvider = deps?.mockProvider ?? new DeterministicMockProvider();
    this.typesafeProvider = deps?.typesafeProvider ?? new TypeSafeSystemOneProvider();
    this.findingManager = deps?.findingManager ?? new DefaultFindingManager();
    this.policyEngine = deps?.policyEngine ?? new DefaultPolicyEngine(this.findingManager);
  }

  /**
   * Resolves effective PolicyConfig using programmatic override, path, or zero-config defaults.
   */
  private async resolveConfig(
    cwd: string,
    optionsConfig?: PolicyConfig,
    configPath?: string
  ): Promise<PolicyConfig> {
    if (optionsConfig) {
      return optionsConfig;
    }
    return await loadConfig(configPath, cwd);
  }

  /**
   * Rapidly inspects repository changes without executing full semantic evaluation suites.
   */
  public async inspect(options: InspectOptions = {}): Promise<InspectResult> {
    const cwd = options.cwd ?? process.cwd();

    const isGit = await this.gitAdapter.isGitRepository(cwd);
    if (!isGit) {
      throw new NotAGitRepositoryError(cwd);
    }

    const config = await this.resolveConfig(cwd, options.config, options.configPath);
    const scope = options.scope ?? 'all';
    const diffOpts = buildDiffOptions(options.target, cwd);

    const rawDiff = await this.gitAdapter.getDiff(scope, diffOpts);
    const parsedDiff = parseDiff(rawDiff);
    const changedFiles = await this.gitAdapter.getChangedFiles(scope, diffOpts);

    const maxDiffChars = config.context?.max_diff_chars ?? 50000;
    const isTruncated = parsedDiff.truncated || rawDiff.length > maxDiffChars;

    const summary: DiffSummary = {
      filesChanged: changedFiles.length,
      insertions: parsedDiff.insertions,
      deletions: parsedDiff.deletions,
      hasBinaryChanges: changedFiles.some((f) => f.binary),
      truncated: isTruncated,
    };

    let hasDeterministicFailures = false;
    let findings: Finding[] = [];
    let status: GateVerdict = 'PASS';

    // Preliminary deterministic check if requested
    if (options.checkDeterministic) {
      const taskStr =
        typeof options.task === 'string'
          ? options.task
          : options.task?.task;

      const context = await this.contextBuilder.buildContext({
        scope,
        diffOptions: diffOpts,
        cwd,
        task: taskStr,
        budget: {
          maxDiffChars: config.context?.max_diff_chars,
          maxTotalChars: config.context?.max_total_chars,
          surroundingLines: config.context?.surrounding_lines,
        },
      });

      const isClean =
        changedFiles.length === 0 && (!parsedDiff.raw || parsedDiff.raw.trim().length === 0);

      const detResults = isClean
        ? [
            {
              id: 'secret_scan' as const,
              status: 'passed' as const,
              exitCode: 0,
              durationMs: 0,
              summary: 'Clean changeset with zero modifications',
              violations: [],
            },
          ]
        : await this.deterministicRunner.run(
            context,
            toDeterministicRunnerConfig(config.deterministic)
          );

      hasDeterministicFailures = detResults.some((r) => r.status === 'failed');
      const evalResult = this.policyEngine.evaluate(detResults, [], config, context);
      status = evalResult.verdict;
      findings = evalResult.findings;
    }

    return {
      status,
      summary,
      changedFiles,
      findings,
      hasDeterministicFailures,
      preliminaryFindings: findings,
    };
  }

  /**
   * Executes the full verification gate (deterministic + semantic + policy evaluation).
   */
  public async check(options: CheckOptions = {}): Promise<CheckResult> {
    const startTime = Date.now();
    const cwd = options.cwd ?? process.cwd();

    const isGit = await this.gitAdapter.isGitRepository(cwd);
    if (!isGit) {
      throw new NotAGitRepositoryError(cwd);
    }

    const config = await this.resolveConfig(cwd, options.config, options.configPath);
    let scope = options.scope;
    if (!scope) {
      if (options.target) {
        scope = options.target.includes('..') ? 'range' : 'commit';
      } else {
        scope = 'all';
      }
    }
    const diffOpts = buildDiffOptions(options.target, cwd);
    const taskStr =
      typeof options.task === 'string'
        ? options.task
        : options.task?.task;

    // 1. Build evaluation context
    const context = await this.contextBuilder.buildContext({
      scope,
      diffOptions: diffOpts,
      cwd,
      task: taskStr,
      budget: {
        maxDiffChars: config.context?.max_diff_chars,
        maxTotalChars: config.context?.max_total_chars,
        surroundingLines: config.context?.surrounding_lines,
        maxRelatedTestFiles: config.context?.related_tests?.max_files,
        maxInstructionChars: config.context?.instructions?.max_chars,
      },
    });

    const changedFiles = context.diff?.files || [];
    const isCleanChangeset =
      changedFiles.length === 0 && (!context.diff?.raw || context.diff.raw.trim().length === 0);

    // 2. Execute deterministic checks
    let deterministicResults: DeterministicResult[];
    if (isCleanChangeset) {
      deterministicResults = [
        {
          id: 'secret_scan',
          status: 'passed',
          exitCode: 0,
          durationMs: 0,
          summary: 'Clean changeset with zero modifications',
          violations: [],
        },
      ];
      const detCfg = config.deterministic;
      if (detCfg?.test?.enabled) {
        deterministicResults.push({
          id: 'test',
          status: 'skipped',
          durationMs: 0,
          summary: 'Skipped test check: clean changeset with zero modifications',
        });
      }
      if (detCfg?.lint?.enabled) {
        deterministicResults.push({
          id: 'lint',
          status: 'skipped',
          durationMs: 0,
          summary: 'Skipped lint check: clean changeset with zero modifications',
        });
      }
      if (detCfg?.typecheck?.enabled) {
        deterministicResults.push({
          id: 'typecheck',
          status: 'skipped',
          durationMs: 0,
          summary: 'Skipped typecheck: clean changeset with zero modifications',
        });
      }
    } else {
      deterministicResults = await this.deterministicRunner.run(
        context,
        toDeterministicRunnerConfig(config.deterministic)
      );
    }

    // 3. Determine semantic provider
    const isOffline =
      options.offline ||
      config.system_one?.provider === 'mock' ||
      !process.env.TYPESAFE_API_KEY;

    const provider: DecisionProvider = isOffline
      ? this.mockProvider
      : this.typesafeProvider;

    // 4. Assemble semantic questions
    const questions: SemanticQuestion[] = [];
    const hasTask = context.task && context.task.task && context.task.task.trim().length > 0;

    if (hasTask) {
      questions.push(
        STANDARD_QUESTIONS_MAP.task_completed,
        STANDARD_QUESTIONS_MAP.task_scope_match,
        STANDARD_QUESTIONS_MAP.unrelated_changes,
        STANDARD_QUESTIONS_MAP.tests_required,
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
        STANDARD_QUESTIONS_MAP.regression_risk
      );
    } else {
      questions.push(
        STANDARD_QUESTIONS_MAP.unrelated_changes,
        STANDARD_QUESTIONS_MAP.tests_required,
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
        STANDARD_QUESTIONS_MAP.regression_risk
      );
    }

    // Include custom policy rules as questions
    if (config.custom_rules && Array.isArray(config.custom_rules)) {
      for (const rule of config.custom_rules) {
        if (rule.enabled !== false) {
          questions.push({
            id: rule.id,
            type:
              rule.primitive === 'score'
                ? 'score'
                : rule.primitive === 'choice'
                ? 'choice'
                : 'boolean',
            prompt: rule.question,
            choices: rule.candidates?.map((c) => ({ value: c })),
            levels: rule.scoreLevels?.map((l, idx) => ({
              name: l,
              description: `Score level: ${l}`,
              score: (idx + 1) / rule.scoreLevels!.length,
            })),
          });
        }
      }
    }

    // 5. Evaluate semantic decisions
    const rawDecisions = isCleanChangeset
      ? [
          {
            id: 'task_completed',
            probability: 1.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'task_scope_match',
            probability: 1.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'unrelated_changes',
            probability: 0.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'tests_required',
            probability: 0.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'security_sensitive_change',
            probability: 0.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'security_sensitive',
            probability: 0.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
          {
            id: 'regression_risk',
            value: 'negligible',
            score: 0.0,
            confidence: 1.0,
            provider: provider.name,
            rationale: 'Clean changeset with zero modifications',
          },
        ]
      : await provider.evaluate(context, questions);
    const semanticDecisions: SemanticDecision[] = [...rawDecisions];

    // Ensure security_sensitive alias is available if security_sensitive_change was evaluated
    const secDecision = semanticDecisions.find((d) => d.id === 'security_sensitive_change');
    if (secDecision && !semanticDecisions.some((d) => d.id === 'security_sensitive')) {
      semanticDecisions.push({
        ...secDecision,
        id: 'security_sensitive',
      });
    }

    // 6. Policy Engine evaluation
    const evalResult = this.policyEngine.evaluate(
      deterministicResults,
      semanticDecisions,
      config,
      context
    );

    // 7. Store generated findings in finding manager
    for (const finding of evalResult.findings) {
      if (this.findingManager.storeFinding) {
        this.findingManager.storeFinding(finding);
      }
    }

    // Filter findings if specific findingIds were requested
    let finalFindings = evalResult.findings;
    if (options.findingIds && options.findingIds.length > 0) {
      const allowed = new Set(options.findingIds);
      finalFindings = finalFindings.filter((f) => allowed.has(f.id));
    }

    // 8. Compute suggested process exit code
    let exitCode = 0;
    if (evalResult.verdict === 'BLOCK') {
      exitCode = 1;
    } else if (evalResult.verdict === 'REVIEW' && options.strict) {
      exitCode = 1;
    } else if (evalResult.verdict === 'WARN' && (options.strict || options.failOnWarn)) {
      exitCode = 1;
    }

    const checkResult: CheckResult = {
      status: evalResult.verdict,
      verdictSummary: evalResult.summary,
      task: context.task,
      diffSummary: {
        filesChanged: context.diff.files.length,
        insertions: context.diff.insertions,
        deletions: context.diff.deletions,
        truncated: context.diff.truncated,
      },
      findings: finalFindings,
      resolved: [],
      remaining: finalFindings.map((f) => f.id),
      resolvedFindings: [],
      remainingFindings: finalFindings.map((f) => f.id),
      deterministicResults,
      semanticDecisions: Object.fromEntries(
        semanticDecisions.map((d) => [d.id, d])
      ),
      metadata: {
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        gitRoot: context.repository?.rootPath ?? cwd,
        headSha: context.repository?.headSha ?? '',
        cacheHit: false,
      },
      exitCode,
    };

    return checkResult;
  }

  /**
   * Re-evaluates previously identified findings to determine if fresh changes have resolved them.
   */
  public async verify(options: VerifyOptions = {}): Promise<VerificationReport> {
    const cwd = options.cwd ?? process.cwd();

    // 1. Run a fresh check on the repository
    const freshCheck = await this.check({
      cwd,
      scope: options.scope ?? 'all',
      task: options.task,
      config: options.config,
      configPath: options.configPath,
      offline: options.offline,
      noCache: options.noCache,
    });

    // 2. Retrieve previous findings to evaluate
    let previousFindings: Finding[] = [];

    if (options.findingIds && options.findingIds.length > 0) {
      const allStored = this.findingManager.getFindings
        ? this.findingManager.getFindings()
        : [];
      const storedMap = new Map(allStored.map((f) => [f.id, f]));

      for (const id of options.findingIds) {
        const stored = storedMap.get(id);
        if (stored) {
          previousFindings.push(stored);
        } else {
          // Synthetic finding placeholder with stable fingerprint
          let extractedRule = id;
          let extractedHash = '';
          const match = id.match(/^finding_(.+)_([0-9a-fA-F]{8})$/);
          if (match) {
            extractedRule = match[1];
            extractedHash = match[2];
          }
          previousFindings.push({
            id,
            ruleId: extractedRule,
            source: extractedRule.startsWith('deterministic') ? 'deterministic' : 'semantic',
            status: 'block',
            severity: 'CRITICAL',
            lifecycle: 'active',
            affectedFiles: [],
            message: `Target finding ${id}`,
            evidence: [],
            expectedEvidence: [],
            fingerprint: extractedHash || `fp_${id}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    } else {
      previousFindings = this.findingManager.getFindings
        ? this.findingManager.getFindings({ lifecycle: 'active' })
        : [];
    }

    // 3. Resolve previous findings against fresh findings
    const report = this.findingManager.resolveFindings(
      previousFindings,
      freshCheck.findings
    );

    // If specific finding IDs were requested for verification,
    // ensure remaining findings are scoped to the targeted set
    if (options.findingIds && options.findingIds.length > 0) {
      const targetedSet = new Set(options.findingIds);
      report.remaining = report.remaining.filter((id) => targetedSet.has(id));
      report.remainingFindings = report.remaining;
      report.findings = report.findings.filter((f) => targetedSet.has(f.id));
      if (report.remaining.length === 0) {
        report.status = 'PASS';
        report.verdictSummary = `All ${report.resolved.length} targeted finding(s) successfully resolved. Gate status: PASS.`;
      }
    }

    // Merge check context and metadata
    report.task = freshCheck.task;
    report.diffSummary = freshCheck.diffSummary;
    report.deterministicResults = freshCheck.deterministicResults;
    report.semanticDecisions = freshCheck.semanticDecisions;
    report.metadata = freshCheck.metadata;

    return report;
  }

  /**
   * Retrieves active or filtered findings from the finding manager.
   */
  public async getFindings(filter?: FindingFilter): Promise<Finding[]> {
    if (this.findingManager.getFindings) {
      return this.findingManager.getFindings(filter);
    }
    return [];
  }
}
