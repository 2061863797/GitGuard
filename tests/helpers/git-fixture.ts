/**
 * tests/helpers/git-fixture.ts
 * Temporary Git repository harness for testing Git CLI adapter and context builder.
 * Operates in os.tmpdir() with isolated repositories and automatic cleanup.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Normalizes file system paths to POSIX standard slashes.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Harness representing an isolated temporary Git repository.
 */
export class GitFixture {
  public readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /**
   * Returns posix-normalized path of the repo.
   */
  public get path(): string {
    return toPosix(this.repoPath);
  }

  /**
   * Executes a git command inside the temporary repository.
   */
  public async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const res = await execFileAsync('git', args, {
      cwd: this.repoPath,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: 'C',
      },
    });
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  }

  /**
   * Creates or overwrites a file inside the repository.
   */
  public async writeFile(relPath: string, content: string): Promise<void> {
    const fullPath = path.resolve(this.repoPath, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  /**
   * Writes raw binary buffer into the repository.
   */
  public async writeBinaryFile(relPath: string, buffer: Buffer): Promise<void> {
    const fullPath = path.resolve(this.repoPath, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
  }

  /**
   * Reads a file from the repository.
   */
  public async readFile(relPath: string): Promise<string> {
    const fullPath = path.resolve(this.repoPath, relPath);
    return fs.readFile(fullPath, 'utf-8');
  }

  /**
   * Deletes a file inside the repository.
   */
  public async deleteFile(relPath: string): Promise<void> {
    const fullPath = path.resolve(this.repoPath, relPath);
    await fs.unlink(fullPath);
  }

  /**
   * Stages files in the repository index.
   */
  public async stage(relPath?: string): Promise<void> {
    await this.exec(['add', relPath || '.']);
  }

  /**
   * Commits current staged changes with a commit message.
   * Returns the new commit SHA.
   */
  public async commit(message: string): Promise<string> {
    await this.exec(['commit', '-m', message]);
    const res = await this.exec(['rev-parse', 'HEAD']);
    return res.stdout.trim();
  }

  /**
   * Creates and checks out a new branch.
   */
  public async createBranch(branchName: string): Promise<void> {
    await this.exec(['checkout', '-b', branchName]);
  }

  /**
   * Checks out a branch, tag, or commit.
   */
  public async checkout(ref: string): Promise<void> {
    await this.exec(['checkout', ref]);
  }

  /**
   * Recursively removes the temporary repository directory with retries.
   */
  public async cleanup(): Promise<void> {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fs.rm(this.repoPath, { recursive: true, force: true });
        return;
      } catch {
        if (attempt === maxRetries) {
          // Gracefully ignore cleanup failure if file is locked on Windows
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }
}

/**
 * Creates a brand new temporary Git repository with safe defaults.
 */
export async function createTempGitRepo(prefix = 'gitguard-fixture-'): Promise<GitFixture> {
  const tmpBase = os.tmpdir();
  const repoDir = await fs.mkdtemp(path.join(tmpBase, prefix));
  const fixture = new GitFixture(repoDir);

  // Initialize repo
  await fixture.exec(['init']);
  await fixture.exec(['config', 'user.name', 'GitGuard Test']);
  await fixture.exec(['config', 'user.email', 'test@gitguard.local']);
  await fixture.exec(['config', 'commit.gpgSign', 'false']);
  await fixture.exec(['config', 'core.autocrlf', 'false']);

  return fixture;
}
