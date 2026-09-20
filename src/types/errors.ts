/**
 * src/types/errors.ts
 * Strongly typed domain error hierarchy for GitGuard.
 */

/**
 * Base class for all GitGuard domain errors.
 */
export class GitGuardError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  constructor(message: string, code = 'GITGUARD_ERROR', exitCode = 1) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation is attempted in a directory that is not a Git repository.
 */
export class NotAGitRepositoryError extends GitGuardError {
  constructor(path?: string) {
    super(
      path
        ? `Directory is not a Git repository: ${path}`
        : 'Current working directory is not a Git repository',
      'NOT_A_GIT_REPOSITORY',
      3
    );
  }
}

/**
 * Thrown when a safe read-only Git subprocess command fails.
 */
export class GitExecutionError extends GitGuardError {
  public readonly command: string;
  public readonly stderr: string;

  constructor(command: string, stderr: string, exitCode = 3) {
    super(`Git command failed: ${command}\n${stderr}`, 'GIT_EXECUTION_ERROR', exitCode);
    this.command = command;
    this.stderr = stderr;
  }
}

/**
 * Thrown when an attempt is made to execute a mutating or forbidden Git command.
 */
export class ForbiddenGitOperationError extends GitGuardError {
  constructor(operation: string) {
    super(
      `Forbidden mutating Git operation: '${operation}'. GitGuard enforces strictly read-only repository access.`,
      'FORBIDDEN_GIT_OPERATION',
      3
    );
  }
}

/**
 * Thrown when an invalid Git commit hash, branch name, or revision range is provided.
 */
export class InvalidGitRefError extends GitGuardError {
  constructor(ref: string) {
    super(`Invalid Git reference or revision range: '${ref}'`, 'INVALID_GIT_REF', 3);
  }
}

/**
 * Thrown when .gitguard.yml is corrupt, contains invalid YAML, or fails schema validation.
 */
export class ConfigurationError extends GitGuardError {
  constructor(message: string) {
    super(`Configuration error: ${message}`, 'CONFIGURATION_ERROR', 2);
  }
}

/**
 * Thrown when policy evaluation encounters invalid rules or evaluation aborts.
 */
export class PolicyEvaluationError extends GitGuardError {
  constructor(message: string) {
    super(`Policy evaluation failed: ${message}`, 'POLICY_EVALUATION_ERROR', 1);
  }
}

/**
 * Thrown when command injection, arbitrary shell invocation, or prompt injection breaches are detected.
 */
export class SecurityViolationError extends GitGuardError {
  constructor(message: string) {
    super(`Security violation detected: ${message}`, 'SECURITY_VIOLATION', 2);
  }
}

/**
 * Thrown when an external semantic provider (TypeSafe/Jev) fails, times out, or receives bad credentials.
 */
export class ProviderError extends GitGuardError {
  public readonly providerId?: string;

  constructor(message: string, providerId?: string) {
    super(
      `Semantic provider error (${providerId ?? 'unknown'}): ${message}`,
      'PROVIDER_ERROR',
      1
    );
    this.providerId = providerId;
  }
}

/**
 * Thrown when context size exceeds unrecoverable memory or token budget ceilings.
 */
export class BudgetExceededError extends GitGuardError {
  constructor(message: string) {
    super(`Context budget exceeded: ${message}`, 'BUDGET_EXCEEDED', 1);
  }
}
