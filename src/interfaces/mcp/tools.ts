/**
 * MCP tool contracts and execution handlers for GitGuard.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { CallToolResult, TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GitGuardEngine } from '../../types/engine.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import type { ChangeScope } from '../../types/git.js';
import type { SemanticDecision } from '../../types/provider.js';
import { redactSecrets } from '../../context/filter.js';

const changeScope = z.enum(['staged', 'working', 'all', 'commit', 'range']);
const text = z.string().trim().min(1);
const repositoryFields = {
  cwd: text.describe('Repository working directory; defaults to the server working directory.').optional(),
  repoPath: text.describe('Alias for cwd. If both are supplied they must resolve to the same path.').optional(),
};
const taskField = text.describe('Natural language task intent.');
const targetField = text.describe('Commit or complete base..head / base...head range. Required for commit/range; infers scope when omitted.').optional();

const INPUT_SCHEMAS = {
  inspect_changes: z.strictObject({
    ...repositoryFields,
    scope: changeScope.describe('Default: all; a target infers commit/range.').optional(),
    target: targetField,
    task: taskField.optional(),
  }),
  check_task_completion: z.strictObject({
    ...repositoryFields,
    task: taskField,
    scope: changeScope.describe('Default: all; a target infers commit/range.').optional(),
    target: targetField,
  }),
  check_before_commit: z.strictObject({
    ...repositoryFields,
    task: taskField.optional(),
    scope: z.enum(['staged', 'working', 'all']).describe('Default: staged.').optional(),
  }),
  verify_findings: z.strictObject({
    ...repositoryFields,
    findingIds: z.array(text).min(1).describe('Non-empty finding IDs previously recorded in this repository.'),
    task: taskField.optional(),
    scope: changeScope.describe('Default: all; a target infers commit/range.').optional(),
    target: targetField,
  }),
};

type ToolName = keyof typeof INPUT_SCHEMAS;

const TOOL_METADATA: Record<ToolName, Pick<Tool, 'description' | 'annotations'>> = {
  inspect_changes: {
    description: 'Inspect changed files and diff statistics locally. Does not run project checks, scan secrets, contact a provider, or persist findings.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  check_task_completion: {
    description: 'Evaluate task completion, scope match and unrelated changes with a fresh online TypeSafe response. Does not run project checks; may persist findings. Requires a TypeSafe key and rejects mock/fallback results.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  check_before_commit: {
    description: 'Run the quality gate on staged changes by default. Executes trusted repository test/lint/typecheck commands which may write files, persists findings, and requires fresh online TypeSafe results.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  verify_findings: {
    description: 'Recheck finding IDs in this repository. Known IDs run project checks and fresh online TypeSafe evaluation and update finding state; unknown IDs return BLOCK before checks or online calls.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

/** Runtime validation and advertised schemas use the same definitions. */
export const GITGUARD_MCP_TOOLS: Tool[] = (Object.keys(INPUT_SCHEMAS) as ToolName[]).map((name) => ({
  name,
  ...TOOL_METADATA[name],
  inputSchema: z.toJSONSchema(INPUT_SCHEMAS[name]) as Tool['inputSchema'],
}));

export interface McpToolResult extends CallToolResult {
  content: TextContent[];
}

interface ToolParameters {
  task?: string;
  scope?: ChangeScope;
  target?: string;
  cwd?: string;
  repoPath?: string;
  findingIds?: string[];
}

function normalizeIds(value: unknown): unknown {
  const ids = typeof value === 'string' ? value.split(',') : value;
  return Array.isArray(ids)
    ? [...new Set(ids.map((id) => typeof id === 'string' ? id.trim() : id))]
    : ids;
}

