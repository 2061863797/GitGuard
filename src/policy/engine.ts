/**
 * src/policy/engine.ts
 * DefaultPolicyEngine implementing the PolicyEngine interface for GitGuard.
 * Combines deterministic outputs with System One's judgments of the checked rules
 * and synthesizes the gate verdict using the worst-case hierarchy: BLOCK > REVIEW > WARN > PASS.
 */

import type {
  GateVerdict,
  PolicyConfig,
  PolicyEngine,
  PolicyEvaluationResult,
  RuleSpec,
  RuleMatch,
} from '../types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../types/provider.js';
import type { EvaluationContext } from '../types/context.js';
import type { FindingManager } from '../types/finding.js';
import { DefaultFindingManager } from '../findings/manager.js';
import {
  evaluateDeterministicCheck,
  evaluateRule,
  ruleAppliesTo,
  synthesizeGateVerdict,
} from './rules.js';

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
   * Evaluates deterministic results and System One's judgments of the checked rules.
   */
  public evaluate(
    deterministicResults: DeterministicResult[],
    semanticDecisions: SemanticDecision[],
    rules: RuleSpec[],
    policy: PolicyConfig,
    context: EvaluationContext
  ): PolicyEvaluationResult {
    const ruleMatches: RuleMatch[] = [];
    const passedRulesSet = new Set<string>();
    const violatedRulesSet = new Set<string>();
    const changedFiles = (context.diff?.files || []).map((f) => f.newPath || f.oldPath || '');

    // 1. Deterministic check outputs
    for (const res of deterministicResults || []) {
      const match = evaluateDeterministicCheck(res, policy, context);
      if (match) {
        ruleMatches.push(match);
        violatedRulesSet.add(match.ruleId);
      } else {
        passedRulesSet.add(`deterministic.${res.id}`);
      }
    }

    // 2. Judgments of agent and config rules
    const decisionMap = new Map((semanticDecisions || []).map((decision) => [decision.id, decision]));
    for (const rule of rules || []) {
      const decision = decisionMap.get(rule.id);
      const affectedFiles = ruleAppliesTo(rule, changedFiles);
      if (!decision || !affectedFiles) {
        continue;
      }
      const match = evaluateRule(decision, rule, affectedFiles);
      if (match) {
        ruleMatches.push(match);
        violatedRulesSet.add(rule.id);
      } else {
        passedRulesSet.add(rule.id);
      }
    }

    for (const violatedId of violatedRulesSet) {
      passedRulesSet.delete(violatedId);
    }

    const verdict = synthesizeGateVerdict(ruleMatches);
    const findings = ruleMatches.length > 0 ? this.findingManager.createFindings(ruleMatches, context) : [];

    let summary: string;
    if (verdict === 'PASS') {
      summary = !context.diff?.raw?.trim() && changedFiles.length === 0
        ? 'Clean changeset with zero modifications. Gate verdict: PASS.'
        : `Gate verdict: PASS. All ${passedRulesSet.size} evaluated check(s) and rule(s) passed.`;
    } else {
      const violatedList = Array.from(violatedRulesSet).join(', ');
      summary = `Gate verdict: ${verdict}. Detected ${ruleMatches.length} issue(s) [${violatedList}].`;
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
