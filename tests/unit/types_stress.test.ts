import { describe, it, expect } from 'vitest';
import {
  GITGUARD_VERSION,
  GitGuardError,
  NotAGitRepositoryError,
  GitExecutionError,
  ForbiddenGitOperationError,
  InvalidGitRefError,
  ConfigurationError,
  PolicyEvaluationError,
  SecurityViolationError,
  ProviderError,
  BudgetExceededError,
  type ChangeScope,
  type FileChangeStatus,
  type GitFileStatus,
  type ChangedFile,
  type GitStatusSummary,
  type GitStatus,
  type DiffOptions,
  type GitAdapter,
  type IGitAdapter,
  type DiffLineType,
  type DiffLine,
  type DiffHunk,
  type DiffFile,
  type DiffSummary,
  type DiffContext,
  type DiffParser,
  type TaskSource,
  type TaskContext,
  type SurroundingCodeSpan,
  type FileContext,
  type InstructionContext,
  type TestContext,
  type RepositoryMetadata,
  type RepositoryContext,
  type ContextBudgetOptions,
  type PrivacyOptions,
  type ContextBuildOptions,
  type EvaluationContext,
  type ContextBuilder,
  type DeterministicCheckId,
  type DeterministicStatus,
  type DeterministicCheckStatus,
  type DeterministicViolation,
  type DeterministicResult,
  type DeterministicEvidence,
  type CommandDefinition,
  type DeterministicConfig,
  type DeterministicChecker,
  type DeterministicRunner,
  type SemanticQuestionType,
  type SemanticPrimitive,
  type SemanticQuestionChoice,
  type SemanticQuestionLevel,
  type StandardQuestionId,
  type SemanticQuestion,
  type SemanticDecision,
  type SemanticResult,
  type DecisionProvider,
  type IDecisionProvider,
  type FindingSeverity,
  type FindingStatus,
  type FindingSource,
  type FindingLifecycleState,
  type EvidenceType,
  type Evidence,
  type Finding,
  type FindingFilter,
  type VerificationReportMetadata,
  type VerificationReport,
  type FindingFingerprintInput,
  type FindingManager,
  type IFindingManager,
  type GateVerdict,
  type GateStatus,
  type ThresholdConfig,
  type PolicyRule,
  type CustomPolicyRule,
  type ContextBudgetConfig,
  type SystemOneConfig,
  type DeterministicCheckConfig,
  type DeterministicSecretScanConfig,
  type DeterministicPolicyConfig,
  type BuiltinRulesConfig,
  type PrivacyConfig,
  type PolicyConfig,
  type RuleMatch,
  type PolicyEvaluationResult,
  type PolicyEngine,
  type InspectOptions,
  type InspectResult,
  type CheckOptions,
  type CheckResult,
  type VerifyOptions,
  type GitGuardEngine,
} from '../../src/index.js';

