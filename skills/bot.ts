/**
 * Discord bot — Project Manager with multi-agent orchestration.
 *
 * The PM (Claude Opus) receives messages from Discord and delegates tasks to:
 *   - Core team (consult_agent): 7 fixed Web3 specialists with dedicated models
 *   - External roster (hire_specialist): any role from msitarzewski/agency-agents,
 *     matched by description and loaded from /app/nanoclaw/roles/ at startup
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from '/app/nanoclaw/node_modules/discord.js/src/index.js';
import {
  AGENTS,
  loadModelMap,
  runAgent,
  loadExternalAgents,
  runExternalAgent,
  type ExternalAgentDef,
} from './agents.js';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const PROJECT_NAME = process.env.PROJECT_NAME || 'Web3 Project';
const TRIGGER = /^@andy\b/i;
const MODELS_CONFIG = '/app/config/models.json';
const ROLES_DIR = '/app/nanoclaw/roles';

if (!DISCORD_BOT_TOKEN) { console.error('DISCORD_BOT_TOKEN is not set'); process.exit(1); }
if (!OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }

const modelMap = loadModelMap(MODELS_CONFIG);
const PM_MODEL = modelMap['project-manager'] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';
const externalAgents: ExternalAgentDef[] = loadExternalAgents(ROLES_DIR);

console.log(`[bot] PM model: ${PM_MODEL}`);
console.log(`[bot] Core team: ${AGENTS.map(a => a.role).join(', ')}`);
console.log(`[bot] External roster: ${externalAgents.length} specialists available for hire`);

// ---------------------------------------------------------------------------
// PM system prompt
// ---------------------------------------------------------------------------

const PM_SYSTEM = `You are Andy, the Project Manager of a Web3 development agency. You are the sole point of contact with the client — all other agents work internally and only you communicate via Discord.

**Your core team** (use \`consult_agent\`):
${AGENTS.map(a => `- **${a.name}** (${a.role}): ${a.description}`).join('\n')}

**External roster** (use \`hire_specialist\`):
Beyond your core team, you can hire any specialist from the agency roster — including roles like UX designer, data scientist, legal advisor, marketing strategist, QA engineer, technical writer, and many others. Describe the expertise you need and the system will find the best match from ${externalAgents.length} available specialists.

**How to work:**
1. Identify which specialists are needed for the client's request.
2. Use \`consult_agent\` for your core Web3 team — they run in parallel.
3. Use \`hire_specialist\` for any expertise outside your core team — describe the role you need (e.g. "UX designer", "legal advisor for token compliance", "technical writer").
4. You can mix both tools in a single turn — they all run in parallel.
5. Synthesise all responses into a clear, professional reply for the client.
6. Ask clarifying questions when the request is ambiguous.
7. Answer simple questions (greetings, process, status) directly — no need to call agents.

**Communication style:** Professional but approachable. Summarise technical details — the client may not be deeply technical. Use bullet points for multi-part answers.

Current project: ${PROJECT_NAME}`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const CONSULT_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'consult_agent',
    description: 'Delegate a task to a core team specialist. Multiple calls run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: AGENTS.map(a => a.role),
          description: 'The core team specialist to consult.',
        },
        task: {
          type: 'string',
          description: 'The specific task or question. Be precise.',
        },
      },
      required: ['role', 'task'],
    },
  },
};

const HIRE_SPECIALIST_TOOL = {
  type: 'function',
  function: {
    name: 'hire_specialist',
    description: `Hire an external specialist from the agency roster (${externalAgents.length} available). Use this for expertise outside your core team. Describe the role you need in natural language — e.g. "UX designer", "blockchain security auditor", "technical writer for docs", "legal advisor for token compliance".`,
    parameters: {
      type: 'object',
      properties: {
        role_description: {
          type: 'string',
          description: 'Natural language description of the expertise needed (e.g. "UX designer", "data scientist", "community manager").',
        },
        task: {
          type: 'string',
          description: 'The specific task or question for this specialist.',
        },
      },
      required: ['role_description', 'task'],
    },
  },
};

// ---------------------------------------------------------------------------
// Types
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
  choices: Array<{
    finish_reason: string;
    message: ORMessage;
  }>;
}

// ---------------------------------------------------------------------------
// PM orchestration
// ---------------------------------------------------------------------------

const histories: Record<string, ORMessage[]> = {};

async function runPM(channelId: string, userMessage: string): Promise<string> {
  const history = histories[channelId] ?? [];
  history.push({ role: 'user', content: userMessage });

  for (let round = 0; round < 10; round++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PM_MODEL,
        messages: [{ role: 'system', content: PM_SYSTEM }, ...history],
        tools: [CONSULT_AGENT_TOOL, HIRE_SPECIALIST_TOOL],
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter PM error ${response.status}: ${err}`);
    }

    const data = await response.json() as ORResponse;
    const choice = data.choices[0];
    const assistantMsg = choice.message;
    history.push(assistantMsg);

    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      histories[channelId] = history.slice(-40);
      return assistantMsg.content ?? '(no response)';
    }

    const toolCalls = assistantMsg.tool_calls;
    console.log(`[bot] PM calling: ${toolCalls.map(tc => {
      try {
        const a = JSON.parse(tc.function.arguments) as Record<string, string>;
        return tc.function.name === 'hire_specialist'
          ? `hire(${a['role_description']})`
          : a['role'];
      } catch { return tc.function.name; }
    }).join(', ')}`);

    const toolResults = await Promise.all(
      toolCalls.map(async (tc): Promise<ORMessage> => {
        let resultContent: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, string>;

          if (tc.function.name === 'hire_specialist') {
            const { agentName, reply } = await runExternalAgent(
              args['role_description'] ?? '',
              args['task'] ?? '',
              `Project: ${PROJECT_NAME}`,
              externalAgents,
              modelMap,
              OPENROUTER_API_KEY,
            );
            resultContent = `[${agentName}]: ${reply}`;
          } else {
            resultContent = await runAgent(
              args['role'] ?? '',
              args['task'] ?? '',
              `Project: ${PROJECT_NAME}`,
              modelMap,
              OPENROUTER_API_KEY,
            );
          }
        } catch (err) {
          resultContent = `Error: ${(err as Error).message}`;
          console.error('[bot] Agent call failed:', err);
        }
        return { role: 'tool', tool_call_id: tc.id, content: resultContent };
      }),
    );

    history.push(...toolResults);
  }

  histories[channelId] = history.slice(-40);
  return 'I consulted the team but ran into an issue synthesising the response. Please try again.';
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

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Discord connected as ${c.user.tag}`);
  console.log(`[bot] Trigger: @Andy (or mention the bot)`);
  console.log(`[bot] PM model: ${PM_MODEL}`);
  console.log(`[bot] External specialists available: ${externalAgents.length}`);
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

  const channelId = message.channelId;

  let typingActive = true;
  const keepTyping = async () => {
    while (typingActive) {
      if ('sendTyping' in message.channel) {
        await (message.channel as TextChannel).sendTyping().catch(() => {});
      }
      await new Promise(r => setTimeout(r, 7000));
    }
  };
  keepTyping();

  try {
    const reply = await runPM(channelId, content);
    typingActive = false;
    const chunks = reply.match(/[\s\S]{1,1900}/g) ?? [reply];
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    typingActive = false;
    console.error('[bot] Error:', err);
    await message.reply('Sorry, something went wrong. Please try again.');
  }
});

client.login(DISCORD_BOT_TOKEN);

process.on('SIGTERM', () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
