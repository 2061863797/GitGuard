/**
 * src/core/index.ts
 * Barrel exports for the GitGuard Core Verification Engine.
 */

export * from './engine.js';
import { DefaultGitGuardEngine, type GitGuardEngineDependencies } from './engine.js';
import type { GitGuardEngine } from '../types/engine.js';

/**
 * Creates and initializes a new GitGuardEngine instance with optional dependency overrides.
 */
export function createEngine(deps?: GitGuardEngineDependencies): GitGuardEngine {
  return new DefaultGitGuardEngine(deps);
}
