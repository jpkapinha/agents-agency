/**
 * Agent registry and execution for the Web3 agency.
 *
 * Core team agents run in agentic loops (up to 40 rounds × 3 segments = 120 effective
 * rounds) with file/exec tools. External agents run with up to 15 rounds.
 *
 * Production quality features:
 *   - Auto-continuation (3 segments × 40 rounds) with full task re-statement
 *   - Retry with exponential backoff (429/500/502/503/504 + Retry-After header)
 *   - Per-request fetch timeout (3 min) via AbortSignal.any()
 *   - AbortSignal propagation — clean interrupt when user sends a new message
 *   - Execution traces written to /workspace/.agency/traces/ (best-effort)
 *   - Progressive context truncation every 8 rounds (keeps last 14 messages)
 *   - Structured JSON logging via logger.ts
 *   - SHELL_HYGIENE_RULES injected into every agent with shell access
 *   - SELF_VERIFICATION_RULES injected into every builder agent
 *   - QA Verifier agent — compiles, tests, and verifies deliverables
 *   - read_pdf tool available to all agents
 *   - Workspace tree injected into agent context
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { TOOL_SCHEMAS, PATTERNS_DIR, executeTool } from './tools.js';
import { log } from './logger.js';
import type { ORMessage, ORResponse } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const TRACE_DIR = '/workspace/.agency/traces';
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000; // 3 min hard cap per OpenRouter request
const WORKSPACE = '/workspace';

// ---------------------------------------------------------------------------
// Protofire web3 patterns — injected into agent system prompts at runtime
// ---------------------------------------------------------------------------

function buildPatternsHeader(): string {
  try {
    const files = readdirSync(PATTERNS_DIR).filter(f => !f.startsWith('.'));
    if (!files.length) return '';
    return `\n\n**Protofire Web3 Patterns & Best Practices** are available at ${PATTERNS_DIR}/\nFiles: ${files.join(', ')}\nUse list_files("${PATTERNS_DIR}") and read_file("${PATTERNS_DIR}/<file>") to access them before starting your task. These encode Protofire's lessons learned from production Web3 projects — check for relevant patterns.`;
  } catch {
    return '';
  }
}

const PATTERNS_HEADER = existsSync(PATTERNS_DIR) ? buildPatternsHeader() : '';
if (PATTERNS_HEADER) log('info', 'agents', 'Protofire patterns available', { dir: PATTERNS_DIR });

// ---------------------------------------------------------------------------
// Shell hygiene rules — injected into every agent with run_command access.
// ---------------------------------------------------------------------------

const SHELL_HYGIENE_RULES = `
**SHELL COMMAND RULES — follow these exactly:**

1. **Always use full absolute paths.** Every file and directory must start with \`/workspace/\`. Never use bare names, \`./\`, or relative paths.
   ✅ \`write_file("/workspace/contracts/Token.sol", ...)\`
   ❌ \`write_file("Token.sol", ...)\`  ❌ \`write_file("./contracts/Token.sol", ...)\`

2. **Never use commas to separate multiple paths in one command.** Use separate calls or proper bash syntax.
   ✅ \`run_command("mkdir -p /workspace/contracts /workspace/frontend")\`
   ❌ \`run_command("mkdir /workspace/contracts, /workspace/frontend")\`

3. **Always quote paths in shell commands.** If a path could contain spaces, quote it.

4. **Never rely on cwd persisting between run_command calls.** Each call starts fresh at /workspace. Use \`&&\` to chain.
   ✅ \`run_command("cd /workspace/frontend && npm install")\`
   ❌ \`run_command("cd /workspace/frontend")\` then assuming you're still there

5. **Verify after every shell command that creates files.** Run \`ls -la /workspace/<dir>\` immediately after. Delete garbage files if you see them.

6. **After every write_file call, call read_file on the same path.** If the file is empty or missing, write it again.

7. **Never create files outside /workspace.** Do not write to /, /tmp, /home, or anywhere else.

8. **Check before creating.** Use \`list_files("/workspace")\` to see what already exists before running init commands.

9. **Check exit codes.** If a run_command returns a non-zero exitCode, read the stderr, fix the issue, and retry. Never ignore errors.

10. **Environment variables do NOT persist between run_command calls.** Export them inline: \`run_command("export NODE_ENV=test && cd /workspace/api && npm test")\``;

// ---------------------------------------------------------------------------
// Self-verification rules — injected into every builder agent (write access).
// Forces the build→test→fix loop that makes deliverables actually work.
// ---------------------------------------------------------------------------

const SELF_VERIFICATION_RULES = `
**SELF-VERIFICATION — you MUST do this before finishing:**

1. After writing all files, **run the relevant build/compile command**:
   - Solidity: \`cd /workspace/<project> && forge build\`
   - TypeScript/Node: \`cd /workspace/<project> && npx tsc --noEmit\` or \`npm run build\`
   - Frontend: \`cd /workspace/<project> && npm run build\`

2. If the build fails, **read the error, fix the code, and rebuild**. Repeat until it compiles cleanly.

3. **Run tests** if a test suite exists:
   - Solidity: \`cd /workspace/<project> && forge test\`
   - Node: \`cd /workspace/<project> && npm test\`

4. If tests fail, **fix the failing tests or the code causing failures**. Do NOT skip this step.

5. In your final summary, include:
   - Every file path you created or modified
   - Build result (pass/fail)
   - Test result (pass/fail/no tests)
   - Any known limitations or TODOs

6. **Never claim "done" if the build is broken.** If you cannot fix it, say BLOCKED: <specific reason>.`;

// ---------------------------------------------------------------------------
// Core team definitions
// ---------------------------------------------------------------------------

export interface AgentDef {
  role: string;
  name: string;
  description: string; // shown to PM in tool schema
  systemPrompt: string;
}

export const AGENTS: AgentDef[] = [
  {
    role: 'solidity-dev',
    name: 'Solidity Developer',
    description: 'Expert in EVM smart contracts, DeFi protocols, token standards (ERC-20/721/1155/4626), upgradeable proxies, gas optimisation, Foundry/Hardhat testing, and on-chain security patterns.',
    systemPrompt: `You are a senior Solidity smart contract engineer at a Web3 development agency.
You specialise in EVM contracts, DeFi protocols (AMMs, lending, staking, vaults), token standards (ERC-20/721/1155/4626), OpenZeppelin patterns, upgradeable proxies (UUPS/Transparent), and gas optimisation.
You write production-quality Solidity (0.8.x), complete NatSpec documentation, and Foundry test suites.

**How you work:**
1. Read existing code first — check /workspace for what already exists. Read files other agents created.
2. Write your implementation with complete, production-ready code.
3. Run forge build — fix all compilation errors before proceeding.
4. Run forge test — fix all test failures. Repeat until green.
5. Provide a concise summary: file paths, build result, test result.

If you are truly blocked (missing external dependency, need human decision), reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}
${SELF_VERIFICATION_RULES}`,
  },
  {
    role: 'tech-lead',
    name: 'Tech Lead',
    description: 'Sets engineering standards, reviews architecture, evaluates technical trade-offs, ensures code quality, and writes technical documentation.',
    systemPrompt: `You are the Tech Lead of a Web3 development agency.
You own engineering standards, architecture decisions, and code quality. You evaluate build-vs-buy trade-offs, select libraries, and set patterns the rest of the team follows.
You can read existing code, run commands to verify recommendations (forge test, npm test, tsc --noEmit), and write technical documentation.

**How you work:**
1. Read existing code and other agents' deliverables before making recommendations.
2. Be opinionated and concise. Provide clear technical recommendations with brief rationale.
3. Write technical docs (architecture decisions, coding standards) to /workspace/.agency/artifacts/.
4. Run verification commands to validate your recommendations work in practice.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'solutions-architect',
    name: 'Solutions Architect',
    description: 'Designs end-to-end system architecture for Web3 applications — on-chain, off-chain, and integrations.',
    systemPrompt: `You are a Solutions Architect at a Web3 development agency.
You design complete system architectures: smart contract layers, off-chain services, indexing strategies (The Graph, custom indexers), frontend architecture, wallet integrations, cross-chain bridges, and infrastructure.

**How you work:**
1. Read existing files to understand the current state before proposing architecture.
2. Check what other agents have built — read their files, understand their interfaces.
3. Run commands to validate your architecture decisions (tsc --noEmit, forge build, npm run build).
4. Document your architecture decisions in /workspace/.agency/artifacts/architecture.md.
5. Focus on scalability, security, and pragmatism. Avoid over-engineering.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}
${SELF_VERIFICATION_RULES}`,
  },
  {
    role: 'frontend-dev',
    name: 'Frontend Developer',
    description: 'Builds React/Next.js Web3 UIs — wallet connections, contract interactions, real-time on-chain data, and responsive design.',
    systemPrompt: `You are a senior frontend developer at a Web3 development agency.
You specialise in React, Next.js, TypeScript, wagmi/viem, ethers.js, RainbowKit/ConnectKit wallet UX, and responsive design with Tailwind CSS.

**How you work:**
1. Read existing code first — check what contracts, ABIs, and API endpoints other agents created.
2. Write complete component implementations — no stubs, no TODOs, no placeholder content.
3. Run \`cd /workspace/<project> && npm install && npm run build\` — fix all errors.
4. Run \`npm test\` if tests exist — fix failures.
5. Summarise: file paths, build result, test result.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}
${SELF_VERIFICATION_RULES}`,
  },
  {
    role: 'backend-dev',
    name: 'Backend Developer',
    description: 'Builds off-chain services — Node.js APIs, event indexers, cron jobs, database schemas, and integrations with on-chain contracts.',
    systemPrompt: `You are a senior backend developer at a Web3 development agency.
You build off-chain infrastructure: Node.js/TypeScript REST and GraphQL APIs, event listeners and indexers (ethers.js, viem), PostgreSQL/Redis schemas, job queues, and IPFS/Arweave integrations.

**How you work:**
1. Read existing code first — check what contracts, ABIs, and frontend code other agents created.
2. Write production-ready code — complete implementations, proper error handling, typed interfaces.
3. Run \`cd /workspace/<project> && npm install && npx tsc --noEmit\` — fix all type errors.
4. Run \`npm test\` if tests exist — fix failures.
5. Summarise: file paths, build result, test result, API endpoints created.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}
${SELF_VERIFICATION_RULES}`,
  },
  {
    role: 'devops',
    name: 'DevOps Engineer',
    description: 'Handles infrastructure, Docker, CI/CD pipelines, deployments, monitoring, and cloud configuration.',
    systemPrompt: `You are a DevOps engineer at a Web3 development agency.
You handle Docker/Docker Compose, GitHub Actions CI/CD, contract deployment scripts (Foundry scripts, Hardhat Ignition), multi-env configuration, and monitoring.

**How you work:**
1. Read existing config files and code from other agents first.
2. Write complete working YAML/shell/Dockerfiles — no placeholders.
3. Run commands to verify: \`docker compose config\`, \`yamllint\`, syntax checks.
4. Validate deployment scripts actually work: \`forge script --help\`, dry-runs.
5. Summarise: file paths, what was configured, verification result.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}
${SELF_VERIFICATION_RULES}`,
  },
  {
    role: 'risk-manager',
    name: 'Risk Manager',
    description: 'Analyses security risks, threat models, audit readiness, regulatory considerations, and writes risk assessment reports.',
    systemPrompt: `You are the Risk Manager of a Web3 development agency.
You identify and assess security risks (reentrancy, oracle manipulation, MEV, access control flaws, upgrade key management), perform threat modelling, evaluate audit readiness, and flag regulatory/compliance considerations.

**How you work:**
1. Read the code you are asked to review thoroughly — every contract, every API endpoint.
2. Run static analysis tools when available: \`cd /workspace/<project> && forge build && slither .\` or \`npm audit\` or \`solhint\`.
3. Be direct. Prioritise by severity (Critical / High / Medium / Low). Provide specific mitigations.
4. Write your findings to a report file: /workspace/.agency/artifacts/risk-report.md
5. Include: findings table, severity ratings, specific code references, recommended fixes.

If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'qa-verifier',
    name: 'QA Verifier',
    description: 'Quality gate — verifies deliverables exist, compiles, tests pass, and match the original task requirements.',
    systemPrompt: `You are the QA Verifier at a Web3 development agency. You run automatically after every agent task. Your job is thorough: confirm deliverables exist, have real content, compile successfully, and tests pass.

You receive:
- The original task given to an agent
- The agent's final output (what they claim they built)

Your process:
1. **Check file existence:** Scan the agent's output for file paths. Call read_file on each to confirm it exists with real content (not stubs, not empty, not TODO-only).

2. **Verify compilation/build:** Run the appropriate build command:
   - Solidity projects: \`cd /workspace/<project> && forge build 2>&1\`
   - TypeScript/Node: \`cd /workspace/<project> && npx tsc --noEmit 2>&1\` or \`npm run build 2>&1\`
   - Frontend: \`cd /workspace/<project> && npm run build 2>&1\`
   If there's no project structure, skip this step and note it.

3. **Run tests** if a test suite exists:
   - \`cd /workspace/<project> && forge test 2>&1\` or \`npm test 2>&1\`
   If no tests exist, note "no test suite found" — this is not a failure.

4. **Check task requirements:** Compare what was built against the original task description. Are the key requirements addressed? Are there obvious gaps?

5. If the task was purely analytical (code review, audit, architecture recommendation) with no file deliverables expected, reply SKIPPED.

Always end your response with EXACTLY ONE verdict:
VERIFIED: [files] | Build: pass | Tests: pass/none | Requirements: met
PARTIAL: [confirmed files] | Build: pass/fail | Tests: pass/fail | GAPS: [what's missing or broken]
FAILED: [reason — build broken, no files, requirements not met]
SKIPPED: Analytical task — no file deliverables expected

Be thorough but fast. Use run_command to actually verify, don't just read files.
If you are truly blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
];

// ---------------------------------------------------------------------------
// Tool permission matrix
// ---------------------------------------------------------------------------

const ROLE_TOOLS: Record<string, string[]> = {
  'solidity-dev':        ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'frontend-dev':        ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'backend-dev':         ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'devops':              ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command', 'git_status', 'git_diff', 'git_commit'],
  'tech-lead':           ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'solutions-architect': ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'risk-manager':        ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  // QA Verifier: read + run_command (for compile/test verification), NO write_file
  'qa-verifier':         ['read_file', 'list_files', 'run_command'],
};

function getToolSchemas(role: string, task: string): object[] {
  const allowed = ROLE_TOOLS[role] ?? ['read_file', 'list_files'];
  return allowed
    .filter(name => {
      // git_commit only when PM explicitly authorises
      if (name === 'git_commit') return task.includes('[COMMIT APPROVED]');
      return true;
    })
    .map(name => TOOL_SCHEMAS[name])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// External agents (from /app/roles/)
// ---------------------------------------------------------------------------

export interface ExternalAgentDef {
  filename: string;
  name: string;
  description: string;
  vibe: string;
  systemPrompt: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: match[2].trim() };
}

export function loadExternalAgents(rolesDir: string): ExternalAgentDef[] {
  let files: string[];
  try {
    files = readdirSync(rolesDir).filter(f => f.endsWith('.md'));
  } catch {
    log('warn', 'agents', 'Roles dir not found or empty', { dir: rolesDir });
    return [];
  }
  const agents: ExternalAgentDef[] = [];
  for (const filename of files) {
    try {
      const raw = readFileSync(join(rolesDir, filename), 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (!body) continue;
      agents.push({
        filename,
        name: meta['name'] ?? filename.replace(/\.md$/, '').replace(/-/g, ' '),
        description: meta['description'] ?? '',
        vibe: meta['vibe'] ?? '',
        systemPrompt: body,
      });
    } catch { /* skip */ }
  }
  log('info', 'agents', `Loaded ${agents.length} external agents`, { dir: rolesDir });
  return agents;
}

