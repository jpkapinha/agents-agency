/**
 * Discord bot powered by OpenRouter.
 * Listens for @Andy trigger or direct @bot mentions and replies via Claude.
 *
 * This replaces the NanoClaw+OneCLI path which requires an external OneCLI
 * service on port 10254 that is not bundled in this image.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from '/app/nanoclaw/node_modules/discord.js/src/index.js';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5';
const TRIGGER = /^@andy\b/i;

if (!DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN is not set');
  process.exit(1);
}
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(1);
}

// Per-channel conversation history
const histories: Record<string, Array<{ role: string; content: string }>> = {};

async function askOpenRouter(channelId: string, userMessage: string): Promise<string> {
  const history = histories[channelId] ?? [];
  history.push({ role: 'user', content: userMessage });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are Andy, a helpful AI assistant in a Discord server. Be concise and helpful.',
        },
        ...history,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const reply = data.choices[0]?.message?.content ?? '(no response)';

  history.push({ role: 'assistant', content: reply });
  // Keep last 20 turns per channel
  if (history.length > 40) history.splice(0, 2);
  histories[channelId] = history;

  return reply;
}

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
  console.log(`[bot] Model: ${MODEL}`);
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  const botId = client.user?.id ?? '';
  const isMentioned = message.mentions.users.has(botId);
  const isTrigger = TRIGGER.test(message.content.trim());

  if (!isMentioned && !isTrigger) return;

  // Strip the trigger/mention from the message
  let content = message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(TRIGGER, '')
    .trim();

  if (!content) content = 'Hello!';

  const channelId = message.channelId;

  try {
    // Show typing indicator
    if ('sendTyping' in message.channel) {
      await (message.channel as TextChannel).sendTyping();
    }

    const reply = await askOpenRouter(channelId, content);

    // Split long replies (Discord limit: 2000 chars)
    const chunks = reply.match(/[\s\S]{1,1900}/g) ?? [reply];
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error('[bot] Error:', err);
    await message.reply('Sorry, something went wrong. Please try again.');
  }
});

client.login(DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[bot] Shutting down...');
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[bot] Shutting down...');
  client.destroy();
  process.exit(0);
});
