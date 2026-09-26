import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { request } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { FileFindingStore } from '../../../src/findings/store.js';
import { startUiServer } from '../../../src/interfaces/ui/server.js';

const execFileAsync = promisify(execFile);

describe('local UI server', () => {
  let tempRoot: string;
  let configured: string;
  let unconfigured: string;
  let plain: string;
  let origin: string;
  let token: string;
  let server: Awaited<ReturnType<typeof startUiServer>>['server'];
  let selectedDirectory: string | null = null;

  async function post(route: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(origin + route, {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-GitGuard-Token': token,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-ui-'));
    configured = path.join(tempRoot, 'configured');
    unconfigured = path.join(tempRoot, 'unconfigured');
    plain = path.join(tempRoot, 'plain');
    await Promise.all([configured, unconfigured, plain].map((folder) => fs.mkdir(folder)));
    await Promise.all([configured, unconfigured].map((folder) => execFileAsync('git', ['init', '-q', folder])));
    await fs.writeFile(path.join(configured, '.gitguard.yaml'), 'version: 1\n', 'utf8');
    const running = await startUiServer({ cwd: configured, open: false, pickDirectory: async () => selectedDirectory });
    server = running.server;
    origin = new URL(running.url).origin;
    const page = await fetch(running.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    token = (await page.text()).match(/data-token="([a-f0-9]{64})"/)?.[1] ?? '';
    expect(token).toHaveLength(64);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!tempRoot) return;
    const [resolved, temp] = await Promise.all([fs.realpath(tempRoot), fs.realpath(os.tmpdir())]);
    const relative = path.relative(temp, resolved);
    if (!relative.startsWith('gitguard-ui-') || relative.includes(path.sep)) {
      throw new Error('Unexpected temporary UI fixture path: ' + resolved);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  afterEach(() => {
    selectedDirectory = null;
    vi.unstubAllEnvs();
  });

  it('classifies Git repositories by config presence', async () => {
    const response = await post('/api/directories', { path: tempRoot });
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { children: Array<{ name: string; isGitRoot: boolean; configFile: string | null }> } };
    expect(data.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'configured', isGitRoot: true, configFile: '.gitguard.yaml' }),
      expect.objectContaining({ name: 'unconfigured', isGitRoot: true, configFile: null }),
      expect.objectContaining({ name: 'plain', isGitRoot: false, configFile: null }),
    ]));
  });

  it('returns a selected repository or folder from the native picker', async () => {
    selectedDirectory = configured;
    const repository = await post('/api/pick-directory', {});
    expect(repository.status).toBe(200);
    const resolvedRepository = await fs.realpath(configured);
    expect((await repository.json()).data).toEqual({ path: resolvedRepository, repositoryRoot: resolvedRepository });

    selectedDirectory = plain;
    const folder = await post('/api/pick-directory', {});
    expect((await folder.json()).data).toEqual({ path: await fs.realpath(plain), repositoryRoot: null });

    selectedDirectory = null;
    const canceled = await post('/api/pick-directory', {});
    expect((await canceled.json()).data).toEqual({ path: null, repositoryRoot: null });
  });

  it('requires online TypeSafe for checks and rejects old offline requests', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    const offline = await post('/api/check', { cwd: configured, offline: true });
    expect(offline.status).toBe(400);
    expect((await offline.json()).error).toContain('只支持官方 TypeSafe 在线检查');

    const online = await post('/api/check', { cwd: configured, scope: 'staged' });
    expect(online.status).toBe(400);
    expect((await online.json()).error).toContain('TypeSafe API key is not configured');
  });

  it('requires online TypeSafe when verifying a saved finding', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    await new FileFindingStore(configured).save([{
      id: 'ui-online-finding', ruleId: 'task_completed', source: 'semantic',
      status: 'review', severity: 'ERROR', lifecycle: 'active',
      affectedFiles: [], message: 'Needs verification', evidence: [], expectedEvidence: [],
      fingerprint: 'ui-online-finding', createdAt: new Date().toISOString(),
    }]);
    const response = await post('/api/verify', {
      cwd: configured, scope: 'staged', findingIds: ['ui-online-finding'], task: 'Verify the saved finding',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('TypeSafe API key is not configured');
  });

  it('creates a valid config once and preserves existing config files', async () => {
    const original = await fs.readFile(path.join(configured, '.gitguard.yaml'), 'utf8');
    const existing = await post('/api/create-config', { cwd: configured });
    expect(existing.status).toBe(409);
    expect(await fs.readFile(path.join(configured, '.gitguard.yaml'), 'utf8')).toBe(original);
    expect(await fs.readdir(configured)).not.toContain('.gitguard.yml');

    const created = await post('/api/create-config', {
      cwd: unconfigured,
      testCommand: 'pnpm test',
      lintCommand: '',
      typecheckCommand: 'pnpm typecheck',
    });
    expect(created.status).toBe(200);
    const configPath = path.join(unconfigured, '.gitguard.yml');
    const content = await fs.readFile(configPath, 'utf8');
    const config = YAML.parse(content);
    expect(config.deterministic.test).toEqual({ enabled: true, run: 'pnpm test' });
    expect(config.deterministic.lint).toEqual({ enabled: false });
    expect(config.deterministic.typecheck).toEqual({ enabled: true, run: 'pnpm typecheck' });
    expect(config.deterministic.secret_scan).toEqual({ enabled: true, block_on_detection: true });
    expect(config.privacy).toEqual({ redact_secrets: true, include_full_files: false });

    const duplicate = await post('/api/create-config', { cwd: unconfigured, testCommand: 'echo changed' });
    expect(duplicate.status).toBe(409);
    expect(await fs.readFile(configPath, 'utf8')).toBe(content);
  });

  it('rejects invalid commands without writing a config', async () => {
    const repository = path.join(tempRoot, 'invalid-command');
    await fs.mkdir(repository);
    await execFileAsync('git', ['init', '-q', repository]);
    const response = await post('/api/create-config', { cwd: repository, testCommand: 'echo ok\necho unsafe' });
    expect(response.status).toBe(400);
    expect(await fs.readdir(repository)).not.toContain('.gitguard.yml');
  });

  it('requires the local origin and token for API calls', async () => {
    const body = { path: tempRoot };
    expect((await post('/api/directories', body, { Origin: 'https://example.com' })).status).toBe(403);
    expect((await post('/api/directories', body, { 'X-GitGuard-Token': 'wrong' })).status).toBe(403);
    const forbiddenHost = await new Promise<number>((resolve, reject) => {
      const req = request(origin + '/api/directories', {
        method: 'POST',
        headers: {
          Host: 'example.com',
          Origin: origin,
          'X-GitGuard-Token': token,
          'Content-Type': 'application/json',
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    expect(forbiddenHost).toBe(403);
  });
});