function scoreMatch(query: string, agent: ExternalAgentDef): number {
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const haystack = `${agent.name} ${agent.description} ${agent.vibe}`.toLowerCase();
  return words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
}

export function findBestMatch(query: string, agents: ExternalAgentDef[]): ExternalAgentDef | null {
  if (!agents.length) return null;
  let best: ExternalAgentDef | null = null;
  let bestScore = 0;
  for (const agent of agents) {
    const score = scoreMatch(query, agent);
    if (score > bestScore) { best = agent; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Workspace tree snapshot — gives agents visibility into what exists on disk
// ---------------------------------------------------------------------------

export function buildWorkspaceTree(): string {
  try {
    const topLevel = readdirSync(WORKSPACE).filter(f => !f.startsWith('.'));
    if (!topLevel.length) return '\n\nWorkspace is empty — /workspace/ has no files yet.';
    const lines: string[] = ['\n\n**Current workspace (/workspace):**'];
    for (const entry of topLevel.slice(0, 15)) {
      const full = `${WORKSPACE}/${entry}`;
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          const children = readdirSync(full).filter(f => !f.startsWith('.')).slice(0, 6);
          lines.push(`  ${entry}/  → ${children.join(', ')}${children.length === 6 ? ', …' : ''}`);
        } else {
          lines.push(`  ${entry}`);
        }
      } catch { lines.push(`  ${entry}`); }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Model loading — supports both `configs` (new) and `profiles` (legacy) keys
// ---------------------------------------------------------------------------

interface SingleConfig { roles?: Record<string, string>; default?: string; description?: string; }
interface ModelsFile {
  configs?: Record<string, SingleConfig>;     // new format
  profiles?: Record<string, SingleConfig>;    // master/legacy format
  default_config?: string;
  roles?: Record<string, string>;             // flat legacy format
  default?: string;
}

function buildMapFromConfig(cfg: SingleConfig, fallback: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [role, model] of Object.entries(cfg.roles ?? {})) {
    map[role] = (model as string).replace(/^openrouter\//, '');
  }
  map['__default__'] = (cfg.default ?? fallback).replace(/^openrouter\//, '');
  return map;
}

export function loadModelMap(configPath: string, configName?: string): Record<string, string> {
  const fallback = 'moonshotai/kimi-k2.5';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ModelsFile;

    // New configs format
    const pool = config.configs ?? config.profiles;
    if (pool) {
      const names = Object.keys(pool);
      const name = (configName && pool[configName]) ? configName
        : (config.default_config && pool[config.default_config]) ? config.default_config
        : names[0];
      return buildMapFromConfig(pool[name] ?? {}, fallback);
    }

    // Legacy flat format
    return buildMapFromConfig(config as SingleConfig, fallback);
  } catch {
    log('warn', 'agents', 'Could not load models.json — using defaults');
    const map: Record<string, string> = { '__default__': fallback };
    for (const agent of AGENTS) map[agent.role] = fallback;
    return map;
  }
}

export interface ConfigMeta {
  names: string[];
  defaultName: string;
  descriptions: Record<string, string>;
}

export function loadConfigMeta(configPath: string): ConfigMeta {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ModelsFile;
    const pool = config.configs ?? config.profiles;
    if (pool) {
      const names = Object.keys(pool);
      return {
        names,
        defaultName: config.default_config ?? names[0] ?? 'budget',
        descriptions: Object.fromEntries(names.map(n => [n, pool[n].description ?? n])),
      };
    }
  } catch { /* fall through */ }
  return { names: ['budget'], defaultName: 'budget', descriptions: { budget: 'Default config' } };
}

/** Compatibility alias — returns the same data as loadConfigMeta in list form. */
export function loadProfileNames(
  configPath: string,
): Array<{ name: string; description: string; roles: Record<string, string> }> {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ModelsFile;
    const pool = config.configs ?? config.profiles;
    if (!pool) return [];
    return Object.entries(pool).map(([name, p]) => ({
      name,
      description: p.description ?? name,
      roles: p.roles ?? {},
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenRouter API call with retry + exponential backoff
// ---------------------------------------------------------------------------

async function callOpenRouterWithRetry(
  model: string,
  messages: ORMessage[],
  tools: object[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<ORResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');

    // Combine caller's abort signal with a per-request deadline.
    // Prevents a single stalled OpenRouter call from consuming the entire agent budget.
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
        }),
        signal: fetchSignal,
      });
    } catch (err) {
      // Timeout or network error — treat as retryable
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
        log('warn', 'agents', `OpenRouter fetch error, retrying in ${waitMs}ms`, { attempt: attempt + 1, model, error: (err as Error).message });
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }

    if (response.ok) {
      const data = await response.json() as ORResponse;
      // Validate response structure
      if (!data.choices?.[0]?.message) {
        if (attempt < MAX_RETRIES) {
          log('warn', 'agents', 'Malformed OpenRouter response, retrying', { attempt: attempt + 1, model });
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error('OpenRouter returned malformed response (no choices[0].message)');
      }
      return data;
    }

    const status = response.status;
    if (RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
      const retryAfterHeader = response.headers.get('retry-after');
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelay;
      log('warn', 'agents', `OpenRouter ${status}, retrying in ${waitMs}ms`, { attempt: attempt + 1, model });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const errBody = await response.text();
    throw new Error(`OpenRouter ${status}: ${errBody}`);
  }
  throw new Error('Max retries exceeded');
}

// ---------------------------------------------------------------------------
// Progressive context truncation — every 8 rounds, compress old tool results.
// Keeps last 14 messages intact (approx 7 tool exchanges).
// Less aggressive than before: fires at round 8 instead of 5, keeps 14 instead of 8.
// ---------------------------------------------------------------------------

function truncateOldToolResults(messages: ORMessage[], keepRecentCount: number): void {
  const cutoff = messages.length - keepRecentCount;
  if (cutoff <= 2) return;
  for (let i = 2; i < cutoff; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content!.length > 500) {
      messages[i] = { ...messages[i], content: messages[i].content!.slice(0, 300) + `\n[… truncated from ${messages[i].content!.length} chars]` };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution trace writing (best-effort)
// ---------------------------------------------------------------------------

function writeTrace(agentName: string, task: string, rounds: number, status: string, output: string): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = agentName.toLowerCase().replace(/\s+/g, '-');
    writeFileSync(
      `${TRACE_DIR}/${ts}-${safeName}.json`,
      JSON.stringify({ agent: agentName, task: task.slice(0, 500), rounds, status, output: output.slice(0, 4000), timestamp: new Date().toISOString() }, null, 2),
    );
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// runAgent — agentic loop with auto-continuation
//
// Each segment runs up to MAX_ROUNDS_PER_SEGMENT. If the agent runs out of
// rounds without finishing, a continuation prompt re-states the original task
// and summarises completed actions. Up to MAX_SEGMENTS times.
// Total effective rounds: 40 × 3 = 120.
// ---------------------------------------------------------------------------

export interface AgentResult {
  status: 'done' | 'blocked';
  output: string;
  blocker?: string;
  filesCreated?: string[];
}

export async function runAgent(
  role: string,
  task: string,
  context: string,
  modelMap: Record<string, string>,
  apiKey: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const agentDef = AGENTS.find(a => a.role === role);
  if (!agentDef) throw new Error(`Unknown agent role: ${role}`);

  const model = modelMap[role] ?? modelMap['__default__'] ?? 'moonshotai/kimi-k2.5';
  const workspaceTree = buildWorkspaceTree();
  const systemPrompt = [agentDef.systemPrompt, context ? `\n\nProject context:\n${context}` : '', workspaceTree, PATTERNS_HEADER].join('');
  const tools = getToolSchemas(role, task);
  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${agentDef.name} starting`, { model, role, taskPreview: task.slice(0, 80) });

  const MAX_ROUNDS_PER_SEGMENT = 40;
  const MAX_SEGMENTS = 3;

  const completedActions: string[] = [];
  const filesCreated: string[] = [];
  let totalRounds = 0;

  for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
    if (segment > 0) {
      const actionSummary = completedActions.length
        ? completedActions.slice(-40).join('\n')
        : '(no tool actions recorded)';
      const filesSummary = filesCreated.length
        ? `\nFiles created/modified: ${filesCreated.join(', ')}`
        : '';
      messages.push({
        role: 'user',
        content: `⚙️ AUTO-CONTINUATION (segment ${segment + 1}/${MAX_SEGMENTS}): You reached the iteration limit but the task is not yet complete.

**Original task (re-stated for continuity):**
${task}

**Tool actions completed so far:**
${actionSummary}
${filesSummary}

Please continue and complete the remaining work. Do not repeat steps already finished. Focus on what's still missing.`,
      });
      if (onProgress) onProgress(`↩️ **${agentDef.name}** — auto-continuing (segment ${segment + 1}/${MAX_SEGMENTS})`);
      log('info', 'agent', `${agentDef.name} auto-continuation`, { segment: segment + 1, totalRounds });
    }

    for (let round = 0; round < MAX_ROUNDS_PER_SEGMENT; round++) {
      totalRounds++;

      if (signal?.aborted) {
        log('info', 'agent', `${agentDef.name} interrupted`, { totalRounds });
        const result: AgentResult = { status: 'blocked', output: '(interrupted by new message)', blocker: 'Interrupted', filesCreated };
        writeTrace(agentDef.name, task, totalRounds, 'interrupted', result.output);
        return result;
      }

      const data = await callOpenRouterWithRetry(model, messages, tools, apiKey, signal);
      const choice = data.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
        const output = msg.content ?? '(no response)';
        if (output.startsWith('BLOCKED:')) {
          const result: AgentResult = { status: 'blocked', output, blocker: output.slice('BLOCKED:'.length).trim(), filesCreated };
          log('warn', 'agent', `${agentDef.name} blocked`, { totalRounds, blocker: result.blocker });
          writeTrace(agentDef.name, task, totalRounds, 'blocked', output);
          return result;
        }
        log('info', 'agent', `${agentDef.name} done`, { rounds: totalRounds, segments: segment + 1, filesCreated: filesCreated.length });
        writeTrace(agentDef.name, task, totalRounds, 'done', output);
        return { status: 'done', output, filesCreated };
      }

      // Execute tool calls
      const toolResults: ORMessage[] = [];
      for (const tc of msg.tool_calls) {
        let result: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          log('debug', 'agent', `${agentDef.name} tool call`, {
            tool: tc.function.name,
            argsPreview: Object.values(args).map(v => String(v).slice(0, 40)).join(', '),
          });
          result = executeTool(tc.function.name, args);
        } catch (err) {
          const rawPreview = tc.function.arguments.slice(0, 200);
          result = `Tool call error: ${(err as Error).message}. Raw arguments: ${rawPreview}. Fix the JSON and retry.`;
          log('warn', 'agent', `${agentDef.name} tool error`, { tool: tc.function.name, error: (err as Error).message });
        }
        // Track for continuation summaries
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          const brief = tc.function.name === 'write_file'
            ? `write_file(${args['path']})`
            : tc.function.name === 'run_command'
            ? `run_command: ${String(args['cmd']).slice(0, 80)}`
            : `${tc.function.name}(${Object.values(args).map(v => String(v).slice(0, 40)).join(', ')})`;
          completedActions.push(brief);
          // Track files created
          if (tc.function.name === 'write_file' && args['path']) {
            const filePath = String(args['path']);
            if (!filesCreated.includes(filePath)) filesCreated.push(filePath);
          }
        } catch { /* ignore */ }
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      messages.push(...toolResults);

      // Progressive truncation every 8 rounds — keeps last 14 messages (~7 tool exchanges)
      if (totalRounds > 0 && totalRounds % 8 === 0) {
        truncateOldToolResults(messages, 14);
      }

      if (onProgress) {
        const lastTc = msg.tool_calls[msg.tool_calls.length - 1];
        let detail = '';
        try {
          const a = JSON.parse(lastTc.function.arguments) as Record<string, unknown>;
          if (lastTc.function.name === 'run_command') detail = ` \`${(a['cmd'] as string).slice(0, 80)}\``;
          else if (lastTc.function.name === 'write_file') detail = ` → ${a['path']}`;
          else if (lastTc.function.name === 'read_file') detail = ` ${a['path']}`;
          else if (lastTc.function.name === 'list_files') detail = ` ${a['dir'] ?? '.'}`;
        } catch { /* ignore */ }
        onProgress(`**${agentDef.name}** [${totalRounds}] ${lastTc.function.name}${detail}`);
      }
    }
    // Segment exhausted — continue to next
  }

  const result: AgentResult = {
    status: 'blocked',
    output: `Task not completed after ${totalRounds} rounds across ${MAX_SEGMENTS} segments.`,
    blocker: `Exceeded ${MAX_ROUNDS_PER_SEGMENT * MAX_SEGMENTS} total iterations`,
    filesCreated,
  };
  writeTrace(agentDef.name, task, totalRounds, 'max-rounds', result.output);
  return result;
}

