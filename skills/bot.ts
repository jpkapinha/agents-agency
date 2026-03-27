/**
 * Discord bot — Project Manager with multi-agent orchestration.
 *
 * The PM (Claude Opus) receives messages from Discord and can delegate tasks
 * to specialist agents (Solidity Dev, Tech Lead, Frontend Dev, etc.) via
 * OpenRouter tool-calling. Specialists run in parallel when the PM requests
 * multiple agents. Final response is synthesised by the PM and sent to Discord.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from '/app/nanoclaw/node_modules/discord.js/src/index.js';
import { AGENTS, loadModelMap, runAgent } from './agents.js';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const PROJECT_NAME = process.env.PROJECT_NAME || 'Web3 Project';
const TRIGGER = /^@andy\b/i;
const MODELS_CONFIG = '/app/config/models.json';

if (!DISCORD_BOT_TOKEN) { console.error('DISCORD_BOT_TOKEN is not set'); process.exit(1); }
if (!OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(1); }

const modelMap = loadModelMap(MODELS_CONFIG);
const PM_MODEL = modelMap['project-manager'] ?? modelMap['__default__'] ?? 'anthropic/claude-sonnet-4-5';

console.log(`[bot] PM model: ${PM_MODEL}`);
console.log(`[bot] Specialist models: ${AGENTS.map(a => `${a.role}=${modelMap[a.role] ?? 'default'}`).join(', ')}`);

// ---------------------------------------------------------------------------
// PM system prompt
// ---------------------------------------------------------------------------

const PM_SYSTEM = `You are Andy, the Project Manager of a Web3 development agency. You are the sole point of contact with the client — all other agents work internally and only you communicate via Discord.

Your specialist team:
${AGENTS.map(a => `- **${a.name}** (${a.role}): ${a.description}`).join('\n')}

**How to work:**
1. When a client sends a request, decide which specialists are needed.
2. Delegate using the \`consult_agent\` tool — you can call multiple agents and they run in parallel.
3. Synthesise their responses into a clear, professional reply for the client.
4. Ask clarifying questions when the request is ambiguous before delegating.
5. For simple questions you can answer yourself (greetings, process questions, status updates), do not call agents unnecessarily.

**Communication style:** Professional but approachable. Summarise technical details — the client may not be deeply technical. Use bullet points for multi-part answers.

Current project: ${PROJECT_NAME}`;

// ---------------------------------------------------------------------------
// Tool definition passed to PM
// ---------------------------------------------------------------------------

const CONSULT_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'consult_agent',
    description: 'Delegate a task to a specialist agent on your team. You can call this multiple times to consult different specialists — they run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: AGENTS.map(a => a.role),
          description: 'The specialist role to consult.',
        },
        task: {
          type: 'string',
          description: 'The specific task or question for this specialist. Be precise — they only see this text plus the project context.',
        },
      },
      required: ['role', 'task'],
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

// Per-channel conversation history (PM-level only)
const histories: Record<string, ORMessage[]> = {};

async function runPM(channelId: string, userMessage: string): Promise<string> {
  const history = histories[channelId] ?? [];
  history.push({ role: 'user', content: userMessage });

  // Orchestration loop: keep going until PM stops calling tools
  for (let round = 0; round < 10; round++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PM_MODEL,
        messages: [
          { role: 'system', content: PM_SYSTEM },
          ...history,
        ],
        tools: [CONSULT_AGENT_TOOL],
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

    // Add PM's message (with tool_calls if any) to history
    history.push(assistantMsg);

    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      // PM is done — return its text reply
      histories[channelId] = history.slice(-40); // keep last 20 turns
      return assistantMsg.content ?? '(no response)';
    }

    // Run all tool calls in parallel
    const toolCalls = assistantMsg.tool_calls;
    console.log(`[bot] PM delegating to: ${toolCalls.map(tc => {
      try { return JSON.parse(tc.function.arguments).role; } catch { return tc.function.name; }
    }).join(', ')}`);

    const toolResults = await Promise.all(
      toolCalls.map(async (tc): Promise<ORMessage> => {
        let resultContent: string;
        try {
          const args = JSON.parse(tc.function.arguments) as { role: string; task: string };
          resultContent = await runAgent(
            args.role,
            args.task,
            `Project: ${PROJECT_NAME}`,
            modelMap,
            OPENROUTER_API_KEY,
          );
        } catch (err) {
          resultContent = `Error consulting agent: ${(err as Error).message}`;
          console.error(`[bot] Agent call failed:`, err);
        }
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: resultContent,
        };
      }),
    );

    // Add all tool results to history before next PM turn
    history.push(...toolResults);
  }

  // Safety: if we somehow hit 10 rounds, return what we have
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

  // Keep typing indicator alive (Discord drops it after 10 s)
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

    // Split long replies (Discord limit: 2000 chars)
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

// Graceful shutdown
process.on('SIGTERM', () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { console.log('[bot] Shutting down...'); client.destroy(); process.exit(0); });
