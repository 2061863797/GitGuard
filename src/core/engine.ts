/**
 * src/core/engine.ts
 * DefaultGitGuardEngine implementing the central GitGuardEngine contract.
 * Coordinates Git context, deterministic status checkers, agent/config rules judged by
 * System One, policy evaluation, and structured finding lifecycle management.
 */

import * as path from 'node:path';
import type {
  AgentRule,
  GitGuardEngine,
  CheckOptions,
  CheckResult,
  VerifyOptions,
} from '../types/engine.js';
import type { Finding, FindingFilter, VerificationReport } from '../types/finding.js';
import type { PolicyConfig, DeterministicPolicyConfig, RuleSpec } from '../types/policy.js';
import type {
  DecisionProvider,
  DeterministicConfig,
  DeterministicResult,
  SemanticDecision,
  SemanticQuestion,
} from '../types/provider.js';
import type { GitAdapter, DiffOptions } from '../types/git.js';
import type { ContextBuilder } from '../types/context.js';
import type { PolicyEngine } from '../types/policy.js';
import type { FindingManager } from '../types/finding.js';
import { GitCLIAdapter } from '../git/adapter.js';
import { DefaultContextBuilder } from '../context/builder.js';
import { DeterministicRunner } from '../analysis/deterministic/runner.js';
import { TypeSafeSystemOneProvider } from '../analysis/semantic/typesafe-provider.js';
import { DefaultPolicyEngine } from '../policy/engine.js';
import { ruleAppliesTo, rulePrompt } from '../policy/rules.js';
import { DefaultFindingManager } from '../findings/manager.js';
import { FileFindingStore } from '../findings/store.js';
import { loadConfig, validateRule } from '../policy/config.js';
import {
  NotAGitRepositoryError,
  ConfigurationError,
  ProviderError,
  SecurityViolationError,
  InvalidGitRefError,
} from '../types/errors.js';
import { recordLastCheck } from '../enforcement/commit-gate.js';
import { scanContentForSecrets, SECRET_PATTERNS, validateCustomSecretPattern, type SecretPattern } from '../analysis/deterministic/secrets.js';

function normalizeRepositoryRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Maximum number of agent-supplied rules per check.
 */
export const MAX_AGENT_RULES = 10;

/**
 * Dependency injection options for DefaultGitGuardEngine.
 */
export interface GitGuardEngineDependencies {
  gitAdapter?: GitAdapter;
  contextBuilder?: ContextBuilder;
  deterministicRunner?: DeterministicRunner;
  /** Semantic provider; a stub replaces the live TypeSafe client in tests */
  typesafeProvider?: DecisionProvider;
  policyEngine?: PolicyEngine;
  findingManager?: FindingManager;
}

/**
 * Validates agent rules and combines them with config rules.
 * Previously checked agent rules (verify) are appended when their id is not taken.
 */
