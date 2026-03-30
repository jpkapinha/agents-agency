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
  runAgent,
  loadExternalAgents,
  runExternalAgent,
  type ExternalAgentDef,
} from './agents.js';
import { formatStateForPM, addRepo } from './state.js';
import { runCommand } from './tools.js';

const OPENROUTER_API_KEY    = process.env.OPENROUTER_API_KEY   || '';
const PROJECT_NAME          = process.env.PROJECT_NAME          || 'Web3 Project';
const MODELS_CONFIG         = '/app/config/models.json';
const ROLES_DIR             = '/app/roles';
const PATTERNS_DIR          = '/app/patterns';
const HISTORY_DIR           = '/workspace/.agency';
const WORKSPACE             = '/workspace';

if (!OPENROUTER_API_KEY) { console.error('[bot] OPENROUTER_API_KEY is not set'); process.exit(1); }

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
1. For significant tasks: call \`send_update\` immediately with a brief plan ("On it — involving Solidity Dev and Risk Manager"), then proceed.
2. Delegate to specialists using \`consult_agent\` (core team) or \`hire_specialist\` (external roster). Multiple calls run in parallel.
3. Specialists can read/write files and run commands in /workspace — they will iterate until done.
4. Use \`send_update\` at major milestones: when a specialist finishes, when tests pass, when blocked. Not after every tool call.
5. Use \`request_decision\` when: at an architectural fork where client preference matters, before committing/deploying, or when genuinely blocked. Do NOT ask for decisions you can resolve with good engineering judgment.
6. Use \`get_state\` at the start of a new task to check what's already been done.
7. Answer simple questions (greetings, status, clarifications) directly — no need to call agents.
8. Use \`add_repo\` when the client provides a GitHub URL — clone it once, then agents work within /workspace/{name}.
9. Use \`send_artifact\` to deliver documents and files: architecture docs, audit reports, specs, PDFs. Agents can generate PDFs via: run_command("pandoc doc.md -o doc.pdf"). Agents can push code and open PRs via: run_command("gh pr create ...").
10. Use \`fetch_url\` whenever the client shares a link (Google Drive, Notion export, GitHub raw, etc.) BEFORE delegating — specialists cannot download URLs themselves. Fetch first, then pass the extracted content in the task description.

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

const PM_TOOLS = [
  CONSULT_AGENT_TOOL,
  HIRE_SPECIALIST_TOOL,
  FETCH_URL_TOOL,
  SEND_UPDATE_TOOL,
  REQUEST_DECISION_TOOL,
  GET_STATE_TOOL,
  SEND_ARTIFACT_TOOL,
  ADD_REPO_TOOL,
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

  for (let round = 0; round < 15; round++) {
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
      const result = await runAgent(
        role,
        task,
        `Project: ${PROJECT_NAME}`,
        modelMap,
        OPENROUTER_API_KEY,
        (msg) => notifyUser(`⚙️ ${msg}`, send),
      );
      if (result.status === 'blocked') {
        await notifyUser(`⚠️ **${agentName}** is blocked: ${result.blocker}`, send);
        return `BLOCKED: ${result.blocker}\n\nAgent output: ${result.output}`;
      }
      await notifyUser(`✅ **${agentName}** — done`, send);
      return result.output;
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
