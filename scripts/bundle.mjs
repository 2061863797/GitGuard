#!/usr/bin/env node
/**
 * Bundles the MCP server and the commit hook into dependency-free ESM files shipped inside the plugins.
 * Plugin installs copy files without running a package manager, so the bundle is committed.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'plugins', 'gitguard', 'server');
const entries = [
  ['main.ts', 'gitguard-mcp.mjs'],
  ['hook.ts', 'gitguard-hook.mjs'],
];

for (const [entry, output] of entries) {
  await build({
    entryPoints: [path.join(repoRoot, 'src', entry)],
    outfile: path.join(serverDir, output),
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
}

process.stdout.write(`Bundled ${entries.map(([, output]) => output).join(', ')} into ${path.relative(repoRoot, serverDir)}\n`);
