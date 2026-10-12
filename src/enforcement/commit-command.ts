/**
 * src/enforcement/commit-command.ts
 * Recognizes `git commit` invocations inside an agent's shell command.
 */

export interface GitCommitInvocation {
  /** Directory the commit runs in, relative to the hook's cwd (from `cd` or `git -C`); undefined means cwd */
  dir?: string;
  /** True for `git commit -a` / `--all`, which also commits unstaged tracked changes */
  all: boolean;
  /** True when the same command stages files (git add/rm/mv) before committing; the hook runs before that happens */
  stagesFirst: boolean;
}

/** Splits a command line into words, honoring single and double quotes. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken || current) tokens.push(current);
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken || current) tokens.push(current);
  return tokens;
}

/** Splits on shell separators (&&, ||, ;, |, newline) outside quotes. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '\n' || char === '|' || (char === '&' && command[i + 1] === '&')) {
      segments.push(current);
      current = '';
      if ((char === '&' || char === '|') && command[i + 1] === char) i++;
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function joinDir(base: string | undefined, next: string): string {
  if (!base || /^([a-zA-Z]:)?[\\/]/.test(next)) return next;
  return `${base}/${next}`;
}

/**
 * Returns every `git commit` in the command, tracking `cd <dir>` and `git -C <dir>`.
 */
export function findGitCommits(command: string): GitCommitInvocation[] {
  const commits: GitCommitInvocation[] = [];
  let dir: string | undefined;
  let staged = false;
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens[0] === 'cd' && tokens[1]) {
      dir = joinDir(dir, tokens[1]);
      continue;
    }
    const gitIndex = tokens.findIndex((token) => token === 'git' || /[\\/]git(\.exe)?$/i.test(token));
    if (gitIndex === -1) continue;

    let i = gitIndex + 1;
    let commitDir = dir;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const option = tokens[i];
      if (option === '-C' && tokens[i + 1]) {
        commitDir = joinDir(commitDir, tokens[i + 1]);
        i += 2;
      } else if (option === '-c' || option === '--git-dir' || option === '--work-tree') {
        i += 2;
      } else {
        i += 1;
      }
    }
    if (['add', 'rm', 'mv', 'stage'].includes(tokens[i])) {
      staged = true;
      continue;
    }
    if (tokens[i] !== 'commit') continue;

    const args = tokens.slice(i + 1);
    const all = args.some((arg) => arg === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(arg));
    commits.push({ dir: commitDir, all, stagesFirst: staged });
  }
  return commits;
}
