/**
 * scripts/test-pack.mjs
 * End-to-end package distribution smoke test.
 * Packs the project into a tarball (.tgz), installs it in an isolated temporary directory,
 * and verifies CLI execution and ESM imports.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

async function run() {
  console.log('--- Starting Package Smoke Test ---');
  const pkgJsonRaw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
  const pkgJson = JSON.parse(pkgJsonRaw);
  const expectedVersion = pkgJson.version;
  console.log(`Target package version: ${expectedVersion}`);

  // Create isolated temp workspace
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-pack-test-'));
  console.log(`Isolated temp test directory: ${tempDir}`);

  let tarballPath = '';
  try {
    // 1. Pack tarball
    console.log('Packaging project with pnpm pack...');
    const packOutput = execSync(`pnpm pack --pack-destination "${tempDir}"`, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    console.log(`pnpm pack output: ${packOutput.trim()}`);

    // Find the generated .tgz in tempDir
    const files = await fs.readdir(tempDir);
    const tarball = files.find((f) => f.endsWith('.tgz'));
    if (!tarball) {
      throw new Error(`Tarball (.tgz) was not found in ${tempDir}`);
    }
    tarballPath = path.join(tempDir, tarball);
    console.log(`Generated tarball: ${tarballPath}`);

    // 2. Initialize fresh npm project in tempDir
    console.log('Initializing isolated project and installing tarball...');
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'pack-smoke-test', version: '1.0.0', type: 'module' }),
      'utf8'
    );

    execSync(`npm install "${tarballPath}"`, {
      cwd: tempDir,
      stdio: 'inherit',
    });

    // 3. Verify CLI execution in isolated directory
    console.log('Verifying CLI --version execution...');
    const cliBin = path.join(
      tempDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'gitguard.cmd' : 'gitguard'
    );
    const versionOutput = execSync(`"${cliBin}" --version`, {
      cwd: tempDir,
      encoding: 'utf8',
    }).trim();
    console.log(`CLI version output: ${versionOutput}`);
    if (versionOutput !== expectedVersion) {
      throw new Error(`CLI version mismatch! Expected: "${expectedVersion}", Got: "${versionOutput}"`);
    }

    // 4. Verify ESM module imports
    console.log('Verifying ESM package import...');
    execSync(
      `node -e "import('gitguard').then(m => { if (!m.DefaultGitGuardEngine) throw new Error('DefaultGitGuardEngine missing'); console.log('Successfully imported DefaultGitGuardEngine'); })"`,
      { cwd: tempDir, stdio: 'inherit' }
    );

    console.log('Verifying ESM subpath types import...');
    execSync(
      `node -e "import('gitguard/types').then(() => { console.log('Successfully resolved gitguard/types export'); })"`,
      { cwd: tempDir, stdio: 'inherit' }
    );

    console.log('✅ Package distribution smoke test PASSED successfully!');
  } finally {
    // Cleanup temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

run().catch((err) => {
  console.error('❌ Package smoke test FAILED:', err);
  process.exit(1);
});
