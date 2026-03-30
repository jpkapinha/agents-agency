/**
 * Discord channel for NanoClaw — implements the Channel interface using discord.js.
 *
 * Attachment handling:
 *   PDFs       → downloaded via Node fetch + text extracted via pandoc
 *   Images     → [IMAGE_URL:url] marker added (vision in bot.ts)
 *   Text files → content injected inline
 *   Other      → file path noted for agents
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import { mkdirSync, writeFileSync } from 'fs';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DISCORD_BOT_TOKEN     = process.env['DISCORD_BOT_TOKEN']     ?? '';
const DISCORD_PM_CHANNEL_ID = process.env['DISCORD_PM_CHANNEL_ID'] ?? '';
const UPLOAD_DIR            = '/workspace/.agency/uploads';

const TRIGGER    = /^@andy\b/i;  // still stripped if present, but no longer required
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

// ---------------------------------------------------------------------------
// Attachment processing — download only, no upfront text extraction.
// PDFs are saved and the path is reported so agents can call read_pdf()
// on demand, avoiding wasteful upfront token injection.
// ---------------------------------------------------------------------------

async function processAttachments(message: Message): Promise<string> {
  if (message.attachments.size === 0) return '';

  try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* exists */ }

  const parts: string[] = [];

  for (const [, att] of message.attachments) {
    const url       = att.url;
    const filename  = att.name ?? 'attachment';
    const ext       = filename.split('.').pop()?.toLowerCase() ?? '';
    const localPath = `${UPLOAD_DIR}/${Date.now()}-${filename}`;

    // Download via Node fetch — no shell escaping issues with signed CDN URLs
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      parts.push(`[Attachment: ${filename} — download failed: ${err}]`);
      continue;
    }

    if (IMAGE_EXTS.has(ext)) {
      // Vision: pass URL marker → bot.ts converts to multimodal content block
      parts.push(`[IMAGE_URL:${url}]`);
    } else if (ext === 'pdf') {
      // Report path only — agents call read_pdf(".agency/uploads/...") on demand
      parts.push(`[PDF attached: "${filename}" saved to ${localPath} — use read_pdf("${localPath}") to read it]`);
    } else {
      parts.push(`[File attached: "${filename}" saved to ${localPath} — use read_file("${localPath}") to read it]`);
    }
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

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
      opts.onChatMetadata(
        DISCORD_PM_CHANNEL_ID,
        new Date().toISOString(),
        'Andy',
        'discord',
        false,
      );
    }
  });

  // Async handler — safe in discord.js v14
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Every message in the PM channel goes to Andy — no trigger word needed.
    // Strip @mention / @andy prefix if the user included one, but don't require it.
    const botId = client.user?.id ?? '';
    let content = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .replace(TRIGGER, '')
      .trim();

    // Download and process attachments before handing off to NanoClaw
    const attachmentContent = await processAttachments(message);
    if (attachmentContent) {
      content = content ? `${content}\n\n${attachmentContent}` : attachmentContent;
    }

    if (!content) content = 'Hello!';

    const jid = message.channelId;
    const msg: NewMessage = {
      id:             message.id,
      chat_jid:       jid,
      sender:         message.author.id,
      sender_name:    message.author.username,
      content,
      timestamp:      message.createdAt.toISOString(),
      is_from_me:     false,
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
      const chunks = text.match(/[\s\S]{1,1900}/g) ?? [text];
      for (const chunk of chunks) {
        await ch.send(chunk).catch((err) =>
          console.error('[discord] send error:', err),
        );
      }
    },

    isConnected(): boolean { return connected; },

    ownsJid(jid: string): boolean { return jid === DISCORD_PM_CHANNEL_ID; },

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
