/**
 * Agent registry and execution for the Web3 agency.
 *
 * Core team agents run in agentic loops (up to 40 rounds × 3 segments = 120 effective rounds) with file/exec tools.
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
// Shared shell hygiene rules — injected into every agent with run_command access.
// These prevent the most common failure modes: garbage filenames, wrong paths,
// files created outside /workspace, and commands treated as pseudocode.
// ---------------------------------------------------------------------------

const SHELL_HYGIENE_RULES = `
**SHELL COMMAND RULES — follow these exactly or you will create garbage files:**

1. **Always use full absolute paths.** Every file and directory must start with \`/workspace/\`. Never use bare names, \`./\`, or relative paths.
   ✅ \`write_file("/workspace/contracts/Token.sol", ...)\`
   ❌ \`write_file("Token.sol", ...)\`  ❌ \`write_file("./contracts/Token.sol", ...)\`

2. **Never use commas or brackets to separate multiple paths.** Each tool call handles one path. For shell commands use separate \`run_command\` calls or proper bash syntax.
   ✅ \`run_command("mkdir -p /workspace/contracts")\`  then  \`run_command("mkdir -p /workspace/frontend")\`
   ✅ \`run_command("mkdir -p /workspace/contracts /workspace/frontend")\`
   ❌ \`run_command("mkdir /workspace/contracts, /workspace/frontend")\`

3. **Always quote paths in shell commands.** If a path could ever contain spaces, quote it.
   ✅ \`run_command("cd \\"/workspace/my project\\" && npm install")\`

4. **Never cd without a full command chained after.** Prefer passing \`-C /workspace/...\` flags (git, npm) or using \`&&\` to chain. Never rely on cwd persisting between \`run_command\` calls — each call starts fresh.
   ✅ \`run_command("npm --prefix /workspace/frontend install")\`
   ✅ \`run_command("cd /workspace/frontend && npm install")\`
   ❌ \`run_command("cd /workspace/frontend")\` — then assuming you're still there

5. **Verify after every shell command that creates files or dirs.** Run \`ls -la /workspace/<dir>\` immediately after to confirm what was actually created. If you see unexpected filenames (single chars, punctuation), delete them: \`run_command("rm /workspace/,")\ \`.

6. **After every write_file call, call read_file on the same path.** If the file is empty or missing, write it again. Never claim a file exists unless read_file confirmed it.

7. **Never create files or directories outside /workspace.** The entire product lives under /workspace. Do not write to /, /tmp, /home, or anywhere else.

8. **Check before creating.** Use \`list_files("/workspace")\` to see what already exists before running mkdir or init commands. Never re-init a git repo, re-run npm init, or overwrite existing config files without reading them first.`;

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
1. Scan the agent's output for every file path mentioned (e.g. /workspace/contracts/Token.sol, paths ending in .sol, .ts, .tsx, .js, .json, .md, .yaml, .toml, etc.).
2. For EACH claimed file: call read_file to confirm it exists and has real content.
   Mark a file as a STUB if it: is empty, contains only comments, has lines like "TODO", "PLACEHOLDER", "implement me", "pass", "// ...", or is under 10 meaningful lines for a code file.
3. If no specific paths were mentioned, call list_files on /workspace and relevant subdirectories to check what actually exists.
4. If the task was purely analytical (a code review, audit report, architecture recommendation) and no file writes were expected or claimed — immediately reply SKIPPED without reading any files.

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
  // QA Verifier is read-only — it must never write or run commands
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

// Shape of the new profile-based config (profiles.X.roles / profiles.X.default)
// Also accepts the old flat format (roles / default) for backwards compatibility.
interface ModelsConfig {
  profiles?: Record<string, { description?: string; roles?: Record<string, string>; default?: string }>;
  // legacy flat format
  roles?: Record<string, string>;
  default?: string;
}

function buildRoleMap(roles: Record<string, string>, defaultModel: string): Record<string, string> {
  const strip = (s: string) => s.replace(/^openrouter\//, '');
  const map: Record<string, string> = { '__default__': strip(defaultModel) };
  for (const [role, model] of Object.entries(roles)) {
    map[role] = strip(model);
  }
  return map;
}

export function loadModelMap(configPath: string, profileName?: string): Record<string, string> {
  const fallback = 'anthropic/claude-sonnet-4-5';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ModelsConfig;

    // New profile-based format
    if (config.profiles) {
      const names = Object.keys(config.profiles);
      const name = (profileName && config.profiles[profileName]) ? profileName : names[0];
      const profile = config.profiles[name] ?? {};
      console.log(`[agents] Model profile: ${name}`);
      return buildRoleMap(profile.roles ?? {}, profile.default ?? fallback);
    }

    // Legacy flat format
    return buildRoleMap(config.roles ?? {}, config.default ?? fallback);
  } catch {
    console.warn('[agents] Could not load models.json — using defaults');
    const map: Record<string, string> = { '__default__': fallback };
    for (const agent of AGENTS) map[agent.role] = fallback;
    return map;
  }
}

/** Returns the list of available profile names and their descriptions. */
export function loadProfileNames(configPath: string): Array<{ name: string; description: string; roles: Record<string, string> }> {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ModelsConfig;
    if (!config.profiles) return [];
    return Object.entries(config.profiles).map(([name, p]) => ({
      name,
      description: p.description ?? name,
      roles: p.roles ?? {},
    }));
  } catch {
    return [];
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
  tokensUsed: { prompt: number; completion: number };
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

  // -------------------------------------------------------------------------
  // Agentic loop with auto-continuation.
  // Each segment runs up to MAX_ROUNDS_PER_SEGMENT iterations. If the agent
  // runs out of rounds without finishing, we inject a "continue" prompt and
  // start a new segment — up to MAX_SEGMENTS times. This gives up to
  // 40 × 3 = 120 effective rounds, enough for complex multi-file tasks.
  // -------------------------------------------------------------------------
  const MAX_ROUNDS_PER_SEGMENT = 40;
  const MAX_SEGMENTS           = 3;

  let totalPrompt     = 0;
  let totalCompletion = 0;
  let completedActions: string[] = []; // summary for continuation prompts
  let totalRounds = 0;

  for (let segment = 0; segment < MAX_SEGMENTS; segment++) {

    if (segment > 0) {
      // Inject auto-continuation prompt so the agent knows where it left off
      const actionSummary = completedActions.length
        ? completedActions.slice(-30).join('\n')
        : '(no tool actions recorded)';
      messages.push({
        role: 'user',
        content: [
          `⚙️ AUTO-CONTINUATION (segment ${segment + 1}/${MAX_SEGMENTS}): You reached the iteration limit but the task is not yet complete.`,
          ``,
          `Tool actions completed so far:`,
          actionSummary,
          ``,
          `Please review what has been done, then continue and complete the remaining work. Do not repeat steps already finished.`,
        ].join('\n'),
      });
      if (onProgress) {
        onProgress(`↩️ **${agentDef.name}** — auto-continuing (segment ${segment + 1}/${MAX_SEGMENTS})`);
      }
      console.log(`[agent] ${agentDef.name} segment ${segment + 1} starting — ${totalRounds} rounds used so far`);
    }

    for (let round = 0; round < MAX_ROUNDS_PER_SEGMENT; round++) {
      totalRounds++;

      const data = await callOpenRouter(model, messages, tools, apiKey);
      if (data.usage) {
        totalPrompt     += data.usage.prompt_tokens;
        totalCompletion += data.usage.completion_tokens;
      }
      const choice = data.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
        const output = msg.content ?? '(no response)';
        if (output.startsWith('BLOCKED:')) {
          return { status: 'blocked', output, blocker: output.slice('BLOCKED:'.length).trim(), tokensUsed: { prompt: totalPrompt, completion: totalCompletion } };
        }
        console.log(`[agent] ${agentDef.name} done (${totalRounds} rounds, ${segment + 1} segment(s))`);
        return { status: 'done', output, tokensUsed: { prompt: totalPrompt, completion: totalCompletion } };
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

      // Truncate old tool results at halfway through the segment to prevent
      // context blowout (preserves recent context, shrinks older results)
      if (round === Math.floor(MAX_ROUNDS_PER_SEGMENT / 2)) {
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
        onProgress(`**${agentDef.name}** [${totalRounds}] ${lastTc.function.name}${detail}`);
      }
    }
    // Segment exhausted — loop to next segment
  }

  return {
    status: 'blocked',
    output: `Task not completed after ${totalRounds} rounds across ${MAX_SEGMENTS} segments. The agent may be stuck in a loop or the task may require human input.`,
    blocker: `Exceeded ${MAX_ROUNDS_PER_SEGMENT * MAX_SEGMENTS} total iterations`,
    tokensUsed: { prompt: totalPrompt, completion: totalCompletion },
  };
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
  const reportPath = `/workspace/.agency/reports/${match.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.md`;
  const systemPrompt = (context ? `${match.systemPrompt}\n\nProject context: ${context}` : match.systemPrompt) +
    `\n\nWrite your analysis, recommendations, and deliverables to: ${reportPath}\nUse write_file to persist your output so the team can reference it later.`;

  // External agents get read + write tools so they can persist their analysis
  const tools = ['read_file', 'list_files', 'write_file'].map(n => TOOL_SCHEMAS[n]);

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
