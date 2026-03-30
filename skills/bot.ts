/**
 * Andy the Project Manager — PM logic.
 *
 * This module is called by NanoClaw's in-process container-runner (via
 * handleMessage / resolveDecision). NanoClaw owns the Discord connection;
 * this module owns the PM conversation loop, tool dispatch, and state.
 *
 * Key exports:
 *   handleMessage(content, channelId, signal, send, sendFile)
 *   resolveDecision(channelId, answer) → boolean
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import {
  AGENTS,
  loadModelMap,
  runAgent,
  loadExternalAgents,
  runExternalAgent,
  type ExternalAgentDef,
} from './agents.js';
import { formatStateForPM, addRepo, updateMemory, getMemory, addTask, updateTask } from './state.js';
import { runCommand, readPdf } from './tools.js';
import { channelSend } from './channel-send.js';

const OPENROUTER_API_KEY    = process.env.OPENROUTER_API_KEY   || '';
const PROJECT_NAME          = process.env.PROJECT_NAME          || 'Web3 Project';
const MODELS_CONFIG         = '/app/config/models.json';
const ROLES_DIR             = '/app/roles';
const PATTERNS_DIR          = '/app/patterns';
const HISTORY_DIR           = '/workspace/.agency';
const ARTIFACTS_DIR         = '/workspace/.agency/artifacts';
const WORKSPACE             = '/workspace';

if (!OPENROUTER_API_KEY) { console.error('[bot] OPENROUTER_API_KEY is not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

// Rough per-token pricing in USD (input / output per million tokens)
const MODEL_PRICING: Record<string, [number, number]> = {
  'moonshotai/kimi-k2.5':        [0.15,  0.60],
  'anthropic/claude-sonnet-4-5': [3.00, 15.00],
  'anthropic/claude-4.6-sonnet': [3.00, 15.00],
  'anthropic/claude-opus-4-5':   [15.0, 75.00],
  'anthropic/claude-4.6-opus':   [15.0, 75.00],
};

function estimateCost(model: string, prompt: number, completion: number): number {
  const entry = Object.entries(MODEL_PRICING).find(([k]) => model.includes(k));
  const [inputPer1M, outputPer1M] = entry ? entry[1] : [1.0, 5.0];
  return (prompt / 1_000_000) * inputPer1M + (completion / 1_000_000) * outputPer1M;
}

function logCost(taskName: string, model: string, prompt: number, completion: number): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    const costsFile = `${HISTORY_DIR}/costs.json`;
    let costs: Array<{ ts: string; task: string; model: string; prompt: number; completion: number; usd: number }> = [];
    try { costs = JSON.parse(readFileSync(costsFile, 'utf-8')); } catch { /* first run */ }
    costs.push({ ts: new Date().toISOString(), task: taskName.slice(0, 80), model, prompt, completion, usd: estimateCost(model, prompt, completion) });
    writeFileSync(costsFile, JSON.stringify(costs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[bot] Failed to log cost:', err);
  }
}

