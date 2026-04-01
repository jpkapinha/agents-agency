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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
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
import { formatStateForPM, addRepo, addTask, updateTask, loadState } from './state.js';
import { runCommand } from './tools.js';
import { CostTracker } from './track-cost.js';
import { log } from './logger.js';
import type { ORMessage, ORResponse } from './types.js';

const OPENROUTER_API_KEY    = process.env.OPENROUTER_API_KEY   || '';
const PROJECT_NAME          = process.env.PROJECT_NAME          || 'Web3 Project';
const MODELS_CONFIG         = '/app/config/models.json';
const ROLES_DIR             = '/app/roles';
const PATTERNS_DIR          = '/app/patterns';
const HISTORY_DIR           = '/workspace/.agency';
const WORKSPACE             = '/workspace';

// Per-agent timeout: 10 minutes
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

// Retryable HTTP status codes
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

if (!OPENROUTER_API_KEY) { log('error', 'bot', 'OPENROUTER_API_KEY is not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// Multi-team config — switchable at runtime by the user
// ---------------------------------------------------------------------------

const configMeta: ConfigMeta = loadConfigMeta(MODELS_CONFIG);

// Pre-load all team model maps at startup so switching is instant
const allModelMaps: Record<string, Record<string, string>> = {};
for (const name of configMeta.names) {
  allModelMaps[name] = loadModelMap(MODELS_CONFIG, name);
}

let activeConfigName: string = configMeta.defaultName;

function getModelMap(): Record<string, string> {
  return allModelMaps[activeConfigName] ?? allModelMaps[configMeta.defaultName];
}

function getPMModel(): string {
  const map = getModelMap();
  return map['project-manager'] ?? map['__default__'] ?? 'moonshotai/kimi-k2.5';
}

const externalAgents: ExternalAgentDef[] = loadExternalAgents(ROLES_DIR);

// Shared cost tracker — exposed via get_cost tool
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
// OpenRouter API call with retry + exponential backoff
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

    if (response.ok) {
      return response.json() as Promise<ORResponse>;
    }

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
    writeFileSync(
      `${HISTORY_DIR}/history-${channelId}.json`,
      JSON.stringify(history, null, 2),
      'utf-8',
    );
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
 * Smart history truncation — preserves the first user message (which
 * establishes project context) and the most recent messages. Inserts a
 * truncation marker so the PM knows older context was dropped.
 */
function truncateHistory(history: ORMessage[], maxMessages = 40): ORMessage[] {
  if (history.length <= maxMessages) return history;

  // Keep the first user message (establishes context)
  const first = history[0];
  // Keep the last (maxMessages - 2) messages (leaving room for first + marker)
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

**Your identity:** You are Andy, an AI Project Manager. Your current underlying model is \`${getPMModel()}\`. When asked what AI or model you are, state this honestly and accurately.

**Your core team** (use \`consult_agent\`):
${AGENTS.map(a => `- **${a.name}** (${a.role}): ${a.description}`).join('\n')}

**External roster** (use \`hire_specialist\`):
You can hire any of ${externalAgents.length} additional specialists — UX designers, legal advisors, data scientists, technical writers, marketing strategists, and many more. Describe the expertise you need in natural language.

**How to work:**
1. For significant tasks: call \`send_update\` immediately with a brief plan ("On it — involving Solidity Dev and Risk Manager"), then proceed.
2. Delegate to specialists using \`consult_agent\` (core team) or \`hire_specialist\` (external roster). Multiple calls run in parallel.
3. Specialists can read/write files and run commands in /workspace — they will iterate until done.
4. Use \`send_update\` at major milestones: when a specialist finishes, when tests pass, when blocked. Not after every tool call.
5. Use \`request_decision\` when: at an architectural fork where client preference matters, before committing/deploying, or when genuinely blocked. Do NOT ask for decisions you can resolve with good engineering judgment.
6. Use \`get_state\` at the start of a new task to check what's already been done.
7. Answer simple questions (greetings, status, clarifications) directly — no need to call agents.
8. Use \`add_repo\` when the client provides a GitHub URL — clone it once, then agents work within /workspace/{name}.
9. Use \`send_artifact\` to deliver documents and files: architecture docs, audit reports, specs, PDFs. Agents can generate PDFs via: run_command("pandoc doc.md -o doc.pdf"). Agents can push code and open PRs via: run_command("gh pr create ...").
10. Use \`create_task\` to track non-trivial work items and \`update_task\` to mark them done/blocked. This ensures progress persists across sessions.
11. Use \`get_cost\` when the client asks about spend, or proactively if a task involved many agent calls.
12. Use \`switch_team\` immediately when the client asks to change the team or model configuration.

**Communication style:** Professional but direct. Summarise technical details for the client. Use bullet points.

**Active team:** \`${activeConfigName}\` — ${configMeta.descriptions[activeConfigName] ?? activeConfigName}
**Available teams:**
${configMeta.names.map(n => `- \`${n}\`: ${configMeta.descriptions[n] ?? n}`).join('\n')}
The client can ask you to switch teams at any time — use \`switch_team\` immediately when they do.

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

const CREATE_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'create_task',
    description: 'Create a task in project state to track work across sessions. Use before delegating non-trivial work.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task description' },
        assignee: { type: 'string', description: 'Agent role that will work on this, e.g. "solidity-dev"' },
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
        id: { type: 'string', description: 'Task ID from project state' },
        status: { type: 'string', enum: ['pending', 'in-progress', 'done', 'blocked'] },
        result: { type: 'string', description: 'Brief summary of what was accomplished or why it is blocked' },
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

const SWITCH_TEAM_TOOL = {
  type: 'function',
  function: {
    name: 'switch_team',
    description: `Switch the AI model team configuration. Available configs: ${configMeta.names.map(n => `"${n}" (${configMeta.descriptions[n]})`).join(', ')}. Call this immediately when the client requests a team change.`,
    parameters: {
      type: 'object',
      properties: {
        config: {
          type: 'string',
          enum: configMeta.names,
          description: 'Team configuration name to activate',
        },
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
  CREATE_TASK_TOOL,
  UPDATE_TASK_TOOL,
  GET_COST_TOOL,
  SWITCH_TEAM_TOOL,
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
// Agent timeout wrapper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Build enriched context for agents (includes recent completed work)
// ---------------------------------------------------------------------------

function buildAgentContext(): string {
  const base = `Project: ${PROJECT_NAME}`;
  try {
    const state = loadState();
    const recentDone = state.tasks
      .filter(t => t.status === 'done' && t.result)
      .slice(-3)
      .map(t => `[${t.assignee}] ${t.title}: ${t.result}`)
      .join('\n');
    if (recentDone) {
      return `${base}\n\nRecent completed work:\n${recentDone}`;
    }
  } catch { /* best effort */ }
  return base;
}

// ---------------------------------------------------------------------------
// URL validation for add_repo
// ---------------------------------------------------------------------------

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

function validateRepoUrl(url: string): string | null {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  if (!GITHUB_URL_RE.test(cleaned)) {
    return null;
  }
  return cleaned;
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
      log('info', 'bot', `Restored history for channel`, { channelId, messages: histories[channelId].length });
    }
  }
  const history = histories[channelId];
  history.push({ role: 'user', content: userMessage });

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

    // PM finished — send final reply to client
    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      if (assistantMsg.content) {
        await notifyUser(assistantMsg.content, send);
      }
      histories[channelId] = truncateHistory(history);
      saveHistory(channelId, histories[channelId]);
      return;
    }

    // Share any reasoning text the PM produced alongside its tool calls
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
          // Give PM actionable error info
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

      // Auto-track task in project state
      const taskRecord = addTask(task.slice(0, 120), role);
      updateTask(taskRecord.id, { status: 'in-progress' });

      try {
        const agentPromise = runAgent(
          role,
          task,
          buildAgentContext(),
          getModelMap(),
          OPENROUTER_API_KEY,
          (msg) => notifyUser(`⚙️ ${msg}`, send),
          signal,
        );
        const result = await withTimeout(agentPromise, AGENT_TIMEOUT_MS, `Agent ${agentName}`);

        // Update task state
        updateTask(taskRecord.id, {
          status: result.status === 'blocked' ? 'blocked' : 'done',
          result: result.output.slice(0, 500),
        });

        if (result.status === 'blocked') {
          await notifyUser(`⚠️ **${agentName}** is blocked: ${result.blocker}`, send);
          return `BLOCKED: ${result.blocker}\n\nAgent output: ${result.output}`;
        }
        await notifyUser(`✅ **${agentName}** — done`, send);
        return result.output;
      } catch (err) {
        updateTask(taskRecord.id, { status: 'blocked', result: (err as Error).message });
        throw err;
      }
    }

    case 'hire_specialist': {
      const roleDesc = args['role_description'] as string;
      await notifyUser(`🔍 Hiring **${roleDesc}**…`, send);
      const { agentName, reply } = await runExternalAgent(
        roleDesc,
        args['task'] as string,
        buildAgentContext(),
        externalAgents,
        getModelMap(),
        OPENROUTER_API_KEY,
        signal,
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
      if (!validUrl) {
        return `Invalid repository URL: "${rawUrl}". Must be an HTTPS GitHub URL like https://github.com/org/repo`;
      }

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
      if (result.exitCode !== 0) {
        return `Clone failed:\n${result.stderr || result.stdout}`;
      }
      addRepo(validUrl, name, branch);
      return `Cloned ${validUrl} → ${localPath} (branch: ${branch}). Agents can now work in /workspace/${name}.`;
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
        for (const [role, cost] of roleEntries) {
          lines.push(`  ${role}: $${cost.toFixed(4)}`);
        }
      }
      const modelEntries = Object.entries(s.byModel).sort(([, a], [, b]) => b - a);
      if (modelEntries.length) {
        lines.push('\n**By model:**');
        for (const [model, cost] of modelEntries) {
          lines.push(`  ${model}: $${cost.toFixed(4)}`);
        }
      }
      return lines.join('\n');
    }

    case 'switch_team': {
      const config = args['config'] as string;
      if (!allModelMaps[config]) {
        return `Unknown team config: "${config}". Available: ${configMeta.names.join(', ')}`;
      }
      if (config === activeConfigName) {
        return `Already on the **${config}** team — no change needed.`;
      }
      activeConfigName = config;
      const desc = configMeta.descriptions[config] ?? config;
      const newPMModel = getPMModel();
      log('info', 'bot', 'Team config switched', { config, pmModel: newPMModel });
      const roleList = Object.entries(allModelMaps[config])
        .filter(([k]) => k !== '__default__')
        .map(([role, model]) => `  • ${role}: \`${model}\``)
        .join('\n');
      await notifyUser(
        `🔄 **Switched to ${config} team** — ${desc}\n\nModel assignments:\n${roleList}`,
        send,
      );
      return `Team switched to "${config}". PM is now using ${newPMModel}.`;
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
    log('error', 'bot', 'PM execution error', { error: (err as Error).message, stack: (err as Error).stack });
    await notifyUser(`Something went wrong: ${(err as Error).message}`, send);
  });
}