function parseArguments(name: ToolName, args: unknown): ToolParameters {
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('Tool arguments must be an object.');
  }
  const input: Record<string, unknown> = { ...(args as Record<string, unknown> | undefined) };
  if (name === 'check_task_completion' && (typeof input.task !== 'string' || !input.task.trim())) {
    throw new Error("Missing required parameter 'task' for check_task_completion");
  }
  if (name === 'verify_findings') {
    const canonical = normalizeIds(input.findingIds);
    const alias = normalizeIds(input.findings);
    if (canonical !== undefined && canonical !== null && alias !== undefined &&
        JSON.stringify(canonical) !== JSON.stringify(alias)) {
      throw new Error("Conflicting 'findingIds' and legacy 'findings' parameters.");
    }
    input.findingIds = canonical ?? alias;
    delete input.findings;
    if (input.findingIds == null || (Array.isArray(input.findingIds) && input.findingIds.length === 0)) {
      throw new Error("Missing or empty required parameter 'findingIds' for verify_findings");
    }
  }
  const parsed = INPUT_SCHEMAS[name].safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) =>
      (issue.path.join('.') || 'arguments') + ': ' + issue.message
    ).join('; '));
  }
  const params: ToolParameters = parsed.data;
  if (params.cwd && params.repoPath) {
    const normalizePath = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (normalizePath(params.cwd) !== normalizePath(params.repoPath)) {
      throw new Error("Conflicting 'cwd' and 'repoPath'; supply one repository path.");
    }
  }
  params.cwd = params.repoPath ?? params.cwd;
  const inferredScope = params.target?.includes('..') ? 'range' : 'commit';
  params.scope ??= params.target ? inferredScope : name === 'check_before_commit' ? 'staged' : 'all';
  if (params.scope === 'commit' || params.scope === 'range') {
    if (!params.target) throw new Error("Scope '" + params.scope + "' requires a target.");
  }
  if (params.target) {
    if (params.scope !== inferredScope) throw new Error('Target does not match the selected scope.');
    const refs = params.target.split(/\.\.\.?/);
    if ((inferredScope === 'range' && (refs.length !== 2 || params.target.includes('....'))) ||
        refs.some((ref) => !ref || ref.startsWith('-') || /\s/.test(ref) ||
          [...ref].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
      throw new Error('Target must be a commit reference or a complete base..head / base...head range.');
    }
  }
  return params;
}

function redactToolData(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactToolData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactToolData(child)]));
  }
  return value;
}

function toolResult(payload: Record<string, unknown>): McpToolResult {
  const structuredContent = redactToolData(payload) as Record<string, unknown>;
  return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }] };
}

function toolError(code: string, message: string): McpToolResult {
  const safeMessage = redactSecrets(message);
  return { isError: true, structuredContent: { error: { code, message: safeMessage } },
    content: [{ type: 'text', text: safeMessage }] };
}

function assertOnlineDecisions(decisions: Record<string, SemanticDecision>): void {
  const values = Object.values(decisions || {});
  if (values.length === 0 || values.some((decision) =>
    decision.provider !== 'typesafe' || decision.metadata?.effectiveProvider !== 'typesafe' || decision.metadata.fallback
  )) {
    throw new Error('TypeSafe online evaluation is required; GitGuard MCP rejects local mock and fallback results.');
  }
}

function semanticSummary(decisions: Record<string, SemanticDecision>) {
  const first = Object.values(decisions)[0];
  return {
    requestedProvider: first?.metadata?.requestedProvider ?? 'typesafe',
    effectiveProvider: first?.metadata?.effectiveProvider ?? first?.provider,
    fallback: first?.metadata?.fallback ?? false,
    model: first?.metadata?.effectiveModel ?? null,
  };
}