describe('Milestone M0 Stress & Contract Soundness Verification', () => {
  describe('1. Version and Export Soundness', () => {
    it('should export GITGUARD_VERSION matching semver format', () => {
      expect(GITGUARD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(GITGUARD_VERSION).toBe('0.2.5');
    });
  });

  describe('2. Error Hierarchy Stress Testing', () => {
    const errorCases = [
      {
        Class: NotAGitRepositoryError,
        args: ['/nonexistent/repo'],
        expectedCode: 'NOT_A_GIT_REPOSITORY',
        expectedExitCode: 3,
        contains: '/nonexistent/repo',
      },
      {
        Class: NotAGitRepositoryError,
        args: [],
        expectedCode: 'NOT_A_GIT_REPOSITORY',
        expectedExitCode: 3,
        contains: 'Current working directory is not a Git repository',
      },
      {
        Class: GitExecutionError,
        args: ['git rev-parse HEAD', 'fatal: not a git repository'],
        expectedCode: 'GIT_EXECUTION_ERROR',
        expectedExitCode: 3,
        contains: 'git rev-parse HEAD',
        customCheck: (err: GitExecutionError) => {
          expect(err.command).toBe('git rev-parse HEAD');
          expect(err.stderr).toBe('fatal: not a git repository');
        },
      },
      {
        Class: ForbiddenGitOperationError,
        args: ['git push --force'],
        expectedCode: 'FORBIDDEN_GIT_OPERATION',
        expectedExitCode: 3,
        contains: 'git push --force',
      },
      {
        Class: InvalidGitRefError,
        args: ['origin/master..HEAD@{unknown}'],
        expectedCode: 'INVALID_GIT_REF',
        expectedExitCode: 3,
        contains: 'origin/master..HEAD@{unknown}',
      },
      {
        Class: ConfigurationError,
        args: ['Invalid YAML indentation at line 14'],
        expectedCode: 'CONFIGURATION_ERROR',
        expectedExitCode: 2,
        contains: 'Invalid YAML indentation at line 14',
      },
      {
        Class: PolicyEvaluationError,
        args: ['Rule circular dependency'],
        expectedCode: 'POLICY_EVALUATION_ERROR',
        expectedExitCode: 1,
        contains: 'Rule circular dependency',
      },
      {
        Class: SecurityViolationError,
        args: ['Command injection detected in run string'],
        expectedCode: 'SECURITY_VIOLATION',
        expectedExitCode: 2,
        contains: 'Command injection detected',
      },
      {
        Class: ProviderError,
        args: ['Rate limit exceeded (HTTP 429)', 'typesafe-jev'],
        expectedCode: 'PROVIDER_ERROR',
        expectedExitCode: 1,
        contains: 'typesafe-jev',
        customCheck: (err: ProviderError) => {
          expect(err.providerId).toBe('typesafe-jev');
        },
      },
      {
        Class: ProviderError,
        args: ['Network timeout'],
        expectedCode: 'PROVIDER_ERROR',
        expectedExitCode: 1,
        contains: 'unknown',
        customCheck: (err: ProviderError) => {
          expect(err.providerId).toBeUndefined();
        },
      },
      {
        Class: BudgetExceededError,
        args: ['Token count 125000 exceeds ceiling 100000'],
        expectedCode: 'BUDGET_EXCEEDED',
        expectedExitCode: 1,
        contains: 'Token count 125000',
      },
    ];

    for (const testCase of errorCases) {
      it(`should properly instantiate and type ${testCase.Class.name}`, () => {
        // @ts-expect-error test dynamic instantiation
        const err: GitGuardError = new testCase.Class(...testCase.args);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(GitGuardError);
        expect(err).toBeInstanceOf(testCase.Class);
        expect(err.name).toBe(testCase.Class.name);
        expect(err.code).toBe(testCase.expectedCode);
        expect(err.exitCode).toBe(testCase.expectedExitCode);
        expect(err.message).toContain(testCase.contains);
        if (testCase.customCheck) {
          testCase.customCheck(err as any);
        }
      });
    }

    it('should maintain proper prototype inheritance across catch blocks', () => {
      try {
        throw new SecurityViolationError('Path traversal detected');
      } catch (err) {
        expect(err instanceof SecurityViolationError).toBe(true);
        expect(err instanceof GitGuardError).toBe(true);
        expect(err instanceof Error).toBe(true);
        if (err instanceof GitGuardError) {
          expect(err.exitCode).toBe(2);
        }
      }
    });
  });

  describe('3. Discriminated Unions & Exhaustiveness Soundness', () => {
    it('should exhaustively match GateVerdict', () => {
      const verdicts: GateVerdict[] = ['PASS', 'WARN', 'REVIEW', 'BLOCK'];
      for (const v of verdicts) {
        let mapped = '';
        switch (v) {
          case 'PASS':
            mapped = 'pass';
            break;
          case 'WARN':
            mapped = 'warn';
            break;
          case 'REVIEW':
            mapped = 'review';
            break;
          case 'BLOCK':
            mapped = 'block';
            break;
          default: {
            const _exhaustive: never = v;
            throw new Error(`Unhandled verdict: ${_exhaustive}`);
          }
        }
        expect(mapped).toBeTruthy();
      }
    });

    it('should treat GateStatus and GateVerdict as strictly interchangeable', () => {
      const status: GateStatus = 'REVIEW';
      const verdict: GateVerdict = status;
      const backToStatus: GateStatus = verdict;
      expect(backToStatus).toBe('REVIEW');
    });

    it('should validate ChangeScope variants', () => {
      const scopes: ChangeScope[] = [
        'staged',
        'working-tree',
        'all',
        'commit',
        'range',
        'pull-request',
      ];
      expect(scopes).toHaveLength(6);
    });

    it('should validate FileChangeStatus variants', () => {
      const statuses: FileChangeStatus[] = [
        'added',
        'modified',
        'deleted',
        'renamed',
        'copied',
        'untracked',
      ];
      expect(statuses).toHaveLength(6);
    });

    it('should validate DiffLineType variants', () => {
      const lineTypes: DiffLineType[] = ['addition', 'deletion', 'context'];
      expect(lineTypes).toHaveLength(3);
    });

    it('should validate FindingSeverity, FindingStatus, and FindingLifecycleState', () => {
      const severities: FindingSeverity[] = ['INFO', 'WARN', 'ERROR', 'CRITICAL'];
      const statuses: FindingStatus[] = ['warn', 'review', 'block'];
      const lifecycles: FindingLifecycleState[] = ['active', 'resolved', 'suppressed'];

      expect(severities).toHaveLength(4);
      expect(statuses).toHaveLength(3);
      expect(lifecycles).toHaveLength(3);
    });

    it('should validate StandardQuestionId canonical list', () => {
      const questions: StandardQuestionId[] = [
        'task_completed',
        'task_scope_match',
        'unrelated_changes',
        'tests_required',
        'tests_present',
        'behavior_change',
        'security_sensitive_change',
        'breaking_change',
        'debug_leftovers',
        'regression_risk',
        'change_type',
      ];
      expect(questions).toHaveLength(11);
    });
  });

  describe('4. Complex Domain Object Type Assignability', () => {
    it('should construct and validate complete EvaluationContext', () => {
      const task: TaskContext = {
        task: 'Implement JWT refresh token rotation',
        taskPresent: true,
        keywords: ['jwt', 'refresh', 'token', 'rotation'],
        source: 'cli',
      };

      const diff: DiffContext = {
        raw: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+const TOKEN = 1;',
        files: [
          {
            oldPath: 'src/auth.ts',
            newPath: 'src/auth.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 0,
            hunks: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 4,
                header: '@@ -1,3 +1,4 @@',
                lines: ['+const TOKEN = 1;'],
              },
            ],
          },
        ],
        insertions: 1,
        deletions: 0,
        truncated: false,
        totalFiles: 1,
      };

      const fileContext: FileContext = {
        path: 'src/auth.ts',
        status: 'modified',
        binary: false,
        spans: [
          {
            startLine: 1,
            endLine: 4,
            code: 'const TOKEN = 1;',
          },
        ],
      };

      const instruction: InstructionContext = {
        sourcePath: 'AGENTS.md',
        scope: '/',
        content: '# Agent guidelines',
      };

      const testCtx: TestContext = {
        testPath: 'tests/auth.test.ts',
        relatedSourcePath: 'src/auth.ts',
        existsInWorkspace: true,
        modifiedInDiff: false,
      };

      const repo: RepositoryContext = {
        rootPath: 'C:/Users/LXT/Desktop/GitGuard',
        branch: 'main',
        headSha: 'a1b2c3d4e5f6',
        isClean: false,
        packageManager: 'pnpm',
      };

      const evidence: DeterministicResult[] = [
        {
          id: 'test',
          status: 'passed',
          exitCode: 0,
          durationMs: 450,
          summary: 'All 42 tests passed',
        },
      ];

      const context: EvaluationContext = {
        task,
        diff,
        files: [fileContext],
        instructions: [instruction],
        relatedTests: [testCtx],
        repository: repo,
        evidence,
        createdAt: new Date().toISOString(),
      };

      expect(context.task?.task).toBe('Implement JWT refresh token rotation');
      expect(context.diff.files[0].additions).toBe(1);
      expect(context.evidence[0].status).toBe('passed');
    });

    it('should construct and validate complete Finding and VerificationReport', () => {
      const finding: Finding = {
        id: 'finding_tests_required_01',
        ruleId: 'tests_required',
        source: 'policy',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        probability: 0.95,
        affectedFiles: ['src/auth.ts'],
        message: 'Security sensitive change requires unit tests',
        evidence: [
          {
            type: 'missing_test',
            path: 'tests/auth.test.ts',
            message: 'No corresponding test file updated',
          },
        ],
        expectedEvidence: ['Add test coverage for token refresh logic'],
        fingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        createdAt: '2026-09-20T00:00:00Z',
      };

      const report: VerificationReport = {
        status: 'BLOCK',
        verdictSummary: 'Blocked due to 1 critical finding',
        diffSummary: {
          filesChanged: 1,
          insertions: 10,
          deletions: 2,
        },
        findings: [finding],
        resolved: [],
        remaining: [finding.id],
        deterministicResults: [],
        semanticDecisions: {
          tests_required: {
            id: 'tests_required',
            probability: 0.95,
            provider: 'typesafe',
            rationale: 'Auth changes always require regression tests',
          },
        },
        metadata: {
          durationMs: 120,
          timestamp: '2026-09-20T00:00:00Z',
          gitRoot: 'C:/Users/LXT/Desktop/GitGuard',
          headSha: 'abc1234',
          cacheHit: false,
        },
      };

      expect(report.status).toBe('BLOCK');
      expect(report.findings).toHaveLength(1);
      expect(report.remaining).toContain(finding.id);
    });

    it('should construct and validate full PolicyConfig', () => {
      const policy: PolicyConfig = {
        version: 1,
        context: {
          max_diff_chars: 40000,
          max_total_chars: 80000,
          surrounding_lines: 30,
        },
        system_one: {
          provider: 'typesafe',
          model: 'jev',
          timeout_ms: 5000,
        },
        deterministic: {
          test: {
            enabled: true,
            run: 'pnpm test',
            block_on_failure: true,
          },
          secret_scan: {
            enabled: true,
            block_on_detection: true,
            patterns: ['AKIA[0-9A-Z]{16}'],
          },
        },
        rules: {
          task_completed: {
            enabled: true,
            review_below: 0.6,
            block_below: 0.2,
          },
          unrelated_changes: {
            enabled: true,
            warn: 0.4,
            review: 0.7,
            block: 0.9,
          },
        },
        custom_rules: [
          {
            id: 'no_console_logs',
            files: ['src/**/*.ts'],
            exclude: ['**/*.test.ts'],
            question: 'Does the diff contain console.log statements?',
            warn: 0.5,
          },
        ],
        privacy: {
          redact_secrets: true,
          exclude_paths: ['.env*', '**/*.pem'],
        },
      };

      expect(policy.version).toBe(1);
      expect(policy.deterministic?.test?.enabled).toBe(true);
      expect(policy.rules?.task_completed?.review_below).toBe(0.6);
      expect(policy.custom_rules?.[0].id).toBe('no_console_logs');
    });
  });

  describe('5. Component Interface Contract Soundness', () => {
    it('should implement GitGuardEngine interface without compilation error', async () => {
      class MockGitGuardEngine implements GitGuardEngine {
        async inspect(options: InspectOptions): Promise<InspectResult> {
          return {
            status: 'PASS',
            summary: { filesChanged: 0, insertions: 0, deletions: 0 },
            changedFiles: [],
            findings: [],
            hasDeterministicFailures: false,
          };
        }

        async check(options: CheckOptions): Promise<CheckResult> {
          return {
            status: 'PASS',
            verdictSummary: 'All checks passed',
            diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
            findings: [],
            resolved: [],
            remaining: [],
            deterministicResults: [],
            semanticDecisions: {},
            metadata: {
              durationMs: 10,
              timestamp: '2026-09-20T00:00:00Z',
              gitRoot: '/test',
              headSha: '000000',
              cacheHit: false,
            },
            exitCode: 0,
          };
        }

        async verify(options: VerifyOptions): Promise<VerificationReport> {
          return {
            status: 'PASS',
            verdictSummary: 'Verified',
            diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
            findings: [],
            resolved: options.findingIds ?? [],
            remaining: [],
            deterministicResults: [],
            semanticDecisions: {},
            metadata: {
              durationMs: 5,
              timestamp: '2026-09-20T00:00:00Z',
              gitRoot: '/test',
              headSha: '000000',
              cacheHit: false,
            },
          };
        }

        async getFindings(filter?: FindingFilter): Promise<Finding[]> {
          return [];
        }
      }

      const engine: GitGuardEngine = new MockGitGuardEngine();
      const inspectRes = await engine.inspect({});
      expect(inspectRes.status).toBe('PASS');

      const checkRes = await engine.check({});
      expect(checkRes.status).toBe('PASS');
      expect(checkRes.exitCode).toBe(0);

      const verifyRes = await engine.verify({ findingIds: ['f1'] });
      expect(verifyRes.resolved).toEqual(['f1']);
    });

    it('should implement ContextBuilder interface cleanly', async () => {
      class MockContextBuilder implements ContextBuilder {
        async buildContext(options: ContextBuildOptions): Promise<EvaluationContext> {
          return {
            diff: {
              raw: '',
              files: [],
              insertions: 0,
              deletions: 0,
              truncated: false,
            },
            files: [],
            instructions: [],
            relatedTests: [],
            repository: {
              rootPath: options.cwd ?? process.cwd(),
              branch: 'main',
              headSha: '123',
              isClean: true,
            },
            evidence: [],
          };
        }
      }

      const builder: ContextBuilder = new MockContextBuilder();
      const ctx = await builder.buildContext({ cwd: '/workspace' });
      expect(ctx.repository.rootPath).toBe('/workspace');
    });

    it('should implement DeterministicChecker cleanly', async () => {
      class MockDeterministicChecker implements DeterministicChecker {
        async run(context: EvaluationContext, config: DeterministicConfig): Promise<DeterministicResult[]> {
          return [
            {
              id: 'test',
              status: 'passed',
              exitCode: 0,
              durationMs: 15,
            },
          ];
        }
      }

      const checker: DeterministicChecker = new MockDeterministicChecker();
      const results = await checker.run({} as any, {});
      expect(results[0].status).toBe('passed');
    });

    it('should implement DecisionProvider cleanly', async () => {
      class MockDecisionProvider implements DecisionProvider {
        readonly name = 'mock-provider';

        async isAvailable(): Promise<boolean> {
          return true;
        }

        async evaluate(context: EvaluationContext, questions: SemanticQuestion[]): Promise<SemanticDecision[]> {
          return questions.map((q) => ({
            id: String(q.id),
            probability: 0.5,
            provider: this.name,
          }));
        }
      }

      const provider: DecisionProvider = new MockDecisionProvider();
      expect(await provider.isAvailable()).toBe(true);
      const res = await provider.evaluate({} as any, [
        { id: 'task_completed', type: 'boolean', prompt: 'Is task complete?' },
      ]);
      expect(res[0].probability).toBe(0.5);
    });

    it('should implement PolicyEngine cleanly', () => {
      class MockPolicyEngine implements PolicyEngine {
        evaluate(
          deterministicResults: DeterministicResult[],
          semanticDecisions: SemanticDecision[],
          policy: PolicyConfig,
          context: EvaluationContext
        ): PolicyEvaluationResult {
          return {
            verdict: 'PASS',
            summary: 'Passed',
            ruleMatches: [],
            findings: [],
            passedRules: ['rule1'],
            violatedRules: [],
          };
        }
      }

      const engine: PolicyEngine = new MockPolicyEngine();
      const res = engine.evaluate([], [], { version: 1 }, {} as any);
      expect(res.verdict).toBe('PASS');
    });

    it('should test GitAdapter implementation against PROJECT.md signature', async () => {
      class ProjectContractGitAdapter implements GitAdapter {
        async isGitRepository(cwd?: string): Promise<boolean> { return true; }
        async getRepositoryRoot(cwd?: string): Promise<string> { return '/test'; }
        async getStatus(cwd?: string): Promise<GitStatusSummary> {
          return {
            isRepo: true,
            rootPath: '/test',
            currentBranch: 'main',
            headSha: '123',
            isClean: true,
            stagedFiles: [],
            unstagedFiles: [],
            untrackedFiles: [],
          };
        }
        async getCurrentBranch(cwd?: string): Promise<string> { return 'main'; }
        async getHeadSha(cwd?: string): Promise<string> { return '123'; }
        async getDiff(scope: ChangeScope, options?: DiffOptions): Promise<string> { return ''; }
        async getStagedDiff(cwd?: string): Promise<string> { return ''; }
        async getWorkingTreeDiff(cwd?: string): Promise<string> { return ''; }
        async getChangedFiles(scope?: ChangeScope, options?: DiffOptions | string): Promise<ChangedFile[]> {
          if (typeof options === 'string') {
            return [{ path: 'foo.ts', status: 'modified', additions: 1, deletions: 0 }];
          }
          return [];
        }
        async getFileContent(filepath: string, ref?: string, cwd?: string): Promise<string | null> { return null; }
      }

      const adapter: GitAdapter = new ProjectContractGitAdapter();
      expect(await adapter.isGitRepository()).toBe(true);
      const changedWithCwd = await adapter.getChangedFiles('working', '/some/cwd');
      expect(changedWithCwd).toHaveLength(1);
    });

    it('should allow implementing FindingManager and IFindingManager contracts', () => {
      class TestFindingManager implements FindingManager {
        createFindings(ruleMatches: RuleMatch[], context: EvaluationContext): Finding[] {
          return [];
        }
        computeFingerprint(finding: Omit<Finding, 'id' | 'fingerprint'> | FindingFingerprintInput): string {
          return 'fingerprint_abc123';
        }
        resolveFindings(previousFindings: Finding[], freshFindings: Finding[]): VerificationReport {
          return {
            status: 'PASS',
            verdictSummary: 'Verified 0 findings',
            diffSummary: { files: 0, insertions: 0, deletions: 0 },
            findings: [],
            resolved: [],
            remaining: [],
            deterministicResults: [],
            semanticDecisions: {},
            metadata: {
              durationMs: 15,
              timestamp: new Date().toISOString(),
              gitRoot: '/repo',
              headSha: 'abc',
              cacheHit: false,
            },
          };
        }
      }

      const fm: IFindingManager = new TestFindingManager();
      expect(fm.computeFingerprint({ ruleId: 'r1', affectedFiles: ['a.ts'], normalizedDiffHunks: 'diff' })).toBe('fingerprint_abc123');
      const report = fm.resolveFindings([], []);
      expect(report.status).toBe('PASS');
    });

    it('should allow primitive: boolean in PolicyRule and CustomPolicyRule', () => {
      const rule: PolicyRule = {
        enabled: true,
        primitive: 'boolean',
        question: 'Are tests required?',
      };
      const customRule: CustomPolicyRule = {
        id: 'auth_tests',
        files: ['src/auth/**'],
        question: 'Are tests adequate?',
        primitive: 'boolean',
        warn: 0.7,
      };
      expect(rule.primitive).toBe('boolean');
      expect(customRule.primitive).toBe('boolean');
    });
  });

  describe('6. Boundary Conditions & Nullable Edge Cases', () => {
    it('should handle empty/unborn repository context safely', () => {
      const emptyRepo: RepositoryContext = {
        rootPath: 'C:/GitGuard',
        branch: 'HEAD',
        headSha: '',
        isClean: true,
      };
      expect(emptyRepo.headSha).toBe('');
      expect(emptyRepo.packageManager).toBeUndefined();
    });

    it('should handle absent task context gracefully', () => {
      const absentTask: TaskContext = {
        task: '',
        taskPresent: false,
        keywords: [],
      };
      expect(absentTask.taskPresent).toBe(false);
      expect(absentTask.keywords).toHaveLength(0);
      expect(absentTask.source).toBeUndefined();
    });

    it('should handle empty diff context without failure', () => {
      const emptyDiff: DiffContext = {
        raw: '',
        files: [],
        insertions: 0,
        deletions: 0,
        truncated: false,
        totalFiles: 0,
      };
      expect(emptyDiff.files).toHaveLength(0);
      expect(emptyDiff.truncated).toBe(false);
    });

    it('should support inverted threshold configurations for task completion', () => {
      const threshold: ThresholdConfig = {
        review_below: 0.60,
        block_below: 0.20,
      };
      expect(threshold.review_below).toBe(0.60);
      expect(threshold.block_below).toBe(0.20);
      expect(threshold.warn).toBeUndefined();
    });

    it('should support finding without optional fields', () => {
      const minimalFinding: Finding = {
        id: 'f_min_01',
        ruleId: 'r_min',
        source: 'deterministic',
        status: 'warn',
        severity: 'WARN',
        lifecycle: 'active',
        affectedFiles: [],
        message: 'Minimal warning',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'abcd1234',
        createdAt: '2026-09-20T00:00:00Z',
      };
      expect(minimalFinding.probability).toBeUndefined();
      expect(minimalFinding.resolvedAt).toBeUndefined();
      expect(minimalFinding.metadata).toBeUndefined();
    });
  });
});
