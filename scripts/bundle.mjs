#!/usr/bin/env node
/**
 * Bundles the MCP server into one dependency-free ESM file shipped inside the plugins.
 * Plugin installs copy files without running a package manager, so the bundle is committed.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'plugins', 'gitguard', 'server', 'gitguard-mcp.mjs');

await build({
  entryPoints: [path.join(repoRoot, 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
  // Bundled CommonJS dependencies may call require(); provide it in the ESM output.
  banner: {
    js: "import { createRequire as __gitguardCreateRequire } from 'node:module';\nconst require = __gitguardCreateRequire(import.meta.url);",
  },
});

process.stdout.write(`Bundled ${path.relative(repoRoot, outfile)}\n`);
