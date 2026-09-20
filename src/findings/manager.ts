/**
 * src/findings/manager.ts
 * DefaultFindingManager implementing FindingManager interface for GitGuard.
 * Handles structured finding instantiation, content-stable fingerprinting,
 * and re-verification resolution.
 */

import type {
  Finding,
  FindingFilter,
  FindingFingerprintInput,
  FindingManager,
  FindingStatus,
  VerificationReport,
} from '../types/finding.js';
import type { RuleMatch, GateVerdict } from '../types/policy.js';
import type { EvaluationContext } from '../types/context.js';
import {
  computeFindingFingerprint,
  extractHunksForFiles,
  normalizeAffectedFiles,
  normalizeHunk,
} from './fingerprint.js';
import { FindingStore, FileFindingStore, MemoryFindingStore } from './store.js';

/**
 * Calculates a match score between a fresh finding and a previous active finding.
 * High score (>= 0.70) indicates the finding refers to the same defect and should be tracked.
 */
function calculateFindingMatchScore(fresh: Finding, prev: Finding): number {
  if (fresh.fingerprint && prev.fingerprint && fresh.fingerprint === prev.fingerprint) {
    return 1.0;
  }

  let score = 0;
  const freshCleanRule = fresh.ruleId.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const prevCleanRule = (prev.ruleId || '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

  if (freshCleanRule === prevCleanRule) {
    score += 0.35;
  }

  // Check affected files overlap
  const freshFiles = new Set(fresh.affectedFiles || []);
  const prevFiles = new Set(prev.affectedFiles || []);
  let commonCount = 0;
  for (const f of freshFiles) {
    if (prevFiles.has(f)) commonCount++;
  }

  if (commonCount > 0) {
    if (freshFiles.size === prevFiles.size && commonCount === freshFiles.size) {
      score += 0.45;
    } else {
      score += 0.35;
    }
  }

  if (fresh.source && prev.source && fresh.source === prev.source) {
    score += 0.10;
  }

  return score;
}

/**
 * Returns standard actionable remediation instructions for a rule violation
 * if the originating evaluator did not supply custom expectedEvidence.
 */
export function getDefaultExpectedEvidence(ruleId: string, status: FindingStatus): string[] {
  const normalizedId = ruleId.toLowerCase();

  if (normalizedId.includes('test') && normalizedId.includes('deterministic')) {
    return [
      'Fix all failing tests reported in the execution output.',
      'Run the test command locally and ensure it exits with code 0.',
    ];
  }
  if (normalizedId.includes('lint')) {
    return [
      'Resolve all reported linting errors and formatting violations.',
      'Run the linter locally and confirm zero errors.',
    ];
  }
  if (normalizedId.includes('typecheck') || normalizedId.includes('tsc')) {
    return [
      'Fix TypeScript compiler errors and type mismatches.',
      'Ensure pnpm tsc --noEmit compiles cleanly with exit code 0.',
    ];
  }
  if (normalizedId.includes('secret')) {
    return [
      'Remove sensitive credentials, tokens, or private keys from the diff.',
      'Ensure secrets are stored in secure environment variables or vault systems.',
      'Rotate any secrets that were committed or staged.',
    ];
  }
  if (normalizedId.includes('task_completed')) {
    return [
      'Implement the missing requirements declared in the task specification.',
      'Ensure all acceptance criteria are demonstrably met by the changeset.',
    ];
  }
  if (normalizedId.includes('unrelated_changes')) {
    return [
      'Remove or isolate changes that are not directly relevant to the assigned task.',
      'Split tangential refactorings or file alterations into separate commits or PRs.',
    ];
  }
  if (normalizedId.includes('tests_required')) {
    return [
      'Add automated unit or integration tests that exercise the newly added or modified logic.',
      'Ensure the test suite passes cleanly.',
    ];
  }
  if (normalizedId.includes('security')) {
    return [
      'Perform a security review on authentication, cryptography, or permission modifications.',
      'Add security-focused regression tests validating authorization boundaries.',
    ];
  }
  if (normalizedId.includes('regression_risk')) {
    return [
      'Provide regression tests verifying backward compatibility.',
      'Check core public interfaces and verify that no unintended side-effects are introduced.',
    ];
  }

  return [
    `Remediate the policy violation identified by rule '${ruleId}'.`,
    `Ensure the gate status criteria (${status.toUpperCase()}) are satisfied.`,
  ];
}

/**
 * Synthesizes a GateVerdict from a list of findings using worst-case hierarchy:
 * BLOCK > REVIEW > WARN > PASS.
 */
function synthesizeFindingsVerdict(findings: Finding[]): GateVerdict {
  if (!findings || findings.length === 0) {
    return 'PASS';
  }

  let hasWarn = false;
  let hasReview = false;
  let hasBlock = false;

  for (const f of findings) {
    if (f.lifecycle !== 'active') continue;
    const s = (f.status || '').toLowerCase();
    if (s === 'block') {
      hasBlock = true;
    } else if (s === 'review') {
      hasReview = true;
    } else if (s === 'warn') {
      hasWarn = true;
    }
  }

  if (hasBlock) return 'BLOCK';
  if (hasReview) return 'REVIEW';
  if (hasWarn) return 'WARN';
  return 'PASS';
}

/**
 * Default implementation of FindingManager.
 */
export class DefaultFindingManager implements FindingManager {
  private findingsStore: Map<string, Finding> = new Map();
  private persistentStore?: FindingStore;

  constructor(options?: { store?: FindingStore; repoRoot?: string }) {
    if (options?.store) {
      this.persistentStore = options.store;
    } else if (options?.repoRoot) {
      this.persistentStore = new FileFindingStore(options.repoRoot);
    }
  }

  /**
   * Instantiates structured Finding objects from evaluated RuleMatch instances and context.
   */
  public createFindings(ruleMatches: RuleMatch[], context: EvaluationContext): Finding[] {
    if (!ruleMatches || ruleMatches.length === 0) {
      return [];
    }

    const createdFindings: Finding[] = [];
    const timestamp = new Date().toISOString();

    for (const match of ruleMatches) {
      const affectedFiles = normalizeAffectedFiles(match.affectedFiles);

      // Extract hunk text for the affected files from context if available
      let diffHunkText = '';
      if (context.diff?.files && context.diff.files.length > 0) {
        diffHunkText = extractHunksForFiles(affectedFiles, context.diff.files);
      }

      // Fallback to evidence snippets if diff hunk extraction is empty
      if (!diffHunkText && match.evidence && match.evidence.length > 0) {
        diffHunkText = match.evidence
          .map((e) => e.snippet || e.message || '')
          .filter(Boolean)
          .join('\n');
      }

      if (!diffHunkText) {
        diffHunkText = match.message || '';
      }

      const normalizedHunks = normalizeHunk(diffHunkText);
      const fingerprint = computeFindingFingerprint(match.ruleId, affectedFiles, normalizedHunks);
      const shortHash = fingerprint.slice(0, 8);
      const cleanRuleId = match.ruleId.replace(/[^a-zA-Z0-9_]/g, '_');
      const id = `finding_${cleanRuleId}_${shortHash}`;

      const expectedEvidence =
        match.expectedEvidence && match.expectedEvidence.length > 0
          ? match.expectedEvidence
          : getDefaultExpectedEvidence(match.ruleId, match.status);

      const finding: Finding = {
        id,
        ruleId: match.ruleId,
        source: match.source,
        status: match.status,
        severity: match.severity,
        lifecycle: 'active',
        probability: match.probability,
        affectedFiles,
        message: match.message,
        evidence: match.evidence || [],
        expectedEvidence,
        fingerprint,
        createdAt: timestamp,
        metadata: match.score !== undefined ? { score: match.score } : undefined,
      };

      this.findingsStore.set(finding.id, finding);
      createdFindings.push(finding);
    }

    return createdFindings;
  }

  /**
   * Computes a content-addressable SHA256 fingerprint for a finding or fingerprint input.
   */
  public computeFingerprint(
    finding: Omit<Finding, 'id' | 'fingerprint'> | FindingFingerprintInput
  ): string {
    if ('normalizedDiffHunks' in finding) {
      return computeFindingFingerprint(
        finding.ruleId,
        finding.affectedFiles,
        finding.normalizedDiffHunks
      );
    }

    // Extract diff snippet from evidence or message
    const snippetText = (finding.evidence || [])
      .map((e) => e.snippet || e.message || '')
      .filter(Boolean)
      .join('\n') || finding.message || '';

    return computeFindingFingerprint(
      finding.ruleId,
      finding.affectedFiles,
      normalizeHunk(snippetText)
    );
  }

  /**
   * Resolves previous findings against fresh findings to support verification loops.
   * Partitions findings into resolved, persistent, and new categories based on stable fingerprint matching.
   */
  public resolveFindings(
    previousFindings: Finding[],
    freshFindings: Finding[]
  ): VerificationReport {
    const remainingFindings: Finding[] = [];
    const remainingFindingIds: string[] = [];
    const resolvedFindingIds: string[] = [];
    const resolvedAt = new Date().toISOString();

    const matchedPrevIds = new Set<string>();
    const matchedFreshIndices = new Set<number>();

    // Pass 1: exact fingerprint, exact ID, or short hash match
    for (let i = 0; i < (freshFindings || []).length; i++) {
      const fresh = freshFindings[i];
      for (const prev of previousFindings || []) {
        if (matchedPrevIds.has(prev.id)) continue;
        const exactFp = prev.fingerprint && fresh.fingerprint && prev.fingerprint === fresh.fingerprint;
        const exactId = prev.id === fresh.id;
        const hashMatch =
          prev.fingerprint &&
          fresh.fingerprint &&
          (prev.fingerprint.startsWith(fresh.fingerprint.slice(0, 8)) ||
            fresh.fingerprint.startsWith(prev.fingerprint.slice(0, 8)));

        if (exactFp || exactId || hashMatch) {
          matchedPrevIds.add(prev.id);
          matchedFreshIndices.add(i);
          const persistentFinding: Finding = {
            ...fresh,
            id: prev.id,
            createdAt: prev.createdAt,
            lifecycle: 'active',
          };
          remainingFindings.push(persistentFinding);
          remainingFindingIds.push(prev.id);
          this.findingsStore.set(prev.id, persistentFinding);
          break;
        }
      }
    }

    // Pass 2: Weighted similarity match (ruleId + file overlap + source >= 0.70)
    for (let i = 0; i < (freshFindings || []).length; i++) {
      if (matchedFreshIndices.has(i)) continue;
      const fresh = freshFindings[i];

      let bestPrevMatch: Finding | null = null;
      let highestScore = 0;

      for (const prev of previousFindings || []) {
        if (matchedPrevIds.has(prev.id)) continue;
        const score = calculateFindingMatchScore(fresh, prev);

        if (score >= 0.70 && score > highestScore) {
          highestScore = score;
          bestPrevMatch = prev;
        }
      }

      if (bestPrevMatch) {
        matchedPrevIds.add(bestPrevMatch.id);
        matchedFreshIndices.add(i);
        const persistentFinding: Finding = {
          ...fresh,
          id: bestPrevMatch.id,
          createdAt: bestPrevMatch.createdAt,
          lifecycle: 'active',
        };
        remainingFindings.push(persistentFinding);
        remainingFindingIds.push(bestPrevMatch.id);
        this.findingsStore.set(bestPrevMatch.id, persistentFinding);
      }
    }

    // Any fresh findings that didn't match any previous finding are brand new findings
    for (let i = 0; i < (freshFindings || []).length; i++) {
      if (!matchedFreshIndices.has(i)) {
        const fresh = freshFindings[i];
        remainingFindings.push(fresh);
        remainingFindingIds.push(fresh.id);
        this.findingsStore.set(fresh.id, fresh);
      }
    }

    // Previous findings that were not matched by any active fresh finding are resolved!
    for (const prev of previousFindings || []) {
      if (!matchedPrevIds.has(prev.id)) {
        resolvedFindingIds.push(prev.id);
        const resolvedFinding: Finding = {
          ...prev,
          lifecycle: 'resolved',
          resolvedAt,
        };
        this.findingsStore.set(prev.id, resolvedFinding);
      }
    }

    // Persist finding state changes
    if (this.persistentStore) {
      const allToSave = [...remainingFindings];
      for (const prev of previousFindings || []) {
        if (!matchedPrevIds.has(prev.id)) {
          allToSave.push({
            ...prev,
            lifecycle: 'resolved',
            resolvedAt,
          });
        }
      }
      this.persistentStore.save(allToSave).catch(() => {});
    }

    // 3. Compute overall status from active remaining findings
    const overallStatus = synthesizeFindingsVerdict(remainingFindings);

    // 4. Generate verdict summary
    let verdictSummary: string;
    if (remainingFindings.length === 0) {
      verdictSummary =
        resolvedFindingIds.length > 0
          ? `All ${resolvedFindingIds.length} finding(s) successfully resolved. Gate status: PASS.`
          : 'All checks passed cleanly with 0 active findings. Gate status: PASS.';
    } else {
      verdictSummary = `Gate status: ${overallStatus}. ${remainingFindings.length} active finding(s) remaining (${resolvedFindingIds.length} resolved).`;
    }

    const report: VerificationReport = {
      status: overallStatus,
      verdictSummary,
      diffSummary: {
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      },
      findings: remainingFindings,
      resolved: resolvedFindingIds,
      remaining: remainingFindingIds,
      resolvedFindings: resolvedFindingIds,
      remainingFindings: remainingFindingIds,
      deterministicResults: [],
      semanticDecisions: {},
      metadata: {
        durationMs: 0,
        timestamp: new Date().toISOString(),
        gitRoot: process.cwd(),
        headSha: '',
        cacheHit: false,
      },
    };

    return report;
  }

  /**
   * Queries stored findings by filter criteria.
   */
  public getFindings(filter?: FindingFilter): Finding[] {
    const list = Array.from(this.findingsStore.values());
    if (!filter) {
      return list;
    }

    return list.filter((f) => {
      if (filter.ruleId && f.ruleId !== filter.ruleId) return false;
      if (filter.source && f.source !== filter.source) return false;
      if (filter.status && f.status !== filter.status) return false;
      if (filter.severity && f.severity !== filter.severity) return false;
      if (filter.lifecycle && f.lifecycle !== filter.lifecycle) return false;
      if (filter.file && !f.affectedFiles.includes(filter.file.replace(/\\/g, '/'))) return false;
      return true;
    });
  }

  /**
   * Asynchronously reads findings from the persistent store, refreshing internal memory.
   */
  public async loadPersistentFindings(filter?: FindingFilter): Promise<Finding[]> {
    if (this.persistentStore) {
      try {
        const persisted = await this.persistentStore.list(filter);
        for (const f of persisted) {
          if (!this.findingsStore.has(f.id)) {
            this.findingsStore.set(f.id, f);
          }
        }
      } catch {
        // ignore storage read errors
      }
    }
    return this.getFindings(filter);
  }

  /**
   * Manually adds or updates a finding in the internal store.
   */
  public storeFinding(finding: Finding): void {
    this.findingsStore.set(finding.id, finding);
    if (this.persistentStore) {
      this.persistentStore.save([finding]).catch(() => {});
    }
  }

  /**
   * Clears the internal findings store.
   */
  public clear(): void {
    this.findingsStore.clear();
  }
}
