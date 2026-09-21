/**
 * src/interfaces/mcp/tools.ts
 * MCP Tool definitions, JSON schemas, and execution handlers for GitGuard.
 * Strictly delegates to GitGuardEngine.
 */

import type { GitGuardEngine } from '../../types/engine.js';
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
      'Semantic evaluation determining whether code modifications genuinely complete the specified task intent, adhere to the expected scope, and avoid unrelated modifications.',
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
      'Full quality gate check before creating a git commit. Orchestrates deterministic checks (test, lint, typecheck, secrets), repository context, semantic checks, and policy rules into an authoritative gate verdict.',
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
      'Closed-loop verification tool for coding agents. After making remediation edits, the agent calls verify_findings with the IDs of previously reported findings to confirm whether they are now resolved.',
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
        });

        const taskCompProb =
          result.semanticDecisions?.task_completed?.probability ?? 1.0;
        const scopeMatchProb =
          result.semanticDecisions?.task_scope_match?.probability ?? 1.0;
        const unrelatedProb =
          result.semanticDecisions?.unrelated_changes?.probability ?? 0.0;

        const payload = {
          status: result.status,
          verdict: result.status,
          taskCompleted: taskCompProb,
          taskScopeMatch: scopeMatchProb,
          unrelatedChanges: unrelatedProb,
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
        });

        const canCommit = result.exitCode === 0;
        const deterministicMap: Record<string, string> = {};
        for (const det of result.deterministicResults || []) {
          deterministicMap[det.id] = det.status;
        }

        const payload = {
          status: result.status,
          verdict: result.status,
          canCommit,
          deterministic: deterministicMap,
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
        });

        const resolved = report.resolved || report.resolvedFindings || [];
        const remaining = report.remaining || report.remainingFindings || [];
        const allResolved = report.status === 'PASS' || remaining.length === 0;

        const payload = {
          status: report.status,
          verdict: report.status,
          resolved,
          remaining,
          allResolved,
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
