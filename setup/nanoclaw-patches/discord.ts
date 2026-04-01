/**
 * Discord channel for NanoClaw — implements the Channel interface using discord.js.
 *
 * Self-registers via registerChannel('discord', factory) so that NanoClaw's
 * channels/index.ts barrel import activates it automatically at startup.
 *
 * Flow:
 *   Discord message → MessageCreate → opts.onMessage(chatJid, msg)
 *     → NanoClaw stores in SQLite → message loop picks up
 *     → runContainerAgent → our skills/bot.ts PM loop
 *     → onOutput callback → channel.sendMessage → Discord
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DISCORD_BOT_TOKEN    = process.env['DISCORD_BOT_TOKEN']    ?? '';
const DISCORD_PM_CHANNEL_ID = process.env['DISCORD_PM_CHANNEL_ID'] ?? '';
// Match @andy anywhere in the message (case-insensitive) OR a real Discord @mention of the bot.
// In the dedicated PM channel, NO trigger is required — every message goes to Andy.
const TRIGGER = /@andy\b/i;

registerChannel('discord', (opts: ChannelOpts): Channel | null => {
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[discord] DISCORD_BOT_TOKEN not set — Discord channel disabled');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let connected = false;
  const channelCache = new Map<string, TextChannel>();

  const getChannel = async (jid: string): Promise<TextChannel | null> => {
    if (channelCache.has(jid)) return channelCache.get(jid)!;
    try {
      const ch = await client.channels.fetch(jid);
      if (ch instanceof TextChannel) {
        channelCache.set(jid, ch);
        return ch;
      }
    } catch { /* channel not found or missing permissions */ }
    return null;
  };

  client.once(Events.ClientReady, async (c) => {
    connected = true;
    console.log(`[discord] Connected as ${c.user.tag}`);
    if (DISCORD_PM_CHANNEL_ID) {
      // Register the PM channel metadata with NanoClaw so it knows this jid
      opts.onChatMetadata(
        DISCORD_PM_CHANNEL_ID,
        new Date().toISOString(),
        'Andy',
        'discord',
        false,
      );
    }
  });

  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot) return;

    const botId = client.user?.id ?? '';
    const isMentioned = message.mentions.users.has(botId);
    const isTrigger = TRIGGER.test(message.content);
    // In the dedicated PM channel every message is for Andy — no trigger required.
    const isPMChannel = message.channelId === DISCORD_PM_CHANNEL_ID;
    if (!isPMChannel && !isMentioned && !isTrigger) return;

    // Strip mention / trigger prefix before handing to NanoClaw
    let content = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .replace(TRIGGER, '')
      .trim();
    if (!content) content = 'Hello!';

    const jid = message.channelId;
    const msg: NewMessage = {
      id: message.id,
      chat_jid: jid,
      sender: message.author.id,
      sender_name: message.author.username,
      content,
      timestamp: message.createdAt.toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    opts.onMessage(jid, msg);
  });

  return {
    name: 'discord',

    async connect(): Promise<void> {
      await client.login(DISCORD_BOT_TOKEN);
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      const ch = await getChannel(jid);
      if (!ch) {
        console.error(`[discord] Channel not found: ${jid}`);
        return;
      }
      // Discord message limit is 2000 chars; split if needed
      const chunks = text.match(/[\s\S]{1,1900}/g) ?? [text];
      for (const chunk of chunks) {
        await ch.send(chunk).catch((err) =>
          console.error('[discord] send error:', err),
        );
      }
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid === DISCORD_PM_CHANNEL_ID;
    },

    async disconnect(): Promise<void> {
      client.destroy();
      connected = false;
    },

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      if (!isTyping) return;
      const ch = await getChannel(jid);
      if (ch) await ch.sendTyping().catch(() => {});
    },
  };
});
