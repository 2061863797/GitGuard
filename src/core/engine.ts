/**
 * src/core/engine.ts
 * DefaultGitGuardEngine implementing the central GitGuardEngine contract.
 * Coordinates Git context, deterministic status checkers, System One semantic evaluators,
 * policy engine rules, and structured finding lifecycle management.
 */

import * as crypto from 'node:crypto';
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
import { FileFindingStore } from '../findings/store.js';
import { loadConfig } from '../policy/config.js';
import {
  NotAGitRepositoryError,
  ConfigurationError,
  ProviderError,
  SecurityViolationError,
} from '../types/errors.js';
import { SemanticCache } from '../cache/semantic-cache.js';
import { scanContentForSecrets, SECRET_PATTERNS, validateCustomSecretPattern, type SecretPattern } from '../analysis/deterministic/secrets.js';

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
      patterns: policyDeterministic.secret_scan.patterns,
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
    configPath?: string,
    allowCustomProvider = false
  ): Promise<PolicyConfig> {
    if (optionsConfig) {
      return optionsConfig;
    }
    return await loadConfig(configPath, cwd, allowCustomProvider);
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

      const buildOptions = {
        scope,
        diffOptions: diffOpts,
        cwd,
        task: taskStr,
        budget: {
          maxDiffChars: config.context?.max_diff_chars,
          maxTotalChars: config.context?.max_total_chars,
          surroundingLines: config.context?.surrounding_lines,
        },
        policyConfigPath: options.configPath,
      };

      const { rawContext, semanticContext } = this.contextBuilder.buildDualContext
        ? await this.contextBuilder.buildDualContext(buildOptions)
        : {
            rawContext: await this.contextBuilder.buildContext(buildOptions),
            semanticContext: await this.contextBuilder.buildContext(buildOptions),
          };

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
            rawContext,
            toDeterministicRunnerConfig(config.deterministic)
          );

      hasDeterministicFailures = detResults.some((r) => r.status === 'failed');
      const evalResult = this.policyEngine.evaluate(detResults, [], config, semanticContext);
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

    const config = await this.resolveConfig(cwd, options.config, options.configPath, options.allowCustomProvider);
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

    // 1. Build dual evaluation context: rawContext for local tools, semanticContext for external AI
    const buildOptions = {
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
      privacy: {
        redactSecrets: config.privacy?.redact_secrets,
        includeFullFiles: config.privacy?.include_full_files,
        excludePatterns: config.privacy?.exclude_paths,
      },
      policyConfigPath: options.configPath,
    };

    const { rawContext, semanticContext } = this.contextBuilder.buildDualContext
      ? await this.contextBuilder.buildDualContext(buildOptions)
      : {
          rawContext: await this.contextBuilder.buildContext(buildOptions),
          semanticContext: await this.contextBuilder.buildContext(buildOptions),
        };

    const context = semanticContext;
    const changedFiles = context.diff?.files || [];
    const isCleanChangeset =
      changedFiles.length === 0 && (!context.diff?.raw || context.diff.raw.trim().length === 0);

    // 2. Execute deterministic checks against rawContext (ensures secrets in .env are caught locally)
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
    } else if (options.checkDeterministic === false) {
      deterministicResults = [];
    } else {
      deterministicResults = await this.deterministicRunner.run(
        rawContext,
        toDeterministicRunnerConfig(config.deterministic)
      );
    }

    // 3. Determine semantic provider with explicit configuration wiring
    const requireOnline = options.onlineOnly === true || options.requireSemantic === true;
    const isOffline =
      options.offline ||
      config.system_one?.provider === 'mock';
    if (requireOnline && isOffline) {
      throw new ProviderError(
        options.onlineOnly
          ? 'MCP semantic checks require TypeSafe; offline or mock mode is unavailable'
          : 'Required online semantic checks cannot use offline or mock mode',
        'typesafe'
      );
    }

    let provider: DecisionProvider;
    if (isOffline) {
      provider = this.mockProvider;
    } else if (this.typesafeProvider instanceof TypeSafeSystemOneProvider) {
      const configuredKey = config.system_one?.apiKey?.trim();
      const effectiveKey = configuredKey || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
      const configuredBaseUrl = config.system_one?.baseUrl?.trim();
      if (configuredBaseUrl && !options.allowCustomProvider) {
        let parsed: URL;
        try {
          parsed = new URL(configuredBaseUrl);
        } catch {
          throw new ConfigurationError(`Invalid system_one.baseUrl format: ${configuredBaseUrl}`);
        }
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.typesafe.ai') {
          throw new SecurityViolationError(
            `Custom system_one.baseUrl [${configuredBaseUrl}] requires explicit --allow-custom-provider permission.`
          );
        }
      }
      provider = new TypeSafeSystemOneProvider({
        ...(effectiveKey ? { apiKey: effectiveKey } : {}),
        baseUrl: config.system_one?.baseUrl,
        model: config.system_one?.model || 'jev-latest',
        timeoutMs: config.system_one?.timeout_ms,
        strict: requireOnline,
        fallbackProvider: this.mockProvider,
      });
    } else {
      provider = this.typesafeProvider;
    }
    if (requireOnline && provider.name !== 'typesafe') {
      throw new ProviderError(
        options.onlineOnly ? 'MCP semantic checks require the TypeSafe provider' : 'Online semantic checks require the TypeSafe provider',
        'typesafe'
      );
    }

    // 4. Assemble semantic questions
    const questions: SemanticQuestion[] = [];
    const hasTask = context.task && context.task.task && context.task.task.trim().length > 0;

    if (options.taskOnly) {
      questions.push(
        STANDARD_QUESTIONS_MAP.task_completed,
        STANDARD_QUESTIONS_MAP.task_scope_match,
        STANDARD_QUESTIONS_MAP.unrelated_changes
      );
    } else if (hasTask) {
      questions.push(
        STANDARD_QUESTIONS_MAP.task_completed,
        STANDARD_QUESTIONS_MAP.task_scope_match,
        STANDARD_QUESTIONS_MAP.unrelated_changes,
        STANDARD_QUESTIONS_MAP.tests_required,
        STANDARD_QUESTIONS_MAP.tests_present,
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
        STANDARD_QUESTIONS_MAP.regression_risk
      );
    } else {
      questions.push(
        STANDARD_QUESTIONS_MAP.unrelated_changes,
        STANDARD_QUESTIONS_MAP.tests_required,
        STANDARD_QUESTIONS_MAP.tests_present,
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
        STANDARD_QUESTIONS_MAP.regression_risk
      );
    }

    // Include custom policy rules as questions (unless in task-only mode)
    if (!options.taskOnly && config.custom_rules && Array.isArray(config.custom_rules)) {
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

    // 5. Evaluate semantic questions with caching
    const cacheEnabled = !options.noCache && !requireOnline && config.gate?.cache?.enabled !== false;
    const cacheDirOverride = config.gate?.cache?.directory;
    const cache = new SemanticCache(context.repository?.rootPath ?? cwd, cacheEnabled, cacheDirOverride);
    const rawDiffText = context.diff?.raw || '';
    const taskKey = context.task?.task || '';
    const modelKey = config.system_one?.model || 'jev-latest';

    const instructionsFp = crypto.createHash('sha256').update(JSON.stringify(context.instructions || [])).digest('hex').slice(0, 16);
    const surroundingFp = crypto.createHash('sha256').update(JSON.stringify(context.files?.map((f) => f.spans) || [])).digest('hex').slice(0, 16);
    const relatedTestsFp = crypto.createHash('sha256').update(JSON.stringify(context.relatedTests || [])).digest('hex').slice(0, 16);
    const questionsFp = crypto.createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 16);
    const contextFp = `${surroundingFp}:${relatedTestsFp}`;

    const cacheKey = cache.computeKey(rawDiffText, taskKey, modelKey, questions.map((q) => q.id), {
      instructionsFingerprint: instructionsFp,
      contextFingerprint: contextFp,
      questionsFingerprint: questionsFp,
      provider: provider.name,
    });

    let semanticDecisions: SemanticDecision[] = [];
    let cacheHit = false;

    if (isCleanChangeset && !requireOnline) {
      const taskPenalty = hasTask && !options.verifyMode;
      semanticDecisions = [
        {
          id: 'task_completed',
          probability: taskPenalty ? 0.0 : 1.0,
          confidence: 1.0,
          provider: provider.name,
          rationale: taskPenalty
            ? 'Clean changeset with zero modifications while a specific task was declared'
            : 'Clean changeset with zero modifications',
        },
        {
          id: 'task_scope_match',
          probability: taskPenalty ? 0.0 : 1.0,
          confidence: 1.0,
          provider: provider.name,
          rationale: taskPenalty
            ? 'Clean changeset with zero modifications while a specific task was declared'
            : 'Clean changeset with zero modifications',
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
      ];
    } else {
      if (cacheEnabled && !isOffline) {
        const cached = await cache.get(cacheKey, { provider: provider.name, model: modelKey });
        if (cached && cached.length > 0) {
          // If requireSemantic is enabled, ensure cached entry is genuine TypeSafe and not mock/fallback
          const cachedIsMockOrFallback =
            cached.some((d) => d.provider === 'mock' || d.metadata?.fallback === true);
          if (!options.requireSemantic || !cachedIsMockOrFallback) {
            semanticDecisions = cached;
            cacheHit = true;
          }
        }
      }

      if (!cacheHit) {
        if (typeof (provider as any).evaluateWithReport === 'function') {
          const report = await (provider as any).evaluateWithReport(semanticContext, questions);
          semanticDecisions = report.decisions;
        } else {
          semanticDecisions = await provider.evaluate(semanticContext, questions);
        }

        // Cache anti-pollution: strictly persist genuine live TypeSafe evaluations, never mock or fallback
        const isFallback =
          provider.name === 'mock' ||
          semanticDecisions.some((d) => d.metadata?.fallback === true);
        if (cacheEnabled && !isOffline && semanticDecisions.length > 0 && provider.name === 'typesafe' && !isFallback) {
          await cache.set(cacheKey, provider.name, modelKey, semanticDecisions);
        }
      }
    }

    if (requireOnline && (
      semanticDecisions.length === 0 ||
      semanticDecisions.some((decision) =>
        decision.provider !== 'typesafe' ||
        decision.metadata?.effectiveProvider !== 'typesafe' ||
        decision.metadata.fallback
      )
    )) {
      throw new ProviderError(
        options.onlineOnly
          ? 'MCP rejected a missing, mock, or fallback semantic result'
          : 'Required online semantic result is missing or used a mock or fallback provider',
        'typesafe'
      );
    }

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
    const blockOnList = config.gate?.block_on || ['BLOCK'];

    if (evalResult.verdict === 'BLOCK' || blockOnList.includes(evalResult.verdict)) {
      exitCode = 1;
    } else if (evalResult.verdict === 'REVIEW' && options.strict) {
      exitCode = 1;
    } else if (evalResult.verdict === 'WARN' && (options.strict || options.failOnWarn)) {
      exitCode = 1;
    }

    // Check requireSemantic failure: exit code 2 if Jev was unavailable or fell back to mock
    if (options.requireSemantic) {
      const isFallback =
        provider.name === 'mock' ||
        semanticDecisions.some((d) => d.metadata?.fallback === true);
      if (isFallback) {
        exitCode = 2;
      }
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
        cacheHit,
      },
      exitCode,
    };

    if (checkResult.findings && checkResult.findings.length > 0) {
      try {
        const repoRoot = context.repository?.rootPath ?? (await this.gitAdapter.getRepositoryRoot(cwd).catch(() => cwd));
        const store = new FileFindingStore(repoRoot);
        await store.save(checkResult.findings);
        checkResult.metadata.persistenceOk = true;
      } catch (err) {
        // Finding persistence must never fail silently: if the store write
        // fails, a later `verify()` would wrongly treat these findings as resolved.
        checkResult.metadata.persistenceOk = false;
        console.error(
          `[gitguard] WARNING: failed to persist ${checkResult.findings.length} finding(s) to the repository store: ${(err as Error)?.message ?? err}`
        );
      }
    }

    return checkResult;
  }

  /**
   * Re-evaluates previously identified findings to determine if fresh changes have resolved them.
   */
  public async verify(options: VerifyOptions = {}): Promise<VerificationReport> {
    const cwd = options.cwd ?? process.cwd();
    const repoRoot = await this.gitAdapter.getRepositoryRoot(cwd);

    // 1. Retrieve previous findings and validate targeted IDs BEFORE running fresh check
    let previousFindings: Finding[] = [];
    let storedMap: Map<string, Finding> | undefined;
    const unknownFindings: string[] = [];
    let allStored: Finding[] = [];

    if (options.findingIds && options.findingIds.length > 0) {
      try {
        const store = new FileFindingStore(repoRoot);
        allStored = await store.list();
      } catch (err) {
        console.error(
          `[gitguard] WARNING: failed to read findings from the repository store: ${(err as Error)?.message ?? err}`
        );
      }
      if (allStored.length === 0) {
        if (typeof (this.findingManager as any).loadPersistentFindings === 'function') {
          allStored = await (this.findingManager as any).loadPersistentFindings();
        } else if (this.findingManager.getFindings) {
          allStored = this.findingManager.getFindings();
        }
      }
      storedMap = new Map<string, Finding>(allStored.map((f: Finding) => [f.id, f]));

      for (const id of options.findingIds) {
        const stored = storedMap.get(id);
        if (stored) {
          previousFindings.push(stored);
        } else {
          unknownFindings.push(id);
        }
      }

      // Early short-circuit if any targeted finding IDs are unknown:
      // Do not waste resources on subcommands or remote API calls!
      if (unknownFindings.length > 0) {
        const summary = previousFindings.length === 0
          ? `Verification failed: None of the targeted finding ID(s) exist in repository store or history: [${unknownFindings.join(', ')}].`
          : `Verification failed: None of the targeted finding ID(s) exist in repository store or history: [${unknownFindings.join(', ')}].`;
        return {
          status: 'BLOCK',
          verdictSummary: summary,
          task: undefined,
          diffSummary: { filesChanged: 0, insertions: 0, deletions: 0, hasBinaryChanges: false, truncated: false },
          findings: [],
          resolved: [],
          remaining: [],
          unknownFindings,
          targetsResolved: false,
          allResolved: false,
          newFindings: [],
          resolvedFindings: [],
          remainingFindings: [],
          deterministicResults: [],
          semanticDecisions: {},
          metadata: {
            durationMs: 0,
            timestamp: new Date().toISOString(),
            gitRoot: repoRoot,
            headSha: '',
            cacheHit: false,
          },
        };
      }
    } else {
      let activeStored: Finding[] = [];
      try {
        const store = new FileFindingStore(repoRoot);
        activeStored = await store.list({ lifecycle: 'active' });
      } catch (err) {
        console.error(
          `[gitguard] WARNING: failed to read findings from the repository store: ${(err as Error)?.message ?? err}`
        );
      }
      if (activeStored.length > 0) {
        previousFindings = activeStored;
      } else {
        previousFindings = this.findingManager.getFindings
          ? this.findingManager.getFindings({ lifecycle: 'active' })
          : [];
      }
    }

    // 2. Run fresh check on the repository
    const freshCheck = await this.check({
      cwd,
      scope: options.scope ?? 'all',
      task: options.task,
      config: options.config,
      configPath: options.configPath,
      offline: options.offline,
      noCache: options.noCache,
      strict: options.strict,
      onlineOnly: options.onlineOnly,
      verifyMode: true,
      allowCustomProvider: options.allowCustomProvider,
    });

    // 3. Resolve previous findings against fresh findings
    const basePrevious = allStored.length > 0 ? allStored : previousFindings;
    const report = this.findingManager.resolveFindings(
      basePrevious,
      freshCheck.findings
    );

    // Baseline Drift and committed violation verification:
    // Ensure findings were not falsely marked as resolved merely because the offending code was committed into HEAD.
    const currentHeadSha = await this.gitAdapter.getHeadSha(repoRoot);
    const validatedResolved: string[] = [];
    const revivedFindings: Finding[] = [];
    const previousMap = new Map<string, Finding>(basePrevious.map((f) => [f.id, f]));

    for (const resId of report.resolved) {
      const prev = previousMap.get(resId);
      if (!prev) {
        validatedResolved.push(resId);
        continue;
      }

      let isStillViolating = false;
      let violationReason = '';

      // Check if secret finding was committed into HEAD or still present in file
      if (prev.ruleId.includes('secret') || prev.id.includes('secret')) {
        const config = await this.resolveConfig(cwd, options.config, options.configPath, options.allowCustomProvider);
        let secretPatterns: SecretPattern[] = SECRET_PATTERNS;
        const userPatterns = config.deterministic?.secret_scan?.patterns;
        if (userPatterns && userPatterns.length > 0) {
          const customPatterns: SecretPattern[] = userPatterns.map((p, idx) => {
            const reason = validateCustomSecretPattern(p);
            if (reason) throw new SecurityViolationError(`Unsafe custom secret pattern ${idx + 1}: ${reason}`);
            return {
              rule: `custom_secret_${idx + 1}`,
              description: `User-defined secret pattern: ${p}`,
              regex: new RegExp(p),
            };
          });
          secretPatterns = [...SECRET_PATTERNS, ...customPatterns];
        }

        for (const relFile of prev.affectedFiles || []) {
          const headContent = await this.gitAdapter.getFileContent(relFile, 'HEAD', repoRoot);
          const workContent = await this.gitAdapter.getFileContent(relFile, undefined, repoRoot);

          if (headContent) {
            const headViolations = scanContentForSecrets(headContent, relFile, secretPatterns);
            if (headViolations.length > 0) {
              isStillViolating = true;
              violationReason = `Secret is still committed in repository HEAD in '${relFile}' (${headViolations[0].rule})`;
              break;
            }
          }
          if (workContent) {
            const workViolations = scanContentForSecrets(workContent, relFile, secretPatterns);
            if (workViolations.length > 0) {
              isStillViolating = true;
              violationReason = `Secret is still present in working file '${relFile}' (${workViolations[0].rule})`;
              break;
            }
          }
        }
      }

      if (isStillViolating) {
        const revived: Finding = {
          ...prev,
          lifecycle: 'active',
          message: `${prev.message} [Unresolved: ${violationReason}]`,
        };
        revivedFindings.push(revived);
        if (this.findingManager.storeFinding) {
          this.findingManager.storeFinding(revived);
        }
      } else {
        validatedResolved.push(resId);
      }
    }

    if (revivedFindings.length > 0) {
      report.resolved = validatedResolved;
      report.resolvedFindings = validatedResolved;
      report.remaining = [...report.remaining, ...revivedFindings.map((f) => f.id)];
      report.remainingFindings = report.remaining;
      report.findings = [...report.findings, ...revivedFindings];
    }

    // 4. Scoped targeted evaluation & comprehensive gate synthesis
    let targetsResolved = false;
    let newFindings: Finding[] = [];

    if (options.findingIds && options.findingIds.length > 0) {
      const targetedSet = new Set(options.findingIds);

      // Scoped resolved & remaining targeted findings
      report.resolved = report.resolved.filter((id) => targetedSet.has(id));
      report.resolvedFindings = report.resolved;

      report.remaining = report.remaining.filter((id) => targetedSet.has(id));
      report.remainingFindings = report.remaining;

      // Detect newly introduced findings that were not in the targeted set and not already present in stored findings
      const storedIds = new Set(allStored.map((f) => f.id));
      newFindings = report.findings.filter((f) => {
        if (targetedSet.has(f.id)) return false;
        if (storedIds.has(f.id)) return false;
        return true;
      });
      report.newFindings = newFindings;

      targetsResolved = unknownFindings.length === 0 && report.remaining.length === 0;
      report.targetsResolved = targetsResolved;

      // Determine overall Gate Status
      if (options.targetOnly) {
        report.status = targetsResolved ? 'PASS' : 'BLOCK';
        report.allResolved = targetsResolved;
        report.verdictSummary = targetsResolved
          ? `All ${report.resolved.length} targeted finding(s) successfully resolved (target-only). Gate status: PASS.`
          : `Verification incomplete: ${report.remaining.length} targeted finding(s) remain unresolved. Gate status: BLOCK.`;
      } else {
        if (!targetsResolved) {
          report.status = 'BLOCK';
          report.allResolved = false;
          report.verdictSummary = `Verification failed: ${report.remaining.length} targeted finding(s) remain unresolved. Gate status: BLOCK.`;
        } else if (freshCheck.exitCode !== 0) {
          report.status = freshCheck.status;
          report.allResolved = false;
          const blockingSummary = newFindings.length > 0
            ? `${newFindings.length} new blocking violation(s) detected [${newFindings.map((f) => f.ruleId).join(', ')}]`
            : `repository check failed gate criteria with status ${freshCheck.status}`;
          report.verdictSummary = `Targeted finding(s) [${report.resolved.join(', ')}] resolved, but ${blockingSummary}. Gate status: ${freshCheck.status}.`;
        } else {
          report.status = 'PASS';
          report.allResolved = true;
          report.verdictSummary = newFindings.length > 0
            ? `All ${report.resolved.length} targeted finding(s) successfully resolved with ${newFindings.length} non-blocking advisory note(s). Gate status: PASS.`
            : `All ${report.resolved.length} targeted finding(s) successfully resolved. Gate status: PASS.`;
        }
      }
    } else {
      targetsResolved = report.remaining.length === 0;
      report.targetsResolved = targetsResolved;
      report.newFindings = [];
      if (options.targetOnly) {
        report.status = targetsResolved ? 'PASS' : 'BLOCK';
        report.allResolved = targetsResolved;
      } else {
        report.status = (targetsResolved && freshCheck.exitCode === 0) ? 'PASS' : (targetsResolved ? freshCheck.status : 'BLOCK');
        report.allResolved = targetsResolved && freshCheck.exitCode === 0;
      }
      report.verdictSummary = report.status === 'PASS'
        ? `All findings verified and resolved. Gate status: PASS.`
        : `Verification incomplete or gate blocked with status ${report.status}.`;
    }

    // Persist resolution state back to repository finding store
    let verifyPersistenceOk: boolean | undefined;
    try {
      const store = new FileFindingStore(repoRoot);
      const allToSave = [...report.findings];
      for (const id of report.resolved || []) {
        const prev = storedMap ? storedMap.get(id) : previousFindings.find((p) => p.id === id);
        if (prev) {
          allToSave.push({
            ...prev,
            lifecycle: 'resolved',
            resolvedAt: new Date().toISOString(),
          });
        }
      }
      if (allToSave.length > 0) {
        await store.save(allToSave);
      }
      verifyPersistenceOk = true;
    } catch (err) {
      verifyPersistenceOk = false;
      console.error(
        `[gitguard] WARNING: failed to persist verification state to the repository store: ${(err as Error)?.message ?? err}`
      );
    }

    // Merge check context and metadata
    report.task = freshCheck.task;
    report.diffSummary = freshCheck.diffSummary;
    report.deterministicResults = freshCheck.deterministicResults;
    report.semanticDecisions = freshCheck.semanticDecisions;
    report.metadata = freshCheck.metadata;
    if (verifyPersistenceOk !== undefined) {
      report.metadata.persistenceOk = verifyPersistenceOk;
    }

    return report;
  }

  /**
   * Retrieves active or filtered findings from the finding manager.
   */
  public async getFindings(filter?: FindingFilter): Promise<Finding[]> {
    if (typeof (this.findingManager as any).loadPersistentFindings === 'function') {
      return await (this.findingManager as any).loadPersistentFindings(filter);
    }
    if (this.findingManager.getFindings) {
      return this.findingManager.getFindings(filter);
    }
    return [];
  }
}
