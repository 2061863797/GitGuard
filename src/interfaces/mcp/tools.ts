/**
 * src/interfaces/mcp/tools.ts
 * MCP Tool definitions, JSON schemas, and execution handlers for GitGuard.
 * Strictly delegates to GitGuardEngine.
 */

import type { GitGuardEngine } from '../../types/engine.js';
import type { SemanticDecision } from '../../types/provider.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Metadata and JSON schemas for the 4 GitGuard MCP tools.
 */
export const GITGUARD_MCP_TOOLS: Tool[] = [
  {
    name: 'inspect_changes',
    description:
      'Quickly inspect current repository code changes, file modifications, diff statistics, and initial findings without modifying repository state.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['staged', 'working', 'all', 'commit', 'range'],
          description: "Git change scope to inspect. Default: 'all'.",
        },
        target: {
          type: 'string',
          description: 'Target commit hash, branch name, or diff range (e.g. HEAD~1..HEAD).',
        },
        task: {
          type: 'string',
          description: 'Optional natural language description of task intent.',
        },
        cwd: {
          type: 'string',
          description: 'Repository working directory path.',
        },
      },
    },
  },
  {
    name: 'check_task_completion',
    description:
      'Online TypeSafe semantic evaluation of task completion and scope. Requires a TypeSafe API key; never uses local mock or fallback results.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The natural language requirement or task statement that must be verified.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'working', 'all', 'commit', 'range'],
          description: "Git change scope to evaluate. Default: 'all'.",
        },
        repoPath: {
          type: 'string',
          description: 'Optional path to target repository root.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'check_before_commit',
    description:
      'Full quality gate with deterministic checks and a fresh online TypeSafe semantic evaluation. Requires a TypeSafe API key; never uses local mock or fallback results.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Optional task intent describing the changes being committed.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'working', 'all'],
          description: "Git change scope to evaluate. Default: 'staged'.",
        },
        repoPath: {
          type: 'string',
          description: 'Optional repository path.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.',
        },
      },
    },
  },
  {
    name: 'verify_findings',
    description:
      'Verify finding resolution using a fresh online TypeSafe evaluation. Requires a TypeSafe API key; never uses local mock or fallback results.',
    inputSchema: {
      type: 'object',
      properties: {
        findingIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of finding IDs that the agent has attempted to resolve.',
        },
        task: {
          type: 'string',
          description: 'Optional task context.',
        },
        scope: {
          type: 'string',
          enum: ['staged', 'working', 'all', 'commit', 'range'],
          description: "Git change scope to evaluate during verification. Default: 'all'.",
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.',
        },
      },
      required: ['findingIds'],
    },
  },
];

function assertOnlineDecisions(decisions: Record<string, SemanticDecision>): void {
  const values = Object.values(decisions || {});
  if (values.length === 0 || values.some((decision) =>
    decision.provider !== 'typesafe' ||
    decision.metadata?.effectiveProvider !== 'typesafe' ||
    decision.metadata.fallback
  )) {
    throw new Error('TypeSafe online evaluation is required; GitGuard MCP rejects local mock and fallback results.');
  }
}

/**
 * Handles execution of MCP tool calls, delegating directly to GitGuardEngine.
 */
