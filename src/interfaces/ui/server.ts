import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { FileFindingStore } from '../../findings/store.js';
import { GitCLIAdapter } from '../../git/adapter.js';
import { CONFIG_FILE_NAMES, parseConfig } from '../../policy/config.js';
import { formatCheckText, formatFindingsText, formatInspectText, formatVerifyText } from '../cli/formatters.js';
import type { FindingFilter, FindingLifecycleState, FindingSeverity, FindingStatus } from '../../types/finding.js';
import type { ChangeScope } from '../../types/git.js';
import { APP_CSS, APP_HTML, APP_JS } from './page.js';

interface UiOptions {
  cwd?: string;
  port?: number | string;
  open?: boolean;
  pickDirectory?: () => Promise<string | null>;
}

interface UiServer {
  server: Server;
  url: string;
}

class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const scopes: ChangeScope[] = ['all', 'staged', 'working', 'commit', 'range'];
const maxRequestBytes = 16 * 1024;
const execFileAsync = promisify(execFile);

async function pickNativeDirectory(): Promise<string | null> {
  if (process.platform !== 'win32') throw new InputError('当前系统不支持原生文件夹选择器。');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目目录'
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024, encoding: 'utf8' });
  return stdout.trim() || null;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mcpCommandLine(): string {
  const entry = process.argv[1];
  if (entry?.endsWith('.ts')) {
    const projectRoot = path.resolve(path.dirname(entry), '..');
    return `pnpm --dir "${projectRoot}" gitguard mcp`;
  }
  const prefix = process.platform === 'win32' ? '& ' : '';
  if (entry && /^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    return `${prefix}"${process.execPath}" "${path.resolve(entry)}" mcp`;
  }
  return `${prefix}"${process.execPath}" mcp`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new InputError('请求必须使用 JSON 格式。', 415);
  }
  if (Number(req.headers['content-length'] ?? 0) > maxRequestBytes) {
    throw new InputError('请求内容过大。', 413);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxRequestBytes) throw new InputError('请求内容过大。', 413);
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value as Record<string, unknown>;
  } catch {
    throw new InputError('请求内容不是有效的 JSON 对象。');
  }
}

function textField(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new InputError(`${key} 格式无效。`);
  return value.trim();
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new InputError(`${key} 格式无效。`);
  return value;
}

function scopeFields(body: Record<string, unknown>): { scope: ChangeScope; target?: string } {
  const scope = textField(body, 'scope', 16) || 'all';
  if (!scopes.includes(scope as ChangeScope)) throw new InputError('检查范围无效。');
  const target = textField(body, 'target', 180);
  const needsTarget = scope === 'commit' || scope === 'range';
  if (needsTarget && !target) throw new InputError('指定提交或范围时需要填写目标。');
  if (!needsTarget && target) throw new InputError('当前检查范围不需要目标。');
  if (target && (!/^[A-Za-z0-9_][A-Za-z0-9_./^~+-]*$/.test(target) ||
      (scope === 'range' && !target.includes('..')) ||
      (scope === 'commit' && target.includes('..')))) {
    throw new InputError('目标只能使用安全的 Git 引用或提交范围。');
  }
  return { scope: scope as ChangeScope, ...(target ? { target } : {}) };
}

function findingIds(body: Record<string, unknown>): string[] | undefined {
  const value = body.findingIds;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some(
    (item) => typeof item !== 'string' || item.length > 200 || !/^[A-Za-z0-9_:.-]+$/.test(item)
  )) throw new InputError('问题 ID 列表无效。');
  return [...new Set(value as string[])];
}

function findingFilter(body: Record<string, unknown>): FindingFilter {
  const status = textField(body, 'filterStatus', 16);
  const severity = textField(body, 'filterSeverity', 16);
  const lifecycle = textField(body, 'filterLifecycle', 16);
  if (status && !['warn', 'review', 'block'].includes(status)) throw new InputError('问题状态筛选无效。');
  if (severity && !['INFO', 'WARN', 'ERROR', 'CRITICAL'].includes(severity)) throw new InputError('严重程度筛选无效。');
  if (lifecycle && !['active', 'resolved', 'suppressed'].includes(lifecycle)) throw new InputError('问题生命周期筛选无效。');
  return {
    ...(status ? { status: status as FindingStatus } : {}),
    ...(severity ? { severity: severity as FindingSeverity } : {}),
    ...(lifecycle ? { lifecycle: lifecycle as FindingLifecycleState } : {}),
    ...(textField(body, 'filterFile', 1024) ? { file: textField(body, 'filterFile', 1024) } : {}),
    ...(textField(body, 'filterRule', 200) ? { ruleId: textField(body, 'filterRule', 200) } : {}),
  };
}

