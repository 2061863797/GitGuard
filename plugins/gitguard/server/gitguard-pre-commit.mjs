import { createRequire as __gitguardCreateRequire } from 'node:module';
const require = __gitguardCreateRequire(import.meta.url);

// src/pre-commit.ts
import process2 from "node:process";

// src/enforcement/commit-gate.ts
import * as fs3 from "node:fs";
import * as path4 from "node:path";

// src/git/adapter.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs2 from "node:fs/promises";
import * as path2 from "node:path";

// src/context/fs.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
async function safeReadRepoFile(repoRoot, relativePath, options = {}) {
  try {
    const normalizedRepo = await fs.realpath(path.resolve(repoRoot));
    const targetPath = path.resolve(normalizedRepo, relativePath);
    if (!targetPath.startsWith(normalizedRepo + path.sep) && targetPath !== normalizedRepo) {
      return null;
    }
    const realPath = await fs.realpath(targetPath);
    if (!realPath.startsWith(normalizedRepo + path.sep) && realPath !== normalizedRepo) {
      return null;
    }
    if (options.allowSymlinksWithinRepo === false && realPath !== targetPath) {
      return null;
    }
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) {
      return null;
    }
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    if (stats.size > maxBytes) {
      const fd = await fs.open(realPath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await fd.close();
      }
    }
    return await fs.readFile(realPath, "utf-8");
  } catch {
    return null;
  }
}

