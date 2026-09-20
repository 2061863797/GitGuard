/**
 * src/interfaces/cli/program.ts
 * Commander CLI program definition for GitGuard.
 */

import { Command } from 'commander';
import { GITGUARD_VERSION } from '../../index.js';
import { inspectCommand } from './inspect.js';
import { checkCommand } from './check.js';
import { findingsCommand } from './findings.js';
import { verifyCommand } from './verify.js';
import { mcpCommand } from './mcp.js';

/**
 * Builds and configures the Commander program with all GitGuard subcommands.
 */
export function createCliProgram(): Command {
  const program = new Command();

  program
    .name('gitguard')
    .description('Repository-aware change verification and quality gate system in TypeScript')
    .version(GITGUARD_VERSION, '-v, --version', 'Output the current GitGuard version');

  // 1. inspect
  program
    .command('inspect')
    .description('Inspect changed files, git diffs, and context')
    .option('-s, --scope <scope>', 'Git change scope to inspect (staged, working, all, commit, range)', 'all')
    .option('-t, --target <target>', 'Target commit hash, branch name, or diff range')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--json', 'Output results as formatted JSON')
    .option('--task <task>', 'Optional natural language description of task intent')
    .option('--check-deterministic', 'Run preliminary deterministic checks')
    .option('-c, --config <path>', 'Custom path to .gitguard.yml')
    .option('--cwd <path>', 'Repository working directory path')
    .action(async (options) => {
      const outcome = await inspectCommand(options);
      if (outcome.exitCode !== 0) {
        process.exitCode = outcome.exitCode;
      }
    });

  // 2. check
  program
    .command('check')
    .description('Run deterministic and semantic quality gates')
    .argument('[range]', 'Optional commit ref or range (e.g. HEAD~1..HEAD)')
    .option('--staged', 'Check only staged changes in git index')
    .option('--working', 'Check only unstaged changes in working tree')
    .option('--all', 'Check all uncommitted changes (staged + unstaged, default)')
    .option('-s, --scope <scope>', 'Git change scope (staged, working, all, commit, range)')
    .option('--task <task>', 'Natural language task intent for semantic evaluation')
    .option('-c, --config <path>', 'Custom path to .gitguard.yml')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--json', 'Output results as formatted JSON')
    .option('--strict', 'Treat WARN and REVIEW as strict blockers')
    .option('--fail-on-warn', 'Cause WARN verdict to yield non-zero exit code')
    .option('--offline', 'Force local offline/mock semantic provider')
    .option('--mock', 'Alias for --offline')
    .option('--require-semantic', 'Require live TypeSafe Jev provider; exit with code 2 if unavailable')
    .option('--no-cache', 'Bypass evaluation cache')
    .option('--findings <ids>', 'Comma-separated list of finding IDs to check')
    .option('--cwd <path>', 'Repository working directory path')
    .action(async (range, options) => {
      const outcome = await checkCommand(range, options);
      if (outcome.exitCode !== 0) {
        process.exitCode = outcome.exitCode;
      }
    });

  // 3. findings
  program
    .command('findings')
    .description('List active findings and severities')
    .option('--status <status>', 'Filter by finding status (warn, review, block)')
    .option('--severity <severity>', 'Filter by severity level (info, warn, error, critical)')
    .option('--file <path>', 'Filter by affected file path')
    .option('--rule <ruleId>', 'Filter by policy rule ID')
    .option('--lifecycle <state>', 'Filter by lifecycle state (active, resolved, suppressed)')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--json', 'Output results as formatted JSON')
    .option('--cwd <path>', 'Repository working directory path')
    .action(async (options) => {
      const outcome = await findingsCommand(options);
      if (outcome.exitCode !== 0) {
        process.exitCode = outcome.exitCode;
      }
    });

  // 4. verify
  program
    .command('verify')
    .description('Verify resolved findings against current changes')
    .option('--findings <ids>', 'Comma-separated list of finding IDs to verify')
    .option('--task <task>', 'Task context description')
    .option('-s, --scope <scope>', 'Git change scope (default: all)')
    .option('-c, --config <path>', 'Custom path to .gitguard.yml')
    .option('--format <format>', 'Output format (text, json)', 'text')
    .option('--json', 'Output results as formatted JSON')
    .option('--offline', 'Force local offline/mock semantic provider')
    .option('--cwd <path>', 'Repository working directory path')
    .action(async (options) => {
      const outcome = await verifyCommand(options);
      if (outcome.exitCode !== 0) {
        process.exitCode = outcome.exitCode;
      }
    });

  // 5. mcp
  program
    .command('mcp')
    .description('Launch the Model Context Protocol (MCP) server over stdio')
    .option('--debug', 'Enable debug diagnostic logs to stderr')
    .action(async (options) => {
      await mcpCommand(options);
    });

  return program;
}