export async function executeMcpTool(
  name: string,
  args: Record<string, any> | undefined,
  engine: GitGuardEngine
): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  try {
    const params = args || {};

    switch (name) {
      case 'inspect_changes': {
        const result = await engine.inspect({
          scope: params.scope,
          target: params.target,
          task: params.task,
          cwd: params.cwd,
        });

        const payload = {
          status: result.status,
          summary: result.summary,
          files: result.changedFiles.map((f) => ({
            path: f.path || f.oldPath,
            status: f.status,
            insertions: f.additions,
            deletions: f.deletions,
          })),
          findings: result.findings,
          hasDeterministicFailures: result.hasDeterministicFailures,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      case 'check_task_completion': {
        if (!params.task || typeof params.task !== 'string') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: "Missing required parameter 'task' for check_task_completion",
              },
            ],
          };
        }

        const cwd = params.repoPath || params.cwd;
        const result = await engine.check({
          task: params.task,
          scope: params.scope ?? 'all',
          cwd,
          checkDeterministic: false,
          taskOnly: true,
          onlineOnly: true,
          noCache: true,
        });

        assertOnlineDecisions(result.semanticDecisions);

        const taskCompProb = result.semanticDecisions?.task_completed?.probability;
        const scopeMatchProb = result.semanticDecisions?.task_scope_match?.probability;
        const unrelatedProb = result.semanticDecisions?.unrelated_changes?.probability;
        if ([taskCompProb, scopeMatchProb, unrelatedProb].some((value) =>
          typeof value !== 'number' || !Number.isFinite(value)
        )) {
          throw new Error('TypeSafe response is missing a required task-completion probability.');
        }

        const decisions = Object.values(result.semanticDecisions || {});
        const firstDecision = decisions[0];
        const effectiveProvider = firstDecision?.metadata?.effectiveProvider ?? firstDecision?.provider;
        const fallback = firstDecision?.metadata?.fallback ?? false;
        const requestedProvider = firstDecision?.metadata?.requestedProvider ?? 'typesafe';
        const model = firstDecision?.metadata?.effectiveModel ?? 'jev-latest';

        const payload = {
          status: result.status,
          verdict: result.status,
          taskCompleted: taskCompProb,
          taskScopeMatch: scopeMatchProb,
          unrelatedChanges: unrelatedProb,
          semantic: {
            requestedProvider,
            effectiveProvider,
            fallback,
            model,
          },
          findings: result.findings,
          summary: result.verdictSummary,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      case 'check_before_commit': {
        const cwd = params.repoPath || params.cwd;
        const result = await engine.check({
          task: params.task,
          scope: params.scope ?? 'staged',
          cwd,
          onlineOnly: true,
          noCache: true,
        });
        assertOnlineDecisions(result.semanticDecisions);

        const canCommit = result.exitCode === 0;
        const deterministicMap: Record<string, string> = {};
        for (const det of result.deterministicResults || []) {
          deterministicMap[det.id] = det.status;
        }

        const decisions = Object.values(result.semanticDecisions || {});
        const firstDecision = decisions[0];
        const effectiveProvider = firstDecision?.metadata?.effectiveProvider ?? firstDecision?.provider;
        const fallback = firstDecision?.metadata?.fallback ?? false;
        const requestedProvider = firstDecision?.metadata?.requestedProvider ?? 'typesafe';
        const model = firstDecision?.metadata?.effectiveModel ?? 'jev-latest';

        const payload = {
          status: result.status,
          verdict: result.status,
          canCommit,
          deterministic: deterministicMap,
          semantic: {
            requestedProvider,
            effectiveProvider,
            fallback,
            model,
          },
          findings: result.findings,
          summary: result.verdictSummary,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      case 'verify_findings': {
        const rawIds = params.findingIds || params.findings;
        const findingIds = Array.isArray(rawIds)
          ? rawIds
          : typeof rawIds === 'string'
          ? rawIds.split(',').map((s) => s.trim())
          : [];

        if (findingIds.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: "Missing or empty required parameter 'findingIds' for verify_findings",
              },
            ],
          };
        }

        const report = await engine.verify({
          findingIds,
          task: params.task,
          scope: params.scope,
          cwd: params.cwd,
          onlineOnly: true,
          noCache: true,
        });
        if (!report.unknownFindings?.length) assertOnlineDecisions(report.semanticDecisions);

        const resolved = report.resolved || report.resolvedFindings || [];
        const remaining = report.remaining || report.remainingFindings || [];
        const unknownFindings = report.unknownFindings || [];
        const newFindings = report.newFindings || [];
        const targetsResolved = report.targetsResolved ?? (report.status === 'PASS' && remaining.length === 0 && unknownFindings.length === 0);
        const allResolved = report.allResolved ?? (targetsResolved && newFindings.length === 0);

        const payload = {
          status: report.status,
          verdict: report.status,
          targetsResolved,
          allResolved,
          resolved,
          remaining,
          unknownFindings,
          newFindings: newFindings.map((f) => ({
            id: f.id,
            ruleId: f.ruleId,
            status: f.status,
            severity: f.severity,
            message: f.message,
          })),
          summary: report.verdictSummary,
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      default:
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown tool name: "${name}"`,
            },
          ],
        };
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Tool execution failed (${name}): ${err.message || String(err)}`,
        },
      ],
    };
  }
}