/** Invalid arguments never reach repository commands or online providers. */
export async function executeMcpTool(name: string, args: unknown, engine: GitGuardEngine = new DefaultGitGuardEngine()): Promise<McpToolResult> {
  if (!Object.hasOwn(INPUT_SCHEMAS, name)) return toolError('UNKNOWN_TOOL', 'Unknown tool name: "' + name + '"');
  let params: ToolParameters;
  try {
    params = parseArguments(name as ToolName, args);
  } catch (error: unknown) {
    return toolError('INVALID_ARGUMENTS', 'Invalid arguments for ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
  try {
    switch (name) {
      case 'inspect_changes': {
        const result = await engine.inspect({ scope: params.scope, target: params.target, task: params.task, cwd: params.cwd });
        return toolResult({
          status: result.status, verdict: result.status, scope: params.scope, summary: result.summary,
          files: result.changedFiles.map((file) => ({ path: file.path || file.oldPath, status: file.status, insertions: file.additions, deletions: file.deletions })),
          findings: result.findings, hasDeterministicFailures: result.hasDeterministicFailures,
        });
      }
      case 'check_task_completion': {
        const result = await engine.check({
          task: params.task, scope: params.scope, target: params.target, cwd: params.cwd,
          checkDeterministic: false, taskOnly: true, onlineOnly: true, noCache: true,
        });
        assertOnlineDecisions(result.semanticDecisions);
        const taskCompleted = result.semanticDecisions.task_completed?.probability;
        const taskScopeMatch = result.semanticDecisions.task_scope_match?.probability;
        const unrelatedChanges = result.semanticDecisions.unrelated_changes?.probability;
        if ([taskCompleted, taskScopeMatch, unrelatedChanges].some((value) =>
          typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
        )) throw new Error('TypeSafe response is missing a required task-completion probability or it is outside [0, 1].');
        return toolResult({
          status: result.status, verdict: result.status, taskCompleted, taskScopeMatch, unrelatedChanges,
          semantic: semanticSummary(result.semanticDecisions), findings: result.findings, summary: result.verdictSummary,
          diffSummary: result.diffSummary, metadata: result.metadata,
        });
      }
      case 'check_before_commit': {
        const result = await engine.check({
          task: params.task, scope: params.scope, cwd: params.cwd, onlineOnly: true, noCache: true,
        });
        assertOnlineDecisions(result.semanticDecisions);
        return toolResult({
          status: result.status, verdict: result.status, canCommit: result.status !== 'BLOCK' && result.exitCode === 0,
          deterministic: Object.fromEntries((result.deterministicResults || []).map((check) => [check.id, check.status])),
          semantic: semanticSummary(result.semanticDecisions), findings: result.findings, summary: result.verdictSummary,
          diffSummary: result.diffSummary, metadata: result.metadata,
        });
      }
      case 'verify_findings': {
        const report = await engine.verify({
          findingIds: params.findingIds, task: params.task, scope: params.scope, target: params.target, cwd: params.cwd,
          onlineOnly: true, noCache: true,
        });
        if (!report.unknownFindings?.length) assertOnlineDecisions(report.semanticDecisions);
        const resolved = report.resolved || report.resolvedFindings || [];
        const remaining = report.remaining || report.remainingFindings || [];
        const unknownFindings = report.unknownFindings || [];
        const newFindings = report.newFindings || [];
        const targetsResolved = report.targetsResolved ?? (report.status === 'PASS' && remaining.length === 0 && unknownFindings.length === 0);
        const allResolved = report.allResolved ?? (targetsResolved && newFindings.length === 0);
        return toolResult({
          status: report.status, verdict: report.status, targetsResolved, allResolved, resolved, remaining, unknownFindings,
          newFindings: newFindings.map((finding) => ({ id: finding.id, ruleId: finding.ruleId, status: finding.status, severity: finding.severity, message: finding.message })),
          summary: report.verdictSummary, diffSummary: report.diffSummary, metadata: report.metadata,
        });
      }
      default:
        return toolError('UNKNOWN_TOOL', 'Unknown tool name: "' + name + '"');
    }
  } catch (error: unknown) {
    return toolError('TOOL_EXECUTION_FAILED', 'Tool execution failed (' + name + '): ' + (error instanceof Error ? error.message : String(error)));
  }
}
