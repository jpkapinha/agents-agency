/**
 * Agent registry for the Web3 agency.
 * Defines specialist roles, their system prompts, and the runAgent() helper
 * that calls OpenRouter with the appropriate model per config/models.json.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface AgentDef {
  role: string;        // slug matching models.json key
  name: string;        // display name
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
You write production-quality Solidity (0.8.x), complete NatSpec documentation, and Foundry/Hardhat test suites.
When asked for code, provide complete, compilable contracts. Flag any security concerns inline.
Be direct and technical — your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'tech-lead',
    name: 'Tech Lead',
    description: 'Sets engineering standards, reviews architecture, evaluates technical trade-offs, and ensures code quality across the stack.',
    systemPrompt: `You are the Tech Lead of a Web3 development agency.
You own engineering standards, architecture decisions, and code quality. You evaluate build-vs-buy trade-offs, select libraries, and set patterns the rest of the team follows.
Your expertise spans full-stack Web3: Solidity, TypeScript, Node.js, React, The Graph, IPFS, and cloud infrastructure.
Be opinionated and concise. Provide clear technical recommendations with brief rationale.
Your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'solutions-architect',
    name: 'Solutions Architect',
    description: 'Designs end-to-end system architecture for Web3 applications — on-chain, off-chain, and integrations.',
    systemPrompt: `You are a Solutions Architect at a Web3 development agency.
You design complete system architectures: smart contract layers, off-chain services, indexing strategies (The Graph, custom indexers), frontend architecture, wallet integrations, cross-chain bridges, and infrastructure.
You produce architecture diagrams (described in text), component breakdowns, data flow diagrams, and technology selection rationale.
Focus on scalability, security, and pragmatism. Avoid over-engineering.
Your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'frontend-dev',
    name: 'Frontend Developer',
    description: 'Builds React/Next.js Web3 UIs — wallet connections, contract interactions, real-time on-chain data, and responsive design.',
    systemPrompt: `You are a senior frontend developer at a Web3 development agency.
You specialise in React, Next.js, TypeScript, wagmi/viem, ethers.js, RainbowKit/ConnectKit wallet UX, real-time on-chain data (WebSocket providers, event subscriptions), and responsive design with Tailwind CSS.
You write clean, accessible, performant UI code. When producing code, include complete component implementations.
Your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'backend-dev',
    name: 'Backend Developer',
    description: 'Builds off-chain services — Node.js APIs, event indexers, cron jobs, database schemas, and integrations with on-chain contracts.',
    systemPrompt: `You are a senior backend developer at a Web3 development agency.
You build off-chain infrastructure: Node.js/TypeScript REST and GraphQL APIs, event listeners and indexers (ethers.js, viem), PostgreSQL/Redis schemas, job queues, webhook systems, and IPFS/Arweave integrations.
You write production-ready code with proper error handling, logging, and observability.
Your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'devops',
    name: 'DevOps Engineer',
    description: 'Handles infrastructure, Docker, CI/CD pipelines, deployments, monitoring, and cloud configuration.',
    systemPrompt: `You are a DevOps engineer at a Web3 development agency.
You handle Docker/Docker Compose, GitHub Actions CI/CD, contract deployment scripts (Foundry scripts, Hardhat Ignition), multi-env configuration, monitoring (Grafana, alerts), cloud infrastructure (AWS/GCP), and security hardening.
When asked for pipelines or scripts, provide complete working YAML/shell. Be concise and practical.
Your output goes to the Project Manager who relays it to the client.`,
  },
  {
    role: 'risk-manager',
    name: 'Risk Manager',
    description: 'Analyses security risks, threat models, audit readiness, regulatory considerations, and operational risks for Web3 systems.',
    systemPrompt: `You are the Risk Manager of a Web3 development agency.
You identify and assess security risks (reentrancy, oracle manipulation, MEV, access control flaws, upgrade key management), perform threat modelling, evaluate audit readiness, and flag regulatory/compliance considerations (token classification, KYC/AML exposure).
Be direct and prioritise by severity (Critical / High / Medium / Low). Provide specific mitigations, not just warnings.
Your output goes to the Project Manager who relays it to the client.`,
  },
];

// ---------------------------------------------------------------------------
// External agents (loaded from /app/nanoclaw/roles/ at runtime)
// ---------------------------------------------------------------------------

export interface ExternalAgentDef {
  filename: string;    // e.g. "engineering-frontend-developer.md"
  name: string;        // from frontmatter
  description: string; // from frontmatter
  vibe: string;        // from frontmatter (one-liner personality)
  systemPrompt: string;// markdown body — used as system prompt
}

/** Parse YAML frontmatter + body from a markdown file. No external deps. */
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

