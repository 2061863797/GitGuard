/**
 * MCP tool contracts and execution handlers for GitGuard.
 */
import * as path from 'node:path';
import { z } from 'zod';
import type { CallToolResult, TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GitGuardEngine } from '../../types/engine.js';
import { DefaultGitGuardEngine, MAX_AGENT_QUESTIONS } from '../../core/engine.js';
import type { ChangeScope } from '../../types/git.js';
import type { SemanticDecision } from '../../types/provider.js';
import type { Finding } from '../../types/finding.js';
import { redactSecrets } from '../../context/filter.js';
import { QUESTION_ID_PATTERN, QUESTION_LEVELS } from '../../policy/config.js';

/**
 * Rules every client sees, whether or not it loads the GitGuard skill.
 */
export const GITGUARD_SERVER_INSTRUCTIONS = [
  'GitGuard checks code changes in a Git repository before they are committed.',
  'Call check after finishing a task and before committing; call verify with the finding IDs after fixing them.',
  'check runs secret scanning plus the test/lint/typecheck commands configured in the repository .gitguard.yml,',
  'and asks TypeSafe System One yes/no questions: questions you pass in, plus questions from .gitguard.yml.',
  'Write 3-6 questions specific to this task and project, one concern each, phrased so that "yes" means a problem exists',
  '(e.g. "Does this change compute money with floating point?"). level is what a "yes" means: warn (mention it),',
  'review (the user must decide) or block (must not be committed). Questions require TYPESAFE_API_KEY; without questions no key is needed.',
  'BLOCK: fix the cause and verify. REVIEW: report to the user. WARN: mention it.',
  'Never delete or weaken questions, lower a level, or edit .gitguard.yml to make a check pass, and never commit past a BLOCK.',
].join(' ');

const changeScope = z.enum(['staged', 'working', 'all', 'commit', 'range']);
const text = z.string().trim().min(1);
const cwdField = text.describe('Absolute path of the Git repository to check. Required: the server does not run inside your project.');
const taskField = text.describe('Natural language description of the task the changes implement; sent to System One as context.');
const targetField = text.describe('Commit or complete base..head / base...head range. Required for commit/range; infers scope when omitted.').optional();
const scopeField = changeScope.describe('Default: all (staged + unstaged); a target infers commit/range.').optional();

const questionSchema = z.strictObject({
  id: z.string().regex(QUESTION_ID_PATTERN).describe('Stable id, [a-z0-9_], unique within the check and not used by .gitguard.yml.'),
  question: z.string().trim().min(1).max(1000).describe('Yes/no question in which "yes" means the problem exists.'),
  level: z.enum(QUESTION_LEVELS).describe('Finding level when the answer is yes: warn, review or block.'),
  files: z.array(text).optional().describe('Optional globs; the question is skipped when no changed file matches.'),
  exclude: z.array(text).optional().describe('Optional globs excluded from files.'),
});

const INPUT_SCHEMAS = {
  check: z.strictObject({
    cwd: cwdField,
    scope: scopeField,
    target: targetField,
    task: taskField.optional(),
    questions: z.array(questionSchema).max(MAX_AGENT_QUESTIONS)
      .describe(`Up to ${MAX_AGENT_QUESTIONS} task-specific yes/no questions. Omit to run only deterministic checks and .gitguard.yml questions.`)
      .optional(),
  }),
  verify: z.strictObject({
    cwd: cwdField,
    findingIds: z.array(text).min(1).describe('Finding IDs returned by an earlier check in this repository.'),
    scope: scopeField,
    target: targetField,
    task: taskField.optional(),
  }),
};

type ToolName = keyof typeof INPUT_SCHEMAS;
type ToolParameters = z.infer<(typeof INPUT_SCHEMAS)['check']> & Partial<z.infer<(typeof INPUT_SCHEMAS)['verify']>>;

const TOOL_METADATA: Record<ToolName, Pick<Tool, 'description' | 'annotations'>> = {
  check: {
    description: 'Run the GitGuard gate on changes in cwd: secret scan, the repository-configured test/lint/typecheck commands, ' +
      'and yes/no questions (yours plus .gitguard.yml) answered by TypeSafe System One. Returns PASS/WARN/REVIEW/BLOCK, ' +
      'canCommit and findings with IDs for verify. Executes trusted repository commands which may write files.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  verify: {
    description: 'Recheck finding IDs from an earlier check after fixing them. Re-runs the gate and re-asks the questions ' +
      'that produced those findings; unknown IDs return BLOCK before any command or API call.',
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

function parseArguments(name: ToolName, args: unknown): ToolParameters {
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
    throw new Error('Tool arguments must be an object.');
  }
  const input: Record<string, unknown> = { ...(args as Record<string, unknown> | undefined) };
  if (name === 'verify' && Array.isArray(input.findingIds)) {
    input.findingIds = [...new Set(input.findingIds.map((id) => typeof id === 'string' ? id.trim() : id))];
  }
  const parsed = INPUT_SCHEMAS[name].safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) =>
      (issue.path.join('.') || 'arguments') + ': ' + issue.message
    ).join('; '));
  }
  const params = parsed.data as ToolParameters;
  if (!path.isAbsolute(params.cwd)) {
    throw new Error('cwd must be an absolute path to the repository.');
  }
  const inferredScope = params.target?.includes('..') ? 'range' : 'commit';
  params.scope ??= params.target ? inferredScope : 'all';
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

function summarizeFinding(finding: Finding) {
  const question = finding.metadata?.question as { question?: string; source?: string } | undefined;
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    status: finding.status,
    source: finding.source,
    message: finding.message,
    affectedFiles: finding.affectedFiles,
    expectedEvidence: finding.expectedEvidence,
    ...(question ? { question: question.question, questionSource: question.source } : {}),
  };
}

function summarizeAnswers(decisions: Record<string, SemanticDecision>) {
  return Object.values(decisions).map((decision) => ({
    id: decision.id,
    probability: decision.probability,
    rationale: decision.rationale,
  }));
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
    if (name === 'check') {
      const result = await engine.check({
        cwd: params.cwd, scope: params.scope as ChangeScope | undefined, target: params.target, task: params.task, questions: params.questions,
      });
      return toolResult({
        status: result.status, canCommit: result.canCommit, summary: result.verdictSummary,
        deterministic: Object.fromEntries((result.deterministicResults || []).map((check) => [check.id, check.status])),
        answers: summarizeAnswers(result.semanticDecisions),
        findings: result.findings.map(summarizeFinding),
        diffSummary: result.diffSummary, metadata: result.metadata,
      });
    }
    const report = await engine.verify({
      cwd: params.cwd, findingIds: params.findingIds, scope: params.scope as ChangeScope | undefined, target: params.target, task: params.task,
    });
    const newFindings = report.newFindings || [];
    return toolResult({
      status: report.status, summary: report.verdictSummary,
      targetsResolved: report.targetsResolved ?? false, allResolved: report.allResolved ?? false,
      resolved: report.resolved || [], remaining: report.remaining || [], unknownFindings: report.unknownFindings || [],
      newFindings: newFindings.map(summarizeFinding),
      answers: summarizeAnswers(report.semanticDecisions),
      diffSummary: report.diffSummary, metadata: report.metadata,
    });
  } catch (error: unknown) {
    return toolError('TOOL_EXECUTION_FAILED', 'Tool execution failed (' + name + '): ' + (error instanceof Error ? error.message : String(error)));
  }
}
