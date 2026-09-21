/**
 * GitGuard - Repository-aware Change Verification & Quality Gate
 * Main Library Entrypoint
 */

export const GITGUARD_VERSION = '0.2.5';

export * from './types/index.js';
export * from './git/index.js';
export * from './context/index.js';
export * from './analysis/index.js';
export { DeterministicRunner } from './analysis/index.js';
export * from './policy/index.js';
export * from './findings/index.js';
export * from './core/index.js';
export * from './interfaces/index.js';