function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `~$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Background task pool
// Agents run detached from the PM's AbortSignal so the user can keep
// chatting while work happens in the background.
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
// Artifact helpers
// Artifacts live in /workspace/.agency/artifacts/ — the same folder that is
// mounted to project-data/.agency/artifacts/ on the host machine, so the
// client can open and edit them with any text editor at any time.
// ---------------------------------------------------------------------------

const ARTIFACT_DESCRIPTIONS: Record<string, string> = {
  'prd.md':           'Product Requirements Document',
  'backlog.md':       'Product backlog — prioritised user stories',
  'tasks.md':         'Current sprint tasks',
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
      .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
      .map((f) => {
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
  // Sanitise filename — alphanumeric, hyphens, dots only
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
    return `(artifact "${name}" not found)`;
  }
}

const modelMap       = loadModelMap(MODELS_CONFIG);
const PM_MODEL       = modelMap['project-manager'] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
const externalAgents: ExternalAgentDef[] = loadExternalAgents(ROLES_DIR);

console.log(`[bot] PM model: ${PM_MODEL}`);
console.log(`[bot] Core team: ${AGENTS.map(a => a.role).join(', ')}`);
console.log(`[bot] External roster: ${externalAgents.length} specialists available`);

// ---------------------------------------------------------------------------
// OpenRouter types
// ---------------------------------------------------------------------------

// Multimodal content blocks (text + vision)
type TextBlock      = { type: 'text'; text: string };
type ImageBlock     = { type: 'image_url'; image_url: { url: string } };
type ContentBlock   = TextBlock | ImageBlock;

interface ORMessage {
  role: string;
  content: string | ContentBlock[] | null;
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

// ---------------------------------------------------------------------------
// Multimodal content conversion
// Parses [IMAGE_URL:url] markers injected by discord.ts and converts the
// message to an array of content blocks for OpenRouter's vision API.
// ---------------------------------------------------------------------------

const IMAGE_URL_RE = /\[IMAGE_URL:([^\]]+)\]/g;

function toMultimodalContent(text: string): string | ContentBlock[] {
  if (!IMAGE_URL_RE.test(text)) return text;
  IMAGE_URL_RE.lastIndex = 0; // reset after .test()

  const blocks: ContentBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = IMAGE_URL_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) blocks.push({ type: 'text', text: before.trim() });
    blocks.push({ type: 'image_url', image_url: { url: match[1] } });
    lastIndex = match.index + match[0].length;
  }

  const after = text.slice(lastIndex).trim();
  if (after) blocks.push({ type: 'text', text: after });

  return blocks.length ? blocks : text;
}

// ---------------------------------------------------------------------------
// Per-channel conversation history (in-memory + disk)
// ---------------------------------------------------------------------------

const histories: Record<string, ORMessage[]> = {};

function saveHistory(channelId: string, history: ORMessage[]): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(
      `${HISTORY_DIR}/history-${channelId}.json`,
      JSON.stringify(history, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.error('[bot] Failed to save history:', err);
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

// ---------------------------------------------------------------------------
// Pending decision requests
// When Andy calls request_decision, the next message for that channel
// resolves the promise instead of starting a new PM loop.
// ---------------------------------------------------------------------------

const pendingDecisions = new Map<string, (answer: string) => void>();

/**
 * If there is a pending decision for this channel, resolve it and return true.
 * Called by container-runner before starting a new PM loop.
 */
export function resolveDecision(channelId: string, answer: string): boolean {
  const resolver = pendingDecisions.get(channelId);
  if (resolver) {
    resolver(answer);
    return true;
  }
  return false;
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

**Your core team** (use \`consult_agent\`):
${AGENTS.map(a => `- **${a.name}** (${a.role}): ${a.description}`).join('\n')}

**External roster** (use \`hire_specialist\`):
You can hire any of ${externalAgents.length} additional specialists — UX designers, legal advisors, data scientists, technical writers, marketing strategists, and many more. Describe the expertise you need in natural language.

**How to work:**
1. For significant tasks: call \`send_update\` immediately with a brief plan ("On it — involving Solidity Dev and Risk Manager"), then dispatch agents. You remain available for questions while they work.
2. Delegate to specialists using \`consult_agent\` (core team) or \`hire_specialist\` (external roster). **Agents run in the background** — \`consult_agent\` returns immediately and you do NOT wait for them. The client can keep chatting with you while work happens.
3. Specialists can read/write files and run commands in /workspace — they will iterate until done and post their own completion messages.
4. Use \`send_update\` for your own progress commentary. Specialists post their own ✅/⚠️ messages when they finish.
5. Use \`request_decision\` when: at an architectural fork where client preference matters, before committing/deploying, or when genuinely blocked. Do NOT ask for decisions you can resolve with good engineering judgment.
6. Use \`get_state\` at the start of a new task to check what's already been done.
7. Answer simple questions (greetings, status, clarifications) directly — no need to call agents.
8. Use \`add_repo\` when the client provides a GitHub URL — clone it once, then agents work within /workspace/{name}.
9. Use \`send_artifact\` to deliver documents and files: architecture docs, audit reports, specs, PDFs. Agents can generate PDFs via: run_command("pandoc doc.md -o doc.pdf"). Agents can push code and open PRs via: run_command("gh pr create ...").
10. Use \`fetch_url\` whenever the client shares a link (Google Drive, Notion export, GitHub raw, etc.) BEFORE delegating — specialists cannot download URLs themselves. Fetch first, then pass the extracted content in the task description.
11. Use \`read_pdf\` whenever the client attaches a PDF file directly. The message will include a path like \`/workspace/.agency/uploads/filename.pdf\` — call \`read_pdf\` with that path immediately to get the content, then proceed.
12. Use \`update_memory\` to record tech stack choices, key decisions, and milestones as they happen. This persists across Docker restarts and sessions.
13. Use \`create_prd\` BEFORE dispatching ANY development work. When the client describes requirements, call \`create_prd\` first to structure them into a PRD, then \`send_artifact\` the PRD (".agency/prd.md"), then \`request_decision\` asking the client to review and type APPROVED. Only dispatch dev agents after receiving APPROVED.
14. Use \`get_running_tasks\` when the client asks how things are going — it shows which agents are active and how long they've been running.
15. Use \`wait_for_tasks\` when the NEXT step truly depends on the output of a currently running task (e.g. "audit the contract once it's written"). Otherwise, just dispatch and move on.
16. **Artifact collaboration workflow:** All project documents live in the shared folder \`project-data/.agency/artifacts/\` on the client's machine (inside the container: \`/workspace/.agency/artifacts/\`). The client can open and edit any artifact with their text editor at any time. After \`create_prd\`, always call \`list_artifacts\` so the client knows what to review. Before dispatching development agents, always call \`read_artifact\` to get the latest version the client may have edited.
17. Use \`update_artifact\` to create or revise project documents beyond the PRD — backlog updates, architecture decisions (\`architecture.md\`), sprint task lists (\`tasks.md\`), or any structured document the client should review.
18. Use \`list_artifacts\` whenever the client asks "what do we have?", "show me the documents", or "what files are there" — or proactively after creating new artifacts.
19. **Pivot / mid-development realignment:** If the client requests changes after development has started, do NOT simply restart from scratch. Follow this flow:
    a. Acknowledge the pivot and call \`read_artifact("prd.md")\` and \`read_artifact("backlog.md")\` to understand current state.
    b. Call \`update_artifact("change-plan.md", ...)\` with a structured plan: what changes are needed, which agents to retask, which files to modify.
    c. Call \`send_artifact\` for \`change-plan.md\` and ask the client to review it (editable at \`project-data/.agency/artifacts/change-plan.md\`).
    d. Call \`request_decision\` asking the client to confirm the change plan (type APPROVED or ask for revisions).
    e. Once approved: update \`prd.md\` and \`backlog.md\` to reflect the new direction, then dispatch the minimal set of agents needed to implement the changes — referencing the change plan in each task description.
    f. Call \`update_memory\` to record the pivot decision.

**Communication style:** Professional but direct. Summarise technical details for the client. Use bullet points.

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
    description: 'Delegate a task to a core team specialist. They will work autonomously (read/write files, run commands) until done. Multiple calls run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: AGENTS.map(a => a.role) },
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
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Update message for the client' },
      },
      required: ['message'],
    },
  },
};

const REQUEST_DECISION_TOOL = {
  type: 'function',
  function: {
    name: 'request_decision',
    description: 'Pause and ask the client a question. Use when a decision genuinely requires client input. Client has 5 minutes to respond.',
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
    description: 'Get the current project state — tasks, decisions, blockers, repos.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const SEND_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'send_artifact',
    description: 'Upload a file from /workspace to Discord so the client can download it. Use for reports (MD, PDF), diagrams, specs, or any deliverable. Agents can generate PDFs with: run_command("pandoc input.md -o output.pdf")',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to /workspace, e.g. "docs/architecture.pdf"' },
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
    description: 'Clone a GitHub repository into /workspace and register it for the project. Agents will then work within that repo. Call once per repo — subsequent tasks reference the repo by name.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTPS GitHub URL, e.g. "https://github.com/org/repo"' },
        name: { type: 'string', description: 'Local folder name in /workspace. Defaults to repo name from URL.' },
        branch: { type: 'string', description: 'Branch to clone. Default: main' },
      },
      required: ['url'],
    },
  },
};

const READ_PDF_TOOL = {
  type: 'function',
  function: {
    name: 'read_pdf',
    description: 'Extract and return the text content of a PDF file that was attached by the client. Use the path reported in the message (e.g. /workspace/.agency/uploads/filename.pdf). Call this immediately when a PDF is attached before doing anything else.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF, e.g. "/workspace/.agency/uploads/report.pdf"' },
      },
      required: ['path'],
    },
  },
};

const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Download a document or file from a URL and return its text content. Supports Google Drive share links, GitHub raw URLs, and direct file links. Use this BEFORE delegating to specialists whenever the client shares a link — specialists cannot download URLs themselves.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch. Google Drive share links are automatically converted to direct downloads.' },
        filename: { type: 'string', description: 'Optional filename hint (e.g. "prd.pdf"). Helps determine how to process the content.' },
      },
      required: ['url'],
    },
  },
};

const UPDATE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'update_memory',
    description: 'Persist key project information to long-term memory — survives Docker restarts. Record tech stack choices, key architectural decisions, milestones reached, and out-of-scope items. Call this whenever a significant decision is made or a milestone is reached.',
    parameters: {
      type: 'object',
      properties: {
        techStack: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technology choices to remember, e.g. ["Solidity 0.8.24", "Next.js 14", "wagmi v2"]',
        },
        keyDecisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Architectural or product decisions, e.g. ["Using UUPS proxy for upgradability", "No gasless transactions in v1"]',
        },
        milestones: {
          type: 'array',
          items: { type: 'string' },
          description: 'Completed milestones with dates, e.g. ["PRD approved 2024-01-15", "Smart contracts audited"]',
        },
        outOfScope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Features/items explicitly excluded from the project',
        },
      },
      required: [],
    },
  },
};

const CREATE_PRD_TOOL = {
  type: 'function',
  function: {
    name: 'create_prd',
    description: 'Generate a structured Product Requirements Document from the client\'s requirements. Writes the PRD to /workspace/.agency/prd.md. Call this BEFORE dispatching any development tasks. After calling this, use send_artifact to share the PRD with the client, then request_decision to get explicit approval before proceeding.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project or feature title' },
        problem: { type: 'string', description: 'Problem statement — what problem does this solve and for whom?' },
        user_stories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of user stories in "As a <user>, I want to <action> so that <benefit>" format',
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific, testable conditions that must be met for the feature to be considered done',
        },
        tech_constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technical constraints or requirements',
        },
        out_of_scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Features or requirements explicitly excluded from this deliverable',
        },
      },
      required: ['title', 'problem', 'user_stories', 'acceptance_criteria'],
    },
  },
};

const GET_COSTS_TOOL = {
  type: 'function',
  function: {
    name: 'get_costs',
    description: 'Get a summary of token usage and estimated costs for this project session. Use when the client asks about cost, budget, or spend.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const GET_RUNNING_TASKS_TOOL = {
  type: 'function',
  function: {
    name: 'get_running_tasks',
    description: 'Check which specialist agents are currently working in the background. Use when the client asks "how is it going?", "what is happening?", or "are you still working on it?".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const WAIT_FOR_TASKS_TOOL = {
  type: 'function',
  function: {
    name: 'wait_for_tasks',
    description: 'Wait for all currently running background agents to finish before proceeding. Use this when the next step depends on the output of a currently running task (e.g. "audit the contract once Solidity Dev finishes writing it").',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const LIST_ARTIFACTS_TOOL = {
  type: 'function',
  function: {
    name: 'list_artifacts',
    description: 'List all project artifacts (PRD, backlog, tasks, architecture docs, etc.) stored in the shared artifacts folder. Call this to show the client what files exist and can be reviewed or edited.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const READ_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'read_artifact',
    description: 'Read the current content of an artifact file from the shared folder. Use before delegating to agents so they have the latest version — the client may have edited the file locally.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact filename, e.g. "prd.md", "backlog.md", "change-plan.md"' },
      },
      required: ['name'],
    },
  },
};

const UPDATE_ARTIFACT_TOOL = {
  type: 'function',
  function: {
    name: 'update_artifact',
    description: 'Write or update an artifact file in the shared folder. Use to create or revise project documents such as the backlog, architecture decisions, change plan, or task list. The client can open and edit these files locally at any time.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact filename, e.g. "backlog.md", "change-plan.md", "tasks.md"' },
        content: { type: 'string', description: 'Full Markdown content to write to the file' },
      },
      required: ['name', 'content'],
    },
  },
};

const PM_TOOLS = [
  CONSULT_AGENT_TOOL,
  HIRE_SPECIALIST_TOOL,
  READ_PDF_TOOL,
  FETCH_URL_TOOL,
  SEND_UPDATE_TOOL,
  REQUEST_DECISION_TOOL,
  GET_STATE_TOOL,
  SEND_ARTIFACT_TOOL,
  ADD_REPO_TOOL,
  UPDATE_MEMORY_TOOL,
  CREATE_PRD_TOOL,
  GET_COSTS_TOOL,
  GET_RUNNING_TASKS_TOOL,
  WAIT_FOR_TASKS_TOOL,
  LIST_ARTIFACTS_TOOL,
  READ_ARTIFACT_TOOL,
  UPDATE_ARTIFACT_TOOL,
];

// ---------------------------------------------------------------------------
// Helpers that accept send/sendFile callbacks from the caller
// ---------------------------------------------------------------------------

async function notifyUser(
  msg: string,
  send: (text: string) => Promise<void>,
): Promise<void> {
  const chunks = msg.match(/[\s\S]{1,1900}/g) ?? [msg];
  for (const chunk of chunks) {
    await send(chunk).catch(err => console.error('[bot] notifyUser error:', err));
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
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${filePath}`);
  }
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

  return new Promise<string>((res) => {
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
      console.log(`[bot] Restored ${histories[channelId].length} messages for channel ${channelId}`);
    }
  }
  const history = histories[channelId];
  // Convert to multimodal content if message contains image URL markers
  history.push({ role: 'user', content: toMultimodalContent(userMessage) });

  for (let round = 0; round < 20; round++) {
    if (signal.aborted) return;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PM_MODEL,
        messages: [{ role: 'system', content: buildPMSystemPrompt() }, ...history],
        tools: PM_TOOLS,
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter PM error ${response.status}: ${err}`);
    }

    if (signal.aborted) return;

    const data = await response.json() as ORResponse;
    const choice = data.choices[0];
    const assistantMsg = choice.message;
    history.push(assistantMsg);

    // PM finished — send final reply to client
    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      if (assistantMsg.content) {
        await notifyUser(assistantMsg.content, send);
      }
      histories[channelId] = history.slice(-40);
      saveHistory(channelId, histories[channelId]);
      return;
    }

    // Share any reasoning text the PM produced alongside its tool calls
    if (assistantMsg.content?.trim()) {
      await notifyUser(`💭 ${assistantMsg.content.trim()}`, send);
    }

    if (signal.aborted) return;

    const toolCalls = assistantMsg.tool_calls;
    console.log(`[bot] PM → ${toolCalls.map(tc => {
      try {
        const a = JSON.parse(tc.function.arguments) as Record<string, string>;
        if (tc.function.name === 'hire_specialist') return `hire(${a['role_description']})`;
        if (tc.function.name === 'consult_agent') return a['role'];
        return tc.function.name;
      } catch { return tc.function.name; }
    }).join(', ')}`);

    const toolResults = await Promise.all(
      toolCalls.map(async (tc): Promise<ORMessage> => {
        if (signal.aborted) return { role: 'tool', tool_call_id: tc.id, content: '(interrupted)' };
        let resultContent: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          resultContent = await dispatchPMTool(tc.function.name, args, channelId, signal, send, sendFile);
        } catch (err) {
          resultContent = `Error: ${(err as Error).message}`;
          console.error('[bot] PM tool error:', err);
        }
        return { role: 'tool', tool_call_id: tc.id, content: resultContent };
      }),
    );

    history.push(...toolResults);
  }

  histories[channelId] = history.slice(-40);
  saveHistory(channelId, histories[channelId]);
  await notifyUser('I hit 20 planning rounds without finishing. Something may be ambiguous — please give me a more specific instruction to continue.', send);
}

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

      // Register in project state
      const trackedTask = addTask(taskPreview, role);
      updateTask(trackedTask.id, { status: 'in-progress' });

      // Announce immediately — agent starts in background
      await notifyUser(`🔧 **${agentName}** — ${taskPreview}`, send);

      // bg() always uses channelSend so it can post to Discord even after
      // the PM loop finishes or is aborted by a new incoming message.
      const bg = (text: string) => channelSend(channelId, text).catch(() => {});

      const promise = (async () => {
        try {
          const result = await runAgent(
            role,
            task,
            `Project: ${PROJECT_NAME}`,
            modelMap,
            OPENROUTER_API_KEY,
            (msg) => bg(`⚙️ ${msg}`),
          );

          // Cost tracking
          const agentModel = modelMap[role] ?? modelMap['__default__'] ?? 'unknown';
          const { prompt, completion } = result.tokensUsed;
          logCost(taskPreview, agentModel, prompt, completion);
          const costUsd = estimateCost(agentModel, prompt, completion);

          if (result.status === 'blocked') {
            updateTask(trackedTask.id, { status: 'blocked', result: result.blocker });
            await bg(`⚠️ **${agentName}** is blocked: ${result.blocker}`);
            return;
          }

          await bg(`✅ **${agentName}** — done (${prompt + completion} tokens, ${formatCost(costUsd)})`);

          // Automated test gate for builder roles
          const BUILDER_ROLES = ['solidity-dev', 'frontend-dev', 'backend-dev'];
          if (BUILDER_ROLES.includes(role)) {
            await bg(`🔍 **Tech Lead** — verifying tests…`);
            const verifyTask = [
              `Review the work just completed by ${agentName} and verify quality:`,
              `Original task: ${taskPreview}`,
              ``,
              `Steps:`,
              `1. Identify what was built (read relevant files in /workspace).`,
              `2. Run the test suite: for Solidity use "forge test"; for Node.js use "npm test"; for TypeScript use "tsc --noEmit".`,
              `3. If tests fail, list specific failures. If no test suite exists, flag it.`,
              `4. Provide a brief quality verdict: PASS / FAIL / NEEDS-TESTS.`,
              `Be concise. Do not rewrite code — only report findings.`,
            ].join('\n');

            const verifyResult = await runAgent(
              'tech-lead',
              verifyTask,
              `Project: ${PROJECT_NAME}`,
              modelMap,
              OPENROUTER_API_KEY,
              (msg) => bg(`⚙️ ${msg}`),
            );

            const verdict = verifyResult.output.includes('FAIL') ? '⚠️' : '✅';
            await bg(`${verdict} **Tech Lead** — ${verifyResult.output.slice(0, 300)}`);
            updateTask(trackedTask.id, {
              status: 'done',
              result: result.output.slice(0, 300) + ' | Tests: ' + verifyResult.output.slice(0, 200),
            });
          } else {
            updateTask(trackedTask.id, { status: 'done', result: result.output.slice(0, 500) });
          }
        } catch (err) {
          await bg(`❌ **${agentName}** — unexpected error: ${(err as Error).message}`);
          updateTask(trackedTask.id, { status: 'blocked', result: (err as Error).message });
        } finally {
          bgRemove(channelId, trackedTask.id);
        }
      })();

      // Register so wait_for_tasks can await it
      bgAdd(channelId, { id: trackedTask.id, agentName, taskPreview, startedAt: new Date(), promise });

      // Return immediately — PM loop is unblocked
      return `**${agentName}** is working on it in the background. I'll post updates as they come in. You can keep talking to me.`;
    }

    case 'hire_specialist': {
      const roleDesc = args['role_description'] as string;
      await notifyUser(`🔍 Hiring **${roleDesc}**…`, send);
      const { agentName, reply } = await runExternalAgent(
        roleDesc,
        args['task'] as string,
        `Project: ${PROJECT_NAME}`,
        externalAgents,
        modelMap,
        OPENROUTER_API_KEY,
      );
      await notifyUser(`✅ **${agentName}** — done`, send);
      return `[${agentName}]: ${reply}`;
    }

    case 'send_artifact': {
      await sendArtifact(args['path'] as string, args['description'] as string | undefined, sendFile);
      return `Artifact sent: ${args['path']}`;
    }

    case 'read_pdf': {
      const result = readPdf(args['path'] as string);
      return result.truncated
        ? `${result.content}\n\n[truncated at 50K chars]`
        : result.content;
    }

    case 'fetch_url': {
      const rawUrl  = args['url'] as string;
      const hint    = (args['filename'] as string | undefined) ?? '';
      const UPLOAD_DIR = '/workspace/.agency/uploads';

      // Convert Google Drive share links → direct download URL.
      // confirm=t bypasses the "file too large to scan for viruses" warning page.
      let downloadUrl = rawUrl;
      const driveMatch = rawUrl.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
      if (driveMatch) {
        downloadUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${driveMatch[1]}`;
      }

      // Derive filename for local storage
      const urlFilename = hint || rawUrl.split('/').pop()?.split('?')[0] || 'document';
      const localPath   = `${UPLOAD_DIR}/${Date.now()}-${urlFilename}`;

      // Download
      const dlResult = runCommand(
        `mkdir -p "${UPLOAD_DIR}" && curl -sL -A "Mozilla/5.0" -o "${localPath}" "${downloadUrl}"`,
        60_000,
      );
      if (dlResult.exitCode !== 0) {
        return `Failed to download ${rawUrl}:\n${dlResult.stderr || dlResult.stdout}`;
      }

      // Extract text — try pandoc first (handles PDF, docx, html, etc.), fall back to cat
      const ext = urlFilename.split('.').pop()?.toLowerCase() ?? '';
      let text = '';
      if (['pdf', 'docx', 'odt', 'html', 'htm'].includes(ext)) {
        const extractResult = runCommand(`pandoc "${localPath}" -t plain 2>/dev/null`, 30_000);
        text = extractResult.stdout.trim();
      }
      if (!text) {
        const catResult = runCommand(`cat "${localPath}" 2>/dev/null`, 10_000);
        text = catResult.stdout.trim();
      }

      if (!text) {
        return `Downloaded to ${localPath} but could not extract text. File may be binary or require special handling.`;
      }

      const MAX = 60_000;
      const preview = text.length > MAX ? text.slice(0, MAX) + '\n...(content truncated)' : text;
      return `Fetched: ${rawUrl}\nSaved to: ${localPath}\n\n--- Document Content ---\n${preview}\n--- End ---`;
    }

    case 'add_repo': {
      const url = (args['url'] as string).replace(/\.git$/, '');
      const name = (args['name'] as string | undefined) ?? url.split('/').pop() ?? 'repo';
      const branch = (args['branch'] as string | undefined) ?? 'main';
      const localPath = `/workspace/${name}`;

      if (existsSync(localPath)) {
        addRepo(url, name, branch);
        return `Repo already exists at ${localPath} — registered in project state.`;
      }

      const result = runCommand(
        `git clone --depth 1 --branch "${branch}" "${url}.git" "${localPath}" 2>&1 || git clone --depth 1 "${url}.git" "${localPath}"`,
        120_000,
      );
      if (result.exitCode !== 0) {
        return `Clone failed:\n${result.stderr || result.stdout}`;
      }
      addRepo(url, name, branch);
      return `Cloned ${url} → ${localPath} (branch: ${branch}). Agents can now work in /workspace/${name}.`;
    }

    case 'update_memory': {
      updateMemory({
        techStack:    (args['techStack']    as string[] | undefined) ?? [],
        keyDecisions: (args['keyDecisions'] as string[] | undefined) ?? [],
        milestones:   (args['milestones']   as string[] | undefined) ?? [],
        outOfScope:   (args['outOfScope']   as string[] | undefined) ?? [],
      });
      const mem = getMemory();
      return `Memory updated. Current state — Tech stack: ${mem.techStack.join(', ') || 'none'} | Key decisions: ${mem.keyDecisions.length} recorded | Milestones: ${mem.milestones.length} recorded`;
    }

    case 'create_prd': {
      const title       = args['title'] as string;
      const problem     = args['problem'] as string;
      const stories     = (args['user_stories'] as string[]) ?? [];
      const criteria    = (args['acceptance_criteria'] as string[]) ?? [];
      const constraints = (args['tech_constraints'] as string[]) ?? [];
      const oos         = (args['out_of_scope'] as string[]) ?? [];

      const prdContent = [
        `# PRD: ${title}`,
        ``,
        `**Status:** DRAFT — awaiting client approval`,
        `**Created:** ${new Date().toISOString().slice(0, 10)}`,
        ``,
        `---`,
        ``,
        `## Problem Statement`,
        ``,
        problem,
        ``,
        `## User Stories`,
        ``,
        stories.map((s: string) => `- ${s}`).join('\n'),
        ``,
        `## Acceptance Criteria`,
        ``,
        criteria.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n'),
        ``,
        ...(constraints.length ? [
          `## Technical Constraints`,
          ``,
          constraints.map((c: string) => `- ${c}`).join('\n'),
          ``,
        ] : []),
        ...(oos.length ? [
          `## Out of Scope`,
          ``,
          oos.map((o: string) => `- ${o}`).join('\n'),
          ``,
        ] : []),
        `---`,
        ``,
        `*Review this document. When satisfied, reply **APPROVED** to start development.*`,
      ].join('\n');

      writeArtifact('prd.md', prdContent);

      // Auto-generate a backlog skeleton from user stories
      const backlogContent = [
        `# Backlog: ${title}`,
        ``,
        `**Status:** DRAFT — edit before development starts`,
        `**Updated:** ${new Date().toISOString().slice(0, 10)}`,
        ``,
        `---`,
        ``,
        `## Prioritised User Stories`,
        ``,
        stories.map((s: string, i: number) => `### US-${String(i + 1).padStart(2, '0')}: ${s}\n- **Priority:** TBD\n- **Effort:** TBD\n- **Status:** Not started\n`).join('\n'),
        `---`,
        ``,
        `*Edit priorities and effort estimates before typing APPROVED.*`,
      ].join('\n');

      writeArtifact('backlog.md', backlogContent);

      const artifactsHostPath = 'project-data/.agency/artifacts/';
      return `PRD written to ${ARTIFACTS_DIR}/prd.md and backlog.md created. Host path: ${artifactsHostPath} — client can edit both files locally. Now call list_artifacts to show the client what to review, then send_artifact for prd.md with description "📋 PRD ready for review", then request_decision asking the client to review both files (editable at ${artifactsHostPath}) and type APPROVED before development begins.`;
    }

    case 'get_costs': {
      try {
        const costsFile = `${HISTORY_DIR}/costs.json`;
        const costs = JSON.parse(readFileSync(costsFile, 'utf-8')) as Array<{
          ts: string; task: string; model: string; prompt: number; completion: number; usd: number;
        }>;
        if (!costs.length) return 'No cost data recorded yet.';
        const total = costs.reduce((sum, c) => sum + c.usd, 0);
        const totalTokens = costs.reduce((sum, c) => sum + c.prompt + c.completion, 0);
        const lines = [
          `**Cost summary** (${costs.length} tasks, ${totalTokens.toLocaleString()} tokens total, **${formatCost(total)}** estimated):`,
          '',
          ...costs.slice(-10).map(c =>
            `• ${c.task} — ${c.model.split('/').pop()} — ${(c.prompt + c.completion).toLocaleString()} tokens — ${formatCost(c.usd)}`
          ),
        ];
        if (costs.length > 10) lines.push(`*(showing last 10 of ${costs.length} tasks)*`);
        return lines.join('\n');
      } catch {
        return 'No cost data recorded yet.';
      }
    }

    case 'get_running_tasks': {
      const tasks = bgList(channelId);
      if (!tasks.length) return 'No agents are currently running in the background.';
      const now = Date.now();
      return tasks.map(t => {
        const elapsed = Math.round((now - t.startedAt.getTime()) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        return `• **${t.agentName}** — ${t.taskPreview.slice(0, 80)} (running for ${time})`;
      }).join('\n');
    }

    case 'wait_for_tasks': {
      const tasks = bgList(channelId);
      if (!tasks.length) return 'No background tasks running — ready to proceed.';
      await notifyUser(`⏳ Waiting for ${tasks.length} background task(s) to complete…`, send);
      await Promise.allSettled(tasks.map(t => t.promise));
      return 'All background tasks completed. Ready to proceed.';
    }

    case 'list_artifacts': {
      const files = listArtifactFiles();
      if (!files.length) {
        return 'No artifacts yet. Use create_prd to generate the first artifacts (PRD + backlog).';
      }
      const hostPath = 'project-data/.agency/artifacts/';
      const lines = [
        `**Project artifacts** (edit locally at \`${hostPath}\`):`,
        '',
        ...files.map(f => `• **${f.name}** — ${f.description} (${(f.size / 1024).toFixed(1)} KB, last modified ${f.modified})`),
        '',
        `*Open any file in \`${hostPath}\` with your editor. Changes are reflected immediately.*`,
      ];
      return lines.join('\n');
    }

    case 'read_artifact': {
      const name = args['name'] as string;
      return readArtifact(name);
    }

    case 'update_artifact': {
      const name    = args['name'] as string;
      const content = args['content'] as string;
      const path    = writeArtifact(name, content);
      return `Artifact "${name}" written (${content.length} chars) → ${path}`;
    }

    default:
      return `Unknown PM tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Public API — called by NanoClaw's container-runner
// ---------------------------------------------------------------------------

/**
 * Handle an inbound message for the PM channel.
 * Called by container-runner.ts for every message NanoClaw routes to Andy.
 *
 * @param content   The user message (may include NanoClaw timestamp prefix)
 * @param channelId Discord channel ID (NanoClaw chatJid)
 * @param signal    AbortSignal — aborted if a new message interrupts this one
 * @param send      Callback to stream text back to Discord via NanoClaw
 * @param sendFile  Callback to upload a file attachment to Discord
 */
export async function handleMessage(
  content: string,
  channelId: string,
  signal: AbortSignal,
  send: (text: string) => Promise<void>,
  sendFile: (path: string, desc: string) => Promise<void>,
): Promise<void> {
  await runPMAsync(channelId, content, signal, send, sendFile).catch(async (err) => {
    if (signal.aborted) return;
    console.error('[bot] PM execution error:', err);
    await notifyUser(`Something went wrong: ${(err as Error).message}`, send);
  });
}