// src/types/errors.ts
var GitGuardError = class extends Error {
  code;
  exitCode;
  constructor(message, code = "GITGUARD_ERROR", exitCode = 1) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var NotAGitRepositoryError = class extends GitGuardError {
  constructor(path5) {
    super(
      path5 ? `Directory is not a Git repository: ${path5}` : "Current working directory is not a Git repository",
      "NOT_A_GIT_REPOSITORY",
      3
    );
  }
};
var GitExecutionError = class extends GitGuardError {
  command;
  stderr;
  constructor(command, stderr, exitCode = 3) {
    super(`Git command failed: ${command}
${stderr}`, "GIT_EXECUTION_ERROR", exitCode);
    this.command = command;
    this.stderr = stderr;
  }
};
var ForbiddenGitOperationError = class extends GitGuardError {
  constructor(operation) {
    super(
      `Forbidden mutating Git operation: '${operation}'. GitGuard enforces strictly read-only repository access.`,
      "FORBIDDEN_GIT_OPERATION",
      3
    );
  }
};
var InvalidGitRefError = class extends GitGuardError {
  constructor(ref) {
    super(`Invalid Git reference or revision range: '${ref}'`, "INVALID_GIT_REF", 3);
  }
};

// src/git/diff-parser.ts
function stripPrefix(pathStr) {
  let cleaned = pathStr.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.substring(1, cleaned.length - 1);
  }
  if (cleaned.startsWith("a/") || cleaned.startsWith("b/")) {
    return cleaned.substring(2);
  }
  return cleaned;
}
function unescapeGitPath(pathStr) {
  const escapes = {
    '"': '"',
    "\\": "\\",
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "	",
    v: "\v"
  };
  return pathStr.replace(
    /(?:\\[0-7]{3})+|\\(["\\abfnrtv])/g,
    (escaped, character) => character ? escapes[character] : Buffer.from(Array.from(escaped.matchAll(/\\([0-7]{3})/g), (match) => parseInt(match[1], 8))).toString("utf8")
  );
}
function parseDiffGitPaths(line) {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;
  const rest = line.substring(prefix.length).trim();
  if (rest.startsWith('"')) {
    let secondQuoteIndex = 1;
    for (; secondQuoteIndex < rest.length; secondQuoteIndex++) {
      if (rest[secondQuoteIndex] === "\\") secondQuoteIndex++;
      else if (rest[secondQuoteIndex] === '"') break;
    }
    if (secondQuoteIndex < rest.length) {
      const firstQuoted = rest.substring(0, secondQuoteIndex + 1);
      const remaining = rest.substring(secondQuoteIndex + 1).trim();
      if (!remaining) return null;
      let secondPath = remaining;
      if (secondPath.startsWith('"') && secondPath.endsWith('"')) {
        secondPath = secondPath.substring(1, secondPath.length - 1);
      }
      return {
        oldPath: unescapeGitPath(stripPrefix(firstQuoted)),
        newPath: unescapeGitPath(stripPrefix(secondPath))
      };
    }
  }
  const splitIdx = Math.max(rest.lastIndexOf(" b/"), rest.lastIndexOf(' "b/'));
  if (splitIdx !== -1) {
    const p1 = rest.substring(0, splitIdx);
    const p2 = rest.substring(splitIdx + 1);
    return {
      oldPath: unescapeGitPath(stripPrefix(p1)),
      newPath: unescapeGitPath(stripPrefix(p2))
    };
  }
  const parts = rest.split(/\s+/);
  if (parts.length >= 2) {
    return {
      oldPath: unescapeGitPath(stripPrefix(parts[0])),
      newPath: unescapeGitPath(stripPrefix(parts[parts.length - 1]))
    };
  }
  return null;
}
var UnifiedDiffParser = class {
  /**
   * Parse a raw unified diff string into a structured DiffContext AST.
   */
  parse(rawDiff) {
    if (!rawDiff || typeof rawDiff !== "string" || rawDiff.trim() === "") {
      return {
        raw: rawDiff || "",
        files: [],
        insertions: 0,
        deletions: 0,
        truncated: false,
        totalFiles: 0
      };
    }
    const lines = rawDiff.split(/\r?\n/);
    const files = [];
    let currentFile = null;
    let currentHunk = null;
    const hunkHeaderRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("diff --git ")) {
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        if (currentFile) {
          if (currentFile.oldPath === currentFile.newPath) {
            currentFile.oldPath = void 0;
          }
          files.push(currentFile);
        }
        const parsedPaths = parseDiffGitPaths(line);
        const oldPath = parsedPaths?.oldPath;
        const newPath = parsedPaths?.newPath || "";
        currentFile = {
          oldPath: oldPath !== newPath ? oldPath : void 0,
          newPath,
          status: "modified",
          binary: false,
          hunks: [],
          additions: 0,
          deletions: 0
        };
        continue;
      }
      if (!currentFile) {
        continue;
      }
      if (line.startsWith("new file mode ")) {
        currentFile.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        currentFile.status = "deleted";
        continue;
      }
      if (line.startsWith("similarity index ")) {
        currentFile.status = "renamed";
        continue;
      }
      if (line.startsWith("rename from ")) {
        currentFile.status = "renamed";
        currentFile.oldPath = unescapeGitPath(stripPrefix(line.substring("rename from ".length)));
        continue;
      }
      if (line.startsWith("rename to ")) {
        currentFile.status = "renamed";
        currentFile.newPath = unescapeGitPath(stripPrefix(line.substring("rename to ".length)));
        continue;
      }
      if (line.startsWith("copy from ")) {
        currentFile.status = "copied";
        currentFile.oldPath = unescapeGitPath(stripPrefix(line.substring("copy from ".length)));
        continue;
      }
      if (line.startsWith("copy to ")) {
        currentFile.status = "copied";
        currentFile.newPath = unescapeGitPath(stripPrefix(line.substring("copy to ".length)));
        continue;
      }
      if (line.startsWith("Binary files ") || line.includes("differ") || line.startsWith("GIT binary patch")) {
        currentFile.binary = true;
        if (currentFile.status === "modified") {
          currentFile.status = "binary";
        }
        continue;
      }
      if (line.startsWith("--- ")) {
        const rawOld = line.substring(4).trim();
        if (rawOld === "/dev/null") {
          currentFile.status = "added";
        } else {
          const stripped = stripPrefix(rawOld);
          if (stripped && !currentFile.oldPath) {
            currentFile.oldPath = unescapeGitPath(stripped);
          }
        }
        continue;
      }
      if (line.startsWith("+++ ")) {
        const rawNew = line.substring(4).trim();
        if (rawNew === "/dev/null") {
          currentFile.status = "deleted";
        } else {
          const stripped = stripPrefix(rawNew);
          if (stripped) {
            currentFile.newPath = unescapeGitPath(stripped);
          }
        }
        continue;
      }
      const hunkMatch = line.match(hunkHeaderRegex);
      if (hunkMatch) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        try {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldLines = hunkMatch[2] !== void 0 ? parseInt(hunkMatch[2], 10) : 1;
          const newStart = parseInt(hunkMatch[3], 10);
          const newLines = hunkMatch[4] !== void 0 ? parseInt(hunkMatch[4], 10) : 1;
          currentHunk = {
            oldStart,
            oldLines,
            newStart,
            newLines,
            header: line,
            lines: []
          };
        } catch {
          currentHunk = null;
        }
        continue;
      }
      if (currentHunk) {
        if (line.startsWith("+")) {
          currentFile.additions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith("-")) {
          currentFile.deletions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith(" ") || line.startsWith("\\")) {
          currentHunk.lines.push(line);
        }
      }
    }
    if (currentHunk && currentFile) {
      currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
      if (currentFile.oldPath === currentFile.newPath) {
        currentFile.oldPath = void 0;
      }
      files.push(currentFile);
    }
    let insertions = 0;
    let deletions = 0;
    for (const f of files) {
      insertions += f.additions;
      deletions += f.deletions;
    }
    return {
      raw: rawDiff,
      files,
      insertions,
      deletions,
      truncated: false,
      totalFiles: files.length
    };
  }
};
var unifiedDiffParser = new UnifiedDiffParser();
function parseDiff(rawDiff) {
  return unifiedDiffParser.parse(rawDiff);
}