/**
 * Reads all .md files from rolesDir and returns parsed agent definitions.
 * Called once at bot startup after install-agency-agents.sh has populated the dir.
 */
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
      if (!body) continue; // skip empty files
      agents.push({
        filename,
        name: meta['name'] ?? filename.replace(/\.md$/, '').replace(/-/g, ' '),
        description: meta['description'] ?? '',
        vibe: meta['vibe'] ?? '',
        systemPrompt: body,
      });
    } catch {
      // skip unreadable files silently
    }
  }

  console.log(`[agents] Loaded ${agents.length} external agents from ${rolesDir}`);
  return agents;
}

/** Score how well an agent matches a free-text query (word overlap). */
function scoreMatch(query: string, agent: ExternalAgentDef): number {
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const haystack = `${agent.name} ${agent.description} ${agent.vibe}`.toLowerCase();
  return words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
}

/**
 * Find the external agent that best matches a natural-language role description.
 * Returns null if no file scored > 0.
 */
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

/**
 * Reads /app/config/models.json and returns a role→modelId map.
 * Strips the "openrouter/" prefix that NanoClaw uses internally.
 */
export function loadModelMap(configPath: string): Record<string, string> {
  const fallback = 'anthropic/claude-sonnet-4-5';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { roles?: Record<string, string>; default?: string };
    const map: Record<string, string> = {};
    for (const [role, model] of Object.entries(config.roles ?? {})) {
      // Strip "openrouter/" prefix so we pass a bare model ID to OpenRouter API
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
// runAgent
// ---------------------------------------------------------------------------

interface OpenRouterMessage {
  role: string;
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * Calls a specialist agent via OpenRouter.
 * @param role     - agent slug (must exist in AGENTS)
 * @param task     - the task/question from the PM
 * @param context  - optional project context to prepend
 * @param modelMap - role→modelId map from loadModelMap()
 * @param apiKey   - OpenRouter API key
 */
export async function runAgent(
  role: string,
  task: string,
  context: string,
  modelMap: Record<string, string>,
  apiKey: string,
): Promise<string> {
  const agentDef = AGENTS.find(a => a.role === role);
  if (!agentDef) throw new Error(`Unknown agent role: ${role}`);

  const model = modelMap[role] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
  const systemPrompt = context
    ? `${agentDef.systemPrompt}\n\nProject context: ${context}`
    : agentDef.systemPrompt;

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  console.log(`[agent] ${agentDef.name} (${model}) — task: ${task.slice(0, 80)}...`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error for ${role} (${model}) ${response.status}: ${err}`);
  }

  const data = await response.json() as OpenRouterResponse;
  const reply = data.choices[0]?.message?.content ?? '(no response)';
  console.log(`[agent] ${agentDef.name} — replied (${reply.length} chars)`);
  return reply;
}

/**
 * Hire and run an external specialist from the agency-agents roster.
 * Fuzzy-matches roleQuery against loaded markdown files, then calls OpenRouter.
 * Always uses the default model (no per-role override for external agents).
 */
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
      `Available roles: ${externalAgents.slice(0, 10).map(a => a.name).join(', ')}...`,
    );
  }

  const model = modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
  const systemPrompt = context
    ? `${match.systemPrompt}\n\nProject context: ${context}`
    : match.systemPrompt;

  console.log(`[agent] ${match.name} [hired] (${model}) — task: ${task.slice(0, 80)}...`);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error for ${match.name} (${model}) ${response.status}: ${err}`);
  }

  const data = await response.json() as OpenRouterResponse;
  const reply = data.choices[0]?.message?.content ?? '(no response)';
  console.log(`[agent] ${match.name} [hired] — replied (${reply.length} chars)`);
  return { agentName: match.name, reply };
}
