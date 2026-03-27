/**
 * Discord bot — Andy the Project Manager.
 *
 * Andy works asynchronously: acknowledges immediately, works in the background,
 * sends proactive progress updates, and asks for decisions when needed.
 * Users can interrupt mid-task with a new message to pivot direction.
 *
 * Agents now run agentic loops with real tools (read/write files, run commands).
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import {
  AGENTS,
  loadModelMap,
  runAgent,
  loadExternalAgents,
  runExternalAgent,
  type ExternalAgentDef,
} from './agents.js';
import { formatStateForPM } from './state.js';

const DISCORD_BOT_TOKEN    = process.env.DISCORD_BOT_TOKEN    || '';
const OPENROUTER_API_KEY   = process.env.OPENROUTER_API_KEY   || '';
const DISCORD_PM_CHANNEL_ID = process.env.DISCORD_PM_CHANNEL_ID || '';
const PROJECT_NAME         = process.env.PROJECT_NAME          || 'Web3 Project';
const TRIGGER              = /^@andy\b/i;
const MODELS_CONFIG        = '/app/config/models.json';
const ROLES_DIR            = '/app/roles';

if (!DISCORD_BOT_TOKEN)  { console.error('DISCORD_BOT_TOKEN is not set');  process.exit(1); }
if (!OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }

const modelMap       = loadModelMap(MODELS_CONFIG);
const PM_MODEL       = modelMap['project-manager'] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
const externalAgents: ExternalAgentDef[] = loadExternalAgents(ROLES_DIR);

console.log(`[bot] PM model: ${PM_MODEL}`);
console.log(`[bot] Core team: ${AGENTS.map(a => a.role).join(', ')}`);
console.log(`[bot] External roster: ${externalAgents.length} specialists available`);

// ---------------------------------------------------------------------------
// Discord state
// ---------------------------------------------------------------------------

let pmChannel: TextChannel | null = null;
let currentExecution: AbortController | null = null;

// Per-channel PM conversation history
const histories: Record<string, ORMessage[]> = {};

// ---------------------------------------------------------------------------
// Proactive messaging
// ---------------------------------------------------------------------------

async function notifyUser(msg: string): Promise<void> {
  if (!pmChannel) return;
  const chunks = msg.match(/[\s\S]{1,1900}/g) ?? [msg];
  for (const chunk of chunks) {
    await pmChannel.send(chunk).catch(err => console.error('[bot] notifyUser error:', err));
  }
}

// ---------------------------------------------------------------------------
// Decision requests — PM pauses and asks user, waits for reply
// ---------------------------------------------------------------------------

async function requestDecision(
  question: string,
  options: string[] | undefined,
  signal: AbortSignal,
): Promise<string> {
  const formatted = options?.length
    ? `${question}\n\nOptions:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : question;

  await notifyUser(`**Decision needed:**\n${formatted}`);

  return new Promise<string>((resolve) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      client.off(Events.MessageCreate, listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve('(no response — timed out after 5 minutes, making best default choice)');
    }, 5 * 60 * 1000);

    signal.addEventListener('abort', () => {
      cleanup();
      resolve('(interrupted by new user message)');
    }, { once: true });

    const listener = (msg: Message) => {
      if (msg.author.bot) return;
      if (msg.channelId !== pmChannel?.id) return;
      cleanup();
      resolve(msg.content);
    };

    client.on(Events.MessageCreate, listener);
  });
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

// ---------------------------------------------------------------------------
// PM system prompt (dynamic — includes current state)
// ---------------------------------------------------------------------------

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

**Communication style:** Professional but direct. Summarise technical details for the client. Use bullet points.

**Current project state:**
${state}

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
    description: 'Get the current project state — tasks, decisions, blockers.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const PM_TOOLS = [
  CONSULT_AGENT_TOOL,
  HIRE_SPECIALIST_TOOL,
  SEND_UPDATE_TOOL,
  REQUEST_DECISION_TOOL,
  GET_STATE_TOOL,
];

// ---------------------------------------------------------------------------
// PM async execution loop
// ---------------------------------------------------------------------------

async function runPMAsync(
  channelId: string,
  userMessage: string,
  signal: AbortSignal,
): Promise<void> {
  const history = histories[channelId] ?? [];
  history.push({ role: 'user', content: userMessage });

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

    // PM finished — send final reply
    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      if (assistantMsg.content) {
        await notifyUser(assistantMsg.content);
      }
      histories[channelId] = history.slice(-40);
      return;
    }

    if (signal.aborted) return;

    // Execute PM tool calls in parallel
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
          resultContent = await dispatchPMTool(tc.function.name, args, signal);
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
  await notifyUser('I hit the maximum planning rounds. Please give me a more specific instruction to continue.');
}

async function dispatchPMTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  switch (name) {
    case 'send_update':
      await notifyUser(args['message'] as string);
      return 'Update sent.';

    case 'request_decision': {
      const answer = await requestDecision(
        args['question'] as string,
        args['options'] as string[] | undefined,
        signal,
      );
      return `Client answered: ${answer}`;
    }

    case 'get_state':
      return formatStateForPM();

    case 'consult_agent': {
      const role = args['role'] as string;
      const task = args['task'] as string;
      const result = await runAgent(
        role,
        task,
        `Project: ${PROJECT_NAME}`,
        modelMap,
        OPENROUTER_API_KEY,
        (msg) => notifyUser(`⚙️ ${msg}`),
      );
      if (result.status === 'blocked') {
        return `BLOCKED: ${result.blocker}\n\nAgent output: ${result.output}`;
      }
      return result.output;
    }

    case 'hire_specialist': {
      const { agentName, reply } = await runExternalAgent(
        args['role_description'] as string,
        args['task'] as string,
        `Project: ${PROJECT_NAME}`,
        externalAgents,
        modelMap,
        OPENROUTER_API_KEY,
      );
      return `[${agentName}]: ${reply}`;
    }

    default:
      return `Unknown PM tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Discord connected as ${c.user.tag}`);
  console.log(`[bot] PM model: ${PM_MODEL}`);
  console.log(`[bot] External specialists: ${externalAgents.length}`);

  // Cache the PM channel for proactive messaging
  if (DISCORD_PM_CHANNEL_ID) {
    try {
      pmChannel = await client.channels.fetch(DISCORD_PM_CHANNEL_ID) as TextChannel;
      console.log(`[bot] PM channel ready: #${pmChannel.name}`);
    } catch (err) {
      console.warn('[bot] Could not fetch PM channel:', err);
    }
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  const botId = client.user?.id ?? '';
  const isMentioned = message.mentions.users.has(botId);
  const isTrigger = TRIGGER.test(message.content.trim());
  if (!isMentioned && !isTrigger) return;

  let content = message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(TRIGGER, '')
    .trim();
  if (!content) content = 'Hello!';

  // Set pmChannel from the message channel if not already set
  if (!pmChannel && 'send' in message.channel) {
    pmChannel = message.channel as TextChannel;
  }

  // Interrupt any in-progress execution
  if (currentExecution) {
    currentExecution.abort();
    currentExecution = null;
    await notifyUser('Noted — pivoting to your new request.');
  }

  // Acknowledge immediately
  await message.reply('On it.');

  // Start background execution
  const ctrl = new AbortController();
  currentExecution = ctrl;

  runPMAsync(message.channelId, content, ctrl.signal).catch(async (err) => {
    if (ctrl.signal.aborted) return;
    console.error('[bot] PM execution error:', err);
    await notifyUser(`Something went wrong: ${(err as Error).message}`);
  }).finally(() => {
    if (currentExecution === ctrl) currentExecution = null;
  });
});

client.login(DISCORD_BOT_TOKEN);

process.on('SIGTERM', () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