// src/git/adapter.ts
var execFileAsync = promisify(execFile);
var GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var ALLOWED_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "show",
  "log",
  "ls-files",
  "rev-parse",
  "check-ref-format",
  "cat-file",
  "symbolic-ref",
  "merge-base",
  "version",
  "hash-object"
]);
var FORBIDDEN_GIT_COMMANDS = /* @__PURE__ */ new Set([
  "add",
  "commit",
  "checkout",
  "reset",
  "clean",
  "push",
  "pull",
  "merge",
  "rebase",
  "tag",
  "branch",
  "cherry-pick",
  "revert",
  "apply",
  "stash",
  "rm",
  "mv",
  "clone",
  "init",
  "config"
]);
function assertSafeRef(ref) {
  if (!ref || ref.startsWith("-") || /\s/.test(ref) || Array.from(ref).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
    throw new InvalidGitRefError(ref);
  }
}
function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}
var GitCLIAdapter = class {
  defaultCwd;
  maxBuffer;
  timeoutMs;
  constructor(options) {
    if (typeof options === "string") {
      this.defaultCwd = options;
      this.maxBuffer = 20 * 1024 * 1024;
      this.timeoutMs = 3e4;
    } else {
      this.defaultCwd = options?.cwd;
      this.maxBuffer = options?.maxBuffer ?? 20 * 1024 * 1024;
      this.timeoutMs = options?.timeoutMs ?? 3e4;
    }
  }
  /**
   * Safely executes a read-only git command using Node child_process.execFile.
   * Throws ForbiddenGitOperationError if a mutating command is requested.
   */
  async executeGit(args, cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    const subcommand = args[0] || "";
    if (FORBIDDEN_GIT_COMMANDS.has(subcommand)) {
      throw new ForbiddenGitOperationError(subcommand || args[0]);
    }
    if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new ForbiddenGitOperationError(subcommand);
    }
    if (subcommand === "symbolic-ref" && (args.length !== 4 || args[1] !== "--short" || args[2] !== "-q" || args[3] !== "HEAD")) {
      throw new ForbiddenGitOperationError("symbolic-ref write or unsupported arguments");
    }
    const pathSeparator = args.indexOf("--");
    const optionArgs = args.slice(1, pathSeparator === -1 ? void 0 : pathSeparator);
    if (["diff", "show", "log"].includes(subcommand) && optionArgs.some(
      (arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv"
    )) {
      throw new ForbiddenGitOperationError(`${subcommand} write or external-diff option`);
    }
    if (subcommand === "hash-object" && optionArgs.some((arg) => arg === "-w" || arg === "--stdin-paths" || arg.startsWith("--literally"))) {
      throw new ForbiddenGitOperationError("hash-object write option");
    }
    if (subcommand === "cat-file" && optionArgs.some((arg) => arg === "--filters" || arg === "--textconv")) {
      throw new ForbiddenGitOperationError("cat-file external filter option");
    }
    const safeArgs = ["diff", "show", "log"].includes(subcommand) ? [subcommand, "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
    try {
      const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...safeArgs], {
        cwd: targetCwd,
        maxBuffer: this.maxBuffer,
        timeout: this.timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          LC_ALL: "C",
          GIT_OPTIONAL_LOCKS: "0"
        }
      });
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: 0
      };
    } catch (err) {
      const execErr = err;
      const stderrStr = execErr.stderr ? execErr.stderr.toString() : "";
      const stdoutStr = execErr.stdout ? execErr.stdout.toString() : "";
      const exitCode = typeof execErr.code === "number" ? execErr.code : 1;
      if (args.includes("--no-index") && execErr.code === 1 && !execErr.killed && !execErr.signal && stdoutStr.length > 0) {
        return {
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode: 1
        };
      }
      if (stderrStr.includes("not a git repository") || stderrStr.includes("Not a git repository") || execErr.message && execErr.message.includes("not a git repository")) {
        throw new NotAGitRepositoryError(targetCwd);
      }
      if (stderrStr.includes("unknown revision") || stderrStr.includes("bad revision") || stderrStr.includes("fatal: Not a valid object name") || stderrStr.includes("fatal: ambiguous argument")) {
        const refArg = args.find(
          (a) => !a.startsWith("-") && a !== subcommand && a !== "--"
        );
        if (refArg) {
          throw new InvalidGitRefError(refArg);
        }
      }
      throw new GitExecutionError(`git ${args.join(" ")}`, stderrStr || execErr.message || "", exitCode);
    }
  }
  /**
   * Checks whether the specified directory is inside a valid Git repository.
   */
  async isGitRepository(cwd) {
    try {
      const res = await this.executeGit(["rev-parse", "--is-inside-work-tree"], cwd);
      return res.stdout.trim() === "true";
    } catch (err) {
      if (err instanceof NotAGitRepositoryError) {
        return false;
      }
      return false;
    }
  }
  /**
   * Gets the absolute path of the Git repository root.
   */
  async getRepositoryRoot(cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    try {
      const res = await this.executeGit(["rev-parse", "--show-toplevel"], targetCwd);
      let rootPath = path2.resolve(res.stdout.trim());
      try {
        rootPath = await fs2.realpath(rootPath);
      } catch {
      }
      return toPosixPath(rootPath);
    } catch (err) {
      if (err instanceof NotAGitRepositoryError) {
        throw err;
      }
      throw new NotAGitRepositoryError(targetCwd);
    }
  }
  /**
   * Gets the current active branch name or 'HEAD' if detached.
   */
  async getCurrentBranch(cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);
    try {
      const res = await this.executeGit(["symbolic-ref", "--short", "-q", "HEAD"], targetCwd);
      const branch = res.stdout.trim();
      if (branch) return branch;
    } catch {
    }
    try {
      const res = await this.executeGit(["rev-parse", "--abbrev-ref", "HEAD"], targetCwd);
      const branch = res.stdout.trim();
      if (branch) return branch;
    } catch {
    }
    return "HEAD";
  }
  /**
   * Gets the HEAD commit SHA, or an empty string for an unborn repository.
   */
  async getHeadSha(cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);
    try {
      const res = await this.executeGit(["rev-parse", "HEAD"], targetCwd);
      return res.stdout.trim();
    } catch {
      return "";
    }
  }
  /**
   * Returns a complete status summary of the repository.
   */
  async getStatus(cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    const rootPath = await this.getRepositoryRoot(targetCwd);
    const currentBranch = await this.getCurrentBranch(targetCwd);
    const headSha2 = await this.getHeadSha(targetCwd);
    const res = await this.executeGit(["status", "--porcelain=v1", "-z", "-uall"], targetCwd);
    const entries = res.stdout.split("\0");
    const stagedFiles = [];
    const unstagedFiles = [];
    const untrackedFiles = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const filePath = entry.substring(3);
      if (x === "R" || x === "C" || y === "R" || y === "C") {
        i++;
      }
      if (x === "?" && y === "?") {
        untrackedFiles.push(filePath);
      } else {
        if (x !== " " && x !== "?" && x !== "!") {
          stagedFiles.push(filePath);
        }
        if (y !== " " && y !== "?" && y !== "!") {
          unstagedFiles.push(filePath);
        }
      }
    }
    const isClean = stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedFiles.length === 0;
    return {
      isRepo: true,
      rootPath,
      currentBranch,
      headSha: headSha2,
      isClean,
      stagedFiles,
      unstagedFiles,
      untrackedFiles
    };
  }
  /**
   * Extracts raw unified diff text for the given scope and options.
   */
  async getDiff(scope, options) {
    const targetCwd = options?.cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);
    const headSha2 = await this.getHeadSha(targetCwd);
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    let diffText = "";
    switch (scope) {
      case "staged": {
        if (!headSha2) {
          args.push("--cached", GIT_EMPTY_TREE_SHA);
        } else {
          args.push("--cached");
        }
        break;
      }
      case "working":
      case "working-tree": {
        break;
      }
      case "all": {
        if (!headSha2) {
          const staged = await this.getDiff("staged", options);
          const working = await this.getDiff("working-tree", options);
          return [staged, working].filter(Boolean).join("\n");
        }
        args.push("HEAD");
        break;
      }
      case "commit": {
        const sha = options?.commitSha;
        if (!sha) {
          throw new InvalidGitRefError("commitSha is required for commit scope");
        }
        assertSafeRef(sha);
        try {
          const type = await this.executeGit(["cat-file", "-t", sha], targetCwd);
          if (type.stdout.trim() !== "commit") throw new InvalidGitRefError(sha);
        } catch {
          throw new InvalidGitRefError(sha);
        }
        const showArgs = ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", sha];
        if (options?.pathFilters && options.pathFilters.length > 0) {
          showArgs.push("--", ...options.pathFilters);
        }
        const showRes = await this.executeGit(showArgs, targetCwd);
        return showRes.stdout;
      }
      case "range": {
        let range = "";
        if (options?.baseRef && options.baseRef.includes("..")) {
          const refs = options.baseRef.split(/\.\.\.?/);
          if (refs.length !== 2) throw new InvalidGitRefError(options.baseRef);
          refs.forEach(assertSafeRef);
          range = options.baseRef;
        } else if (options?.baseRef && options?.headRef) {
          assertSafeRef(options.baseRef);
          assertSafeRef(options.headRef);
          range = `${options.baseRef}..${options.headRef}`;
        } else {
          throw new InvalidGitRefError("baseRef and headRef are required for range scope");
        }
        args.push(range);
        break;
      }
      case "pull-request": {
        const base = options?.baseRef || "main";
        const head = options?.headRef || "HEAD";
        assertSafeRef(base);
        assertSafeRef(head);
        args.push(`${base}...${head}`);
        break;
      }
      default:
        throw new GitExecutionError(`git diff`, `Unknown change scope: ${scope}`);
    }
    if (options?.pathFilters && options.pathFilters.length > 0) {
      args.push("--", ...options.pathFilters);
    }
    try {
      const res = await this.executeGit(args, targetCwd);
      diffText = res.stdout;
    } catch (err) {
      if (err instanceof InvalidGitRefError) throw err;
      if (err instanceof NotAGitRepositoryError) throw err;
      throw err;
    }
    const shouldIncludeUntracked = options?.includeUntracked !== false && (options?.includeUntracked === true || scope === "working" || scope === "working-tree" || scope === "all");
    if (shouldIncludeUntracked) {
      const status = await this.getStatus(targetCwd);
      for (const untracked of status.untrackedFiles) {
        if (untracked === ".gitguard.yml" || untracked === ".gitguard.yaml" || untracked.startsWith(".git/") || untracked.startsWith(".git\\")) {
          continue;
        }
        if (options?.pathFilters && options.pathFilters.length > 0 && !options.pathFilters.some((f) => untracked.startsWith(f) || untracked === f)) {
          continue;
        }
        const noIndexRes = await this.executeGit(
          ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", untracked],
          targetCwd
        );
        if (noIndexRes.stdout) {
          diffText = diffText ? `${diffText}
${noIndexRes.stdout}` : noIndexRes.stdout;
        }
      }
    }
    return diffText;
  }
  /**
   * Convenience method to get staged unified diff.
   */
  async getStagedDiff(cwd) {
    return this.getDiff("staged", { cwd });
  }
  /**
   * Convenience method to get working tree unified diff.
   */
  async getWorkingTreeDiff(cwd) {
    return this.getDiff("working-tree", { cwd });
  }
  /**
   * Returns list of changed files with additions, deletions, and status.
   */
  async getChangedFiles(scope, options) {
    let diffOptions = {};
    let resolvedScope = scope ?? "staged";
    if (typeof options === "string") {
      diffOptions = { cwd: options, scope: resolvedScope };
    } else if (options) {
      diffOptions = { ...options };
      if (options.scope && !scope) {
        resolvedScope = options.scope;
      }
    }
    const rawDiff = await this.getDiff(resolvedScope, diffOptions);
    const parsed = parseDiff(rawDiff);
    const changedFiles = parsed.files.map((file) => {
      const isStaged = resolvedScope === "staged" || resolvedScope === "commit";
      return {
        path: toPosixPath(file.newPath),
        status: file.status === "binary" ? "modified" : file.status,
        oldPath: file.oldPath ? toPosixPath(file.oldPath) : void 0,
        staged: isStaged,
        binary: file.binary,
        additions: file.additions,
        deletions: file.deletions
      };
    });
    return changedFiles;
  }
  /**
   * Gets file content at a Git ref, the index (ref ':'), or the current working tree.
   * Returns null if file does not exist or was deleted.
   */
  async getFileContent(filepath, ref, cwd) {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    const root = await this.getRepositoryRoot(targetCwd);
    const relativePath = toPosixPath(path2.relative(root, path2.resolve(root, filepath)));
    if (ref) {
      assertSafeRef(ref);
      try {
        const objectPath = ref === ":" ? `:${relativePath}` : `${ref}:${relativePath}`;
        const res = await this.executeGit(["show", objectPath], targetCwd);
        return res.stdout;
      } catch {
        return null;
      }
    } else {
      return safeReadRepoFile(root, relativePath);
    }
  }
  /**
   * Convenience alias: get content of a file at a specific Git ref.
   */
  async getFileContentAtRef(filePath, ref, cwd) {
    return this.getFileContent(filePath, ref, cwd);
  }
  /**
   * Convenience alias: get content of a file in the working tree.
   */
  async getWorkingFileContent(filePath, cwd) {
    return this.getFileContent(filePath, void 0, cwd);
  }
  /**
   * Internal helper ensuring that target directory is a Git repository.
   */
  async ensureRepo(cwd) {
    const isRepo = await this.isGitRepository(cwd);
    if (!isRepo) {
      throw new NotAGitRepositoryError(cwd);
    }
  }
};

