/**
 * Agent registry and execution for the Web3 agency.
 *
 * Core team agents run in agentic loops (up to 20 rounds) with file/exec tools.
 * External agents (from agency-agents roster) run as single-turn consultants.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TOOL_SCHEMAS, PATTERNS_DIR, executeTool } from './tools.js';

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
if (PATTERNS_HEADER) console.log(`[agents] Protofire patterns available: ${PATTERNS_DIR}`);

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
  'solidity-dev':        ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'frontend-dev':        ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'backend-dev':         ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command'],
  'devops':              ['read_pdf', 'read_file', 'write_file', 'list_files', 'run_command', 'git_status', 'git_diff', 'git_commit'],
  'tech-lead':           ['read_pdf', 'read_file', 'list_files'],
  'solutions-architect': ['read_pdf', 'read_file', 'write_file', 'list_files'],
  'risk-manager':        ['read_pdf', 'read_file', 'list_files'],
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
// External agents (from /app/nanoclaw/roles/)
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
    console.warn(`[agents] Roles dir not found or empty: ${rolesDir}`);
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
  console.log(`[agents] Loaded ${agents.length} external agents from ${rolesDir}`);
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

export function loadModelMap(configPath: string): Record<string, string> {
  const fallback = 'anthropic/claude-sonnet-4-5';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { roles?: Record<string, string>; default?: string };
    const map: Record<string, string> = {};
    for (const [role, model] of Object.entries(config.roles ?? {})) {
      map[role] = (model as string).replace(/^openrouter\//, '');
    }
    map['__default__'] = (config.default ?? fallback).replace(/^openrouter\//, '');
    return map;
  } catch {
    console.warn('[agents] Could not load models.json — using defaults');
    const map: Record<string, string> = { '__default__': fallback };
    for (const agent of AGENTS) map[agent.role] = fallback;
    return map;
  }
}

// ---------------------------------------------------------------------------
// OpenRouter types
// ---------------------------------------------------------------------------

interface ORMessage {
  role: string;
  content: string | null;
  tool_calls?: ORToolCall[];
  tool_call_id?: string;
}

interface ORToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ORResponse {
  choices: Array<{ finish_reason: string; message: ORMessage }>;
}

async function callOpenRouter(
  model: string,
  messages: ORMessage[],
  tools: object[],
  apiKey: string,
): Promise<ORResponse> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? 'auto' : undefined }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${err}`);
  }
  return response.json() as Promise<ORResponse>;
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

  console.log(`[agent] ${agentDef.name} (${model}) starting — task: ${task.slice(0, 80)}...`);

  for (let round = 0; round < 20; round++) {
    const data = await callOpenRouter(model, messages, tools, apiKey);
    const choice = data.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      const output = msg.content ?? '(no response)';
      if (output.startsWith('BLOCKED:')) {
        return { status: 'blocked', output, blocker: output.slice('BLOCKED:'.length).trim() };
      }
      console.log(`[agent] ${agentDef.name} done (${round + 1} rounds)`);
      return { status: 'done', output };
    }

    // Execute tool calls
    const toolResults: ORMessage[] = [];
    for (const tc of msg.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        console.log(`[agent] ${agentDef.name} → tool: ${tc.function.name}(${Object.values(args).map(v => String(v).slice(0, 40)).join(', ')})`);
        result = executeTool(tc.function.name, args);
      } catch (err) {
        result = `Tool error: ${(err as Error).message}`;
      }
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    messages.push(...toolResults);

    // Truncate old tool results after round 10 to prevent context blowout
    if (round === 10) {
      for (let i = 2; i < messages.length - 10; i++) {
        if (messages[i].role === 'tool' && messages[i].content && messages[i].content!.length > 500) {
          messages[i] = { ...messages[i], content: `[truncated — ${messages[i].content!.length} chars]` };
        }
      }
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

  return { status: 'blocked', output: 'Max rounds reached without completing the task.', blocker: 'Exceeded 20 iterations' };
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

  console.log(`[agent] ${match.name} [hired] (${model}) — task: ${task.slice(0, 80)}...`);

  for (let round = 0; round < 5; round++) {
    const data = await callOpenRouter(model, messages, tools, apiKey);
    const choice = data.choices[0];
    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      const reply = msg.content ?? '(no response)';
      console.log(`[agent] ${match.name} [hired] done (${reply.length} chars)`);
      return { agentName: match.name, reply };
    }

    const toolResults: ORMessage[] = [];
    for (const tc of msg.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        result = executeTool(tc.function.name, args);
      } catch (err) {
        result = `Tool error: ${(err as Error).message}`;
      }
      toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    messages.push(...toolResults);
  }

  return { agentName: match.name, reply: '(max rounds reached)' };
}
