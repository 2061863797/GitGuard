/**
 * src/analysis/semantic/questions.ts
 * Standard System One semantic evaluation questions for GitGuard.
 * Uses Noul (boolean probability), Choice (categorical selection), and Score (ranked level).
 */

import type {
  SemanticQuestion,
  StandardQuestionId,
  SemanticQuestionLevel,
  SemanticQuestionChoice,
} from '../../types/provider.js';

/**
 * Ordered risk levels for regression_risk evaluation.
 */
export const REGRESSION_RISK_LEVELS: SemanticQuestionLevel[] = [
  {
    name: 'negligible',
    description: 'Trivial or documentation-only change with no realistic failure modes',
    score: 0.1,
  },
  {
    name: 'low',
    description: 'Minor localized logic modification covered by automated tests',
    score: 0.3,
  },
  {
    name: 'medium',
    description: 'Moderate functional change touching multiple internal modules or interfaces',
    score: 0.6,
  },
  {
    name: 'high',
    description: 'Significant architectural alteration, core algorithm change, or broad refactor',
    score: 0.85,
  },
  {
    name: 'critical',
    description: 'Dangerous core subsystem modification with wide blast radius and high regression potential',
    score: 1.0,
  },
];

/**
 * Standard categories for changeset classification.
 */
export const CHANGE_TYPE_CHOICES: SemanticQuestionChoice[] = [
  { value: 'feature', description: 'New functionality or enhancement' },
  { value: 'bug_fix', description: 'Defect or issue remediation' },
  { value: 'refactor', description: 'Internal restructuring without behavioral alteration' },
  { value: 'test', description: 'Addition or modification of automated tests' },
  { value: 'documentation', description: 'Documentation, comments, or Markdown changes only' },
  { value: 'configuration', description: 'Build scripts, CI/CD, or repository configuration' },
  { value: 'security', description: 'Authentication, authorization, or cryptographic patch' },
  { value: 'mixed', description: 'Multi-faceted changeset spanning multiple categories' },
];

/**
 * Map of canonical MVP standard semantic evaluation questions.
 */
export const STANDARD_QUESTIONS_MAP: Record<StandardQuestionId, SemanticQuestion> = {
  task_completed: {
    id: 'task_completed',
    type: 'boolean',
    prompt: 'Does this code change completely fulfill the requirements specified in the task description?',
  },
  task_scope_match: {
    id: 'task_scope_match',
    type: 'boolean',
    prompt: 'Do the modified files and changed logic strictly adhere to the scope required by the task?',
  },
  unrelated_changes: {
    id: 'unrelated_changes',
    type: 'boolean',
    prompt: 'Does this diff contain meaningful changes that are unrelated or extraneous to the assigned task?',
  },
  tests_required: {
    id: 'tests_required',
    type: 'boolean',
    prompt: 'Does this behavioral modification introduce new functionality or logic alterations that require regression tests?',
  },
  tests_present: {
    id: 'tests_present',
    type: 'boolean',
    prompt: 'Are sufficient automated tests included in the changeset that exercise the newly added or modified behaviors?',
  },
  behavior_change: {
    id: 'behavior_change',
    type: 'boolean',
    prompt: 'Does this change alter observable program behavior, runtime semantics, or external outputs?',
  },
  security_sensitive_change: {
    id: 'security_sensitive_change',
    type: 'boolean',
    prompt: 'Does this change alter security-sensitive components (authentication, authorization, cryptography, token validation, permissions, data sanitization)?',
  },
  breaking_change: {
    id: 'breaking_change',
    type: 'boolean',
    prompt: 'Does this change break public APIs, database schemas, binary compatibility, or serialization contracts?',
  },
  debug_leftovers: {
    id: 'debug_leftovers',
    type: 'boolean',
    prompt: 'Does this diff contain leftover debugging code, console print statements, commented-out dead code, or temporary flags?',
  },
  regression_risk: {
    id: 'regression_risk',
    type: 'score',
    prompt: 'Rate the risk of unintended regression introduced by this change into the existing system.',
    levels: REGRESSION_RISK_LEVELS,
  },
  change_type: {
    id: 'change_type',
    type: 'choice',
    prompt: 'Select the primary category of this changeset.',
    choices: CHANGE_TYPE_CHOICES,
  },
};

/**
 * 10 MVP canonical semantic questions array in standard evaluation order.
 */
export const MVP_STANDARD_QUESTIONS: SemanticQuestion[] = [
  STANDARD_QUESTIONS_MAP.task_completed,
  STANDARD_QUESTIONS_MAP.task_scope_match,
  STANDARD_QUESTIONS_MAP.unrelated_changes,
  STANDARD_QUESTIONS_MAP.tests_required,
  STANDARD_QUESTIONS_MAP.tests_present,
  STANDARD_QUESTIONS_MAP.behavior_change,
  STANDARD_QUESTIONS_MAP.security_sensitive_change,
  STANDARD_QUESTIONS_MAP.breaking_change,
  STANDARD_QUESTIONS_MAP.debug_leftovers,
  STANDARD_QUESTIONS_MAP.regression_risk,
];

/**
 * Retrieves a standard semantic question definition by its ID.
 */
export function getStandardQuestion(id: StandardQuestionId): SemanticQuestion | undefined {
  return STANDARD_QUESTIONS_MAP[id];
}

/**
 * Returns all predefined standard questions including change_type classification.
 */
export function getAllStandardQuestions(): SemanticQuestion[] {
  return Object.values(STANDARD_QUESTIONS_MAP);
}