export function mergeRules(
  configRules: RuleSpec[] = [],
  agentRules: AgentRule[] = [],
  storedRules: RuleSpec[] = []
): RuleSpec[] {
  if (agentRules.length > MAX_AGENT_RULES) {
    throw new ConfigurationError(`At most ${MAX_AGENT_RULES} rules can be supplied per check.`);
  }
  const merged: RuleSpec[] = configRules.map((q) => ({ ...q, source: 'config' as const }));
  const ids = new Set(merged.map((q) => q.id));
  agentRules.forEach((rule, i) => {
    const errors = validateRule(rule, `rules[${i}]`);
    if (errors.length > 0) {
      throw new ConfigurationError(`Invalid rule: ${errors.join('; ')}`);
    }
    if (ids.has(rule.id)) {
      throw new ConfigurationError(`Rule id '${rule.id}' is already used by .gitguard.yml or another rule.`);
    }
    ids.add(rule.id);
    merged.push({ ...rule, source: 'agent' });
  });
  for (const rule of storedRules) {
    if (rule.source === 'agent' && !ids.has(rule.id)) {
      ids.add(rule.id);
      merged.push(rule);
    }
  }
  return merged;
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

  if (target.includes('..')) {
    const refs = target.split(/\.\.\.?/);
    if (target.includes('....') || refs.length !== 2 || refs.some((ref) => !ref.trim() || ref.includes('..'))) {
      throw new InvalidGitRefError(target);
    }
    // Preserve Git's distinction between endpoint and merge-base comparisons.
    opts.baseRef = target;
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
  public readonly typesafeProvider: DecisionProvider;
  public readonly policyEngine: PolicyEngine;
  public readonly findingManager: FindingManager;

  constructor(deps?: GitGuardEngineDependencies) {
    this.gitAdapter = deps?.gitAdapter ?? new GitCLIAdapter();
    this.contextBuilder = deps?.contextBuilder ?? new DefaultContextBuilder(this.gitAdapter);
    this.deterministicRunner = deps?.deterministicRunner ?? new DeterministicRunner();
    this.typesafeProvider = deps?.typesafeProvider ?? new TypeSafeSystemOneProvider();
    this.findingManager = deps?.findingManager ?? new DefaultFindingManager();
    this.policyEngine = deps?.policyEngine ?? new DefaultPolicyEngine(this.findingManager);
  }

  private async resolveConfig(cwd: string, optionsConfig?: PolicyConfig, configPath?: string): Promise<PolicyConfig> {
    return optionsConfig ?? (await loadConfig(configPath, cwd));
  }

  /**
   * Builds the live TypeSafe client from configuration, or returns the injected provider.
   */
  private resolveProvider(config: PolicyConfig): DecisionProvider {
    if (!(this.typesafeProvider instanceof TypeSafeSystemOneProvider)) {
      return this.typesafeProvider;
    }
    const configuredBaseUrl = config.system_one?.baseUrl?.trim();
    if (configuredBaseUrl) {
      let parsed: URL;
      try {
        parsed = new URL(configuredBaseUrl);
      } catch {
        throw new ConfigurationError(`Invalid system_one.baseUrl format: ${configuredBaseUrl}`);
      }
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'api.typesafe.ai') {
        throw new SecurityViolationError(
          `system_one.baseUrl [${configuredBaseUrl}] must be the official TypeSafe endpoint; use TYPESAFE_BASE_URL for other endpoints.`
        );
      }
    }
    return new TypeSafeSystemOneProvider({
      apiKey: process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || undefined,
      baseUrl: configuredBaseUrl,
      model: config.system_one?.model || 'jev-latest',
      timeoutMs: config.system_one?.timeout_ms,
    });
  }

  /**
   * Executes the gate: deterministic checks plus agent and config rules.
   */
  public async check(options: CheckOptions = {}): Promise<CheckResult> {
    return this.runCheck(options, []);
  }

  private async runCheck(options: CheckOptions, storedRules: RuleSpec[]): Promise<CheckResult> {
    const startTime = Date.now();
    const cwd = options.cwd ?? process.cwd();

    const isGit = await this.gitAdapter.isGitRepository(cwd);
    if (!isGit) {
      throw new NotAGitRepositoryError(cwd);
    }

    const config = await this.resolveConfig(cwd, options.config, options.configPath);
    const rules = mergeRules(config.rules, options.rules, storedRules);
    const scope = options.scope ?? (options.target ? (options.target.includes('..') ? 'range' : 'commit') : 'all');
    const diffOpts = buildDiffOptions(options.target, cwd);
    const taskStr = typeof options.task === 'string' ? options.task : options.task?.task;

    // 1. Dual context: rawContext for local tools, redacted semanticContext for System One
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
    const changedPaths = (context.diff?.files || []).map((f) => f.newPath || f.oldPath || '');
    const isCleanChangeset =
      changedPaths.length === 0 && (!context.diff?.raw || context.diff.raw.trim().length === 0);

    // 2. Deterministic checks run against rawContext so secrets in excluded files are still caught locally
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
      for (const checkId of ['test', 'lint', 'typecheck'] as const) {
        if (config.deterministic?.[checkId]?.enabled) {
          deterministicResults.push({
            id: checkId,
            status: 'skipped',
            durationMs: 0,
            summary: `Skipped ${checkId}: clean changeset with zero modifications`,
          });
        }
      }
    } else {
      deterministicResults = await this.deterministicRunner.run(
        rawContext,
        toDeterministicRunnerConfig(config.deterministic)
      );
    }

    // 3. Check only the rules whose file filters match this changeset; no rules means no API call
    const asked = isCleanChangeset ? [] : rules.filter((rule) => ruleAppliesTo(rule, changedPaths));
    let semanticDecisions: SemanticDecision[] = [];
    if (asked.length > 0) {
      const provider = this.resolveProvider(config);
      const semanticQuestions: SemanticQuestion[] = asked.map((rule) => ({ id: rule.id, prompt: rulePrompt(rule) }));
      semanticDecisions = provider.evaluateWithReport
        ? (await provider.evaluateWithReport(semanticContext, semanticQuestions)).decisions
        : await provider.evaluate(semanticContext, semanticQuestions);
      const answered = new Set(semanticDecisions.map((d) => d.id));
      const missing = asked.filter((q) => !answered.has(q.id)).map((q) => q.id);
      if (missing.length > 0) {
        throw new ProviderError(`System One returned no answer for: ${missing.join(', ')}`, provider.name);
      }
    }

    // 4. Policy evaluation
    const evalResult = this.policyEngine.evaluate(deterministicResults, semanticDecisions, asked, config, context);

    for (const finding of evalResult.findings) {
      if (this.findingManager.storeFinding) {
        this.findingManager.storeFinding(finding);
      }
    }

    const checkResult: CheckResult = {
      status: evalResult.verdict,
      canCommit: evalResult.verdict !== 'BLOCK',
      verdictSummary: evalResult.summary,
      task: context.task,
      diffSummary: {
        filesChanged: context.diff.files.length,
        insertions: context.diff.insertions,
        deletions: context.diff.deletions,
        truncated: context.diff.truncated,
      },
      findings: evalResult.findings,
      resolved: [],
      remaining: evalResult.findings.map((f) => f.id),
      resolvedFindings: [],
      remainingFindings: evalResult.findings.map((f) => f.id),
      deterministicResults,
      semanticDecisions: Object.fromEntries(semanticDecisions.map((d) => [d.id, d])),
      metadata: {
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        gitRoot: context.repository?.rootPath ?? cwd,
        headSha: context.repository?.headSha ?? '',
        rulesChecked: asked.length,
      },
    };

    if (checkResult.findings.length > 0) {
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

    // Record what this check covered so the commit hook can verify the content being committed.
    if (this.gitAdapter instanceof GitCLIAdapter) {
      const adapter = this.gitAdapter;
      try {
        const root = context.repository?.rootPath ?? (await adapter.getRepositoryRoot(cwd));
        const blocking = checkResult.findings.filter((f) => f.status === 'block').map((f) => f.id);
        await recordLastCheck(root, scope, checkResult.status, blocking,
          async (args, dir) => (await adapter.executeGit(args, dir)).stdout);
      } catch (err) {
        console.error(`[gitguard] WARNING: failed to record the check for the commit gate: ${(err as Error)?.message ?? err}`);
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

    const matchesCurrentRepository = (finding: Finding): boolean =>
      !!finding.provenance?.repositoryRoot &&
      normalizeRepositoryRoot(finding.provenance.repositoryRoot) === normalizeRepositoryRoot(repoRoot);

    if (options.findingIds && options.findingIds.length > 0) {
      try {
        const store = new FileFindingStore(repoRoot);
        allStored = await store.list();
      } catch (err) {
        console.error(
          `[gitguard] WARNING: failed to read findings from the repository store: ${(err as Error)?.message ?? err}`
        );
        throw err;
      }
      if (allStored.length === 0) {
        if (typeof (this.findingManager as any).loadPersistentFindings === 'function') {
          allStored = await (this.findingManager as any).loadPersistentFindings();
        } else if (this.findingManager.getFindings) {
          allStored = this.findingManager.getFindings();
        }
        allStored = allStored.filter(matchesCurrentRepository);
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
        const pendingFindings = previousFindings.filter((finding) => finding.lifecycle === 'active');
        const pendingIds = pendingFindings.map((finding) => finding.id);
        const summary = previousFindings.length === 0
          ? `Verification failed: None of the targeted finding ID(s) exist in this repository: [${unknownFindings.join(', ')}].`
          : `Verification failed: Some targeted finding ID(s) are unknown in this repository: [${unknownFindings.join(', ')}].`;
        return {
          status: 'BLOCK',
          verdictSummary: summary,
          task: undefined,
          diffSummary: { filesChanged: 0, insertions: 0, deletions: 0, hasBinaryChanges: false, truncated: false },
          findings: pendingFindings,
          resolved: [],
          remaining: pendingIds,
          unknownFindings,
          targetsResolved: false,
          allResolved: false,
          newFindings: [],
          resolvedFindings: [],
          remainingFindings: pendingIds,
          deterministicResults: [],
          semanticDecisions: {},
          metadata: {
            durationMs: 0,
            timestamp: new Date().toISOString(),
            gitRoot: repoRoot,
            headSha: '',
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
        throw err;
      }
      if (activeStored.length > 0) {
        previousFindings = activeStored;
      } else {
        previousFindings = this.findingManager.getFindings
          ? this.findingManager.getFindings({ lifecycle: 'active' })
          : [];
        previousFindings = previousFindings.filter(matchesCurrentRepository);
      }
    }

    // 2. Run a fresh check, re-checking the agent rules that produced the findings being verified
    const storedRules = previousFindings
      .map((finding) => finding.metadata?.rule as RuleSpec | undefined)
      .filter((rule): rule is RuleSpec => Boolean(rule && rule.id && rule.rule));
    const freshCheck = await this.runCheck({
      cwd,
      scope: options.scope,
      target: options.target,
      task: options.task,
      config: options.config,
      configPath: options.configPath,
    }, storedRules);

    // 3. Resolve previous findings against fresh findings
    const basePrevious = allStored.length > 0 ? allStored : previousFindings;
    const report = this.findingManager.resolveFindings(
      basePrevious,
      freshCheck.findings
    );

    // Baseline Drift and committed violation verification:
    // Ensure findings were not falsely marked as resolved merely because the offending code was committed into HEAD.
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
        const config = await this.resolveConfig(cwd, options.config, options.configPath);
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
      if (!targetsResolved) {
        report.status = 'BLOCK';
        report.allResolved = false;
        report.verdictSummary = `Verification failed: ${report.remaining.length} targeted finding(s) remain unresolved. Gate status: BLOCK.`;
      } else if (freshCheck.status === 'BLOCK') {
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
    } else {
      targetsResolved = report.remaining.length === 0;
      report.targetsResolved = targetsResolved;
      report.newFindings = [];
      const freshBlocked = freshCheck.status === 'BLOCK';
      report.status = (targetsResolved && !freshBlocked) ? 'PASS' : (targetsResolved ? freshCheck.status : 'BLOCK');
      report.allResolved = targetsResolved && !freshBlocked;
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
    if (verifyPersistenceOk === false) {
      report.status = 'BLOCK';
      report.allResolved = false;
      report.verdictSummary = 'Verification state could not be persisted. Check repository write access and retry verification.';
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
