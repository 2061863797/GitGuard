/**
 * src/policy/engine.ts
 * DefaultPolicyEngine implementing the PolicyEngine interface for GitGuard.
 * Evaluates deterministic outputs, semantic System One decisions, and custom repository rules
 * to synthesize definitive gate verdicts adhering to worst-case hierarchy: BLOCK > REVIEW > WARN > PASS.
 */

import type {
  GateVerdict,
  PolicyConfig,
  PolicyEngine,
  PolicyEvaluationResult,
  RuleMatch,
} from '../types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../types/provider.js';
import type { EvaluationContext } from '../types/context.js';
import type { FindingManager } from '../types/finding.js';
import { DefaultFindingManager } from '../findings/manager.js';
import {
  evaluateDeterministicCheck,
  evaluateSemanticRuleMatch,
  filterMatchingFiles,
  getEffectiveBuiltinRule,
  synthesizeGateVerdict,
} from './rules.js';

/**
 * Standard list of built-in semantic rule identifiers.
 */
const BUILTIN_RULE_IDS = [
  'task_completed',
  'unrelated_changes',
  'tests_required',
  'security_sensitive',
  'regression_risk',
];

/**
 * Default implementation of PolicyEngine.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  constructor(private readonly findingManager: FindingManager = new DefaultFindingManager()) {}

  /**
   * Synthesizes an overall GateVerdict from any collection of items.
   * Adheres strictly to worst-case hierarchy: BLOCK > REVIEW > WARN > PASS.
   */
  public synthesizeVerdict(
    items: Array<RuleMatch | any>
  ): GateVerdict {
    return synthesizeGateVerdict(items);
  }

  /**
   * Evaluates deterministic results and semantic decisions against policy configuration and repository context.
   */
  public evaluate(
    deterministicResults: DeterministicResult[],
    semanticDecisions: SemanticDecision[],
    policy: PolicyConfig,
    context: EvaluationContext
  ): PolicyEvaluationResult {
    const ruleMatches: RuleMatch[] = [];
    const passedRulesSet = new Set<string>();
    const violatedRulesSet = new Set<string>();

    const changedFiles = (context.diff?.files || []).map((f) => f.newPath || f.oldPath || '');
    const hasDeterministicFailures = (deterministicResults || []).some((r) => r.status === 'failed');
    const isDiffEmpty =
      (!context.diff || (!context.diff.raw?.trim() && changedFiles.length === 0)) &&
      !hasDeterministicFailures;

    // Short-circuit on completely empty repository changeset
    if (isDiffEmpty) {
      return {
        verdict: 'PASS',
        summary: 'Clean changeset with zero modifications. Gate verdict: PASS.',
        ruleMatches: [],
        findings: [],
        passedRules: (deterministicResults || [])
          .filter((r) => r.status === 'passed')
          .map((r) => `deterministic.${r.id}`),
        violatedRules: [],
      };
    }

    // 1. Evaluate deterministic check outputs
    if (deterministicResults && deterministicResults.length > 0) {
      for (const res of deterministicResults) {
        const match = evaluateDeterministicCheck(res, policy, context);
        if (match) {
          ruleMatches.push(match);
          violatedRulesSet.add(match.ruleId);
        } else {
          // If check did not fail and was enabled, record as passed
          passedRulesSet.add(`deterministic.${res.id}`);
        }
      }
    }

    // 2. Index semantic decisions by ID for fast lookup
    const decisionMap = new Map<string, SemanticDecision>();
    if (semanticDecisions && semanticDecisions.length > 0) {
      for (const decision of semanticDecisions) {
        decisionMap.set(decision.id, decision);
      }
    }

    // 3. Evaluate built-in standard rules
    for (const ruleId of BUILTIN_RULE_IDS) {
      const effectiveRule = getEffectiveBuiltinRule(ruleId, policy);
      if (!effectiveRule) {
        continue;
      }

      // Check task requirement constraint for task_completed
      if (ruleId === 'task_completed') {
        const hasTask = context.task && context.task.task && context.task.task.trim().length > 0;
        if (!hasTask) {
          // Without task description, task_completed rule is treated as clean / satisfied
          passedRulesSet.add(ruleId);
          continue;
        }
      }

      // Lookup decision by canonical ID or alias
      const decision =
        decisionMap.get(ruleId) ||
        (ruleId === 'security_sensitive' ? decisionMap.get('security_sensitive_change') : undefined);

      if (decision) {
        const match = evaluateSemanticRuleMatch(decision, effectiveRule, context);
        if (match) {
          ruleMatches.push(match);
          violatedRulesSet.add(ruleId);
        } else {
          passedRulesSet.add(ruleId);
        }
      }
    }

    // 4. Evaluate custom repository rules
    if (policy.custom_rules && Array.isArray(policy.custom_rules)) {
      for (const customRule of policy.custom_rules) {
        if (customRule.enabled === false) {
          continue;
        }

        // Check if any changed files match the custom rule's glob filters
        const matchedFiles = filterMatchingFiles(
          changedFiles,
          customRule.files,
          customRule.exclude
        );

        if (matchedFiles.length === 0) {
          // Rule is not applicable to current diff files; skip
          continue;
        }

        // Find matching semantic decision for this custom rule
        const decision =
          decisionMap.get(customRule.id) || decisionMap.get(customRule.question);

        if (decision) {
          const match = evaluateSemanticRuleMatch(
            decision,
            customRule,
            context,
            matchedFiles
          );

          if (match) {
            ruleMatches.push(match);
            violatedRulesSet.add(customRule.id);
          } else {
            passedRulesSet.add(customRule.id);
          }
        }
      }
    }

    // Ensure passed and violated sets are disjoint
    for (const violatedId of violatedRulesSet) {
      passedRulesSet.delete(violatedId);
    }

    // 5. Synthesize definitive gate verdict
    const verdict = synthesizeGateVerdict(ruleMatches);

    // 6. Generate structured findings via FindingManager
    const findings = this.findingManager.createFindings(ruleMatches, context);

    // 7. Compose verdict summary
    let summary: string;
    if (verdict === 'PASS') {
      summary = `Gate verdict: PASS. All ${passedRulesSet.size} evaluated check(s) and rule(s) passed cleanly.`;
    } else {
      const violatedList = Array.from(violatedRulesSet).join(', ');
      summary = `Gate verdict: ${verdict}. Detected ${ruleMatches.length} rule violation(s) [${violatedList}].`;
    }

    return {
      verdict,
      summary,
      ruleMatches,
      findings,
      passedRules: Array.from(passedRulesSet),
      violatedRules: Array.from(violatedRulesSet),
    };
  }
}
