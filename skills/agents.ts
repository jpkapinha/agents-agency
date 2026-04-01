/**
 * Agent registry and execution for the Web3 agency.
 *
 * Core team agents run in agentic loops (up to 20 rounds) with file/exec tools.
 * External agents (from agency-agents roster) run as single-turn consultants.
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

// Computed once at startup; empty string if no patterns loaded yet
const PATTERNS_HEADER = existsSync(PATTERNS_DIR) ? buildPatternsHeader() : '';
if (PATTERNS_HEADER) log('info', 'agents', 'Protofire patterns available', { dir: PATTERNS_DIR });

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
When done, provide a concise summary of what you built and the test results.
If you are truly blocked (missing external dependency, need human decision), reply with: BLOCKED: <reason>`,
  },
  {
    role: 'tech-lead',
    name: 'Tech Lead',
    description: 'Sets engineering standards, reviews architecture, evaluates technical trade-offs, and ensures code quality across the stack.',
    systemPrompt: `You are the Tech Lead of a Web3 development agency.
You own engineering standards, architecture decisions, and code quality. You evaluate build-vs-buy trade-offs, select libraries, and set patterns the rest of the team follows.
You can read existing code to inform your recommendations.
Be opinionated and concise. Provide clear technical recommendations with brief rationale.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'solutions-architect',
    name: 'Solutions Architect',
    description: 'Designs end-to-end system architecture for Web3 applications — on-chain, off-chain, and integrations.',
    systemPrompt: `You are a Solutions Architect at a Web3 development agency.
You design complete system architectures: smart contract layers, off-chain services, indexing strategies (The Graph, custom indexers), frontend architecture, wallet integrations, cross-chain bridges, and infrastructure.
Read existing files to understand the current state before proposing architecture.
Document your architecture decisions in /workspace/.agency/architecture.md.
Focus on scalability, security, and pragmatism. Avoid over-engineering.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'frontend-dev',
    name: 'Frontend Developer',
    description: 'Builds React/Next.js Web3 UIs — wallet connections, contract interactions, real-time on-chain data, and responsive design.',
    systemPrompt: `You are a senior frontend developer at a Web3 development agency.
You specialise in React, Next.js, TypeScript, wagmi/viem, ethers.js, RainbowKit/ConnectKit wallet UX, and responsive design with Tailwind CSS.
Read existing code first. Write complete component implementations. Run npm commands to install deps and verify builds.
When done, summarise what you built.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'backend-dev',
    name: 'Backend Developer',
    description: 'Builds off-chain services — Node.js APIs, event indexers, cron jobs, database schemas, and integrations with on-chain contracts.',
    systemPrompt: `You are a senior backend developer at a Web3 development agency.
You build off-chain infrastructure: Node.js/TypeScript REST and GraphQL APIs, event listeners and indexers (ethers.js, viem), PostgreSQL/Redis schemas, job queues, and IPFS/Arweave integrations.
Read existing code first. Write production-ready code. Run npm commands to verify.
When done, summarise what you built.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'devops',
    name: 'DevOps Engineer',
    description: 'Handles infrastructure, Docker, CI/CD pipelines, deployments, monitoring, and cloud configuration.',
    systemPrompt: `You are a DevOps engineer at a Web3 development agency.
You handle Docker/Docker Compose, GitHub Actions CI/CD, contract deployment scripts (Foundry scripts, Hardhat Ignition), multi-env configuration, and monitoring.
Read existing config files first. Write complete working YAML/shell. Run commands to verify.
When done, summarise what you set up.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
  {
    role: 'risk-manager',
    name: 'Risk Manager',
    description: 'Analyses security risks, threat models, audit readiness, regulatory considerations, and operational risks for Web3 systems.',
    systemPrompt: `You are the Risk Manager of a Web3 development agency.
You identify and assess security risks (reentrancy, oracle manipulation, MEV, access control flaws, upgrade key management), perform threat modelling, evaluate audit readiness, and flag regulatory/compliance considerations.
Read the code you are asked to review. Be direct. Prioritise by severity (Critical / High / Medium / Low). Provide specific mitigations.
If you are blocked, reply with: BLOCKED: <reason>`,
  },
];

// ---------------------------------------------------------------------------
// Tool permission matrix
// ---------------------------------------------------------------------------

const ROLE_TOOLS: Record<string, string[]> = {
  'solidity-dev':        ['read_file', 'write_file', 'list_files', 'run_command'],
  'frontend-dev':        ['read_file', 'write_file', 'list_files', 'run_command'],
  'backend-dev':         ['read_file', 'write_file', 'list_files', 'run_command'],
  'devops':              ['read_file', 'write_file', 'list_files', 'run_command', 'git_status', 'git_diff', 'git_commit'],
  'tech-lead':           ['read_file', 'list_files'],
  'solutions-architect': ['read_file', 'write_file', 'list_files'],
  'risk-manager':        ['read_file', 'list_files'],
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
// Model loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal type for models.json structure
// ---------------------------------------------------------------------------

interface SingleConfig { roles?: Record<string, string>; default?: string; description?: string; }
interface ModelsFile {
  // New multi-config structure
  configs?: Record<string, SingleConfig>;
  default_config?: string;
  // Legacy flat structure
  roles?: Record<string, string>;
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

    // New multi-config structure
    if (config.configs) {
      const name = configName ?? config.default_config ?? Object.keys(config.configs)[0];
      const namedCfg = config.configs[name] ?? config.configs[Object.keys(config.configs)[0]];
      return buildMapFromConfig(namedCfg, fallback);
    }

    // Legacy flat structure
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
    if (config.configs) {
      const names = Object.keys(config.configs);
      return {
        names,
        defaultName: config.default_config ?? names[0] ?? 'budget',
        descriptions: Object.fromEntries(
          names.map(n => [n, config.configs![n].description ?? n]),
        ),
      };
    }
  } catch { /* fall through */ }
  return { names: ['budget'], defaultName: 'budget', descriptions: { budget: 'Default config' } };
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

    // Retry on transient errors
    if (RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
      const retryAfterHeader = response.headers.get('retry-after');
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelay;

      log('warn', 'agents', `OpenRouter ${status}, retrying in ${waitMs}ms`, {
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        model,
      });

      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Non-retryable error or max retries exceeded
    const errBody = await response.text();
    throw new Error(`OpenRouter ${status}: ${errBody}`);
  }

  throw new Error('Max retries exceeded');
}

