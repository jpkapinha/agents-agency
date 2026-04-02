/**
 * Agent registry and execution for the Web3 agency.
 *
 * Core team agents run in agentic loops (up to 40 rounds × 3 segments = 120 effective
 * rounds) with file/exec tools. External agents run as single-turn consultants.
 *
 * Features from both branches:
 *   - Auto-continuation (3 segments × 40 rounds) — handles complex multi-file tasks
 *   - Retry with exponential backoff (429/500/502/503/504 + Retry-After header)
 *   - AbortSignal propagation — clean interrupt when user sends a new message
 *   - Execution traces written to /workspace/.agency/traces/ (best-effort)
 *   - Progressive context truncation every 5 rounds
 *   - Structured JSON logging via logger.ts
 *   - SHELL_HYGIENE_RULES injected into every agent with shell access
 *   - QA Verifier agent — auto quality gate after every task
 *   - read_pdf tool available to all agents
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
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
// Prevents the most common LLM agent failure modes: wrong paths, garbage
// filenames, relative paths, commands that assume cwd persists.
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

4. **Never rely on cwd persisting between run_command calls.** Each call starts fresh. Use \`&&\` to chain or pass \`-C /workspace/...\` flags.
   ✅ \`run_command("cd /workspace/frontend && npm install")\`
   ❌ \`run_command("cd /workspace/frontend")\` — then assuming you're still there

5. **Verify after every shell command that creates files.** Run \`ls -la /workspace/<dir>\` immediately after to confirm. Delete garbage files if you see them.

6. **After every write_file call, call read_file on the same path.** If the file is empty or missing, write it again. Never claim a file exists unless read_file confirmed it.

7. **Never create files outside /workspace.** Do not write to /, /tmp, /home, or anywhere else.

8. **Check before creating.** Use \`list_files("/workspace")\` to see what already exists before running init commands.`;

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
Work iteratively: read existing code first, write your implementation, run forge build/test, fix errors, repeat until tests pass.
When done, provide a concise summary of what you built, the confirmed file paths, and the test results.
If you are truly blocked (missing external dependency, need human decision), reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'tech-lead',
    name: 'Tech Lead',
    description: 'Sets engineering standards, reviews architecture, evaluates technical trade-offs, and ensures code quality across the stack.',
    systemPrompt: `You are the Tech Lead of a Web3 development agency.
You own engineering standards, architecture decisions, and code quality. You evaluate build-vs-buy trade-offs, select libraries, and set patterns the rest of the team follows.
You can read existing code and run commands to verify your recommendations (e.g. forge test, npm test, tsc --noEmit).
Be opinionated and concise. Provide clear technical recommendations with brief rationale.
If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'solutions-architect',
    name: 'Solutions Architect',
    description: 'Designs end-to-end system architecture for Web3 applications — on-chain, off-chain, and integrations.',
    systemPrompt: `You are a Solutions Architect at a Web3 development agency.
You design complete system architectures: smart contract layers, off-chain services, indexing strategies (The Graph, custom indexers), frontend architecture, wallet integrations, cross-chain bridges, and infrastructure.
Read existing files to understand the current state before proposing architecture.
You can run commands to validate your architecture decisions (e.g. tsc --noEmit, forge build, npm run build).
Document your architecture decisions in /workspace/.agency/artifacts/architecture.md.
Focus on scalability, security, and pragmatism. Avoid over-engineering.
If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'frontend-dev',
    name: 'Frontend Developer',
    description: 'Builds React/Next.js Web3 UIs — wallet connections, contract interactions, real-time on-chain data, and responsive design.',
    systemPrompt: `You are a senior frontend developer at a Web3 development agency.
You specialise in React, Next.js, TypeScript, wagmi/viem, ethers.js, RainbowKit/ConnectKit wallet UX, and responsive design with Tailwind CSS.
Read existing code first. Write complete component implementations. Run npm commands to install deps and verify builds.
When done, summarise what you built and list the confirmed file paths.
If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'backend-dev',
    name: 'Backend Developer',
    description: 'Builds off-chain services — Node.js APIs, event indexers, cron jobs, database schemas, and integrations with on-chain contracts.',
    systemPrompt: `You are a senior backend developer at a Web3 development agency.
You build off-chain infrastructure: Node.js/TypeScript REST and GraphQL APIs, event listeners and indexers (ethers.js, viem), PostgreSQL/Redis schemas, job queues, and IPFS/Arweave integrations.
Read existing code first. Write production-ready code. Run npm commands to verify.
When done, summarise what you built and list the confirmed file paths.
If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'devops',
    name: 'DevOps Engineer',
    description: 'Handles infrastructure, Docker, CI/CD pipelines, deployments, monitoring, and cloud configuration.',
    systemPrompt: `You are a DevOps engineer at a Web3 development agency.
You handle Docker/Docker Compose, GitHub Actions CI/CD, contract deployment scripts (Foundry scripts, Hardhat Ignition), multi-env configuration, and monitoring.
Read existing config files first. Write complete working YAML/shell. Run commands to verify.
When done, summarise what you set up and list the confirmed file paths.
If you are blocked, reply with: BLOCKED: <reason>
${SHELL_HYGIENE_RULES}`,
  },
  {
    role: 'risk-manager',
    name: 'Risk Manager',
    description: 'Analyses security risks, threat models, audit readiness, regulatory considerations, and operational risks for Web3 systems.',
    systemPrompt: `You are the Risk Manager of a Web3 development agency.
You identify and assess security risks (reentrancy, oracle manipulation, MEV, access control flaws, upgrade key management), perform threat modelling, evaluate audit readiness, and flag regulatory/compliance considerations.
Read the code you are asked to review. Run static analysis tools when available (slither, solhint, npm audit). Be direct. Prioritise by severity (Critical / High / Medium / Low). Provide specific mitigations.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'qa-verifier',
    name: 'QA Verifier',
    description: 'Internal quality gate — verifies that claimed deliverables actually exist and have real, non-stub content. Runs automatically after every agent task.',
    systemPrompt: `You are the QA Verifier at a Web3 development agency. You run automatically after every agent task. Your job is fast and focused: confirm that deliverables claimed by the previous agent actually exist and contain real, complete content — not stubs, not placeholders, not empty files.

You receive:
- The original task given to an agent
- The agent's final output (what they claim they built)

Your process:
1. Scan the agent's output for every file path mentioned (e.g. /workspace/contracts/Token.sol).
2. For EACH claimed file: call read_file to confirm it exists and has real content.
   Mark a file as a STUB if it: is empty, contains only comments, has lines like "TODO", "PLACEHOLDER", "implement me", or is under 10 meaningful lines for a code file.
3. If no specific paths were mentioned, call list_files on /workspace and relevant subdirectories.
4. If the task was purely analytical (a code review, audit report, architecture recommendation) and no file writes were expected — immediately reply SKIPPED without reading any files.

Always end your response with EXACTLY ONE of these verdicts on its own line:
VERIFIED: [comma-separated list of confirmed files with one-line note each]
PARTIAL: [confirmed files] | MISSING: [absent or stub files with details]
FAILED: [all claimed files missing or stubs — explain specifically what is wrong]
SKIPPED: Analytical task — no file deliverables expected

Be fast and direct. Reading the first 30 lines of each file is sufficient to judge real vs. stub content.
If you are truly blocked, reply with: BLOCKED: <reason>`,
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
  'tech-lead':           ['read_pdf', 'read_file', 'list_files', 'run_command'],
  'solutions-architect': ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'risk-manager':        ['read_pdf', 'read_file', 'list_files', 'run_command'],
  // QA Verifier is read-only — must never write or run commands
  'qa-verifier':         ['read_file', 'list_files'],
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

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
      }),
      signal,
    });

    if (response.ok) {
      return response.json() as Promise<ORResponse>;
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
// Progressive context truncation — every 5 rounds, compress old tool results
// ---------------------------------------------------------------------------

function truncateOldToolResults(messages: ORMessage[], keepRecentCount: number): void {
  const cutoff = messages.length - keepRecentCount;
  if (cutoff <= 2) return;
  for (let i = 2; i < cutoff; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content!.length > 300) {
      messages[i] = { ...messages[i], content: `[truncated — ${messages[i].content!.length} chars]` };
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
      JSON.stringify({ agent: agentName, task: task.slice(0, 200), rounds, status, output: output.slice(0, 2000), timestamp: new Date().toISOString() }, null, 2),
    );
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// runAgent — agentic loop with auto-continuation
//
// Each segment runs up to MAX_ROUNDS_PER_SEGMENT. If the agent runs out of
// rounds without finishing, a continuation prompt is injected summarising
// completed actions and a new segment starts — up to MAX_SEGMENTS times.
// Total effective rounds: 40 × 3 = 120.
// ---------------------------------------------------------------------------

export interface AgentResult {
  status: 'done' | 'blocked';
  output: string;
  blocker?: string;
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
  const systemPrompt = [agentDef.systemPrompt, context ? `\n\nProject context: ${context}` : '', PATTERNS_HEADER].join('');
  const tools = getToolSchemas(role, task);
  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${agentDef.name} starting`, { model, role, taskPreview: task.slice(0, 80) });

  const MAX_ROUNDS_PER_SEGMENT = 40;
  const MAX_SEGMENTS = 3;

  let completedActions: string[] = [];
  let totalRounds = 0;

  for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
    if (segment > 0) {
      const actionSummary = completedActions.length
        ? completedActions.slice(-30).join('\n')
        : '(no tool actions recorded)';
      messages.push({
        role: 'user',
        content: `⚙️ AUTO-CONTINUATION (segment ${segment + 1}/${MAX_SEGMENTS}): You reached the iteration limit but the task is not yet complete.\n\nTool actions completed so far:\n${actionSummary}\n\nPlease continue and complete the remaining work. Do not repeat steps already finished.`,
      });
      if (onProgress) onProgress(`↩️ **${agentDef.name}** — auto-continuing (segment ${segment + 1}/${MAX_SEGMENTS})`);
      log('info', 'agent', `${agentDef.name} auto-continuation`, { segment: segment + 1, totalRounds });
    }

    for (let round = 0; round < MAX_ROUNDS_PER_SEGMENT; round++) {
      totalRounds++;

      if (signal?.aborted) {
        log('info', 'agent', `${agentDef.name} interrupted`, { totalRounds });
        const result: AgentResult = { status: 'blocked', output: '(interrupted by new message)', blocker: 'Interrupted' };
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
          const result: AgentResult = { status: 'blocked', output, blocker: output.slice('BLOCKED:'.length).trim() };
          log('warn', 'agent', `${agentDef.name} blocked`, { totalRounds, blocker: result.blocker });
          writeTrace(agentDef.name, task, totalRounds, 'blocked', output);
          return result;
        }
        log('info', 'agent', `${agentDef.name} done`, { rounds: totalRounds, segments: segment + 1 });
        writeTrace(agentDef.name, task, totalRounds, 'done', output);
        return { status: 'done', output };
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
        } catch { /* ignore */ }
        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      messages.push(...toolResults);

      // Progressive truncation every 5 rounds — keeps recent context, compresses older results
      if (totalRounds > 0 && totalRounds % 5 === 0) {
        truncateOldToolResults(messages, 8);
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
  };
  writeTrace(agentDef.name, task, totalRounds, 'max-rounds', result.output);
  return result;
}

// ---------------------------------------------------------------------------
// runExternalAgent — single-turn consultant with write access for reports
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
  const systemPrompt = (context ? `${match.systemPrompt}\n\nProject context: ${context}` : match.systemPrompt) +
    `\n\nWrite your analysis, recommendations, and deliverables to: ${reportPath}\nUse write_file to persist your output so the team can reference it later.`;

  // External agents get read + write tools so they can persist their analysis
  const tools = ['read_file', 'list_files', 'write_file'].map(n => TOOL_SCHEMAS[n]).filter(Boolean);

  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${match.name} [hired] starting`, { model, taskPreview: task.slice(0, 80) });

  for (let round = 0; round < 5; round++) {
    if (signal?.aborted) return { agentName: match.name, reply: '(interrupted)' };

    const data = await callOpenRouterWithRetry(model, messages, tools, apiKey, signal);
    const choice = data.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      const reply = msg.content ?? '(no response)';
      log('info', 'agent', `${match.name} [hired] done`, { replyLength: reply.length });
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

  return { agentName: match.name, reply: '(max rounds reached)' };
}