async function repositoryRoot(body: Record<string, unknown>): Promise<string> {
  const cwd = textField(body, 'cwd', 2048);
  if (!cwd || !path.isAbsolute(cwd)) throw new InputError('请填写 Git 仓库的绝对路径。');
  return new GitCLIAdapter().getRepositoryRoot(cwd);
}


async function existingConfig(root: string): Promise<string | null> {
  for (const name of CONFIG_FILE_NAMES) {
    try {
      await fs.lstat(path.join(root, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function browseDirectories(body: Record<string, unknown>): Promise<unknown> {
  const requested = textField(body, 'path', 2048);
  if (!requested || !path.isAbsolute(requested)) throw new InputError('请选择绝对目录路径。');
  const directory = await fs.realpath(requested);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules')
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  const children = await Promise.all(names.slice(0, 300).map(async (name) => {
    const folder = path.join(directory, name);
    try {
      const [isGitRoot, configFile] = await Promise.all([hasGitMarker(folder), existingConfig(folder)]);
      return { name, path: folder, isGitRoot, configFile };
    } catch {
      return { name, path: folder, isGitRoot: false, configFile: null };
    }
  }));
  return { path: directory, parent: path.dirname(directory), children, truncated: names.length > 300 };
}

async function createConfig(root: string, body: Record<string, unknown>): Promise<unknown> {
  const found = await existingConfig(root);
  if (found) throw new InputError('仓库已经存在 ' + found + '，不会覆盖。', 409);
  const test = textField(body, 'testCommand', 500);
  const lint = textField(body, 'lintCommand', 500);
  const typecheck = textField(body, 'typecheckCommand', 500);
  for (const command of [test, lint, typecheck]) {
    if (/[\r\n\0]/.test(command)) throw new InputError('检查命令不能包含换行或空字符。');
  }
  const config = {
    version: 1,
    deterministic: {
      test: { enabled: Boolean(test), ...(test ? { run: test } : {}) },
      lint: { enabled: Boolean(lint), ...(lint ? { run: lint } : {}) },
      typecheck: { enabled: Boolean(typecheck), ...(typecheck ? { run: typecheck } : {}) },
      secret_scan: { enabled: true, block_on_detection: true },
    },
    privacy: { redact_secrets: true, include_full_files: false },
  };
  const content = '# GitGuard repository configuration\n' + YAML.stringify(config);
  parseConfig(content);
  const configPath = path.join(root, '.gitguard.yml');
  let created = false;
  try {
    const file = await fs.open(configPath, 'wx');
    created = true;
    try {
      await file.writeFile(content, 'utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (created) await fs.unlink(configPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new InputError('配置文件已存在，不会覆盖。', 409);
    }
    throw error;
  }
  return { path: configPath, configFile: '.gitguard.yml' };
}

async function runAction(
  route: string,
  body: Record<string, unknown>,
  pickDirectory: () => Promise<string | null>
): Promise<{ data: unknown; text?: string }> {
  if (route === '/api/directories') return { data: await browseDirectories(body) };
  if (route === '/api/pick-directory') {
    const selected = await pickDirectory();
    if (!selected) return { data: { path: null, repositoryRoot: null } };
    const selectedPath = await fs.realpath(selected);
    const git = new GitCLIAdapter();
    const repositoryRoot = await git.isGitRepository(selectedPath)
      ? path.resolve(await git.getRepositoryRoot(selectedPath))
      : null;
    return { data: { path: selectedPath, repositoryRoot } };
  }
  const cwd = await repositoryRoot(body);
  if (route === '/api/status') {
    const [status, configFile] = await Promise.all([new GitCLIAdapter().getStatus(cwd), existingConfig(cwd)]);
    return { data: { ...status, configFile } };
  }
  if (route === '/api/create-config') return { data: await createConfig(cwd, body) };
  if (route === '/api/findings') {
    const data = await new FileFindingStore(cwd).list(findingFilter(body));
    return { data, text: formatFindingsText(data) };
  }
  const { scope, target } = scopeFields(body);
  const engine = new DefaultGitGuardEngine();
  const task = textField(body, 'task', 2000) || undefined;
  const configPath = textField(body, 'configPath', 2048) || undefined;
  if (route === '/api/inspect') {
    const data = await engine.inspect({ cwd, scope, target, task, configPath, checkDeterministic: boolField(body, 'checkDeterministic', false) });
    return { data, text: formatInspectText(data, scope) };
  }
  if (boolField(body, 'offline', false) || boolField(body, 'allowCustomProvider', false)) {
    throw new InputError('界面只支持官方 TypeSafe 在线检查。');
  }
  if (route === '/api/check') {
    const data = await engine.check({
      cwd, scope, target, task, configPath, onlineOnly: true, noCache: true,
      strict: boolField(body, 'strict', false),
      failOnWarn: boolField(body, 'failOnWarn', false),
      findingIds: findingIds(body),
    });
    return { data, text: formatCheckText(data) };
  }
  if (route === '/api/verify') {
    if (target || scope === 'commit' || scope === 'range') throw new InputError('复验只支持未提交改动范围。');
    const data = await engine.verify({
      cwd,
      scope,
      task,
      configPath,
      onlineOnly: true,
      noCache: true,
      findingIds: findingIds(body),
      targetOnly: boolField(body, 'targetOnly', false),
    });
    return { data, text: formatVerifyText(data) };
  }
  throw new InputError('未知操作。', 404);
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => process.stderr.write('无法自动打开浏览器，请复制上方地址。\n'));
  child.unref();
}

export async function startUiServer(options: UiOptions = {}): Promise<UiServer> {
  const initialCwd = path.resolve(options.cwd ?? process.cwd());
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InputError('端口必须在 0 到 65535 之间。');
  const token = randomBytes(32).toString('hex');
  let serverPort = 0;
  let runningGate = false;
  const routes = new Set(['/api/status', '/api/inspect', '/api/check', '/api/findings', '/api/verify', '/api/directories', '/api/pick-directory', '/api/create-config']);

  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${serverPort}`;
    if (req.headers.host !== `127.0.0.1:${serverPort}`) {
      sendJson(res, 403, { error: '请求来源无效。' });
      return;
    }
    const route = new URL(req.url ?? '/', origin).pathname;
    if (req.method === 'GET') {
      if (route === '/') {
        send(res, 200, 'text/html; charset=utf-8', APP_HTML
          .replace('__TOKEN__', token)
          .replace('__INITIAL_CWD__', escapeAttribute(initialCwd))
          .replace('__NATIVE_PICKER__', String(Boolean(options.pickDirectory || process.platform === 'win32')))
          .replace('__MCP_COMMAND__', escapeAttribute(mcpCommandLine())));
      } else if (route === '/app.css') {
        send(res, 200, 'text/css; charset=utf-8', APP_CSS);
      } else if (route === '/app.js') {
        send(res, 200, 'text/javascript; charset=utf-8', APP_JS);
      } else {
        sendJson(res, 404, { error: '页面不存在。' });
      }
      return;
    }
    if (req.method !== 'POST' || !routes.has(route)) {
      sendJson(res, 404, { error: '操作不存在。' });
      return;
    }
    if (req.headers.origin !== origin || req.headers['x-gitguard-token'] !== token) {
      sendJson(res, 403, { error: '请求未通过本地界面验证。' });
      return;
    }
    const isGate = route === '/api/inspect' || route === '/api/check' || route === '/api/verify' || route === '/api/pick-directory' || route === '/api/create-config';
    if (isGate && runningGate) {
      sendJson(res, 409, { error: '已有检查正在运行，请等待完成。' });
      return;
    }
    if (isGate) runningGate = true;
    try {
      const body = await readJson(req);
      sendJson(res, 200, await runAction(route, body, options.pickDirectory ?? pickNativeDirectory));
    } catch (error) {
      const status = error instanceof InputError ? error.status : 400;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, status, { error: message });
    } finally {
      if (isGate) runningGate = false;
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法确定本地界面端口。');
  serverPort = address.port;
  return { server, url: `http://127.0.0.1:${serverPort}/` };
}

export async function uiCommand(options: UiOptions = {}): Promise<void> {
  const { url } = await startUiServer(options);
  process.stdout.write(`GitGuard 图形界面：${url}\n关闭本终端即可结束服务。\n`);
  if (options.open !== false) openBrowser(url);
}
