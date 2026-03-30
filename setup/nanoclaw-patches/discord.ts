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
 *
 * Attachment handling:
 *   PDFs       → downloaded + text extracted via pandoc, injected into message
 *   Images     → downloaded + [IMAGE_URL:url] marker added (vision in bot.ts)
 *   Text files → downloaded + content injected inline
 *   Other      → downloaded + file path noted for agents to use
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DISCORD_BOT_TOKEN     = process.env['DISCORD_BOT_TOKEN']     ?? '';
const DISCORD_PM_CHANNEL_ID = process.env['DISCORD_PM_CHANNEL_ID'] ?? '';
const UPLOAD_DIR            = '/workspace/.agency/uploads';
const MAX_TEXT_CHARS        = 50_000;

// Match @andy (case-insensitive) OR @<bot-mention>
const TRIGGER = /^@andy\b/i;

// ---------------------------------------------------------------------------
// Attachment processing
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const TEXT_EXTS  = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'ts', 'js',
                             'sol', 'csv', 'toml', 'env', 'sh', 'py', 'rs',
                             'go', 'java', 'html', 'css', 'xml', 'sql']);

function processAttachments(message: Message): string {
  if (message.attachments.size === 0) return '';

  try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* exists */ }

  const parts: string[] = [];

  for (const [, att] of message.attachments) {
    const url      = att.url;
    const filename = att.name ?? 'attachment';
    const ext      = filename.split('.').pop()?.toLowerCase() ?? '';
    const localPath = `${UPLOAD_DIR}/${Date.now()}-${filename}`;

    // Download the file
    try {
      execSync(`curl -sL "${url}" -o "${localPath}"`, { timeout: 30_000 });
    } catch {
      parts.push(`[Attachment: ${filename} (URL: ${url}) — download failed]`);
      continue;
    }

    if (IMAGE_EXTS.has(ext)) {
      // Vision: pass URL marker → bot.ts converts to multimodal content block
      parts.push(`[IMAGE_URL:${url}]`);

    } else if (ext === 'pdf') {
      try {
        const raw = execSync(
          `pandoc "${localPath}" -t plain 2>/dev/null`,
          { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        ).toString().trim();
        const text = raw.length > MAX_TEXT_CHARS
          ? raw.slice(0, MAX_TEXT_CHARS) + '\n...(content truncated)'
          : raw;
        parts.push(
          `--- Attached PDF: ${filename} (saved to ${localPath}) ---\n${text}\n--- End of PDF ---`,
        );
      } catch {
        parts.push(
          `[Attached PDF: ${filename} saved to ${localPath} — text extraction failed; ` +
          `agents can process it directly with run_command("pandoc \\"${localPath}\\" ...")]`,
        );
      }

    } else if (TEXT_EXTS.has(ext)) {
      try {
        const raw = execSync(`cat "${localPath}"`, {
          timeout: 10_000,
          maxBuffer: 10 * 1024 * 1024,
        }).toString();
        const text = raw.length > MAX_TEXT_CHARS
          ? raw.slice(0, MAX_TEXT_CHARS) + '\n...(content truncated)'
          : raw;
        parts.push(
          `--- Attached file: ${filename} (saved to ${localPath}) ---\n${text}\n--- End of file ---`,
        );
      } catch {
        parts.push(`[Attached file: ${filename} saved to ${localPath}]`);
      }

    } else {
      parts.push(`[Attached file: ${filename} saved to ${localPath}]`);
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

  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot) return;

    const botId      = client.user?.id ?? '';
    const isMentioned = message.mentions.users.has(botId);
    const isTrigger   = TRIGGER.test(message.content.trim());
    if (!isMentioned && !isTrigger) return;

    // Strip mention / trigger prefix
    let content = message.content
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .replace(TRIGGER, '')
      .trim();

    // Process attachments and append to content
    const attachmentContent = processAttachments(message);
    if (attachmentContent) {
      content = content ? `${content}\n\n${attachmentContent}` : attachmentContent;
    }

    if (!content) content = 'Hello!';

    const jid = message.channelId;
    const msg: NewMessage = {
      id:           message.id,
      chat_jid:     jid,
      sender:       message.author.id,
      sender_name:  message.author.username,
      content,
      timestamp:    message.createdAt.toISOString(),
      is_from_me:   false,
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
