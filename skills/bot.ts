/**
 * Andy the Project Manager — PM logic.
 *
 * Merged best-of-both-branches implementation:
 *
 * From feat/production-hardening:
 *   - Retry with exponential backoff for PM's own OpenRouter calls
 *   - Smart history truncation (preserves first message + marker)
 *   - Per-agent 10-minute timeout
 *   - Auto task tracking wired into consult_agent
 *   - CostTracker (class-based, not inline MODEL_PRICING)
 *   - Structured JSON logging
 *   - Plan→approve→build protocol in system prompt
 *   - Discord attachment support (read_file handles PDFs via pdftotext)
 *   - switch_team with named configs + persistence
 *
 * From master:
 *   - channel-send.ts for non-abort-gated background sends
 *   - Background task pool — agents run detached from PM's AbortSignal
 *   - Artifacts subsystem (create_prd, update_artifact, read_artifact, list_artifacts)
 *   - ProjectMemory (tech stack, decisions, milestones) via update_memory
 *   - Active profile persistence across container restarts via setActiveProfile()
 *   - fetch_url PM tool
 *   - get_running_tasks + wait_for_tasks PM tools
 *   - Typing indicator via triggerTyping()
 *   - QA Verifier auto-dispatch after every agent task
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import {
  AGENTS,
  loadModelMap,
  loadConfigMeta,
  runAgent,
  loadExternalAgents,
  runExternalAgent,
  type ExternalAgentDef,
  type ConfigMeta,
} from './agents.js';
import {
  formatStateForPM,
  addRepo,
  addTask,
  updateTask,
  loadState,
  getMemory,
  updateMemory,
  getActiveProfile,
  setActiveProfile,
} from './state.js';
import { runCommand, readPdf } from './tools.js';
import { channelSend, triggerTyping } from './channel-send.js';
import { CostTracker } from './track-cost.js';
import { log } from './logger.js';
import type { ORMessage, ORResponse } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const PROJECT_NAME       = process.env.PROJECT_NAME       || 'Web3 Project';
const MODELS_CONFIG      = '/app/config/models.json';
const ROLES_DIR          = '/app/roles';
const PATTERNS_DIR       = '/app/patterns';
const HISTORY_DIR        = '/workspace/.agency';
const ARTIFACTS_DIR      = '/workspace/.agency/artifacts';
const WORKSPACE          = '/workspace';

const AGENT_TIMEOUT_MS       = 10 * 60 * 1000; // 10 minutes
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES            = 3;

if (!OPENROUTER_API_KEY) { log('error', 'bot', 'OPENROUTER_API_KEY is not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// Multi-team config — persisted across restarts via state.json
// ---------------------------------------------------------------------------

const configMeta: ConfigMeta = loadConfigMeta(MODELS_CONFIG);

// Pre-load all model maps at startup so switching is instant
const allModelMaps: Record<string, Record<string, string>> = {};
for (const name of configMeta.names) {
  allModelMaps[name] = loadModelMap(MODELS_CONFIG, name);
}

// Restore last-used config from state.json — survives container restarts
let activeConfigName: string = getActiveProfile();
if (!configMeta.names.includes(activeConfigName)) {
  activeConfigName = configMeta.defaultName;
}

function getModelMap(): Record<string, string> {
  return allModelMaps[activeConfigName] ?? allModelMaps[configMeta.defaultName];
}

function getPMModel(): string {
  const map = getModelMap();
  return map['project-manager'] ?? map['__default__'] ?? 'moonshotai/kimi-k2.5';
}

// ---------------------------------------------------------------------------
// External agents + cost tracker
// ---------------------------------------------------------------------------

const externalAgents: ExternalAgentDef[] = loadExternalAgents(ROLES_DIR);

const costTracker = new CostTracker();
costTracker.register();

log('info', 'bot', 'PM initialised', {
  activeConfig: activeConfigName,
  model: getPMModel(),
  availableConfigs: configMeta.names,
  coreTeam: AGENTS.map(a => a.role),
  externalRoster: externalAgents.length,
});

// ---------------------------------------------------------------------------
// Background task pool
// Agents run detached from the PM's AbortSignal so the user can keep chatting
// while work happens in the background. channelSend() (non-abort-gated) is
// used for all background progress messages.
// ---------------------------------------------------------------------------

interface BgTask {
  id: string;
  agentName: string;
  taskPreview: string;
  startedAt: Date;
  promise: Promise<void>;
}

const bgPool = new Map<string, BgTask[]>();

function bgAdd(channelId: string, task: BgTask): void {
  const list = bgPool.get(channelId) ?? [];
  list.push(task);
  bgPool.set(channelId, list);
}

function bgRemove(channelId: string, id: string): void {
  const list = bgPool.get(channelId) ?? [];
  bgPool.set(channelId, list.filter(t => t.id !== id));
}

function bgList(channelId: string): BgTask[] {
  return bgPool.get(channelId) ?? [];
}

// ---------------------------------------------------------------------------
// Artifacts subsystem
// Project documents live in /workspace/.agency/artifacts/ — shared between
// the PM and the client (who can edit them on their machine via the volume).
// ---------------------------------------------------------------------------

const ARTIFACT_DESCRIPTIONS: Record<string, string> = {
  'prd.md':           'Product Requirements Document',
  'backlog.md':       'Product backlog — prioritised user stories',
  'tasks.md':         'Current sprint task list',
  'architecture.md':  'System architecture decisions',
  'decisions.md':     'Architecture decision log',
  'changelog.md':     'Change log — pivots and updates',
  'change-plan.md':   'Active change / pivot plan',
  'risk-report.md':   'Security risk assessment',
};

function ensureArtifactsDir(): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function listArtifactFiles(): Array<{ name: string; description: string; size: number; modified: string }> {
  try {
    ensureArtifactsDir();
    return readdirSync(ARTIFACTS_DIR)
      .filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.pdf'))
      .map(f => {
        try {
          const st = statSync(`${ARTIFACTS_DIR}/${f}`);
          return {
            name: f,
            description: ARTIFACT_DESCRIPTIONS[f] ?? f.replace(/[-_]/g, ' ').replace(/\.\w+$/, ''),
            size: st.size,
            modified: st.mtime.toISOString().slice(0, 16).replace('T', ' '),
          };
        } catch { return null; }
      })
      .filter(Boolean) as Array<{ name: string; description: string; size: number; modified: string }>;
  } catch {
    return [];
  }
}

function writeArtifact(name: string, content: string): string {
  ensureArtifactsDir();
  const safe = name.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/\.\.+/g, '.');
  const path = `${ARTIFACTS_DIR}/${safe}`;
  writeFileSync(path, content, 'utf-8');
  return path;
}

function readArtifact(name: string): string {
  ensureArtifactsDir();
  const safe = name.replace(/[^a-zA-Z0-9.\-_]/g, '-').replace(/\.\.+/g, '.');
  try {
    return readFileSync(`${ARTIFACTS_DIR}/${safe}`, 'utf-8');
  } catch {
    return `(artifact "${name}" not found — use list_artifacts to see what exists)`;
  }
}

// ---------------------------------------------------------------------------
// OpenRouter call with retry + exponential backoff (PM loop only)
// ---------------------------------------------------------------------------

async function callPMWithRetry(
  messages: ORMessage[],
  tools: object[],
  signal?: AbortSignal,
): Promise<ORResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getPMModel(),
        messages,
        tools,
        tool_choice: 'auto',
      }),
      signal,
    });

    if (response.ok) return response.json() as Promise<ORResponse>;

    const status = response.status;
    if (RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
      const retryAfterHeader = response.headers.get('retry-after');
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : baseDelay;
      log('warn', 'bot', `OpenRouter PM ${status}, retrying in ${waitMs}ms`, { attempt: attempt + 1, model: getPMModel() });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const err = await response.text();
    throw new Error(`OpenRouter PM error ${status}: ${err}`);
  }
  throw new Error('Max retries exceeded');
}

// ---------------------------------------------------------------------------
// Per-channel conversation history (in-memory + disk)
// ---------------------------------------------------------------------------

const histories: Record<string, ORMessage[]> = {};

function saveHistory(channelId: string, history: ORMessage[]): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(`${HISTORY_DIR}/history-${channelId}.json`, JSON.stringify(history, null, 2), 'utf-8');
  } catch (err) {
    log('error', 'bot', 'Failed to save history', { error: (err as Error).message });
  }
}

function loadHistory(channelId: string): ORMessage[] {
  try {
    const raw = readFileSync(`${HISTORY_DIR}/history-${channelId}.json`, 'utf-8');
    return JSON.parse(raw) as ORMessage[];
  } catch {
    return [];
  }
}

/**
 * Smart history truncation — preserves the first user message (establishes
 * project context) and the most recent messages. Inserts a truncation marker.
 */
