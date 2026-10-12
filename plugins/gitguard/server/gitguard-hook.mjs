import { createRequire as __gitguardCreateRequire } from 'node:module';
const require = __gitguardCreateRequire(import.meta.url);

// src/hook.ts
import process from "node:process";

// src/enforcement/bypass-guard.ts
import * as fs from "node:fs";
import * as path from "node:path";

// src/policy/config-files.ts
var CONFIG_FILE_NAMES = [
  ".gitguard.yml",
  ".gitguard.yaml",
  "gitguard.yml",
  "gitguard.yaml"
];

// src/enforcement/bypass-guard.ts
var BYPASS_PATTERNS = [
  [/--no-verify\b/, "--no-verify skips the GitGuard pre-commit check"],
  [/\bgit\b[^\n]*\bcommit\b[^\n;&|]*\s-[A-Za-z]*n[A-Za-z]*(?=\s|$)/, "`git commit -n` skips the GitGuard pre-commit check"],
  [/hooks_?path/i, "changing core.hooksPath disables the GitGuard pre-commit hook"],
  [/\.git[\\/]+(hooks|gitguard)\b/i, "the GitGuard hook and check records under .git/ must not be edited by the agent"]
];
function findHookBypass(command) {
  for (const [pattern, reason] of BYPASS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}
function isGitGuardRepository(dir) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return CONFIG_FILE_NAMES.some((name) => fs.existsSync(path.join(current, name)));
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// src/hook.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (!SHELL_TOOLS.has(event.tool_name ?? "") || typeof event.tool_input?.command !== "string") {
    return 0;
  }
  const reason = findHookBypass(event.tool_input.command);
  if (!reason || !isGitGuardRepository(event.cwd || process.cwd())) {
    return 0;
  }
  process.stderr.write(`GitGuard: blocked because ${reason}. Run the GitGuard check tool and commit normally; only the user may skip the check.
`);
  return 2;
}
main().then((code) => process.exit(code), () => process.exit(0));