// src/findings/store.ts
import * as fsSync from "node:fs";
import * as path3 from "node:path";
function resolveGitDir(repoRoot) {
  const gitPath = path3.join(repoRoot, ".git");
  try {
    const stat2 = fsSync.statSync(gitPath);
    if (stat2.isDirectory()) {
      return gitPath;
    }
    if (stat2.isFile()) {
      const content = fsSync.readFileSync(gitPath, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const rawTarget = match[1].trim();
        return path3.isAbsolute(rawTarget) ? rawTarget : path3.resolve(repoRoot, rawTarget);
      }
    }
  } catch {
  }
  return gitPath;
}

// src/policy/config-files.ts
var CONFIG_FILE_NAMES = [
  ".gitguard.yml",
  ".gitguard.yaml",
  "gitguard.yml",
  "gitguard.yaml"
];

// src/enforcement/commit-gate.ts
var ZERO_SHA = "0".repeat(40);
var RECORD_FILE = "last-check.json";
function defaultGitExec() {
  const adapter = new GitCLIAdapter();
  return async (args, cwd) => (await adapter.executeGit(args, cwd)).stdout;
}
function splitZ(output) {
  return output.split("\0").filter(Boolean);
}
async function headSha(exec, root) {
  try {
    return (await exec(["rev-parse", "--verify", "--quiet", "HEAD"], root)).trim();
  } catch {
    return "";
  }
}
async function stagedBlobs(exec, root, head) {
  const args = ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"];
  if (!head) args.push("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  const fields = splitZ(await exec(args, root));
  const files = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i].split(" ");
    files[fields[i + 1]] = meta[3] ?? ZERO_SHA;
  }
  return files;
}
async function workingBlobs(exec, root, paths) {
  const files = {};
  const regular = [];
  for (const p of new Set(paths)) {
    const full = path4.join(root, p);
    if (!fs3.existsSync(full)) {
      files[p] = ZERO_SHA;
    } else if (fs3.statSync(full).isDirectory()) {
      files[p] = await headSha(exec, full) || ZERO_SHA;
    } else {
      regular.push(p);
    }
  }
  for (let i = 0; i < regular.length; i += 100) {
    const batch = regular.slice(i, i + 100);
    const shas = (await exec(["hash-object", "--", ...batch], root)).split(/\r?\n/).filter(Boolean);
    batch.forEach((p, index) => {
      files[p] = shas[index] ?? ZERO_SHA;
    });
  }
  return files;
}
async function collectBlobs(exec, root, mode) {
  const head = await headSha(exec, root);
  if (mode === "staged") return stagedBlobs(exec, root, head);
  const paths = [];
  if (mode === "working") {
    paths.push(...splitZ(await exec(["diff", "--name-only", "-z", "--no-renames"], root)));
  } else if (head) {
    paths.push(...splitZ(await exec(["diff", "HEAD", "--name-only", "-z", "--no-renames"], root)));
  } else {
    paths.push(...Object.keys(await stagedBlobs(exec, root, head)));
    paths.push(...splitZ(await exec(["diff", "--name-only", "-z", "--no-renames"], root)));
  }
  paths.push(...splitZ(await exec(["ls-files", "--others", "--exclude-standard", "-z"], root)));
  return workingBlobs(exec, root, paths);
}
function recordPath(root) {
  return path4.join(resolveGitDir(root), "gitguard", RECORD_FILE);
}
async function hasGitGuardConfig(root, exec = defaultGitExec()) {
  if (CONFIG_FILE_NAMES.some((name) => fs3.existsSync(path4.join(root, name)))) {
    return true;
  }
  for (const name of CONFIG_FILE_NAMES) {
    try {
      await exec(["cat-file", "-e", `HEAD:${name}`], root);
      return true;
    } catch {
    }
  }
  return false;
}
function readLastCheck(root) {
  try {
    const parsed = JSON.parse(fs3.readFileSync(recordPath(root), "utf8"));
    return parsed && parsed.version === 1 && parsed.files ? parsed : null;
  } catch {
    return null;
  }
}
async function evaluateCommitGate(repoDir, exec = defaultGitExec()) {
  const root = (await exec(["rev-parse", "--show-toplevel"], repoDir)).trim();
  if (!await hasGitGuardConfig(root, exec)) {
    return { allow: true };
  }
  const rerun = 'Run the GitGuard check tool (scope "all" or "staged") on this repository, fix any BLOCK findings, then commit.';
  const record = readLastCheck(root);
  if (!record) {
    return { allow: false, reason: `GitGuard: this repository requires a check before committing, and none was recorded. ${rerun}` };
  }
  if (record.headSha !== await headSha(exec, root)) {
    return { allow: false, reason: `GitGuard: HEAD moved since the last check. ${rerun}` };
  }
  const committing = await collectBlobs(exec, root, "staged");
  const unchecked = Object.entries(committing).filter(([file, sha]) => record.files[file] !== sha).map(([file]) => file);
  if (unchecked.length > 0) {
    const listed = unchecked.slice(0, 5).join(", ") + (unchecked.length > 5 ? `, \u2026 (${unchecked.length} files)` : "");
    return { allow: false, reason: `GitGuard: these changes were not covered by the last check or changed after it: ${listed}. ${rerun}` };
  }
  if (record.status === "BLOCK") {
    const findings = record.blockingFindings.length > 0 ? ` Blocking findings: ${record.blockingFindings.join(", ")}.` : "";
    return {
      allow: false,
      reason: `GitGuard: the last check returned BLOCK.${findings} Fix them and run the GitGuard verify tool with these IDs before committing.`
    };
  }
  return { allow: true };
}

// src/pre-commit.ts
async function main() {
  try {
    const decision = await evaluateCommitGate(process2.cwd());
    if (decision.allow) return 0;
    process2.stderr.write(`${decision.reason}
(To commit anyway as a person, use git commit --no-verify.)
`);
    return 1;
  } catch (err) {
    process2.stderr.write(
      `GitGuard: the pre-commit check could not run: ${err instanceof Error ? err.message : String(err)}
(Fix the problem, or commit with --no-verify to skip GitGuard once.)
`
    );
    return 1;
  }
}
main().then((code) => process2.exit(code));
