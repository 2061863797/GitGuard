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
} from '../../src/index.js';

describe('GitGuard Scaffolding & Core Types', () => {
  it('should export correct library version', () => {
    expect(GITGUARD_VERSION).toBe('0.2.0');
  });

  describe('Domain Error Hierarchy', () => {
    it('GitGuardError base properties', () => {
      const err = new GitGuardError('Generic error', 'CUSTOM_CODE', 1);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.name).toBe('GitGuardError');
      expect(err.message).toBe('Generic error');
      expect(err.code).toBe('CUSTOM_CODE');
      expect(err.exitCode).toBe(1);
    });

    it('NotAGitRepositoryError has exit code 3', () => {
      const err = new NotAGitRepositoryError('/test/path');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('NOT_A_GIT_REPOSITORY');
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain('/test/path');
    });

    it('GitExecutionError preserves command and stderr with exit code 3', () => {
      const err = new GitExecutionError('git diff', 'fatal: error');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('GIT_EXECUTION_ERROR');
      expect(err.exitCode).toBe(3);
      expect(err.command).toBe('git diff');
      expect(err.stderr).toBe('fatal: error');
      expect(err.message).toContain('git diff');
    });

    it('ForbiddenGitOperationError has exit code 3', () => {
      const err = new ForbiddenGitOperationError('git commit');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('FORBIDDEN_GIT_OPERATION');
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain('git commit');
    });

    it('InvalidGitRefError has exit code 3', () => {
      const err = new InvalidGitRefError('bad_ref');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('INVALID_GIT_REF');
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain('bad_ref');
    });

    it('ConfigurationError has exit code 2', () => {
      const err = new ConfigurationError('invalid yaml');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('CONFIGURATION_ERROR');
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain('invalid yaml');
    });

    it('PolicyEvaluationError has exit code 1', () => {
      const err = new PolicyEvaluationError('eval failed');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('POLICY_EVALUATION_ERROR');
      expect(err.exitCode).toBe(1);
    });

    it('SecurityViolationError has exit code 2', () => {
      const err = new SecurityViolationError('command injection detected');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('SECURITY_VIOLATION');
      expect(err.exitCode).toBe(2);
    });

    it('ProviderError has exit code 1 and retains providerId', () => {
      const err = new ProviderError('timeout', 'typesafe');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('PROVIDER_ERROR');
      expect(err.exitCode).toBe(1);
      expect(err.providerId).toBe('typesafe');
      expect(err.message).toContain('typesafe');
    });

    it('BudgetExceededError has exit code 1', () => {
      const err = new BudgetExceededError('diff exceeds 50000 chars');
      expect(err).toBeInstanceOf(GitGuardError);
      expect(err.code).toBe('BUDGET_EXCEEDED');
      expect(err.exitCode).toBe(1);
    });
  });
});