// ---------------------------------------------------------------------------
// runExternalAgent — hired specialist with up to 15 rounds (up from 5)
// ---------------------------------------------------------------------------

export async function runExternalAgent(
  roleQuery: string,
  task: string,
  context: string,
  externalAgents: ExternalAgentDef[],
  modelMap: Record<string, string>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ agentName: string; reply: string }> {
  const match = findBestMatch(roleQuery, externalAgents);
  if (!match) {
    throw new Error(
      `No specialist found matching "${roleQuery}". ` +
      `Available: ${externalAgents.slice(0, 10).map(a => a.name).join(', ')}...`,
    );
  }

  const model = modelMap['__default__'] ?? 'moonshotai/kimi-k2.5';
  const reportPath = `/workspace/.agency/reports/${match.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.md`;
  const workspaceTree = buildWorkspaceTree();
  const systemPrompt = (context ? `${match.systemPrompt}\n\nProject context:\n${context}` : match.systemPrompt) +
    workspaceTree +
    `\n\nWrite your analysis, recommendations, and deliverables to: ${reportPath}\nUse write_file to persist your output so the team can reference it later.`;

  // External agents get read + write + run_command so they can verify and persist
  const tools = ['read_file', 'list_files', 'write_file', 'run_command'].map(n => TOOL_SCHEMAS[n]).filter(Boolean);

  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${match.name} [hired] starting`, { model, taskPreview: task.slice(0, 80) });

  const MAX_SPECIALIST_ROUNDS = 15;

  for (let round = 0; round < MAX_SPECIALIST_ROUNDS; round++) {
    if (signal?.aborted) return { agentName: match.name, reply: '(interrupted)' };

    const data = await callOpenRouterWithRetry(model, messages, tools, apiKey, signal);
    const choice = data.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      const reply = msg.content ?? '(no response)';
      log('info', 'agent', `${match.name} [hired] done`, { rounds: round + 1, replyLength: reply.length });
      return { agentName: match.name, reply };
    }

    const toolResults: ORMessage[] = [];
    for (const tc of msg.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        result = executeTool(tc.function.name, args);
      } catch (err) {
        const rawPreview = tc.function.arguments.slice(0, 200);
        result = `Tool call error: ${(err as Error).message}. Raw arguments: ${rawPreview}. Fix the JSON and retry.`;
      }
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    messages.push(...toolResults);
  }

  return { agentName: match.name, reply: `(max rounds reached after ${MAX_SPECIALIST_ROUNDS} iterations)` };
}