function truncateHistory(history: ORMessage[], maxMessages = 40): ORMessage[] {
  if (history.length <= maxMessages) return history;
  const first = history[0];
  const tail = history.slice(-(maxMessages - 2));
  const dropped = history.length - maxMessages;
  return [
    first,
    { role: 'system', content: `[${dropped} earlier messages truncated to save context]` },
    ...tail,
  ];
}

// ---------------------------------------------------------------------------
// Pending decision requests
// ---------------------------------------------------------------------------

const pendingDecisions = new Map<string, (answer: string) => void>();

export function resolveDecision(channelId: string, answer: string): boolean {
  const resolver = pendingDecisions.get(channelId);
  if (resolver) { resolver(answer); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

function buildAgentContext(): string {
  const base = `Project: ${PROJECT_NAME}`;
  try {
    const state = loadState();
    const recentDone = state.tasks
      .filter(t => t.status === 'done' && t.result)
      .slice(-3)
      .map(t => `[${t.assignee}] ${t.title}: ${t.result}`)
      .join('\n');
    if (recentDone) return `${base}\n\nRecent completed work:\n${recentDone}`;
  } catch { /* best effort */ }
  return base;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

function validateRepoUrl(url: string): string | null {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  return GITHUB_URL_RE.test(cleaned) ? cleaned : null;
}

// ---------------------------------------------------------------------------
// PM system prompt
// ---------------------------------------------------------------------------

function patternsNote(): string {
  try {
    const files = readdirSync(PATTERNS_DIR).filter(f => !f.startsWith('.'));
    if (!files.length) return '';
    return `\n**Protofire Web3 Patterns** are loaded at \`${PATTERNS_DIR}/\` (${files.length} files). When delegating to specialists, mention relevant patterns or ask them to check that directory.\n`;
  } catch {
    return '';
  }
}

function buildPMSystemPrompt(): string {
  const state = formatStateForPM();
  return `You are Andy, the Project Manager of a Web3 development agency. You are the sole point of contact with the client — all other agents work internally.

**Your identity:** You are Andy, an AI Project Manager. Your current underlying model is \`${getPMModel()}\` (team: \`${activeConfigName}\`). When asked what AI or model you are, state this accurately.

**Your core team** (use \`consult_agent\`):
${AGENTS.filter(a => a.role !== 'qa-verifier').map(a => `- **${a.name}** (${a.role}): ${a.description}`).join('\n')}

**External roster** (use \`hire_specialist\`):
You can hire any of ${externalAgents.length} additional specialists — UX designers, legal advisors, data scientists, technical writers, marketing strategists, and more.

**How to work — MANDATORY PROTOCOL:**

**PHASE 1 — UNDERSTAND (always first):**
1. When the client shares a PRD, spec, or any document: call \`read_file\` immediately to read it fully. Never ask them to paste content.
2. When the client shares a URL: call \`fetch_url\` immediately to retrieve its contents.
3. After reading, identify any ambiguities. Ask ALL clarifying questions in a single message — not one at a time.
4. Do NOT proceed to Phase 2 until you have enough information to plan confidently.

**PHASE 2 — PLAN (always before building):**
5. Once you understand the requirements, call \`create_prd\` to structure them into a formal PRD. Then \`send_artifact\` it to the client.
6. Follow with a clear plan message: tech stack, architecture overview, task breakdown per agent, risks.
7. End with: **"Does this plan look good? Reply 'approved' or let me know what to change."**
8. Call \`update_memory\` to record the tech stack and key decisions.
9. STOP. Do not call \`consult_agent\` yet. Wait for explicit approval.

**PHASE 3 — BUILD (only after explicit client approval):**
10. Once the client approves, call \`send_update\` with a kick-off message, then dispatch agents using \`consult_agent\`. Agents run **in the background** — you do NOT wait for them. The client can keep chatting with you while they work.
11. Use \`get_running_tasks\` when asked for a status update.
12. Use \`wait_for_tasks\` when the next step depends on a currently running agent's output.

**PHASE 4 — DELIVER:**
13. Use \`send_artifact\` to deliver documents and files. Agents generate PDFs via: run_command("pandoc doc.md -o doc.pdf"). Agents open PRs via: run_command("gh pr create ...").
14. After delivery, use \`update_memory\` to record the milestone.

**Always:**
- Use \`get_state\` at the start of a session to recall what has already been done.
- Use \`list_artifacts\` to show the client what project documents exist.
- Use \`read_artifact\` to read the latest version before re-dispatching agents (client may have edited the file).
- Use \`add_repo\` when the client provides a GitHub URL.
- Answer greetings and simple questions directly — no agents needed.
- Use \`create_task\` / \`update_task\` to track all non-trivial work items.
- Use \`get_cost\` when the client asks about spend.
- Use \`switch_team\` immediately when the client asks to change the model configuration.
- Before committing code or opening PRs: use \`request_decision\` to confirm with the client.

**Pivot / mid-development changes:**
If the client requests changes after development has started:
a. Acknowledge the pivot. Call \`read_artifact("prd.md")\` to understand current state.
b. Call \`update_artifact("change-plan.md", ...)\` with a structured plan of what needs to change.
c. \`send_artifact\` the change plan and \`request_decision\` asking the client to confirm.
d. Once approved: update the PRD, then dispatch the minimal set of agents with the change plan in context.
e. \`update_memory\` to record the pivot decision.

**Communication style:** Professional but direct. Summarise technical details for the client. Use bullet points. Never start building without the client's explicit go-ahead.

**Active team:** \`${activeConfigName}\` — ${configMeta.descriptions[activeConfigName] ?? activeConfigName}
**Available teams:** ${configMeta.names.map(n => `\`${n}\` (${configMeta.descriptions[n] ?? n})`).join(' | ')}

**Current project state:**
${state}
${patternsNote()}
Current project: ${PROJECT_NAME}`;
}

// ---------------------------------------------------------------------------
// PM tool definitions
// ---------------------------------------------------------------------------

const CONSULT_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'consult_agent',
    description: 'Delegate a task to a core team specialist. They work autonomously in the background (read/write files, run commands). Multiple calls run in parallel. Returns immediately — agent posts its own completion message.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: AGENTS.filter(a => a.role !== 'qa-verifier').map(a => a.role) },
        task: { type: 'string', description: 'Full task description. Be specific. Include file paths if relevant. Add [COMMIT APPROVED] to authorise git commits.' },
      },
      required: ['role', 'task'],
    },
  },
};

const HIRE_SPECIALIST_TOOL = {
  type: 'function',
  function: {
    name: 'hire_specialist',
    description: `Hire an external specialist from the agency roster (${externalAgents.length} available). Use for expertise outside the core team.`,
    parameters: {
      type: 'object',
      properties: {
        role_description: { type: 'string', description: 'Natural language description, e.g. "UX designer", "legal advisor for token compliance"' },
        task: { type: 'string' },
      },
      required: ['role_description', 'task'],
    },
  },
};

const SEND_UPDATE_TOOL = {
  type: 'function',
  function: {
    name: 'send_update',
    description: 'Send a progress update to the client in Discord. Use at major milestones only.',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
};

const REQUEST_DECISION_TOOL = {
  type: 'function',
  function: {
    name: 'request_decision',
    description: 'Pause and ask the client a question. Client has 5 minutes to respond.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional list of choices' },
      },
      required: ['question'],
    },
  },
};

const GET_STATE_TOOL = {
  type: 'function',
  function: {
    name: 'get_state',
    description: 'Get the current project state — tasks, decisions, blockers, repos, tech stack, and memory.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const SEND_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'send_artifact',
    description: 'Upload a file from /workspace to Discord so the client can download it. Use for reports, PDFs, specs, diagrams.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to /workspace, e.g. ".agency/artifacts/prd.md"' },
        description: { type: 'string', description: 'Short message shown above the file in Discord' },
      },
      required: ['path'],
    },
  },
};

const ADD_REPO_TOOL = {
  type: 'function',
  function: {
    name: 'add_repo',
    description: 'Clone a GitHub repository into /workspace and register it for the project.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTPS GitHub URL, e.g. "https://github.com/org/repo"' },
        name: { type: 'string', description: 'Local folder name. Defaults to repo name.' },
        branch: { type: 'string', description: 'Branch to clone. Default: main' },
      },
      required: ['url'],
    },
  },
};

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from /workspace (including user-uploaded files in /workspace/uploads/). PDFs are automatically converted to text via pdftotext. Call this immediately whenever the client uploads a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to /workspace (e.g. "uploads/PRD.pdf") or absolute (e.g. "/workspace/uploads/PRD.pdf")' },
      },
      required: ['path'],
    },
  },
};

const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Download the content of a URL and return it as text. Use when the client shares a link (Google Docs, Notion, GitHub raw, etc.) before delegating.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        filename: { type: 'string', description: 'Optional: save to /workspace/.agency/uploads/<filename>' },
      },
      required: ['url'],
    },
  },
};

const UPDATE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'update_memory',
    description: 'Record tech stack choices, key decisions, milestones, and out-of-scope items. Persists across Docker restarts.',
    parameters: {
      type: 'object',
      properties: {
        techStack:     { type: 'array', items: { type: 'string' }, description: 'Tech stack items to add, e.g. ["Solidity 0.8.24", "Next.js 14"]' },
        keyDecisions:  { type: 'array', items: { type: 'string' }, description: 'Key decisions, e.g. ["Using UUPS proxy pattern"]' },
        milestones:    { type: 'array', items: { type: 'string' }, description: 'Milestones reached, e.g. ["PRD approved 2024-01-15"]' },
        outOfScope:    { type: 'array', items: { type: 'string' }, description: 'Things explicitly excluded' },
      },
      required: [],
    },
  },
};

const CREATE_PRD_TOOL = {
  type: 'function',
  function: {
    name: 'create_prd',
    description: 'Create a structured PRD from the client\'s requirements and save it to /workspace/.agency/artifacts/prd.md. Call this after Phase 1 (understanding) before dispatching agents.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full PRD content in Markdown — include objectives, scope, technical requirements, out of scope, success criteria.' },
      },
      required: ['content'],
    },
  },
};

const CREATE_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'create_task',
    description: 'Create a task in project state to track work. Use before delegating non-trivial work.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignee: { type: 'string', description: 'Agent role, e.g. "solidity-dev"' },
      },
      required: ['title', 'assignee'],
    },
  },
};

const UPDATE_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'update_task',
    description: 'Update a task status and optionally record the result summary.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in-progress', 'done', 'blocked'] },
        result: { type: 'string', description: 'Brief summary of outcome' },
      },
      required: ['id', 'status'],
    },
  },
};

const GET_COST_TOOL = {
  type: 'function',
  function: {
    name: 'get_cost',
    description: 'Get current session cost summary — total spend, breakdown by model and by role.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const GET_RUNNING_TASKS_TOOL = {
  type: 'function',
  function: {
    name: 'get_running_tasks',
    description: 'Show which specialist agents are currently running in the background and how long they\'ve been running.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const WAIT_FOR_TASKS_TOOL = {
  type: 'function',
  function: {
    name: 'wait_for_tasks',
    description: 'Wait for all currently running background agents to finish before proceeding. Use when the next step depends on their output.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const LIST_ARTIFACTS_TOOL = {
  type: 'function',
  function: {
    name: 'list_artifacts',
    description: 'List all project documents in /workspace/.agency/artifacts/. Show this to the client when they ask "what do we have?".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const READ_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'read_artifact',
    description: 'Read a project document from /workspace/.agency/artifacts/. Always call this before re-dispatching agents — the client may have edited the file.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact filename, e.g. "prd.md" or "architecture.md"' },
      },
      required: ['name'],
    },
  },
};

const UPDATE_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'update_artifact',
    description: 'Create or update a project document in /workspace/.agency/artifacts/. Use for backlog updates, architecture decisions, change plans, etc.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact filename, e.g. "backlog.md" or "change-plan.md"' },
        content: { type: 'string', description: 'Full document content in Markdown' },
      },
      required: ['name', 'content'],
    },
  },
};

const SWITCH_TEAM_TOOL = {
  type: 'function',
  function: {
    name: 'switch_team',
    description: `Switch the AI model team configuration. Persists across restarts. Available: ${configMeta.names.map(n => `"${n}" (${configMeta.descriptions[n]})`).join(', ')}. Call immediately when the client asks to change the team.`,
    parameters: {
      type: 'object',
      properties: {
        config: { type: 'string', enum: configMeta.names, description: 'Team configuration name to activate' },
      },
      required: ['config'],
    },
  },
};

const PM_TOOLS = [
  CONSULT_AGENT_TOOL,
  HIRE_SPECIALIST_TOOL,
  SEND_UPDATE_TOOL,
  REQUEST_DECISION_TOOL,
  GET_STATE_TOOL,
  SEND_ARTIFACT_TOOL,
  ADD_REPO_TOOL,
  READ_FILE_TOOL,
  FETCH_URL_TOOL,
  UPDATE_MEMORY_TOOL,
  CREATE_PRD_TOOL,
  CREATE_TASK_TOOL,
  UPDATE_TASK_TOOL,
  GET_COST_TOOL,
  GET_RUNNING_TASKS_TOOL,
  WAIT_FOR_TASKS_TOOL,
  LIST_ARTIFACTS_TOOL,
  READ_ARTIFACT_TOOL,
  UPDATE_ARTIFACT_TOOL,
  SWITCH_TEAM_TOOL,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function notifyUser(msg: string, send: (text: string) => Promise<void>): Promise<void> {
  const chunks = msg.match(/[\s\S]{1,1900}/g) ?? [msg];
  for (const chunk of chunks) {
    await send(chunk).catch(err => log('error', 'bot', 'notifyUser error', { error: (err as Error).message }));
  }
}

async function sendArtifact(
  filePath: string,
  description: string | undefined,
  sendFile: (path: string, desc: string) => Promise<void>,
): Promise<void> {
  const abs = filePath.startsWith('/') ? filePath : resolve(WORKSPACE, filePath);
  if (!abs.startsWith(WORKSPACE + '/') && abs !== WORKSPACE) {
    throw new Error(`Path outside workspace: ${filePath}`);
  }
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  await sendFile(abs, description ?? basename(abs));
}

async function requestDecision(
  channelId: string,
  question: string,
  options: string[] | undefined,
  signal: AbortSignal,
  send: (text: string) => Promise<void>,
): Promise<string> {
  const formatted = options?.length
    ? `${question}\n\nOptions:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : question;
  await notifyUser(`**Decision needed:**\n${formatted}`, send);

  return new Promise<string>(res => {
    let done = false;
    const finish = (answer: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingDecisions.delete(channelId);
      res(answer);
    };
    const timer = setTimeout(
      () => finish('(no response — timed out after 5 minutes, making best default choice)'),
      5 * 60 * 1000,
    );
    signal.addEventListener('abort', () => finish('(interrupted by new user message)'), { once: true });
    pendingDecisions.set(channelId, finish);
  });
}

// ---------------------------------------------------------------------------
// Background agent dispatch with QA auto-verification
// ---------------------------------------------------------------------------

function dispatchAgentBackground(
  role: string,
  task: string,
  channelId: string,
): void {
  const agentDef = AGENTS.find(a => a.role === role);
  const agentName = agentDef?.name ?? role;
  const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const taskPreview = task.length > 120 ? task.slice(0, 120) + '…' : task;

  // Auto-track in project state
  const taskRecord = addTask(taskPreview, role);
  updateTask(taskRecord.id, { status: 'in-progress' });

  const promise = (async () => {
    try {
      const agentPromise = runAgent(
        role,
        task,
        buildAgentContext(),
        getModelMap(),
        OPENROUTER_API_KEY,
        (msg) => channelSend(channelId, `⚙️ ${msg}`),
        // Background agents are NOT abort-gated — they always run to completion
      );
      const result = await withTimeout(agentPromise, AGENT_TIMEOUT_MS, `Agent ${agentName}`);

      updateTask(taskRecord.id, {
        status: result.status === 'blocked' ? 'blocked' : 'done',
        result: result.output.slice(0, 500),
      });

      if (result.status === 'blocked') {
        await channelSend(channelId, `⚠️ **${agentName}** is blocked: ${result.blocker}`);
      } else {
        await channelSend(channelId, `✅ **${agentName}** — done\n${result.output.slice(0, 800)}`);

        // Auto-dispatch QA verifier for tasks that produce file deliverables
        if (role !== 'qa-verifier' && role !== 'risk-manager' && role !== 'tech-lead') {
          dispatchQAVerifier(task, result.output, channelId);
        }
      }
    } catch (err) {
      updateTask(taskRecord.id, { status: 'blocked', result: (err as Error).message });
      await channelSend(channelId, `❌ **${agentName}** failed: ${(err as Error).message}`);
    } finally {
      bgRemove(channelId, taskId);
    }
  })();

  bgAdd(channelId, { id: taskId, agentName, taskPreview, startedAt: new Date(), promise });
}

function dispatchQAVerifier(originalTask: string, agentOutput: string, channelId: string): void {
  const qaTask = `Verify the deliverables from this task:\n\nORIGINAL TASK:\n${originalTask.slice(0, 500)}\n\nAGENT OUTPUT:\n${agentOutput.slice(0, 1000)}`;
  const qaId = `qa-${Date.now()}`;

  const promise = (async () => {
    try {
      const result = await withTimeout(
        runAgent('qa-verifier', qaTask, buildAgentContext(), getModelMap(), OPENROUTER_API_KEY),
        2 * 60 * 1000,
        'QA Verifier',
      );
      const verdict = result.output.split('\n').find(l =>
        l.startsWith('VERIFIED:') || l.startsWith('PARTIAL:') || l.startsWith('FAILED:') || l.startsWith('SKIPPED:'),
      ) ?? result.output.slice(-200);

      if (verdict.startsWith('FAILED:') || verdict.startsWith('PARTIAL:')) {
        await channelSend(channelId, `🔍 **QA Verifier** — ${verdict}`);
      }
      // VERIFIED and SKIPPED are silent — no noise for passing tasks
    } catch { /* QA is best-effort, never fail the workflow */ } finally {
      bgRemove(channelId, qaId);
    }
  })();

  bgAdd(channelId, { id: qaId, agentName: 'QA Verifier', taskPreview: 'Verifying deliverables…', startedAt: new Date(), promise });
}

// ---------------------------------------------------------------------------
// PM tool dispatcher
// ---------------------------------------------------------------------------

async function dispatchPMTool(
  name: string,
  args: Record<string, unknown>,
  channelId: string,
  signal: AbortSignal,
  send: (text: string) => Promise<void>,
  sendFile: (path: string, desc: string) => Promise<void>,
): Promise<string> {
  switch (name) {

    case 'send_update':
      await notifyUser(args['message'] as string, send);
      return 'Update sent.';

    case 'request_decision': {
      const answer = await requestDecision(
        channelId,
        args['question'] as string,
        args['options'] as string[] | undefined,
        signal,
        send,
      );
      return `Client answered: ${answer}`;
    }

    case 'get_state':
      return formatStateForPM();

    case 'consult_agent': {
      const role = args['role'] as string;
      const task = args['task'] as string;
      const agentDef = AGENTS.find(a => a.role === role);
      const agentName = agentDef?.name ?? role;
      const taskPreview = task.length > 120 ? task.slice(0, 120) + '…' : task;
      await notifyUser(`🔧 **${agentName}** — ${taskPreview}`, send);
      dispatchAgentBackground(role, task, channelId);
      return `${agentName} dispatched and working in the background. They will post their own completion message when done.`;
    }

    case 'hire_specialist': {
      const roleDesc = args['role_description'] as string;
      await notifyUser(`🔍 Hiring **${roleDesc}**…`, send);
      const { agentName, reply } = await withTimeout(
        runExternalAgent(roleDesc, args['task'] as string, buildAgentContext(), externalAgents, getModelMap(), OPENROUTER_API_KEY, signal),
        AGENT_TIMEOUT_MS,
        `Specialist ${roleDesc}`,
      );
      await notifyUser(`✅ **${agentName}** — done`, send);
      return `[${agentName}]: ${reply}`;
    }

    case 'send_artifact': {
      await sendArtifact(args['path'] as string, args['description'] as string | undefined, sendFile);
      return `Artifact sent: ${args['path']}`;
    }

    case 'add_repo': {
      const rawUrl = args['url'] as string;
      const validUrl = validateRepoUrl(rawUrl);
      if (!validUrl) return `Invalid repository URL: "${rawUrl}". Must be an HTTPS GitHub URL like https://github.com/org/repo`;
      const name = (args['name'] as string | undefined) ?? validUrl.split('/').pop() ?? 'repo';
      const branch = (args['branch'] as string | undefined) ?? 'main';
      const localPath = `/workspace/${name}`;
      if (existsSync(localPath)) {
        addRepo(validUrl, name, branch);
        return `Repo already exists at ${localPath} — registered in project state.`;
      }
      const result = runCommand(
        `git clone --depth 1 --branch "${branch}" "${validUrl}.git" "${localPath}" 2>&1 || git clone --depth 1 "${validUrl}.git" "${localPath}"`,
        120_000,
      );
      if (result.exitCode !== 0) return `Clone failed:\n${result.stderr || result.stdout}`;
      addRepo(validUrl, name, branch);
      return `Cloned ${validUrl} → ${localPath} (branch: ${branch}). Agents can now work in /workspace/${name}.`;
    }

    case 'read_file': {
      const rawPath = args['path'] as string;
      const abs = rawPath.startsWith('/') ? rawPath : resolve(WORKSPACE, rawPath);
      if (!abs.startsWith(WORKSPACE + '/') && abs !== WORKSPACE) return `Access denied: path must be within /workspace`;
      if (!existsSync(abs)) return `File not found: ${abs}. Check /workspace/uploads/ for user-uploaded files.`;
      const MAX_CHARS = 15_000;
      if (abs.toLowerCase().endsWith('.pdf')) {
        const result = readPdf(abs);
        const truncated = result.content.length > MAX_CHARS;
        return `[PDF: ${basename(abs)}]\n\n${result.content.slice(0, MAX_CHARS)}${truncated ? `\n\n[truncated at ${MAX_CHARS} chars]` : ''}`;
      }
      try {
        const text = readFileSync(abs, 'utf-8');
        const truncated = text.length > MAX_CHARS;
        return `[File: ${basename(abs)}]\n\n${text.slice(0, MAX_CHARS)}${truncated ? `\n\n[truncated at ${MAX_CHARS} chars]` : ''}`;
      } catch (err) {
        return `Could not read file: ${(err as Error).message}`;
      }
    }

    case 'fetch_url': {
      const url = args['url'] as string;
      const filename = args['filename'] as string | undefined;
      try {
        const resp = await fetch(url, { signal });
        if (!resp.ok) return `HTTP ${resp.status} fetching ${url}: ${resp.statusText}`;
        const contentType = resp.headers.get('content-type') ?? '';
        let text: string;
        if (contentType.includes('application/pdf')) {
          const localPath = `/workspace/.agency/uploads/${filename ?? basename(new URL(url).pathname) || 'download.pdf'}`;
          mkdirSync('/workspace/.agency/uploads', { recursive: true });
          const buffer = Buffer.from(await resp.arrayBuffer());
          writeFileSync(localPath, buffer);
          const result = readPdf(localPath);
          text = result.content;
        } else {
          text = await resp.text();
          if (contentType.includes('text/html')) {
            text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
        if (filename) {
          const localPath = `/workspace/.agency/uploads/${filename}`;
          mkdirSync('/workspace/.agency/uploads', { recursive: true });
          writeFileSync(localPath, text, 'utf-8');
          return `[Fetched: ${url} → ${localPath}]\n\n${text.slice(0, 15_000)}${text.length > 15_000 ? '\n\n[truncated]' : ''}`;
        }
        return `[Fetched: ${url}]\n\n${text.slice(0, 15_000)}${text.length > 15_000 ? '\n\n[truncated]' : ''}`;
      } catch (err) {
        return `Failed to fetch ${url}: ${(err as Error).message}`;
      }
    }

    case 'update_memory': {
      const updates: Parameters<typeof updateMemory>[0] = {};
      if (args['techStack'])    updates.techStack    = args['techStack']    as string[];
      if (args['keyDecisions']) updates.keyDecisions = args['keyDecisions'] as string[];
      if (args['milestones'])   updates.milestones   = args['milestones']   as string[];
      if (args['outOfScope'])   updates.outOfScope   = args['outOfScope']   as string[];
      updateMemory(updates);
      const mem = getMemory();
      return `Memory updated. Tech stack: ${mem.techStack.length} items, decisions: ${mem.keyDecisions.length}, milestones: ${mem.milestones.length}.`;
    }

    case 'create_prd': {
      const content = args['content'] as string;
      const path = writeArtifact('prd.md', content);
      return `PRD saved to ${path} (${content.length} chars). Now send it to the client with send_artifact(".agency/artifacts/prd.md"), then present your plan and ask for approval.`;
    }

    case 'create_task': {
      const taskRecord = addTask(args['title'] as string, args['assignee'] as string);
      return `Task created: ${taskRecord.id} — "${taskRecord.title}" assigned to ${taskRecord.assignee}`;
    }

    case 'update_task': {
      const id = args['id'] as string;
      const status = args['status'] as 'pending' | 'in-progress' | 'done' | 'blocked';
      const result = args['result'] as string | undefined;
      updateTask(id, { status, ...(result ? { result } : {}) });
      return `Task ${id} updated to "${status}"${result ? ` — ${result}` : ''}`;
    }

    case 'get_cost': {
      const s = costTracker.summary();
      const lines = [`**Session cost:** $${s.totalCostUsd.toFixed(4)} USD`];
      lines.push(`**Calls:** ${s.recordCount} | **Since:** ${s.since.toISOString()}`);
      const roleEntries = Object.entries(s.byRole).sort(([, a], [, b]) => b - a);
      if (roleEntries.length) {
        lines.push('\n**By role:**');
        for (const [role, cost] of roleEntries) lines.push(`  ${role}: $${cost.toFixed(4)}`);
      }
      const modelEntries = Object.entries(s.byModel).sort(([, a], [, b]) => b - a);
      if (modelEntries.length) {
        lines.push('\n**By model:**');
        for (const [model, cost] of modelEntries) lines.push(`  ${model}: $${cost.toFixed(4)}`);
      }
      return lines.join('\n');
    }

    case 'get_running_tasks': {
      const tasks = bgList(channelId);
      if (!tasks.length) return 'No agents currently running.';
      const lines = tasks.map(t => {
        const elapsed = Math.round((Date.now() - t.startedAt.getTime()) / 1000);
        return `• **${t.agentName}** — "${t.taskPreview}" (${elapsed}s elapsed)`;
      });
      return `**Running agents (${tasks.length}):**\n${lines.join('\n')}`;
    }

    case 'wait_for_tasks': {
      const tasks = bgList(channelId);
      if (!tasks.length) return 'No running agents to wait for.';
      const count = tasks.length;
      await Promise.all(tasks.map(t => t.promise));
      return `All ${count} running agent(s) have completed.`;
    }

    case 'list_artifacts': {
      const files = listArtifactFiles();
      if (!files.length) return 'No project documents yet. Use create_prd or update_artifact to create them.';
      return `**Project documents (${files.length}):**\n${files.map(f => `• **${f.name}** — ${f.description} (${f.size}B, ${f.modified})`).join('\n')}`;
    }

    case 'read_artifact': {
      const name = args['name'] as string;
      return readArtifact(name);
    }

    case 'update_artifact': {
      const artifactName = args['name'] as string;
      const content = args['content'] as string;
      const path = writeArtifact(artifactName, content);
      return `Artifact "${artifactName}" saved to ${path} (${content.length} chars).`;
    }

    case 'switch_team': {
      const config = args['config'] as string;
      if (!allModelMaps[config]) return `Unknown team config: "${config}". Available: ${configMeta.names.join(', ')}`;
      if (config === activeConfigName) return `Already on the **${config}** team — no change needed.`;
      activeConfigName = config;
      setActiveProfile(config); // persist across restarts
      const desc = configMeta.descriptions[config] ?? config;
      const newPMModel = getPMModel();
      log('info', 'bot', 'Team config switched', { config, pmModel: newPMModel });
      const roleList = Object.entries(allModelMaps[config])
        .filter(([k]) => k !== '__default__')
        .map(([role, model]) => `  • ${role}: \`${model}\``)
        .join('\n');
      await notifyUser(`🔄 **Switched to ${config} team** — ${desc}\n\nModel assignments:\n${roleList}`, send);
      return `Team switched to "${config}". PM is now using ${newPMModel}.`;
    }

    default:
      return `Unknown PM tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// PM async execution loop
// ---------------------------------------------------------------------------

async function runPMAsync(
  channelId: string,
  userMessage: string,
  signal: AbortSignal,
  send: (text: string) => Promise<void>,
  sendFile: (path: string, desc: string) => Promise<void>,
): Promise<void> {
  if (!histories[channelId]) {
    histories[channelId] = loadHistory(channelId);
    if (histories[channelId].length > 0) {
      log('info', 'bot', 'Restored history', { channelId, messages: histories[channelId].length });
    }
  }
  const history = histories[channelId];
  history.push({ role: 'user', content: userMessage });

  // Show typing indicator while PM thinks
  await triggerTyping(channelId).catch(() => {});

  for (let round = 0; round < 15; round++) {
    if (signal.aborted) return;

    const data = await callPMWithRetry(
      [{ role: 'system', content: buildPMSystemPrompt() }, ...history],
      PM_TOOLS,
      signal,
    );

    if (signal.aborted) return;

    const choice = data.choices[0];
    const assistantMsg = choice.message;
    history.push(assistantMsg);

    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      if (assistantMsg.content) await notifyUser(assistantMsg.content, send);
      histories[channelId] = truncateHistory(history);
      saveHistory(channelId, histories[channelId]);
      return;
    }

    if (assistantMsg.content?.trim()) {
      await notifyUser(`💭 ${assistantMsg.content.trim()}`, send);
    }

    if (signal.aborted) return;

    const toolCalls = assistantMsg.tool_calls;
    log('info', 'bot', 'PM tool dispatch', {
      tools: toolCalls.map(tc => {
        try {
          const a = JSON.parse(tc.function.arguments) as Record<string, string>;
          if (tc.function.name === 'hire_specialist') return `hire(${a['role_description']})`;
          if (tc.function.name === 'consult_agent') return a['role'];
          return tc.function.name;
        } catch { return tc.function.name; }
      }),
    });

    const toolResults = await Promise.all(
      toolCalls.map(async (tc): Promise<ORMessage> => {
        if (signal.aborted) return { role: 'tool', tool_call_id: tc.id, content: '(interrupted)' };
        let resultContent: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          resultContent = await dispatchPMTool(tc.function.name, args, channelId, signal, send, sendFile);
        } catch (err) {
          const rawPreview = tc.function.arguments.slice(0, 200);
          resultContent = `Error: ${(err as Error).message}. Tool: ${tc.function.name}, args: ${rawPreview}`;
          log('error', 'bot', 'PM tool error', { tool: tc.function.name, error: (err as Error).message });
        }
        return { role: 'tool', tool_call_id: tc.id, content: resultContent };
      }),
    );

    history.push(...toolResults);
  }

  histories[channelId] = truncateHistory(history);
  saveHistory(channelId, histories[channelId]);
  await notifyUser('I hit the maximum planning rounds. Please give me a more specific instruction to continue.', send);
}

// ---------------------------------------------------------------------------
// Public API — called by NanoClaw's container-runner
// ---------------------------------------------------------------------------

export async function handleMessage(
  content: string,
  channelId: string,
  signal: AbortSignal,
  send: (text: string) => Promise<void>,
  sendFile: (path: string, desc: string) => Promise<void>,
): Promise<void> {
  await runPMAsync(channelId, content, signal, send, sendFile).catch(async (err) => {
    if (signal.aborted) return;
    log('error', 'bot', 'PM execution error', { error: (err as Error).message });
    await notifyUser(`Something went wrong: ${(err as Error).message}`, send);
  });
}