// ---------------------------------------------------------------------------
// Progressive context truncation
// ---------------------------------------------------------------------------

function truncateOldToolResults(messages: ORMessage[], keepRecentCount: number): void {
  const cutoff = messages.length - keepRecentCount;
  if (cutoff <= 2) return; // nothing to truncate (skip system + first user)
  for (let i = 2; i < cutoff; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content!.length > 300) {
      messages[i] = { ...messages[i], content: `[truncated — ${messages[i].content!.length} chars]` };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution trace writing (best-effort)
// ---------------------------------------------------------------------------

function writeTrace(
  agentName: string,
  task: string,
  rounds: number,
  status: string,
  output: string,
): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = agentName.toLowerCase().replace(/\s+/g, '-');
    const trace = {
      agent: agentName,
      task: task.slice(0, 200),
      rounds,
      status,
      output: output.slice(0, 2000),
      timestamp: new Date().toISOString(),
    };
    writeFileSync(`${TRACE_DIR}/${ts}-${safeName}.json`, JSON.stringify(trace, null, 2));
  } catch { /* best effort — never fail the agent run */ }
}

// ---------------------------------------------------------------------------
// runAgent — agentic loop
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

  const model = modelMap[role] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
  const systemPrompt = [
    agentDef.systemPrompt,
    context ? `\n\nProject context: ${context}` : '',
    PATTERNS_HEADER,
  ].join('');

  const tools = getToolSchemas(role, task);
  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${agentDef.name} starting`, { model, role, taskPreview: task.slice(0, 80) });

  for (let round = 0; round < 20; round++) {
    // Check for interruption at the top of each round
    if (signal?.aborted) {
      log('info', 'agent', `${agentDef.name} interrupted`, { round });
      const result: AgentResult = { status: 'blocked', output: '(interrupted by new message)', blocker: 'Interrupted' };
      writeTrace(agentDef.name, task, round, 'interrupted', result.output);
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
        log('warn', 'agent', `${agentDef.name} blocked`, { round: round + 1, blocker: result.blocker });
        writeTrace(agentDef.name, task, round + 1, 'blocked', output);
        return result;
      }
      log('info', 'agent', `${agentDef.name} done`, { rounds: round + 1 });
      writeTrace(agentDef.name, task, round + 1, 'done', output);
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
        // Give the LLM actionable feedback so it can self-correct
        const rawPreview = tc.function.arguments.slice(0, 200);
        result = `Tool call error: ${(err as Error).message}. Raw arguments: ${rawPreview}. Fix the JSON and retry.`;
        log('warn', 'agent', `${agentDef.name} tool error`, { tool: tc.function.name, error: (err as Error).message });
      }
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    messages.push(...toolResults);

    // Progressive context truncation — every 5 rounds, compress old tool results
    if (round > 0 && round % 5 === 0) {
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
      onProgress(`**${agentDef.name}** [${round + 1}] ${lastTc.function.name}${detail}`);
    }
  }

  const result: AgentResult = { status: 'blocked', output: 'Max rounds reached without completing the task.', blocker: 'Exceeded 20 iterations' };
  writeTrace(agentDef.name, task, 20, 'max-rounds', result.output);
  return result;
}

// ---------------------------------------------------------------------------
// runExternalAgent — single-turn consultant (read-only)
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

  const model = modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
  const systemPrompt = context ? `${match.systemPrompt}\n\nProject context: ${context}` : match.systemPrompt;

  // External agents get read-only tools (conservative default)
  const tools = ['read_file', 'list_files'].map(n => TOOL_SCHEMAS[n]);

  const messages: ORMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  log('info', 'agent', `${match.name} [hired] starting`, { model, taskPreview: task.slice(0, 80) });

  for (let round = 0; round < 5; round++) {
    if (signal?.aborted) {
      return { agentName: match.name, reply: '(interrupted)' };
    }

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
