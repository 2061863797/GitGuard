import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { inject } = require('postject');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'dist-exe');
const bundlePath = path.join(outputDir, 'gitguard-bundle.cjs');
const configPath = path.join(outputDir, 'sea-config.json');
const blobPath = path.join(outputDir, 'gitguard.blob');
const exePath = path.join(outputDir, 'GitGuard.exe');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Windows x64 is required to build GitGuard.exe');
}
if (Number.parseInt(process.versions.node, 10) < 24) {
  throw new Error('Node.js 24 or newer is required to build GitGuard.exe');
}

await fs.mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, 'bin', 'gitguard.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
});

await fs.writeFile(configPath, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}), 'utf8');

execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});
await fs.copyFile(process.execPath, exePath);
await inject(exePath, 'NODE_SEA_BLOB', await fs.readFile(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

console.log('Built ' + exePath);
