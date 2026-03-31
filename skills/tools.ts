/**
 * Tool implementations for agentic execution inside /workspace.
 * All file paths are restricted to /workspace via resolveSafe().
 * runCommand() sanitises the environment so secrets never leak to child processes.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { execSync, execFileSync } from 'child_process';

const WORKSPACE = '/workspace';
export const PATTERNS_DIR = '/app/patterns';
const MAX_FILE_CHARS = 50_000;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// Writes must stay inside /workspace.
function resolveSafe(userPath: string): string {
  const abs = resolve(WORKSPACE, userPath);
  if (!abs.startsWith(WORKSPACE + '/') && abs !== WORKSPACE) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return abs;
}

// Reads also allow /app/patterns (Protofire web3 best practices, read-only).
function resolveSafeRead(userPath: string): string {
  const abs = resolve(WORKSPACE, userPath);
  if (
    (abs.startsWith(WORKSPACE + '/') || abs === WORKSPACE) ||
    (abs.startsWith(PATTERNS_DIR + '/') || abs === PATTERNS_DIR)
  ) {
    return abs;
  }
  throw new Error(`Path traversal denied: ${userPath}`);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function readFile(filePath: string): { content: string; truncated: boolean } {
  const abs = resolveSafeRead(filePath);
  try {
    const raw = readFileSync(abs, 'utf-8');
    if (raw.length > MAX_FILE_CHARS) {
      return { content: raw.slice(0, MAX_FILE_CHARS), truncated: true };
    }
    return { content: raw, truncated: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { content: `File not found: ${filePath}`, truncated: false };
    if (code === 'EISDIR') return { content: `Path is a directory: ${filePath}`, truncated: false };
    throw err;
  }
}

export function writeFile(filePath: string, content: string): string {
  const abs = resolveSafe(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return `Written: ${filePath} (${content.length} chars)`;
}

export function listFiles(dirPath = '.'): string[] {
  const abs = resolveSafeRead(dirPath);
  const results: string[] = [];
  // Determine display base: workspace paths shown relative, patterns paths shown as-is
  const isPatterns = abs.startsWith(PATTERNS_DIR);
  const base = isPatterns ? PATTERNS_DIR : WORKSPACE;

  function walk(dir: string) {
    if (results.length >= MAX_LIST_ENTRIES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) break;
      const full = resolve(dir, entry);
      const rel = relative(base, full);
      if (rel.startsWith('.git/') || entry === '.git') continue;
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(`${rel}/`);
          walk(full);
        } else {
          results.push(rel);
        }
      } catch { /* skip unreadable entries */ }
    }
  }

  walk(abs);
  return results;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): CommandResult {
  const timeout = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  // Sanitised environment — never expose secrets to child processes
  const safeEnv: Record<string, string> = {
    HOME: process.env['HOME'] ?? '/root',
    PATH: process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'xterm',
    USER: process.env['USER'] ?? 'root',
    // Foundry needs these
    FOUNDRY_DIR: process.env['FOUNDRY_DIR'] ?? '/home/agency/.foundry',
    // Node needs this for npm/hardhat
    NODE_ENV: 'development',
  };

  try {
    const stdout = execSync(cmd, {
      cwd: WORKSPACE,
      env: safeEnv,
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? e.message ?? 'Unknown error',
      exitCode: e.status ?? 1,
    };
  }
}

export function readPdf(filePath: string): { content: string; truncated: boolean } {
  // Allow absolute paths under /workspace or relative paths resolved to it
  const abs = filePath.startsWith('/') ? filePath : resolve(WORKSPACE, filePath);
  const UPLOADS = `${WORKSPACE}/.agency/uploads`;
  const allowed =
    abs.startsWith(WORKSPACE + '/') ||
    abs.startsWith(UPLOADS + '/') ||
    abs === WORKSPACE;
  if (!allowed) throw new Error(`Path traversal denied: ${filePath}`);

  try {
    // pdftotext (poppler-utils) — purpose-built for PDF text extraction.
    // "-" as output writes to stdout.
    const raw = execFileSync('pdftotext', [abs, '-'], {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    }).toString().trim();

    if (!raw) return { content: '(PDF produced no extractable text — may be a scanned/image-only PDF)', truncated: false };
    if (raw.length > MAX_FILE_CHARS) {
      return { content: raw.slice(0, MAX_FILE_CHARS), truncated: true };
    }
    return { content: raw, truncated: false };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    return { content: `PDF extraction failed: ${msg}`, truncated: false };
  }
}

export function gitStatus(): CommandResult {
  return runCommand('git status --short', 10_000);
}

export function gitDiff(): CommandResult {
  const result = runCommand('git diff HEAD', 30_000);
  // Cap diff output
  if (result.stdout.length > 20_000) {
    result.stdout = result.stdout.slice(0, 20_000) + '\n... [diff truncated]';
  }
  return result;
}

export function gitCommit(message: string): CommandResult {
  return runCommand(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, 30_000);
}

// ---------------------------------------------------------------------------
// OpenRouter tool schemas
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: Record<string, object> = {
  read_pdf: {
    type: 'function',
    function: {
      name: 'read_pdf',
      description: 'Extract and return the text content of a PDF file. Accepts paths relative to /workspace or absolute paths under /workspace/.agency/uploads/. More efficient than read_file for PDFs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the PDF, e.g. ".agency/uploads/report.pdf" or "docs/spec.pdf"' },
        },
        required: ['path'],
      },
    },
  },

  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Returns content (capped at 50K chars). Use read_pdf for PDF files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to /workspace, e.g. "src/MyContract.sol"' },
        },
        required: ['path'],
      },
    },
  },

  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file. Creates parent directories automatically. Path MUST be an absolute path starting with /workspace/ — never a bare filename or relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path starting with /workspace/, e.g. "/workspace/contracts/Token.sol"' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },

  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace (recursive, up to 500 entries). Use "." for root.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Directory relative to /workspace. Default: "."' },
        },
        required: [],
      },
    },
  },

  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command. Returns stdout, stderr, and exit code. Timeout: 60s default, max 300s. IMPORTANT: Always use full absolute paths starting with /workspace/ — never bare filenames or relative paths. Never use commas to separate multiple paths in a single command (use separate calls or proper bash syntax). Each call starts with a fresh shell — do not rely on cwd persisting between calls.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Shell command using absolute paths, e.g. "forge test --root /workspace/contracts" or "npm --prefix /workspace/frontend install"' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (max 300000)' },
        },
        required: ['cmd'],
      },
    },
  },

  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status of the workspace (short format).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff of uncommitted changes in the workspace.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  git_commit: {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage all changes and commit with the given message. Only use when explicitly authorised.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['message'],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_pdf': {
      const result = readPdf(args['path'] as string);
      return result.truncated
        ? `${result.content}\n\n[truncated at 50K chars]`
        : result.content;
    }
    case 'read_file': {
      const result = readFile(args['path'] as string);
      return result.truncated
        ? `${result.content}\n\n[truncated at 50K chars]`
        : result.content;
    }
    case 'write_file':
      return writeFile(args['path'] as string, args['content'] as string);

    case 'list_files': {
      const files = listFiles((args['dir'] as string | undefined) ?? '.');
      return files.length ? files.join('\n') : '(empty directory)';
    }
    case 'run_command': {
      const r = runCommand(args['cmd'] as string, args['timeout_ms'] as number | undefined);
      return `exit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`.trim();
    }
    case 'git_status': {
      const r = gitStatus();
      return r.stdout || '(clean)';
    }
    case 'git_diff': {
      const r = gitDiff();
      return r.stdout || '(no changes)';
    }
    case 'git_commit': {
      const r = gitCommit(args['message'] as string);
      return r.exitCode === 0 ? `Committed: ${r.stdout}` : `Commit failed: ${r.stderr}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
